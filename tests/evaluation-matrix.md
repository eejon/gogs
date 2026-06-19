# Feature Coverage Evaluation Matrix

## Scoring Guide

| Score | Meaning |
|-------|---------|
| 5 | Full implementation, production quality, handles edge cases |
| 4 | Substantially complete, minor gaps that rarely affect real PDFs |
| 3 | Core functionality works, notable limitations visible in some documents |
| 2 | Partial implementation, significant gaps affecting common documents |
| 1 | Minimal/stub, present but not functionally useful |
| 0 | Not implemented |

**Weight** reflects importance to Gogs' embedded PDF viewing use case (1 = nice-to-have, 5 = critical).

**Weighted score** = Weight x Score. Maximum possible total noted per section.

---

## Section 1: Parsing & Document Structure

| # | Feature | Weight | Score | Weighted | Notes |
|---|---------|--------|-------|----------|-------|
| 1.1 | PDF header/version validation (`%PDF-` magic) | 5 | _/5 | | `pdf-parser.js:580-611` |
| 1.2 | Traditional xref table parsing | 5 | _/5 | | `pdf-parser.js:702-850` |
| 1.3 | Xref stream parsing (PDF 1.5+) | 4 | _/5 | | `pdf-parser.js:851-1016` |
| 1.4 | Trailer / root / catalog resolution | 5 | _/5 | | `pdf-parser.js` trailer chain with `/Prev` following (depth limit 20) |
| 1.5 | Indirect object and reference resolution | 5 | _/5 | | Cycle detection included |
| 1.6 | Object streams (`/ObjStm`) | 3 | _/5 | | `pdf-parser.js:1193-1258` |
| 1.7 | FlateDecode (zlib/deflate) | 5 | _/5 | | Custom RFC 1951 inflate at `pdf-stream.js:178-601` |
| 1.8 | ASCIIHexDecode | 2 | _/5 | | `pdf-stream.js` |
| 1.9 | ASCII85Decode | 2 | _/5 | | `pdf-stream.js` |
| 1.10 | RunLengthDecode | 2 | _/5 | | `pdf-stream.js` |
| 1.11 | PNG predictor support (Sub/Up/Average/Paeth) | 4 | _/5 | | `pdf-stream.js` - used by Flate images |
| 1.12 | Page tree traversal + property inheritance | 5 | _/5 | | Resources, MediaBox, Rotate inherited down tree |
| 1.13 | PDFDocEncoding / UTF-16BE string handling | 3 | _/5 | | For metadata and text strings |
| **Section max** | | **50** | | **/250** | |

---

## Section 2: Text Rendering

| # | Feature | Weight | Score | Weighted | Notes |
|---|---------|--------|-------|----------|-------|
| 2.1 | Text show operators (Tj / TJ / ' / ") | 5 | _/5 | | `pdf-renderer.js:1025-1582` |
| 2.2 | Text positioning (Tm / Td / TD / T*) | 5 | _/5 | | Text matrix and line matrix handling |
| 2.3 | Font size and scaling (Tf / Tz / TL / Tc / Tw) | 4 | _/5 | | Character/word spacing, leading, horizontal scaling |
| 2.4 | Standard 14 font width tables | 5 | _/5 | | `pdf-fonts.js:349-457` — all 14 fonts |
| 2.5 | Font encoding maps (WinAnsi / MacRoman / Standard) | 4 | _/5 | | `pdf-fonts.js:29-218` |
| 2.6 | /Differences array handling | 4 | _/5 | | `pdf-fonts.js:629-656` |
| 2.7 | ToUnicode CMap parsing | 4 | _/5 | | `pdf-fonts.js:709-777` — regex-based bfchar/bfrange |
| 2.8 | CIDFont /W width arrays | 3 | _/5 | | `pdf-fonts.js:1026-1100` |
| 2.9 | CSS font family fallback mapping | 3 | _/5 | | `pdf-fonts.js:513-560` — heuristic keyword matching |
| 2.10 | Embedded font program parsing (Type1/TrueType/CFF) | 3 | _/5 | | **Not implemented** — relies on system font fallback |
| 2.11 | Type3 font glyph rendering | 2 | _/5 | | `pdf-renderer.js:2294-2466` — content stream per glyph |
| 2.12 | Text rendering at correct positions (no drift/overlap) | 5 | _/5 | | 100px trick at `pdf-renderer.js:1784-1901` |
| **Section max** | | **47** | | **/235** | |

---

## Section 3: Vector Graphics

| # | Feature | Weight | Score | Weighted | Notes |
|---|---------|--------|-------|----------|-------|
| 3.1 | Path construction (m / l / c / v / y / h / re) | 4 | _/5 | | `pdf-renderer.js` content stream ops |
| 3.2 | Paint operators (S / s / f / F / f* / B / B* / b / b* / n) | 4 | _/5 | | Stroke, fill, even-odd, combined |
| 3.3 | Clipping paths (W / W*) | 3 | _/5 | | Nonzero and even-odd clipping |
| 3.4 | Graphics state save/restore (q / Q) | 5 | _/5 | | Stack-based |
| 3.5 | CTM manipulation (cm) | 5 | _/5 | | Affine transforms |
| 3.6 | Stroke style (w / J / j / M / d) | 3 | _/5 | | Line width, cap, join, miter, dash |
| 3.7 | Color: DeviceGray (g / G) | 4 | _/5 | | |
| 3.8 | Color: DeviceRGB (rg / RG) | 4 | _/5 | | |
| 3.9 | Color: DeviceCMYK (k / K) | 3 | _/5 | | Simple (1-C)(1-K) conversion, not ICC |
| 3.10 | Color: cs / CS / sc / SC / scn / SCN | 3 | _/5 | | Named/pattern color space operators |
| 3.11 | ExtGState: fill/stroke alpha (ca / CA) | 3 | _/5 | | `pdf-renderer.js` |
| 3.12 | ExtGState: blend mode (BM) | 2 | _/5 | | |
| 3.13 | Form XObject rendering (Do) | 4 | _/5 | | `pdf-renderer.js:1968-2051` — recursive, depth limit 20 |
| 3.14 | Soft mask compositing (SMask on ExtGState) | 2 | _/5 | | `pdf-renderer.js:2053-2231` — offscreen pixel compositing |
| **Section max** | | **49** | | **/245** | |

---

## Section 4: Image Handling

| # | Feature | Weight | Score | Weighted | Notes |
|---|---------|--------|-------|----------|-------|
| 4.1 | JPEG passthrough (DCTDecode) | 5 | _/5 | | `pdf-images.js:98-99` — Blob URL to browser |
| 4.2 | Flate-compressed images | 4 | _/5 | | With predictor support |
| 4.3 | BPC unpacking (1 / 2 / 4 / 8 bit) | 4 | _/5 | | `pdf-images.js` |
| 4.4 | DeviceGray images | 4 | _/5 | | |
| 4.5 | DeviceRGB images | 4 | _/5 | | |
| 4.6 | DeviceCMYK images | 3 | _/5 | | Approximate conversion |
| 4.7 | Indexed (palette) color space | 3 | _/5 | | |
| 4.8 | Stencil masks (/ImageMask) | 3 | _/5 | | |
| 4.9 | Soft masks (/SMask on image) | 3 | _/5 | | |
| 4.10 | Color key masks (/Mask array) | 2 | _/5 | | |
| 4.11 | Inline images (BI / ID / EI) | 3 | _/5 | | `pdf-renderer.js:608-710` |
| 4.12 | Image placement (position, scale, transform) | 4 | _/5 | | Via CTM |
| **Section max** | | **42** | | **/210** | |

---

## Section 5: Shading & Gradients

| # | Feature | Weight | Score | Weighted | Notes |
|---|---------|--------|-------|----------|-------|
| 5.1 | Type 2 (axial/linear) gradient | 3 | _/5 | | `pdf-shading.js` — Canvas gradient API |
| 5.2 | Type 3 (radial) gradient | 2 | _/5 | | `pdf-shading.js` |
| 5.3 | Mesh shadings (types 4-7) graceful fallback | 1 | _/5 | | Fallback only, not rendered |
| **Section max** | | **6** | | **/30** | |

---

## Section 6: Annotations & Interactivity

| # | Feature | Weight | Score | Weighted | Notes |
|---|---------|--------|-------|----------|-------|
| 6.1 | Link annotations (URI / external) | 4 | _/5 | | `pdf-annotations.js:35-100` |
| 6.2 | GoTo annotations (internal page jump) | 3 | _/5 | | |
| 6.3 | Safe link rendering (`target="_blank"`, `rel="noopener noreferrer"`) | 4 | _/5 | | |
| 6.4 | Annotation action allowlisting | 4 | _/5 | | `pdf-security.js:168-188` — only URI + GoTo |
| **Section max** | | **15** | | **/75** | |

---

## Section 7: Viewer UI (Gogs Integration)

| # | Feature | Weight | Score | Weighted | Notes |
|---|---------|--------|-------|----------|-------|
| 7.1 | `?file=` URL query parameter entry point | 5 | _/5 | | `viewer.html` / `viewer.js:12-13` |
| 7.2 | PDF fetch as ArrayBuffer | 5 | _/5 | | |
| 7.3 | Page navigation (prev / next / page input) | 5 | _/5 | | `viewer.js` |
| 7.4 | Fit-width default zoom | 4 | _/5 | | `viewer.js:34` |
| 7.5 | Zoom presets and fit-page | 3 | _/5 | | `viewer.html:40-52` |
| 7.6 | Loading indicator | 4 | _/5 | | |
| 7.7 | Error display (user-facing message) | 4 | _/5 | | |
| 7.8 | Lazy / scroll-based page rendering | 4 | _/5 | | `viewer.js:390-416` |
| 7.9 | Keyboard shortcuts | 2 | _/5 | | |
| 7.10 | Page rotation support | 4 | _/5 | | 0/90/180/270 in rendering pipeline |
| 7.11 | Iframe-safe behavior (no breakout, no history manipulation) | 5 | _/5 | | |
| 7.12 | Debounced resize/scroll handling | 3 | _/5 | | |
| **Section max** | | **48** | | **/240** | |

---

## Section 8: Security

| # | Feature | Weight | Score | Weighted | Notes |
|---|---------|--------|-------|----------|-------|
| 8.1 | Same-origin URL validation | 5 | _/5 | | `pdf-security.js:57-108` |
| 8.2 | URI scheme allowlist (http/https/mailto only) | 5 | _/5 | | `pdf-security.js:117-158` |
| 8.3 | Embedded JavaScript stripping (never eval /JS) | 5 | _/5 | | `pdf-security.js:317-354` |
| 8.4 | Dangerous action blocking (Launch/SubmitForm/ImportData) | 5 | _/5 | | `pdf-security.js:168-188` |
| 8.5 | Resource limits (max objects, depth, decompression, timeout) | 5 | _/5 | | `pdf-security.js:17-30` |
| 8.6 | Circular reference / cycle detection | 4 | _/5 | | In parser and renderer |
| 8.7 | DOM safety (no innerHTML, string sanitization) | 5 | _/5 | | `pdf-security.js:477-482` |
| 8.8 | Max page dimension enforcement | 3 | _/5 | | 14400pt limit |
| 8.9 | Malformed/corrupt PDF resilience (no crash/hang) | 5 | _/5 | | Structured errors, graceful degradation |
| **Section max** | | **42** | | **/210** | |

---

## Section Summary

| Section | Weight Total | Max Weighted | Your Weighted Score | % |
|---------|-------------|--------------|---------------------|---|
| 1. Parsing & Document Structure | 50 | 250 | | |
| 2. Text Rendering | 47 | 235 | | |
| 3. Vector Graphics | 49 | 245 | | |
| 4. Image Handling | 42 | 210 | | |
| 5. Shading & Gradients | 6 | 30 | | |
| 6. Annotations & Interactivity | 15 | 75 | | |
| 7. Viewer UI (Gogs Integration) | 48 | 240 | | |
| 8. Security | 42 | 210 | | |
| **Total** | **299** | **1495** | | |

---

## Section 9: Viability Metrics

These are not scored on the same 0-5 scale. They are quantitative measurements that contextualize
whether the replacement is a net reduction in supply-chain risk and maintenance burden.

| # | Metric | PDF.js (pdfjs-1.4.20) | Custom Renderer | Delta | Notes |
|---|--------|----------------------|-----------------|-------|-------|
| 9.1 | Total lines of code (JS + CSS + HTML) | 64,116 | 10,605 | | Include viewer + lib |
| 9.2 | Total file count | 92 | 11 | | All files under plugin dir |
| 9.3 | External runtime dependencies | 0 | 0 | | Both are self-contained |
| 9.4 | Externally maintained projects included | 1 (Mozilla PDF.js) | 0 | | The entire plugin is third-party vs in-house |
| 9.5 | Transitive dependency chain depth | 1 (PDF.js -> Gogs) | 0 | | Custom code has no upstream |
| 9.6 | Known CVEs in bundled version | ___ | 0 (new code) | | Research pdfjs-1.4.20 CVEs |
| 9.7 | Build step required | No (pre-built) | No | | Both servable as static files |
| 9.8 | Browser polyfill layer | Yes (`compatibility.js`, 593 LOC) | No | | Custom targets modern browsers only |

### Interpretation Guide for Section 9

- **9.1-9.2**: Raw reduction in attack surface area and audit scope. Less code = less to review, less to break.
- **9.3-9.5**: Supply chain depth. PDF.js is maintained by Mozilla; Gogs bundles a frozen copy (1.4.20).
  Any vulnerability in PDF.js requires waiting for Mozilla's patch, then updating the bundled copy.
  The custom renderer has no such dependency chain — fixes are applied directly.
- **9.6**: The motivating concern. Document known CVEs affecting the bundled PDF.js version to quantify
  the security debt being eliminated.
- **9.7-9.8**: Operational parity — neither requires a build step, but the custom renderer drops the
  polyfill layer entirely.

---

## How to Use This Matrix

1. **Score each row** by reading the referenced source code and testing against the PDF corpus in `tests/corpus/`.
2. **Compute weighted scores** per row (Weight x Score) and sum per section.
3. **Compute section percentages** (Weighted Score / Max Weighted x 100).
4. **Identify weak spots**: Any row where Score < 3 on a Weight >= 4 feature is a functional gap that
   affects common PDFs and may need remediation.
5. **Overall viability threshold**: Define your own. A suggested starting point:
   - Sections 1, 7, 8 (Parsing, Viewer, Security) should each be >= 80% — these are non-negotiable for Gogs.
   - Sections 2, 3, 4 (Text, Graphics, Images) should each be >= 60% — visual fidelity can tolerate some degradation in an embedded preview context.
   - Sections 5, 6 (Shading, Annotations) are lower priority — >= 40% is acceptable if fallback behavior is graceful.
6. **Section 9** is not scored as a percentage — it provides quantitative evidence for the supply-chain argument.
   The key question it answers: "Does eliminating the external dependency justify the feature coverage gaps identified above?"
