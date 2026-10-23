# CONTRACT — dsh-photoshop-genfill (shared team contract)

All paths below are relative to the workspace root:

`the plugin workspace`

Plugin directory: `plugins/dsh-photoshop-genfill/`

## Product

A DeepSeek Harness profile plugin bundle (`@local/dsh-photoshop-genfill`) that:

1. connects the official `@alisaitteke/photoshop-mcp` MCP server (stdio) so the agent gets all
   `mcp__photoshop__*` tools;
2. adds Host tools + slash commands that run a **generative-fill / generate-layer / image-edit**
   pipeline: capture pixels from Photoshop → call an OpenAI-compatible image API
   (`/v1/images/generations`, `/v1/images/edits`, model `gpt-image-2` by default) → place the
   result back into Photoshop as a layer (masked by the selection);
3. adds a compact Client panel in the Web GUI composer dock that triggers the commands.

Runtime facts (verified):

- macOS 27, Adobe Photoshop 2026 (`/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app`),
  AppleScript automation of Photoshop works from this host
  (`osascript -e 'tell application "Adobe Photoshop 2026" to version'` → `27.2.0`).
- ExtendScript runs through AppleScript `do javascript "$.evalFile(path)"`; a `.jsx` file must be
  written as UTF-8 with a leading BOM (`\uFEFF`).
- The reference implementation (MIT) is unpacked at `/tmp/psmcp/package`:
  - `dist/api/photoshop-api.js` → `wrapInErrorHandling()`: the wrapper every JSX body must use
    (preferences to px/pt, `displayDialogs = NO`, dialog suppression, IIFE, `toSource()` result,
    `'ERROR: '` prefix on failure).
  - `dist/api/extendscript.js` → proven snippets (`placeImage`, `createLayerMask`,
    `MCP_LAYER_MASK_HELPERS`, `selectionHelpers`, `getContextInfo`, `exportPreview`, `undo`).
  - `dist/platform/macos-executor.js` → AppleScript wrapper + temp-file pattern.
- Extracted DSH implementation for API reference: `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai/`
  (READMEs + built JS). Read the relevant README before guessing a framework API.
- DSH profile: `~/.dsh/profiles/desktop`. Only the Team Lead installs bundles / edits the profile.

## Hard rules

- ES modules, Node 22 builtins only (`node:*`). **No npm dependencies**, no imports of
  `@deepseek-ai/*` (plugin must load from the profile without extra packages).
- Do not install the bundle, do not write the profile, do not restart the Harness.
- Do not modify or close documents/drafts the user has open in Photoshop. Create your own test
  document(s), close them with `SaveOptions.DONOTSAVECHANGES`, and leave Photoshop as you found it.
- Every temporary file/dir you create gets a unique name under `os.tmpdir()` or `tests/tmp/` and is
  cleaned up. Bounded execution everywhere.
- Only write the files in your assigned scope. Never rewrite another member's file.
- Report write results and blockers to the Lead with `send_message`; write a short report under
  `reports/` when you finish (`reports/<area>.md`).

## Module contracts

### `lib/ps-bridge.js` (owner: ps-bridge-dev)

```js
export function createPsBridge(options = {}) // sync constructor
// options: { appName='Adobe Photoshop 2026', appPath?, timeoutMs=60000, launchIfNeeded=true, logger? }
```

Returns `PsBridge`:

```js
interface PsBridge {
  // Execute one ExtendScript BODY inside the reference error wrapper.
  // `body` is the *inside* of `function(){ ... }`; it must `return` a plain object.
  // Resolves with the parsed object/array/scalar; rejects with Error(message) on Photoshop error.
  run(body: string, opts?: { timeoutMs?: number }): Promise<any>
  // Same with the long default timeout (default 180000).
  runLong(body: string): Promise<any>
  // Is the target Photoshop process currently running (pgrep-style check).
  isRunning(): Promise<boolean>
  // The resolved target (detected from /Applications or options).
  target(): { appName: string, appPath?: string }
  dispose(): Promise<void>
}
```

Behavior:

- Serializes all executions through one FIFO queue (Photoshop scripting is not concurrent-safe).
- Writes `<tmp>/dsh-ps-<rand>.jsx` (UTF-8 with BOM) and `<tmp>/dsh-ps-<rand>.scpt`, runs
  `/usr/bin/osascript <scpt>` with `execFile`, kills it (SIGKILL) after
  `timeoutMs + appleScriptTimeoutMargin + grace`, deletes both temp files in `finally`.
- AppleScript skeleton (same semantics as the reference):
  ```
  tell application "<appName>"            (or `tell application file "<bundle>"` when appPath known)
      set jsxFile to POSIX file "<jsxPath>"
      with timeout of <ceil(timeoutMs/1000)+5> seconds
          do javascript "$.evalFile(decodeURI('<encodeURI(jsxPath)>'))"
      end timeout
  end tell
  ```
- stdout is the `toSource()` string of the returned value: parse with `JSON.parse`, else
  `new Function('return ' + text)()`, else return trimmed string. Output starting with `ERROR:`
  becomes a rejected Error (strip prefix).
- Wrap `body` exactly like the reference wrapper (save/restore `app.preferences.rulerUnits`,
  `typeUnits`, `app.displayDialogs`, suppress `alert`/`confirm`/`prompt`, `try/catch → 'ERROR: '+msg`,
  finally restore). Do not return `undefined`; always `toSource` objects.
- Error messages must be actionable (Photoshop not running / AppleScript -10814 / "not allowed to
  send Apple events" / script syntax line / `ERROR:` message).

### `lib/ps-scripts.js` (owner: ps-bridge-dev)

Pure functions returning ExtendScript **body** strings for the wrapper above. Use
`JSON.stringify(value)` in Node to embed strings. Required exports:

```js
export function appInfoScript()                       // { name, version, running }
export function stateScript({ layerLimit = 40 })      // see shape below
export function captureScript({ outPath, source })    // source: 'selection' | 'layer' | 'document'
export function placeScript({ filePath, bounds, fit, name, maskSelection, center })
export function undoScript({ steps = 1 })
```

Shapes (JSON-serializable, all px numbers):

```js
// stateScript()
{
  ok: true,
  app: { name, version },
  hasDocument: true,
  document: { id, name, width, height, resolution, colorMode, path, saved,
              layerCount, hasSelection },
  selection: null | { left, top, right, bottom, width, height },
  activeLayer: { name, kind, opacity, blendMode, visible, isBackground, bounds? },
  layers: [{ name, kind, visible }],   // top…bottom
}
// captureScript(): export a flattened PNG of the region to outPath, then close the temp doc
{ ok: true, path, source, bounds: { left, top, width, height } }
//   source 'selection': region = selection bounds (error code 'selection_required' when none)
//   source 'layer':     region = active layer bounds (error 'empty_layer' when empty)
//   source 'document':  region = full document
// placeScript(): place a file as a smart-object layer in the ACTIVE document
{ ok: true, layerName, bounds: { left, top, width, height }, maskCreated: true|false, fit }
//   fit 'cover': scale uniformly to cover bounds, centered on bounds (default for fill)
//   fit 'stretch': scale x/y independently to exactly fill bounds
//   fit 'contain': scale uniformly to fit inside bounds, centered
//   center: when true ignore bounds and center/fit inside the full document
//   maskSelection: when true and the target doc has a pixel selection, create a layer mask
//   from that selection (AM helper) so only the selection shows; when false no mask.
// undoScript(): { ok, undone, historyCount }  // one or more history steps back
```

Implementation notes:

- Selection handling: capture `doc.selection.store()` into a temporary channel at the start of
  `placeScript` when `maskSelection` is requested and a selection exists, then
  `doc.selection.load(channel, SelectionType.REPLACE)` before creating the mask; remove the temp
  channel afterwards. Test with rectangle and freeform selections.
- `captureScript` must use `doc.duplicate(name, true)` then `crop(...)` then `saveAs(PNG)`, and always
  close the duplicate (also on error).
- `placeScript` must use the Action Manager `Plc ` place (smart object) like the reference
  `placeImage` snippet, then `layer.resize(...)` + `layer.translate(...)` using `layer.bounds`.
  Support Backdrop/empty documents (`hasDocument` false → error `no_document`).
- Every script returns `{ok:false, code, message}` instead of throwing when the condition is
  recoverable (no document, no selection); use `throw new Error(...)` for unexpected failures.
- No non-ASCII source in the JSX body unless necessary; always embed user text via
  `JSON.stringify` from Node.

Tests (owner: ps-bridge-dev): `tests/ps-bridge.test.mjs` run with
`node`. It must:

1. create a new test document (e.g. 800×600 white) in Photoshop, add a colored shape/text,
   `captureScript` to PNG and assert the PNG exists/decodes (check PNG signature + IHDR size);
2. make an elliptical/rectangular selection, run `placeScript` with a generated test PNG
   (create one with `sips` or a tiny script), assert layer exists, bounds ≈ requested, mask created;
3. verify `stateScript` reports document/selection;
4. verify `undoScript` removes the placed layer;
5. close the test document `DONOTSAVECHANGES`; assert no extra documents remain relative to start.

### `lib/image-api.js` (owner: image-api-dev)

```js
export function createImageApi({ baseUrl, apiKey, model, timeoutMs = 180000, outputDir })
// returns { generate, edit, config, probe }
```

```js
generate({ prompt, size?, n?, outDir? }) -> { images: [{ path, bytes, mimeType }], durationMs, raw? }
edit({ prompt, imagePath, maskPath?, size?, n?, outDir? }) -> same
probe() -> { ok, status?, detail }            // cheap /v1/models or generation-free connectivity check
config() -> { baseUrl, model, hasKey }
```

Requirements:

- `baseUrl` default `https://chatgpt2api.343426.xyz/v1`; endpoints `${baseUrl}/images/generations`
  (JSON: `{model, prompt, n}`) and `${baseUrl}/images/edits` (multipart: `model`, `prompt`,
  `image` file part, optional `mask`, optional `size`, `n`) — exactly the calls in the task brief.
- Auth header `Authorization: Bearer <apiKey>`; if `apiKey` empty, throw a clear
  `ImageApiError('auth', '未配置 API Key…')` before any request.
- Node 22 global `fetch`/`FormData`/`Blob`, no deps. Bound each request with AbortSignal.timeout.
- Parse tolerant response shapes: `{ data: [{ b64_json } | { url }] }`, `{ data: [ ... ] }` with
  nested `b64_json`/`url`, top-level `{ url }`, `{ images: [...] }`, `{ output: [...] }`.
  Download `url` values when the host returns a URL; write bytes to `outDir` with a unique name.
- Errors: `class ImageApiError extends Error { code, status, detail }` with codes
  `auth | http | network | timeout | shape | empty`; message must include HTTP status and the
  server's `error.message` when present (the endpoint returns `{"error":{"message":"密钥无效或已失效…"}}`).
- Test file `tests/image-api.test.mjs`: (a) malformed key → expects `code === 'auth'` and a readable
  message; (b) network error (unreachable port) → `network`/`timeout`; (c) response parsing for all
  supported shapes using a local `node:http` stub server; (d) when the Lead provides the real key via
  `PS_IMAGE_API_KEY`, one real generation + one real edit, saving PNGs and asserting PNG signature.
  Never hard-code keys in files.

### `client.js` (owner: ui-dev)

Static Client module loaded by DSH's module loader; single file, no bundler:

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-photoshop-genfill',
  factory(require) {
    const React = require('react')
    // ... component ...
    return { inject: ['slots', 'locale', 'remote.commands'], apply(ctx) { ... } }
  },
})
```

- Register in `conversation.composer.dock` with `ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'ps-genfill', order: 6 }, Panel))`.
- Props include `sessionId` (session scope). Get `slots`/`locale`/`remote.commands` services through
  `ctx.get('...')` in `apply`.
- UI: one compact ambient row (about 28–36 px) below the composer:
  `[●] PS 生成式填充  [模式 ▾] [输入提示词…            ] [生成]` + a one-line status/result area that
  only appears when busy or after an action. Modes:
  `fill` → command `psfill`, `gen` → `psgen`, `edit` → `psedit`; plus two icon buttons for
  `psstatus` (状态) and `psundo` (撤销).
- Submitting runs
  `const remote = ctx.get('remote.commands'); const res = await remote.execute(sessionId, '/' + name + ' ' + text, [])`.
  `res.ok === true` → `res.value.result.kind === 'success'` → show `res.value.result.text`;
  otherwise show the error text; `res.ok === false` → show `res.error.message` (fold carrier errors).
  While awaiting, disable controls and show a spinner text. Empty prompt: only allowed for
  status/undo commands.
- Styling: theme tokens only (`--dsw-alias-*`), copied host patterns; render a component-local
  `<style>` element; no imports besides `react`. Light and dark both must read correctly; long text
  ellipsized; `aria-label`s on icon buttons; keyboard Enter submits, Esc closes result.
- Localization via `ctx.locale` service: `register` a namespace (e.g. `ps-genfill`) for `en` and `zh`
  and bind it in the component. Every visible string goes through it; Chinese is the primary locale.
  Also ship `locale/en.json` and `locale/zh.json` with `meta.title` / `meta.description` for the
  plugin inventory (do not touch the `coris.patch.yml`/`locale` files owned by the Lead except these
  two new locale files).
- `icon.svg`: original artwork (no Adobe/Photoshop trademark), blue/violet rounded square with a
  layer stack + sparkle, valid SVG ≤ 256 KiB.

## Integration shape (Lead)

Host `index.js` implements:

- `export const inject = ['tools', 'commands', 'attachments', 'systemPrompt']`; `export function apply(ctx, config)`;
- `export const Config` — standard-schema object (`~standard.validate`) filling defaults:
  `apiBaseUrl`, `apiKey`, `model`, `photoshopApp`, `outputDir`, `requestTimeoutMs`, `defaultFit`;
- tools: `ps_preview`, `ps_generative_fill`, `ps_generate_layer`, `ps_image_edit`, `ps_state`, `ps_undo`;
- the `photoshop:retouch-workflow` system prompt section requires image-first inspection, native non-destructive editing, post-edit preview, and bounded undo/retry;
- `ps_preview` captures a document-pinned, 1024px-long-edge PNG; mutating tools attach a fresh preview as a durable Harness image attachment;
- commands: `psfill`, `psgen`, `psedit`, `psstatus`, `psundo`;
- `lib/pipeline.js` orchestrates `ps-bridge` + `ps-scripts` + `image-api` and returns
  `{ ok, action, layerName, outputPath, region, api, durationMs, message, preview }` for visual operations.

Commands return `{ kind: 'success' | 'error', text }`; tools return a JSON-serializable object and a
short rendered summary.

## File ownership

| Area | Files | Owner |
|---|---|---|
| bundle scaffold, patch, locales(meta), icon decision | `package.json`, `cordis.patch.yml`, `locale/en.json`, `locale/zh.json` | Lead |
| PS bridge + JSX snippets | `lib/ps-bridge.js`, `lib/ps-scripts.js`, `tests/ps-bridge.test.mjs`, `tests/fixtures/*` | ps-bridge-dev |
| image API client | `lib/image-api.js`, `tests/image-api.test.mjs` | image-api-dev |
| Web panel | `client.js`, `icon.svg` | ui-dev |
| pipeline + tools/commands + docs + install/verify | `index.js`, `lib/pipeline.js`, `README.md`, `reports/lead-*.md` | Lead |
