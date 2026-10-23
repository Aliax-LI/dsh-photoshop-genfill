/**
 * macOS AppleScript -> ExtendScript bridge for Adobe Photoshop.
 *
 * Photoshop does not expose a Node API on macOS; the only reliable automation path is:
 *
 *   Node writes a UTF-8 (BOM) `.jsx` file
 *     -> Node writes a tiny AppleScript `.scpt` that tells Photoshop to `do javascript "$.evalFile(...)"`
 *       -> `/usr/bin/osascript` runs the `.scpt`
 *         -> Photoshop executes the JSX and returns a `toSource()` string on stdout.
 *
 * This module implements that path with:
 *  - a FIFO queue (Photoshop scripting is not concurrent-safe),
 *  - a per-call timeout budget mirrored into `with timeout of N seconds` plus a hard SIGKILL
 *    of the osascript process strictly after the AppleScript timeout,
 *  - the reference `wrapInErrorHandling()` wrapper (forced px/pt units, suppressed dialogs,
 *    `'ERROR: '` failure prefix),
 *  - temp-file cleanup in `finally`,
 *  - actionable error messages (Photoshop not running, Automation permission -1743,
 *    AppleScript timeout -1712, syntax errors, Photoshop `ERROR:` payloads).
 *
 * Node 22 builtins only (ESM). No npm dependencies, no imports of `@deepseek-ai/*`.
 *
 * @module dsh-photoshop-genfill/lib/ps-bridge
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Default Photoshop target. */
export const DEFAULT_APP_NAME = 'Adobe Photoshop 2026'
/** Default per-call budget for `run()`. */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Default budget for `runLong()` (capture/place on large documents). */
export const DEFAULT_LONG_TIMEOUT_MS = 180_000
/** Slack added to the AppleScript-side `with timeout`, so the JSX gets its full budget. */
export const APPLESCRIPT_TIMEOUT_MARGIN_SECONDS = 5
/** Extra grace before Node SIGKILLs osascript, strictly after the AppleScript timeout. */
export const KILL_GRACE_MS = 5_000
/** Time a queued script may wait for its turn before the call is rejected. */
export const QUEUE_WAIT_ALLOWANCE_MS = 120_000
/** Time to wait for a freshly launched Photoshop to become scriptable. */
export const LAUNCH_WAIT_MS = 60_000

const MIN_TIMEOUT_MS = 500
const MAX_TIMEOUT_MS = 600_000
const OSASCRIPT = '/usr/bin/osascript'
const PGREP = '/usr/bin/pgrep'
const OPEN = '/usr/bin/open'

/** ExtendScript only detects UTF-8 when the file starts with a BOM (Adobe docs). */
export const EXTENDSCRIPT_BOM = '\uFEFF'

/**
 * Error raised by the bridge. `code` is a stable machine-readable bucket:
 * `not_running` | `not_authorized` | `timeout` | `busy` | `applescript` |
 * `photoshop_error` | `parse_error` | `launch_failed` | `invalid_script` | `disposed`.
 */
export class PsBridgeError extends Error {
  /**
   * @param {string} code stable error bucket
   * @param {string} message actionable message shown to the user/agent
   * @param {object} [details] extra context (`stderr`, `exitCode`, `timeoutMs`, ...)
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PsBridgeError'
    this.code = code
    if (details && Object.keys(details).length > 0) this.details = details
  }
}

/** @typedef {{ appName: string, appPath?: string }} PsTarget */

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function clampTimeout(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)))
}

function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Quote a value as an AppleScript double-quoted string literal. */
export function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Escape a value for use inside a `pgrep -f` extended regex. */
export function escapeForPgrep(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The `.app` bundle containing `path`, or undefined when `path` is not inside one. */
export function bundlePathOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const match = /^(.*?\.app)(?:\/.*)?$/.exec(value.trim())
  return match ? match[1] : undefined
}

/**
 * Resolve the Photoshop target: explicit `appPath` wins (normalized to its `.app` bundle),
 * otherwise the conventional macOS install locations for `appName`.
 *
 * @param {{ appName?: string, appPath?: string }} [options]
 * @returns {PsTarget}
 */
export function resolveTarget(options = {}) {
  const appName = typeof options.appName === 'string' && options.appName.trim() ? options.appName.trim() : DEFAULT_APP_NAME
  const requested = typeof options.appPath === 'string' && options.appPath.trim() ? options.appPath.trim() : undefined
  let appPath = requested ? bundlePathOf(requested) ?? requested : undefined
  if (!appPath) {
    const candidates = [
      `/Applications/${appName}/${appName}.app`,
      `/Applications/${appName}.app`,
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        appPath = candidate
        break
      }
    }
  }
  return appPath ? { appName, appPath } : { appName }
}

/**
 * The ExtendScript wrapper every body runs inside (copied from the MIT reference
 * `@alisaitteke/photoshop-mcp` `wrapInErrorHandling()`): forces pixel/point units,
 * suppresses dialogs, serializes the result with `toSource()` and prefixes failures
 * with `ERROR: ` so they can be turned back into thrown Errors on the Node side.
 *
 * @param {string} body ExtendScript body: the inside of `function () { ... }`; must `return`.
 * @returns {string} complete ExtendScript program
 */
export function wrapInErrorHandling(body) {
  const script = String(body ?? '')
  return `
(function() {
  var __originalRulerUnits = null;
  var __originalTypeUnits = null;
  var __origDialogs = null;
  var __origAlert = null;
  var __origConfirm = null;
  var __origPrompt = null;
  try { __originalRulerUnits = app.preferences.rulerUnits; } catch (e) {}
  try { __originalTypeUnits = app.preferences.typeUnits; } catch (e) {}
  try { __origDialogs = app.displayDialogs; } catch (e) {}
  try { app.displayDialogs = DialogModes.NO; } catch (e) {}
  if (typeof alert !== 'undefined') {
    __origAlert = alert;
    alert = function(msg) { $.writeln('[dsh-ps] ' + msg); };
  }
  if (typeof confirm !== 'undefined') {
    __origConfirm = confirm;
    confirm = function() { $.writeln('[dsh-ps] confirm suppressed'); return true; };
  }
  if (typeof prompt !== 'undefined') {
    __origPrompt = prompt;
    prompt = function(msg, def) {
      $.writeln('[dsh-ps] prompt suppressed: ' + msg);
      return def || '';
    };
  }

  try {
    try { app.preferences.rulerUnits = Units.PIXELS; } catch (e) {}
    try { app.preferences.typeUnits = TypeUnits.POINTS; } catch (e) {}

    var result = (function() {
      ${script}
    })();
    if (typeof result === 'object' && result !== null) {
      return result.toSource ? result.toSource() : String(result);
    }
    return String(result);
  } catch (error) {
    var errorMessage = '';
    var errorNumber = '';
    try { errorMessage = error.message; } catch (e) {}
    try { errorNumber = String(error.number); } catch (e2) {}
    if (!errorMessage) {
      try { errorMessage = String(error); } catch (e3) { errorMessage = 'unknown'; }
    }
    if (errorNumber && errorNumber !== 'undefined' && errorNumber !== 'NaN') {
      return 'ERROR: ' + errorMessage + ' (number: ' + errorNumber + ')';
    }
    return 'ERROR: ' + errorMessage;
  } finally {
    try { if (__originalRulerUnits !== null) app.preferences.rulerUnits = __originalRulerUnits; } catch (e) {}
    try { if (__originalTypeUnits !== null) app.preferences.typeUnits = __originalTypeUnits; } catch (e) {}
    try { if (__origDialogs !== null) app.displayDialogs = __origDialogs; } catch (e) {}
    if (__origAlert !== null) { alert = __origAlert; }
    if (__origConfirm !== null) { confirm = __origConfirm; }
    if (__origPrompt !== null) { prompt = __origPrompt; }
  }
})();
  `.trim()
}

/**
 * Parse the stdout payload of `do javascript`.
 *
 * `toSource()` output (e.g. `({ok:true})`) is not JSON but is a valid JavaScript
 * object literal, so JSON is tried first and `new Function('return ' + text)` second.
 * Anything else is returned as the trimmed string.
 *
 * @param {string} raw stdout
 * @returns {any}
 */
export function parseExtendScriptPayload(raw) {
  if (raw === null || raw === undefined) return raw
  const trimmed = String(raw).trim()
  if (trimmed === '') return trimmed
  try {
    return JSON.parse(trimmed)
  } catch {
    /* fall through to toSource object-literal parsing */
  }
  const looksLikeLiteral =
    (trimmed.startsWith('(') && trimmed.endsWith(')')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  if (looksLikeLiteral) {
    try {
      return new Function(`return ${trimmed}`)()
    } catch {
      if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
        try {
          return new Function(`return ${trimmed.slice(1, -1)}`)()
        } catch {
          /* keep raw string below */
        }
      }
    }
  }
  return trimmed
}

/**
 * Build the `.scpt` file contents.
 *
 * `tell application "<bundle path>"` targets exactly the detected install; plain
 * `tell application "<name>"` resolves the display name. Verified on macOS 27 with
 * Photoshop 2026: `application "<path>"` works, while the literal `application file`
 * form is invalid AppleScript (-1728), hence the string form on both branches.
 *
 * @param {string} jsxPath absolute POSIX path of the generated JSX file
 * @param {number} timeoutMs per-call budget
 * @param {PsTarget} target resolved Photoshop target
 * @returns {string}
 */
export function buildAppleScript(jsxPath, timeoutMs, target) {
  const posixPath = String(jsxPath).replace(/\\/g, '/')
  // `%27` keeps a stray apostrophe from terminating the ExtendScript string in `decodeURI(...)`.
  const encodedPath = encodeURI(posixPath).replace(/'/g, '%27')
  const timeoutSeconds = Math.ceil(clampTimeout(timeoutMs, DEFAULT_TIMEOUT_MS) / 1000) + APPLESCRIPT_TIMEOUT_MARGIN_SECONDS
  const appRef = appleScriptString(target.appPath ?? target.appName)
  return [
    `tell application ${appRef}`,
    `\tset jsxFile to POSIX file ${appleScriptString(posixPath)}`,
    `\twith timeout of ${timeoutSeconds} seconds`,
    `\t\tdo javascript "$.evalFile(decodeURI('${encodedPath}'))"`,
    `\tend timeout`,
    `end tell`,
  ].join('\n')
}

/** Hard SIGKILL bound for osascript: strictly after the AppleScript-side timeout. */
export function killTimeoutMs(timeoutMs) {
  return (
    clampTimeout(timeoutMs, DEFAULT_TIMEOUT_MS) +
    APPLESCRIPT_TIMEOUT_MARGIN_SECONDS * 1000 +
    KILL_GRACE_MS
  )
}

function timeoutError(timeoutMs, kind) {
  const base =
    kind === 'killed'
      ? `Photoshop did not answer within ${timeoutMs}ms; osascript was killed (SIGKILL).`
      : `Photoshop did not answer within ${timeoutMs}ms (AppleEvent timeout).`
  return new PsBridgeError(
    'timeout',
    `${base} A long-running Photoshop script cannot be interrupted from outside; wait until Photoshop is idle (or finishes its current dialog) and retry.`,
    { timeoutMs },
  )
}

/**
 * Translate an osascript failure into an actionable {@link PsBridgeError}.
 *
 * @param {any} error rejected `execFile` error or thrown error
 * @param {{ timeoutMs: number, target: PsTarget }} context
 * @returns {PsBridgeError}
 */
export function classifyAppleScriptError(error, context) {
  const timeoutMs = context?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const target = context?.target ?? { appName: DEFAULT_APP_NAME }
  const appLabel = target.appPath ?? target.appName
  const message = String(error?.message ?? '')
  const stderr = String(error?.stderr ?? '')
  const stdout = String(error?.stdout ?? '')
  const combined = `${message}\n${stderr}\n${stdout}`
  const signal = String(error?.signal ?? '')
  const exitCode = error?.code

  if (error?.killed || signal === 'SIGKILL' || signal === 'SIGTERM') {
    return timeoutError(timeoutMs, 'killed')
  }
  // -1712: AppleEvent timed out (the `with timeout` block fired).
  if (/-1712\b|AppleEvent timed out|Apple event timed out|事件超时/.test(combined)) {
    return timeoutError(timeoutMs, 'applee')
  }
  // -1743 (and localized variants): macOS Automation permission is missing.
  if (
    /-1743\b|not authorized to send apple events|not allowed to send apple events|不允许发送 Apple 事件|未获授权|未经授权.*Apple/i.test(
      combined,
    )
  ) {
    return new PsBridgeError(
      'not_authorized',
      `macOS blocked Apple events to ${appLabel} (-1743). Open System Settings > Privacy & Security > Automation and allow your terminal/agent app to control "${target.appName}", then retry.`,
      { stderr: truncate(stderr, 1000) },
    )
  }
  // -10814 / -600 / -609: Photoshop is not running or cannot be addressed.
  if (
    /-10814\b|-600\b|-609\b|isn't running|is not running|Application isn't running|Can't get application|不能获得.*应用程序|应用程序.*未运行|未运行/.test(
      combined,
    )
  ) {
    return new PsBridgeError(
      'not_running',
      `Adobe Photoshop is not running (target: ${appLabel}). Open Photoshop, or create the bridge with { launchIfNeeded: true } so it is launched on demand.`,
      { stderr: truncate(stderr, 1000) },
    )
  }
  const detail = truncate(stderr || stdout || message, 1200) || 'no output'
  return new PsBridgeError(
    'applescript',
    `AppleScript could not run the Photoshop script (target: ${appLabel}, exit: ${exitCode ?? 'unknown'}): ${detail}. AppleScript line numbers refer to the generated .scpt, not to your JSX body.`,
    { exitCode, stderr: truncate(stderr, 2000) },
  )
}

function parseStdout(stdout) {
  const trimmed = String(stdout ?? '').trim()
  if (trimmed.startsWith('ERROR:')) {
    const message = trimmed.slice('ERROR:'.length).trim() || 'Photoshop script failed without a message'
    throw new PsBridgeError('photoshop_error', message, { payload: truncate(trimmed, 2000) })
  }
  return parseExtendScriptPayload(trimmed)
}

function normalizeLogger(logger) {
  if (!logger) {
    const noop = () => {}
    return { debug: noop, info: noop, warn: noop, error: noop }
  }
  if (typeof logger === 'function') {
    return { debug: logger, info: logger, warn: logger, error: logger }
  }
  const pick = (name) => (typeof logger[name] === 'function' ? logger[name].bind(logger) : () => {})
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') }
}

/**
 * Create the Photoshop bridge.
 *
 * @param {object} [options]
 * @param {string} [options.appName='Adobe Photoshop 2026'] Photoshop application name
 * @param {string} [options.appPath] explicit `.app` path (or executable inside one)
 * @param {number} [options.timeoutMs=60000] default budget for `run()`
 * @param {number} [options.longTimeoutMs=180000] budget for `runLong()`
 * @param {boolean} [options.launchIfNeeded=true] launch Photoshop when it is not running
 * @param {number} [options.queueWaitMs=120000] max time a call may wait behind other calls
 * @param {{debug?: Function, info?: Function, warn?: Function, error?: Function}|Function} [options.logger]
 */
export function createPsBridge(options = {}) {
  const logger = normalizeLogger(options.logger)
  const targetInfo = resolveTarget(options)
  const defaultTimeoutMs = clampTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const longTimeoutMs = clampTimeout(options.longTimeoutMs, DEFAULT_LONG_TIMEOUT_MS)
  const launchIfNeeded = options.launchIfNeeded !== false
  const queueWaitMs = clampTimeout(options.queueWaitMs, QUEUE_WAIT_ALLOWANCE_MS)
  const launchWaitMs = clampTimeout(options.launchWaitMs, LAUNCH_WAIT_MS)

  let disposed = false
  let queueTail = Promise.resolve()
  let queueDepth = 0

  function describeTarget() {
    return targetInfo.appPath ?? targetInfo.appName
  }

  /**
   * Append a task to the FIFO queue. Callers observe their own timeout, not queue time;
   * a task that waited longer than `queueWaitMs` is rejected before touching Photoshop.
   */
  function enqueue(task, timeoutMs) {
    queueDepth += 1
    const enqueuedAt = Date.now()
    const run = queueTail.then(async () => {
      queueDepth -= 1
      if (disposed) {
        throw new PsBridgeError('disposed', 'The Photoshop bridge has been disposed; create a new one before running scripts.')
      }
      const waitedMs = Date.now() - enqueuedAt
      if (waitedMs > queueWaitMs) {
        throw new PsBridgeError(
          'busy',
          `Photoshop is busy: the script waited ${waitedMs}ms in the execution queue (limit ${queueWaitMs}ms). Wait for the current operation to finish and retry.`,
          { waitedMs, queueDepth },
        )
      }
      if (waitedMs > 250) logger.debug(`[dsh-ps] dequeued after ${waitedMs}ms wait (timeout ${timeoutMs}ms)`)
      return task()
    })
    queueTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function isRunning() {
    if (targetInfo.appPath) {
      try {
        const { stdout } = await execFileAsync(PGREP, ['-f', `^${escapeForPgrep(targetInfo.appPath)}/Contents/MacOS/`], {
          timeout: 10_000,
        })
        return String(stdout ?? '').trim() !== ''
      } catch (error) {
        // pgrep exit code 1 = no match; anything else falls through to the AppleScript probe.
        if (error && error.code === 1) return false
      }
    }
    try {
      const { stdout } = await execFileAsync(
        OSASCRIPT,
        ['-e', `application ${appleScriptString(targetInfo.appPath ?? targetInfo.appName)} is running`],
        { timeout: 10_000 },
      )
      return String(stdout ?? '').trim() === 'true'
    } catch {
      return false
    }
  }

  async function launchApp() {
    const ref = describeTarget()
    logger.info(`[dsh-ps] launching Photoshop: ${ref}`)
    try {
      await execFileAsync(OPEN, ['-a', ref], { timeout: 30_000 })
    } catch (error) {
      throw new PsBridgeError(
        'launch_failed',
        `Could not launch Photoshop (${ref}): ${truncate(error?.message ?? String(error), 500)}. Start Photoshop manually and retry.`,
      )
    }
    const deadline = Date.now() + launchWaitMs
    while (Date.now() < deadline) {
      if (await isRunning()) return
      await sleep(1000)
    }
    throw new PsBridgeError(
      'not_running',
      `Launched Photoshop (${ref}) but it did not become scriptable within ${launchWaitMs}ms. Wait for it to finish starting, then retry.`,
    )
  }

  async function ensureRunning() {
    if (await isRunning()) return
    if (!launchIfNeeded) {
      throw new PsBridgeError(
        'not_running',
        `Adobe Photoshop is not running (target: ${describeTarget()}). Open Photoshop, or create the bridge with { launchIfNeeded: true }.`,
      )
    }
    await launchApp()
  }

  async function executeScript(script, timeoutMs) {
    const id = randomBytes(8).toString('hex')
    const jsxPath = join(tmpdir(), `dsh-ps-${id}.jsx`)
    const scptPath = join(tmpdir(), `dsh-ps-${id}.scpt`)
    const killMs = killTimeoutMs(timeoutMs)
    try {
      await writeFile(jsxPath, EXTENDSCRIPT_BOM + script, 'utf8')
      await writeFile(scptPath, buildAppleScript(jsxPath, timeoutMs, targetInfo), 'utf8')
      logger.debug(`[dsh-ps] osascript ${scptPath} (timeout ${timeoutMs}ms, kill after ${killMs}ms)`)
      let stdout
      try {
        const result = await execFileAsync(OSASCRIPT, [scptPath], {
          timeout: killMs,
          killSignal: 'SIGKILL',
          maxBuffer: 32 * 1024 * 1024,
          encoding: 'utf8',
        })
        stdout = result.stdout
      } catch (error) {
        throw classifyAppleScriptError(error, { timeoutMs, target: targetInfo })
      }
      const parsed = parseStdout(stdout)
      logger.debug('[dsh-ps] script finished')
      return parsed
    } finally {
      await Promise.all([unlink(jsxPath).catch(() => {}), unlink(scptPath).catch(() => {})])
    }
  }

  /**
   * Run one ExtendScript body inside the reference error wrapper.
   *
   * @param {string} body inside of `function () { ... }`; must `return` a plain object
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<any>} parsed `toSource()` payload of the returned value
   */
  async function run(body, opts = {}) {
    if (typeof body !== 'string' || body.trim() === '') {
      throw new PsBridgeError('invalid_script', 'run(body) requires a non-empty ExtendScript body string.')
    }
    if (disposed) {
      throw new PsBridgeError('disposed', 'The Photoshop bridge has been disposed; create a new one before running scripts.')
    }
    const timeoutMs = opts.timeoutMs === undefined ? defaultTimeoutMs : clampTimeout(opts.timeoutMs, defaultTimeoutMs)
    const script = wrapInErrorHandling(body)
    return enqueue(async () => {
      await ensureRunning()
      return executeScript(script, timeoutMs)
    }, timeoutMs)
  }

  /**
   * Run with the long default budget (default 180000ms), for capture/place on big documents.
   *
   * @param {string} body
   * @param {{ timeoutMs?: number }} [opts]
   */
  async function runLong(body, opts = {}) {
    return run(body, {
      ...opts,
      timeoutMs: opts.timeoutMs === undefined ? longTimeoutMs : opts.timeoutMs,
    })
  }

  /** @returns {PsTarget} resolved target (a copy). */
  function target() {
    return { ...targetInfo }
  }

  /** Mark the bridge disposed and wait for the in-flight queue to drain. */
  async function dispose() {
    disposed = true
    await queueTail.catch(() => {})
    logger.debug('[dsh-ps] bridge disposed')
  }

  return { run, runLong, isRunning, target, dispose }
}
