# Phase 2a Handoff: Core Page Rendering Engine

## What Was Built

Three files implementing the core PDF content stream interpreter and canvas rendering engine:

### File: `public/plugins/custom-pdf-render/src/pdf-fonts.js` (~450 lines)
Font handling module. Provides encoding tables, width data, and CSS font mappings.

### File: `public/plugins/custom-pdf-render/src/pdf-images.js` (~370 lines)
Image rendering module. Handles JPEG passthrough, pixel data reconstruction, and canvas drawing.

### File: `public/plugins/custom-pdf-render/src/pdf-renderer.js` (~1100 lines)
Core renderer. Tokenizes content streams, maintains graphics state, and renders text/paths/images to canvas.

---

## Public Interface

### PDFRenderer (from pdf-renderer.js)

```javascript
// In Node.js:
const { PDFRenderer, _parseInlineImageBlock, _getGlyphAdvance1000 } = require('.../pdf-renderer.js');

// In browser: available globally after script load

const renderer = new PDFRenderer();
await renderer.renderPage(canvas, pageData, scale, parser);
```

#### renderPage(canvas, pageData, scale, parser)
- **canvas**: HTMLCanvasElement or mock with getContext('2d'). Width/height will be set.
- **pageData**: A page object from parser.pages[]. Raw dictionary with '/MediaBox', '/Contents', '/Resources', '/Annots', etc.
- **scale**: Number (default 1.0). Multiplied into canvas dimensions and transform.
- **parser**: PDFParser instance. Needed for resolveRef() on indirect references in resources/fonts/images.

#### Internal Methods (exposed for testing and Phase 2b extension)
- `renderer._resolveFontAsync(fontKey, resources)` - Resolve font dict, extract widths/encoding/ToUnicode
- `renderer._drawFormXObject(stream, resources, ctx, gs)` - Render a Form XObject sub-stream
- `renderer._invokeXObject(name, resources, ctx)` - Dispatch Do operator to Image or Form handler
- `renderer._executeContentStream(bytes, resources, ctx)` - Tokenize and execute a content stream
- `renderer._formDepth` / `renderer._activeFormIds` - Form recursion tracking

### PDFFonts (from pdf-fonts.js)

```javascript
const PDFFonts = require('.../pdf-fonts.js');

PDFFonts.getStandardFontCSS('Helvetica')
// -> '"Helvetica Neue", Helvetica, Arial, sans-serif'

PDFFonts.pdfStringToText(new Uint8Array([72, 101, 108, 108, 111]))
// -> 'Hello'

PDFFonts.getCharWidth('Helvetica', 32) // space
// -> 278

PDFFonts.resolveEncoding('WinAnsiEncoding')
// -> number[256] code-point table

PDFFonts.applyDifferences(baseTable, [32, '/space', '/exclam', ...])
// -> modified encoding table

PDFFonts.parseToUnicodeCMap(cmapText)
// -> Map(charCode -> unicodeString)

PDFFonts.decodeWithEncoding(bytes, encodingTable)
// -> string

PDFFonts.decodeWithToUnicode(bytes, toUnicodeMap, isTwoByte)
// -> string
```

Exports: `getStandardFontCSS`, `isBoldFont`, `isItalicFont`, `getCharWidth`, `pdfDocEncoding`, `NAMED_ENCODINGS`, `resolveEncoding`, `applyDifferences`, `decodeWithEncoding`, `parseToUnicodeCMap`, `decodeWithToUnicode`, `pdfStringToText`, `GLYPH_NAME_TO_UNICODE`, `HELVETICA_WIDTHS`, `TIMES_ROMAN_WIDTHS`, `COURIER_WIDTHS`, `FONT_WIDTHS`

### PDFImages (from pdf-images.js)

```javascript
const PDFImages = require('.../pdf-images.js');

PDFImages.cmykToRGB(c, m, y, k)
// -> [r, g, b] each 0-255

PDFImages.resolveColorSpace(csSpec)
// -> canonical string like 'DeviceRGB'

PDFImages.buildRGBAData(data, width, height, bpc, colorSpace, options)
// -> Uint8ClampedArray(width * height * 4)

await PDFImages.drawImageXObject(ctx, imageObj, parser)
// Draws image to canvas context (1x1 unit square, CTM should scale)

await PDFImages.drawInlineImage(ctx, dict, data)
// Draws inline image to canvas context
```

---

## Assumptions Made

1. **Parser API stability**: Pages are raw dictionaries with slash-prefixed keys. Streams have `.isStream = true` and `.getBytes()`. References have `{ type: 'ref', num, gen }`. `parser.resolveRef(ref)` resolves them.

2. **Font rendering via browser**: Actual glyph shapes come from the browser's built-in fonts via `ctx.fillText()`. We provide correct positioning, sizing, and CSS font-family mapping. For non-standard embedded fonts, text will appear in the closest standard font.

3. **Single-page rendering**: Each `renderPage()` call renders one page independently. State is reset between pages.

4. **JPEG passthrough in browser**: For DCTDecode images, raw JPEG bytes are handed to the browser's native decoder via Blob URL + Image element. In Node.js test environment, a mock image object is used.

5. **CropBox takes priority**: If a page has both /MediaBox and /CropBox, /CropBox is used for page dimensions (per PDF spec).

6. **Form XObject depth limit**: Maximum recursion depth is 10. This prevents stack overflow from deeply nested or circular form references.

---

## Known Gaps / Deferred to Phase 2b

1. **Type3 font rendering**: d0/d1 operators are recognized but ignored. Phase 2b should implement CharProc content stream interpretation with FontMatrix transform.

2. **Shading (sh operator)**: Stubbed. Phase 2b implements axial and radial gradient shading.

3. **Advanced ExtGState**: Only /ca, /CA (alpha) and line style params are handled. /SMask, /BM (blend mode) are deferred.

4. **PNG predictor for images**: buildRGBAData handles raw decoded pixel data. If FlateDecode images use PNG predictors, the parser's stream decoder handles the predictor reversal before the data reaches the renderer. Phase 2b may add additional predictor handling for edge cases.

5. **Image masks**: /ImageMask is detected but not rendered as stencil masks. Phase 2b should render 1-bit masks using the current fill color.

6. **Soft masks (/SMask)**: Not implemented. Phase 2b should apply SMask as alpha channel.

7. **Color spaces**: ICCBased falls back to device color space by /N count. Separation, DeviceN, Pattern, and Lab color spaces are not implemented.

8. **Multi-component indexed colors**: Basic Indexed color space works for RGB palettes. More complex palette lookups (CMYK palette, ICCBased base) may need Phase 2b attention.

---

## Example Usage (Full Pipeline)

```javascript
// 1. Fetch and parse
const response = await fetch(pdfUrl);
const arrayBuffer = await response.arrayBuffer();
const parser = new PDFParser(arrayBuffer);
const result = await parser.load();

// 2. Sanitize
sanitizeCatalog(result.catalog);
sanitizeObject(result.catalog);
for (const page of result.pages) {
  sanitizeObject(page);
}

// 3. Render page 0
const canvas = document.createElement('canvas');
const renderer = new PDFRenderer();
const scale = 1.5; // 150% zoom
await renderer.renderPage(canvas, result.pages[0], scale, parser);
document.body.appendChild(canvas);
```

---

## Test Results Summary

| Suite | Pass | Fail | Total |
|-------|------|------|-------|
| Phase 2 Core | 30 | 0 | 30 |
| R4 Form XObject | 6 | 0 | 6 |
| R5 Font Encoding | 10 | 0 | 10 |
| R6 Inline Image | 8 | 0 | 8 |
| R7 Font Width | 5 | 2 | 7 |
| **Phase 2 Total** | **59** | **2** | **61** |

R7 failures are parser API mismatches (test calls `resolveObject()` which doesn't exist on parser).
All Phase 1 regression tests pass (46/46).
