import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createPipeline } from '../lib/pipeline.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('preview captures the current canvas as bounded PNG and pins the inspected document', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ps-preview-test-'))
  const scripts = []
  const state = {
    ok: true,
    hasDocument: true,
    document: { id: 59, name: 'Preview test', width: 2400, height: 3600 },
    selection: null,
    activeLayer: { name: 'Retouch', bounds: { left: 0, top: 0, right: 2400, bottom: 3600 } },
    layers: [{ name: 'Retouch', kind: 'normal', visible: true }],
  }
  const bridge = {
    target: () => ({ appName: 'Photoshop' }),
    isRunning: async () => true,
    run: async (body) => {
      scripts.push(body)
      if (!body.includes('var maxEdge =')) return state
      const match = body.match(/var outFile = new File\(("(?:[^"\\]|\\.)*")\)/)
      assert.ok(match, 'preview script includes an output file path')
      const filePath = JSON.parse(match[1])
      await fs.writeFile(filePath, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(512)]))
      return {
        ok: true,
        path: filePath,
        bounds: { left: 0, top: 0, right: 2400, bottom: 3600, width: 2400, height: 3600 },
      }
    },
    runLong: async () => ({}),
    dispose: async () => {},
  }
  const api = { config: () => ({ model: 'test' }) }
  const pipeline = createPipeline({
    bridge,
    api,
    config: { outputDir, defaultFit: 'cover' },
  })

  try {
    const result = await pipeline.preview()
    assert.equal(result.ok, true)
    assert.equal(result.document.id, 59)
    assert.equal(result.preview.mimeType, 'image/png')
    assert.equal(result.preview.data, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(512)]).toString('base64'))
    assert.match(scripts[1], /var maxEdge = 1024;/)
    assert.match(scripts[1], /doc\.id !== 59/)
    assert.equal(result.state.activeLayer.name, 'Retouch')
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true })
  }
})
