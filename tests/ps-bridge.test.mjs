/**
 * End-to-end tests for `lib/ps-bridge.js` + `lib/ps-scripts.js` against the REAL
 * installed Adobe Photoshop 2026 (macOS AppleScript -> ExtendScript path).
 *
 * Safety rules baked in (they run against the user's live Photoshop):
 *  - the suite creates its own document `DSH PS Bridge Test` and does every destructive
 *    operation there;
 *  - the user's documents are never modified, saved or closed;
 *  - the test document is closed with `SaveOptions.DONOTSAVECHANGES` and the previously
 *    active document is re-activated, so the document set is restored exactly;
 *  - every bridge call is bounded by the bridge timeout; the whole file is run with a
 *    shell `timeout` in CI/scripts;
 *  - all temp files live in a unique `tests/tmp/run-*` directory and are removed.
 *
 * Run from the workspace root:
 *   node --test plugins/dsh-photoshop-genfill/tests/ps-bridge.test.mjs
 *
 * @module dsh-photoshop-genfill/tests/ps-bridge.test
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { createPsBridge, PsBridgeError } from '../lib/ps-bridge.js'
import {
  appInfoScript,
  captureScript,
  placeScript,
  stateScript,
  undoScript,
} from '../lib/ps-scripts.js'

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEST_DOC_NAME = 'DSH PS Bridge Test'
const TEST_DOC_WIDTH = 800
const TEST_DOC_HEIGHT = 600
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const TOLERANCE = 1.5

/** Collected for `reports/ps-bridge.md`; every entry is a real Photoshop observation. */
const evidence = {}
function record(name, value) {
  evidence[name] = value
  console.log(`[evidence] ${name} ${JSON.stringify(value)}`)
}

// ---------------------------------------------------------------------------
// ExtendScript bodies used by the test harness itself (read/cleanup operations)
// ---------------------------------------------------------------------------

const LIST_DOCUMENTS_BODY = `
var out = [];
var activeId = -1;
try { activeId = app.activeDocument.id; } catch (eActive) {}
for (var i = 0; i < app.documents.length; i++) {
  out.push({ id: app.documents[i].id, name: String(app.documents[i].name) });
}
return { documents: out, count: out.length, activeId: activeId };
`

const HISTORY_BODY = `
var doc = app.activeDocument;
var index = -1;
for (var i = 0; i < doc.historyStates.length; i++) {
  if (doc.historyStates[i] === doc.activeHistoryState) { index = i; break; }
}
return { index: index, count: doc.historyStates.length };
`

const ACTIVE_LAYER_MASK_BODY = `
var layer = app.activeDocument.activeLayer;
var ref = new ActionReference();
ref.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('UsrM'));
ref.putEnumerated(app.charIDToTypeID('Lyr '), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
var args = new ActionDescriptor();
args.putReference(app.charIDToTypeID('null'), ref);
var desc = executeAction(app.charIDToTypeID('getd'), args, DialogModes.NO);
return { layerName: String(layer.name), hasMask: desc.hasKey(app.charIDToTypeID('UsrM')) };
`

function closeDocumentBody({ id, name, restoreId }) {
  return `
var targetId = ${Number.isFinite(id) ? id : -1};
var targetName = ${JSON.stringify(name ?? '')};
var restoreId = ${Number.isFinite(restoreId) ? restoreId : -1};
var target = null;
for (var i = 0; i < app.documents.length; i++) {
  var candidate = app.documents[i];
  if (candidate.id === targetId || (targetName && String(candidate.name) === targetName)) {
    target = candidate;
    break;
  }
}
if (!target) return { closed: false, reason: 'not_found' };
try { app.activeDocument = target; } catch (eActivate) {}
target.close(SaveOptions.DONOTSAVECHANGES);
var restore = null;
if (restoreId >= 0) {
  for (var j = 0; j < app.documents.length; j++) {
    if (app.documents[j].id === restoreId) { restore = app.documents[j]; break; }
  }
}
if (restore) { try { app.activeDocument = restore; } catch (eRestore) {} }
return { closed: true, remaining: app.documents.length };
`
}

const CREATE_TEST_DOCUMENT_BODY = `
var doc = app.documents.add(${TEST_DOC_WIDTH}, ${TEST_DOC_HEIGHT}, 72, ${JSON.stringify(TEST_DOC_NAME)}, NewDocumentMode.RGB, DocumentFill.WHITE);

// A colored shape so captures contain real pixels (not a uniform white canvas).
var shape = doc.artLayers.add();
shape.name = 'Test Shape';
doc.activeLayer = shape;
doc.selection.select([[40,40],[760,40],[760,360],[40,360]], SelectionType.REPLACE, 0, true);
var cool = new SolidColor();
cool.rgb.red = 32; cool.rgb.green = 120; cool.rgb.blue = 210;
doc.selection.fill(cool, ColorBlendMode.NORMAL, 100, false);
doc.selection.select([[240,160],[560,160],[560,440],[240,440]], SelectionType.REPLACE, 0, true);
var warm = new SolidColor();
warm.rgb.red = 240; warm.rgb.green = 180; warm.rgb.blue = 40;
doc.selection.fill(warm, ColorBlendMode.NORMAL, 100, false);
doc.selection.deselect();

return {
  ok: true,
  id: doc.id,
  name: String(doc.name),
  width: doc.width.as('px'),
  height: doc.height.as('px'),
  layerCount: doc.layers.length
};
`

const SELECT_RECTANGLE_BODY = `
var doc = app.activeDocument;
doc.selection.select([[100,100],[500,100],[500,400],[100,400]], SelectionType.REPLACE, 0, true);
return { ok: true };
`

const DESELECT_BODY = `
var doc = app.activeDocument;
try { doc.selection.deselect(); } catch (eNoSelection) {}
return { ok: true };
`

const SELECT_ELLIPSE_BODY = `
var doc = app.activeDocument;
var points = [];
var steps = 48;
for (var i = 0; i < steps; i++) {
  var angle = (2 * Math.PI * i) / steps;
  points.push([400 + 200 * Math.cos(angle), 300 + 120 * Math.sin(angle)]);
}
doc.selection.select(points, SelectionType.REPLACE, 0, true);
return { ok: true };
`

const ADD_EMPTY_LAYER_BODY = `
var doc = app.activeDocument;
var empty = doc.artLayers.add();
empty.name = 'Empty Layer';
return { ok: true, name: String(empty.name) };
`

// ---------------------------------------------------------------------------
// Small utilities (Node builtins only)
// ---------------------------------------------------------------------------

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Failures that mean the JSX body did not run at all: the AppleScript event was rejected
 * before/while `do javascript` handed the file to Photoshop. This machine is shared with
 * other agents that also drive Photoshop, and two concurrent `do javascript` calls make
 * Photoshop answer with a generic error (8800), so a bounded retry is safe here.
 */
const RETRIABLE =
  /(-1728|-1712|8800|AppleEvent timed out|Photoshop is busy|general photoshop error|常规 Photoshop 错误|user interaction|no response)/i

/**
 * Run a body with a bounded retry for clearly transient AppleScript failures
 * (a busy Photoshop whose script never ran). Mutations run through this too, but
 * retries only happen for osascript-level failures, where the body did not execute.
 */
async function psRun(body, { timeoutMs, label = 'script', attempts = 3 } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await bridge.run(body, timeoutMs === undefined ? undefined : { timeoutMs })
    } catch (error) {
      lastError = error
      const transient = error?.code === 'applescript' && RETRIABLE.test(String(error.message))
      if (!transient || attempt === attempts) throw error
      const backoffMs = 2000 * attempt
      console.log(`[retry] ${label} failed on attempt ${attempt}, waiting ${backoffMs}ms: ${error.message}`)
      await sleep(backoffMs)
    }
  }
  throw lastError
}

/** Read the Photoshop state via `stateScript()` (with retry for read-only calls). */
async function readState(layerLimit = 40) {
  return psRunDoc(stateScript({ layerLimit }), { label: 'state' })
}

/**
 * Prefix a body with "activate the test document by id, or fail".
 *
 * The suite runs against a live, shared Photoshop: other agents may open/activate their
 * own documents between our calls, and every ps-scripts body uses `app.activeDocument`.
 * Activating the target doc inside the same JSX execution makes each script deterministic
 * (Photoshop executes one JSX script atomically, so no other AppleEvent can retarget it).
 */
function withTargetDocument(body, docId = testDocId) {
  const targetId = Number.isFinite(Number(docId)) ? Number(docId) : -1
  return `
var __dshTargetId = ${targetId};
var __dshTarget = null;
for (var __dshIndex = 0; __dshIndex < app.documents.length; __dshIndex++) {
  if (app.documents[__dshIndex].id === __dshTargetId) { __dshTarget = app.documents[__dshIndex]; break; }
}
if (!__dshTarget) {
  return { ok: false, code: 'document_gone', message: 'The test document (id ' + __dshTargetId + ') is no longer open' };
}
try { app.activeDocument = __dshTarget; } catch (eActivateTarget) {}
${body}
`
}

/** Run a body that must operate on the suite's own test document. */
async function psRunDoc(body, options = {}) {
  return psRun(withTargetDocument(body), options)
}

/** Current history position of the active document. */
async function historyInfo() {
  return psRunDoc(HISTORY_BODY, { label: 'history' })
}

/**
 * Undo everything that happened since `historyBefore` (capture leaves no history,
 * one placement creates several steps: place, transform, mask, selection restore).
 */
async function undoSince(historyBefore, label) {
  const after = await historyInfo()
  const steps = after.index - historyBefore.index
  assert.ok(steps > 0, `${label}: expected the placement to add history steps (before ${historyBefore.index}, after ${after.index})`)
  const undo = await psRunDoc(undoScript({ steps }), { timeoutMs: 60_000, label: `${label} undo` })
  assert.equal(undo.ok, true, `${label}: undoScript should succeed`)
  assert.equal(undo.undone, steps, `${label}: undoScript.undone should be the number of steps actually traversed`)
  assert.equal(undo.steps, steps)
  assert.ok(undo.historyCount >= steps)
  const restored = await historyInfo()
  assert.equal(restored.index, historyBefore.index, `${label}: history should be back at the pre-placement state`)
  return { steps, undo }
}

function assertBounds(actual, expected, label, tolerance = TOLERANCE) {
  for (const key of ['left', 'top', 'width', 'height']) {
    assert.ok(
      Math.abs(Number(actual[key]) - Number(expected[key])) <= tolerance,
      `${label}: expected ${key} ≈ ${expected[key]}, got ${actual[key]} (bounds ${JSON.stringify(actual)})`,
    )
  }
}

/** Validate PNG signature/IHDR/IEND and return its decoded header. */
function assertPng(buffer, { width, height, label = 'PNG' } = {}) {
  assert.ok(buffer.length > 64, `${label}: file is too small (${buffer.length} bytes)`)
  assert.deepEqual([...buffer.subarray(0, 8)], PNG_SIGNATURE, `${label}: missing PNG signature`)
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR', `${label}: first chunk must be IHDR`)
  const pngWidth = buffer.readUInt32BE(16)
  const pngHeight = buffer.readUInt32BE(20)
  const bitDepth = buffer[24]
  const colorType = buffer[25]
  assert.equal(buffer.toString('ascii', buffer.length - 8, buffer.length - 4), 'IEND', `${label}: missing IEND`)
  if (width !== undefined) assert.equal(pngWidth, width, `${label}: IHDR width`)
  if (height !== undefined) assert.equal(pngHeight, height, `${label}: IHDR height`)
  return { width: pngWidth, height: pngHeight, bitDepth, colorType, bytes: buffer.length }
}

/** Read a captured PNG and validate it. */
async function readCapturedPng(filePath, expected, label) {
  const buffer = await readFile(filePath)
  return assertPng(buffer, { ...expected, label })
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder for the placement fixtures (no npm dependencies)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Write an 8-bit RGB PNG with a deterministic diagonal gradient (visible pixels). */
async function writeTestPng(filePath, width, height) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    raw[row] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const offset = row + 1 + x * 3
      raw[offset] = Math.round(24 + (210 * x) / Math.max(1, width - 1))
      raw[offset + 1] = Math.round(48 + (150 * y) / Math.max(1, height - 1))
      raw[offset + 2] = Math.round(200 - (140 * x) / Math.max(1, width - 1))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  const buffer = Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  await writeFile(filePath, buffer)
  assertPng(buffer, { width, height, label: path.basename(filePath) })
  return buffer
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let bridge
let tmpDir
let preSnapshot
let testDocId = null
let testDocClosed = false

async function closeTestDocument(label) {
  if (!bridge || testDocClosed) return null
  const restoreId = preSnapshot?.activeId ?? -1
  const result = await psRun(closeDocumentBody({ id: testDocId, name: TEST_DOC_NAME, restoreId }), {
    timeoutMs: 60_000,
    label,
    attempts: 4,
  })
  if (result.closed) testDocClosed = true
  return result
}

/**
 * Assert that our test document is gone and no pre-existing document was lost.
 * This machine's Photoshop may be driven by another agent at the same time, so
 * documents opened by that agent are reported but not treated as our leak (we only
 * ever create the single `DSH PS Bridge Test` document).
 */
function assertDocumentSetRestored(prefix, postSnapshot) {
  const missing = preSnapshot.documents.filter(
    (before) => !postSnapshot.documents.some((after) => after.id === before.id && after.name === before.name),
  )
  assert.deepEqual(missing, [], `${prefix}: pre-existing Photoshop documents must still be open`)
  assert.equal(
    postSnapshot.documents.some((doc) => doc.name === TEST_DOC_NAME),
    false,
    `${prefix}: the test document must be closed`,
  )
  const extras = postSnapshot.documents.filter(
    (after) => !preSnapshot.documents.some((before) => before.id === after.id),
  )
  if (extras.length > 0) {
    console.log(`[warn] ${prefix}: concurrent documents from another process: ${JSON.stringify(extras)}`)
  }
  const previouslyActiveStillOpen = postSnapshot.documents.some((doc) => doc.id === preSnapshot.activeId)
  if (previouslyActiveStillOpen) {
    assert.equal(postSnapshot.activeId, preSnapshot.activeId, `${prefix}: previously active document should be active again`)
  }
  return { missing, extras }
}

before(async () => {
  const tmpBase = path.join(PLUGIN_ROOT, 'tests', 'tmp')
  await mkdir(tmpBase, { recursive: true })
  tmpDir = await mkdtemp(path.join(tmpBase, 'run-'))

  bridge = createPsBridge({ timeoutMs: 60_000, launchIfNeeded: false })
  const running = await bridge.isRunning()
  assert.equal(
    running,
    true,
    'Adobe Photoshop 2026 must be running (the test executes real ExtendScript through AppleScript)',
  )
  preSnapshot = await psRun(LIST_DOCUMENTS_BODY, { label: 'pre-snapshot' })
  record('before_documents', preSnapshot)
})

after(async () => {
  // Safety net: if a test failed mid-way, still close only our own document.
  try {
    const result = await closeTestDocument('after-hook cleanup')
    if (result && !result.closed) console.log(`[cleanup] test document already gone: ${result.reason}`)
  } catch (error) {
    console.log(`[cleanup] could not close test document: ${error.message}`)
  }
  try {
    const post = await psRun(LIST_DOCUMENTS_BODY, { label: 'post-snapshot', attempts: 4 })
    record('after_documents', post)
    if (preSnapshot) assertDocumentSetRestored('after hook', post)
  } catch (error) {
    console.log(`[cleanup] final document snapshot failed: ${error.message}`)
  }
  try {
    await bridge?.dispose()
  } catch {
    /* best effort */
  }
  try {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
    const base = path.join(PLUGIN_ROOT, 'tests', 'tmp')
    await rm(base, { recursive: false, force: true }).catch(() => {})
  } catch {
    /* best effort */
  }
  console.log(`[evidence] test_summary ${JSON.stringify({ ok: true, evidence })}`)
})

// ---------------------------------------------------------------------------
// 1. Bridge plumbing (read-only against the user's Photoshop)
// ---------------------------------------------------------------------------

test('bridge detects the installed Photoshop 2026 and runs appInfoScript', async () => {
  const target = bridge.target()
  assert.equal(target.appName, 'Adobe Photoshop 2026')
  assert.ok(/Adobe Photoshop 2026\.app$/.test(target.appPath), `unexpected appPath: ${target.appPath}`)
  assert.equal(await bridge.isRunning(), true)

  const info = await bridge.run(appInfoScript())
  assert.equal(info.running, true)
  assert.match(info.name, /Photoshop/i)
  assert.match(info.version, /^\d+\.\d+/)
  record('app_info', { target, info })
})

test('bridge fails fast and actionably when the target app is not running', async () => {
  const ghost = createPsBridge({
    appName: 'Adobe Photoshop 2026',
    appPath: '/Applications/DSH Missing Photoshop.app',
    launchIfNeeded: false,
    timeoutMs: 5_000,
  })
  try {
    assert.equal(await ghost.isRunning(), false)
    await assert.rejects(
      () => ghost.run('return { ok: true };'),
      (error) => {
        assert.ok(error instanceof PsBridgeError, 'expected a PsBridgeError')
        assert.equal(error.code, 'not_running')
        assert.match(error.message, /not running/i)
        return true
      },
    )
  } finally {
    await ghost.dispose()
    await assert.rejects(
      () => ghost.run('return { ok: true };'),
      (error) => error.code === 'disposed',
    )
  }
  record('not_running_error', 'PsBridgeError{code:not_running} for a missing .app target; disposed bridge rejects with code:disposed')
})

test('Photoshop ERROR payloads reject, and the FIFO queue serializes executions', async () => {
  await assert.rejects(
    () => bridge.run(`throw new Error('dsh-bridge-boom-42');`),
    (error) => {
      assert.ok(error instanceof PsBridgeError)
      assert.equal(error.code, 'photoshop_error')
      assert.match(error.message, /dsh-bridge-boom-42/)
      return true
    },
  )

  const startedAt = Date.now()
  const first = bridge.run(
    `var startedAt = (new Date()).getTime(); $.sleep(800); return { seq: 1, startedAt: startedAt, at: (new Date()).getTime() };`,
  )
  const second = bridge.run(`return { seq: 2, startedAt: (new Date()).getTime(), at: (new Date()).getTime() };`)
  const [r1, r2] = await Promise.all([first, second])
  assert.equal(r1.seq, 1)
  assert.equal(r2.seq, 2)
  // With one FIFO queue the second script can only start after the first (sleeping)
  // one finished: it must start at least 800ms after the first one STARTED. If the
  // bridge ran both concurrently, the second script would return while the first is
  // still sleeping, i.e. r2.at << r1.startedAt + 800.
  assert.ok(
    r2.at >= r1.startedAt + 800,
    `queue is not serial: second script ran ${r2.at - r1.startedAt}ms after the first started (expected >= 800ms)`,
  )
  assert.ok(r2.at > r1.at, 'the second script should only run after the first returned')
  assert.ok(Date.now() - startedAt >= 800)
  record('queue_serialization', {
    first: r1,
    second: r2,
    secondStartedAfterFirstStartedMs: r2.at - r1.startedAt,
    secondAfterFirstReturnedMs: r2.at - r1.at,
  })
})

test('a runaway script is bounded by the bridge timeout and Photoshop recovers', async () => {
  const startedAt = Date.now()
  await assert.rejects(
    () => bridge.run(`$.sleep(8000); return { ok: true };`, { timeoutMs: 1000 }),
    (error) => {
      assert.ok(error instanceof PsBridgeError)
      assert.equal(error.code, 'timeout')
      assert.match(error.message, /did not answer within 1000ms/)
      return true
    },
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 15_000, `timeout was not bounded: ${elapsed}ms`)
  // A timed-out AppleEvent cannot abort JSX already running in Photoshop; let it finish.
  await sleep(2_500)
  const recovered = await bridge.run('return { ok: true };')
  assert.equal(recovered.ok, true)
  record('timeout_error', { elapsedMs: elapsed, recovered: true })
})

// ---------------------------------------------------------------------------
// 2. Own test document: state, captures
// ---------------------------------------------------------------------------

test('creates its own test document and stateScript reports the full shape', async () => {
  const created = await psRun(CREATE_TEST_DOCUMENT_BODY, { timeoutMs: 120_000, label: 'create test document' })
  assert.equal(created.ok, true)
  assert.equal(created.name, TEST_DOC_NAME)
  testDocId = created.id
  record('created_document', created)

  const state = await readState()
  assert.equal(state.ok, true)
  assert.equal(state.hasDocument, true)
  assert.equal(state.app.name, 'Adobe Photoshop')
  assert.match(state.app.version, /^\d+\.\d+/)

  const doc = state.document
  assert.equal(doc.id, testDocId)
  assert.equal(doc.name, TEST_DOC_NAME)
  assert.equal(doc.width, TEST_DOC_WIDTH)
  assert.equal(doc.height, TEST_DOC_HEIGHT)
  assert.equal(doc.resolution, 72)
  assert.match(doc.colorMode, /RGB/i)
  assert.equal(doc.path, null)
  assert.equal(doc.saved, false)
  assert.equal(doc.layerCount, 2)
  assert.equal(doc.hasSelection, false)

  assert.equal(state.selection, null)
  assert.equal(state.activeLayer.name, 'Test Shape')
  assert.equal(state.activeLayer.kind, 'normal')
  assert.equal(state.activeLayer.visible, true)
  assert.equal(state.activeLayer.isBackground, false)
  assertBounds(state.activeLayer.bounds, { left: 40, top: 40, width: 720, height: 400 }, 'activeLayer.bounds')

  assert.deepEqual(state.layers.map((layer) => layer.kind), ['normal', 'normal'])
  assert.equal(state.layers.length, 2)
  assert.equal(state.layers[0].name, 'Test Shape')
  assert.equal(state.layers[0].visible, true)
  assert.equal(state.layers[1].visible, true)
  record('state_test_document', doc)
})

test('captureScript exports flattened PNGs for document, selection and layer regions', async () => {
  // document
  const documentPng = path.join(tmpDir, 'capture-document.png')
  const capturedDocument = await psRunDoc(captureScript({ outPath: documentPng, source: 'document' }), {
    timeoutMs: 120_000,
    label: 'capture document',
  })
  assert.equal(capturedDocument.ok, true)
  assert.equal(capturedDocument.path, documentPng)
  assert.equal(capturedDocument.source, 'document')
  assertBounds(capturedDocument.bounds, { left: 0, top: 0, width: 800, height: 600 }, 'capture document bounds')
  const documentInfo = await readCapturedPng(documentPng, { width: 800, height: 600 }, 'capture-document.png')

  // rectangle selection
  await psRunDoc(SELECT_RECTANGLE_BODY, { label: 'select rectangle' })
  const selectedState = await readState()
  assert.equal(selectedState.document.hasSelection, true)
  assertBounds(selectedState.selection, { left: 100, top: 100, width: 400, height: 300 }, 'selection bounds')
  assert.deepEqual(
    { left: selectedState.selection.left, top: selectedState.selection.top, right: selectedState.selection.right, bottom: selectedState.selection.bottom },
    { left: 100, top: 100, right: 500, bottom: 400 },
  )

  const selectionPng = path.join(tmpDir, 'capture-selection.png')
  const capturedSelection = await psRunDoc(captureScript({ outPath: selectionPng, source: 'selection' }), {
    timeoutMs: 120_000,
    label: 'capture selection',
  })
  assert.equal(capturedSelection.ok, true)
  assert.equal(capturedSelection.source, 'selection')
  assertBounds(capturedSelection.bounds, { left: 100, top: 100, width: 400, height: 300 }, 'capture selection bounds')
  const selectionInfo = await readCapturedPng(selectionPng, { width: 400, height: 300 }, 'capture-selection.png')

  // active layer ("Test Shape" covers 720x400 at 40,40)
  const layerPng = path.join(tmpDir, 'capture-layer.png')
  const capturedLayer = await psRunDoc(captureScript({ outPath: layerPng, source: 'layer' }), {
    timeoutMs: 120_000,
    label: 'capture layer',
  })
  assert.equal(capturedLayer.ok, true)
  assert.equal(capturedLayer.source, 'layer')
  assertBounds(capturedLayer.bounds, { left: 40, top: 40, width: 720, height: 400 }, 'capture layer bounds')
  const layerInfo = await readCapturedPng(layerPng, { width: 720, height: 400 }, 'capture-layer.png')

  // The captures worked on duplicates: the user's document is unchanged (2 layers, same selection).
  const afterCaptures = await readState()
  assert.equal(afterCaptures.document.layerCount, 2)
  assert.equal(afterCaptures.document.saved, false)
  assert.equal(afterCaptures.document.hasSelection, true)

  record('captures', {
    document: { ...capturedDocument.bounds, png: documentInfo },
    selection: { ...capturedSelection.bounds, png: selectionInfo },
    layer: { ...capturedLayer.bounds, png: layerInfo },
  })
})

// ---------------------------------------------------------------------------
// 3. Place + mask + undo (rectangular selection)
// ---------------------------------------------------------------------------

test('placeScript places a smart object with cover fit and a selection mask, then undo removes it', async () => {
  const placedSource = path.join(tmpDir, 'placed-200x150.png')
  await writeTestPng(placedSource, 200, 150) // 4:3, same aspect as the 400x300 selection

  const beforeState = await readState()
  const historyBefore = await historyInfo()

  const placed = await bridge.runLong(
    placeScript({
      filePath: placedSource,
      bounds: beforeState.selection,
      fit: 'cover',
      name: 'DSH Placed',
      maskSelection: true,
    }),
  )
  assert.equal(placed.ok, true)
  assert.equal(placed.layerName, 'DSH Placed')
  assert.equal(placed.fit, 'cover')
  assert.equal(placed.maskCreated, true)
  assertBounds(placed.bounds, { left: 100, top: 100, width: 400, height: 300 }, 'placed layer bounds')

  const afterState = await readState()
  assert.equal(afterState.document.layerCount, beforeState.document.layerCount + 1)
  assert.equal(afterState.activeLayer.name, 'DSH Placed')
  assert.equal(afterState.activeLayer.kind, 'smartobject')
  assertBounds(afterState.activeLayer.bounds, { left: 100, top: 100, width: 400, height: 300 }, 'placed smart object bounds')

  // The user's selection must survive the masked placement (restored from the temp channel).
  assert.equal(afterState.document.hasSelection, true)
  assertBounds(afterState.selection, { left: 100, top: 100, width: 400, height: 300 }, 'selection after masked place')

  // Real layer mask, verified through Action Manager (UsrM key), not just our result flag.
  const mask = await psRunDoc(ACTIVE_LAYER_MASK_BODY, { label: 'mask check' })
  assert.equal(mask.hasMask, true, 'the placed layer should own a real user layer mask')
  assert.equal(mask.layerName, 'DSH Placed')

  const undone = await undoSince(historyBefore, 'place+mask')
  const restoredState = await readState()
  assert.equal(restoredState.document.layerCount, beforeState.document.layerCount)
  assert.equal(restoredState.layers[0].name, 'Test Shape')
  assert.equal(restoredState.document.hasSelection, true)
  assertBounds(restoredState.selection, { left: 100, top: 100, width: 400, height: 300 }, 'selection after undo')

  record('place_cover_mask', {
    result: placed,
    state: {
      layerCount: afterState.document.layerCount,
      activeLayer: afterState.activeLayer,
      selection: afterState.selection,
    },
    maskCheck: mask,
    undo: { steps: undone.steps, result: undone.undo },
    afterUndo: { layerCount: restoredState.document.layerCount, layers: restoredState.layers },
  })
})

// ---------------------------------------------------------------------------
// 4. Center/fit modes (contain + stretch), no mask
// ---------------------------------------------------------------------------

test('placeScript honors center + contain and center + stretch fits without a mask', async () => {
  await psRunDoc(DESELECT_BODY, { label: 'deselect' })
  const square = path.join(tmpDir, 'placed-120x120.png')
  await writeTestPng(square, 120, 120)

  // contain: 120x120 into an 800x600 document -> 600x600 centered at (400,300)
  const beforeContain = await readState()
  const containHistory = await historyInfo()
  const contain = await psRunDoc(
    placeScript({ filePath: square, bounds: null, fit: 'contain', center: true, name: 'DSH Contain', maskSelection: false }),
    { timeoutMs: 120_000, label: 'place contain' },
  )
  assert.equal(contain.ok, true)
  assert.equal(contain.maskCreated, false)
  assert.equal(contain.fit, 'contain')
  assertBounds(contain.bounds, { left: 100, top: 0, width: 600, height: 600 }, 'contain bounds', 2)
  const containMask = await psRunDoc(ACTIVE_LAYER_MASK_BODY, { label: 'contain mask check' })
  assert.equal(containMask.hasMask, false)
  await undoSince(containHistory, 'place contain')
  const afterContain = await readState()
  assert.equal(afterContain.document.layerCount, beforeContain.document.layerCount)

  // stretch: 120x120 into an 800x600 document -> exactly 800x600 at (0,0)
  const stretchHistory = await historyInfo()
  const stretch = await psRunDoc(
    placeScript({ filePath: square, bounds: null, fit: 'stretch', center: true, name: 'DSH Stretch', maskSelection: false }),
    { timeoutMs: 120_000, label: 'place stretch' },
  )
  assert.equal(stretch.ok, true)
  assert.equal(stretch.maskCreated, false)
  assert.equal(stretch.fit, 'stretch')
  assertBounds(stretch.bounds, { left: 0, top: 0, width: 800, height: 600 }, 'stretch bounds', 2)
  await undoSince(stretchHistory, 'place stretch')
  const afterStretch = await readState()
  assert.equal(afterStretch.document.layerCount, beforeContain.document.layerCount)
  assert.equal(afterStretch.layers[0].name, 'Test Shape')

  record('place_center_fits', { contain: contain, stretch: stretch })
})

// ---------------------------------------------------------------------------
// 5. Freeform (elliptical) selection mask
// ---------------------------------------------------------------------------

test('placeScript masks with a freeform (elliptical) selection', async () => {
  await psRunDoc(SELECT_ELLIPSE_BODY, { label: 'select ellipse' })
  const selected = await readState()
  assert.equal(selected.document.hasSelection, true)
  assertBounds(selected.selection, { left: 200, top: 180, width: 400, height: 240 }, 'ellipse selection bounds', 2)

  // 5:3 image, matching the 400x240 ellipse bounding box so cover fit is exact.
  const ellipseSource = path.join(tmpDir, 'placed-200x120.png')
  await writeTestPng(ellipseSource, 200, 120)
  const historyBefore = await historyInfo()
  const placed = await psRunDoc(
    placeScript({
      filePath: ellipseSource,
      bounds: selected.selection,
      fit: 'cover',
      name: 'DSH Ellipse Mask',
      maskSelection: true,
    }),
    { timeoutMs: 120_000, label: 'place ellipse mask' },
  )
  assert.equal(placed.ok, true)
  assert.equal(placed.maskCreated, true)
  assertBounds(placed.bounds, { left: 200, top: 180, width: 400, height: 240 }, 'ellipse placed bounds', 2)

  const mask = await psRunDoc(ACTIVE_LAYER_MASK_BODY, { label: 'ellipse mask check' })
  assert.equal(mask.hasMask, true)
  const placedState = await readState()
  assert.equal(placedState.activeLayer.kind, 'smartobject')
  assert.equal(placedState.document.hasSelection, true)
  assertBounds(placedState.selection, { left: 200, top: 180, width: 400, height: 240 }, 'ellipse selection after place', 2)

  await undoSince(historyBefore, 'place ellipse mask')
  const restored = await readState()
  assert.equal(restored.layers[0].name, 'Test Shape')
  record('place_freeform_mask', { selection: selected.selection, result: placed, maskCheck: mask, layersAfterUndo: restored.layers })
})

// ---------------------------------------------------------------------------
// 6. Recoverable Photoshop conditions
// ---------------------------------------------------------------------------

test('recoverable conditions return { ok:false, code } instead of throwing', async () => {
  await psRunDoc(DESELECT_BODY, { label: 'deselect for error tests' })

  const noSelection = await psRunDoc(captureScript({ outPath: path.join(tmpDir, 'never.png'), source: 'selection' }), {
    label: 'capture without selection',
  })
  assert.equal(noSelection.ok, false)
  assert.equal(noSelection.code, 'selection_required')

  const missingFile = await psRunDoc(
    placeScript({ filePath: path.join(tmpDir, 'does-not-exist.png'), bounds: null, fit: 'cover', maskSelection: false }),
    { label: 'place missing file' },
  )
  assert.equal(missingFile.ok, false)
  assert.equal(missingFile.code, 'file_not_found')

  // Empty layer -> empty_layer
  await psRunDoc(ADD_EMPTY_LAYER_BODY, { label: 'add empty layer' })
  const emptyLayer = await psRunDoc(captureScript({ outPath: path.join(tmpDir, 'empty-layer.png'), source: 'layer' }), {
    label: 'capture empty layer',
  })
  assert.equal(emptyLayer.ok, false)
  assert.match(String(emptyLayer.code), /empty_layer|empty_region/)
  const history = await historyInfo()
  const undo = await psRunDoc(undoScript({ steps: 1 }), { label: 'undo empty layer' })
  assert.equal(undo.ok, true)
  assert.equal(undo.undone, 1)
  assert.equal(history.index >= 1, true)

  record('recoverable_errors', {
    noSelection: noSelection,
    missingFile: missingFile,
    emptyLayer: emptyLayer,
  })
})

// ---------------------------------------------------------------------------
// 7. Cleanup: close only our document, restore the document set
// ---------------------------------------------------------------------------

test('closes the test document with DONOTSAVECHANGES and leaves Photoshop as found', async () => {
  const closed = await closeTestDocument('close test document')
  assert.equal(closed.closed, true)
  assert.ok(closed.remaining >= (preSnapshot?.count ?? 0))

  const postSnapshot = await psRun(LIST_DOCUMENTS_BODY, { label: 'post-snapshot' })
  const comparison = assertDocumentSetRestored('document set', postSnapshot)

  // No stray alpha channels / temp layer on the pre-existing documents is assumed because
  // we never targeted them; this assertion just proves the bridge still works after cleanup.
  // (Not targeted at the test document: it is closed at this point.)
  const liveState = await psRun(stateScript({ layerLimit: 1 }), { label: 'state after cleanup' })
  assert.equal(liveState.ok, true)
  assert.equal(liveState.hasDocument, (preSnapshot.count ?? 0) > 0)

  record('cleanup', { closed, postSnapshot, comparison })
})
