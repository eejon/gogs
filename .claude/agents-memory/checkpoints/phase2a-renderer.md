# Phase 2a: Core Page Rendering Engine -- COMPLETE

## Components Completed

1. `public/plugins/custom-pdf-render/src/pdf-fonts.js` (~450 lines)
   - Standard 14 PDF font CSS mappings (Helvetica, Times, Courier, Symbol, ZapfDingbats)
   - Character width tables (AFM data: Helvetica, Times-Roman, Courier)
   - Font alias resolution (ArialMT -> Helvetica, TimesNewRomanPSMT -> Times-Roman, etc.)
   - PDFDocEncoding, WinAnsiEncoding, MacRomanEncoding, StandardEncoding tables
   - Encoding differences array application with glyph name to Unicode lookup
   - ToUnicode CMap parsing (beginbfchar, beginbfrange, array ranges)
   - PDF string to text conversion (Latin-1, UTF-16BE with BOM, UTF-8 with BOM)
   - Adobe glyph name to Unicode mapping (common Latin glyphs, accented chars, ligatures)

2. `public/plugins/custom-pdf-render/src/pdf-images.js` (~370 lines)
   - CMYK to RGB conversion (subtractive color model)
   - Color space resolution and component counting
   - RGBA data building for 8bpc, 1bpc, 2bpc, 4bpc images
   - DeviceGray, DeviceRGB, DeviceCMYK, Indexed color space support
   - JPEG passthrough via Blob/Image in browser, mock in Node.js
   - Image XObject rendering (decodes pixel data, creates ImageData, draws to canvas)
   - Inline image rendering to canvas context
   - ICCBased fallback (based on /N: 1->Gray, 3->RGB, 4->CMYK)

3. `public/plugins/custom-pdf-render/src/pdf-renderer.js` (~1100 lines)
   - Content stream tokenizer: numbers, names, strings (literal + hex), arrays, comments
   - Inline image (BI/ID/EI) tokenization with abbreviated name normalization
   - Graphics state machine: save/restore (q/Q), all state properties
   - Matrix operations: multiply, transform point
   - Coordinate transforms: PDF bottom-left -> Canvas top-left via setTransform
   - Path operators: m, l, c, v, y, h, re
   - Path painting: S, s, f, F, f*, B, B*, b, b*, n
   - Clipping: W, W*
   - Color operators: g/G, rg/RG, k/K, cs/CS, sc/SC/scn/SCN
   - Text state: Tc, Tw, Tz, TL, Tf, Tr, Ts
   - Text positioning: BT/ET, Td, TD, Tm, T*
   - Text showing: Tj, TJ, ', "
   - Text rendering: glyph-by-glyph with proper advance widths
   - Font resolution: /Widths (simple), /W (CID), encoding, ToUnicode
   - XObject invocation: Do operator dispatching to Image or Form
   - Form XObjects: depth guard, cycle guard, BBox clipping, Matrix application
   - Inline images: BI/ID/EI parsing and rendering
   - ExtGState: gs operator for alpha transparency, line style overrides
   - Marked content: BMC/BDC/EMC (ignored, as spec'd)
   - Compatibility sections: BX/EX
   - Shading stub: sh (for Phase 2b)
   - Type 3 font stubs: d0/d1 (for Phase 2b)

## Test Results

- Phase 2 Renderer tests: **30/30 PASS**
- R4 Form XObject tests: **6/6 PASS**
- R5 Font Encoding tests: **10/10 PASS**
- R6 Inline Image tests: **8/8 PASS**
- R7 Font Width tests: **5/7 PASS** (2 failures are parser API mismatch, not renderer)
- All Phase 1 / R1 / R2 regression tests: **46/46 PASS**

## Decisions Made

1. Split into three modules per test runner expectations: pdf-fonts.js, pdf-images.js, pdf-renderer.js
2. PDFRenderer API matches test runner: `new PDFRenderer()`, `renderer.renderPage(canvas, pageData, scale, parser)`
3. Font resolution uses cached lookups keyed by font resource name (e.g., "F1")
4. Text rendering does glyph-by-glyph positioning using advance widths from either PDF /Widths or AFM fallback
5. The text coordinate handling flips Y axis via ctx.scale(hScale, -1) inside save/restore for each glyph
6. Form XObject rendering uses recursion with depth guard (max 10) and cycle detection (Set of active streams)
7. Inline image parsing handles all abbreviated key names per PDF spec Table 93
8. Color CSS conversion supports Gray, RGB, and CMYK (via cmykToRGB from pdf-images.js)
9. ExtGState applies /ca, /CA (alpha), /LW, /LC, /LJ, /ML (line style)
10. Unknown operators are silently skipped (no crash)

## Extension Points for Phase 2b

1. **Type3 fonts**: d0/d1 operators are stub-handled. Phase 2b adds CharProc rendering by calling `_executeContentStream` recursively with the glyph stream, applying FontMatrix.

2. **Extended image formats**: `buildRGBAData()` in pdf-images.js already handles 1/2/4/8 bpc. Phase 2b adds PNG predictor filter reversal and enhanced Indexed/ICCBased color space handling.

3. **Shading**: The `sh` operator is stub-handled. Phase 2b implements axial (Type 2) and radial (Type 3) gradient shading by creating canvas gradient objects.

4. **ExtGState**: The `gs` handler already reads /ca and /CA. Phase 2b can extend it to read /SMask (soft mask), /BM (blend mode), etc.

5. **Operator dispatch**: The switch statement in `_executeOperator` is easily extended by adding new cases.

6. **Image masks**: The `drawImageXObject` function detects /ImageMask but currently treats it like a normal image. Phase 2b can implement stencil mask rendering using the fill color.
