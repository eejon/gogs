# Phase 1 Handoff: PDF Binary Parser and Security Filter

## What Was Built

Three library files implementing the PDF binary parser and security filter:

### Files

| File | Purpose | Lines |
|------|---------|-------|
| `public/plugins/custom-pdf-render/lib/pdf-stream.js` | Stream decoders (Flate, ASCIIHex, ASCII85, RunLength, predictors) | ~600 |
| `public/plugins/custom-pdf-render/lib/pdf-security.js` | URL validation, action filtering, resource limits, security checks | ~350 |
| `public/plugins/custom-pdf-render/lib/pdf-parser.js` | PDF tokenizer, xref parser, object store, page tree, content stream extraction | ~950 |
| `tests/test-runner.js` | Test suite (81 tests, all passing) | ~650 |
| `tests/corpus.json` | Corpus metadata for test runner | ~100 |

## Public Interface

### PDFDocument (pdf-parser.js)

```javascript
// Constructor
var doc = new PDFDocument(arrayBuffer); // ArrayBuffer or Uint8Array

// Parse the document (must call before other methods)
doc.parse(); // throws PDFParseError on failure

// Page access
doc.getPageCount(); // -> number
doc.getPage(pageNum); // -> page dict with inherited Resources, MediaBox, CropBox, Rotate
                       // pageNum is 1-based

// Content stream
doc.getPageContentStream(pageNum); // -> Uint8Array of decoded content stream data
                                    // Handles array of streams (concatenated with spaces)

// Resource access
doc.getPageResources(pageNum); // -> Resources dictionary (resolved)

// Object resolution
doc.resolveRef(ref); // -> resolved value (if ref is {objNum, genNum, isRef}, resolves it)
doc.getObject(objNum, genNum); // -> parsed object at that xref entry
doc.resolveDeep(value, depth, maxDepth); // -> recursively resolve all refs in a value

// Stream data
doc.getStreamData(streamObj); // -> Uint8Array of decoded stream bytes

// String conversion
doc.stringToJS(pdfString); // -> JavaScript string (handles UTF-16BE, UTF-8, PDFDocEncoding)

// Properties available after parse()
doc.version;     // string, e.g. "1.7"
doc.trailer;     // trailer dictionary
doc.catalog;     // document catalog dictionary
doc.pagesRoot;   // page tree root node
doc.pages;       // flat array of page dictionaries
doc.xrefEntries; // object number -> {offset, gen, free, inStream, ...}
```

### PDFStreamDecoders (pdf-stream.js)

```javascript
// High-level decode pipeline
PDFStreamDecoders.decodeStream(data, filters, decodeParms, maxOutputSize);
// filters: string or string[] of filter names (e.g., "FlateDecode", ["FlateDecode", "ASCIIHexDecode"])
// decodeParms: object or object[] of decode parameters

// Individual decoders
PDFStreamDecoders.flateDecode(data, decodeParms, maxOutputSize);
PDFStreamDecoders.asciiHexDecode(data);
PDFStreamDecoders.ascii85Decode(data);
PDFStreamDecoders.runLengthDecode(data);
PDFStreamDecoders.inflateRaw(data, startOffset, maxOutputSize);
PDFStreamDecoders.applyPredictor(data, params);
```

### PDFSecurity (pdf-security.js)

```javascript
// URL validation
PDFSecurity.validateFileUrl(fileUrl, viewerOrigin);
// -> { valid: boolean, url: string, error: string|null }

// Annotation URI sanitization
PDFSecurity.sanitizeAnnotationUri(uri);
// -> sanitized string or null if blocked

// Action filtering
PDFSecurity.isActionAllowed(actionType); // -> boolean
PDFSecurity.filterAnnotation(annot);     // -> filtered annotation or null
PDFSecurity.filterAdditionalActions(aa); // -> filtered AA dict or null
PDFSecurity.containsJavaScript(dict);    // -> boolean

// Resource tracking
var tracker = new PDFSecurity.ResourceTracker(limits);
tracker.trackObject();
tracker.pushDepth();
tracker.popDepth();
tracker.trackDecompression(size);
tracker.checkTimeout();
tracker.beginResolve(refKey); // -> false if cycle detected
tracker.endResolve(refKey);
tracker.validatePageDimensions(mediaBox);

// Limits object
PDFSecurity.PDFSecurityLimits; // { MAX_OBJECT_COUNT, MAX_RECURSION_DEPTH, etc. }
```

### Module System

All three files export via both `module.exports` (Node.js) and `window.*` (browser):
- `window.PDFStreamDecoders`
- `window.PDFSecurity`
- `window.PDFParser`

In Node.js, `pdf-parser.js` requires `pdf-stream.js` and `pdf-security.js` automatically.
In browser, load via `<script>` tags in dependency order: pdf-stream.js, pdf-security.js, pdf-parser.js.

## Assumptions Made

1. **No DecompressionStream API**: Used pure JS inflate for broader compatibility. The inflate implementation handles both zlib-wrapped and raw deflate.

2. **Object caching**: All resolved objects are cached per document instance. This trades memory for speed but means a document should not be mutated after parsing.

3. **Xref entry priority**: When incremental updates exist (multiple xref sections chained via /Prev), the first entry found for each object number wins (most recent xref is processed first).

4. **Missing /Type inference**: Page tree nodes without an explicit /Type field are inferred as /Pages (if they have /Kids) or /Page (if they have /MediaBox or /Contents).

5. **Stream length fallback**: If /Length is an unresolvable indirect reference (can happen in xref streams before the xref table is built), the parser searches forward for the `endstream` keyword.

6. **Content stream concatenation**: When /Contents is an array of stream references, they are concatenated with a space byte separator between each stream (per PDF spec).

7. **PDFDocEncoding**: The 0x80-0x9F range mapping follows the PDF spec table, not Windows-1252 (they differ in several positions).

## Known Gaps / Deferred Decisions

1. **LZWDecode**: Not implemented. Will throw `PDFStreamError('LZWDecode is not supported')`. Rare in modern PDFs.

2. **CCITTFaxDecode / JBIG2Decode**: Not implemented. Will throw. These are needed for scanned B&W documents. The scanned corpus PDF (8-scanned.pdf) parses structurally but image decoding for these filters will need Phase 2b to handle (or accept as a limitation if the images use these filters).

3. **Encrypted PDFs**: Not supported. The parser will fail on encrypted content.

4. **Object stream nesting**: Object streams cannot themselves be in object streams (per PDF spec), but no explicit check prevents this.

5. **Linearization**: The parser handles linearized PDFs structurally (the leading xref is parsed), but does not optimize for progressive loading.

6. **Content stream tokenizer**: The content stream data is returned as raw decoded bytes. The content stream operator parsing (Tf, Tj, TJ, cm, etc.) is Phase 2a's responsibility. Phase 1 only decodes the bytes.

7. **Font and encoding data**: Not in Phase 1 scope. Phase 2a will need to resolve font dictionaries from page Resources, parse /ToUnicode CMaps, /Encoding + /Differences, /Widths arrays, etc. The object resolution infrastructure in Phase 1 supports this.

## Test Results

All 81 tests pass across the following categories:
- P01 (URL policy): 10 tests
- P02 (binary fetch): 4 tests
- P03 (header): 3 tests
- P04/P05 (xref): 2 tests
- P06 (trailer/catalog): 3 tests
- P07 (object resolution): 3 tests
- P08 (FlateDecode): 4 tests
- P09 (ASCIIHex/ASCII85): 6 tests
- P10 (page tree): 4 tests
- S01 (JS stripping): 5 tests
- S02 (URI sanitization): 8 tests
- S03 (action blocking): 8 tests
- S04 (malformed resilience): 3 tests
- S05 (guardrails): 7 tests
- S06 (DOM/network safety): 4 tests
- Links PDF: 2 tests
- PNG Predictor: 3 tests
- String conversion: 2 tests

All corpus PDFs parse successfully:
- `1&5-arXiv-Latex.pdf` (pdflatex + TikZ)
- `2-lualatex.pdf` (LuaLaTeX, xref streams)
- `3-word-docx.pdf` (Microsoft Word)
- `4-google-doc.pdf` (Google Docs)
- `7-matplotlib-charts.pdf` (matplotlib)
- `8-scanned.pdf` (scanned document)
- `9-browser-print.pdf` (browser print-to-PDF)
- `links.pdf` (link annotations)
