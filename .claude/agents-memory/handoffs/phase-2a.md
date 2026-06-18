# Phase 2a Handoff: Core Page Rendering Engine

## What Was Built

Two library files implementing the core page rendering engine for the custom PDF renderer:

### Files

| File | Purpose | Lines |
|------|---------|-------|
| `public/plugins/custom-pdf-render/lib/pdf-fonts.js` | Font metrics, encoding tables, ToUnicode CMap, font resolution | ~580 |
| `public/plugins/custom-pdf-render/lib/pdf-renderer.js` | Content stream tokenizer, graphics state, text/path/color rendering, Form XObjects | ~1020 |
| `tests/test-runner.js` | Test suite (125 tests total: 81 Phase 1 + 44 Phase 2a, all passing) | ~950 |

## Public Interface

### PDFFonts (pdf-fonts.js)

```javascript
// Encoding tables
PDFFonts.getEncoding(name); // 'WinAnsiEncoding' | 'MacRomanEncoding' | 'StandardEncoding'
// -> Array[256] mapping byte code -> Unicode code point

PDFFonts.applyDifferences(baseEncoding, differencesArray);
// differencesArray: [code, 'glyphName', 'glyphName', code, 'glyphName', ...]
// -> Array[256] with substituted entries

PDFFonts.glyphNameToUnicode(name);
// -> Unicode code point (number) or null
// Handles named glyphs (e.g., 'endash'), uniXXXX format, /gXXXX format

// Font metrics
PDFFonts.getStandardFontMetrics(fontName);
// -> { widths: {charCode: width}, defaultWidth: number, css: string, weight: string, style: string }
// Returns null if not a standard 14 font

PDFFonts.getCSSFontFamily(fontName);
// -> CSS font-family string (e.g., '"Helvetica", "Arial", sans-serif')
// Handles subset prefixes (ABCDEF+FontName), aliases, LaTeX CM fonts

PDFFonts.getCSSFontWeight(fontName); // -> 'normal' | 'bold'
PDFFonts.getCSSFontStyle(fontName);  // -> 'normal' | 'italic' | 'oblique'

// ToUnicode CMap parsing
PDFFonts.parseToUnicodeCMap(cmapData);
// cmapData: string or Uint8Array
// -> { charCode: unicodeString, ... }
// Handles beginbfchar/endbfchar, beginbfrange/endbfrange, multi-byte output

// Font resolution (main entry point for font setup)
PDFFonts.resolveFont(fontDict, pdfDoc);
// fontDict: the PDF font dictionary (with Subtype, BaseFont, Encoding, Widths, etc.)
// pdfDoc: PDFDocument instance for resolving indirect references
// -> {
//   name: string,
//   subtype: string ('Type1'|'TrueType'|'Type0'|'Type3'|'MMType1'|'CIDFontType0'|'CIDFontType2'),
//   encoding: Array[256] or null,
//   widths: { charCode: width },
//   defaultWidth: number,
//   toUnicode: { charCode: unicodeString } or null,
//   cssFamily: string,
//   cssWeight: string,
//   cssStyle: string,
//   isComposite: boolean,
//   isTwoByteEncoding: boolean
// }

PDFFonts.getCharWidth(fontInfo, charCode);   // -> width in 1/1000 units
PDFFonts.charCodeToUnicode(fontInfo, charCode); // -> Unicode string
PDFFonts.createDefaultFont(); // -> fontInfo for Helvetica/WinAnsiEncoding
```

### PDFRenderer (pdf-renderer.js)

```javascript
// Main rendering entry point
PDFRenderer.renderPage(pdfDoc, pageNum, canvas, scale);
// pdfDoc: PDFDocument instance (parsed)
// pageNum: 1-based page number
// canvas: HTMLCanvasElement (or MockCanvas for testing)
// scale: number (1.0 = 100%)
// -> { width: number, height: number } (canvas dimensions after rendering)
//
// Sets canvas.width and canvas.height, then draws page content.
// Handles MediaBox/CropBox, Rotate (0/90/180/270), coordinate transforms.

// Content stream tokenization
PDFRenderer.tokenizeContentStream(data);
// data: Uint8Array of raw content stream bytes
// -> Array of { op: string, args: Array }
// Parses all PDF content stream tokens: numbers, literal strings (Uint8Array),
// hex strings (Uint8Array), names (string), arrays, dictionaries, inline images.
// Enforces MAX_OPERATOR_COUNT (200000).

// Graphics state
PDFRenderer.GraphicsState;
// Constructor: new PDFRenderer.GraphicsState()
// Properties: ctm, fillColor, strokeColor, fillColorSpace, strokeColorSpace,
//   fillColorComponents, strokeColorComponents, lineWidth, lineCap, lineJoin,
//   miterLimit, dashArray, dashPhase, font, fontSize, charSpacing, wordSpacing,
//   horizontalScaling, leading, renderMode, rise, textMatrix, textLineMatrix,
//   fillAlpha, strokeAlpha, blendMode, clip
// Methods: clone()

// Matrix math
PDFRenderer.multiplyMatrix(m1, m2);
// -> [a,b,c,d,e,f] = m1 * m2 (post-multiplication per PDF spec)

PDFRenderer.transformPoint(matrix, x, y);
// -> [transformedX, transformedY]

// Color utilities
PDFRenderer.colorToCSS(colorSpace, components);
// colorSpace: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK' | 'Pattern'
// components: number[] (1 for gray, 3 for RGB, 4 for CMYK)
// -> CSS color string like 'rgb(R,G,B)'

PDFRenderer.resolveColorSpace(csName, resources, pdfDoc);
// csName: string or array (e.g., 'DeviceRGB', ['ICCBased', streamRef])
// -> { type: string, numComponents: number, baseCS?: object, lookup?: Uint8Array }
// Handles: DeviceGray, DeviceRGB, DeviceCMYK, CalGray, CalRGB,
//   ICCBased (falls back by /N), Indexed, Separation, DeviceN, Pattern
```

### Module System

Both files export via `module.exports` (Node.js) and `window.*` (browser):
- `window.PDFFonts` / `require('./pdf-fonts.js')`
- `window.PDFRenderer` / `require('./pdf-renderer.js')`

In Node.js, `pdf-renderer.js` requires `pdf-parser.js`, `pdf-stream.js`, `pdf-security.js`, and `pdf-fonts.js`.
In browser, load via `<script>` tags in dependency order:
1. pdf-stream.js
2. pdf-security.js
3. pdf-parser.js
4. pdf-fonts.js
5. pdf-renderer.js

## Assumptions Made

1. **Canvas text rendering**: Text is rendered using `ctx.fillText()` / `ctx.strokeText()` with the text matrix applied via `ctx.transform()`. The y-axis is locally flipped with `ctx.scale(1, -1)` before each text draw call because PDF text coordinates increase upward while canvas text renders downward.

2. **Font sizing**: Font size on canvas is set as `fontSize * horizontalScaling / 100` in the CSS font string. The text matrix handles the rest of the transform. Character advance is computed from font width tables (in 1/1000 units) scaled by fontSize / 1000.

3. **Image placeholders**: Image XObjects are rendered as gray rectangles with a placeholder cross pattern. Phase 2b is expected to implement actual image decoding (JPEG, PNG embedded in PDF, inline images).

4. **Inline image rendering**: Inline images (BI/ID/EI) are tokenized and their raw data is captured, but they are not rendered. Phase 2b will handle this.

5. **Form XObject recursion**: Form XObjects are rendered by recursively interpreting their content stream with merged resources. A recursion depth limit (50) prevents infinite loops. Form resources override parent resources; parent resources provide fallback for keys not present in the form.

6. **Color space fallback**: ICCBased color spaces fall back to DeviceGray (N=1), DeviceRGB (N=3), or DeviceCMYK (N=4) based on the /N value. Indexed color spaces are resolved by looking up the index in the lookup table. Separation and DeviceN color spaces fall back to DeviceGray.

7. **Encoding priority**: When resolving a font's encoding, the priority order is: (1) /Encoding dict with /BaseEncoding + /Differences, (2) /Encoding as a name string, (3) standard encoding for the base font. For Type0/CIDFont composite fonts, character codes are treated as two-byte values when the CMap is Identity-H or Identity-V.

8. **CIDFont widths**: The /W array in CIDFont descriptors is parsed supporting both the `[cid [w1, w2, ...]]` format and the `[cidFirst cidLast width]` range format. Missing widths fall back to /DW (default width) or 1000.

9. **LaTeX font mapping**: Computer Modern fonts (CMBX10, CMR10, CMSY10, etc.) are mapped to Times New Roman / serif CSS families with appropriate weight/style. CMSS* fonts map to Helvetica/sans-serif.

## Known Gaps / Deferred Decisions

1. **Image rendering**: Image XObjects and inline images are NOT rendered -- they show gray placeholders. Phase 2b must implement:
   - JPEG image decoding (DCTDecode)
   - Raw image data rendering (uncompressed or FlateDecode)
   - Color space application to image data
   - Image masks and soft masks (/SMask)
   - Inline image rendering (BI/ID/EI)

2. **Shading patterns**: The `sh` operator is a no-op placeholder. Phase 2b must implement:
   - Axial shading (Type 2)
   - Radial shading (Type 3)
   - Other shading types as needed

3. **Type3 fonts**: d0 and d1 operators are recognized but Type3 font glyph rendering (executing a content stream per glyph) is not implemented. Characters fall back to the canvas font.

4. **Exact current point tracking**: The 'v' curve operator (initial control point equals current point) approximates the current point from the provided control point coordinates rather than tracking the exact path state. This could produce slight visual differences for paths using 'v' after curves.

5. **Pattern color spaces**: The Pattern color space is recognized but pattern rendering (tiling patterns, shading patterns) is not implemented.

6. **Text extraction**: The rendering pipeline draws text to canvas but does not expose a text extraction API. If text selection/copy is needed in the viewer, the text positions would need to be collected during rendering.

7. **CMap file references**: Predefined CMap names (e.g., 'UniJIS-UCS2-H') referenced in /Encoding of Type0 fonts are not resolved from external CMap files. Only Identity-H and Identity-V are handled as special cases.

8. **Blend modes**: Canvas `globalCompositeOperation` is set from PDF blend modes where there's a direct mapping. Some PDF blend modes (e.g., ColorDodge, ColorBurn, Hue, Saturation, Color, Luminosity) may not be supported by all canvas implementations.

## Test Results

All 125 tests pass:

### Phase 1 tests (81 tests, unchanged)
- P01: URL policy (10)
- P02: Binary fetch (4)
- P03: Header (3)
- P04/P05: Cross-reference (2)
- P06: Trailer/catalog (3)
- P07: Object resolution (3)
- P08: FlateDecode (4)
- P09: ASCIIHex/ASCII85 (6)
- P10: Page tree (4)
- S01: JS stripping (5)
- S02: URI sanitization (8)
- S03: Action blocking (8)
- S04: Malformed resilience (3)
- S05: Guardrails (7)
- S06: DOM/network safety (4)
- Links PDF (2)
- PNG Predictor (3)
- String conversion (2)

### Phase 2a tests (44 tests, new)
- R01: Standard font metrics (6)
- R02: Encoding resolution (6)
- R03: ToUnicode CMap parsing (4)
- R04: Font resolution (5)
- R05: Content stream tokenization (6)
- R06: Graphics state management (3)
- R07: Color space and color conversion (6)
- R08: Rendering pipeline (8)

### Corpus rendering results
All 8 corpus PDFs render page 1 without crashing:
- `1&5-arXiv-Latex.pdf` - renders (LaTeX/Type1 fonts resolved)
- `2-lualatex.pdf` - renders (CIDFont/Type0 composite fonts resolved)
- `3-word-docx.pdf` - renders (TrueType/CIDFont fonts resolved)
- `4-google-doc.pdf` - renders (produces fillText calls for text content)
- `7-matplotlib-charts.pdf` - renders (path operators for charts)
- `8-scanned.pdf` - renders (image placeholders shown)
- `9-browser-print.pdf` - renders (browser-generated PDF)
- `links.pdf` - renders (text with link annotations)
