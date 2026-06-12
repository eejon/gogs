# PDF.js Replacement — Analysis and Implementation Plan

## Analysis

### Feature: File Fetch via Query Parameter
**What PDF.js does:** `viewer.html` loads `viewer.js` which reads the `?file=` query parameter and fetches the PDF bytes via XHR/fetch from that URL. The URL is expected to be same-origin.
**How Gogs uses it:** The iframe `src` is constructed in `templates/repo/view_file.tmpl:84` as:
```
{{AppSubURL}}/plugins/pdfjs-1.4.20/web/viewer.html?file={{EscapePound $.RawFileLink}}
```
`$.RawFileLink` resolves to `/<user>/<repo>/raw/<branch>/<path>.pdf`. The raw bytes are served by `repo.SingleDownload` (`internal/route/repo/download.go:51`), which reads the blob and calls `serveData`. For PDFs (non-text, non-image), `serveData` sets `Content-Disposition: attachment` and writes raw bytes.
**Requirement for bespoke implementation:** Must accept a `?file=` query parameter, fetch PDF bytes from the same-origin URL via `fetch()` or `XMLHttpRequest`, and handle the response as an `ArrayBuffer` for binary parsing.

### Feature: PDF Binary Parsing
**What PDF.js does:** `build/pdf.js` and `build/pdf.worker.js` implement a complete PDF parser — header validation, cross-reference table parsing, trailer dictionary, indirect object resolution, stream decompression (FlateDecode, ASCIIHexDecode, ASCII85Decode, etc.), and page tree traversal.
**How Gogs uses it:** Implicitly — any PDF uploaded to a repository must render. The test corpus includes text-only, images, mixed content, links, and malformed/adversarial PDFs.
**Requirement for bespoke implementation:** Must parse the PDF binary format:
- Validate `%PDF-` header and version
- Parse cross-reference tables (both traditional xref tables and cross-reference streams)
- Resolve trailer dictionary to find the root catalog
- Parse indirect objects (`N M obj ... endobj`)
- Decompress streams (at minimum: FlateDecode via raw inflate/deflate)
- Traverse the page tree (`/Type /Pages` → `/Type /Page`)
- Extract page content streams, font dictionaries, and image XObjects

### Feature: Text Rendering
**What PDF.js does:** Parses font dictionaries (Type1, TrueType, Type0/CIDFont), loads encoding maps (WinAnsiEncoding, MacRomanEncoding, custom differences), applies text positioning operators (`Tm`, `Td`, `TD`, `T*`), and renders glyphs to canvas.
**How Gogs uses it:** Any PDF with text content must display readable text. The `text-only.pdf` and `mixed.pdf` test cases exercise this.
**Requirement for bespoke implementation:** Must handle:
- PDF text operators: `BT`, `ET`, `Tf`, `Td`, `TD`, `Tm`, `T*`, `Tj`, `TJ`, `'`, `"`
- The 14 standard PDF fonts (Helvetica, Times-Roman, Courier, Symbol, ZapfDingbats and their variants)
- Standard encodings (WinAnsiEncoding, MacRomanEncoding, StandardEncoding)
- Encoding differences arrays
- Font size and text matrix transformations
- Character spacing, word spacing, leading
- Render text positioned correctly on a canvas element

### Feature: Image Rendering
**What PDF.js does:** Decodes embedded images from XObject streams — supports JPEG (DCTDecode), PNG-like (FlateDecode with predictors), CCITT fax, JBIG2, and JPX. Renders to canvas.
**How Gogs uses it:** The `images.pdf` and `mixed.pdf` test cases contain raster images.
**Requirement for bespoke implementation:** Must handle:
- Image XObjects (`/Subtype /Image`) with common filters
- DCTDecode (JPEG): pass raw JPEG bytes to browser's native decoding via `<img>` or `createImageBitmap`
- FlateDecode images: decompress and reconstruct pixel data from width/height/bitsPerComponent/colorSpace
- Common color spaces: DeviceRGB, DeviceGray, DeviceCMYK (convert to RGB for canvas)
- Inline images (`BI ... ID ... EI` operators)
- Correct placement using the current transformation matrix (CTM)

### Feature: Page Navigation
**What PDF.js does:** `viewer.html` provides Previous/Next buttons (`#previous`, `#next`), a page number input (`#pageNumber`), page count display (`#numPages`), and first/last page buttons.
**How Gogs uses it:** Multi-page PDFs must be navigable. The viewer is embedded in a 600px-tall iframe.
**Requirement for bespoke implementation:** Must provide:
- Previous/Next page buttons
- Current page number display and input (jump to page)
- Total page count display
- Render one page at a time (or continuous scroll)

### Feature: Zoom and Scaling
**What PDF.js does:** `viewer.html` provides Zoom In/Out buttons (`#zoomIn`, `#zoomOut`), and a scale select dropdown with presets: Auto, Actual Size, Fit Page, Full Width, 50%–400%.
**How Gogs uses it:** The viewer is in a fixed-size iframe (`width="100%" height="600px"`). Users need to zoom to read content.
**Requirement for bespoke implementation:** Must provide:
- Zoom in/out controls
- Fit-to-width as default (most useful in the iframe context)
- Scale presets or continuous zoom
- Re-render at appropriate resolution when zoom changes

### Feature: Link Handling (Security-Critical)
**What PDF.js does:** Renders PDF link annotations as clickable elements. External URLs open in new tabs. JavaScript actions in PDFs can trigger `window.open` or navigation.
**How Gogs uses it:** The `links.pdf` test case contains external links. The `poc.pdf` test case likely contains malicious JavaScript actions or URI schemes.
**Requirement for bespoke implementation:** Must:
- Render link annotations as visible, clickable regions
- External links: open in `_blank` with `rel="noopener noreferrer"` — MUST NOT auto-follow
- **Strip all JavaScript actions** (`/S /JavaScript`, `/JS` keys) — never execute PDF-embedded JS
- Sanitize URI schemes — allow only `http:`, `https:`, `mailto:` — block `javascript:`, `data:`, `file:`, etc.
- Internal links (page destinations): navigate within the viewer

### Feature: Error Handling and Malformed Input Resilience
**What PDF.js does:** Has extensive error recovery — handles truncated files, corrupt xref tables, missing objects, invalid streams. Shows error messages in the `#errorWrapper` div.
**How Gogs uses it:** The `malformed.pdf` and `poc.pdf` test cases must not crash the viewer.
**Requirement for bespoke implementation:** Must:
- Gracefully handle truncated/corrupt files without throwing uncaught exceptions
- Display a user-friendly error message when a PDF cannot be parsed
- Never enter an infinite loop on circular references
- Bound memory usage — reject PDFs that would allocate excessive memory
- Catch and swallow all parse errors within a structured try/catch

### Feature: Graphics State and Content Stream Operators
**What PDF.js does:** Implements the full PDF graphics state machine — CTM transforms, clipping, color spaces, line styles, path construction, and painting operators.
**How Gogs uses it:** The `mixed.pdf` and other test cases may use vector graphics, lines, rectangles, and fills.
**Requirement for bespoke implementation:** Must handle core operators:
- Graphics state: `q`, `Q` (save/restore), `cm` (concat matrix)
- Path construction: `m`, `l`, `c`, `v`, `y`, `h` (moveto, lineto, curveto, closepath)
- Path painting: `S` (stroke), `f`/`F` (fill), `B` (fill+stroke), `n` (no-op end path)
- Clipping: `W`, `W*`
- Color: `g`, `G` (gray), `rg`, `RG` (RGB), `k`, `K` (CMYK), `cs`, `CS`, `sc`, `SC` (color space)
- Rectangle shorthand: `re`
- External object: `Do` (for images and form XObjects)

### Feature: Loading and Progress Indication
**What PDF.js does:** Shows a loading bar (`#loadingBar`) while the PDF is being fetched and parsed. The body has class `loadingInProgress` that is removed when ready.
**How Gogs uses it:** Provides visual feedback during load.
**Requirement for bespoke implementation:** Must show a loading indicator while fetching and parsing the PDF, and remove it when rendering is complete or on error.

### Feature: Iframe Embedding Compatibility
**What PDF.js does:** The viewer is designed to work in an iframe context. It's a standalone HTML page.
**How Gogs uses it:** Embedded via `<iframe width="100%" height="600px" src="...">` in the repository file view.
**Requirement for bespoke implementation:** Must:
- Work correctly when loaded in an iframe
- Fill the available width (100%) and respect the 600px height
- Not attempt to break out of the iframe (`window.top` manipulation)
- Handle the iframe's scroll context properly

---

## Features NOT Required (Scope Reduction)

The following PDF.js features are present in `viewer.html` but **not needed** for the Gogs use case:

1. **Sidebar (thumbnails, outline, attachments)** — Not essential for basic viewing in a 600px iframe. Can be omitted.
2. **Find/Search in document** — Nice-to-have but not a functional requirement for Gogs' PDF preview.
3. **Presentation mode** — Not useful in an iframe context.
4. **Print support** — The raw file download link is already available; printing from the iframe is not a primary use case.
5. **Open File button** — The PDF is loaded from the repository; there's no need to open local files.
6. **Download button** — Gogs already provides a "Raw" download link above the iframe.
7. **Bookmark/Current View** — Not needed for repository file preview.
8. **Page rotation** — Optional; low priority.
9. **Hand tool** — Optional; low priority.
10. **Document properties overlay** — Not needed for preview.
11. **Password-protected PDFs** — Out of scope. Show an error message instead.
12. **Form filling** — Not needed for preview.
13. **Annotations (comment, markup)** — Read-only display of link annotations only.

---

## Implementation Phases

### Phase 1: PDF Binary Parser and Security Filter

**Agent:** `phase-1`
**Scope:** Build the core PDF binary parser and security sanitization layer. This is the foundation — all subsequent phases depend on it.

**Input:** This analysis document.

**Components to build:**
1. **`js/pdf-parser.js`** — PDF binary parser
   - `%PDF-` header validation and version extraction
   - Cross-reference table parser (traditional `xref` keyword format)
   - Cross-reference stream parser (PDF 1.5+ format)
   - Trailer dictionary parser
   - Indirect object parser (`N M obj ... endobj`)
   - PDF object type parsers: booleans, numbers, strings (literal and hex), names, arrays, dictionaries, streams
   - Stream decompression: FlateDecode (implement raw inflate — the RFC 1951 DEFLATE algorithm)
   - Object reference resolution (`N M R` → resolved object)
   - Page tree traversal: Catalog → Pages → Page objects
   - Circular reference detection (track visited object numbers)
   - Resource dictionary inheritance through the page tree

2. **`js/pdf-security.js`** — Security filter
   - Strip `/JS` and `/JavaScript` action entries from all objects
   - Sanitize URI annotations: allow only `http:`, `https:`, `mailto:`
   - Block `javascript:`, `data:`, `file:`, `vbscript:` URI schemes
   - Remove `/Launch` actions, `/SubmitForm` actions, `/ImportData` actions
   - Enforce size limits: max object count, max stream size, max nesting depth
   - Timeout/bail-out for parsing to prevent denial-of-service via crafted PDFs

**Output for next phase:**
- A `PDFParser` class/module that takes an `ArrayBuffer` and returns a structured document object:
  ```
  {
    version: "1.7",
    pageCount: N,
    pages: [
      {
        index: 0,
        mediaBox: [0, 0, 612, 792],
        contentStreams: [Uint8Array, ...],
        resources: { fonts: {...}, xObjects: {...}, ... }
      },
      ...
    ]
  }
  ```
- A `SecurityFilter` class/module that sanitizes the parsed document in-place

**Definition of done:**
- Parser correctly extracts page tree from well-formed PDFs
- FlateDecode decompression works for standard deflate streams
- Security filter strips all JavaScript actions and dangerous URIs
- Malformed input (truncated, corrupt xref, circular refs) produces a structured error, never an uncaught exception or infinite loop
- All code is self-contained — no imports from outside the repository

**Key implementation notes:**
- FlateDecode is the most critical filter — the vast majority of PDF content streams use it. Implement a DEFLATE decompressor from scratch (RFC 1951). This is the single hardest sub-component of Phase 1.
- The parser must handle both traditional xref tables AND xref streams (PDF 1.5+). Many modern PDFs use xref streams.
- String parsing must handle escape sequences in literal strings `(...)` and hex strings `<...>`.
- Name objects use `#XX` hex escapes (e.g., `/Type#20Name` → `/Type Name`).
- Streams have a `/Length` key that may be an indirect reference — resolve before reading stream bytes.

---

### Phase 2: Page Rendering Engine

**Agent:** `phase-2`
**Scope:** Build the content stream interpreter and canvas rendering engine. Takes parsed page data from Phase 1 and renders it to an HTML5 Canvas.

**Input:** Phase 1's parser output (structured page objects with content streams and resources).

**Components to build:**
1. **`js/pdf-renderer.js`** — Content stream interpreter and canvas renderer
   - **Content stream tokenizer**: Parse the PostScript-like operator stream into tokens (operands + operator)
   - **Graphics state machine**: Maintain a stack of graphics states (`q`/`Q`), including:
     - Current Transformation Matrix (CTM)
     - Fill and stroke colors
     - Line width, cap, join, dash pattern
     - Font and font size
     - Text matrix and text line matrix
     - Clipping path
   - **Text rendering operators**:
     - `BT`/`ET` — begin/end text object
     - `Tf` — set font and size
     - `Td`, `TD`, `Tm`, `T*` — text positioning
     - `Tj`, `TJ`, `'`, `"` — show text
     - `Tc`, `Tw`, `TL`, `Tr`, `Ts` — text state parameters
   - **Path operators**:
     - `m`, `l`, `c`, `v`, `y`, `h` — path construction
     - `re` — rectangle
     - `S`, `s`, `f`, `F`, `f*`, `B`, `B*`, `b`, `b*`, `n` — painting
     - `W`, `W*` — clipping
   - **Color operators**:
     - `g`/`G`, `rg`/`RG`, `k`/`K` — device colors
     - `cs`/`CS`, `sc`/`SC`, `scn`/`SCN` — general color spaces
   - **Image rendering**:
     - `Do` operator to render XObject images
     - JPEG passthrough (DCTDecode): create `Image()` element from raw bytes
     - FlateDecode images: reconstruct pixel data from raw components
     - Inline images (`BI`/`ID`/`EI`)
   - **Font handling**:
     - The 14 standard fonts: mapping to CSS font families (Helvetica→sans-serif, Times→serif, Courier→monospace, Symbol, ZapfDingbats)
     - Standard encodings: WinAnsiEncoding, MacRomanEncoding, StandardEncoding — character code → Unicode mapping tables
     - Encoding differences arrays
     - ToUnicode CMap parsing (for proper text extraction from non-standard encodings)
   - **Coordinate transforms**:
     - PDF coordinate system (origin bottom-left) → Canvas coordinate system (origin top-left)
     - MediaBox/CropBox handling for page dimensions
     - Scaling to fit the target canvas size

**Output for next phase:**
- A `PDFRenderer` class that takes a parsed page object and a canvas element, and renders the page content
- API: `renderer.renderPage(pageData, canvas, scale)` → `Promise<void>`

**Definition of done:**
- Text-only PDFs render with correct positioning and readable text
- Images display at correct position and scale
- Mixed content (text + images + vector graphics) renders correctly
- Colors are preserved
- Multi-page documents: each page can be rendered independently
- Graceful degradation for unsupported features (log warning, skip element, don't crash)

**Key implementation notes:**
- The canvas coordinate transform is critical. PDF has origin at bottom-left, y-axis up. Canvas has origin at top-left, y-axis down. Apply a flip transform: `ctx.transform(1, 0, 0, -1, 0, pageHeight)`.
- Font metrics for the standard 14 fonts must be hardcoded. At minimum, include character widths for proper text spacing. Exact glyph rendering can use browser's built-in fonts via `ctx.fillText()`.
- The `TJ` operator takes an array of strings and numbers — numbers are kerning adjustments in thousandths of a unit of text space.
- Image rendering for JPEG is straightforward: create a blob URL from the raw bytes, load into an `Image`, draw to canvas. For FlateDecode images, you need to reconstruct the pixel data based on width, height, bitsPerComponent, and colorSpace, then use `ImageData` + `putImageData`.
- The `cm` operator concatenates a matrix with the CTM. Matrix math is essential — implement 3x3 affine matrix multiplication.

---

### Phase 3: PDF View Entry Point

**Agent:** `phase-3`
**Scope:** Build the viewer HTML page and UI that ties everything together — the entry point that Gogs will iframe.

**Input:** Phase 1's parser and Phase 2's renderer.

**Components to build:**
1. **`web/viewer.html`** — Entry point HTML page
   - Minimal HTML structure with toolbar and canvas container
   - Script tags loading the JS modules in order: `pdf-parser.js`, `pdf-security.js`, `pdf-renderer.js`, `pdf-viewer.js`
   - CSS link to `viewer.css`
   - No external dependencies

2. **`js/pdf-viewer.js`** — Viewer application logic
   - **`?file=` parameter parsing**: Read URL query parameter, validate it's a relative/same-origin URL
   - **PDF fetch**: `fetch()` the PDF bytes as `ArrayBuffer`
   - **Parse → Filter → Render pipeline**: Call parser, run security filter, render first page
   - **Page navigation**:
     - Previous/Next buttons
     - Page number input (jump to page)
     - Total page count display
     - Keyboard navigation (left/right arrows, Page Up/Down)
   - **Zoom controls**:
     - Zoom In/Out buttons
     - Fit-to-width (default)
     - Scale display
   - **Loading indicator**: Show during fetch+parse, hide on complete or error
   - **Error display**: Show user-friendly message on parse failure or fetch error
   - **Link annotation rendering**: Overlay clickable regions for link annotations
     - `target="_blank" rel="noopener noreferrer"` for external URLs
     - Internal page links navigate within the viewer
   - **Responsive layout**: Fill iframe width, handle resize events

3. **`css/viewer.css`** — Viewer styles
   - Toolbar styling (top bar with controls)
   - Canvas container (centered, with shadow/border like a document)
   - Loading spinner/bar
   - Error message styling
   - Responsive: works at any width, 600px height context
   - Clean, minimal design consistent with Gogs' UI aesthetic

**Output:**
- Complete viewer that can be loaded as `custom-pdf-render/web/viewer.html?file=/path/to/file.pdf`
- All static files, no server-side dependencies

**Definition of done:**
- Opening `viewer.html?file=<url>` fetches and renders the PDF
- Page navigation works (prev/next, jump to page)
- Zoom works (in/out, fit-to-width default)
- Links are rendered as clickable regions that open in new tabs (not auto-follow)
- Loading indicator shows during load
- Error message shows for invalid/corrupt PDFs
- Works correctly inside an iframe
- No external dependencies or imports

**Key implementation notes:**
- The `?file=` URL must be validated before fetching. Only allow relative URLs or same-origin absolute URLs. Block `javascript:`, `data:`, and cross-origin URLs.
- Default zoom should be "fit to width" since the iframe is `width="100%"`. Calculate the scale as `containerWidth / pageWidth`.
- For link annotations, parse the `/Annots` array on each page, find entries with `/Subtype /Link`, extract the `/Rect` coordinates, and overlay positioned `<a>` elements on top of the canvas.
- The viewer should work without any build step — just plain JS files loaded via `<script>` tags.

---

### Phase 4: Integration with Gogs and Testing

**Agent:** `phase-4`
**Scope:** Wire the custom renderer into Gogs, run integration tests, perform security audit.

**Input:** Complete viewer from Phases 1–3.

**Tasks:**
1. **Template update**: Change `templates/repo/view_file.tmpl:84` from:
   ```
   src="{{AppSubURL}}/plugins/pdfjs-1.4.20/web/viewer.html?file={{EscapePound $.RawFileLink}}"
   ```
   to:
   ```
   src="{{AppSubURL}}/plugins/custom-pdf-render/web/viewer.html?file={{EscapePound $.RawFileLink}}"
   ```

2. **Integration tests** against the test corpus:
   - `text-only.pdf` → renders text, correct positioning
   - `images.pdf` → renders embedded images
   - `mixed.pdf` → renders text + images + layout correctly
   - `links.pdf` → link annotations visible, open in new tab, no auto-follow
   - `poc.pdf` → security gate: no JS execution, no auto-navigation, safe rendering
   - `malformed.pdf` → graceful error message, no crash, no infinite loop

3. **Security audit**:
   - Verify no `eval()`, `Function()`, `innerHTML` with unsanitized content, or `document.write` in the codebase
   - Verify all PDF-sourced strings are sanitized before DOM insertion
   - Verify URI scheme filtering works
   - Verify JavaScript action stripping works
   - Verify the viewer cannot break out of the iframe
   - Verify no external network requests are made (except the `?file=` fetch)
   - Test with adversarial inputs (oversized objects, deeply nested structures, circular refs)

4. **Regression testing**:
   - Ensure other file types (images, video, text, markdown, notebooks) still render correctly
   - Ensure the "Raw" download link still works for PDFs
   - Verify `AppSubURL` substitution works correctly

**Definition of done:**
- All 6 test corpus PDFs handled correctly
- No security vulnerabilities in the custom renderer code
- Template change is minimal (one path string)
- No regressions in other Gogs functionality

---

## File Structure

```
public/plugins/custom-pdf-render/
├── web/
│   └── viewer.html          # Entry point — accepts ?file= parameter
├── js/
│   ├── pdf-parser.js        # Phase 1: PDF binary format parser
│   ├── pdf-security.js      # Phase 1: Security filter/sanitizer
│   ├── pdf-renderer.js      # Phase 2: Canvas rendering engine
│   └── pdf-viewer.js        # Phase 3: Viewer UI and application logic
└── css/
    └── viewer.css           # Phase 3: Viewer styles
```

---

## Security Requirements (Cross-Cutting)

### Input Validation
- Validate `%PDF-` magic bytes before parsing
- Enforce maximum file size for parsing (e.g., 100MB)
- Enforce maximum object count (e.g., 100,000 objects)
- Enforce maximum stream decompression size (e.g., 200MB decompressed)
- Enforce maximum nesting depth for dictionaries/arrays (e.g., 100 levels)
- Detect and break circular references in object graph

### Content Sanitization
- **JavaScript**: Strip ALL `/JS`, `/JavaScript`, `/S /JavaScript` action entries
- **URIs**: Whitelist `http:`, `https:`, `mailto:` schemes only
- **Launch actions**: Remove `/S /Launch`, `/S /SubmitForm`, `/S /ImportData`
- **Embedded files**: Do not process `/EmbeddedFiles` in the catalog
- **Forms**: Do not process `/AcroForm` interactive forms

### DOM Safety
- Never use `innerHTML` with PDF-sourced content
- Use `textContent` or DOM API for text insertion
- Sanitize all attributes set from PDF data
- Canvas rendering is inherently safe (pixel-level, no DOM injection)

### Network Safety
- Only fetch the URL from the `?file=` parameter
- Validate the URL is same-origin or relative
- No other network requests
- No loading of external fonts, images, or scripts from PDF-specified URLs

### Execution Safety
- No `eval()`, `new Function()`, or `setTimeout` with string arguments
- No `document.write` or `document.writeln`
- The viewer is a static page — no server-side code

---

## Test Strategy

### Unit Tests (per phase)
- **Phase 1**: Parse known PDF structures (xref, objects, streams), verify FlateDecode output, verify security filter strips dangerous actions
- **Phase 2**: Render known content streams, verify canvas output dimensions and non-blank pixels
- **Phase 3**: Verify `?file=` parameter handling, page navigation state, zoom calculations

### Integration Tests (Phase 4)
- Load each corpus PDF end-to-end through the viewer
- Verify rendering produces visible content (non-blank canvas)
- Verify page count matches expected
- Verify link annotations are present and properly constrained
- Verify malformed inputs produce error messages, not crashes

### Security Tests (Phase 4)
- `poc.pdf`: Verify no JavaScript execution (check for alert/confirm/prompt interception)
- Craft test with `javascript:` URI — verify it's blocked
- Craft test with `/Launch` action — verify it's stripped
- Verify deeply nested objects don't cause stack overflow
- Verify circular references don't cause infinite loops
- Verify oversized streams don't exhaust memory
