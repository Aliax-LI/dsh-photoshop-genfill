/**
 * @local/dsh-photoshop-genfill — Host half.
 *
 * Registers:
 *  - agent tools: ps_preview, ps_generative_fill, ps_generate_layer, ps_image_edit, ps_generate_images,
 *    ps_place_image, ps_state, ps_undo;
 *  - human slash commands: psfill, psgen, psedit, psstatus, psundo.
 *
 * Together with the bundle patch's `photoshop` MCP connection (all `mcp__photoshop__*` tools),
 * this lets the agent operate Photoshop and fill/generate/edit layers with an OpenAI-compatible
 * image API (gpt-image-2 by default) instead of Adobe's credit-based generative fill.
 *
 * @module @local/dsh-photoshop-genfill
 */

import z from '@deepseek-ai/schemastery'
import { createPsBridge } from './lib/ps-bridge.js'
import { createImageApi } from './lib/image-api.js'
import { createPipeline } from './lib/pipeline.js'

export const name = 'photoshop-genfill'

/** Services this plugin registers into. */
export const inject = ['tools', 'commands', 'attachments', 'systemPrompt']

const DEFAULTS = {
  apiBaseUrl: 'https://chatgpt2api.343426.xyz/v1',
  apiKey: '',
  model: 'gpt-image-2',
  generationModel: '',
  editModel: '',
  photoshopApp: 'Adobe Photoshop 2026',
  outputDir: '~/.dsh/photoshop-genfill',
  requestTimeoutMs: 180000,
  defaultFit: 'cover',
}

const FIT_VALUES = ['cover', 'stretch', 'contain']
const REGION_VALUES = ['auto', 'selection', 'layer', 'document']

/** Strip trailing slashes and guarantee one version suffix (`/v1`). */
function normalizeBaseUrl(raw) {
  let url = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!url) url = DEFAULTS.apiBaseUrl
  if (!/\/v\d+[a-z]*$/i.test(url)) url += '/v1'
  return url
}

export const Config = z.object({
  apiBaseUrl: z.string().default(DEFAULTS.apiBaseUrl),
  apiKey: z.string().default('').volatile(),
  model: z.string().default(DEFAULTS.model),
  generationModel: z.string().default(''),
  editModel: z.string().default(''),
  photoshopApp: z.string().default(DEFAULTS.photoshopApp),
  outputDir: z.string().default(DEFAULTS.outputDir),
  requestTimeoutMs: z.number().min(10000).max(600000).default(DEFAULTS.requestTimeoutMs),
  defaultFit: z.union([...FIT_VALUES]).default(DEFAULTS.defaultFit),
})

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const string = (key, fallback) => {
    const value = input[key]
    return value === undefined || value === null || value === '' ? fallback : String(value).trim() || fallback
  }
  const model = string('model', DEFAULTS.model)
  const generationModel = string('generationModel', model)
  const editModel = string('editModel', model)
  const requestTimeoutMs = Math.min(600000, Math.max(10000, Math.round(Number(input.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs))))
  const defaultFit = FIT_VALUES.includes(string('defaultFit', DEFAULTS.defaultFit).toLowerCase()) ? string('defaultFit', DEFAULTS.defaultFit).toLowerCase() : DEFAULTS.defaultFit
  return {
    apiBaseUrl: normalizeBaseUrl(string('apiBaseUrl', DEFAULTS.apiBaseUrl)),
    apiKey: typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : process.env.PS_GENFILL_API_KEY || '',
    model,
    generationModel,
    editModel,
    photoshopApp: string('photoshopApp', DEFAULTS.photoshopApp),
    outputDir: string('outputDir', DEFAULTS.outputDir),
    requestTimeoutMs,
    defaultFit,
  }
}
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Human-readable summary shared by tool renders and command results. */
function renderResult(value) {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value : JSON.stringify(value)
  if (value.ok === false) return `失败：${value.message ?? value.error ?? '未知错误'}`
  const lines = []
  if (value.message) lines.push(value.message)
  if (value.layerName) lines.push(`图层: ${value.layerName}`)
  if (value.document) {
    const doc = value.document
    lines.push(`文档: ${doc.name} (${Math.round(doc.width)}×${Math.round(doc.height)}px)`)
  }
  if (value.region?.bounds) {
    const r = value.region
    const masked = r.masked ? '，已加选区蒙版' : ''
    lines.push(`区域: ${r.kind} ${r.bounds.width}×${r.bounds.height}px @ (${r.bounds.left},${r.bounds.top})${masked}`)
  }
  if (value.api) {
    const seconds = value.api.durationMs ? ` / ${(value.api.durationMs / 1000).toFixed(1)}s` : ''
    lines.push(`图片 API: ${value.api.model}${seconds}`)
  }
  if (Array.isArray(value.images) && value.images.length > 0) {
    lines.push(`图片文件: ${value.images.map((image) => image.path).join('\n           ')}`)
  }
  if (value.outputPath && !Array.isArray(value.images)) lines.push(`输出: ${value.outputPath}`)
  if (value.capturePath) lines.push(`输入截图: ${value.capturePath}`)
  if (value.previewError) lines.push(`画布预览失败: ${value.previewError}`)
  return lines.join('\n')
}

function renderToolResult(value) {
  const blocks = [{ type: 'text', text: renderResult(value) }]
  if (value?.previewAttachment) blocks.push({ type: 'image', attachment: value.previewAttachment })
  return blocks
}

function renderState(state) {
  if (!state || state.ok === false) return `无法读取 Photoshop 状态：${state?.message ?? '未知原因'}`
  const lines = []
  const app = state.app ?? {}
  lines.push(`Photoshop: ${app.name ?? '?'} ${app.version ?? ''} (${state.bridge?.running ? '运行中' : '未运行'})`.trim())
  if (!state.hasDocument) {
    lines.push('文档: 未打开任何文档')
  } else {
    const doc = state.document ?? {}
    const saved = doc.saved === false ? '未保存' : '已保存'
    lines.push(`文档: ${doc.name} (${Math.round(doc.width)}×${Math.round(doc.height)}px, ${doc.resolution ?? '?'}ppi, ${saved})`)
    lines.push(`图层数: ${doc.layerCount}`)
    if (state.activeLayer) {
      const layer = state.activeLayer
      const bounds = layer.bounds ? ` ${Math.round(layer.bounds.right - layer.bounds.left)}×${Math.round(layer.bounds.bottom - layer.bounds.top)}px` : ''
      lines.push(`当前图层: ${layer.name} (${layer.kind}${bounds}${layer.visible === false ? ', 隐藏' : ''})`)
    }
    if (state.selection) {
      const selection = state.selection
      lines.push(`选区: ${Math.round(selection.width)}×${Math.round(selection.height)}px @ (${Math.round(selection.left)},${Math.round(selection.top)})`)
    } else {
      lines.push('选区: 无（可用 photoshop_select_subject / photoshop_select_rectangle 创建）')
    }
  }
  if (state.api) {
    const key = state.api.hasKey ? '已配置 Key' : '未配置 Key'
    lines.push(`图片 API: 生成=${state.api.generationModel ?? state.api.model}，编辑=${state.api.editModel ?? state.api.model} @ ${state.api.baseUrl} (${key})`)
  }
  if (state.outputDir) lines.push(`输出目录: ${state.outputDir}`)
  return lines.join('\n')
}

function summarizeStateForModel(state) {
  if (!state || state.ok === false) return state
  const doc = state.document ?? {}
  return {
    app: state.app,
    bridge: state.bridge,
    hasDocument: state.hasDocument,
    document: state.hasDocument
      ? {
          id: doc.id,
          name: doc.name,
          width: Math.round(doc.width),
          height: Math.round(doc.height),
          resolution: doc.resolution,
          colorMode: doc.colorMode,
          saved: doc.saved,
          layerCount: doc.layerCount,
        }
      : null,
    selection: state.selection
      ? {
          left: Math.round(state.selection.left),
          top: Math.round(state.selection.top),
          width: Math.round(state.selection.width),
          height: Math.round(state.selection.height),
        }
      : null,
    activeLayer: state.activeLayer,
    layers: Array.isArray(state.layers) ? state.layers.slice(0, 40) : state.layers,
    api: state.api,
    lastJob: state.lastJob
      ? { action: state.lastJob.action, layerName: state.lastJob.layerName, at: state.lastJob.at }
      : null,
  }
}

/**
 * Tool parameter names are model-facing snake_case; the pipeline API is camelCase.
 * Map the shared optional fields once at the boundary so a provided `layer_name` /
 * `mask_selection` is not silently ignored.
 */
function toPipelineArgs(args) {
  const input = args && typeof args === 'object' ? args : {}
  return {
    ...input,
    ...(input.layer_name !== undefined && input.layerName === undefined ? { layerName: input.layer_name } : {}),
    ...(input.mask_selection !== undefined && input.maskSelection === undefined ? { maskSelection: input.mask_selection } : {}),
  }
}

/** Wrap a pipeline method as a registered tool definition. */
function defineLocalTool({ name: toolName, description, parameters, execute, render, timeoutMs, attachments }) {
  return {
    name: toolName,
    description,
    parameters: parameters ?? { type: 'object', properties: {} },
    output: {
      schema: {},
      render(_args, value) {
        try {
          const rendered = (render ?? renderToolResult)(value)
          return Array.isArray(rendered) ? rendered : [{ type: 'text', text: String(rendered ?? '') }]
        } catch (error) {
          return [{ type: 'text', text: String(error?.message ?? error) }]
        }
      },
    },
    async execute(args) {
      const value = await execute(args && typeof args === 'object' ? args : {})
      if (value?.preview?.data && attachments?.saveImage) {
        const preview = value.preview
        const { data: _data, ...previewMetadata } = preview
        try {
          const previewAttachment = await attachments.saveImage({
            data: Buffer.from(preview.data, 'base64'),
            mediaType: preview.mimeType,
            name: 'photoshop-canvas-preview.png',
          })
          return { ...value, preview: previewMetadata, previewAttachment }
        } catch (error) {
          return { ...value, preview: previewMetadata, previewError: `Preview could not be attached: ${error?.message ?? error}` }
        }
      }
      return value
    },
    ...(timeoutMs ? { timeoutMs } : {}),
  }
}

const STRING = (description, extra = {}) => ({ type: 'string', description, ...extra })
const BOOLEAN = (description, extra = {}) => ({ type: 'boolean', description, ...extra })
const ENUM = (values, description, extra = {}) => ({ type: 'string', enum: values, description, ...extra })
const NUMBER = (description, extra = {}) => ({ type: 'number', description, ...extra })

function buildTools(pipeline, ctx) {
  const attachments = ctx.get('attachments')
  const define = (options) => defineLocalTool({ ...options, attachments })
  return [
    define({
      name: 'ps_preview',
      description:
        'Capture the current Photoshop canvas as an embedded PNG image plus document, selection, active-layer, and layer context. '
        + 'This is the primary visual inspection tool for the retouching agent. Call it before planning any visual edit and after every meaningful mutation to verify the result. '
        + 'Do not rely on text-only ps_state or assumptions about the canvas when choosing an edit.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      execute: () => pipeline.preview(),
      render: renderToolResult,
      timeoutMs: 180000,
    }),
    define({
      name: 'ps_generative_fill',
      description:
        'Photoshop generative fill through an external gpt-image-2-compatible image API (not Adobe Firefly, no Adobe credits). '
        + 'Captures the current selection (or the active layer/document region), sends it to /v1/images/edits with the prompt, '
        + 'then places the returned image back into the active document as a new smart-object layer, masked by the selection when one exists. '
        + 'Use for 生成式填充: replace/repaint selection content, restyle an area (e.g. "改成赛博朋克夜景"), remove or replace objects inside a selection. '
        + 'Before calling, use ps_preview and native Photoshop inspection tools to understand the image and target region. After calling, inspect the returned embedded preview; undo and retry if the result is visually wrong. '
        + 'Preconditions: Photoshop has an open document; create/refine the selection first with the photoshop_select_* MCP tools '
        + '(photoshop_select_rectangle, photoshop_select_subject, photoshop_expand_selection…). '
        + 'For a whole new picture use ps_generate_layer; to edit the whole canvas use ps_image_edit. One call = one generated image.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: STRING('What to fill/repaint the region with, e.g. "赛博朋克夜景，霓虹灯，电影感". Detailed English prompts usually work best.'),
          region: ENUM(REGION_VALUES, 'Region to capture: auto (selection, else active layer bounds, else document), selection, layer, or document. Default auto.'),
          fit: ENUM(FIT_VALUES, 'How the generated image fills the region: cover (default, keep aspect and crop), stretch, contain.'),
          mask_selection: BOOLEAN('When a selection exists, mask the new layer with it so only the selection shows. Default true.'),
          layer_name: STRING('Optional name for the new Photoshop layer.'),
        },
        required: ['prompt'],
      },
      execute: (args) => pipeline.fill(toPipelineArgs(args)),
      render: renderResult,
      timeoutMs: 420000,
    }),

    define({
      name: 'ps_generate_layer',
      description:
        'Generate a brand-new image from a text prompt with the configured gpt-image-2-compatible /v1/images/generations endpoint and place it '
        + 'as a new layer in the active Photoshop document, fitted to the canvas. '
        + 'Use when the user asks for a new picture/visual/background/素材 to be created and inserted into the current document. '
        + 'Preconditions: an open Photoshop document. Use ps_generate_images instead when the user only wants image files to review.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: STRING('Image description, e.g. "极简产品海报，白色背景，柔和阴影，高级感".'),
          size: STRING('Optional size such as "1024x1024"; omit to let the service choose.'),
          fit: ENUM(['contain', 'cover', 'stretch'], 'How the new layer fits the canvas: contain (default), cover, stretch.'),
          layer_name: STRING('Optional name for the new Photoshop layer.'),
        },
        required: ['prompt'],
      },
      execute: (args) => pipeline.generateLayer(toPipelineArgs(args)),
      render: renderResult,
      timeoutMs: 420000,
    }),

    define({
      name: 'ps_image_edit',
      description:
        'Image-to-image edit of the current Photoshop selection/layer/document with the configured gpt-image-2-compatible /v1/images/edits endpoint. '
        + 'Captures the region, applies the prompt as an edit (style transfer, relight, color grade, add/remove content), and places the result as a new layer. '
        + 'For precision retouching, prefer native Photoshop adjustment, mask, and retouch recipes; use this broad external image edit only when appropriate. Inspect the current canvas with ps_preview first and verify its returned preview afterward. '
        + 'Unlike ps_generative_fill it does not mask by the selection unless mask_selection is true, so it can update the whole captured area. '
        + 'Preconditions: an open document. Use for 图生图/局部修改/风格转换.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: STRING('The edit instruction, e.g. "改成赛博朋克夜景，霓虹灯" or "warm cinematic color grade".'),
          region: ENUM(REGION_VALUES, 'Region to capture: auto (default), selection, layer, or document.'),
          fit: ENUM(FIT_VALUES, 'How the result fills the region: cover (default), stretch, contain.'),
          mask_selection: BOOLEAN('Mask the new layer with the current selection. Default false.'),
          layer_name: STRING('Optional name for the new Photoshop layer.'),
        },
        required: ['prompt'],
      },
      execute: (args) => pipeline.editImage(toPipelineArgs(args)),
      render: renderResult,
      timeoutMs: 420000,
    }),

    define({
      name: 'ps_generate_images',
      description:
        'Generate one or more image files from a text prompt with the configured gpt-image-2-compatible API and return their paths WITHOUT touching Photoshop. '
        + 'Use when the user wants options/previews first; place the chosen one afterwards with ps_place_image or ps_generate_layer/ps_generative_fill. '
        + 'No Photoshop document is required.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: STRING('Image description.'),
          size: STRING('Optional size such as "1024x1024".'),
          n: NUMBER('How many images to generate (1-4). Default 1.', { minimum: 1, maximum: 4 }),
        },
        required: ['prompt'],
      },
      execute: (args) => pipeline.generateImages(toPipelineArgs(args)),
      render: renderResult,
      timeoutMs: 420000,
    }),

    define({
      name: 'ps_place_image',
      description:
        'Place an existing local image file (PNG/JPEG/PSD…) into the active Photoshop document as a new smart-object layer fitted to the canvas. '
        + 'Use after ps_generate_images, or to place any downloaded/generated asset.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: STRING('Absolute path (or ~/...) of the image file to place.'),
          fit: ENUM(['contain', 'cover', 'stretch'], 'How the layer fits the canvas: contain (default), cover, stretch.'),
          layer_name: STRING('Optional name for the new Photoshop layer.'),
        },
        required: ['path'],
      },
      execute: (args) => pipeline.placeImageFile(toPipelineArgs(args)),
      render: renderResult,
      timeoutMs: 180000,
    }),

    define({
      name: 'ps_state',
      description:
        'Inspect Photoshop and this plugin before acting: running state, open documents, active document size, current pixel selection bounds, '
        + 'active layer and layer list, plus the configured image API (base URL/model/key presence) and output directory. '
        + 'Call it first when a Photoshop operation fails or before asking the user for missing context.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          include_layers: BOOLEAN('Include the top layer names. Default true.'),
        },
      },
      execute: async (args) => {
        const state = await pipeline.getState()
        const summarized = summarizeStateForModel(state)
        if (args.include_layers === false && summarized && typeof summarized === 'object') {
          summarized.layers = undefined
        }
        return {
          ok: state?.ok !== false,
          state: summarized,
          text: renderState(state),
        }
      },
      render: (value) => (value?.text ? value.text : renderResult(value)),
      timeoutMs: 120000,
    }),

    define({
      name: 'ps_undo',
      description:
        'Undo Photoshop history in the active document. With no `steps`, it rolls back exactly the history steps created by the last '
        + 'ps_generative_fill / ps_generate_layer / ps_image_edit / ps_place_image call while the document is still at that state; pass `steps` to undo a '
        + 'specific number of history steps. Use it after an AI operation to remove the generated layer, or when the user asks to undo.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          steps: NUMBER('Optional explicit number of history steps to undo (1-30). Omit to roll back the last AI operation.', { minimum: 1, maximum: 30 }),
        },
      },
      execute: (args) => pipeline.undo(args),
      render: renderResult,
      timeoutMs: 120000,
    }),
  ]
}

/** Parse the free-form command input into {steps} for psundo. */
function parseSteps(rawInput) {
  const match = String(rawInput ?? '').match(/\d+/)
  if (!match) return { steps: 1 }
  return { steps: Math.min(30, Math.max(1, Number(match[0]))) }
}

function failureText(error) {
  return error?.message ? String(error.message) : String(error)
}

function buildCommands(pipeline) {
  const run = (label, action, format) => async ({ rawInput }) => {
    const input = String(rawInput ?? '').trim()
    try {
      const value = await action(input)
      const body = format ? format(value, input) : renderResult(value)
      return { kind: 'success', text: `✅ ${label}\n${body}` }
    } catch (error) {
      return { kind: 'error', text: `❌ ${label}失败：${failureText(error)}` }
    }
  }

  return [
    {
      name: 'psfill',
      description: 'Photoshop 生成式填充：把选区/图层内容按提示词重绘，并把结果写回新图层（调用图片 API，不消耗 Adobe 额度）',
      input: { hint: '<提示词，例如：赛博朋克夜景，霓虹灯>' },
      handler: run('生成式填充', async (input) => {
        if (!input) throw new Error('请在命令后面输入提示词，例如 /psfill 赛博朋克夜景')
        return pipeline.fill({ prompt: input, region: 'auto' })
      }),
    },
    {
      name: 'psgen',
      description: '调用图片 API 生成一张新图并放入当前 Photoshop 文档（新图层，适配画布）',
      input: { hint: '<画面描述，例如：极简产品海报，白色背景>' },
      handler: run('生成新图层', async (input) => {
        if (!input) throw new Error('请在命令后面输入画面描述，例如 /psgen 极简产品海报')
        return pipeline.generateLayer({ prompt: input })
      }),
    },
    {
      name: 'psedit',
      description: '图生图：按提示词编辑当前选区/图层/画布，并把结果写回新图层',
      input: { hint: '<修改要求，例如：改成赛博朋克夜景>' },
      handler: run('图片编辑', async (input) => {
        if (!input) throw new Error('请在命令后面输入修改要求，例如 /psedit 改成赛博朋克夜景')
        return pipeline.editImage({ prompt: input, region: 'auto' })
      }),
    },
    {
      name: 'psstatus',
      description: '查看 Photoshop 连接、当前文档/选区/图层与图片 API 配置状态',
      handler: run('Photoshop 状态', async () => {
        const state = await pipeline.getState()
        return { ...state, text: renderState(state) }
      }, (value) => value.text),
    },
    {
      name: 'psundo',
      description: '撤销上一步（或多步）Photoshop 历史操作，例如 /psundo 2',
      input: { hint: '[步数，默认 1]' },
      handler: run('撤销', async (input) => pipeline.undo(parseSteps(input))),
    },
  ]
}

/**
 * Activate the plugin: one Photoshop bridge, one image API client, one pipeline, then
 * the tool and command registrations. Everything is disposed with the plugin fiber.
 */
export function apply(ctx, config) {
  const effective = normalizeConfig(config)
  ctx.effect(() => {
    const bridge = createPsBridge({
      appName: effective.photoshopApp,
      timeoutMs: 120000,
    })
    const api = createImageApi({
      baseUrl: effective.apiBaseUrl,
      apiKey: effective.apiKey,
      model: effective.model,
      generationModel: effective.generationModel,
      editModel: effective.editModel,
      timeoutMs: effective.requestTimeoutMs,
      outputDir: effective.outputDir,
    })
    const pipeline = createPipeline({ bridge, api, config: effective })

    const disposers = []
    disposers.push(ctx.systemPrompt.section({
      name: 'photoshop:retouch-workflow',
      order: 100,
      text: [
        '## Photoshop retouching workflow',
        '- Treat Photoshop as a visual editing session, not a prompt-to-image toy. Before choosing an edit, inspect the active document and call `ps_preview` or `photoshop_get_preview` to view the actual composite. If multiple documents are open, identify and pin the intended document before mutating it.',
        '- Translate the request into a small edit plan: target region, requested change, what must remain unchanged, and whether a broad generative edit is appropriate. Ask a short clarification when region, strength, or preservation requirements are materially ambiguous.',
        '- Prefer Photoshop-native non-destructive adjustment layers, masks, Smart Objects, and focused recipes for normal retouching. Do not replace the whole image with `ps_image_edit` or external image generation for localized cleanup. Use external image APIs only when the user requested generative changes or broad image-to-image work; they transmit image pixels to the configured third-party endpoint.',
        '- Make one meaningful change at a time. After each change, inspect a fresh canvas preview and relevant layer/selection state. Compare against the request and preserve identity, texture, edges, logos, text, and composition unless asked otherwise. If the result is wrong, undo the exact operation and retry with a narrower region or lower strength; keep iterations bounded.',
        '- Do not claim precise healing/clone retouch when no native brush stroke tool is available. Do not flatten, rasterize, overwrite source pixels, or save/export destructively unless the user asked for it. Before delivery, show/inspect the final canvas and summarize layers, external AI use, and any limitations.',
      ].join('\\n'),
    }))
    for (const tool of buildTools(pipeline, ctx)) {
      disposers.push(ctx.tools.register(tool))
    }
    for (const command of buildCommands(pipeline)) {
      disposers.push(ctx.commands.register(command))
    }

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
      try {
        bridge.dispose?.()
      } catch {
        /* best effort */
      }
    }
  }, 'photoshop-genfill')
}
