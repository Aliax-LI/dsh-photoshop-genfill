/**
 * Tests for lib/image-api.js — Node 22 builtins only, no npm packages.
 *
 * Run the offline/stub suite:
 *   node --test tests/image-api.test.mjs
 *
 * Run the live suite against the real ChatGPT2API service (key from env only,
 * never written to any file). When PS_IMAGE_API_KEY is present, three extra
 * `live:` tests run: fake-key auth mapping, one real generation, one real edit.
 *   PS_IMAGE_API_KEY=... node --test tests/image-api.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { deflateSync } from 'node:zlib'

import { createImageApi, DEFAULT_BASE_URL, DEFAULT_MODEL, ImageApiError } from '../lib/image-api.js'

// ---------------------------------------------------------------------------
// fixtures: dependency-free PNG writer (also used as real-edit input)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(width, height, pixelAt) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelAt(x, y)
      const offset = y * stride + 1 + x * 4
      raw[offset] = r & 0xff
      raw[offset + 1] = g & 0xff
      raw[offset + 2] = b & 0xff
      raw[offset + 3] = a & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// 32x32 keeps the base64 payload above the `raw` redaction threshold (256 chars)
// and is a realistic small PNG for multipart/edit fixtures.
const TEST_PNG = encodePng(32, 32, (x, y) => [x * 8, y * 8, 128, 255])
const TEST_PNG_B64 = TEST_PNG.toString('base64')

function assertPng(bytes, label = 'image') {
  assert.ok(bytes.length > PNG_SIGNATURE.length, `${label} should be non-trivial`)
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE, `${label} should start with the PNG signature`)
}

// ---------------------------------------------------------------------------
// shared temp space + stub servers
// ---------------------------------------------------------------------------

const TMP_ROOT = await mkdtemp(path.join(tmpdir(), 'dsh-image-api-test-'))
const openServers = new Set()

async function tmpOutDir(name) {
  const directory = path.join(TMP_ROOT, name)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  return directory
}

/**
 * Start a tiny node:http stub. `handler(req, res, body)` receives the fully
 * buffered request body.
 */
async function startServer(handler) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    calls.push({ method: req.method, url: req.url, headers: req.headers, body })
    try {
      await handler(req, res, body)
    } catch {
      try {
        res.statusCode = 500
        res.end('stub handler failure')
      } catch {
        /* client may already be gone */
      }
    }
  })
  server.on('clientError', (err, socket) => socket.destroy(err))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  openServers.add(server)
  const port = server.address().port
  return {
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: async () => {
      openServers.delete(server)
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Obtain a 127.0.0.1 port that is guaranteed closed (for network-error tests). */
async function closedPortBaseUrl() {
  const probe = await startServer(() => {})
  const baseUrl = probe.baseUrl
  await probe.close()
  return baseUrl
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function pngResponse() {
  return new Response(TEST_PNG, { status: 200, headers: { 'content-type': 'image/png' } })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sendPng(res) {
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': TEST_PNG.length })
  res.end(TEST_PNG)
}

function apiFor(server, { outDir, ...rest } = {}) {
  return createImageApi({
    baseUrl: server.baseUrl,
    apiKey: 'test-key',
    timeoutMs: 5000,
    outputDir: outDir ?? path.join(TMP_ROOT, 'default-out'),
    ...rest,
  })
}

/** fetchImpl that never touches the network: JSON for API calls, PNG for /files/*. */
function makeInjectedFetch({ generationPayload, editPayload } = {}) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, method: init.method ?? 'GET', init })
    const pathname = new URL(url).pathname
    if (init.method === 'POST' && pathname.endsWith('/images/generations')) {
      return jsonResponse(typeof generationPayload === 'function' ? generationPayload() : generationPayload)
    }
    if (init.method === 'POST' && pathname.endsWith('/images/edits')) {
      return jsonResponse(typeof editPayload === 'function' ? editPayload() : editPayload ?? { data: [] })
    }
    if (pathname.startsWith('/files/')) return pngResponse()
    throw new Error(`unexpected fetch in injected fetch stub: ${init.method ?? 'GET'} ${url}`)
  }
  return { fetchImpl, calls }
}

after(async () => {
  for (const server of [...openServers]) {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
  await rm(TMP_ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// config() + argument validation
// ---------------------------------------------------------------------------

test('config() reports normalised baseUrl/model and whether a key is configured', () => {
  const custom = createImageApi({ baseUrl: 'http://127.0.0.1:9/v1/', apiKey: 'k', model: 'm' })
  assert.deepEqual(custom.config(), { baseUrl: 'http://127.0.0.1:9/v1', model: 'm', generationModel: 'm', editModel: 'm', hasKey: true })

  const defaults = createImageApi({ apiKey: '' })
  assert.deepEqual(defaults.config(), { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL, generationModel: DEFAULT_MODEL, editModel: DEFAULT_MODEL, hasKey: false })
})

test('empty apiKey fails with a readable auth error before any request', async () => {
  const api = createImageApi({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', outputDir: path.join(TMP_ROOT, 'nokey') })
  await assert.rejects(api.generate({ prompt: 'x' }), (err) => {
    assert.ok(err instanceof ImageApiError)
    assert.equal(err.code, 'auth')
    assert.match(err.message, /未配置 API Key/)
    return true
  })
  await assert.rejects(api.edit({ prompt: 'x', imagePath: '/definitely/missing.png' }), (err) => {
    assert.equal(err.code, 'auth')
    return true
  })
})

test('prompt/n/imagePath validation fails with shape errors', async () => {
  const api = createImageApi({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', outputDir: path.join(TMP_ROOT, 'validation') })
  await assert.rejects(api.generate({ prompt: '   ' }), { code: 'shape' })
  await assert.rejects(api.generate({ prompt: 'ok', n: 5 }), { code: 'shape' })
  await assert.rejects(api.generate({ prompt: 'ok', n: 1.5 }), { code: 'shape' })
  await assert.rejects(api.edit({ prompt: 'ok' }), { code: 'shape' })
  await assert.rejects(
    api.edit({ prompt: 'ok', imagePath: path.join(TMP_ROOT, 'validation', 'missing.png') }),
    (err) => {
      assert.equal(err.code, 'shape')
      assert.match(err.message, /找不到待编辑的图片文件/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// generate(): response shapes
// ---------------------------------------------------------------------------

test('generate(): data[].b64_json (real service shape) is decoded and saved as PNG', async () => {
  const server = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      sendJson(res, 200, {
        created: 1778470000,
        data: [
          {
            url: `${server.origin}/images/example.png?token=super-secret`,
            b64_json: TEST_PNG_B64,
            revised_prompt: 'a red circle',
            output_format: 'png',
          },
        ],
      })
      return
    }
    sendJson(res, 404, { error: { message: `unexpected ${req.method} ${req.url}` } })
  })
  const outDir = await tmpOutDir('b64')
  const api = apiFor(server, { outDir })

  const result = await api.generate({ prompt: 'a red circle', size: '1024x1024', n: 1 })

  assert.equal(server.calls.length, 1, 'b64_json must win over the download URL (no image download request)')
  const request = server.calls[0]
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/v1/images/generations')
  assert.equal(request.headers.authorization, 'Bearer test-key')
  assert.match(request.headers['content-type'], /^application\/json/)
  assert.deepEqual(JSON.parse(request.body.toString('utf8')), {
    model: 'gpt-image-2',
    prompt: 'a red circle',
    n: 1,
    size: '1024x1024',
  })

  assert.equal(result.images.length, 1)
  const [image] = result.images
  assert.equal(image.bytes, TEST_PNG.length)
  assert.equal(image.mimeType, 'image/png')
  assert.equal(path.dirname(image.path), outDir)
  assertPng(await readFile(image.path), 'saved generation')
  assert.equal(typeof result.durationMs, 'number')
  assert.ok(result.durationMs >= 0)

  // raw stays useful for debugging but redacts base64 blobs and URL queries.
  assert.ok(result.raw)
  assert.match(result.raw.data[0].b64_json, /^<base64:\d+ chars>$/)
  assert.equal(result.raw.data[0].url, `${server.origin}/images/example.png?<query>`)
  assert.ok(!JSON.stringify(result.raw).includes('super-secret'))
  assert.equal(result.raw.data[0].revised_prompt, 'a red circle')

  await server.close()
})

test('generate(): data[].url is downloaded and saved, with auth only for the API origin', async () => {
  // Same-origin image URL: the request must carry the bearer token.
  const apiServer = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      sendJson(res, 200, {
        created: 1,
        data: [{ url: `${apiServer.origin}/files/from-url.png`, revised_prompt: 'from a url' }],
      })
      return
    }
    if (req.method === 'GET' && req.url === '/files/from-url.png') {
      sendPng(res)
      return
    }
    sendJson(res, 404, { error: { message: 'not found' } })
  })
  const outDir = await tmpOutDir('url')
  const api = apiFor(apiServer, { outDir })

  const result = await api.generate({ prompt: 'download me' })
  assert.equal(result.images.length, 1)
  assertPng(await readFile(result.images[0].path), 'downloaded generation')
  assert.equal(result.images[0].bytes, TEST_PNG.length)
  assert.equal(result.images[0].mimeType, 'image/png')

  const download = apiServer.calls.find((call) => call.method === 'GET' && call.url === '/files/from-url.png')
  assert.ok(download, 'image URL should be downloaded')
  assert.equal(download.headers.authorization, 'Bearer test-key', 'same-origin downloads carry the API key')

  // Cross-origin image URL: the API key must NOT be forwarded.
  const foreign = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/files/cross.png') {
      sendPng(res)
      return
    }
    sendJson(res, 404, { error: { message: 'not found' } })
  })
  const crossServer = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      sendJson(res, 200, { data: [{ url: `${foreign.origin}/files/cross.png` }] })
      return
    }
    sendJson(res, 404, { error: { message: 'not found' } })
  })
  const crossApi = apiFor(crossServer, { outDir: await tmpOutDir('cross') })
  const crossResult = await crossApi.generate({ prompt: 'cross origin download' })
  assert.equal(crossResult.images.length, 1)
  assertPng(await readFile(crossResult.images[0].path), 'cross-origin download')
  const foreignDownload = foreign.calls.find((call) => call.method === 'GET' && call.url === '/files/cross.png')
  assert.ok(foreignDownload)
  assert.equal(foreignDownload.headers.authorization, undefined, 'API key must not leak to third-party hosts')

  await Promise.all([apiServer.close(), foreign.close(), crossServer.close()])
})

test('generate(): tolerates all reasonable OpenAI-compatible response shapes', async (t) => {
  const cases = [
    { name: 'top-level url', payload: { url: 'https://img.test/files/top.png' } },
    { name: 'images[] of url strings', payload: { images: ['https://img.test/files/images-a.png'] } },
    { name: 'images[] of objects', payload: { images: [{ b64_json: TEST_PNG_B64 }] } },
    { name: 'output[] of objects with url', payload: { output: [{ url: 'https://img.test/files/output-a.png' }] } },
    { name: 'output[] of base64 strings', payload: { output: [TEST_PNG_B64] } },
    { name: 'data[] with nested image_url object', payload: { data: [{ image_url: { url: 'https://img.test/files/nested.png' } }] } },
    { name: 'images[] with data URL', payload: { images: [`data:image/png;base64,${TEST_PNG_B64}`] } },
    {
      name: 'data[] recovering from empty b64_json via url',
      payload: { data: [{ b64_json: '', url: 'https://img.test/files/recovered.png' }] },
    },
    {
      name: 'Responses-style output[] image_generation_call result',
      payload: { output: [{ type: 'image_generation_call', result: TEST_PNG_B64 }] },
    },
  ]

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { fetchImpl } = makeInjectedFetch({ generationPayload: entry.payload })
      const outDir = await tmpOutDir(`shape-${createHash('sha1').update(entry.name).digest('hex').slice(0, 8)}`)
      const api = createImageApi({
        baseUrl: 'https://api.test/v1',
        apiKey: 'test-key',
        timeoutMs: 5000,
        outputDir: outDir,
        fetchImpl,
      })
      const result = await api.generate({ prompt: 'shape probe' })
      assert.equal(result.images.length, 1, `${entry.name}: one image expected`)
      assertPng(await readFile(result.images[0].path), entry.name)
      assert.equal(result.images[0].mimeType, 'image/png')
    })
  }
})

test('generate(): raw image/* response body is saved directly', async () => {
  const server = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      sendPng(res)
      return
    }
    sendJson(res, 404, { error: { message: 'not found' } })
  })
  const outDir = await tmpOutDir('direct-bytes')
  const api = apiFor(server, { outDir })
  const result = await api.generate({ prompt: 'direct bytes' })
  assert.equal(result.images.length, 1)
  assertPng(await readFile(result.images[0].path), 'direct image response')
  await server.close()
})

test('generate(): every call writes a uniquely named file', async () => {
  const server = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      sendJson(res, 200, { data: [{ b64_json: TEST_PNG_B64 }] })
      return
    }
    sendJson(res, 404, { error: { message: 'not found' } })
  })
  const outDir = await tmpOutDir('unique')
  const api = apiFor(server, { outDir })
  const first = await api.generate({ prompt: 'one' })
  const second = await api.generate({ prompt: 'two' })
  assert.notEqual(first.images[0].path, second.images[0].path)
  assert.equal(path.dirname(first.images[0].path), outDir)
  await server.close()
})

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------

test('401 with the real service payload maps to code=auth and a readable message', async () => {
  const payload = {
    error: {
      message: '密钥无效或已失效，请重新登录',
      type: 'authentication_error',
      param: null,
      code: 'invalid_api_key',
    },
  }
  const server = await startServer((req, res) => sendJson(res, 401, payload))
  const api = apiFor(server, { outDir: await tmpOutDir('auth-401') })
  await assert.rejects(api.generate({ prompt: 'hello' }), (err) => {
    assert.ok(err instanceof ImageApiError)
    assert.equal(err.code, 'auth')
    assert.equal(err.status, 401)
    assert.match(err.message, /HTTP 401/)
    assert.match(err.message, /密钥无效或已失效/)
    assert.match(err.message, /invalid_api_key/)
    assert.match(err.message, /apiKey/)
    assert.equal(err.detail, '密钥无效或已失效，请重新登录')
    return true
  })
  await server.close()
})

test('401 FastAPI-style {"detail":{"error":...}} payload also maps to auth', async () => {
  const server = await startServer((req, res) => sendJson(res, 401, { detail: { error: 'authorization is invalid' } }))
  const api = apiFor(server, { outDir: await tmpOutDir('auth-detail') })
  await assert.rejects(api.generate({ prompt: 'hello' }), (err) => {
    assert.equal(err.code, 'auth')
    assert.equal(err.status, 401)
    assert.match(err.message, /authorization is invalid/)
    return true
  })
  await server.close()
})

test('403 maps to auth; 500 maps to http with status and server message', async () => {
  const forbidden = await startServer((req, res) => sendJson(res, 403, { error: { message: 'permission denied' } }))
  const forbiddenApi = apiFor(forbidden, { outDir: await tmpOutDir('http-403') })
  await assert.rejects(forbiddenApi.generate({ prompt: 'x' }), (err) => {
    assert.equal(err.code, 'auth')
    assert.equal(err.status, 403)
    assert.match(err.message, /permission denied/)
    return true
  })
  await forbidden.close()

  const failing = await startServer((req, res) => sendJson(res, 500, { error: { message: 'upstream exploded' } }))
  const failingApi = apiFor(failing, { outDir: await tmpOutDir('http-500') })
  await assert.rejects(failingApi.generate({ prompt: 'x' }), (err) => {
    assert.equal(err.code, 'http')
    assert.equal(err.status, 500)
    assert.match(err.message, /HTTP 500/)
    assert.match(err.message, /upstream exploded/)
    assert.equal(err.detail, 'upstream exploded')
    return true
  })
  await failing.close()
})

test('429 quota/rate limit is mapped to http with an actionable hint', async () => {
  const server = await startServer((req, res) =>
    sendJson(res, 429, {
      error: { message: 'no available image quota', type: 'insufficient_quota', code: 'insufficient_quota' },
    }),
  )
  const api = apiFor(server, { outDir: await tmpOutDir('http-429') })
  await assert.rejects(api.generate({ prompt: 'x' }), (err) => {
    assert.equal(err.code, 'http')
    assert.equal(err.status, 429)
    assert.match(err.message, /429/)
    assert.match(err.message, /no available image quota/)
    assert.match(err.message, /额度/)
    return true
  })
  await server.close()
})

test('400 image_generation_text_response maps to code=empty with prompt advice', async () => {
  const server = await startServer((req, res) =>
    sendJson(res, 400, {
      error: {
        message: 'Image generation returned a text response instead of image data.',
        type: 'invalid_request_error',
        code: 'image_generation_text_response',
      },
    }),
  )
  const api = apiFor(server, { outDir: await tmpOutDir('text-response') })
  await assert.rejects(api.generate({ prompt: 'x' }), (err) => {
    assert.equal(err.code, 'empty')
    assert.equal(err.status, 400)
    assert.match(err.message, /image_generation_text_response/)
    assert.match(err.message, /改写提示词/)
    return true
  })
  await server.close()
})

test('unreachable host maps to code=network', async () => {
  const baseUrl = await closedPortBaseUrl()
  const api = createImageApi({ baseUrl, apiKey: 'test-key', timeoutMs: 3000, outputDir: path.join(TMP_ROOT, 'network') })
  await assert.rejects(api.generate({ prompt: 'x' }), (err) => {
    assert.equal(err.code, 'network')
    assert.equal(err.status, null)
    assert.match(err.message, /无法连接图片 API/)
    return true
  })
})

test('slow response maps to code=timeout via AbortSignal.timeout', async () => {
  const server = await startServer(async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      sendJson(res, 200, { data: [{ b64_json: TEST_PNG_B64 }] })
    } catch {
      /* client already aborted */
    }
  })
  const api = createImageApi({
    baseUrl: server.baseUrl,
    apiKey: 'test-key',
    timeoutMs: 150,
    outputDir: path.join(TMP_ROOT, 'timeout'),
  })
  const startedAt = Date.now()
  await assert.rejects(api.generate({ prompt: 'x' }), (err) => {
    assert.equal(err.code, 'timeout')
    assert.match(err.message, /超时/)
    assert.match(err.message, /150ms/)
    return true
  })
  assert.ok(Date.now() - startedAt < 1500, 'timeout must abort promptly')
  await server.close()
})

test('HTTP 200 without images maps to code=empty', async () => {
  const server = await startServer((req, res) => sendJson(res, 200, { created: 1234, data: [] }))
  const api = apiFor(server, { outDir: await tmpOutDir('empty') })
  await assert.rejects(api.generate({ prompt: 'x' }), (err) => {
    assert.equal(err.code, 'empty')
    assert.equal(err.status, 200)
    assert.match(err.message, /没有图片数据/)
    assert.match(err.message, /data/)
    return true
  })
  await server.close()
})

test('HTTP 200 with non-JSON body maps to code=shape', async () => {
  const server = await startServer((req, res) => {
    const body = 'this is not json'
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  const api = apiFor(server, { outDir: await tmpOutDir('shape-error') })
  await assert.rejects(api.generate({ prompt: 'x' }), (err) => {
    assert.equal(err.code, 'shape')
    assert.equal(err.status, 200)
    assert.match(err.message, /无法解析/)
    return true
  })
  await server.close()
})

// ---------------------------------------------------------------------------
// edit()
// ---------------------------------------------------------------------------

test('edit(): multipart request carries model/prompt/n/size/image and saves the result', async () => {
  const inputDir = await tmpOutDir('edit-input')
  const inputPath = path.join(inputDir, 'input.png')
  await writeFile(inputPath, TEST_PNG)

  const server = await startServer((req, res, body) => {
    if (req.method === 'POST' && req.url === '/v1/images/edits') {
      assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/)
      assert.equal(req.headers.authorization, 'Bearer test-key')
      const text = body.toString('latin1')
      assert.match(text, /name="model"/)
      assert.match(text, /gpt-image-2/)
      assert.match(text, /name="prompt"/)
      assert.match(text, /make it blue/)
      assert.match(text, /name="n"/)
      assert.match(text, /name="size"/)
      assert.match(text, /1024x1024/)
      assert.match(text, /name="image"; filename="input.png"/)
      assert.match(text, /image\/png/)
      assert.ok(body.includes(PNG_SIGNATURE), 'multipart body must contain the raw PNG bytes')
      assert.ok(!text.includes('name="mask"'), 'no mask field when maskPath is omitted')
      sendJson(res, 200, {
        created: 1778470001,
        data: [{ b64_json: TEST_PNG_B64, url: `${server.origin}/images/edited.png`, output_format: 'png' }],
      })
      return
    }
    sendJson(res, 404, { error: { message: 'not found' } })
  })
  const api = apiFor(server, { outDir: await tmpOutDir('edit-out') })
  const result = await api.edit({ prompt: 'make it blue', imagePath: inputPath, size: '1024x1024', n: 1 })
  assert.equal(result.images.length, 1)
  assertPng(await readFile(result.images[0].path), 'edited image')
  assert.equal(result.images[0].mimeType, 'image/png')
  assert.ok(result.raw.data[0].b64_json)
  await server.close()
})

test('edit(): optional mask is sent as a second multipart file part', async () => {
  const inputDir = await tmpOutDir('edit-mask-input')
  const inputPath = path.join(inputDir, 'photo.png')
  const maskPath = path.join(inputDir, 'mask.png')
  await writeFile(inputPath, TEST_PNG)
  await writeFile(maskPath, TEST_PNG)

  const server = await startServer((req, res, body) => {
    if (req.method === 'POST' && req.url === '/v1/images/edits') {
      const text = body.toString('latin1')
      assert.match(text, /name="image"; filename="photo.png"/)
      assert.match(text, /name="mask"; filename="mask.png"/)
      sendJson(res, 200, { data: [{ b64_json: TEST_PNG_B64 }] })
      return
    }
    sendJson(res, 404, { error: { message: 'not found' } })
  })
  const api = apiFor(server, { outDir: await tmpOutDir('edit-mask-out') })
  const result = await api.edit({ prompt: 'inpaint', imagePath: inputPath, maskPath })
  assert.equal(result.images.length, 1)
  await server.close()
})

test('edit(): request shape is inspectable via an injected fetch (FormData)', async () => {
  const inputDir = await tmpOutDir('edit-injected-input')
  const inputPath = path.join(inputDir, 'input.png')
  await writeFile(inputPath, TEST_PNG)
  const { fetchImpl, calls } = makeInjectedFetch({ editPayload: { data: [{ b64_json: TEST_PNG_B64 }] } })
  const api = createImageApi({
    baseUrl: 'https://api.test/v1',
    apiKey: 'test-key',
    model: 'gpt-image-2',
    timeoutMs: 5000,
    outputDir: await tmpOutDir('edit-injected-out'),
    fetchImpl,
  })
  await api.edit({ prompt: 'inpaint this', imagePath: inputPath, n: 2 })
  assert.equal(calls.length, 1)
  const [{ url, method, init }] = calls
  assert.equal(url, 'https://api.test/v1/images/edits')
  assert.equal(method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer test-key')
  assert.ok(init.body instanceof FormData)
  assert.equal(init.body.get('model'), 'gpt-image-2')
  assert.equal(init.body.get('prompt'), 'inpaint this')
  assert.equal(init.body.get('n'), '2')
  const imagePart = init.body.get('image')
  assert.ok(imagePart instanceof Blob)
  assert.equal(imagePart.type, 'image/png')
  assert.equal(imagePart.size, TEST_PNG.length)
  assert.equal(init.headers['content-type'], undefined, 'content-type must be left to fetch (boundary)')
})

test('generate(): JSON request body is inspectable via an injected fetch', async () => {
  const { fetchImpl, calls } = makeInjectedFetch({ generationPayload: { data: [{ b64_json: TEST_PNG_B64 }] } })
  const api = createImageApi({
    baseUrl: 'https://api.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 5000,
    outputDir: await tmpOutDir('gen-injected-out'),
    fetchImpl,
  })
  await api.generate({ prompt: 'hello', n: 3 })
  assert.equal(calls.length, 1)
  const [{ url, method, init }] = calls
  assert.equal(url, 'https://api.test/v1/images/generations')
  assert.equal(method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer test-key')
  assert.match(init.headers['content-type'], /application\/json/)
  assert.deepEqual(JSON.parse(init.body), { model: 'test-model', prompt: 'hello', n: 3 })
})

// ---------------------------------------------------------------------------
// probe()
// ---------------------------------------------------------------------------

test('probe(): 200 /v1/models is ok and lists the target model', async () => {
  const server = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      sendJson(res, 200, { object: 'list', data: [{ id: 'gpt-image-2', object: 'model' }, { id: 'gpt-5' }] })
      return
    }
    sendJson(res, 404, { error: { message: 'not found' } })
  })
  const api = apiFor(server, { outDir: await tmpOutDir('probe-ok') })
  const probe = await api.probe()
  assert.equal(probe.ok, true)
  assert.equal(probe.status, 200)
  assert.match(probe.detail, /gpt-image-2/)
  assert.match(probe.detail, /已列出/)
  assert.equal(server.calls[0].headers.authorization, 'Bearer test-key')
  await server.close()
})

test('probe(): rejected key returns ok=false without throwing', async () => {
  const server = await startServer((req, res) =>
    sendJson(res, 401, { error: { message: '密钥无效或已失效，请重新登录', code: 'invalid_api_key' } }),
  )
  const api = apiFor(server, { outDir: await tmpOutDir('probe-auth') })
  const probe = await api.probe()
  assert.equal(probe.ok, false)
  assert.equal(probe.status, 401)
  assert.match(probe.detail, /API Key 被拒绝/)
  assert.match(probe.detail, /密钥无效或已失效/)
  await server.close()
})

test('probe(): 404 /v1/models falls back to /health', async () => {
  const server = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      sendJson(res, 404, { error: { message: 'not found' } })
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok' })
      return
    }
    sendJson(res, 404, { error: { message: 'not found' } })
  })
  const api = apiFor(server, { outDir: await tmpOutDir('probe-health') })
  const probe = await api.probe()
  assert.equal(probe.ok, true)
  assert.match(probe.detail, /\/health/)
  await server.close()
})

test('probe(): unreachable host returns ok=false instead of throwing', async () => {
  const baseUrl = await closedPortBaseUrl()
  const api = createImageApi({ baseUrl, apiKey: 'test-key', timeoutMs: 1000, outputDir: path.join(TMP_ROOT, 'probe-net') })
  const probe = await api.probe()
  assert.equal(probe.ok, false)
  assert.match(probe.detail, /无法连接图片 API/)
})

// ---------------------------------------------------------------------------
// live tests against the real service — gated on PS_IMAGE_API_KEY (env only)
// ---------------------------------------------------------------------------

const LIVE_KEY = (process.env.PS_IMAGE_API_KEY || '').trim()
const LIVE_BASE_URL = (process.env.PS_IMAGE_BASE_URL || '').trim() || DEFAULT_BASE_URL
const LIVE_SKIP = LIVE_KEY ? false : 'PS_IMAGE_API_KEY is not set (real-service verification intentionally skipped)'

test('live: fake key against the real endpoint maps to code=auth / HTTP 401', { skip: LIVE_SKIP, timeout: 90_000 }, async () => {
  const api = createImageApi({
    baseUrl: LIVE_BASE_URL,
    apiKey: 'sk-invalid-test-key-000',
    timeoutMs: 60_000,
    outputDir: path.join(TMP_ROOT, 'live-fake-key'),
  })
  await assert.rejects(api.generate({ prompt: 'ping' }), (err) => {
    assert.equal(err.code, 'auth')
    assert.equal(err.status, 401)
    assert.match(err.message, /HTTP 401/)
    assert.match(err.message, /密钥无效或已失效/)
    console.log('[live] fake-key 401 mapping:', JSON.stringify({ code: err.code, status: err.status, detail: err.detail }))
    return true
  })
})

test('live: probe() against the real service reports model-list availability', { skip: LIVE_SKIP, timeout: 90_000 }, async () => {
  const api = createImageApi({
    baseUrl: LIVE_BASE_URL,
    apiKey: LIVE_KEY,
    timeoutMs: 60_000,
    outputDir: path.join(TMP_ROOT, 'live-probe'),
  })
  const probe = await api.probe()
  console.log('[live] probe evidence:', JSON.stringify(probe))
  assert.equal(typeof probe.ok, 'boolean')
  assert.ok(probe.detail.length > 0)
})

test('live: real generation returns PNG + record shape/duration', { skip: LIVE_SKIP, timeout: 240_000 }, async () => {
  const outDir = path.join(TMP_ROOT, 'live-generate')
  const api = createImageApi({ baseUrl: LIVE_BASE_URL, apiKey: LIVE_KEY, timeoutMs: 180_000, outputDir: outDir })
  const startedAt = Date.now()
  const result = await api.generate({
    prompt: 'A plain white background with a single solid red circle in the center, flat vector style, no text',
    size: '1024x1024',
    n: 1,
  })
  const wallMs = Date.now() - startedAt
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].mimeType, 'image/png')
  assertPng(await readFile(result.images[0].path), 'real generation')
  assert.ok(result.images[0].bytes > 1000)

  const shape = result.raw?.data?.[0] ?? {}
  const evidence = {
    clientDurationMs: result.durationMs,
    wallMs,
    imageBytes: result.images[0].bytes,
    imageMimeType: result.images[0].mimeType,
    topLevelKeys: Object.keys(result.raw ?? {}),
    dataLength: Array.isArray(result.raw?.data) ? result.raw.data.length : 0,
    dataItemKeys: Object.keys(shape),
    b64_json: typeof shape.b64_json === 'string' ? shape.b64_json : null,
    url: typeof shape.url === 'string' ? shape.url : null,
    width: shape.width ?? null,
    height: shape.height ?? null,
    output_format: shape.output_format ?? null,
    usageKeys: Object.keys(result.raw?.usage ?? {}),
  }
  console.log('[live] generation evidence:', JSON.stringify(evidence))
  assert.ok(evidence.b64_json || evidence.url, 'response data item must expose b64_json or url')
})

test('live: real edit of a locally generated PNG returns PNG + record shape/duration', { skip: LIVE_SKIP, timeout: 240_000 }, async () => {
  const workDir = path.join(TMP_ROOT, 'live-edit')
  await mkdir(workDir, { recursive: true })
  const inputPath = path.join(workDir, 'edit-input.png')
  await writeFile(inputPath, encodePng(64, 64, (x, y) => [x * 4, y * 4, 200, 255]))
  const api = createImageApi({
    baseUrl: LIVE_BASE_URL,
    apiKey: LIVE_KEY,
    timeoutMs: 180_000,
    outputDir: path.join(workDir, 'out'),
  })
  const startedAt = Date.now()
  const result = await api.edit({
    prompt: 'Turn this image into a smooth blue gradient while keeping the overall composition',
    imagePath: inputPath,
    size: '1024x1024',
    n: 1,
  })
  const wallMs = Date.now() - startedAt
  const shape = result.raw?.data?.[0] ?? {}
  const evidence = {
    clientDurationMs: result.durationMs,
    wallMs,
    requestedN: 1,
    imagesReturned: result.images.length,
    images: result.images.map((image) => ({ bytes: image.bytes, mimeType: image.mimeType })),
    topLevelKeys: Object.keys(result.raw ?? {}),
    dataLength: Array.isArray(result.raw?.data) ? result.raw.data.length : 0,
    dataItemKeys: Object.keys(shape),
    b64_json: typeof shape.b64_json === 'string' ? shape.b64_json : null,
    url: typeof shape.url === 'string' ? shape.url : null,
    width: shape.width ?? null,
    height: shape.height ?? null,
    output_format: shape.output_format ?? null,
    usageKeys: Object.keys(result.raw?.usage ?? {}),
  }
  console.log('[live] edit evidence:', JSON.stringify(evidence))

  // Real service quirk: /v1/images/edits may return more than the requested n
  // (observed 3 images for n=1). The client returns everything the server sent.
  assert.ok(result.images.length >= 1, 'edit must return at least one image')
  for (const image of result.images) {
    assert.equal(image.mimeType, 'image/png')
    assertPng(await readFile(image.path), 'real edit')
    assert.ok(image.bytes > 1000)
  }
  assert.ok(evidence.b64_json || evidence.url, 'response data item must expose b64_json or url')
})
