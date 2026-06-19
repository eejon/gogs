# Functional Coherence Evaluation Matrix (v2)

## Purpose

Evaluate the extent to which the custom PDF renderer meets the functional requirements
of PDF.js, scoped to what Gogs (the downstream application) requires.

This evaluation does **not** assess implementation approach or internal code design.
It assesses observable functional outcomes.

## Scoring Guide

| Score | Meaning |
|-------|---------|
| 5 | Fully renders / functions correctly, indistinguishable from PDF.js for this category |
| 4 | Renders / functions correctly with minor cosmetic differences (e.g., slightly different font glyph shapes) |
| 3 | Core content is readable and functional, but noticeable visual or behavioral differences |
| 2 | Partially renders — significant content missing, misplaced, or broken |
| 1 | Attempts to render but output is largely unusable |
| 0 | Fails entirely (crash, blank, or error) |

---

## Section 1: PDF Support Coverage

Scored by **producer type** — how well does the custom renderer handle PDFs from each
source? Producer types are drawn from `tests/corpus/types.md`.

The detailed scoring rubric in Appendix A lists the technical capabilities relevant to
each producer type. Use it when deciding between scores.

| # | Producer Type | Typical PDF Characteristics | Weight | Score | Weighted | Corpus Files |
|---|--------------|----------------------------|--------|-------|----------|--------------|
| 1.1 | pdflatex | Type1 font subsets (CMR, CMBX, CMSS), custom encodings, /Differences arrays | 5 | _/5 | | |
| 1.2 | XeLaTeX / LuaLaTeX | OpenType/TrueType via CIDFont Type2, Identity-H, /W width arrays | 4 | _/5 | | |
| 1.3 | Microsoft Word / LibreOffice Writer | TrueType subsets (Calibri, Liberation), WinAnsiEncoding, simple /Widths | 5 | _/5 | | |
| 1.4 | Google Docs export | Similar to Word; simple structure, standard fonts | 4 | _/5 | | |
| 1.5 | TikZ / pgf (via pdflatex) | Heavy path operators (m/l/c), clipping (W), nested Form XObjects | 4 | _/5 | | |
| 1.6 | Matplotlib / R ggplot | Many short path segments, rotated text matrices, sometimes Type3 fonts | 3 | _/5 | | |
| 1.7 | Scanner / OCR output | JPEG (DCTDecode) for color scans, raster-heavy, minimal text | 4 | _/5 | | |
| 1.8 | Browser "Print to PDF" (Chrome/Firefox) | Full-page raster images or fragmented text runs, DCTDecode | 4 | _/5 | | |
| **Section max** | | | **33** | | **/165** | |

> **Note**: Inkscape / Adobe Illustrator export (type 6 in `types.md`) is marked [Skipped]
> and is excluded from this evaluation.

### How to Score Section 1

For each producer type:
1. Select representative PDFs from `tests/corpus/` (record which files in the Corpus Files column).
2. Render in both PDF.js and the custom renderer side-by-side.
3. Score based on how well the custom renderer's output matches PDF.js's output for that document.
4. Consult Appendix A to understand *why* a particular PDF may render differently — the appendix
   maps producer characteristics to the underlying capabilities they exercise.

---

## Section 2: Downstream Integration & UI

Scored by **observable behavior** — does the custom renderer integrate with Gogs and
provide the UI functionality that PDF.js provides within the embedded iframe context?

| # | Feature | Description | Weight | Score | Weighted |
|---|---------|-------------|--------|-------|----------|
| 2.1 | Iframe embed via `?file=` param | Gogs embeds the viewer in an iframe with a `?file=` query parameter pointing to the raw PDF URL. The viewer must accept this and load the PDF. | 5 | _/5 | |
| 2.2 | Template path swap | Replacing `pdfjs-1.4.20` with `custom-pdf-render` in `view_file.tmpl:84` is the only change required in Gogs. | 5 | _/5 | |
| 2.3 | Static file serving | Served as static files by Gogs with no server-side runtime dependencies. | 5 | _/5 | |
| 2.4 | Page navigation | Previous / next page buttons and direct page number input, with bounds checking. | 5 | _/5 | |
| 2.5 | Zoom controls | Zoom in / out with fit-width as default. Fit-page and preset zoom levels available. | 4 | _/5 | |
| 2.6 | Loading indicator | Visual feedback while the PDF is being fetched and parsed. | 3 | _/5 | |
| 2.7 | Error display | User-facing error message when a PDF fails to load or parse. | 4 | _/5 | |
| 2.8 | Multi-page scroll | Scroll through all pages within the 600px iframe. Pages render on scroll (lazy rendering). | 4 | _/5 | |
| 2.9 | Page rotation handling | PDFs with /Rotate entries (90/180/270) display in correct orientation. | 4 | _/5 | |
| 2.10 | Iframe-safe behavior | No iframe breakout, no `window.top` manipulation, no browser history modification. | 5 | _/5 | |
| 2.11 | Responsive to container resize | Viewer adapts when Gogs layout or browser window changes size. | 3 | _/5 | |
| 2.12 | Link annotations | Clickable links open in new tab with `target="_blank"` and `rel="noopener noreferrer"`. Internal GoTo links navigate within the viewer. | 4 | _/5 | |
| **Section max** | | | **51** | | **/255** | |

---

## Section 3: Security (Functional Parity)

Scoped to security behaviors that **PDF.js also exhibits**. The question is: does the custom
renderer achieve the same security outcomes as PDF.js for the Gogs use case?

Features that are *new* in the custom implementation (e.g., explicit resource limits,
action allowlists, decompression caps) are **not scored here**. They belong in a separate
security posture evaluation — see the note below.

| # | Behavior | How PDF.js achieves it | Weight | Score | Weighted |
|---|----------|----------------------|--------|-------|----------|
| 3.1 | URL origin validation | `validateFileURL()` in viewer.js restricts loading to same-origin | 5 | _/5 | |
| 3.2 | Embedded JavaScript never executes | PDF.js does not implement a JS interpreter; /JS entries are ignored | 5 | _/5 | |
| 3.3 | Dangerous actions not available | PDF.js does not implement Launch, SubmitForm, ImportData, or other risky action types | 5 | _/5 | |
| 3.4 | External links open safely | PDF.js sets `externalLinkTarget` to open links in new tab, preventing navigation hijack | 4 | _/5 | |
| 3.5 | Malformed PDF resilience | PDF.js handles corrupt / truncated / malformed PDFs with error messages rather than crashes or hangs | 5 | _/5 | |
| 3.6 | No unauthorized network requests | Beyond fetching the PDF itself, neither viewer makes additional network calls | 4 | _/5 | |
| **Section max** | | | **28** | | **/140** | |

> **Separate evaluation recommended**: The custom implementation introduces explicit
> defense-in-depth mechanisms not present in PDF.js — including a `ResourceTracker` with
> documented limits (max objects, decompression ceiling, timeout), an action type allowlist,
> `sanitizeStringForDOM()`, circular reference detection, and max page dimension enforcement.
> These are strengths of the custom implementation but do not have a PDF.js baseline to
> compare against, so they should be assessed in a standalone security posture study rather
> than a functional coherence evaluation.

---

## Overall Summary

| Section | Weight Total | Max Weighted | Weighted Score | % |
|---------|-------------|--------------|----------------|---|
| 1. PDF Support Coverage | 33 | 165 | | |
| 2. Downstream Integration & UI | 51 | 255 | | |
| 3. Security (Functional Parity) | 28 | 140 | | |
| **Total** | **112** | **560** | | |

---

## Section 4: Viability Metrics

Not scored on the 0-5 scale. Quantitative measurements that contextualize whether
the replacement is a net reduction in supply-chain risk and maintenance burden.

| # | Metric | PDF.js (pdfjs-1.4.20) | Custom Renderer | Delta |
|---|--------|----------------------|-----------------|-------|
| 4.1 | Lines of code (JS + CSS + HTML) | 64,116 | 10,605 | -53,511 (83.5% reduction) |
| 4.2 | File count (all files under plugin dir) | 92 | 11 | -81 (88.0% reduction) |
| 4.3 | External runtime dependencies | 0 | 0 | 0 |
| 4.4 | Externally maintained projects bundled | 1 (Mozilla PDF.js) | 0 | -1 |
| 4.5 | Upstream dependency chain depth | 1 (PDF.js -> Gogs) | 0 (in-house) | -1 |
| 4.6 | Known CVEs in bundled version | ___ | 0 (new code) | |
| 4.7 | Requires build step | No | No | Parity |
| 4.8 | Browser polyfill layer | Yes (compatibility.js, 593 LOC) | No | -593 LOC |

---

## Appendix A: Scoring Rubric — PDF Capability Details

Reference material for evaluators when scoring Section 1. Maps producer types to the
underlying PDF capabilities they exercise, so evaluators understand *why* a PDF may
render well or poorly.

### A.1 Parsing & Document Structure

These capabilities are exercised by all producer types. If any of these fail, the PDF
will not render at all (score 0).

| Capability | Relevant Producer Types |
|-----------|------------------------|
| Traditional xref table parsing | All |
| Xref stream parsing (PDF 1.5+) | Modern producers (Word, Chrome, Google Docs) |
| FlateDecode (deflate decompression) | All (nearly universal) |
| ASCIIHexDecode / ASCII85Decode | Older producers (rare) |
| PNG predictor support | Flate-compressed images from most producers |
| Page tree traversal + property inheritance | Multi-page documents from all producers |
| Object streams | Modern producers |

### A.2 Text Rendering

| Capability | Relevant Producer Types | Impact if Missing |
|-----------|------------------------|-------------------|
| Standard 14 font width tables | pdflatex, simple documents | Text spacing breaks |
| Font encoding (WinAnsi/MacRoman/Standard) | Word, LibreOffice, pdflatex | Wrong characters displayed |
| /Differences arrays | pdflatex (custom encodings) | Glyph substitution errors in LaTeX docs |
| ToUnicode CMap parsing | XeLaTeX/LuaLaTeX, Word | Wrong characters for CID fonts |
| CIDFont /W width arrays | XeLaTeX/LuaLaTeX | Text spacing breaks for CJK / OpenType |
| CSS font fallback mapping | All (when embedded fonts aren't parsed) | Glyph shapes differ, but text remains readable |
| Embedded font program parsing | All with non-standard fonts | Glyph shapes fall back to system fonts |
| Type3 font rendering | Matplotlib (math labels) | Math symbols may not render |
| Text positioning (Tm/Td/TD/T*) | All | Text drift / overlap |
| Character and word spacing (Tc/Tw) | Word, LaTeX | Subtle spacing errors |

### A.3 Vector Graphics

| Capability | Relevant Producer Types | Impact if Missing |
|-----------|------------------------|-------------------|
| Path operators (m/l/c/v/y/h/re) | TikZ, Matplotlib, Illustrator | Diagrams/charts don't render |
| Paint operators (stroke/fill/clip) | TikZ, Matplotlib | Shapes missing or unfilled |
| Clipping paths (W/W*) | TikZ, complex layouts | Content bleeds outside expected bounds |
| Graphics state (q/Q/cm) | All with transforms | Mispositioned elements |
| Color operators (all device color spaces) | All | Wrong colors |
| CMYK color handling | Print-oriented producers | Colors shift |
| ExtGState alpha (ca/CA) | Documents with transparency | Missing transparency effects |
| Form XObject rendering | TikZ (reusable elements), complex layouts | Repeated diagram elements missing |
| Soft mask compositing | Transparency groups | Visual artifacts |

### A.4 Images

| Capability | Relevant Producer Types | Impact if Missing |
|-----------|------------------------|-------------------|
| JPEG passthrough (DCTDecode) | Scanner/OCR, Chrome print-to-PDF | Photos/scans don't display |
| Flate-compressed images + predictors | Most producers | Embedded graphics missing |
| BPC 1/2/4/8 unpacking | Various (1-bit for B&W scans) | Tonal/palette corruption |
| DeviceGray / RGB images | All | Images missing or wrong color |
| DeviceCMYK images | Print-oriented producers | Image color shift |
| Indexed (palette) color space | GIF-like embedded images | Wrong colors |
| Stencil masks (/ImageMask) | Documents with masked graphics | Mask shapes missing |
| Soft masks (/SMask on images) | Documents with image transparency | Transparency lost |
| Inline images (BI/ID/EI) | Some producers for small images | Small embedded images missing |

### A.5 Shading & Gradients

| Capability | Relevant Producer Types | Impact if Missing |
|-----------|------------------------|-------------------|
| Type 2 (axial/linear) gradients | Illustrator, some LaTeX packages | Gradients render as flat color |
| Type 3 (radial) gradients | Illustrator, presentations | Gradients render as flat color |
| Mesh shadings (types 4-7) | Advanced vector graphics (rare) | Complex gradients missing |
