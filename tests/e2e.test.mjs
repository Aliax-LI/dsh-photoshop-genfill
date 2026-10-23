/**
 * Lead-owned end-to-end test for the generative-fill plugin.
 *
 * Runs the real pipeline: real Adobe Photoshop 2026 (ExtendScript bridge) + the real
 * image API (unless PS_IMAGE_API_KEY is absent, in which case only the Photoshop half
 * runs and the API part is reported as skipped).
 *
 * Usage:
 *   PS_IMAGE_API_KEY=… node tests/e2e.test.mjs            # full pipeline
 *   node tests/e2e.test.mjs --no-api                      # Photoshop place/mask/undo only
 *
 * Never touches documents it did not create: it opens its own "DSH GenFill E2E" document
 * and closes it with DONOTSAVECHANGES in `finally`.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createPsBridge } from '../lib/ps-bridge.js'
import { createImageApi } from '../lib/image-api.js'
import { createPipeline } from '../lib/pipeline.js'
import { stateScript } from '../lib/ps-scripts.js'

const DOC_NAME = 'DSH GenFill E2E'
const API_BASE = process.env.PS_IMAGE_BASE_URL || 'https://chatgpt2api.343426.xyz/v1'
const API_KEY = process.env.PS_IMAGE_API_KEY || ''
const noApi = process.argv.includes('--no-api') || API_KEY === ''

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

async function main() {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ps-e2e-'))
  const bridge = createPsBridge({ appName: 'Adobe Photoshop 2026', timeoutMs: 120000 })
  const api = createImageApi({
    baseUrl: API_BASE,
    apiKey: API_KEY,
    model: 'gpt-image-2',
    timeoutMs: 240000,
    outputDir: outDir,
  })
  const config = {
    apiBaseUrl: API_BASE,
    apiKey: API_KEY,
    model: 'gpt-image-2',
    outputDir: outDir,
    requestTimeoutMs: 240000,
    defaultFit: 'cover',
  }
  const pipeline = createPipeline({ bridge, api, config })

  /** Activate our own test document and make sure it has the rectangular selection. */
  async function ensureSelection() {
    return await bridge.run(`
      var doc = null;
      for (var i = 0; i < app.documents.length; i++) {
        if (app.documents[i].name === ${JSON.stringify(DOC_NAME)}) doc = app.documents[i];
      }
      if (!doc) return { ok: false, code: 'no_document' };
      app.activeDocument = doc;
      var has = false;
      try { has = !!(doc.selection.bounds); } catch (eHas) { has = false; }
      if (!has) doc.selection.select([ [140, 160], [660, 160], [660, 440], [140, 440] ], SelectionType.REPLACE, 0, true);
      return { ok: true, docId: doc.id, name: doc.name, hasSelection: true };
    `, { timeoutMs: 60000 })
  }

  let setup = null
  try {
    // 1. Photoshop bridge + app info.
    const target = bridge.target()
    record('bridge target resolved', Boolean(target.appName || target.appPath), JSON.stringify(target))

    // 2. Create our own document with some content and a rectangular selection.
    setup = await bridge.run(`
      var existing = null;
      for (var i = 0; i < app.documents.length; i++) {
        if (app.documents[i].name === ${JSON.stringify(DOC_NAME)}) existing = app.documents[i];
      }
      if (existing) { app.activeDocument = existing; existing.close(SaveOptions.DONOTSAVECHANGES); }
      var __previousActiveId = null;
      try { if (app.documents.length > 0) __previousActiveId = app.activeDocument.id; } catch (ePrev) {}
      var doc = app.documents.add(UnitValue(900, 'px'), UnitValue(600, 'px'), 72, ${JSON.stringify(DOC_NAME)}, NewDocumentMode.RGB, DocumentFill.WHITE);
      var bg = doc.activeLayer;
      bg.name = 'Background Base';
      var paint = doc.artLayers.add();
      paint.name = 'Subject Shape';
      var pts = [ [140, 160], [660, 160], [660, 440], [140, 440] ];
      doc.selection.select(pts, SelectionType.REPLACE, 0, true);
      var color = new SolidColor();
      color.rgb.red = 40; color.rgb.green = 120; color.rgb.blue = 220;
      doc.selection.fill(color);
      doc.selection.select([ [140, 160], [660, 160], [660, 440], [140, 440] ], SelectionType.REPLACE, 0, true);
      return { docId: doc.id, name: doc.name, width: doc.width.as('px'), height: doc.height.as('px'), layers: doc.layers.length, previousActiveId: __previousActiveId };
    `, { timeoutMs: 60000 })
    record('test document created', setup?.docId !== undefined, JSON.stringify(setup))

    const state = await pipeline.getState()
    record('state has document', state.hasDocument === true, `${state.document?.name} ${state.document?.width}x${state.document?.height}`)
    record('state has selection', Boolean(state.selection), JSON.stringify(state.selection))
    record(
      'api configured' + (noApi ? ' (skipped: no key)' : ''),
      noApi ? true : state.api.hasKey === true,
      `${state.api.baseUrl} model=${state.api.model} hasKey=${state.api.hasKey}`,
    )

    if (!noApi) {
      const ensured = await ensureSelection()
      record('test document selection ready before fill', ensured?.ok === true, JSON.stringify(ensured))

      // 3. Generative fill: selection region -> image edit API -> masked layer.
      const fill = await pipeline.fill({ prompt: '赛博朋克夜景，霓虹灯，电影感，保持构图', region: 'selection' })
      record('generative fill returned', fill.ok === true, fill.message)
      const afterFill = await bridge.run(stateScript({ layerLimit: 10 }))
      record('fill layer exists', afterFill.document.layerCount === setup.layers + 1, `layers=${afterFill.document.layerCount} active=${afterFill.activeLayer?.name}`)
      record('fill layer masked', fill.region?.masked === true, `masked=${fill.region?.masked}`)
      const outStat = await fs.stat(fill.outputPath).catch(() => null)
      record('result image saved', Boolean(outStat && outStat.size > 4096), `${fill.outputPath} (${outStat?.size ?? 0} bytes)`)
      const head = outStat ? (await fs.readFile(fill.outputPath)).subarray(0, 8) : Buffer.alloc(0)
      record('result is PNG', head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), head.toString('hex'))

      // 4. One-click undo must roll back the whole placement (place + transform + mask + rename).
      record('fill recorded undo steps', fill.undoSteps > 0, `undoSteps=${fill.undoSteps} historyIndexAfter=${fill.historyIndexAfter}`)
      const undo = await pipeline.undo({})
      record('undo executed', undo.ok === true, undo.message)
      const afterUndo = await bridge.run(stateScript({ layerLimit: 10 }))
      record('undo removed fill layer', afterUndo.document.layerCount === setup.layers, `layers=${afterUndo.document.layerCount} doc=${afterUndo.document.name}`)
      if (afterUndo.document.layerCount !== setup.layers) {
        // Safety net for the later assertions: roll back whatever is left to the setup state.
        await pipeline.undo({ steps: 12 }).catch(() => {})
      }

      // 5. Generate a new image layer fitted to the canvas.
      const gen = await pipeline.generateLayer({ prompt: '极简产品海报，白色背景，中央红色圆点，高级感', fit: 'contain' })
      record('generate layer returned', gen.ok === true, gen.message)
      const afterGen = await bridge.run(stateScript({ layerLimit: 10 }))
      record('generate layer added', afterGen.document.layerCount === setup.layers + 1, `layers=${afterGen.document.layerCount} active=${afterGen.activeLayer?.name}`)

      // 6. Place an existing local file (the generated image) as a layer.
      const place = await pipeline.placeImageFile({ path: gen.outputPath, fit: 'contain', layerName: 'E2E Placed File' })
      record('place image file returned', place.ok === true, place.message)
      const afterPlace = await bridge.run(stateScript({ layerLimit: 10 }))
      record('place image file added layer', afterPlace.document.layerCount === setup.layers + 2, `layers=${afterPlace.document.layerCount}`)

      // 7. Generate options without touching Photoshop.
      const options = await pipeline.generateImages({ prompt: '两张极简海报配色方案', n: 2 })
      record('generate images (no PS) returned', options.ok === true && options.images.length === 2, options.message)
    }
  } finally {
    // Always remove our own document and temp output.
    try {
      const restoreId = Number.isFinite(setup?.previousActiveId) ? String(setup.previousActiveId) : 'null'
      await bridge.run(`
        for (var i = app.documents.length - 1; i >= 0; i--) {
          if (app.documents[i].name === ${JSON.stringify(DOC_NAME)}) {
            app.activeDocument = app.documents[i];
            app.documents[i].close(SaveOptions.DONOTSAVECHANGES);
          }
        }
        var __restoreId = ${restoreId};
        if (__restoreId !== null) {
          for (var j = 0; j < app.documents.length; j++) {
            if (app.documents[j].id === __restoreId) { app.activeDocument = app.documents[j]; break; }
          }
        }
        var __active = null;
        try { __active = app.activeDocument.name; } catch (eActive) {}
        return { closed: true, remaining: app.documents.length, active: __active };
      `, { timeoutMs: 60000 })
      record('test document cleaned up', true)
    } catch (error) {
      record('test document cleaned up', false, String(error?.message ?? error))
    }
    await bridge.dispose().catch(() => {})
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {})
  }

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('FAILED:', failed.map((item) => item.name).join(', '))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('E2E crashed:', error?.stack ?? error)
  process.exitCode = 1
})
