/**
 * OpenAI-compatible image API client for the dsh-photoshop-genfill plugin.
 *
 * Target service: ChatGPT2API (https://github.com/ZyphrZero/chatgpt2api), which
 * implements `POST /v1/images/generations` (JSON) and `POST /v1/images/edits`
 * (multipart/form-data) with `Authorization: Bearer <token>`.
 *
 * Node 22 builtins only: global fetch / FormData / Blob / AbortSignal.timeout.
 * No npm dependencies, no imports of harness packages.
 *
 * Public API (see CONTRACT.md):
 *   const api = createImageApi({ baseUrl, apiKey, model, timeoutMs, outputDir })
 *   api.generate({ prompt, size?, n?, outDir? }) -> { images, durationMs, raw }
 *   api.edit({ prompt, imagePath, maskPath?, size?, n?, outDir? }) -> same
 *   api.probe() -> { ok, status, detail }
 *   api.config() -> { baseUrl, model, generationModel, editModel, hasKey }
 *
 * Note: the target proxy may return more images than the requested `n` (observed
 * intermittently for /images/edits: 3 PNGs for n=1). `images` contains everything
 * the server returned, in response order; callers that want one result should use
 * `images[0]`.
 *
 * An optional `fetchImpl` (alias `fetch`) may be injected for tests. It must be
 * compatible with the WHATWG fetch signature. It is also used for image URL
 * downloads.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

/** Default API base (keeps the /v1 suffix; endpoints are appended verbatim). */
export const DEFAULT_BASE_URL = 'https://chatgpt2api.343426.xyz/v1'
/** Default image model understood by the target service. */
export const DEFAULT_MODEL = 'gpt-image-2'
/** Default per-request bound: image generation can legitimately take tens of seconds. */
export const DEFAULT_TIMEOUT_MS = 180_000

const APP_UA = 'dsh-photoshop-genfill/1.0 (node)'
const MAX_ERROR_SNIPPET = 300
const MAX_RAW_STRING = 256

/**
 * Error raised by the image API client.
 *
 * codes:
 *   auth    - missing/invalid API key, HTTP 401/403, permission denied
 *   http    - any other non-2xx HTTP response (status is set)
 *   network - DNS/TCP/TLS failure before a response was received
 *   timeout - AbortSignal.timeout elapsed for the request (or body read)
 *   shape   - response was not JSON / not an image API response
 *   empty   - HTTP 200 but no image data in the response
 *
 * `detail` is a human-readable server message (or a response snippet) when one
 * was available; it never contains the API key.
 */
export class ImageApiError extends Error {
  /**
   * @param {'auth'|'http'|'network'|'timeout'|'shape'|'empty'} code
   * @param {string} message
   * @param {{status?: number|null, detail?: string|null, cause?: unknown}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'ImageApiError'
    this.code = code
    this.status = normaliseStatus(extra.status)
    this.detail = typeof extra.detail === 'string' && extra.detail.trim() ? extra.detail : null
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, status: this.status, detail: this.detail }
  }
}

function normaliseStatus(status) {
  return Number.isInteger(status) ? status : null
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function expandHome(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2))
  return value
}

function uniqueFileName(ext) {
  const stamp = Date.now().toString(36)
  const random = randomBytes(5).toString('hex')
  return `img-${stamp}-${random}.${ext}`
}

// ---------------------------------------------------------------------------
// option normalisation / validation
// ---------------------------------------------------------------------------

function normaliseBaseUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  const value = raw || DEFAULT_BASE_URL
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ImageApiError('shape', `baseUrl 不是合法的 URL：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageApiError('shape', `baseUrl 只支持 http(s) 协议：${value}`)
  }
  url.hash = ''
  url.search = ''
  return url.href.replace(/\/+$/, '')
}

function normaliseTimeout(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_TIMEOUT_MS
}

function normaliseOutputDir(value) {
  if (typeof value === 'string' && value.trim()) return path.resolve(expandHome(value.trim()))
  return path.join(tmpdir(), 'dsh-photoshop-genfill')
}

function requirePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ImageApiError('shape', 'prompt 不能为空：请提供生成或编辑提示词。')
  }
  return prompt.trim()
}

function normaliseCount(n) {
  if (n === undefined || n === null) return 1
  const value = Number(n)
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new ImageApiError('shape', `n 必须是 1-4 之间的整数，收到：${String(n)}`)
  }
  return value
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ImageApiError('shape', `${field} 必须是字符串，收到：${typeof value}`)
  const trimmed = value.trim()
  return trimmed || undefined
}

// ---------------------------------------------------------------------------
// image byte sniffing
// ---------------------------------------------------------------------------

/**
 * Detect a common image container from its magic bytes.
 * @param {Buffer} bytes
 * @returns {{mimeType: string, ext: string}|null}
 */
function sniffImageType(bytes) {
  if (!bytes || bytes.length < 4) return null
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mimeType: 'image/png', ext: 'png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' }
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return { mimeType: 'image/webp', ext: 'webp' }
  }
  if (bytes.length >= 6 && bytes.toString('latin1', 0, 3) === 'GIF') {
    return { mimeType: 'image/gif', ext: 'gif' }
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { mimeType: 'image/bmp', ext: 'bmp' }
  }
  const head = bytes.toString('utf8', 0, Math.min(bytes.length, 256)).trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return { mimeType: 'image/svg+xml', ext: 'svg' }
  }
  return null
}

const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

function decodeBase64Payload(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let text = value.trim()
  const dataUrl = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/is.exec(text)
  if (dataUrl) text = dataUrl[2]
  else if (text.startsWith('data:')) return null
  text = text.replace(/\s+/g, '')
  if (!text || !/^[A-Za-z0-9+/=]+$/.test(text)) return null
  try {
    const bytes = Buffer.from(text, 'base64')
    return bytes.length ? bytes : null
  } catch {
    return null
  }
}

function isProbablyBase64(text) {
  const value = text.trim()
  if (value.length < 32) return false
  const compact = value.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return false
  return compact.length % 4 === 0 || compact.endsWith('=')
}

/**
 * Is this string an image reference (URL or base64)? Used only inside response
 * arrays where plain text would otherwise be ignored.
 * @returns {{kind: 'url'|'b64', value: string}|null}
 */
function classifyImageString(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (/^data:image\//i.test(text)) return { kind: 'b64', value: text }
  if (/^https?:\/\//i.test(text)) return { kind: 'url', value: text }
  if (isProbablyBase64(text)) return { kind: 'b64', value: text }
  return null
}

// ---------------------------------------------------------------------------
// tolerant response parsing
// ---------------------------------------------------------------------------

const B64_KEYS = ['b64_json', 'b64', 'base64', 'b64Image', 'b64_image', 'image_base64', 'imageBase64']
const URL_KEYS = ['url', 'image_url', 'imageUrl', 'download_url', 'downloadUrl']

/**
 * Turn one response object into a group of alternative image candidates
 * (base64 first, then URLs). A group represents exactly one image.
 * @returns {Array<{kind: 'b64'|'url', value: string}>}
 */
function candidatesFromObject(item) {
  const alternatives = []
  if (!isPlainObject(item)) return alternatives
  for (const key of B64_KEYS) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) alternatives.push({ kind: 'b64', value })
  }
  for (const key of URL_KEYS) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) alternatives.push({ kind: 'url', value })
    else if (isPlainObject(value) && typeof value.url === 'string' && value.url.trim()) {
      alternatives.push({ kind: 'url', value: value.url })
    }
  }
  if (alternatives.length === 0 && Array.isArray(item.content)) {
    // Responses / chat-completions style: content: [{type:'output_image', image_url:{url}}]
    for (const part of item.content) {
      const classified = classifyImageString(part) ?? classifyImageString(part?.image_url?.url) ?? classifyImageString(part?.image_url)
      if (classified) alternatives.push(classified)
      else if (isPlainObject(part)) alternatives.push(...candidatesFromObject(part))
    }
  }
  if (alternatives.length === 0 && isPlainObject(item.image)) {
    alternatives.push(...candidatesFromObject(item.image))
  }
  if (alternatives.length === 0 && typeof item.result === 'string') {
    // Responses-style image_generation_call items: { type: 'image_generation_call', result: '<b64>' }
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : ''
    if (type.includes('image')) {
      const classified = classifyImageString(item.result)
      if (classified) alternatives.push(classified)
    }
  }
  return alternatives
}

/**
 * Collect candidate image groups from any OpenAI-compatible image response.
 * Handles: {data:[{b64_json}|{url}]}, {data:[...]}, top-level {url},
 * {images:[...]}, {output:[...]}, plus nested image/content/result variants.
 */
function collectCandidateGroups(payload) {
  const groups = []
  const seenContainers = new Set()

  /** @param {unknown} value */
  function addItem(value, depth = 0) {
    if (depth > 4 || value === undefined || value === null) return
    if (typeof value === 'string') {
      const classified = classifyImageString(value)
      if (classified) groups.push([classified])
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) addItem(entry, depth + 1)
      return
    }
    if (!isPlainObject(value) || seenContainers.has(value)) return
    seenContainers.add(value)
    const alternatives = candidatesFromObject(value)
    if (alternatives.length > 0) {
      groups.push(alternatives)
      return
    }
    for (const key of ['data', 'images', 'output', 'artifacts', 'results']) {
      if (key in value) addItem(value[key], depth + 1)
    }
    if (groups.length === 0) {
      // last resort: a nested single-image object, e.g. { result: { url } }
      for (const key of ['result', 'response', 'image']) {
        const nested = value[key]
        if (isPlainObject(nested) || Array.isArray(nested) || typeof nested === 'string') addItem(nested, depth + 1)
      }
    }
  }

  if (Array.isArray(payload)) {
    addItem(payload)
  } else if (isPlainObject(payload)) {
    for (const key of ['data', 'images', 'output', 'artifacts', 'results']) {
      if (key in payload) addItem(payload[key])
    }
    if (groups.length === 0) addItem(payload)
  }
  return groups
}

/** Redact an API payload for the `raw` field: drop base64 blobs, cap strings, strip URL queries. */
function redactPayload(value, depth = 0) {
  if (depth > 6) return '<max-depth>'
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value)) return `data:image/... (${value.length} chars)`
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value)
        return `${url.origin}${url.pathname}${url.search ? '?<query>' : ''}`
      } catch {
        return truncate(value, MAX_RAW_STRING)
      }
    }
    return value.length > MAX_RAW_STRING ? (isProbablyBase64(value) ? `<base64:${value.length} chars>` : `<${value.length} chars>`) : value
  }
  if (Array.isArray(value)) return value.map((entry) => redactPayload(entry, depth + 1))
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = redactPayload(entry, depth + 1)
    return out
  }
  return value
}

function responseKeys(payload) {
  if (Array.isArray(payload)) return '<array>'
  if (!isPlainObject(payload)) return String(typeof payload)
  const keys = Object.keys(payload)
  return keys.length ? keys.join(', ') : '<empty object>'
}

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------

/**
 * Extract the most useful server error message from a response body.
 * Supports the shapes used by chatgpt2api / OpenAI / FastAPI:
 *   {"error":{"message","type","code"}}, {"error":"text"},
 *   {"detail":{"error":"text"}}, {"detail":"text"}, {"message":"text"}
 * @returns {{message: string|null, code: string|null}}
 */
function extractServerError(payload, text) {
  const candidates = []
  if (isPlainObject(payload)) {
    const error = payload.error
    if (typeof error === 'string') candidates.push({ message: error, code: null })
    else if (isPlainObject(error)) {
      candidates.push({
        message: typeof error.message === 'string' ? error.message : typeof error.error === 'string' ? error.error : null,
        code: typeof error.code === 'string' ? error.code : null,
      })
    }
    const detail = payload.detail
    if (typeof detail === 'string') candidates.push({ message: detail, code: null })
    else if (isPlainObject(detail)) {
      candidates.push({
        message: typeof detail.error === 'string' ? detail.error : typeof detail.message === 'string' ? detail.message : null,
        code: typeof detail.code === 'string' ? detail.code : null,
      })
    }
    for (const key of ['message', 'error_message', 'msg']) {
      if (typeof payload[key] === 'string') candidates.push({ message: payload[key], code: null })
    }
  }
  const usable = candidates.find((entry) => typeof entry.message === 'string' && entry.message.trim())
  if (usable) return { message: usable.message.trim(), code: usable.code ?? null }
  const snippet = truncate(text?.trim() ?? '', MAX_ERROR_SNIPPET)
  return { message: snippet || null, code: null }
}

/** Compose a readable server error string, including the error code when separate. */
function serverErrorText(info) {
  const message = info.message?.trim() ?? ''
  if (!message) return ''
  if (info.code && !message.includes(info.code)) return `${message}（${info.code}）`
  return message
}

/**
 * Map a non-2xx HTTP response to an ImageApiError (auth/http/empty).
 */
function httpResponseError(res, text, context) {
  const status = res.status
  const statusText = res.statusText ? ` ${res.statusText}` : ''
  const payload = parseJsonLoose(text)
  const info = extractServerError(payload, text)
  const serverText = serverErrorText(info) || '服务端未返回错误详情'
  const target = `${context.method} ${context.path}`
  let code = 'http'
  let message = `图片 API 请求失败（HTTP ${status}${statusText}）：${serverText}`

  if (status === 401 || status === 403) {
    code = 'auth'
    message =
      `图片 API 鉴权失败（HTTP ${status}${statusText}）：${serverText}。` +
      '请检查插件配置中的 apiKey（或 PS_IMAGE_API_KEY）是否正确、是否已过期。'
  } else if (status === 429) {
    message =
      `图片 API 请求被限流或图片额度不足（HTTP 429 Too Many Requests）：${serverText}。` +
      '请稍后重试，或检查服务账号的图片额度/并发限制。'
  } else if (info.code === 'image_generation_text_response') {
    code = 'empty'
    message =
      `图片 API 未返回图片（HTTP ${status}${statusText}）：${serverText}。` +
      '当前提示词可能没有触发图片输出，请改写提示词后重试。'
  } else if (status === 400) {
    message = `图片 API 请求参数被拒绝（HTTP 400 Bad Request）：${serverText}`
  } else if (status >= 500) {
    message = `图片 API 服务端错误（HTTP ${status}${statusText}）：${serverText}。可稍后重试。`
  }

  return new ImageApiError(code, `${message}（${target}）`, {
    status,
    detail: info.message ?? null,
  })
}

function describeFetchFailure(err) {
  const cause = isPlainObject(err) || err instanceof Error ? err.cause : undefined
  const causeObject = isPlainObject(cause) ? cause : {}
  const code = causeObject.code || err?.code || ''
  const rawMessage = causeObject.message || err?.message || String(err ?? '未知错误')
  const parts = []
  if (code) parts.push(code)
  if (rawMessage && rawMessage !== 'fetch failed' && rawMessage !== 'terminated') parts.push(rawMessage)
  const detail = parts.join('；') || '未知网络错误'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `域名解析失败（${detail}）`
  if (code === 'ECONNREFUSED') return `连接被拒绝（${detail}）`
  if (code === 'ECONNRESET' || code === 'EPIPE') return `连接被重置（${detail}）`
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `连接超时（${detail}）`
  if (code.startsWith('CERT_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return `TLS 证书校验失败（${detail}）`
  }
  return detail
}

function isAbortLike(err) {
  if (!err || typeof err !== 'object') return false
  const names = [err.name, err.cause?.name].filter(Boolean)
  return names.includes('TimeoutError') || names.includes('AbortError')
}

/** Wrap any thrown value from fetch/body reads into an ImageApiError. */
function requestFailure(err, { method, url, timeoutMs, phase = '请求' }) {
  if (err instanceof ImageApiError) return err
  if (isAbortLike(err)) {
    return new ImageApiError('timeout', `图片 API ${phase}超时（${timeoutMs}ms）：${method} ${url}`, {
      detail: `AbortSignal 在 ${timeoutMs}ms 后中断了${phase}`,
      cause: err,
    })
  }
  return new ImageApiError('network', `无法连接图片 API：${describeFetchFailure(err)}（${method} ${url}）`, {
    detail: describeFetchFailure(err),
    cause: err,
  })
}

// ---------------------------------------------------------------------------
// output file persistence
// ---------------------------------------------------------------------------

async function persistImageBytes(bytes, { outDir, kind }) {
  const directory = normaliseOutputDir(outDir)
  await mkdir(directory, { recursive: true })
  const sniffed = sniffImageType(bytes)
  const ext = sniffed?.ext ?? 'bin'
  let filePath = path.join(directory, uniqueFileName(ext))
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await writeFile(filePath, bytes, { flag: 'wx' })
      return {
        path: filePath,
        bytes: bytes.length,
        mimeType: sniffed?.mimeType ?? 'application/octet-stream',
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      filePath = path.join(directory, uniqueFileName(ext))
    }
  }
  throw new ImageApiError('shape', `无法写入图片文件：${filePath}（同名文件冲突）`)
}

// ---------------------------------------------------------------------------
// createImageApi
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   baseUrl?: string,
 *   apiKey?: string,
 *   model?: string,
 *   generationModel?: string,
 *   editModel?: string,
 *   timeoutMs?: number,
 *   outputDir?: string,
 *   fetchImpl?: typeof fetch,
 *   fetch?: typeof fetch,
 * }} [options]
 */
export function createImageApi(options = {}) {
  const baseUrl = normaliseBaseUrl(options.baseUrl)
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  const model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : DEFAULT_MODEL
  const generationModel = typeof options.generationModel === 'string' && options.generationModel.trim() ? options.generationModel.trim() : model
  const editModel = typeof options.editModel === 'string' && options.editModel.trim() ? options.editModel.trim() : model
  const timeoutMs = normaliseTimeout(options.timeoutMs)
  const outputDir = normaliseOutputDir(options.outputDir)
  const fetchImpl = options.fetchImpl || options.fetch || globalThis.fetch
  const base = new URL(baseUrl)
  const baseOrigin = base.origin

  if (typeof fetchImpl !== 'function') {
    throw new Error('image-api: 当前运行时没有可用的 fetch，请升级到 Node 22+。')
  }

  function endpointUrl(suffix) {
    return `${baseUrl}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
  }

  function authHeaders(extra = {}) {
    return {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      'user-agent': APP_UA,
      ...extra,
    }
  }

  function ensureKey() {
    if (!apiKey) {
      throw new ImageApiError(
        'auth',
        '未配置 API Key：请在插件配置中填写 apiKey（或设置环境变量 PS_IMAGE_API_KEY）后再试。',
      )
    }
  }

  /** One bounded fetch call; maps network/timeout failures. */
  async function doFetch(url, init, { method, timeoutMs: requestTimeout, phase }) {
    const signal = AbortSignal.timeout(requestTimeout)
    try {
      return await fetchImpl(url, { ...init, signal })
    } catch (err) {
      throw requestFailure(err, { method, url, timeoutMs: requestTimeout, phase })
    }
  }

  async function readTextBody(res, context) {
    try {
      return await res.text()
    } catch (err) {
      throw requestFailure(err, { ...context, phase: '响应读取' })
    }
  }

  async function readBytesBody(res, context) {
    try {
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      throw requestFailure(err, { ...context, phase: '响应读取' })
    }
  }

  /**
   * Execute one JSON request and normalise the response body.
   * @returns {Promise<{payload?: unknown, directBytes?: Buffer, directMimeType?: string}>}
   */
  async function executeJsonRequest({ pathSuffix, body, extraHeaders = {} }) {
    ensureKey()
    const url = endpointUrl(pathSuffix)
    const context = { method: 'POST', path: pathSuffix }
    const res = await doFetch(
      url,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json', ...extraHeaders }),
        body: JSON.stringify(body),
      },
      { method: 'POST', timeoutMs, phase: '请求' },
    )
    return normaliseResponse(res, { ...context, url, timeoutMs })
  }

  /** Execute one multipart request and normalise the response body. */
  async function executeMultipartRequest({ pathSuffix, form }) {
    ensureKey()
    const url = endpointUrl(pathSuffix)
    const context = { method: 'POST', path: pathSuffix }
    const res = await doFetch(
      url,
      { method: 'POST', headers: authHeaders(), body: form },
      { method: 'POST', timeoutMs, phase: '请求' },
    )
    return normaliseResponse(res, { ...context, url, timeoutMs })
  }

  async function normaliseResponse(res, context) {
    if (!res.ok) {
      const text = await readTextBody(res, context)
      throw httpResponseError(res, text, context)
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (/^image\//.test(contentType)) {
      // Tolerant path: some proxies stream raw image bytes instead of JSON.
      const bytes = await readBytesBody(res, context)
      if (!bytes.length) {
        throw new ImageApiError('empty', `图片 API 返回了 0 字节图片数据（HTTP ${res.status}）`, { status: res.status })
      }
      return { directBytes: bytes, directMimeType: contentType.split(';')[0] }
    }
    const text = await readTextBody(res, context)
    if (!text.trim()) {
      throw new ImageApiError('empty', `图片 API 返回了空响应（HTTP ${res.status}）：${context.method} ${context.path}`, {
        status: res.status,
      })
    }
    const payload = parseJsonLoose(text)
    if (payload === undefined) {
      throw new ImageApiError(
        'shape',
        `图片 API 返回了无法解析的响应（HTTP ${res.status}，content-type: ${contentType || '未知'}）：${truncate(text.trim(), 240)}（${context.method} ${context.path}）`,
        { status: res.status, detail: truncate(text.trim(), 500) },
      )
    }
    return { payload, status: res.status }
  }

  /** Download an image URL returned by the API, bounded by the request timeout. */
  async function downloadImage(rawUrl) {
    let url
    try {
      url = new URL(rawUrl)
    } catch {
      url = new URL(rawUrl, `${baseUrl}/`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ImageApiError('shape', `图片 API 返回了不支持的图片地址协议：${url.protocol}`)
    }
    // Only forward our API key to the API host itself; never leak it to third parties.
    const headers = { accept: 'image/*', 'user-agent': APP_UA }
    if (url.origin === baseOrigin) headers.authorization = `Bearer ${apiKey}`
    const method = 'GET'
    const res = await doFetch(url.href, { method, headers }, { method, timeoutMs, phase: '图片下载' })
    if (!res.ok) {
      const text = await readTextBody(res, { method, url: url.href, timeoutMs })
      const info = extractServerError(parseJsonLoose(text), text)
      throw new ImageApiError(
        res.status === 401 || res.status === 403 ? 'auth' : 'http',
        `下载图片失败（HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}）：${serverErrorText(info) || '服务端未返回错误详情'}（${url.href}）`,
        { status: res.status, detail: info.message ?? null },
      )
    }
    const bytes = await readBytesBody(res, { method, url: url.href, timeoutMs })
    if (!bytes.length) {
      throw new ImageApiError('empty', `下载图片得到 0 字节数据：${url.href}`)
    }
    return bytes
  }

  /**
   * Materialise candidate groups into saved files.
   * Each group is one image with alternatives (b64 first, then url); a failed
   * base64 candidate may still be recovered from the URL alternative.
   */
  async function materialiseImages(groups, { kind, outDir }) {
    const images = []
    const errors = []
    const seenHashes = new Set()
    for (const group of groups) {
      for (const candidate of group) {
        try {
          const bytes = candidate.kind === 'b64' ? decodeBase64Payload(candidate.value) : await downloadImage(candidate.value)
          if (!bytes || !bytes.length) {
            errors.push(
              new ImageApiError('empty', '图片 API 响应中的图片数据为空（base64 解码后 0 字节）。', {
                detail: 'empty image payload',
              }),
            )
            continue
          }
          const hash = createHash('sha1').update(bytes).digest('hex')
          if (seenHashes.has(hash)) break
          const saved = await persistImageBytes(bytes, { outDir, kind })
          seenHashes.add(hash)
          images.push(saved)
          break
        } catch (err) {
          errors.push(
            err instanceof ImageApiError
              ? err
              : new ImageApiError('shape', `保存图片时出错：${err?.message || String(err)}`, { cause: err }),
          )
        }
      }
    }
    if (images.length === 0) {
      if (errors.length > 0) throw errors[0]
      throw new ImageApiError('empty', '图片 API 返回成功，但响应中没有图片数据。')
    }
    return images
  }

  async function persistResponse(response, { kind, outDir }) {
    if (response.directBytes) {
      const saved = await persistImageBytes(response.directBytes, { outDir, kind })
      return { images: [saved], raw: { direct: response.directMimeType, bytes: saved.bytes } }
    }
    const groups = collectCandidateGroups(response.payload)
    if (groups.length === 0) {
      throw new ImageApiError(
        'empty',
        `图片 API 返回成功，但响应中没有图片数据（响应键：${responseKeys(response.payload)}）。`,
        {
          status: response.status ?? null,
          detail: truncate(JSON.stringify(redactPayload(response.payload)), 500),
        },
      )
    }
    const images = await materialiseImages(groups, { kind, outDir })
    return { images, raw: redactPayload(response.payload) }
  }

  /**
   * Generate image(s) from a text prompt.
   * @param {{prompt: string, size?: string, n?: number, outDir?: string}} input
   */
  async function generate(input = {}) {
    const startedAt = Date.now()
    const prompt = requirePrompt(input.prompt)
    const n = normaliseCount(input.n)
    const size = optionalString(input.size, 'size')
    ensureKey()
    const body = { model: generationModel, prompt, n }
    if (size) body.size = size

    const response = await executeJsonRequest({ pathSuffix: '/images/generations', body })
    const result = await persistResponse(response, { kind: 'gen', outDir: input.outDir ?? outputDir })
    return { images: result.images, durationMs: Date.now() - startedAt, raw: result.raw }
  }

  async function readImageInput(filePath, field) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new ImageApiError('shape', `${field} 不能为空：请提供图片文件的绝对路径。`)
    }
    const resolved = path.resolve(expandHome(filePath.trim()))
    let bytes
    try {
      bytes = await readFile(resolved)
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new ImageApiError('shape', `找不到待编辑的图片文件（${field}）：${resolved}`)
      }
      throw new ImageApiError('shape', `无法读取图片文件（${field}）：${resolved}（${err?.message || String(err)}）`)
    }
    if (!bytes.length) throw new ImageApiError('shape', `图片文件为空（${field}）：${resolved}`)
    const extension = path.extname(resolved).slice(1).toLowerCase()
    const sniffed = sniffImageType(bytes)
    return {
      bytes,
      filename: path.basename(resolved),
      mimeType: sniffed?.mimeType ?? EXT_MIME[extension] ?? 'application/octet-stream',
    }
  }

  /**
   * Edit an existing image (optionally with a mask) via multipart/form-data.
   * @param {{prompt: string, imagePath: string, maskPath?: string, size?: string, n?: number, outDir?: string}} input
   */
  async function edit(input = {}) {
    const startedAt = Date.now()
    const prompt = requirePrompt(input.prompt)
    const n = normaliseCount(input.n)
    const size = optionalString(input.size, 'size')
    ensureKey()
    const image = await readImageInput(input.imagePath, 'imagePath')
    const mask = input.maskPath === undefined || input.maskPath === null || input.maskPath === ''
      ? null
      : await readImageInput(input.maskPath, 'maskPath')

    const form = new FormData()
    form.append('model', editModel)
    form.append('prompt', prompt)
    form.append('n', String(n))
    if (size) form.append('size', size)
    form.append('image', new Blob([image.bytes], { type: image.mimeType }), image.filename)
    if (mask) form.append('mask', new Blob([mask.bytes], { type: mask.mimeType }), mask.filename)

    const response = await executeMultipartRequest({ pathSuffix: '/images/edits', form })
    const result = await persistResponse(response, { kind: 'edit', outDir: input.outDir ?? outputDir })
    return { images: result.images, durationMs: Date.now() - startedAt, raw: result.raw }
  }

  /**
   * Cheap connectivity/auth check: GET {baseUrl}/models.
   * Falls back to {origin}/health when the proxy does not implement /models.
   * Never throws: resolves to { ok, status, detail }.
   */
  async function probe() {
    if (!apiKey) {
      return { ok: false, status: null, detail: '未配置 API Key：请在插件配置中填写 apiKey（或设置 PS_IMAGE_API_KEY）。' }
    }
    const startedAt = Date.now()
    const pathSuffix = '/models'
    const url = endpointUrl(pathSuffix)
    const probeTimeout = Math.min(timeoutMs, 15_000)
    try {
      const res = await doFetch(url, { method: 'GET', headers: authHeaders() }, { method: 'GET', timeoutMs: probeTimeout, phase: '连通性检查' })
      const text = await readTextBody(res, { method: 'GET', url, timeoutMs: probeTimeout })
      const elapsed = Date.now() - startedAt
      if (res.ok) {
        const payload = parseJsonLoose(text)
        const ids = extractModelIds(payload)
        const listed = ids.includes(model)
        const listPart = ids.length
          ? `返回 ${ids.length} 个模型：${ids.slice(0, 10).join('、')}${ids.length > 10 ? '…' : ''}`
          : '未返回模型列表'
        return {
          ok: true,
          status: res.status,
          detail:
            `GET /v1/models 可用（HTTP ${res.status}，${elapsed}ms），${listPart}；` +
            (listed ? `目标模型 ${model} 已列出。` : `目标模型 ${model} 未列出（Models 可能只列文本模型，生图接口仍可能可用）。`),
        }
      }
      const info = extractServerError(parseJsonLoose(text), text)
      const serverText = serverErrorText(info) || '服务端未返回错误详情'
      if (res.status === 404 || res.status === 405) {
        const health = await probeHealth()
        if (health) {
          return {
            ok: true,
            status: health.status,
            detail:
              `GET /v1/models 返回 HTTP ${res.status}（该代理未实现模型列表）；` +
              `GET /health 可用（HTTP ${health.status}，${health.latencyMs}ms），服务可达。`,
          }
        }
        return {
          ok: false,
          status: res.status,
          detail: `GET /v1/models 返回 HTTP ${res.status}，且 /health 不可用，无法确认图片服务状态。`,
        }
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, detail: `API Key 被拒绝（HTTP ${res.status}）：${serverText}` }
      }
      return { ok: false, status: res.status, detail: `模型列表请求失败（HTTP ${res.status}）：${serverText}` }
    } catch (err) {
      if (err instanceof ImageApiError) {
        return { ok: false, status: err.status, detail: err.message }
      }
      return { ok: false, status: null, detail: `连通性检查失败：${err?.message || String(err)}` }
    }
  }

  async function probeHealth() {
    const origin = `${baseOrigin}/health`
    const startedAt = Date.now()
    try {
      const res = await doFetch(
        origin,
        { method: 'GET', headers: { accept: 'application/json', 'user-agent': APP_UA } },
        { method: 'GET', timeoutMs: Math.min(timeoutMs, 5_000), phase: '健康检查' },
      )
      if (!res.ok) return null
      await res.arrayBuffer().catch(() => {})
      return { status: res.status, latencyMs: Date.now() - startedAt }
    } catch {
      return null
    }
  }

  function extractModelIds(payload) {
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
    return list
      .map((entry) => (typeof entry === 'string' ? entry : entry?.id ?? entry?.name ?? null))
      .filter((id) => typeof id === 'string' && id.trim())
  }

  function config() {
    return { baseUrl, model, generationModel, editModel, hasKey: apiKey.length > 0 }
  }

  return { generate, edit, probe, config }
}
