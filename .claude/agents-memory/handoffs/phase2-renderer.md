# Phase 2 Renderer Handoff

## Phase 2a: Core Page Rendering Engine (COMPLETE)

### What Was Built and Where

| File | Approx Lines | Description |
|------|-------------|-------------|
| `public/plugins/custom-pdf-render/src/pdf-fonts.js` | 450 | Font handling: CSS mappings, width tables, encodings, ToUnicode |
| `public/plugins/custom-pdf-render/src/pdf-images.js` | 370 | Image rendering: JPEG passthrough, pixel reconstruction, canvas draw |
| `public/plugins/custom-pdf-render/src/pdf-renderer.js` | 1100 | Core renderer: tokenizer, graphics state, text, paths, colors, XObjects |

### Public Interface

**PDFRenderer** (pdf-renderer.js):
```javascript
class PDFRenderer {
  async renderPage(canvas, pageData, scale, parser) -> void
  // Internal but exposed for testing/extension:
  async _resolveFontAsync(fontKey, resources) -> {fontCSS, fontBold, fontItalic, fontWidthsType, fontWidths, fontFirstChar, fontDefaultWidth, fontEncoding, fontToUnicode, fontIsTwoByte, baseFontName}
  async _drawFormXObject(stream, resources, ctx, gs) -> void
  async _invokeXObject(name, resources, ctx) -> void
  async _executeContentStream(bytes, resources, ctx) -> void
  _formDepth: number
  _activeFormIds: Set
  _gs: GraphicsState
  _ctx: CanvasRenderingContext2D
  _parser: PDFParser
}
```

**Exported helpers** from pdf-renderer.js: `PDFRenderer`, `_parseInlineImageBlock`, `_getGlyphAdvance1000`, `tokenizeContentStream`, `multiplyMatrix`, `transformPoint`, `createDefaultGraphicsState`, `cloneGraphicsState`, `colorToCSS`

**PDFFonts** (pdf-fonts.js): `getStandardFontCSS`, `isBoldFont`, `isItalicFont`, `getCharWidth`, `pdfDocEncoding`, `NAMED_ENCODINGS`, `resolveEncoding`, `applyDifferences`, `decodeWithEncoding`, `parseToUnicodeCMap`, `decodeWithToUnicode`, `pdfStringToText`, `GLYPH_NAME_TO_UNICODE`, `HELVETICA_WIDTHS`, `TIMES_ROMAN_WIDTHS`, `COURIER_WIDTHS`, `FONT_WIDTHS`

**PDFImages** (pdf-images.js): `cmykToRGB`, `resolveColorSpace`, `getColorComponents`, `buildRGBAData`, `createJPEGImage`, `drawImageXObject`, `drawInlineImage`, `resolveValue`

### Assumptions Made

1. Parser API: pages are raw dicts with '/Key' prefixed keys; streams have `.isStream=true`, `.getBytes()`; refs have `{type:'ref',num,gen}`; `parser.resolveRef(ref)` resolves.
2. Font rendering uses browser's built-in fonts via `ctx.fillText()` with CSS font-family from standard 14 mapping.
3. JPEG decoding is delegated to the browser via Blob URL + Image element.
4. CropBox takes priority over MediaBox for page dimensions.
5. Form XObject depth limit is 10 (prevents stack overflow from deep/circular nesting).
6. Unknown operators are silently skipped (no crash).

### Known Gaps / Deferred to Phase 2b

1. **Type3 font rendering** (d0/d1 stubs present) - Phase 2b implements CharProc interpretation
2. **Shading** (sh stub present) - Phase 2b implements axial/radial gradients
3. **Advanced ExtGState** - Only /ca, /CA, line style params handled; /SMask, /BM deferred
4. **Image masks** - /ImageMask detected but not rendered as stencil
5. **Soft masks** - /SMask not implemented
6. **Advanced color spaces** - Separation, DeviceN, Pattern, Lab not implemented
7. **PNG predictor for images** - Parser handles predictors; renderer trusts decoded data

### Extension Points for Phase 2b

- **Operator dispatch**: Add cases to the switch in `_executeOperator()` for `sh`, extended `gs` params
- **Type3 fonts**: In `_resolveFont`, detect `/Subtype /Type3` and store CharProcs. In text rendering, call `_executeContentStream` for each glyph's CharProc stream with FontMatrix applied
- **Shading**: Implement `_paintShading(name, resources, ctx)` using canvas `createLinearGradient` / `createRadialGradient`
- **ExtGState**: Extend `_applyExtGState` to read /SMask, /BM, /OPM, etc.
- **Image masks**: In `drawImageXObject`, when `/ImageMask true`, use ctx fill color and draw 1-bit mask as stencil
- **PDF images module**: `buildRGBAData` is designed to accept any bpc/colorSpace; add palette support and predictor reversal as needed
