# Phase 2b Handoff: Extended Rendering -- Images, Type3 Fonts, Shading

## What Was Built

Two new library files and updates to two existing files implementing extended rendering capabilities:

### Files

| File | Purpose | Lines (approx) |
|------|---------|-------|
| `public/plugins/custom-pdf-render/lib/pdf-images.js` | Image XObject/inline image decoding and rendering | ~590 |
| `public/plugins/custom-pdf-render/lib/pdf-shading.js` | Shading patterns, gradient rendering, PDF function evaluation | ~500 |
| `public/plugins/custom-pdf-render/lib/pdf-renderer.js` | Updated: wired up images, shading, Type3 fonts, pattern colors | ~2090 (was ~1957) |
| `public/plugins/custom-pdf-render/lib/pdf-fonts.js` | Updated: Type3 font data capture during font resolution | ~600 (was ~580) |
| `tests/test-runner.js` | Test suite: 165 tests total (125 Phase 1+2a + 40 Phase 2b) | ~1960 |

## Public Interface

### PDFImages (pdf-images.js)

```javascript
// Render an image XObject onto a canvas context
PDFImages.renderImageXObject(ctx, state, imgObj, resources, doc);
// ctx: CanvasRenderingContext2D (with CTM already applied)
// state: GraphicsState (for fill color in stencil masks, alpha)
// imgObj: image XObject dictionary (with _isStream, Width, Height, etc.)
// resources: page resources
// doc: PDFDocument instance

// Render an inline image (from BI/ID/EI operators)
PDFImages.renderInlineImage(ctx, state, imageDict, imageData, resources, doc);
// imageDict: inline image dictionary (expanded abbreviations)
// imageData: raw image data bytes (Uint8Array)

// Decode raw image stream data into RGBA pixel data
PDFImages.decodeImageData(data, width, height, bpc, colorSpace, imgDict, doc);
// -> Uint8ClampedArray (width*height*4 bytes, RGBA)
// Handles BPC: 1, 2, 4, 8
// Handles color spaces: DeviceGray, DeviceRGB, DeviceCMYK, Indexed, Separation, DeviceN

// Resolve image color space (handles inline image abbreviations)
PDFImages.resolveImageColorSpace(csSpec, resources, doc);
// -> { type, numComponents, base?, hival?, lookup? }

// Apply a soft mask to RGBA data
PDFImages.applySoftMask(rgbaData, smaskObj, imgWidth, imgHeight, doc);

// Apply a color key mask to RGBA data
PDFImages.applyColorKeyMask(rgbaData, mask, width, height, bpc, colorSpace);

// Parse CSS color string to [r, g, b]
PDFImages.parseCSSColor(cssColor);
// -> [r, g, b] array

// Constants
PDFImages.MAX_IMAGE_PIXELS;    // 100 * 1024 * 1024 (100 megapixels)
PDFImages.MAX_IMAGE_DIMENSION; // 16384
```

### PDFShading (pdf-shading.js)

```javascript
// Render a shading pattern via the sh operator
PDFShading.renderShading(ctx, state, shadingName, resources, doc);
// Fills the current clipping region with the gradient

// Resolve a shading name from resources
PDFShading.resolveShading(name, resources, doc);
// -> shading dictionary or null

// Create a pattern fill from a Pattern resource (for SCN/scn with Pattern CS)
PDFShading.resolvePatternFill(ctx, patternName, resources, doc);
// -> CanvasGradient or null

// Create canvas gradients from shading dictionaries
PDFShading.createAxialGradient(ctx, shading, resources, doc);  // Type 2
PDFShading.createRadialGradient(ctx, shading, resources, doc); // Type 3

// Evaluate PDF functions (used internally for gradient color stops)
PDFShading.evaluateFunction(fn, t, doc);
// fn: PDF function dictionary (Type 0, 2, 3, or 4)
// t: input parameter value
// -> number[] (output color components) or null

// Specific function evaluators
PDFShading.evaluateExponentialFunction(fn, t, doc);  // Type 2: f(x) = C0 + x^N * (C1 - C0)
PDFShading.evaluateStitchingFunction(fn, t, doc);    // Type 3: piecewise
PDFShading.evaluateSampledFunction(fn, t, doc);      // Type 0: interpolated table

// Convert function output to CSS color
PDFShading.functionOutputToCSS(values, colorSpace);
// -> CSS color string like 'rgb(R,G,B)'
```

### Updated PDFRenderer Exports

```javascript
// New export (added in Phase 2b)
PDFRenderer.buildType3FontData(fontDict, doc);
// fontDict: Type3 font dictionary with CharProcs, FontMatrix, Encoding
// doc: PDFDocument instance
// -> { charProcs, fontMatrix, resources, encodingNames } or null
```

### Module System

All files export via both `module.exports` (Node.js) and `window.*` (browser):
- `window.PDFImages` / `require('./pdf-images.js')`
- `window.PDFShading` / `require('./pdf-shading.js')`

In browser, load via `<script>` tags in dependency order:
1. pdf-stream.js
2. pdf-security.js
3. pdf-parser.js
4. pdf-fonts.js
5. pdf-renderer.js
6. pdf-images.js
7. pdf-shading.js

## Assumptions Made

1. **JPEG passthrough**: DCTDecode images pass raw JPEG bytes to the browser's native Image decoder via Blob URL. This is async (Image.onload), so JPEG images may render slightly after other page content. In Node.js test environments, JPEG images render as gray placeholders since there is no browser Image API.

2. **JPEG 2000 unsupported**: JPXDecode images render as placeholders. Browser support for JPEG 2000 is extremely limited (no major browser supports it natively in Image elements).

3. **Image coordinate system**: PDF images are drawn in a 1x1 unit square with the CTM handling the actual size/position transform. The image data is drawn using putImageData with a scale(1/width, -1/height) + translate(0, -height) transform to flip from PDF's bottom-up to canvas's top-down coordinate system.

4. **Indexed color lookup**: Indexed images use a direct lookup table (Uint8Array or string) to convert index values to base color space values. The base color space is recursively resolved.

5. **Separation/DeviceN fallback**: For images using Separation or DeviceN color spaces, the first component is treated as a subtractive gray value (inverted: 0 = white, 1 = black). A proper implementation would evaluate the tint transform function, but this provides reasonable results for most cases.

6. **Type3 font rendering**: Type3 glyphs are rendered by executing their CharProcs content streams with the font's FontMatrix applied. Each glyph is rendered at the text matrix position. If a glyph's content stream is not found in CharProcs, the system falls back to canvas text rendering using the Unicode mapping.

7. **Soft mask scaling**: When a soft mask has different dimensions from the image, nearest-neighbor scaling is used to map mask pixels to image pixels.

8. **Gradient sampling**: Shading gradients are sampled at 10 evenly-spaced points to create canvas gradient color stops. This provides smooth gradients for most practical cases.

9. **PostScript calculator functions**: Type 4 (PostScript calculator) functions fall back to linear interpolation between the Range min and max values. This is a significant simplification but handles the most common case (identity functions used in some gradient definitions).

10. **Circular dependency handling**: pdf-images.js and pdf-shading.js both depend on pdf-renderer.js (for resolveColorSpace, colorToCSS). pdf-renderer.js depends on them for image/shading rendering. This circular dependency is broken using lazy loading (getImages()/getShading() functions that load on first use).

## Known Gaps / Deferred Decisions

1. **CCITTFaxDecode / JBIG2Decode**: Not implemented. Scanned B&W documents using these compression formats will fail with an unsupported filter error. If the scanned PDF uses DCTDecode (common for color scans), it will work via JPEG passthrough.

2. **LZWDecode**: Not implemented (from Phase 1). Will throw an error.

3. **Tiling patterns (Type 1)**: Pattern color spaces with PatternType=1 (tiling patterns) are not supported. Only shading patterns (Type 2) that reference axial/radial gradients are implemented.

4. **Free-form mesh shadings (Types 4-7)**: Coons patch, tensor-product patch, and mesh shadings are not implemented. They render as a flat background color (gray or the shading's /Background if specified).

5. **Transparency groups (SMask in ExtGState)**: The canvas 2D API does not directly support PDF transparency groups. Per-image SMask is fully supported (alpha channel compositing), but page-level transparency groups from ExtGState SMask dictionaries are acknowledged and skipped.

6. **Sampled functions (Type 0)**: Implemented but only for 1-D input functions. Multi-dimensional sampled functions (rare in gradients) are not handled.

7. **PostScript calculator functions (Type 4)**: Only a linear fallback is provided. Complex PS expressions are not evaluated.

8. **Async JPEG rendering**: JPEG images load asynchronously via Image.onload in the browser. This means they may appear after the rest of the page has rendered. There is no mechanism to wait for all images to finish loading before signaling "render complete."

9. **Type3 font glyph caching**: Each Type3 glyph content stream is re-tokenized and re-executed on every appearance. For documents with many repeated Type3 glyphs, this could be slow. A caching mechanism (render to offscreen canvas, then drawImage) would improve performance.

## Test Results

All 165 tests pass:

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

### Phase 2a tests (44 tests, unchanged)
- R01: Standard font metrics (6)
- R02: Encoding resolution (6)
- R03: ToUnicode CMap parsing (4)
- R04: Font resolution (5)
- R05: Content stream tokenization (6)
- R06: Graphics state management (3)
- R07: Color space and color conversion (6)
- R08: Rendering pipeline (8)

### Phase 2b tests (40 tests, new)
- R09: Image decoding and rendering (15)
- R10: Shading and gradient support (10)
- R11: ExtGState alpha and blend modes (3)
- R12: Corpus image rendering (4)
- R13: Type3 font support (4)
- R14: Inline image handling (2)
- R15: Additional BPC and image edge cases (2)

### Corpus rendering results
All 8 corpus PDFs render page 1 without crashing:
- `1&5-arXiv-Latex.pdf` - renders (LaTeX/Type1 fonts, images now decoded)
- `2-lualatex.pdf` - renders (CIDFont/Type0 composite fonts)
- `3-word-docx.pdf` - renders (TrueType/CIDFont fonts)
- `4-google-doc.pdf` - renders (text content with fillText calls)
- `7-matplotlib-charts.pdf` - renders (path operators for charts)
- `8-scanned.pdf` - renders (image handling active, may hit CCITTFaxDecode limitation)
- `9-browser-print.pdf` - renders (browser-generated PDF with images)
- `links.pdf` - renders (text with link annotations)
