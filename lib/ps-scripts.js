/**
 * ExtendScript body builders for the Photoshop bridge.
 *
 * Every function returns the *inside* of `function () { ... }`; `lib/ps-bridge.js`
 * wraps it with the reference error-handling scaffolding (pixel/point units, suppressed
 * dialogs, `toSource()` result, `'ERROR: '` prefix) before writing it as JSX.
 *
 * Rules kept deliberately:
 *  - Bodies are ExtendScript/ES3: `var` only, no arrow functions, template literals,
 *    array extras (`indexOf`, `forEach`, ...) or `JSON` (Photoshop has none of them).
 *  - All user text (paths, layer names) is embedded through {@link jsLiteral}, which
 *    JSON-encodes and then escapes non-ASCII to `\uXXXX`, so the JSX source stays pure
 *    ASCII and survives any macOS/AppleScript encoding hop.
 *  - "Recoverable" preconditions (no document, no selection, empty layer, missing file)
 *    return `{ ok: false, code, message }`; unexpected failures throw and surface as
 *    `ERROR:` through the wrapper.
 *  - Nothing here touches documents the caller did not target: capture works on a
 *    duplicate that is always closed with `SaveOptions.DONOTSAVECHANGES`.
 *
 * Proven snippets (`Plc ` Action Manager place, layer-mask AM helpers, selection
 * helpers, duplicate+crop+PNG save, history-state undo) are adapted from the MIT
 * reference implementation `@alisaitteke/photoshop-mcp` (`dist/api/extendscript.js`).
 *
 * @module dsh-photoshop-genfill/lib/ps-scripts
 */

/** Valid `captureScript({ source })` values. */
export const CAPTURE_SOURCES = ['selection', 'layer', 'document']
/** Valid `placeScript({ fit })` values. */
export const FIT_MODES = ['cover', 'stretch', 'contain']

/**
 * JSON-stringify a value and escape every non-printable-ASCII character to `\uXXXX`.
 * The result is a complete ExtendScript string literal with ASCII-only source text.
 *
 * @param {string} value
 * @returns {string}
 */
function jsLiteral(value) {
  const json = JSON.stringify(String(value))
  return json.replace(/[^\x20-\x7e]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

/** Finite JS number literal, falling back to `0`. */
function numLiteral(value) {
  const n = Number(value)
  return Number.isFinite(n) ? String(n) : '0'
}

/**
 * Normalize caller bounds to `{ left, top, width, height }` in pixels.
 * Accepts either `{ left, top, width, height }` or `{ left, top, right, bottom }`
 * (or the array form `[left, top, right, bottom]`) and returns `null` when unusable.
 *
 * @param {any} bounds
 * @returns {{left:number, top:number, width:number, height:number}|null}
 */
export function normalizeBounds(bounds) {
  if (!bounds) return null
  let left
  let top
  let right
  let bottom
  if (Array.isArray(bounds)) {
    left = Number(bounds[0])
    top = Number(bounds[1])
    right = Number(bounds[2])
    bottom = Number(bounds[3])
  } else if (typeof bounds === 'object') {
    left = Number(bounds.left ?? 0)
    top = Number(bounds.top ?? 0)
    if (bounds.width !== undefined || bounds.height !== undefined) {
      const width = Number(bounds.width)
      const height = Number(bounds.height)
      right = left + (Number.isFinite(width) ? width : 0)
      bottom = top + (Number.isFinite(height) ? height : 0)
    } else {
      right = Number(bounds.right)
      bottom = Number(bounds.bottom)
    }
  } else {
    return null
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    return null
  }
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) return null
  return { left, top, width, height }
}

/** ExtendScript helpers shared by every body (ES3, no dependencies). */
const PSX_HELPERS = `
function __dsh_cTID(s) { return app.charIDToTypeID(s); }
function __dsh_sTID(s) { return app.stringIDToTypeID(s); }

/** Pixel selection present? Action Manager probe first (never throws on no selection). */
function __dsh_hasSelection() {
  try {
    var ref = new ActionReference();
    ref.putProperty(__dsh_sTID('property'), __dsh_sTID('selection'));
    ref.putEnumerated(__dsh_cTID('Dcmn'), __dsh_cTID('Ordn'), __dsh_cTID('Trgt'));
    return executeActionGet(ref).hasKey(__dsh_sTID('selection'));
  } catch (eAm) {
    try { return !!app.activeDocument.selection.bounds; } catch (eDom) { return false; }
  }
}

/** Selection bounding box in px (left/top/right/bottom/width/height) or null. */
function __dsh_selectionBounds() {
  try {
    var b = app.activeDocument.selection.bounds;
    var left = b[0].as('px');
    var top = b[1].as('px');
    var right = b[2].as('px');
    var bottom = b[3].as('px');
    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) return null;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  } catch (e) {
    return null;
  }
}

/** Layer bounding box in px (left/top/right/bottom/width/height) or null. */
function __dsh_layerBounds(layer) {
  if (!layer) return null;
  try {
    var b = layer.bounds;
    var left = b[0].as('px');
    var top = b[1].as('px');
    var right = b[2].as('px');
    var bottom = b[3].as('px');
    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) return null;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  } catch (e) {
    return null;
  }
}

/** Lower-case layer kind name ('normal', 'text', 'smartobject', 'group', ...). */
function __dsh_kindName(layer) {
  try { if (layer.typename === 'LayerSet') return 'group'; } catch (e0) {}
  try {
    var k = layer.kind;
    if (k === LayerKind.NORMAL) return 'normal';
    if (k === LayerKind.TEXT) return 'text';
    if (k === LayerKind.SMARTOBJECT) return 'smartobject';
    if (k === LayerKind.SOLIDFILL) return 'solidfill';
    if (k === LayerKind.GRADIENTFILL) return 'gradientfill';
    if (k === LayerKind.PATTERNFILL) return 'patternfill';
    if (k === LayerKind.LEVELS) return 'levels';
    if (k === LayerKind.CURVES) return 'curves';
    if (k === LayerKind.HUESATURATION) return 'huesaturation';
    if (k === LayerKind.BRIGHTNESSCONTRAST) return 'brightnesscontrast';
    if (k === LayerKind.SELECTIVECOLOR) return 'selectivecolor';
    if (k === LayerKind.CHANNELMIXER) return 'channelmixer';
    if (k === LayerKind.GRADIENTMAP) return 'gradientmap';
    if (k === LayerKind.INVERSION) return 'inversion';
    if (k === LayerKind.THRESHOLD) return 'threshold';
    if (k === LayerKind.POSTERIZE) return 'posterize';
    if (k === LayerKind.PHOTOFILTER) return 'photofilter';
    if (k === LayerKind.EXPOSURE) return 'exposure';
    if (k === LayerKind.VIBRANCE) return 'vibrance';
    if (k === LayerKind.COLORBALANCE) return 'colorbalance';
    if (k === LayerKind.CHANNELMIXER) return 'channelmixer';
  } catch (e1) {}
  try { return String(layer.kind); } catch (e2) {}
  return 'unknown';
}

/** Does the active layer have a user (pixel) layer mask? Action Manager: UsrM key. */
function __dsh_hasLayerMaskAM() {
  var ref = new ActionReference();
  var args = new ActionDescriptor();
  ref.putProperty(__dsh_cTID('Prpr'), __dsh_cTID('UsrM'));
  ref.putEnumerated(__dsh_cTID('Lyr '), __dsh_cTID('Ordn'), __dsh_cTID('Trgt'));
  args.putReference(__dsh_cTID('null'), ref);
  try {
    var resultDesc = executeAction(__dsh_cTID('getd'), args, DialogModes.NO);
    return resultDesc.hasKey(__dsh_cTID('UsrM'));
  } catch (e) {
    return false;
  }
}

/** Make a user mask on the active layer: 'revealSelection' (from selection) or 'revealAll'. */
function __dsh_makeLayerMaskAtChannel(maskMode) {
  var desc = new ActionDescriptor();
  var atRef = new ActionReference();
  desc.putClass(__dsh_sTID('new'), __dsh_sTID('channel'));
  atRef.putEnumerated(__dsh_sTID('channel'), __dsh_sTID('channel'), __dsh_sTID('mask'));
  desc.putReference(__dsh_sTID('at'), atRef);
  desc.putEnumerated(__dsh_sTID('using'), __dsh_sTID('userMaskEnabled'), __dsh_sTID(maskMode));
  executeAction(__dsh_sTID('make'), desc, DialogModes.NO);
}

/** Store the active selection into an alpha channel (version-tolerant store signature). */
function __dsh_storeSelection(doc, channel) {
  try { doc.selection.store(channel); return true; } catch (e1) {}
  try { doc.selection.store(channel, SelectionType.REPLACE); return true; } catch (e2) {}
  return false;
}

/** Load an alpha channel into the active selection (version-tolerant load signature). */
function __dsh_loadSelection(doc, channel) {
  try { doc.selection.load(channel); return true; } catch (e1) {}
  try { doc.selection.load(channel, SelectionType.REPLACE); return true; } catch (e2) {}
  return false;
}

/** Index of the active history state, or -1 when it cannot be read. */
function __dsh_historyIndex(doc) {
  try {
    var states = doc.historyStates;
    var active = doc.activeHistoryState;
    for (var i = 0; i < states.length; i++) {
      if (states[i] === active) return i;
    }
  } catch (e) {}
  return -1;
}
`

/**
 * Body: application name/version. Shape `{ name, version, running }`.
 *
 * @returns {string}
 */
export function appInfoScript() {
  return `
${PSX_HELPERS}

return {
  name: String(app.name),
  version: String(app.version),
  running: true
};
`
}

/**
 * Body: full Photoshop state snapshot used by the `ps_state` tool and the pipeline.
 *
 * Shape:
 * `{ ok, app:{name,version}, hasDocument, document:{id,name,width,height,resolution,colorMode,
 * path,saved,layerCount,hasSelection}, selection, activeLayer, layers:[{name,kind,visible}] }`
 * Selection/layer bounds include `left/top/right/bottom/width/height` in px.
 * When no document is open returns `{ ok:false, code:'no_document', message, hasDocument:false, ... }`.
 *
 * @param {{ layerLimit?: number }} [options]
 * @returns {string}
 */
export function stateScript({ layerLimit = 40 } = {}) {
  const limit = Number.isFinite(Number(layerLimit)) ? Math.max(0, Math.floor(Number(layerLimit))) : 40
  return `
${PSX_HELPERS}

var state = {
  ok: true,
  app: { name: String(app.name), version: String(app.version) },
  hasDocument: false,
  document: null,
  selection: null,
  activeLayer: null,
  layers: []
};

if (app.documents.length === 0) {
  state.ok = false;
  state.code = 'no_document';
  state.message = 'No active document in Photoshop';
  return state;
}

var doc = app.activeDocument;
state.hasDocument = true;

var selection = __dsh_selectionBounds();

var documentInfo = {
  id: doc.id,
  name: String(doc.name),
  width: doc.width.as('px'),
  height: doc.height.as('px'),
  resolution: doc.resolution,
  colorMode: String(doc.mode),
  path: null,
  saved: false,
  layerCount: 0,
  hasSelection: selection !== null
};
try { documentInfo.path = doc.path && doc.path.fsName ? String(doc.path.fsName) : null; } catch (ePath) {}
try { documentInfo.saved = !!doc.saved; } catch (eSaved) {}
try { documentInfo.layerCount = doc.layers.length; } catch (eCount) {}
state.document = documentInfo;
state.selection = selection
  ? {
      left: selection.left,
      top: selection.top,
      right: selection.right,
      bottom: selection.bottom,
      width: selection.width,
      height: selection.height
    }
  : null;

try {
  var layer = doc.activeLayer;
  if (layer) {
    var activeInfo = {
      name: String(layer.name),
      kind: __dsh_kindName(layer),
      opacity: layer.opacity,
      blendMode: String(layer.blendMode),
      visible: !!layer.visible,
      isBackground: false
    };
    try { activeInfo.isBackground = !!layer.isBackgroundLayer; } catch (eBg) {}
    var lb = __dsh_layerBounds(layer);
    if (lb) {
      activeInfo.bounds = {
        left: lb.left,
        top: lb.top,
        right: lb.right,
        bottom: lb.bottom,
        width: lb.width,
        height: lb.height
      };
    }
    state.activeLayer = activeInfo;
  }
} catch (eLayer) {
  state.activeLayer = null;
}

try {
  var count = Math.min(doc.layers.length, ${limit});
  for (var i = 0; i < count; i++) {
    var entry = { name: String(doc.layers[i].name), kind: __dsh_kindName(doc.layers[i]), visible: false };
    try { entry.visible = !!doc.layers[i].visible; } catch (eVis) {}
    state.layers.push(entry);
  }
} catch (eLayers) {}

return state;
`
}

/**
 * Body: export a flattened PNG of a region of the active document.
 *
 * Works on a duplicate (`doc.duplicate(name, true)` -> crop -> flatten -> saveAs PNG) and
 * always closes the duplicate with `SaveOptions.DONOTSAVECHANGES`, so the user's document
 * and its history are left untouched.
 *
 * Shape `{ ok:true, path, source, bounds:{left,top,right,bottom,width,height} }`.
 * Recoverable failures: `no_document`, `selection_required`, `empty_layer`, `export_failed`.
 *
 * @param {{ outPath: string, source?: 'selection'|'layer'|'document' }} options
 * @returns {string}
 */
export function captureScript({ outPath, source = 'document', maxDimension, expectedDocumentId } = {}) {
  if (typeof outPath !== 'string' || outPath.trim() === '') {
    throw new Error('captureScript requires a non-empty outPath')
  }
  const captureSource = CAPTURE_SOURCES.includes(source) ? source : 'document'
  const outLiteral = jsLiteral(outPath)
  const expectedId = Number(expectedDocumentId)
  const documentGuard = Number.isFinite(expectedId)
    ? `if (doc.id !== ${expectedId}) return { ok: false, code: 'document_changed', message: 'The active Photoshop document changed before preview capture' };`
    : ''
  const limit = Number(maxDimension)
  const resizeSnippet = Number.isFinite(limit) && limit > 0
    ? `
  var maxEdge = ${Math.min(8192, Math.max(64, Math.round(limit)))};
  var captureWidth = duplicate.width.as('px');
  var captureHeight = duplicate.height.as('px');
  var captureScale = Math.min(1, maxEdge / Math.max(captureWidth, captureHeight));
  if (captureScale < 1) {
    duplicate.resizeImage(
      new UnitValue(Math.max(1, Math.round(captureWidth * captureScale)), 'px'),
      new UnitValue(Math.max(1, Math.round(captureHeight * captureScale)), 'px'),
      null,
      ResampleMethod.BICUBIC
    );
  }
`
    : ''
  return `
${PSX_HELPERS}

if (app.documents.length === 0) {
  return { ok: false, code: 'no_document', message: 'No active document in Photoshop' };
}

var doc = app.activeDocument;
${documentGuard}
var source = '${captureSource}';
var docWidth = doc.width.as('px');
var docHeight = doc.height.as('px');
var region = null;

if (source === 'selection') {
  var selection = __dsh_selectionBounds();
  if (!selection) {
    return {
      ok: false,
      code: 'selection_required',
      message: 'A pixel selection is required to capture the selection region'
    };
  }
  region = selection;
} else if (source === 'layer') {
  var activeLayer = null;
  try { activeLayer = doc.activeLayer; } catch (eActive) {}
  var layerBounds = __dsh_layerBounds(activeLayer);
  if (!layerBounds || layerBounds.width < 1 || layerBounds.height < 1) {
    return {
      ok: false,
      code: 'empty_layer',
      message: 'The active layer has no visible pixels to capture'
    };
  }
  region = layerBounds;
} else {
  region = { left: 0, top: 0, right: docWidth, bottom: docHeight, width: docWidth, height: docHeight };
}

// Crop rectangles must be integral and inside the document.
var left = Math.max(0, Math.round(region.left));
var top = Math.max(0, Math.round(region.top));
var right = Math.min(Math.round(docWidth), Math.round(region.right));
var bottom = Math.min(Math.round(docHeight), Math.round(region.bottom));
if (right - left < 1) right = Math.min(Math.round(docWidth), left + 1);
if (bottom - top < 1) bottom = Math.min(Math.round(docHeight), top + 1);
if (right - left < 1 || bottom - top < 1) {
  return { ok: false, code: 'empty_region', message: 'The capture region has no area inside the document' };
}

var duplicate = null;
try {
  duplicate = doc.duplicate('__dsh_capture_' + (new Date()).getTime() + '__', true);
  if (duplicate.mode !== DocumentMode.RGB) {
    try { duplicate.changeMode(ChangeMode.RGB); } catch (eMode) {}
  }
  try {
    if (duplicate.bitsPerChannel !== BitsPerChannelType.EIGHT) {
      duplicate.bitsPerChannel = BitsPerChannelType.EIGHT;
    }
  } catch (eBits) {}
  duplicate.crop([
    new UnitValue(left, 'px'),
    new UnitValue(top, 'px'),
    new UnitValue(right, 'px'),
    new UnitValue(bottom, 'px')
  ]);
${resizeSnippet}
  duplicate.flatten();
  var outFile = new File(${outLiteral});
  var pngOptions = new PNGSaveOptions();
  pngOptions.compression = 6;
  pngOptions.interlaced = false;
  duplicate.saveAs(outFile, pngOptions, true, Extension.LOWERCASE);
} catch (eCapture) {
  return {
    ok: false,
    code: 'export_failed',
    message: 'Failed to export the PNG capture: ' + (eCapture.message || String(eCapture))
  };
} finally {
  if (duplicate) {
    try { duplicate.close(SaveOptions.DONOTSAVECHANGES); } catch (eClose) {}
  }
}

var writtenFile = new File(${outLiteral});
var writtenBytes = 0;
if (writtenFile.exists) {
  try {
    writtenFile.open('r');
    writtenBytes = writtenFile.length;
    writtenFile.close();
  } catch (eSize) {}
}
if (!writtenFile.exists || writtenBytes <= 0) {
  return {
    ok: false,
    code: 'export_failed',
    message: 'The PNG capture was not written to ' + ${outLiteral}
  };
}

return {
  ok: true,
  path: ${outLiteral},
  source: '${captureSource}',
  bounds: {
    left: left,
    top: top,
    right: right,
    bottom: bottom,
    width: right - left,
    height: bottom - top
  }
};
`
}

/**
 * Body: place a local image file as a smart-object layer in the active document.
 *
 * Uses the proven Action Manager `Plc ` place (centered), then reads the placed layer
 * bounds and transforms with `layer.resize(...)` + `layer.translate(...)` to honor the
 * requested fit and bounds:
 *  - cover:   uniform scale so the image covers the target rect, centered (default)
 *  - contain: uniform scale to fit inside the target rect, centered
 *  - stretch: independent x/y scale to exactly fill the target rect
 *  - center:  ignore `bounds`, fit/center inside the whole document
 *
 * When `maskSelection` is true and the document has a pixel selection, the selection is
 * stored in a temporary alpha channel, the placed layer is transformed, the channel is
 * loaded back and an AM user mask is created from it (`revealSelection`); the temporary
 * channel is removed afterwards. The selection itself is preserved.
 *
 * Shape `{ ok:true, layerName, bounds:{left,top,right,bottom,width,height}, maskCreated, fit }`.
 * Recoverable failures: `no_document`, `file_not_found`, `empty_region`, `place_failed`.
 *
 * @param {object} options
 * @param {string} options.filePath image file to place
 * @param {{left:number,top:number,width:number,height:number}|{left:number,top:number,right:number,bottom:number}|null} [options.bounds]
 * @param {'cover'|'stretch'|'contain'} [options.fit='cover']
 * @param {string} [options.name] layer name; defaults to the file basename
 * @param {boolean} [options.maskSelection=false]
 * @param {boolean} [options.center=false]
 * @returns {string}
 */
export function placeScript({
  filePath,
  bounds = null,
  fit = 'cover',
  name,
  maskSelection = false,
  center = false,
} = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('placeScript requires a non-empty filePath')
  }
  const fitMode = FIT_MODES.includes(fit) ? fit : 'cover'
  const target = normalizeBounds(bounds)
  const layerName = typeof name === 'string' && name.trim() !== '' ? name : ''
  const wantMask = maskSelection === true
  const wantCenter = center === true
  const targetLiteral = target
    ? `{ left: ${numLiteral(target.left)}, top: ${numLiteral(target.top)}, width: ${numLiteral(target.width)}, height: ${numLiteral(target.height)} }`
    : 'null'
  return `
${PSX_HELPERS}

if (app.documents.length === 0) {
  return { ok: false, code: 'no_document', message: 'No active document in Photoshop' };
}

var doc = app.activeDocument;
var imageFile = new File(${jsLiteral(filePath)});
if (!imageFile.exists) {
  return {
    ok: false,
    code: 'file_not_found',
    message: 'The image to place does not exist: ' + ${jsLiteral(filePath)}
  };
}

var maskSelection = ${wantMask ? 'true' : 'false'};
var center = ${wantCenter ? 'true' : 'false'};
var fit = '${fitMode}';
var requested = ${targetLiteral};
var docWidth = doc.width.as('px');
var docHeight = doc.height.as('px');

var hadSelection = __dsh_hasSelection();
var savedChannel = null;
var selectionStored = false;
if (maskSelection && hadSelection) {
  try {
    savedChannel = doc.channels.add();
    savedChannel.name = '__dsh_mask_' + (new Date()).getTime();
    try { savedChannel.kind = ChannelType.SELECTEDAREA; } catch (eChannelKind) {}
    selectionStored = __dsh_storeSelection(doc, savedChannel);
    if (!selectionStored) {
      try { savedChannel.remove(); } catch (eRemoveUnused) {}
      savedChannel = null;
    }
  } catch (eChannel) {
    savedChannel = null;
    selectionStored = false;
  }
  // Storing a selection makes the alpha channel the ACTIVE channel; while a channel
  // (instead of the composite RGB) is active, layer transforms such as resize() are
  // silently ignored by Photoshop. Restore the composite channels before placing.
  try { doc.activeChannels = doc.componentChannels; } catch (eRestoreChannels) {}
}

try {
  // 1. Place embedded as a smart object (Action Manager, same as File > Place Embedded).
  var placeDesc = new ActionDescriptor();
  placeDesc.putPath(__dsh_cTID('null'), imageFile);
  placeDesc.putEnumerated(__dsh_cTID('FTcs'), __dsh_cTID('QCSt'), __dsh_cTID('Qcsa'));
  var offsetDesc = new ActionDescriptor();
  offsetDesc.putUnitDouble(__dsh_cTID('Hrzn'), __dsh_cTID('#Pxl'), 0);
  offsetDesc.putUnitDouble(__dsh_cTID('Vrtc'), __dsh_cTID('#Pxl'), 0);
  placeDesc.putObject(__dsh_cTID('Ofst'), __dsh_cTID('Ofst'), offsetDesc);
  executeAction(__dsh_cTID('Plc '), placeDesc, DialogModes.NO);

  var layer = doc.activeLayer;
  if (!layer) throw new Error('Photoshop did not create a layer for the placed image');
  if (${layerName ? jsLiteral(layerName) : 'null'}) {
    try { layer.name = ${layerName ? jsLiteral(layerName) : 'null'}; } catch (eName) {}
  }

  // 2. Target rectangle in pixels.
  var targetRect = null;
  if (center || !requested) {
    targetRect = { left: 0, top: 0, width: docWidth, height: docHeight };
  } else {
    targetRect = requested;
  }
  if (!(targetRect.width > 0) || !(targetRect.height > 0)) {
    return { ok: false, code: 'empty_region', message: 'The requested target bounds have no area' };
  }

  // 3. Scale the placed layer to honor the fit mode.
  var placedBounds = __dsh_layerBounds(layer);
  if (!placedBounds || placedBounds.width <= 0 || placedBounds.height <= 0) {
    return {
      ok: false,
      code: 'place_failed',
      message: 'The placed image has empty bounds; the file may be unreadable or zero-sized'
    };
  }
  var scaleX = targetRect.width / placedBounds.width;
  var scaleY = targetRect.height / placedBounds.height;
  if (fit === 'stretch') {
    // independent x/y scale
  } else if (fit === 'contain') {
    var containScale = Math.min(scaleX, scaleY);
    scaleX = containScale;
    scaleY = containScale;
  } else {
    var coverScale = Math.max(scaleX, scaleY);
    scaleX = coverScale;
    scaleY = coverScale;
  }
  if (scaleX > 0 && scaleY > 0 && (Math.abs(scaleX - 1) > 0.0005 || Math.abs(scaleY - 1) > 0.0005)) {
    layer.resize(scaleX * 100, scaleY * 100, AnchorPosition.MIDDLECENTER);
  }

  // 4. Center the layer on the target rectangle.
  var scaledBounds = __dsh_layerBounds(layer);
  if (!scaledBounds) {
    return { ok: false, code: 'place_failed', message: 'The placed image lost its bounds after scaling' };
  }
  var deltaX = (targetRect.left + targetRect.width / 2) - (scaledBounds.left + scaledBounds.width / 2);
  var deltaY = (targetRect.top + targetRect.height / 2) - (scaledBounds.top + scaledBounds.height / 2);
  if (Math.abs(deltaX) > 0.01 || Math.abs(deltaY) > 0.01) {
    layer.translate(deltaX, deltaY);
  }

  var finalBounds = __dsh_layerBounds(layer) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

  // 5. Optional layer mask from the stored selection.
  var maskCreated = false;
  var maskError = '';
  if (maskSelection && selectionStored && savedChannel) {
    try {
      doc.activeLayer = layer;
      if (__dsh_loadSelection(doc, savedChannel)) {
        __dsh_makeLayerMaskAtChannel('revealSelection');
        maskCreated = __dsh_hasLayerMaskAM();
        if (!maskCreated) maskError = 'Photoshop did not report a user mask after the make action';
      } else {
        maskError = 'Could not restore the stored selection';
      }
    } catch (eMask) {
      maskError = String(eMask && eMask.message ? eMask.message : eMask);
    }
    // Creating a mask from a selection consumes the selection; load it back so the
    // user's selection survives the operation (repeat fills can reuse it).
    try {
      doc.activeLayer = layer;
      __dsh_loadSelection(doc, savedChannel);
    } catch (eSelectionRestore) {}
    try { doc.activeChannels = doc.componentChannels; } catch (eChannels) { try { doc.activeLayer = layer; } catch (eLayer) {} }
  }

  var result = {
    ok: true,
    layerName: String(layer.name),
    bounds: {
      left: finalBounds.left,
      top: finalBounds.top,
      right: finalBounds.right,
      bottom: finalBounds.bottom,
      width: finalBounds.width,
      height: finalBounds.height
    },
    maskCreated: maskCreated,
    fit: fit
  };
  if (!maskCreated && maskError) result.maskError = maskError;
  return result;
} finally {
  if (savedChannel) {
    try { savedChannel.remove(); } catch (eRemove) {}
  }
}
`
}

/**
 * Body: step back `steps` entries in the active document history.
 *
 * Shape `{ ok:true, undone:<steps>, steps, historyCount, currentHistoryState }` where
 * `undone` is the number of history steps actually traversed (the pipeline renders it as
 * "已撤销 N 步"). Recoverable failures: `no_document`, `history_unavailable`, `nothing_to_undo`.
 *
 * @param {{ steps?: number }} [options]
 * @returns {string}
 */
export function undoScript({ steps = 1 } = {}) {
  const requested = Number.isFinite(Number(steps)) ? Math.max(1, Math.floor(Number(steps))) : 1
  return `
${PSX_HELPERS}

if (app.documents.length === 0) {
  return { ok: false, code: 'no_document', message: 'No active document in Photoshop' };
}

var doc = app.activeDocument;
var currentIndex = __dsh_historyIndex(doc);
if (currentIndex < 0) {
  return {
    ok: false,
    code: 'history_unavailable',
    message: 'Could not read the active history state of "' + doc.name + '"'
  };
}

var targetIndex = currentIndex - ${requested};
if (targetIndex < 0) targetIndex = 0;
var undoneSteps = currentIndex - targetIndex;
if (undoneSteps <= 0) {
  return {
    ok: false,
    code: 'nothing_to_undo',
    message: 'Nothing to undo: "' + doc.name + '" is already at its earliest history state'
  };
}

doc.activeHistoryState = doc.historyStates[targetIndex];

return {
  ok: true,
  undone: undoneSteps,
  steps: undoneSteps,
  historyCount: doc.historyStates.length,
  currentHistoryState: String(doc.activeHistoryState.name)
};
`
}
