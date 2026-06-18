# PDF.js Replacement Analysis

## Analysis

### Feature: File Fetch via Query Parameter
**What PDF.js does:** `viewer.html` loads `viewer.js` which parses `?file=` from the query string (`viewer.js:7146-7148`) via `parseQueryString()` (`viewer.js:162-172`). If no `file` param is present, it falls back to `DEFAULT_URL` (`viewer.js:28`). The extracted URL is then validated by `validateFileURL()` (`viewer.js:7114-7138`).

**How Gogs uses it:** The iframe src in `templates/repo/view_file.tmpl:84` passes `$.RawFileLink` as the `file` parameter:
```
<iframe width="100%" height="600px" src="{{AppSubURL}}/plugins/pdfjs-1.4.20/web/viewer.html?file={{EscapePound $.RawFileLink}}"></iframe>
```
`RawFileLink` is set in `internal/route/repo/view.go:135` as `rawLink + "/" + c.Repo.TreePath`, which resolves to `/<user>/<repo>/raw/<branch>/<path>.pdf`. The `EscapePound` function (`internal/template/template.go:262-264`) escapes `%`, `#`, ` `, and `?` characters in the URL.

**Requirement for custom implementation:** Must accept a `?file=` query parameter, parse it from the URL search string, and use it as the PDF fetch target. The URL will always be a relative same-origin path (e.g., `/user/repo/raw/branch/file.pdf`).

---

### Feature: Same-Origin URL Validation
**What PDF.js does:** `validateFileURL()` (`viewer.js:7114-7138`) constructs `URL` objects for the viewer origin and file origin, then rejects files whose origin differs from the viewer's origin (unless the viewer origin is in `HOSTED_VIEWER_ORIGINS = ['null', 'http://mozilla.github.io', 'https://mozilla.github.io']`).

**How Gogs uses it:** Since Gogs serves both the viewer and the raw PDF from the same origin, this validation always passes. However, it provides defense-in-depth against URL manipulation.

**Requirement for custom implementation:** Must validate that the `?file=` URL resolves to the same origin as the viewer page. Must reject `javascript:`, `data:`, `blob:` (external), and any cross-origin URLs. Only `http:`, `https:`, and relative paths should be allowed.

---

### Feature: PDF Binary Fetch
**What PDF.js does:** For `file:` URLs, viewer.js uses `XMLHttpRequest` with `responseType = 'arraybuffer'` (`viewer.js:7348-7355`). For `http/https` URLs, `PDFViewerApplication.open(file)` is called (`viewer.js:7362-7363`), which delegates to `PDFJS.getDocument(parameters)` (`viewer.js:6481`). The pdf.js library internally uses XHR to fetch the bytes.

**How Gogs uses it:** The raw PDF bytes are served by `repo.SingleDownload` (`internal/route/repo/download.go:51-62`), which calls `ServeBlob` -> `serveData`. For PDFs (non-text, non-image), `serveData` sets `Content-Disposition: attachment` and `Content-Transfer-Encoding: binary` (`download.go:29-30`), then writes the raw blob bytes to the response. The `Content-Disposition: attachment` header does not block `XMLHttpRequest`/`fetch` -- it only affects browser navigation.

**Requirement for custom implementation:** Must fetch the PDF bytes from the `?file=` URL using `fetch()` (or `XMLHttpRequest`) with `responseType`/response handling that yields an `ArrayBuffer` or `Uint8Array`. Must handle fetch errors (network failure, 404, 500) gracefully with a user-visible error message.

---

### Feature: PDF Header/Magic Validation
**What PDF.js does:** pdf.js validates the `%PDF-` magic header and extracts the version number during document parsing.

**How Gogs uses it:** Gogs pre-validates on the server side via `tool.IsPDFFile(data)` (`internal/tool/file.go:26-28`), which uses Go's `http.DetectContentType(data)` to check for `application/pdf`. This means the iframe is only rendered for content the server has already identified as PDF. However, the client-side parser must also validate the header to guard against TOCTOU issues or direct URL manipulation.

**Requirement for custom implementation:** Must validate that fetched bytes begin with `%PDF-` (within the first 1024 bytes, per PDF spec allowance for leading whitespace). Must reject non-PDF content with a clear error message. Must extract the PDF version for informational purposes.

---

### Feature: Cross-Reference Table Parsing (Traditional + Stream)
**What PDF.js does:** Parses both traditional cross-reference tables (`xref\n...trailer`) and cross-reference streams (PDF 1.5+) to build the object lookup table for the entire document.

**How Gogs uses it:** Indirectly -- any PDF that Gogs users upload may use either format. PDFs from older producers (Word, LaTeX with older pdfTeX) typically use traditional xref. Newer producers and PDF 1.5+ files use xref streams with Flate compression.

**Requirement for custom implementation:** Must parse traditional xref tables with `startxref` pointer, `xref` keyword, generation numbers, and `trailer` dictionary. Must also parse cross-reference streams (Type `/XRef` stream objects) with `/W` array defining field widths. Must handle linearized PDFs (which have an xref at the beginning). Must handle documents with incremental updates (multiple xref sections chained via `/Prev`).

---

### Feature: Trailer/Root/Catalog Resolution
**What PDF.js does:** Resolves the trailer dictionary to find `/Root` (the catalog), then navigates `/Root` -> `/Pages` to find the page tree root.

**How Gogs uses it:** Required for any PDF rendering.

**Requirement for custom implementation:** Must parse the trailer (or trailer-equivalent in xref streams), resolve the `/Root` indirect reference to the catalog dictionary, and from there resolve `/Pages` to the page tree root. Must handle the case where `/Root` or `/Pages` is missing with a graceful error.

---

### Feature: Indirect Object and Reference Resolution
**What PDF.js does:** Resolves `N M R` references to their corresponding `N M obj...endobj` definitions using the xref table.

**How Gogs uses it:** Fundamental to PDF structure -- every PDF uses indirect references.

**Requirement for custom implementation:** Must resolve indirect references (`N M R` syntax) by looking up the object number `N` and generation `M` in the xref table, then parsing the object at that byte offset. Must handle missing references gracefully (treat as null). Must detect and break circular references to prevent infinite loops.

---

### Feature: Stream Decoding (FlateDecode)
**What PDF.js does:** Decodes streams compressed with `/FlateDecode` (zlib/deflate), which is the most common compression in modern PDFs.

**How Gogs uses it:** Nearly all modern PDFs use FlateDecode for content streams, xref streams, and embedded resources.

**Requirement for custom implementation:** Must implement FlateDecode (RFC 1951 raw deflate). Must handle `/DecodeParms` with `/Predictor` values (especially PNG predictors 10-15 for image data). Must handle missing or corrupt stream data gracefully.

---

### Feature: Stream Decoding (ASCIIHexDecode, ASCII85Decode)
**What PDF.js does:** Decodes `ASCIIHexDecode` and `ASCII85Decode` streams, which are text-based encodings for binary data.

**How Gogs uses it:** Less common but can appear in older PDFs or PDFs generated by certain tools.

**Requirement for custom implementation:** Must implement ASCIIHexDecode (hex pairs to bytes, `>` as EOD marker) and ASCII85Decode (base-85 encoding with `~>` as EOD marker).

---

### Feature: Page Tree and Inherited Resources
**What PDF.js does:** Traverses the page tree (which may be a balanced tree, not just a flat `/Kids` array) and inherits `/Resources`, `/MediaBox`, `/CropBox`, `/Rotate` from ancestor nodes.

**How Gogs uses it:** Multi-page PDFs and PDFs with shared resources across pages.

**Requirement for custom implementation:** Must recursively traverse `/Pages` nodes following `/Kids` arrays. Must inherit `/Resources`, `/MediaBox`, `/CropBox`, `/Rotate` from parent nodes when not specified on individual `/Page` objects.

---

### Feature: Text Rendering (Operators Tj, TJ, ', ")
**What PDF.js does:** Processes PDF text operators including `Tj` (show string), `TJ` (show string with individual glyph positioning), `'` (move to next line and show), `"` (set spacing, move to next line, show). Handles text state operators: `Tf` (font/size), `Tm` (text matrix), `Td/TD` (text position), `Tc` (character spacing), `Tw` (word spacing), `TL` (leading), `Tr` (rendering mode), `Ts` (rise).

**How Gogs uses it:** Core requirement -- text is the primary content of most PDFs viewed in a code hosting platform (documentation, papers, READMEs).

**Requirement for custom implementation:** Must implement all text showing operators and text state operators. Must correctly compose the text matrix (Tm) with the CTM for proper positioning. Must handle horizontal and vertical text positioning.

---

### Feature: Standard 14 Fonts and Encodings
**What PDF.js does:** Provides built-in metrics and glyph mappings for the 14 standard PDF fonts (Times-Roman, Times-Bold, Times-Italic, Times-BoldItalic, Helvetica, Helvetica-Bold, Helvetica-Oblique, Helvetica-BoldOblique, Courier, Courier-Bold, Courier-Oblique, Courier-BoldOblique, Symbol, ZapfDingbats). Handles encoding differences via `/Encoding` and `/Differences` arrays.

**How Gogs uses it:** PDFs that reference standard fonts without embedding them rely on the viewer providing these fonts.

**Requirement for custom implementation:** Must include width tables for all 14 standard fonts. Must map standard encoding names (StandardEncoding, WinAnsiEncoding, MacRomanEncoding, MacExpertEncoding) to Unicode. Must handle `/Differences` arrays that override individual character codes. Can use system/web-safe font fallbacks (serif -> Times, sans-serif -> Helvetica, monospace -> Courier) rather than exact replicas.

---

### Feature: Embedded Font Handling (Type1 Subsets, TrueType, CIDFont)
**What PDF.js does:** Parses embedded font programs (Type1, TrueType, OpenType/CFF), extracts glyph outlines or uses the embedded `/ToUnicode` CMap for text extraction, and constructs font objects for rendering.

**How Gogs uses it:** Critical for LaTeX-generated PDFs (Type1 subsets like CMR, CMBX, CMSS), Word/LibreOffice PDFs (TrueType subsets like Calibri, Liberation), and XeLaTeX/LuaLaTeX PDFs (CIDFont Type2 with Identity-H encoding).

**Requirement for custom implementation:** Must parse `/ToUnicode` CMaps to map character codes to Unicode for correct glyph display. Must extract `/Widths`, `/W` arrays for character positioning. For rendering, must detect the font's `/BaseFont` name and attempt to map to a reasonable web-safe equivalent. Must handle Identity-H and Identity-V CMap encodings for CIDFonts. Does not need to fully parse Type1/TrueType font programs -- using `/ToUnicode` + width data + fallback web fonts is sufficient for the Gogs use case.

---

### Feature: Graphics State Stack (q/Q/cm)
**What PDF.js does:** Implements the graphics state stack with `q` (save), `Q` (restore), and `cm` (concatenate matrix) operators. The CTM (Current Transformation Matrix) is a 3x2 affine matrix.

**How Gogs uses it:** Required for any PDF with positioned elements, rotated text, scaled images, or nested transformations (common in TikZ diagrams, charts).

**Requirement for custom implementation:** Must maintain a graphics state stack. `q` pushes a copy of the current state. `Q` pops and restores. `cm` concatenates a 6-element matrix [a b c d e f] with the current CTM via matrix multiplication. The state must track: CTM, fill/stroke color, line width, line cap/join, dash pattern, font, text state, clipping path, and alpha values.

---

### Feature: Path and Paint Operators
**What PDF.js does:** Implements path construction (`m` moveto, `l` lineto, `c` curveto, `v/y` shorthand curves, `h` closepath, `re` rectangle) and paint operators (`S` stroke, `s` close+stroke, `f/F` fill, `f*` fill even-odd, `B/B*` fill+stroke, `b/b*` close+fill+stroke, `n` no-op/clip-only).

**How Gogs uses it:** Required for TikZ diagrams, charts (matplotlib/ggplot), borders, boxes, and any vector graphics content.

**Requirement for custom implementation:** Must implement all path construction and paint operators. Must render to HTML5 Canvas using the equivalent Canvas 2D API calls. Must handle the fill rules (winding vs. even-odd).

---

### Feature: Clipping (W/W*)
**What PDF.js does:** Implements clipping operators `W` (winding) and `W*` (even-odd) that intersect the current clipping region with the current path.

**How Gogs uses it:** Used in TikZ diagrams, charts with clipped regions, and complex vector graphics.

**Requirement for custom implementation:** Must implement clipping by applying `canvas.clip()` after path construction when `W` or `W*` appears before the path paint operator.

---

### Feature: Color Spaces
**What PDF.js does:** Handles DeviceGray, DeviceRGB, DeviceCMYK, Indexed, ICCBased, CalGray, CalRGB, Lab, Separation, DeviceN, and Pattern color spaces.

**How Gogs uses it:** Most PDFs use DeviceRGB or DeviceGray. CMYK appears in some print-oriented documents. Indexed colors appear in palette-based images.

**Requirement for custom implementation:** Must handle DeviceGray (1 component -> gray), DeviceRGB (3 components -> rgb), DeviceCMYK (4 components -> approximate RGB conversion), and Indexed (lookup table). ICCBased should fall back to the nearest device color space based on `/N` (number of components). CalGray/CalRGB can fall back to DeviceGray/DeviceRGB. Separation and DeviceN can use the `/AlternateColorSpace` fallback.

---

### Feature: Image XObjects (DCTDecode/JPEG)
**What PDF.js does:** Renders image XObjects (`/Subtype /Image`) with various decode filters. DCTDecode (JPEG) images can be passed directly to the browser since browsers natively decode JPEG.

**How Gogs uses it:** Scanned documents, browser-print PDFs, and any PDF with embedded photos or screenshots.

**Requirement for custom implementation:** Must extract image XObjects, decode their streams, and render them on canvas. For DCTDecode (JPEG), create a `Blob` URL from the raw JPEG bytes and draw via `Image` element. Must handle `/Width`, `/Height`, `/BitsPerComponent`, `/ColorSpace`, and `/Decode` array.

---

### Feature: Flate-Compressed Images with Predictors
**What PDF.js does:** Decodes image streams using FlateDecode with PNG-style predictors (predictor values 10-15), where each row is filtered relative to the previous row.

**How Gogs uses it:** Common in PDFs with non-JPEG raster images (charts, diagrams with solid colors, screenshots).

**Requirement for custom implementation:** Must implement PNG predictor decoding (Sub=10, Up=11, Average=12, Paeth=13, Optimum=15 where each row selects its own filter). Must reconstruct raw pixel data from the filtered stream. Must handle `/Columns` and `/Colors` decode parameters.

---

### Feature: BitsPerComponent Variations
**What PDF.js does:** Handles 1-bit (B&W), 2-bit, 4-bit, and 8-bit images, unpacking sub-byte samples into full pixel values.

**How Gogs uses it:** 1-bit images in scanned B&W documents, 8-bit for full-color images, other depths in specialized content.

**Requirement for custom implementation:** Must unpack pixel data at all standard BPC values (1, 2, 4, 8). Must handle the `/Decode` array for mapping sample values to the output range.

---

### Feature: Image Masks and Soft Masks (SMask)
**What PDF.js does:** Handles stencil masks (`/ImageMask true`), explicit masks (`/Mask` array or image), and soft masks (`/SMask` image XObject). Stencil masks use the current color to paint where the mask bit is set.

**How Gogs uses it:** Transparency effects, masked images, text overlays on images.

**Requirement for custom implementation:** Must handle `/ImageMask true` (stencil -- paint current fill color where mask=1). Must handle `/SMask` (soft mask -- use the grayscale values as alpha channel). Must handle `/Mask` as a color key mask (array of min/max ranges for each component that become transparent).

---

### Feature: Inline Images (BI/ID/EI)
**What PDF.js does:** Parses inline image data embedded directly in the content stream using `BI` (begin image), `ID` (image data), and `EI` (end image) operators.

**How Gogs uses it:** Some PDF producers (especially browser print-to-PDF) use inline images for small icons or pattern fills.

**Requirement for custom implementation:** Must parse inline image dictionaries (abbreviated keys like `/W`, `/H`, `/BPC`, `/CS`, `/F`), extract the binary data between `ID` and `EI` markers, and render like a regular image XObject.

---

### Feature: ExtGState Alpha (ca/CA)
**What PDF.js does:** Applies transparency via the `/ExtGState` resource dictionary entries `/ca` (fill alpha) and `/CA` (stroke alpha), set by the `gs` operator.

**How Gogs uses it:** Transparency effects in diagrams, watermarks, and layered content.

**Requirement for custom implementation:** Must parse `/ExtGState` resources, extract `/ca` and `/CA` values, and apply them via `canvas.globalAlpha` (separately tracking fill and stroke alpha). Must also handle `/BM` (blend mode) by mapping PDF blend modes to canvas `globalCompositeOperation` where possible.

---

### Feature: Shading Patterns (sh operator)
**What PDF.js does:** Renders shading patterns (linear gradients type 2, radial gradients type 3, and other types).

**How Gogs uses it:** Gradient fills in Inkscape exports, some chart backgrounds, decorative elements.

**Requirement for custom implementation:** Must implement Type 2 (axial/linear) and Type 3 (radial) shading as canvas gradients. Other shading types (4-7: free-form mesh, etc.) can fall back to the background color or a flat fill. Must not crash on unsupported shading types.

---

### Feature: Page Navigation
**What PDF.js does:** Provides previous/next buttons, page number input, first/last page buttons (`viewer.html:120-125, 162-172`). The page number input accepts direct jumps (`viewer.js:7316`). Navigation is bounded by page count.

**How Gogs uses it:** Users browse multi-page PDFs (papers, documentation).

**Requirement for custom implementation:** Must provide previous/next page buttons, a page number input field with direct jump, and display of total page count (e.g., "Page 1 of 10"). Must enforce bounds (no navigating before page 1 or after the last page). Must render only the current page to minimize memory usage.

---

### Feature: Zoom and Scale Controls
**What PDF.js does:** Provides zoom in/out buttons, a scale dropdown with preset values (50%, 75%, 100%, 125%, 150%, 200%, 300%, 400%), and special modes (Automatic Zoom, Actual Size, Fit Page, Full Width) (`viewer.html:203-226`). Default is "auto" (`viewer.js:43`).

**How Gogs uses it:** Users need to zoom into details or fit the document to the iframe width. The iframe is fixed at `width="100%" height="600px"` (`view_file.tmpl:84`).

**Requirement for custom implementation:** Must provide zoom in/out buttons and a fit-to-width default mode (since the viewer is in a fixed-height iframe, fitting to the container width is the most practical default). Must support at least: fit-width, 50%, 75%, 100%, 150%, 200%. Must re-render the canvas at the new scale.

---

### Feature: Loading Progress Indicator
**What PDF.js does:** Shows a loading bar (`viewer.html:231-236`, `viewer.js:6622-6648`) that fills as the PDF bytes are downloaded.

**How Gogs uses it:** Provides visual feedback during PDF load.

**Requirement for custom implementation:** Must show a loading indicator while fetching PDF bytes. Can be simpler than PDF.js (e.g., a spinner or "Loading..." text). Must hide the indicator when rendering begins or on error.

---

### Feature: Error Display
**What PDF.js does:** Shows an error wrapper (`viewer.html:255-272`) with error message, "More Information" toggle, and close button (`viewer.js:6573-6619`).

**How Gogs uses it:** Displays errors for corrupt PDFs, fetch failures, etc.

**Requirement for custom implementation:** Must display user-friendly error messages for: fetch failure, invalid PDF, parse errors, render errors. Must not expose raw stack traces by default but may offer a "details" toggle for debugging.

---

### Feature: Link Annotations
**What PDF.js does:** Renders annotation layers on top of the canvas page. For URI link annotations, it creates `<a>` elements with the target URL. When embedded (`isViewerEmbedded`), it sets `PDFJS.externalLinkTarget = PDFJS.LinkTarget.TOP` (`viewer.js:6273-6276`) to prevent links from navigating within the iframe.

**How Gogs uses it:** PDFs with hyperlinks (e.g., references in academic papers, links in documentation).

**Requirement for custom implementation:** Must parse `/Annots` arrays on pages, filter for `/Subtype /Link` annotations. For URI actions, render clickable overlay `<a>` elements positioned over the link rectangle. Must set `target="_blank"` and `rel="noopener noreferrer"` on all external links. For internal GoTo actions (page jumps), navigate to the target page. Must sanitize URIs (only allow `http:`, `https:`, `mailto:` schemes).

---

### Feature: Iframe Embedding Behavior
**What PDF.js does:** Detects iframe embedding via `window.parent !== window` (`viewer.js:6088`). When embedded: (1) does not change parent page title (`viewer.js:6386-6390`), (2) disables browsing history manipulation (`viewer.js:6697`), (3) sets external link target to `_top` or `_blank` (`viewer.js:6273-6276`).

**How Gogs uses it:** The viewer is always in an iframe within the Gogs repository file view.

**Requirement for custom implementation:** Must work correctly within an iframe. Must not attempt to change the parent page title. Must not manipulate browser history. Must not attempt to break out of the iframe. All external links must open in a new tab (`_blank`).

---

### Feature: Security - Embedded JavaScript Stripping
**What PDF.js does:** PDF.js does not execute embedded JavaScript actions (`/JS` entries in action dictionaries). It simply ignores them.

**How Gogs uses it:** Passive security -- malicious PDFs with embedded JS are rendered without executing the scripts.

**Requirement for custom implementation:** Must never evaluate or execute any JavaScript found in PDF action dictionaries (`/S /JavaScript`, `/JS` entries). Must strip/ignore all JavaScript actions during annotation parsing.

---

### Feature: Security - Dangerous Action Blocking
**What PDF.js does:** Ignores launch actions (`/S /Launch`), form submission actions (`/S /SubmitForm`), import data actions (`/S /ImportData`), and other potentially dangerous action types.

**How Gogs uses it:** Passive security.

**Requirement for custom implementation:** Must implement an action type allowlist. Only `/S /URI` (with scheme sanitization) and `/S /GoTo` (internal page navigation) should be processed. All other action types must be silently dropped.

---

### Feature: Security - Resource Limits
**What PDF.js does:** Has implicit limits on recursion depth and object resolution.

**How Gogs uses it:** Prevents denial-of-service via maliciously crafted PDFs.

**Requirement for custom implementation:** Must enforce explicit limits: max object count (e.g., 100,000), max recursion/nesting depth (e.g., 50), max stream size after decompression (e.g., 100 MB), max page dimensions (e.g., 14400 x 14400 points = 200 x 200 inches), and a parsing timeout (e.g., 30 seconds). Must fail gracefully when limits are exceeded.

---

### Features NOT Required (Used by PDF.js but not by Gogs)

The following PDF.js features are present in `viewer.html` but are NOT required for the Gogs replacement because they are not part of the core viewing experience in an embedded iframe context:

1. **Sidebar (Thumbnails/Outline/Attachments)** - `viewer.html:51-73`. Not needed -- the viewer is in a 600px iframe where sidebar space is impractical.
2. **Find/Search** - `viewer.html:76-94`. Not needed for embedded viewing.
3. **Presentation Mode** - `viewer.html:98-99, 175-177`. Not needed in iframe context.
4. **Open File button** - `viewer.html:102-104, 179-181`. Not needed -- file is specified by Gogs.
5. **Print button** - `viewer.html:106-108, 183-185`. Not needed in embedded context.
6. **Download button** - `viewer.html:110-112, 186-189`. Not strictly needed -- Gogs already provides a "Raw" download link in the file header (`view_file.tmpl:21`).
7. **Bookmark/Current View** - `viewer.html:114-116, 190-192`.
8. **Page Rotation** - `viewer.html:129-134`. Nice-to-have but not essential.
9. **Hand Tool** - `viewer.html:138-140`.
10. **Document Properties dialog** - `viewer.html:144-146, 291-335`.
11. **Password-protected PDFs** - `viewer.html:276-290`. Edge case for code hosting.
12. **Context Menu** - `viewer.html:240-249`.
13. **Text selection/copy** - PDF.js text layer. Nice-to-have but complex; not essential.
14. **Debugger** - `debugger.js`. Development tool only.
15. **Localization (l10n)** - Data attributes throughout. Not needed for a simple viewer.

---

## Implementation Phases

### Phase 1: PDF Binary Parser and Security Filter
**Agent:** `phase-1`
**Scope:** Build the core PDF binary parser that can read a PDF file's structure from an `ArrayBuffer`, and a security filter that strips/blocks dangerous content before rendering.

**Components:**
1. **PDF Tokenizer/Lexer** - Tokenize PDF syntax: numbers, strings (literal and hex), names, arrays, dictionaries, `obj`/`endobj`, `stream`/`endstream`, boolean, null, references (`N M R`).
2. **Cross-Reference Parser** - Parse traditional xref tables and xref streams (FlateDecode + `/W` array). Handle incremental updates via `/Prev` chain.
3. **Object Store** - Build an indexed object store from the xref table. Resolve indirect references with cycle detection (max depth 50).
4. **Stream Decoders** - Implement FlateDecode (using browser's `DecompressionStream` API or a pure-JS deflate), ASCIIHexDecode, ASCII85Decode. Handle `/DecodeParms` including `/Predictor`.
5. **Trailer/Catalog/Page Tree Resolution** - Parse trailer -> `/Root` -> `/Pages`. Traverse page tree with resource inheritance.
6. **Security Filter** - Strip `/JS`, `/JavaScript`, `/Launch`, `/SubmitForm`, `/ImportData`, `/RichMedia` actions. URI scheme allowlist. Resource limits enforcement.

**Input:** Raw `ArrayBuffer` of PDF bytes.
**Output:** A `PDFDocument` object with methods: `getPageCount()`, `getPage(n)` returning page dictionary + inherited resources + MediaBox, and `getObject(ref)` for resolving any indirect reference.

**Definition of done:**
- Can parse the xref and build the object table for all test corpus PDFs.
- Can resolve the page tree and return correct page count for all test corpus PDFs.
- Can extract and decode content streams (FlateDecode) for all test corpus PDFs.
- Security filter strips all dangerous actions from `links.pdf` and any other PDFs with annotations.
- Circular reference detection works (tested with a crafted input).
- Resource limits are enforced (max objects, max depth, max decompressed size, timeout).
- All error conditions produce structured errors, never crashes.

---

### Phase 2a: Core Page Rendering Engine
**Agent:** `phase-2a`
**Scope:** Build the content stream interpreter and canvas renderer for text and vector graphics.

**Components:**
1. **Content Stream Parser** - Parse the page content stream(s) into an operator sequence. Handle the case where `/Contents` is an array of streams (concatenated).
2. **Graphics State Machine** - Implement the graphics state stack (`q`/`Q`), CTM (`cm`), and all state-tracking (color, line style, font, text state, alpha).
3. **Text Renderer** - Implement text operators (`Tf`, `Tm`, `Td`, `TD`, `T*`, `Tj`, `TJ`, `'`, `"`, `Tc`, `Tw`, `TL`, `Tr`, `Ts`). Compute glyph positions using font metrics and the text/CTM matrix pipeline.
4. **Standard Font Metrics** - Width tables and encoding maps for the 14 standard PDF fonts. Mapping to CSS font families.
5. **Embedded Font Support** - Parse `/ToUnicode` CMaps, `/Widths` arrays, `/W` arrays (CIDFont), `/Encoding` + `/Differences`. Map embedded font names to reasonable web-safe fallbacks.
6. **Vector Graphics Renderer** - Path operators (`m`, `l`, `c`, `v`, `y`, `h`, `re`), paint operators (`S`, `s`, `f`, `F`, `f*`, `B`, `B*`, `b`, `b*`, `n`), clip operators (`W`, `W*`).
7. **Color Operator Handling** - `g`/`G` (DeviceGray), `rg`/`RG` (DeviceRGB), `k`/`K` (DeviceCMYK), `cs`/`CS` (set color space), `sc`/`SC`/`scn`/`SCN` (set color). Color space resolution from page resources.

**Input:** A page object from Phase 1's `PDFDocument`, a target `<canvas>` element, and a scale factor.
**Output:** The page rendered to the canvas.

**Definition of done:**
- Text renders at correct positions for PDFs from all producer types (LaTeX, Word, Google Docs, browser print).
- Standard fonts display with correct character mappings (no garbled text for WinAnsiEncoding, MacRomanEncoding).
- Embedded font subsets display using `/ToUnicode` mapping with correct character spacing.
- Vector paths (lines, curves, rectangles) render correctly for TikZ-style diagrams.
- Colors (gray, RGB, CMYK->RGB fallback) display correctly.
- Clipping works for complex vector diagrams.
- `q`/`Q` state save/restore handles nested transforms correctly.

---

### Phase 2b: Extended Rendering -- Images, Type3 Fonts, Shading
**Agent:** `phase-2b`
**Scope:** Add image rendering, advanced font support, and shading/gradient support.

**Components:**
1. **Image XObject Renderer** - Decode and render image XObjects. Handle DCTDecode (JPEG pass-through to browser), FlateDecode with predictors, various BPC values (1, 2, 4, 8), and color spaces (Gray, RGB, CMYK, Indexed).
2. **Image Mask Support** - Stencil masks (`/ImageMask true`), soft masks (`/SMask`), color key masks (`/Mask` array).
3. **Inline Image Parser** - Parse `BI`/`ID`/`EI` inline images from the content stream.
4. **ExtGState Handler** - Parse and apply `/ExtGState` entries: `/ca` (fill alpha), `/CA` (stroke alpha), `/BM` (blend mode), `/SMask` (soft mask from graphics state).
5. **Shading Renderer** - Type 2 (axial/linear gradient) and Type 3 (radial gradient) via canvas gradient API. Graceful fallback for types 4-7.
6. **Type3 Font Support** - If Type3 fonts are encountered (they define glyphs via content streams), render each glyph's content stream to a small canvas/path and use as the glyph representation.

**Input:** Extends Phase 2a's renderer with image/shading/alpha capabilities.
**Output:** Full page rendering including images and transparency.

**Definition of done:**
- JPEG images render at correct size/position for scanned PDFs and browser-print PDFs.
- Flate-compressed images with PNG predictors render correctly (charts, diagrams).
- 1-bit images render correctly for B&W scanned documents.
- Indexed color images render with correct palette.
- Image masks produce correct transparency effects.
- Fill/stroke alpha from ExtGState produces correct opacity layering.
- Linear and radial gradients render for shading patterns.
- Inline images render correctly.

---

### Phase 3: Viewer Entry Point (viewer.html)
**Agent:** `phase-3`
**Scope:** Build the `viewer.html` page and its associated CSS/JS that provides the user-facing viewer interface, integrates with the parser and renderer from Phases 1-2, and handles the `?file=` parameter.

**Components:**
1. **viewer.html** - HTML structure with: toolbar (prev/next, page number input, total pages, zoom controls), canvas container, loading indicator, error display area.
2. **viewer.css** - Styling for the viewer that works within a `width="100%" height="600px"` iframe. Clean, minimal toolbar. Responsive layout.
3. **viewer.js (entry point)** -
   - Parse `?file=` from URL query string.
   - Validate URL (same-origin check, scheme allowlist).
   - Fetch PDF bytes via `fetch()` as `ArrayBuffer`.
   - Initialize the parser (Phase 1) and renderer (Phase 2a/2b).
   - Render the first page.
   - Wire up navigation controls (prev/next/jump).
   - Wire up zoom controls.
   - Display loading state and error states.
4. **Link Annotation Overlay** - After rendering each page, parse `/Annots` for link annotations. Create positioned `<a>` elements over link rectangles with `target="_blank" rel="noopener noreferrer"`. Sanitize URI schemes.

**Input:** URL query parameter `?file=<path>`.
**Output:** A fully functional PDF viewer page that can be served as static files and embedded in the Gogs iframe.

**Definition of done:**
- `viewer.html?file=/user/repo/raw/branch/file.pdf` loads and renders the PDF.
- Page navigation (prev/next/jump) works correctly with bounds checking.
- Zoom (fit-width default, manual zoom levels) works and re-renders at appropriate resolution.
- Loading indicator shows during fetch.
- Errors display user-friendly messages for: fetch failure, invalid PDF, parse error, render error.
- Link annotations are clickable with safe `target="_blank"` + `rel="noopener noreferrer"`.
- Internal GoTo links navigate to the correct page.
- Viewer works correctly inside the Gogs iframe (no title changes, no history manipulation, no iframe breakout).
- Cross-origin URLs are rejected.
- `javascript:`, `data:`, and other dangerous URL schemes are rejected.

---

### Phase 4: Integration and Testing
**Agent:** `phase-4`
**Scope:** Integrate the custom viewer into Gogs, run the full test matrix, and perform security audits.

**Sub-phases:**

#### Phase 4a: Gogs Integration
- Update `templates/repo/view_file.tmpl` to reference `custom-pdf-render` instead of `pdfjs-1.4.20`.
- Verify the static file serving path works (the `public/plugins/custom-pdf-render/` directory is served by macaron's static middleware at `internal/cmd/web.go:89-95`).
- Test with `AppSubURL` configured (subpath deployment).

#### Phase 4b: Functional Testing
- Run the full test matrix (P01-P10, R01-R13, V01-V05, S01-S06) against all test corpus PDFs.
- Test all producer types: pdflatex, LuaLaTeX, Word, Google Docs, TikZ, matplotlib, scanned, browser-print.
- Verify link annotations work correctly (from `links.pdf`).

#### Phase 4c: Security Audit
- Verify JS stripping (S01): embedded JavaScript never executes.
- Verify URI sanitization (S02): only `http`, `https`, `mailto` schemes allowed.
- Verify dangerous action blocking (S03): Launch, SubmitForm, ImportData actions blocked.
- Verify malformed/corrupt resilience (S04): no crash/hang on malformed inputs.
- Verify guardrails/limits (S05): depth, object count, stream size, timeout limits enforced.
- Verify DOM/network safety (S06): no `eval()`, no `innerHTML` with unsanitized content, no unauthorized network calls, no DOM clobbering.
- Code review for: prototype pollution, ReDoS, buffer overflows in typed arrays, XSS via PDF string content.

#### Phase 4d: Regression and Edge Cases
- Test PDFs with: empty pages, zero-length streams, missing resources, very large page counts, unusual MediaBox values, rotated pages, incremental updates.
- Test with network conditions: slow load, interrupted load, 404 for PDF URL.
- Test the `EscapePound` encoding: PDFs with `#`, `%`, `?`, and spaces in filenames.

**Definition of done:**
- All test matrix items (P01-P10, R01-R13, V01-V05, S01-S06) pass.
- The template change is a one-line path swap.
- No external dependencies in the final output.
- All files are self-contained static assets under `public/plugins/custom-pdf-render/`.
- The viewer works in major browsers (Chrome, Firefox, Safari, Edge).

---

## File Structure

The final `public/plugins/custom-pdf-render/` directory should contain:

```
public/plugins/custom-pdf-render/
  web/
    viewer.html          # Entry point (loaded in iframe)
    viewer.css           # Viewer styles
    viewer.js            # Entry point script: URL parsing, fetch, UI controls
  lib/
    pdf-parser.js        # Phase 1: binary parser, xref, object store
    pdf-security.js      # Phase 1: security filter, action stripping
    pdf-renderer.js      # Phase 2a: content stream interpreter, text/vector rendering
    pdf-fonts.js         # Phase 2a: standard font metrics, encoding maps
    pdf-images.js        # Phase 2b: image decoding, masks, inline images
    pdf-shading.js       # Phase 2b: gradient/shading support
    pdf-stream.js        # Phase 1: stream decoders (Flate, ASCII85, ASCIIHex)
    pdf-annotations.js   # Phase 3: link annotation parsing and overlay
```

All files are vanilla JavaScript (ES2020+). No build step, no bundler, no external dependencies. Files are loaded via `<script>` tags in `viewer.html` or via ES module imports.
