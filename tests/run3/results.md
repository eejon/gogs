# Test Run Results - Phase 4 Integration

**Date:** 2026-06-22T02:56:22.942Z
**Total:** 263
**Passed:** 261
**Failed:** 2

## Results by Group

### P01: URL Parsing and Policy

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| P01-01 | Accept relative same-origin URL | PASS | - |
| P01-02 | Accept same-origin absolute URL | PASS | - |
| P01-03 | Reject cross-origin URL | PASS | - |
| P01-04 | Reject javascript: scheme | PASS | - |
| P01-05 | Reject data: scheme | PASS | - |
| P01-06 | Reject blob: scheme | PASS | - |
| P01-07 | Reject empty URL | PASS | - |
| P01-08 | Reject null URL | PASS | - |
| P01-09 | Accept URL with percent-encoded characters | PASS | - |
| P01-10 | Reject vbscript: scheme | PASS | - |

### P02: Binary Fetch Pipeline

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| P02-01 | Load PDF from ArrayBuffer | PASS | - |
| P02-02 | PDFDocument accepts ArrayBuffer | PASS | - |
| P02-03 | PDFDocument accepts Uint8Array | PASS | - |
| P02-04 | PDFDocument rejects invalid input | PASS | - |

### P03: Header/Version Recognition

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| P03-01 | Validate PDF header on corpus files | PASS | - |
| P03-02 | Reject non-PDF data | PASS | - |
| P03-03 | Reject empty data | PASS | - |

### P04/P05: Cross-Reference Parsing

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| P04-01 | Parse xref for all corpus PDFs | PASS | - |
| P04-02 | Xref entries have valid offsets | PASS | - |

### P06: Trailer/Root/Catalog Resolution

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| P06-01 | Trailer found for all corpus PDFs | PASS | - |
| P06-02 | Catalog resolved for all corpus PDFs | PASS | - |
| P06-03 | Pages root found for all corpus PDFs | PASS | - |

### P07: Indirect Object/Reference Resolution

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| P07-01 | Resolve objects from xref | PASS | - |
| P07-02 | Missing reference returns null | PASS | - |
| P07-03 | Circular reference detection | PASS | - |

### P08: Stream Decode (Flate)

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| P08-01 | FlateDecode basic compression | PASS | - |
| P08-02 | FlateDecode empty input | PASS | - |
| P08-03 | Content streams decode for all corpus PDFs | PASS | - |
| P08-04 | FlateDecode size limit enforcement | PASS | - |

### P09: Stream Decode (ASCIIHex/ASCII85)

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| P09-01 | ASCIIHexDecode basic | PASS | - |
| P09-02 | ASCIIHexDecode with whitespace | PASS | - |
| P09-03 | ASCIIHexDecode odd nibble | PASS | - |
| P09-04 | ASCII85Decode basic | PASS | - |
| P09-05 | ASCII85Decode z shorthand | PASS | - |
| P09-06 | Decode pipeline chains filters | PASS | - |

### P10: Page Tree and Inherited Resources

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| P10-01 | Page count for all corpus PDFs | PASS | - |
| P10-02 | Pages have MediaBox | PASS | - |
| P10-03 | Pages have Resources | PASS | - |
| P10-04 | Out of range page throws | PASS | - |

### S01: Embedded JS Stripping

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| S01-01 | JavaScript action type is blocked | PASS | - |
| S01-02 | containsJavaScript detects JS entries | PASS | - |
| S01-03 | containsJavaScript detects nested JS | PASS | - |
| S01-04 | filterAnnotation strips JS action | PASS | - |
| S01-05 | No eval/Function in source code | PASS | - |

### S02: URI Scheme Sanitization

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| S02-01 | Allow http: scheme | PASS | - |
| S02-02 | Allow https: scheme | PASS | - |
| S02-03 | Allow mailto: scheme | PASS | - |
| S02-04 | Block javascript: scheme | PASS | - |
| S02-05 | Block data: scheme | PASS | - |
| S02-06 | Block protocol-relative URL | PASS | - |
| S02-07 | Block file: scheme | PASS | - |
| S02-08 | Block vbscript: scheme | PASS | - |

### S03: Dangerous Action Blocking

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| S03-01 | Launch action blocked | PASS | - |
| S03-02 | SubmitForm action blocked | PASS | - |
| S03-03 | ImportData action blocked | PASS | - |
| S03-04 | RichMedia action blocked | PASS | - |
| S03-05 | URI action allowed | PASS | - |
| S03-06 | GoTo action allowed | PASS | - |
| S03-07 | filterAnnotation preserves safe Link | PASS | - |
| S03-08 | filterAnnotation strips Launch action | PASS | - |

### S04: Malformed/Corrupt Resilience

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| S04-01 | Handle truncated PDF | PASS | - |
| S04-02 | Handle garbage data | PASS | - |
| S04-03 | Handle PDF with corrupted header | PASS | - |

### S05: Guardrails and Limits

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| S05-01 | Object count limit exists | PASS | - |
| S05-02 | Recursion depth limit exists | PASS | - |
| S05-03 | Decompressed size limit exists | PASS | - |
| S05-04 | Parse timeout limit exists | PASS | - |
| S05-05 | Page dimension limit exists | PASS | - |
| S05-06 | ResourceTracker enforces depth limit | PASS | - |
| S05-07 | ResourceTracker enforces object count limit | PASS | - |

### S06: DOM/Network Safety

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| S06-01 | No innerHTML usage in source | PASS | - |
| S06-02 | No document.write in source | PASS | - |
| S06-03 | No window.open in source | PASS | - |
| S06-04 | No dynamic import in source | PASS | - |

### Links PDF: Annotation Handling

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| LINKS-01 | Parse links.pdf successfully | PASS | - |
| LINKS-02 | links.pdf pages have annotations | PASS | - |

### PNG Predictor Decoding

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| PRED-01 | PNG None predictor (type 0) | PASS | - |
| PRED-02 | PNG Sub predictor (type 1) | PASS | - |
| PRED-03 | PNG Up predictor (type 2) | PASS | - |

### PDF String Conversion

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| STR-01 | ASCII string conversion | PASS | - |
| STR-02 | UTF-16BE string conversion | PASS | - |

### R01: Standard Font Metrics

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R01-01 | Standard 14 fonts available | PASS | - |
| R01-02 | Courier is monospaced | PASS | - |
| R01-03 | Font aliases resolve correctly | PASS | - |
| R01-04 | CSS font family mapping | PASS | - |
| R01-05 | Subset font name handling | PASS | - |
| R01-06 | LaTeX CM font mapping | PASS | - |

### R02: Encoding Resolution

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R02-01 | WinAnsiEncoding basic ASCII | PASS | - |
| R02-02 | WinAnsiEncoding high bytes | PASS | - |
| R02-03 | MacRomanEncoding differs from WinAnsi | PASS | - |
| R02-04 | Differences array application | PASS | - |
| R02-05 | Glyph name to Unicode lookup | PASS | - |
| R02-06 | Unicode name format (uniXXXX) | PASS | - |

### R03: ToUnicode CMap Parsing

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R03-01 | Parse bfchar mapping | PASS | - |
| R03-02 | Parse bfrange mapping | PASS | - |
| R03-03 | Parse multiple mappings | PASS | - |
| R03-04 | Parse Uint8Array CMap data | PASS | - |

### R04: Font Resolution

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R04-01 | Resolve standard font | PASS | - |
| R04-02 | Default font creation | PASS | - |
| R04-03 | Character width lookup | PASS | - |
| R04-04 | Character code to Unicode | PASS | - |
| R04-05 | Resolve fonts from corpus PDFs | PASS | - |

### R05: Content Stream Tokenization

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R05-01 | Tokenize simple operator sequence | PASS | - |
| R05-02 | Tokenize path operators | PASS | - |
| R05-03 | Tokenize color operators | PASS | - |
| R05-04 | Tokenize hex string | PASS | - |
| R05-05 | Tokenize TJ array | PASS | - |
| R05-06 | Tokenize corpus content streams | PASS | - |

### R06: Graphics State Management

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R06-01 | Graphics state save/restore | PASS | - |
| R06-02 | Matrix multiplication | PASS | - |
| R06-03 | Transform point | PASS | - |

### R07: Color Space and Color Conversion

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R07-01 | DeviceGray to CSS | PASS | - |
| R07-02 | DeviceRGB to CSS | PASS | - |
| R07-03 | DeviceCMYK to CSS | PASS | - |
| R07-04 | Color clamping | PASS | - |
| R07-05 | Color space resolution for named spaces | PASS | - |
| R07-06 | ICCBased fallback | PASS | - |

### R08: Rendering Pipeline

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R08-01 | Render empty page | PASS | - |
| R08-02 | Render basic path | PASS | - |
| R08-03 | Render text to mock canvas | PASS | - |
| R08-04 | Render corpus PDFs page 1 without crash | PASS | - |
| R08-05 | Render produces fillText calls | FAIL | Should produce fillText calls for Google Docs PDF |
| R08-06 | Render with scale factor | PASS | - |
| R08-07 | q/Q state stack works in rendering | PASS | - |
| R08-08 | Operator count limit enforcement | PASS | - |

### R09: Image Decoding and Rendering

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R09-01 | PDFImages module exports exist | PASS | - |
| R09-02 | Decode DeviceGray 8bpc image data | PASS | - |
| R09-03 | Decode DeviceRGB 8bpc image data | PASS | - |
| R09-04 | Decode DeviceCMYK 8bpc image data | PASS | - |
| R09-05 | Decode 1-bit image data | PASS | - |
| R09-06 | Decode 4-bit image data | PASS | - |
| R09-07 | Decode Indexed color space image | PASS | - |
| R09-08 | Decode array with /Decode mapping | PASS | - |
| R09-09 | Apply color key mask | PASS | - |
| R09-10 | Apply soft mask | PASS | - |
| R09-11 | Parse CSS color | PASS | - |
| R09-12 | Image color space abbreviation expansion | PASS | - |
| R09-13 | Render image XObject to mock canvas | PASS | - |
| R09-14 | Image dimension limits enforced | PASS | - |
| R09-15 | Render inline image | PASS | - |

### R10: Shading and Gradient Support

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R10-01 | PDFShading module exports exist | PASS | - |
| R10-02 | Evaluate Type 2 exponential function | PASS | - |
| R10-03 | Evaluate Type 2 function with N=2 (quadratic) | PASS | - |
| R10-04 | Evaluate Type 2 function with RGB output | PASS | - |
| R10-05 | Evaluate Type 3 stitching function | PASS | - |
| R10-06 | Create axial gradient on mock canvas | PASS | - |
| R10-07 | Create radial gradient on mock canvas | PASS | - |
| R10-08 | Unsupported shading type renders fallback | PASS | - |
| R10-09 | Resolve shading from resources | PASS | - |
| R10-10 | Function output to CSS conversion | PASS | - |

### R11: ExtGState Alpha and Blend Modes

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R11-01 | ExtGState fill alpha applied during rendering | PASS | - |
| R11-02 | Blend mode mapping | PASS | - |
| R11-03 | BM as array handled gracefully | PASS | - |

### R12: Corpus Image Rendering

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R12-01 | Scanned PDF renders with image support | PASS | - |
| R12-02 | Browser-print PDF renders with images | PASS | - |
| R12-03 | All corpus PDFs still render without crash | PASS | - |
| R12-04 | Image rendering produces putImageData calls for image-heavy PDFs | PASS | - |

### R13: Type3 Font Support

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R13-01 | buildType3FontData function exists | PASS | - |
| R13-02 | buildType3FontData captures CharProcs and FontMatrix | PASS | - |
| R13-03 | buildType3FontData uses default FontMatrix | PASS | - |
| R13-04 | buildType3FontData returns null without CharProcs | PASS | - |

### R14: Inline Image Handling

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R14-01 | Inline image tokenization captures dict and data | PASS | - |
| R14-02 | Inline image abbreviations expanded | PASS | - |

### R15: Additional BPC and Image Edge Cases

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| R15-01 | Decode 2-bit image data | PASS | - |
| R15-02 | Large dimension image rejected | PASS | - |

### V01: Viewer URL Parsing and File Parameter

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| V01-01 | viewer.html exists at expected path | PASS | - |
| V01-02 | viewer.js exists at expected path | PASS | - |
| V01-03 | viewer.css exists at expected path | PASS | - |
| V01-04 | viewer.html loads all required script dependencies | PASS | - |
| V01-05 | viewer.html has required DOM elements | PASS | - |
| V01-06 | viewer.html has file= query parameter handling | PASS | - |
| V01-07 | URL validation rejects cross-origin URLs | PASS | - |
| V01-08 | URL validation rejects javascript: scheme | PASS | - |
| V01-09 | URL validation rejects data: scheme | PASS | - |
| V01-10 | URL validation accepts relative same-origin path | PASS | - |

### V02: Viewer Page Navigation

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| V02-01 | viewer.js has navigation controls | PASS | - |
| V02-02 | viewer.js enforces page bounds | PASS | - |
| V02-03 | viewer.js handles page input | PASS | - |
| V02-04 | viewer.js has keyboard navigation | PASS | - |
| V02-05 | All corpus PDFs can provide page count | PASS | - |

### V03: Viewer Zoom Controls

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| V03-01 | viewer.js has zoom controls | PASS | - |
| V03-02 | viewer.js has zoom level presets | PASS | - |
| V03-03 | viewer.js enforces zoom limits | PASS | - |
| V03-04 | Fit-width is default zoom mode | PASS | - |
| V03-05 | Canvas dimension check enforced | PASS | - |

### V04: Annotation Overlay

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| V04-01 | pdf-annotations.js exists | PASS | - |
| V04-02 | PDFAnnotations exports getPageAnnotations | PASS | - |
| V04-03 | PDFAnnotations exports createAnnotationOverlay | PASS | - |
| V04-04 | getPageAnnotations extracts links from links.pdf | PASS | - |
| V04-05 | getPageAnnotations returns empty for pages without annotations | PASS | - |
| V04-06 | Annotation URI sanitization blocks javascript: | PASS | - |
| V04-07 | Annotation URI sanitization allows https: | PASS | - |
| V04-08 | Annotation URI sanitization allows mailto: | PASS | - |
| V04-09 | resolveDestination handles array destination | PASS | - |
| V04-10 | resolveDestination handles string destination | PASS | - |
| V04-11 | All corpus PDFs can extract annotations without crash | PASS | - |
| V04-12 | Link annotations have correct structure | PASS | - |

### V05: Viewer Security

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| V05-01 | No eval() in viewer.js | PASS | - |
| V05-02 | No innerHTML with unsanitized content in viewer.js | PASS | - |
| V05-03 | No innerHTML in pdf-annotations.js | PASS | - |
| V05-04 | viewer.js does not change parent page title | PASS | - |
| V05-05 | viewer.js does not manipulate browser history | PASS | - |
| V05-06 | viewer.js does not try to break out of iframe | PASS | - |
| V05-07 | Link annotations use target="_blank" and rel="noopener noreferrer" | PASS | - |
| V05-08 | No unauthorized network calls in viewer.js | PASS | - |
| V05-09 | viewer.html contains no inline event handlers | PASS | - |
| V05-10 | Annotation extraction safely handles malformed annotations | PASS | - |

### I01: Template Integration

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| I01-01 | view_file.tmpl references custom-pdf-render | PASS | - |
| I01-02 | view_file.tmpl no longer references pdfjs-1.4.20 for PDF viewing | PASS | - |
| I01-03 | Template change is a one-line path swap (same iframe structure) | PASS | - |
| I01-04 | viewer.html accepts ?file= parameter (via query string parsing) | PASS | - |
| I01-05 | All files are static-servable (no server-side runtime) | PASS | - |
| I01-06 | No external imports in any source file | PASS | - |
| I01-07 | viewer.html includes all required library scripts | PASS | - |
| I01-08 | Script load order is correct (dependencies before dependents) | PASS | - |

### I02: Full Pipeline Integration

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| I02-01 | All corpus PDFs parse+render page 1 without error | PASS | - |
| I02-02 | Multi-page PDFs can render all pages | PASS | - |
| I02-03 | Rendering at different zoom levels works for all corpus PDFs | PASS | - |
| I02-04 | Page content streams decode successfully for all pages | PASS | - |
| I02-05 | Annotations extractable from all corpus PDFs without crash | PASS | - |
| I02-06 | links.pdf has URI annotations on at least one page | PASS | - |
| I02-07 | links.pdf URI annotations have safe schemes | PASS | - |
| I02-08 | Text-heavy PDFs produce fillText operations | FAIL | 4-google-doc.pdf: 4-google-doc.pdf: should produce fillText calls |

### I03: Security Audit - Source Code

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| I03-01 | No eval/Function/document.write in ANY source file | PASS | - |
| I03-02 | No innerHTML/outerHTML/insertAdjacentHTML in ANY source file | PASS | - |
| I03-03 | No dynamic script loading in ANY source file | PASS | - |
| I03-04 | No prototype pollution vectors (__proto__) | PASS | - |
| I03-05 | No window.open in ANY source file | PASS | - |
| I03-06 | Only one fetch() call in viewer.js (PDF loading only) | PASS | - |
| I03-07 | No external URLs hardcoded in source files | PASS | - |
| I03-08 | viewer.js does not access parent/top frame | PASS | - |

### I04: Security Fuzzing

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| I04-01 | Handle PDF with fake header + garbage body | PASS | - |
| I04-02 | Handle extremely small PDF (just header) | PASS | - |
| I04-03 | Handle PDF with injection attempt in Name objects | PASS | - |
| I04-04 | Handle recursive/deeply-nested dictionary structure | PASS | - |
| I04-05 | Decompression bomb protection | PASS | - |
| I04-06 | Circular reference detection in ResourceTracker | PASS | - |
| I04-07 | JavaScript action injection in mock annotation | PASS | - |
| I04-08 | Dangerous action types all blocked | PASS | - |
| I04-09 | Only GoTo and URI actions are allowed | PASS | - |
| I04-10 | URI sanitization blocks all dangerous schemes | PASS | - |
| I04-11 | URL validation blocks all dangerous file URL schemes | PASS | - |
| I04-12 | Page dimension validation works | PASS | - |

### I05: Edge Cases and Regression

| Test | Description | Status | Error |
|------|-------------|--------|-------|
| I05-01 | Empty content stream handles gracefully | PASS | - |
| I05-02 | Content stream with only whitespace handles gracefully | PASS | - |
| I05-03 | Very long text string renders without crash | PASS | - |
| I05-04 | Missing font in Resources does not crash rendering | PASS | - |
| I05-05 | MediaBox with negative origin coordinates works | PASS | - |
| I05-06 | Rotated page dimensions are correctly calculated | PASS | - |
| I05-07 | Object count tracking works | PASS | - |
| I05-08 | PDF version extraction works for all corpus files | PASS | - |
| I05-09 | Catalog Type is always Catalog for all corpus files | PASS | - |
| I05-10 | Content stream decode pipeline handles chained filters | PASS | - |
| I05-11 | FlateDecode handles invalid compressed data gracefully | PASS | - |
| I05-12 | Standard font metrics are complete for all 14 fonts | PASS | - |
| I05-13 | All encoding tables have 256 entries | PASS | - |
| I05-14 | File structure completeness check | PASS | - |
| I05-15 | No ReDoS-vulnerable regex patterns in source | PASS | - |
| I05-16 | viewer.html has no inline event handlers | PASS | - |
| I05-17 | Annotations link elements use safe attributes | PASS | - |
| I05-18 | ParseTimer timeout mechanism works | PASS | - |
| I05-19 | All security limits have reasonable values | PASS | - |
| I05-20 | Color conversion handles edge cases | PASS | - |

