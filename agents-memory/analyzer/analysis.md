# PDF Renderer Replacement — Analyzer Agent Output

**Date**: 2026-05-26
**Gogs version**: 0.13.2
**Vulnerable plugin**: `public/plugins/pdfjs-1.4.20/`
**Replacement target**: `public/plugins/custom-pdf-render/`

---

## Executive Summary

Gogs embeds PDF.js 1.4.20 as a static plugin and renders PDFs inside an `<iframe>` pointing to `viewer.html?file=<raw-url>`. The integration surface is minimal: one URL query parameter (`file=`), same-origin fetch of raw PDF bytes, and a full-page viewer UI. The replacement needs to:

1. Accept a `?file=` query parameter containing a same-origin raw PDF URL.
2. Fetch the PDF bytes via `XMLHttpRequest` or `fetch` (same-origin, no CORS required).
3. Parse the PDF binary using pure JavaScript — no external libraries.
4. Render each page to a `<canvas>` element.
5. Provide basic navigation (previous/next page, page number input, zoom).
6. Never execute JavaScript found inside the PDF document.
7. Degrade gracefully on malformed input without crashing.

The entire implementation must live in `public/plugins/custom-pdf-render/` as static files. No server changes are required. The only Gogs source change needed is a single string substitution in `templates/repo/view_file.tmpl` (line 84): `pdfjs-1.4.20` -> `custom-pdf-render`.

---

## 1. Feature Mapping

### 1.1 Integration Surface: How Gogs Calls the Viewer

**Route registration** (`internal/cmd/web.go:610-611`):
```
m.Get("/src/*", repo.Home)
m.Get("/raw/*", repo.SingleDownload)
```

**PDF detection** (`internal/route/repo/view.go:203-204`):
```go
case tool.IsPDFFile(p):
    c.Data["IsPDFFile"] = true
```
`IsPDFFile` uses `http.DetectContentType` which checks the `%PDF` magic bytes at offset 0.

**Template embedding** (`templates/repo/view_file.tmpl:84`):
```html
<iframe width="100%" height="600px"
  src="{{AppSubURL}}/plugins/pdfjs-1.4.20/web/viewer.html?file={{EscapePound $.RawFileLink}}">
</iframe>
```

The `?file=` value is the raw path, e.g. `/username/repo/raw/main/document.pdf`.
`EscapePound` encodes `%`, `#`, ` `, `?` -- the URL is NOT HTML-entity-encoded, just percent-encoded for special path characters.

**AppSubURL** is `conf.Server.Subpath` -- empty string by default, may be a path prefix like `/gogs`.

### 1.2 Raw PDF Endpoint (`/raw/*` -> `repo.SingleDownload`)

Served by `internal/route/repo/download.go:serveData`:
- PDFs are NOT text, NOT images -> headers set:
  - `Content-Disposition: attachment; filename="<name>"`
  - `Content-Transfer-Encoding: binary`
  - No explicit `Content-Type` -> Go's `http.ResponseWriter` auto-sniffs -> will be `application/pdf` for `%PDF` bytes
- `Last-Modified` set from git commit timestamp
- No CORS headers are set on the raw endpoint by default (only set if `conf.HTTP.AccessControlAllowOrigin` is configured)
- **Implication**: The viewer must be served from the same origin as the raw endpoint. This is guaranteed since both are served by the same Gogs process from the `public/` static tree.

### 1.3 Static File Serving

`public/` is embedded into the Go binary via `//go:embed assets/* css/* img/* js/* plugins/*` (`public/embed.go`). Adding a new directory under `public/plugins/custom-pdf-render/` will automatically be included in the embed. When `LoadAssetsFromDisk` is true (dev mode), files are served from disk.

### 1.4 URL Validation in PDF.js (reference)

PDF.js 1.4.20 validates the `file=` param with `validateFileURL()`: it checks that the file's origin matches `window.location.href`'s origin. Our replacement must do the same same-origin check to prevent cross-origin fetch attempts.

### 1.5 Features Visible to Users in PDF.js Viewer

From analysis of `viewer.html` (422 lines) and `viewer.js` (7953 lines) outline:

| Feature | HTML Element IDs | Priority |
|---|---|---|
| Page canvas rendering | `#viewer .pdfViewer` | Must-have |
| Previous/Next page navigation | `#previous`, `#next` | Must-have |
| Page number input + total count | `#pageNumber`, `#numPages` | Must-have |
| Zoom in/out buttons | `#zoomIn`, `#zoomOut` | Must-have |
| Zoom presets (fit, width, %) | `#scaleSelect` | Nice-to-have |
| Download button | `#download`, `#secondaryDownload` | Nice-to-have |
| Loading indicator | `#loadingBar` | Nice-to-have |
| Error display | `#errorWrapper`, `#errorMessage` | Must-have |
| Find in document | `#findbar`, `#findInput` | Nice-to-have |
| Thumbnails sidebar | `#viewThumbnail`, `#thumbnailView` | Nice-to-have |
| Document outline sidebar | `#viewOutline`, `#outlineView` | Nice-to-have |
| Attachments sidebar | `#viewAttachments` | Skip |
| Presentation mode | `#presentationMode` | Skip |
| Open local file | `#openFile`, `#fileInput` | Skip |
| Print | `#print` | Skip |
| Rotation | `#pageRotateCw`, `#pageRotateCcw` | Nice-to-have |
| Hand tool | `#toggleHandTool` | Skip |
| Document properties overlay | `#documentPropertiesOverlay` | Skip |
| Password prompt overlay | `#passwordOverlay` | Skip |
| Bookmark (current view URL) | `#viewBookmark` | Skip |

### 1.6 CVE-2024-4367 Attack Vector

The vulnerability is in PDF.js's font evaluation: `pdf.worker.js` compiled Type3 font glyph programs using `new Function(...)` or `eval()` with unsanitized font name/matrix data. The bespoke implementation must NEVER use `eval()` or `new Function()` with any data derived from PDF content.

---

## 2. Functional Requirements

### 2.1 Must-Have

**F1 - URL Interface**: Accept `?file=<url>` query parameter. Validate it is same-origin before fetching. Render an error if the file parameter is missing or cross-origin.

**F2 - PDF Fetch**: Fetch the raw PDF bytes from the given URL using `XMLHttpRequest` or `fetch` (ArrayBuffer). Handle HTTP errors (4xx, 5xx) with an error message.

**F3 - PDF Header Validation**: Verify the response starts with `%PDF-` magic bytes. Reject non-PDF data with a clear error message.

**F4 - Basic PDF Parsing**: Parse enough of the PDF structure to extract page count and page content streams:
- Cross-reference table (`xref`/`startxref`)
- Trailer dictionary (`/Root`, `/Info` references)
- Page tree (`/Type /Catalog` -> `/Pages` -> page objects)
- Page content streams with basic graphics operators
- Basic font dictionaries for text positioning

**F5 - Canvas Rendering**: Render each page to an HTML5 `<canvas>` element at a reasonable default scale. Support text operators, basic path drawing, and raster images.

**F6 - Page Navigation**: Implement previous/next page buttons and a direct page number input field. Display total page count.

**F7 - Error Handling**: Display a visible error message if the PDF cannot be fetched, parsed, or rendered. Must NOT crash the browser tab on malformed input.

**F8 - Security: No JS Execution**: Never execute JavaScript actions found in the PDF (OpenAction, AA, JavaScript actions, URI actions with javascript: scheme). Ignore all PDF action types that could trigger code execution.

**F9 - Security: No eval/Function**: Never use `eval()`, `new Function()`, or `setTimeout`/`setInterval` with string arguments anywhere in the implementation.

**F10 - Security: Input Bounds Checking**: All array index operations on PDF-derived data must have bounds checks. All loops over PDF objects must have iteration limits to prevent infinite loops from malformed/cyclic structures.

### 2.2 Nice-to-Have

**N1 - Zoom Controls**: Zoom in/out buttons with configurable scale levels (50%, 75%, 100%, 125%, 150%, 200%). Fit-to-page and fit-to-width modes.

**N2 - Loading Indicator**: Show a progress bar or spinner while the PDF is being fetched and rendered.

**N3 - Download Link**: A button that opens the raw PDF URL for download.

**N4 - Text Layer**: Render a transparent text overlay on top of the canvas for copy-paste functionality.

**N5 - Image Support**: Decode and render inline and referenced raster images embedded in the PDF.

**N6 - Basic Outline/TOC**: Parse and display the document outline in a sidebar if present.

**N7 - Rotation**: Honour page `/Rotate` attribute and expose rotation buttons.

### 2.3 Security Requirements

**S1 - JavaScript Isolation**: The viewer must not execute any PDF-embedded JavaScript.

**S2 - No External Network Requests**: The viewer must not load any resource from outside the Gogs instance (no CDN scripts, no external fonts, no external images).

**S3 - XSS Prevention**: All text extracted from the PDF must be HTML-escaped before DOM insertion. Never use `innerHTML` with unsanitized PDF-derived strings; use `textContent` or `createElement`.

**S4 - Origin Validation**: Validate that the `file=` URL is same-origin before making a request. Reject `javascript:`, `data:`, and cross-origin URLs.

**S5 - Resource Limits**: Implement limits on maximum pages (500), xref objects (1,000,000), object resolution depth (10), stream decompression output (50 MB).

**S6 - Malformed Input Tolerance**: Wrap all PDF parsing in try/catch. Never let a parse error propagate to an unhandled exception.

---

## 3. PDF Spec Scope

### 3.1 Minimum Viable - Text-Only PDF (text-only.pdf)

Required PDF spec features:
- `%PDF-x.y` header validation
- `startxref` + `xref` table parsing (traditional table and cross-reference streams for PDF 1.5+)
- Object reference resolution (`R` indirect references, `obj`/`endobj` pairs)
- Trailer dictionary parsing (`/Root`, `/Size`)
- Catalog -> Pages tree -> Page objects (`/MediaBox`, `/Contents`, `/Resources`)
- Content stream parsing: `BT`/`ET` text blocks, `Tf`/`Tj`/`TJ`/`Td`/`Tm`/`TD`/`T*` operators
- Font resource dictionary: basic `/Type1` and `/TrueType` font handling for positioning
- FlateDecode (zlib/deflate) stream decompression for compressed content streams
- Canvas 2D API: `fillText`, transform matrix operations

### 3.2 Extended - Images and Mixed Content (images.pdf, mixed.pdf)

Additional features:
- `XObject` resource handling -- `/Image` XObjects via `Do` operator
- Inline image decoding: JPEG (`DCTDecode`), PNG/deflate (`FlateDecode`), raw
- Color spaces: `DeviceRGB`, `DeviceGray`, `DeviceCMYK` (basic)
- Path drawing operators: `m`, `l`, `c`, `h`, `f`, `S`, `s`, `B`, `n` for basic vector graphics
- Graphics state: `q`/`Q` save/restore, `cm` (CTM concatenation), `w` (line width), `RG`/`rg` (stroke/fill color)

### 3.3 Links (links.pdf)

- Parse `/Annots` array on each page
- Identify `/Subtype /Link` annotations with `/URI` actions
- Render as clickable overlays using `<a>` tags with `target="_blank" rel="noopener noreferrer"`
- Block auto-follow: only user-initiated clicks are permitted
- Block `javascript:` URI scheme in link annotations

### 3.4 Security Gate - Malicious PDF (poc.pdf)

The PoC PDF for CVE-2024-4367 exploits font name evaluation. Required defenses:
- Never pass font name/matrix data to `eval()` or `new Function()`
- Ignore `/JavaScript` action type entirely
- Ignore `/OpenAction`, `/AA` at catalog and page level
- Strip all `/Action` dicts with `/S /JavaScript`, `/S /Launch`, `/S /SubmitForm`, `/S /ImportData`
- For `/S /URI` actions: only allow `http://` and `https://` schemes, opened via user interaction only

### 3.5 Malformed Input (malformed.pdf)

Robustness requirements:
- Handle truncated files (unexpected EOF during parsing)
- Handle invalid object numbers, missing `endobj` markers
- Handle circular object references (via a seen-set with depth limit)
- Handle invalid stream lengths (clamp to available bytes)
- Handle unknown/missing filter names (skip stream, show placeholder)
- Per-page try/catch: if one page fails, show error placeholder but continue with remaining pages

---

## 4. Implementation Phase Plan

### Phase 1 - Core Infrastructure: PDF Binary Parser

**Goal**: Implement the pure-JS PDF byte-level parser that can locate and dereference all objects in a PDF, including cross-reference handling and stream decompression.

**Input**: No prior phase. Read this analysis document.

**Components to implement** (in `public/plugins/custom-pdf-render/`):
- `src/pdf-parser.js` -- Main parser module:
  - `PDFParser` class
  - `parseHeader(bytes)` -- validate `%PDF-` magic, extract version
  - `findStartxref(bytes)` -- scan backwards for `startxref`
  - `parseXrefTable(bytes, offset)` -- parse traditional xref table
  - `parseXrefStream(bytes, offset)` -- parse cross-reference stream (PDF 1.5+)
  - `parseTrailer(bytes, offset)` -- parse trailer dictionary
  - `resolveObject(objNum, genNum)` -- indirect object resolution with cycle detection
  - `parsePDFObject(bytes, offset)` -- parse any PDF object (dict, array, name, string, integer, real, boolean, null, stream, indirect reference)
  - `decodeStream(stream, filters)` -- decompress stream data (FlateDecode via DecompressionStream)
  - `getPageTree(catalog)` -- walk Pages tree, return flat array of page objects
- `src/pdf-security.js` -- Security filter:
  - `sanitizeObject(obj)` -- recursively remove dangerous action types
  - `isAllowedAction(actionDict)` -- whitelist safe action subtypes
  - `validateURL(url)` -- origin check + scheme whitelist

**Tests to pass before handoff**:
- [ ] Load and parse `text-only.pdf`, `mixed.pdf`, `images.pdf` without throwing
- [ ] Correctly extract page count from all test PDFs
- [ ] Load `malformed.pdf` without crashing (errors caught and returned as Error objects)
- [ ] Load `poc.pdf` -- confirm no JavaScript action objects survive `sanitizeObject()`

**Handoff**: `agents-memory/handoffs/phase1-parser.md`

---

### Phase 2 - Canvas Rendering Engine

**Goal**: Implement the page rendering pipeline that interprets PDF content stream operators and draws to an HTML5 canvas.

**Input**: Read `agents-memory/handoffs/phase1-parser.md`.

**Components to implement**:
- `src/pdf-renderer.js` -- Page renderer:
  - `PDFRenderer` class
  - `renderPage(canvas, pageObj, scale)` -- entry point
  - Graphics state machine: push/pop (`q`/`Q`), CTM (`cm`), colors, line width
  - Text operators: `BT`, `ET`, `Tf`, `Tj`, `TJ`, `Td`, `TD`, `Tm`, `T*`, `Tr`
  - Path operators: `m`, `l`, `c`, `v`, `y`, `h`, `re`; painting: `f`, `F`, `f*`, `S`, `s`, `B`, `B*`, `b`, `b*`, `n`
  - Image XObjects: `Do` operator for inline images and referenced images
  - Color operators: `RG`, `rg`, `K`, `k`, `G`, `g`
  - Clipping: `W`, `W*`
  - Canvas matrix math: build transform from PDF user space to canvas pixel space
- `src/pdf-fonts.js` -- Font metric table:
  - `getCharWidth(fontName, charCode)` -- approximate character advance widths using built-in metrics for the 14 standard PDF fonts
  - `measureText(font, size, text)` -- estimate text bounds for positioning
  - No font file loading -- use canvas 2D `measureText` as fallback for non-standard fonts
- `src/pdf-images.js` -- Image decode helper:
  - `decodeJPEG(bytes)` -- create `Image` object from JPEG bytes via Blob URL
  - `decodeRaw(bytes, width, height, colorSpace, bitsPerComponent)` -- build ImageData from raw bytes

**Tests to pass before handoff**:
- [ ] `text-only.pdf` renders visible text on canvas at correct approximate positions
- [ ] `images.pdf` renders at least one raster image visibly on canvas
- [ ] `mixed.pdf` renders combination of text and images
- [ ] `poc.pdf` renders without executing any JavaScript
- [ ] `malformed.pdf` either renders partial content or shows per-page error placeholder

**Handoff**: `agents-memory/handoffs/phase2-renderer.md`

---

### Phase 3 - Viewer UI Shell

**Goal**: Build the `viewer.html` entry point with navigation controls, zoom, loading state, error display, and link annotation overlay.

**Input**: Read `agents-memory/handoffs/phase2-renderer.md`.

**Components to implement**:
- `web/viewer.html` -- Entry point HTML:
  - Minimal, self-contained HTML with no external dependencies
  - `?file=` parameter parsed from `window.location.search`
  - Same-origin URL validation before fetch
  - Loading state -> render pipeline -> navigation controls
- `web/viewer.css` -- Viewer styles:
  - Full-height layout matching 600px iframe context
  - Toolbar with navigation controls
  - Canvas container with scroll for multi-page
  - Error message area
  - Loading spinner/progress bar
- `web/viewer.js` (or inline in HTML) -- Orchestration:
  - `init()` -- parse `?file=`, validate URL, begin fetch
  - `onPDFLoaded(arrayBuffer)` -- instantiate `PDFParser`, build page list, render page 1
  - `goToPage(n)` -- render requested page to canvas, update navigation state
  - Navigation event handlers (previous, next, page number input, zoom select)
  - Download button: opens the raw PDF URL
  - Error display: writes sanitized error message to error div using `textContent`

**Security constraints for this phase**:
- `?file=` URL must be validated: reject `javascript:`, `data:`, cross-origin URLs
- All PDF-derived text must use `element.textContent =` not `innerHTML`
- No `eval()`, no `new Function()`, no dynamic script loading

**Tests to pass before handoff**:
- [ ] `viewer.html?file=<path>/text-only.pdf` in browser -- text visible
- [ ] `viewer.html?file=<path>/images.pdf` in browser -- images visible
- [ ] `viewer.html?file=<path>/mixed.pdf` in browser -- mixed content visible
- [ ] `viewer.html?file=<path>/links.pdf` in browser -- links render as `<a>` elements; auto-follow does NOT occur on load
- [ ] `viewer.html?file=<path>/poc.pdf` in browser -- no `alert()`, no `eval()`, no DOM mutation from PDF JavaScript
- [ ] `viewer.html?file=<path>/malformed.pdf` in browser -- error message shown, no unhandled exception
- [ ] Page navigation (prev/next) works correctly across all corpus PDFs
- [ ] Cross-origin `?file=` URL shows error "cross-origin file not allowed"

**Handoff**: `agents-memory/handoffs/phase3-viewer.md`

---

### Phase 4 - Integration Test and Hardening

**Goal**: Run the full test corpus against the assembled viewer, perform security validation, fix rendering regressions, and produce test scripts.

**Input**: Read `agents-memory/handoffs/phase3-viewer.md`.

**Components to implement**:
- `tests/test-runner.js` (headless browser script):
  - For each corpus PDF: load viewer, check no uncaught exceptions, check canvas has non-zero pixels
  - For `poc.pdf`: confirm no calls to `window.alert`, `window.eval`, `Function` constructor
  - For `malformed.pdf`: confirm error message shown, no crash
  - For `links.pdf`: confirm link annotations render as `<a>` elements, no auto-navigation
- `tests/security-fuzz.js` (optional): generate truncated/corrupted variants, assert no uncaught exceptions

**Hardening tasks**:
- Review all loops over PDF-derived data for iteration limits
- Review all string insertions for `textContent` usage
- Audit for any remaining `eval`/`Function` patterns
- Verify `?file=` origin check works on Gogs subpath configurations

**Template change** (the only Gogs source modification required):
In `templates/repo/view_file.tmpl` line 84, change:
```
pdfjs-1.4.20
```
to:
```
custom-pdf-render
```

**Tests to pass before completion**:
- [ ] All 6 corpus PDFs pass their respective checks in `test-runner.js`
- [ ] No `eval`, `Function(`, `innerHTML` with PDF-derived data found by static grep
- [ ] The viewer iframe renders correctly in a Docker-based Gogs 0.13.2 instance
- [ ] Gogs unit/integration tests still pass (`go test ./...`)

**Handoff**: `agents-memory/handoffs/phase4-integration.md`

---

## 5. Security Threat Model

### 5.1 Attack Vectors to Mitigate

| Vector | Threat | Mitigation |
|---|---|---|
| CVE-2024-4367 pattern | Font name/matrix data fed to `eval`/`new Function` | Never use `eval` or `new Function` anywhere |
| PDF OpenAction / AA | Auto-execute JS on document open | Skip all action handlers on load |
| PDF JavaScript objects | Embedded `app.alert()` or similar | Filter out `/S /JavaScript` action dicts |
| XSS via PDF text content | `innerHTML` injection from extracted text | Always use `textContent`; HTML-escape all PDF strings |
| SSRF via `?file=` param | Fetch internal URLs via crafted link | Same-origin check in `validateURL()` |
| `javascript:` URI in link annotations | XSS via link click | Scheme whitelist: only `http://` and `https://` |
| Zip bomb / compressed stream | Memory exhaustion | Decompression output size limit (50 MB hard cap) |
| Circular object references | Stack overflow | Seen-set + depth limit (10) in `resolveObject` |
| Infinite page tree | Hang | Page count limit (500) in `getPageTree` |

### 5.2 Out-of-Scope

- Encrypted PDFs with password: show "password-protected PDFs are not supported"
- Digital signatures: not required
- PDF forms: not required
- 3D content (U3D/PRC): skip
- Video/audio embedded media: skip

### 5.3 Dependency Policy

The bespoke implementation must contain ONLY code written for this project. Permissible browser built-ins:
- `DecompressionStream` API (for FlateDecode) or a self-contained inflate implementation
- `HTMLCanvasElement` and `CanvasRenderingContext2D`
- `XMLHttpRequest` or `fetch`
- `URL` (for origin validation)
- `Blob`, `createObjectURL` (for JPEG image decoding)

No third-party libraries (PDF.js, pako, pdf-lib, pdfmake, etc.) may be imported or bundled.

---

## 6. Directory Structure (Expected Output)

```
public/plugins/custom-pdf-render/
+-- web/
|   +-- viewer.html          # Entry point: accepts ?file= param
|   +-- viewer.css           # Viewer styles
|   +-- viewer.js            # UI orchestration
+-- src/
    +-- pdf-parser.js        # Binary parser, xref, object resolution
    +-- pdf-renderer.js      # Content stream interpreter, canvas drawing
    +-- pdf-fonts.js         # Font metrics for standard PDF fonts
    +-- pdf-images.js        # Image decoding helpers
    +-- pdf-security.js      # Action filter, URL validator

tests/
+-- corpus/
|   +-- text-only.pdf
|   +-- images.pdf
|   +-- mixed.pdf
|   +-- links.pdf
|   +-- poc.pdf
|   +-- malformed.pdf
+-- test-runner.js
+-- security-fuzz.js

agents-memory/
+-- analyzer/
|   +-- analysis.md          # This file
+-- handoffs/
    +-- phase1-parser.md
    +-- phase2-renderer.md
    +-- phase3-viewer.md
    +-- phase4-integration.md
```

---

## 7. Implementation Notes for Implementer Agents

### Zlib/DEFLATE Without External Libraries

PDF's `FlateDecode` filter uses zlib-wrapped DEFLATE. The browser's built-in `DecompressionStream('deflate-raw')` handles raw DEFLATE. For zlib-wrapped streams (2-byte zlib header + DEFLATE + 4-byte Adler-32), strip the 2-byte header and use `DecompressionStream('deflate-raw')`. If `DecompressionStream` is unavailable, a ~500-line pure-JS inflate implementation must be written (RFC 1951).

### Standard PDF Fonts

The 14 standard PDF fonts have well-known AFM (Adobe Font Metrics) width tables. Embed compact width tables (one integer per character code 0-255) as a JS literal. For non-standard fonts, fall back to canvas `ctx.measureText()` with a system sans-serif font.

### Content-Disposition: attachment

The raw endpoint serves PDFs with `Content-Disposition: attachment`. This does NOT prevent `XMLHttpRequest` or `fetch` from reading the bytes -- it only affects browser download behavior. The custom viewer can freely fetch and parse the response body.

### Template Substitution (the only required Gogs source change)

File: `templates/repo/view_file.tmpl`, line 84

Before:
```html
<iframe width="100%" height="600px" src="{{AppSubURL}}/plugins/pdfjs-1.4.20/web/viewer.html?file={{EscapePound $.RawFileLink}}"></iframe>
```

After:
```html
<iframe width="100%" height="600px" src="{{AppSubURL}}/plugins/custom-pdf-render/web/viewer.html?file={{EscapePound $.RawFileLink}}"></iframe>
```

This is the complete set of Gogs source changes required.
