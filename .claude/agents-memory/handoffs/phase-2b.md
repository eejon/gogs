# Phase 2b Handoff: Extended Rendering -- Images, Type3 Fonts, Shading

## What Was Built

Phase 2b extended the Phase 2a core renderer with four categories of additive features. All changes were made by extending existing files, not rewriting them.

### Modified Files

1. **`public/plugins/custom-pdf-render/src/pdf-images.js`** (1014 lines, was 608)
   - Added PNG predictor filter reversal (~170 lines)
   - Added TIFF predictor 2 reversal (~30 lines)
   - Rewrote drawImageXObject to support image masks, soft masks, and predictor integration (~180 lines)
   - Added buildSoftMaskAlpha, scaleAlphaChannel, drawRGBAToCanvas helpers (~100 lines)
   - Removed duplicated canvas-drawing code (DRY refactor)

2. **`public/plugins/custom-pdf-render/src/pdf-renderer.js`** (2774 lines, was 2060)
   - Added Type3 font support in _resolveFontAsync (~50 lines)
   - Added _showTextType3 method for Type3 glyph rendering (~100 lines)
   - Added shading pattern support: _paintShading, _paintAxialShading, _paintRadialShading (~120 lines)
   - Added PDF function evaluation: _buildShadingFunction, _buildExponentialFunction, _buildStitchingFunction, _buildFallbackFunction (~180 lines)
   - Extended _applyExtGState with /BM, /SMask, /D support (~60 lines)
   - Made text operators async (Tj, TJ, ', ") to support Type3 recursive rendering

3. **`tests/test-runner.js`** (added R8 test suite, ~350 lines)

### No changes to `pdf-fonts.js` or `pdf-parser.js`.

---

## Public Interface

The public API is unchanged from Phase 2a:

```javascript
const renderer = new PDFRenderer();
await renderer.renderPage(canvas, pageData, scale, parser);
```

### New Internal Methods (exposed on prototype)

```javascript
// Type3 font rendering
renderer._showTextType3(bytes, ctx, gs, resources)

// Shading
renderer._paintShading(nameArg, resources, ctx)
renderer._paintAxialShading(dict, csName, ctx)
renderer._paintRadialShading(dict, csName, ctx)
renderer._buildShadingFunction(funcSpec, csName)  // -> evaluator function
renderer._buildExponentialFunction(funcSpec)       // -> f(t) -> [values]
renderer._buildStitchingFunction(funcSpec)         // -> f(t) -> [values]
renderer._buildFallbackFunction(funcSpec)          // -> f(t) -> [values]
renderer._shadingColorToCSS(color, csName)         // -> CSS color string
renderer._resolveVal(val)                          // -> resolved value
```

### New Image Module Exports

```javascript
PDFImages.reversePNGPredictors(data, width, bpc, components, predictor)
PDFImages.reverseTIFFPredictor(data, width, components, bpc)
PDFImages.paethPredictor(a, b, c)
PDFImages.buildSoftMaskAlpha(smaskObj, targetWidth, targetHeight, parser)
PDFImages.scaleAlphaChannel(alpha, srcW, srcH, dstW, dstH)
PDFImages.drawRGBAToCanvas(ctx, rgbaData, width, height)
```

### Updated Signature

```javascript
// drawImageXObject now accepts an optional renderState parameter
PDFImages.drawImageXObject(ctx, imageObj, parser, renderState)
// renderState = { fillColor: [r,g,b], fillColorSpace: 'DeviceRGB', fillAlpha: 1 }
```

---

## Assumptions Made

1. **PNG predictors at image level**: The parser's FlateDecode stream handler may or may not apply predictor reversal. The image-level predictor code in drawImageXObject reads /DecodeParms from the image dictionary and applies reversal if needed. This handles the case where the parser decodes the stream's zlib/deflate but doesn't reverse the PNG row filters (which is image-specific).

2. **Type3 font glyph names**: The mapping from byte codes to glyph names uses the font's /Encoding and a reverse lookup through the GLYPH_NAME_TO_UNICODE table. For standard glyph names (A-Z, a-z, 0-9, space, period, comma), fallback mappings are used if the reverse lookup fails.

3. **Shading gradient resolution**: 10 color stops are sampled for each gradient. This provides a reasonable approximation of continuous gradients without excessive computation.

4. **Blend modes**: Only the 12 standard PDF blend modes that have direct Canvas equivalents are mapped. PDF-specific blend modes (Hue, Saturation, Color, Luminosity) are not mapped because Canvas does not support them natively.

5. **Soft mask in ExtGState**: Complex /SMask dictionaries with /G (transparency group) require rendering the group to an offscreen canvas, which is a significant rendering pipeline feature. Only the /SMask /None reset is handled. Soft masks on individual images (/SMask on image XObjects) are fully supported.

---

## Known Gaps / Limitations

1. **Complex ExtGState /SMask**: Soft masks defined via transparency groups in ExtGState (/SMask with /G key) require rendering an entire content stream to an offscreen canvas and using the result as an alpha channel. This is deferred.

2. **Type3 font glyph name resolution**: The reverse lookup from Unicode code points to glyph names may not find all glyph names for fonts with non-standard naming. The fallback to character codes (A-Z, a-z, etc.) covers common cases.

3. **Shading function Type 0 (sampled) and Type 4 (PostScript calculator)**: These fall back to a flat color derived from the /Range midpoints. Type 0 would require parsing a sampled data table; Type 4 would require a PostScript interpreter -- both are uncommon in typical PDFs.

4. **Paeth predictor edge cases**: The Paeth predictor is implemented per the PNG specification. Edge cases with unusual bytesPerPixel values (non-8bpc, multi-component) are handled correctly via the bitsPerPixel/bytesPerPixel calculation.

5. **PNG predictor without filter bytes**: For Predictor 10-14 (fixed filter type), the code attempts to detect whether the data includes per-row filter bytes by checking if the data length matches `height * (rowBytes + 1)`. In ambiguous cases, it prefers the with-filter-byte interpretation.

---

## What Phase 3 (the Viewer) Needs to Know

1. **API is unchanged**: `renderer.renderPage(canvas, pageData, scale, parser)` returns a Promise that resolves when rendering is complete. No new parameters needed.

2. **All rendering features are transparent**: The viewer does not need to know about PNG predictors, Type3 fonts, shading, or ExtGState -- the renderer handles them internally.

3. **Canvas context requirements**: The renderer now uses `ctx.createLinearGradient()` and `ctx.createRadialGradient()` for shading, and `ctx.globalCompositeOperation` for blend modes. The viewer should provide a standard Canvas2D context.

4. **Async text rendering**: The text rendering methods are now async. This is already handled by the existing `await` pattern in `_executeOperator`.

5. **Form depth limit**: Type3 font glyphs share the form XObject depth counter (maximum 10). Deeply nested Type3 fonts within Form XObjects may hit this limit, but this is extremely unlikely in real-world PDFs.

---

## Test Results

| Suite | Pass | Fail | Total |
|-------|------|------|-------|
| Phase 1 | 25 | 0 | 25 |
| Phase 2 Core | 30 | 0 | 30 |
| R1 Parser Repair | 4 | 0 | 4 |
| R2 Stream Filters | 17 | 0 | 17 |
| R4 Form XObject | 6 | 0 | 6 |
| R5 Font Encoding | 10 | 0 | 10 |
| R6 Inline Image | 8 | 0 | 8 |
| R7 Font Widths | 5 | 2 | 7 |
| **R8 Phase 2b** | **31** | **0** | **31** |
| **Overall** | **136** | **2** | **138** |

The 2 R7 failures are pre-existing parser API mismatches (test calls `resolveObject()` which does not exist on the parser; the correct method is `resolveRef()`). They are not Phase 2b regressions.
