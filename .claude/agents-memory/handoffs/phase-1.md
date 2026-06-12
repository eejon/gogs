# Phase 1 Handoff: PDF Binary Parser and Security Filter

## What Was Built

### File: `public/plugins/custom-pdf-render/src/pdf-parser.js`
A complete PDF binary format parser that takes an `ArrayBuffer` and produces a structured document object. Approximately 2600 lines of self-contained JavaScript with no external dependencies.

### File: `public/plugins/custom-pdf-render/src/pdf-security.js`
A security filter that sanitizes parsed PDF documents in-place. Approximately 250 lines.

---

## Public Interface

### PDFParser (from pdf-parser.js)

```javascript
const { PDFParser, ParseError } = require('.../src/pdf-parser.js');
// or in browser: classes are globally available after script load

const parser = new PDFParser(arrayBuffer);
parser.parseHeader();           // sets parser.version (e.g., "1.4")

const result = await parser.load();
// result = {
//   version: "1.4",
//   pageCount: 3,
//   pages: [ page0, page1, page2 ],
//   catalog: { ... },       // raw catalog dictionary
//   namedDests: { ... },    // named destinations
//   error: null              // or ParseError instance on failure
// }
```

#### Page Object Structure
Pages are raw dictionaries with PDF-style slash-prefixed keys:
```javascript
page = {
  '/Type': '/Page',
  '/MediaBox': [0, 0, 612, 792],
  '/Contents': streamObject,   // or array of stream objects
  '/Resources': {
    '/Font': { '/F1': { type: 'ref', num: 5, gen: 0 } },
    '/XObject': { ... },
    '/ExtGState': { ... },
    ...
  },
  '/Annots': [ ... ],          // annotation array (if present)
  index: 0                      // zero-based page index
}
```

#### Stream Objects
Stream objects have these properties:
```javascript
stream.isStream = true;           // type marker
stream.dict = { ... };            // the stream's dictionary
stream.rawBytes = Uint8Array;     // compressed bytes
stream.getBytes = function();     // returns decoded Uint8Array
stream._objNum = N;               // object number
stream._gen = G;                  // generation number
// Also includes all dict keys at top level: /Filter, /Length, /Width, etc.
```

#### Indirect References
Unresolved references appear as:
```javascript
{ type: 'ref', num: 5, gen: 0 }
```
Resolve them with `parser.resolveRef(ref)`.

#### String Values
PDF strings are returned as `Uint8Array` (not JS strings). To convert:
```javascript
// Latin-1
let str = '';
for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);

// UTF-16BE (if bytes start with FE FF BOM)
```

#### Name Values
PDF names are returned as strings with the leading slash: `'/Type'`, `'/Page'`, etc.

### ParseError (from pdf-parser.js)
```javascript
class ParseError extends Error {
  constructor(message) { ... }
  // name = 'ParseError'
}
```

### Security Filter (from pdf-security.js)
```javascript
const { sanitizeObject, sanitizeCatalog, isAllowedAction, validateURL } = require('.../src/pdf-security.js');

// Sanitize the catalog (removes /JavaScript name tree, /AA, /AcroForm, /OpenAction if JS, etc.)
sanitizeCatalog(catalog);

// Recursively sanitize any object (strips /JS, /JavaScript, dangerous actions, bad URIs)
sanitizeObject(catalog);
for (const page of pages) {
  sanitizeObject(page);
}

// Check if a specific action dictionary is safe
isAllowedAction(actionDict); // returns boolean

// Check if a URL is safe
validateURL(url); // returns boolean; allows http:, https:, mailto:, relative
```

---

## Stream Decompression Filters Implemented

| Filter | Implementation |
|--------|---------------|
| FlateDecode | Full RFC 1951 DEFLATE from scratch (fixed + dynamic Huffman + stored blocks), zlib header handling |
| ASCIIHexDecode | Complete |
| ASCII85Decode | Complete (with 'z' shorthand) |
| RunLengthDecode | Complete (literal + repeat runs, EOD) |
| LZWDecode | Complete (MSB-first, earlyChange parameter support) |
| CCITTFaxDecode | Basic Group 4 decoder (V0/VR/VL/Pass/Horizontal modes), Group 3 stub |
| DCTDecode | Pass-through (JPEG, browser decodes natively) |
| JPXDecode | Pass-through (JPEG 2000) |
| JBIG2Decode | Pass-through |

### DecodeParms Support
- **PNG Predictor** (types 10-15): None, Sub, Up, Average, Paeth
- **TIFF Predictor** (type 2): horizontal differencing undo

---

## Assumptions Made

1. **Page structure**: Pages are stored as raw dictionaries. The renderer (Phase 2) will need to resolve nested references within resources as needed.

2. **String encoding**: PDF strings are returned as `Uint8Array`, not decoded to JavaScript strings. The renderer will need to handle encoding (WinAnsiEncoding, etc.) during text rendering.

3. **Content streams**: Content streams (page `/Contents`) are stream objects. Call `.getBytes()` to get the decoded operator stream as `Uint8Array`. Multiple content streams in an array should be concatenated.

4. **Resource inheritance**: Resources are inherited from parent `/Pages` nodes and merged into each leaf page during tree traversal.

5. **MediaBox default**: Pages without a `/MediaBox` default to US Letter [0, 0, 612, 792].

6. **Repair mode**: When the xref table has corrupted offsets (entries exist but all point to 0), the parser falls back to a linear scan that searches for "N M obj" patterns in the file.

7. **Object streams**: PDF 1.5+ object streams (/Type /ObjStm) are fully supported. The parser decompresses the stream, parses the header (object-number/offset pairs), and extracts individual objects.

---

## Known Gaps / Deferred Decisions

1. **CCITTFaxDecode (Group 3 1-D)**: The Group 3 1-D decoder returns an empty image of the correct dimensions rather than actually decoding Huffman runs. This is unlikely to be needed for the test corpus but could affect scanned documents. Group 4 2-D has a basic implementation.

2. **Encryption**: Encrypted PDFs are not supported. If a PDF uses /Encrypt, parsing will likely fail or produce garbage. The spec says to show an error message for password-protected PDFs.

3. **Linearized PDFs**: No special handling for linearized (web-optimized) PDFs. They parse correctly through the normal xref path since linearization hints are optional metadata.

4. **Cross-reference stream nested references**: References within xref stream dictionaries are resolved, but if an xref stream's /W or /Index arrays themselves contain references, this won't work. This is extremely rare in practice.

5. **Large file handling**: The parser loads the entire file into memory as a Uint8Array. Files larger than ~500MB may cause memory issues in the browser.

---

## How To Use (Example Pipeline)

```javascript
// 1. Fetch PDF bytes
const response = await fetch(pdfUrl);
const arrayBuffer = await response.arrayBuffer();

// 2. Parse
const parser = new PDFParser(arrayBuffer);
const result = await parser.load();

if (result.error) {
  console.error('Parse error:', result.error.message);
  return;
}

// 3. Sanitize
sanitizeCatalog(result.catalog);
sanitizeObject(result.catalog);
for (const page of result.pages) {
  sanitizeObject(page);
}

// 4. Access pages
for (const page of result.pages) {
  const mediaBox = page['/MediaBox'];  // [0, 0, width, height]
  const contents = page['/Contents'];  // stream object or array
  const resources = page['/Resources'];

  // Get decoded content stream bytes
  if (contents && contents.isStream) {
    const bytes = contents.getBytes();  // Uint8Array of PDF operators
  }

  // Resolve a font reference
  if (resources && resources['/Font']) {
    const fontRef = resources['/Font']['/F1'];
    const fontDict = parser.resolveRef(fontRef);
  }
}
```

---

## Test Results Summary

| Test Suite | Pass | Fail | Total |
|-----------|------|------|-------|
| Phase 1 Core | 25 | 0 | 25 |
| R1 Repair Mode | 4 | 0 | 4 |
| R2 Stream Filters | 17 | 0 | 17 |
| **Total** | **46** | **0** | **46** |
