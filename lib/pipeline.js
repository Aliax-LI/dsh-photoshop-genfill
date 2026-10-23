/**
 * Generative-fill / generate-layer / edit pipeline for the Photoshop plugin.
 *
 * One operation = capture pixels from Photoshop -> call the image API -> place the
 * result back into Photoshop as a layer (masked by the selection when appropriate).
 *
 * The module is intentionally dependency-free: it composes the two injected
 * collaborators (`psBridge`, `imageApi`) so each one stays independently testable.
 *
 * @module dsh-photoshop-genfill/lib/pipeline
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { stateScript, captureScript, placeScript, undoScript } from './ps-scripts.js'
import { ImageApiError } from './image-api.js'

/** Smallest capture region the image API can meaningfully edit. */
const MIN_REGION_PX = 16
/** Largest capture edge we hand to the API; larger regions are still sent, models downscale. */
const MAX_REGION_EDGE_PX = 8192

/**
 * @typedef {object} PipelineConfig
 * @property {string} outputDir absolute directory for captures and results
 * @property {'cover'|'stretch'|'contain'} defaultFit
 * @property {string} model
 * @property {string} apiBaseUrl
 */

/**
 * Build the pipeline over a Photoshop bridge and an image-API client.
 *
 * @param {object} deps
 * @param {{run: Function, runLong: Function, target: Function, isRunning: Function}} deps.bridge
 * @param {{generate: Function, edit: Function, config: Function}} deps.api
 * @param {PipelineConfig} deps.config
 * @returns {ReturnType<typeof createPipeline>}
 */
export function createPipeline({ bridge, api, config }) {
  const outputDir = config.outputDir
  let lastJob = null

  /** Expand a leading `~` and resolve to an absolute path. */
  function expandHome(value) {
    if (typeof value !== 'string') return value
    if (value === '~') return os.homedir()
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
    return value
  }

  async function ensureOutputDir() {
    const dir = expandHome(outputDir)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  function stamp() {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  }

  function slug(text, max = 30) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'image'
  }

  function layerNameFor(prefix, prompt) {
    const tag = slug(prompt, 24)
    return `${prefix} ${stamp().slice(9)} ${tag}`.slice(0, 60)
  }

  /** Translate collaborator failures into messages a Chinese-speaking user can act on. */
  function describeError(error) {
    if (error instanceof ImageApiError) {
      switch (error.code) {
        case 'auth':
          return '图片 API 鉴权失败：请在插件配置 apiKey 填入有效的 Bearer Key（或设置环境变量 PS_GENFILL_API_KEY）。'
        case 'timeout':
          return `图片 API 超时（>${Math.round((error.timeoutMs ?? 0) / 1000)}s）：${error.message}`
        case 'network':
          return `无法连接图片 API（${error.detail ?? error.message}）：请检查网络与 apiBaseUrl。`
        case 'http':
          return `图片 API 返回 HTTP ${error.status}：${error.detail ?? error.message}`
        case 'shape':
          return `图片 API 响应格式无法识别：${error.detail ?? error.message}`
        case 'empty':
          return '图片 API 没有返回任何图片。'
        default:
          return `图片 API 调用失败：${error.message}`
      }
    }
    return error?.message ? String(error.message) : String(error)
  }

  /** Run a Photoshop script, prefixing a user-facing context on failure. */
  async function runPs(body, label) {
    try {
      return await bridge.run(body, { timeoutMs: 120000 })
    } catch (error) {
      throw new Error(`${label}失败：${error?.message ?? String(error)}`)
    }
  }

  async function runPsLong(body, label, timeoutMs = 240000) {
    try {
      return await bridge.run(body, { timeoutMs })
    } catch (error) {
      throw new Error(`${label}失败：${error?.message ?? String(error)}`)
    }
  }

  /** Best-effort read of the active document's history cursor (used for one-click undo). */
  async function historyInfo() {
    try {
      return await bridge.run(`
        if (app.documents.length === 0) return { ok: false, reason: 'no_document' };
        var doc = app.activeDocument;
        var states = doc.historyStates;
        var index = -1;
        for (var i = 0; i < states.length; i++) {
          if (states[i] === doc.activeHistoryState) { index = i; break; }
        }
        return {
          ok: true,
          docId: doc.id,
          index: index,
          count: states.length,
          state: String(doc.activeHistoryState.name)
        };
      `, { timeoutMs: 30000 })
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) }
    }
  }

  /** Read the current state without the extra bridge probes (used by undo). */
  async function rawState() {
    return await bridge.run(stateScript({ layerLimit: 1 }), { timeoutMs: 60000 })
  }

  async function getState() {
    const state = await runPs(stateScript({ layerLimit: 40 }), '读取 Photoshop 状态')
    const enriched = {
      ...state,
      bridge: {
        ...bridge.target(),
        running: await bridge.isRunning().catch(() => false),
      },
      api: api.config(),
      outputDir: expandHome(outputDir),
      lastJob,
    }
    return enriched
  }

  function requireDocument(state) {
    if (!state || state.ok === false || !state.hasDocument) {
      throw new Error(
        'Photoshop 中当前没有打开的文档：请先在 Photoshop 打开或新建一个文档，然后重试。',
      )
    }
    return state.document
  }

  function documentBounds(doc) {
    return { left: 0, top: 0, right: Math.round(doc.width), bottom: Math.round(doc.height), width: Math.round(doc.width), height: Math.round(doc.height) }
  }

  function normalizeBounds(bounds) {
    if (!bounds) return null
    const left = Math.round(Number(bounds.left) || 0)
    const top = Math.round(Number(bounds.top) || 0)
    const right = Math.round(Number(bounds.right) || 0)
    const bottom = Math.round(Number(bounds.bottom) || 0)
    const width = Math.max(0, right - left)
    const height = Math.max(0, bottom - top)
    return { left, top, right, bottom, width, height }
  }

  function assertUsableRegion(bounds, doc) {
    if (!bounds || bounds.width < MIN_REGION_PX || bounds.height < MIN_REGION_PX) {
      throw new Error(`可处理区域太小（${bounds?.width ?? 0}×${bounds?.height ?? 0}px）：请扩大选区/图层内容后重试。`)
    }
    if (bounds.width > MAX_REGION_EDGE_PX || bounds.height > MAX_REGION_EDGE_PX) {
      throw new Error(`区域过大（${bounds.width}×${bounds.height}px，上限 ${MAX_REGION_EDGE_PX}px）：请缩小选区，或分段处理。`)
    }
    if (doc && (bounds.width > doc.width * 2 || bounds.height > doc.height * 2)) {
      throw new Error('区域超出文档范围：请检查选区/图层状态。')
    }
  }

  /**
   * Resolve the region to edit.
   * @param {'auto'|'selection'|'layer'|'document'} requested
   */
  function resolveRegion(state, requested = 'auto') {
    const doc = state.document
    const selection = normalizeBounds(state.selection)
    const layerBounds = normalizeBounds(state.activeLayer?.bounds)

    if (requested === 'selection' || (requested === 'auto' && selection)) {
      if (!selection) {
        throw new Error('当前没有像素选区：请先用选框/套索等工具建立选区，或让 Agent 先调用 photoshop_select_subject / photoshop_select_rectangle。')
      }
      return { kind: 'selection', bounds: selection, maskSelection: true }
    }
    if (requested === 'layer' || (requested === 'auto' && layerBounds && layerBounds.width > 1 && layerBounds.height > 1)) {
      if (!layerBounds || layerBounds.width < 2 || layerBounds.height < 2) {
        throw new Error('当前图层没有可处理的像素范围：请换一个有内容的图层，或先建立选区。')
      }
      return { kind: 'layer', bounds: layerBounds, maskSelection: false }
    }
    if (requested === 'layer') {
      throw new Error('当前图层没有可处理的像素范围：请换一个有内容的图层，或先建立选区。')
    }
    return { kind: 'document', bounds: documentBounds(doc), maskSelection: false }
  }

  async function captureRegion(region, { maxDimension, expectedDocumentId } = {}) {
    const dir = await ensureOutputDir()
    const outPath = path.join(dir, `capture-${stamp()}-${Math.random().toString(36).slice(2, 7)}.png`)
    const captured = await runPs(
      captureScript({ outPath, source: region.kind === 'document' ? 'document' : region.kind, maxDimension, expectedDocumentId }),
      '从 Photoshop 抓取图像',
    )
    if (!captured || captured.ok === false) {
      throw new Error(`从 Photoshop 抓取图像失败：${captured?.message ?? '未知原因'}`)
    }
    const info = await fs.stat(captured.path || outPath).catch(() => null)
    if (!info || info.size < 512) {
      throw new Error('抓取到的图像文件为空或过小：请检查选区/图层内容。')
    }
    return { path: captured.path || outPath, bytes: info.size, bounds: normalizeBounds(captured.bounds) || region.bounds }
  }

  /**
   * Place one API result image back into the active document.
   * @param {{path: string}} image
   * @param {{kind: string, bounds: {left:number,top:number,width:number,height:number}, maskSelection: boolean}} region
   */
  async function placeResult(image, region, options = {}) {
    const state = await runPs(stateScript({ layerLimit: 1 }), '读取 Photoshop 状态')
    const doc = requireDocument(state)
    if (options.expectedDocumentId !== undefined && doc.id !== options.expectedDocumentId) {
      throw new Error('操作期间活动的 Photoshop 文档发生变化：已保留生成结果，请重新执行。')
    }
    const layerName = options.layerName || layerNameFor(options.prefix || 'AI Fill', options.prompt)
    const historyBefore = await historyInfo()
    const placed = await runPsLong(
      placeScript({
        filePath: image.path,
        bounds: region.bounds,
        fit: options.fit || config.defaultFit,
        name: layerName,
        maskSelection: options.maskSelection ?? region.maskSelection,
        center: options.center === true,
      }),
      '把生成结果写入 Photoshop 图层',
    )
    if (!placed || placed.ok === false) {
      throw new Error(`把生成结果写入 Photoshop 图层失败：${placed?.message ?? '未知原因'}`)
    }
    const historyAfter = await historyInfo()
    const sameDoc = historyBefore.ok === true && historyAfter.ok === true && historyBefore.docId === historyAfter.docId
    const historySteps = sameDoc ? Math.max(0, historyAfter.index - historyBefore.index) : 0
    return {
      ...placed,
      documentId: doc.id,
      historySteps,
      historyIndexAfter: historyAfter.ok === true ? historyAfter.index : undefined,
    }
  }

  function okResult(action, payload) {
    lastJob = { action, at: Date.now(), ...payload }
    return lastJob
  }

  /**
   * Generative fill: capture the selection (or layer/document) region, let the
   * image API edit it with the prompt, place the result as a masked layer.
   */
  async function fill(args = {}) {
    const started = Date.now()
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) throw new Error('缺少 prompt：请描述想要填充成什么内容。')
    const state = await getState()
    const doc = requireDocument(state)
    const region = resolveRegion(state, args.region || 'auto')
    assertUsableRegion(region.bounds, doc)
    const capture = await captureRegion(region)
    const apiResult = await api.edit({ prompt, imagePath: capture.path }).catch((error) => {
      throw new Error(describeError(error))
    })
    const placed = await placeResult(
      apiResult.images[0],
      region,
      { prompt, fit: args.fit, maskSelection: region.kind === 'selection' ? args.maskSelection !== false : false, prefix: 'AI Fill', layerName: args.layerName, expectedDocumentId: doc.id },
    )
    const result = okResult('generative_fill', {
      ok: true,
      action: 'generative_fill',
      layerName: placed.layerName,
      outputPath: apiResult.images[0].path,
      capturePath: capture.path,
      region: { kind: region.kind, bounds: region.bounds, masked: placed.maskCreated === true },
      document: { id: doc.id, name: doc.name, width: doc.width, height: doc.height },
      undoSteps: placed.historySteps,
      historyIndexAfter: placed.historyIndexAfter,
      documentId: doc.id,
      api: { model: api.config().editModel, durationMs: apiResult.durationMs },
      durationMs: Date.now() - started,
      message: `已生成并写入图层「${placed.layerName}」（${region.kind === 'selection' ? '选区' : region.kind === 'layer' ? '图层范围' : '整幅画布'} ${region.bounds.width}×${region.bounds.height}px${placed.maskCreated ? '，已按选区加蒙版' : ''}）。`,
    })
    return await attachPreview(result)
  }

  /** Generate a brand-new image and place it as a layer sized to the document. */
  async function generateLayer(args = {}) {
    const started = Date.now()
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) throw new Error('缺少 prompt：请描述想要生成的画面。')
    const state = await getState()
    const doc = requireDocument(state)
    const apiResult = await api
      .generate({ prompt, size: args.size })
      .catch((error) => {
        throw new Error(describeError(error))
      })
    const bounds = documentBounds(doc)
    const placed = await placeResult(apiResult.images[0], { kind: 'document', bounds, maskSelection: false }, {
      prompt,
      fit: args.fit || 'contain',
      center: true,
      prefix: 'AI Gen',
      layerName: args.layerName,
      expectedDocumentId: doc.id,
    })
    return await attachPreview(okResult('generate_layer', {
      ok: true,
      action: 'generate_layer',
      layerName: placed.layerName,
      outputPath: apiResult.images[0].path,
      region: { kind: 'document', bounds },
      document: { id: doc.id, name: doc.name, width: doc.width, height: doc.height },
      undoSteps: placed.historySteps,
      historyIndexAfter: placed.historyIndexAfter,
      documentId: doc.id,
      api: { model: api.config().generationModel, durationMs: apiResult.durationMs },
      durationMs: Date.now() - started,
      message: `已生成新图层「${placed.layerName}」，按文档 ${bounds.width}×${bounds.height}px 适配。`,
    }))
  }

  /** Image-to-image edit of the selection / layer / document, result placed back. */
  async function editImage(args = {}) {
    const started = Date.now()
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) throw new Error('缺少 prompt：请描述要如何修改画面。')
    const state = await getState()
    const doc = requireDocument(state)
    const region = resolveRegion(state, args.region || 'auto')
    assertUsableRegion(region.bounds, doc)
    const capture = await captureRegion(region)
    const apiResult = await api.edit({ prompt, imagePath: capture.path }).catch((error) => {
      throw new Error(describeError(error))
    })
    const placed = await placeResult(apiResult.images[0], region, {
      prompt,
      fit: args.fit,
      maskSelection: args.maskSelection === true && (region.kind === 'selection' || Boolean(state.selection)),
      prefix: 'AI Edit',
      layerName: args.layerName,
      expectedDocumentId: doc.id,
    })
    return await attachPreview(okResult('image_edit', {
      ok: true,
      action: 'image_edit',
      layerName: placed.layerName,
      outputPath: apiResult.images[0].path,
      capturePath: capture.path,
      region: { kind: region.kind, bounds: region.bounds, masked: placed.maskCreated === true },
      document: { id: doc.id, name: doc.name, width: doc.width, height: doc.height },
      undoSteps: placed.historySteps,
      historyIndexAfter: placed.historyIndexAfter,
      documentId: doc.id,
      api: { model: api.config().editModel, durationMs: apiResult.durationMs },
      durationMs: Date.now() - started,
      message: `已按描述编辑并写入新图层「${placed.layerName}」。`,
    }))
  }

  async function capturePreview(state) {
    const region = { kind: 'document', bounds: documentBounds(state.document) }
    const capture = await captureRegion(region, { maxDimension: 1024, expectedDocumentId: state.document.id })
    const bytes = await fs.readFile(capture.path)
    return {
      path: capture.path,
      bytes: bytes.length,
      mimeType: 'image/png',
      data: bytes.toString('base64'),
      bounds: capture.bounds,
      capturedAt: new Date().toISOString(),
    }
  }

  async function preview() {
    const state = await getState()
    requireDocument(state)
    const image = await capturePreview(state)
    return {
      ok: true,
      action: 'preview',
      document: {
        id: state.document.id,
        name: state.document.name,
        width: state.document.width,
        height: state.document.height,
      },
      preview: image,
      state: {
        selection: state.selection,
        activeLayer: state.activeLayer,
        layers: state.layers,
      },
      message: `已抓取当前画布预览（${Math.round(state.document.width)}×${Math.round(state.document.height)}px）。`,
    }
  }

  async function attachPreview(result) {
    try {
      const current = await preview()
      return { ...result, preview: current.preview, previewState: current.state }
    } catch (error) {
      return { ...result, previewError: error?.message ?? String(error) }
    }
  }

  /** Generate image files without touching Photoshop (useful to preview options). */
  async function generateImages(args = {}) {
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) throw new Error('缺少 prompt：请描述想要生成的画面。')
    const dir = await ensureOutputDir()
    const count = Math.min(4, Math.max(1, Number(args.n) || 1))
    const apiResult = await api
      .generate({ prompt, size: args.size, n: count, outDir: dir })
      .catch((error) => {
        throw new Error(describeError(error))
      })
    return {
      ok: true,
      action: 'generate_images',
      prompt,
      images: apiResult.images.map((image) => ({ path: image.path, bytes: image.bytes })),
      api: { model: api.config().generationModel, durationMs: apiResult.durationMs },
      message: `已生成 ${apiResult.images.length} 张图片：${apiResult.images.map((image) => path.basename(image.path)).join('、')}`,
    }
  }

  /** Place an existing local image file into the active document as a new layer. */
  async function placeImageFile(args = {}) {
    const rawPath = String(args.path ?? '').trim()
    if (!rawPath) throw new Error('缺少 path：请提供本地图片路径。')
    const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(expandHome(rawPath))
    const info = await fs.stat(filePath).catch(() => null)
    if (!info || !info.isFile()) throw new Error(`找不到图片文件：${filePath}`)
    const state = await getState()
    const doc = requireDocument(state)
    const placed = await placeResult({ path: filePath, bytes: info.size }, { kind: 'document', bounds: documentBounds(doc), maskSelection: false }, {
      prompt: args.layerName || path.basename(filePath),
      fit: args.fit || 'contain',
      center: true,
      prefix: 'AI Place',
      layerName: args.layerName,
      expectedDocumentId: doc.id,
    })
    return await attachPreview({
      ok: true,
      action: 'place_image',
      layerName: placed.layerName,
      outputPath: filePath,
      document: { id: doc.id, name: doc.name, width: doc.width, height: doc.height },
      undoSteps: placed.historySteps,
      historyIndexAfter: placed.historyIndexAfter,
      documentId: doc.id,
      message: `已把 ${path.basename(filePath)} 放入新图层「${placed.layerName}」。`,
    })
  }

  async function undo(args = {}) {
    let steps = Math.floor(Number(args.steps))
    if (!Number.isFinite(steps) || steps <= 0) {
      // Default: undo exactly the history steps this plugin's last operation created,
      // but only while the document is still at the history state that operation ended on.
      try {
        const state = await rawState()
        const docId = state?.document?.id
        if (lastJob && lastJob.undoSteps > 0 && lastJob.documentId === docId) {
          const info = await historyInfo()
          if (info.ok === true && info.index === lastJob.historyIndexAfter) steps = lastJob.undoSteps
        }
      } catch {
        /* fall back to one step */
      }
      if (!Number.isFinite(steps) || steps <= 0) steps = 1
    }
    steps = Math.min(30, Math.max(1, steps))
    const result = await runPsLong(undoScript({ steps }), '撤销 Photoshop 操作', 60000)
    if (!result || result.ok === false) {
      throw new Error(`撤销失败：${result?.message ?? '没有可撤销的历史步骤'}`)
    }
    return await attachPreview({
      ok: true,
      action: 'undo',
      steps: result.undone ?? steps,
      historyCount: result.historyCount,
      message: `已撤销 ${result.undone ?? steps} 步 Photoshop 历史。`,
    })
  }

  return {
    getState,
    fill,
    generateLayer,
    editImage,
    preview,
    generateImages,
    placeImageFile,
    undo,
    config: () => ({ ...api.config(), outputDir: expandHome(outputDir), defaultFit: config.defaultFit }),
    lastJob: () => lastJob,
  }
}
