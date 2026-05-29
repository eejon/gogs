# Phase 1 Parser — Handoff to Phase 2 (Canvas Renderer)

**Date**: 2026-05-26
**Agent**: phase1-parser
**Status**: COMPLETE — 25/25 tests passing

---

## What Was Built

| File | Purpose |
|------|---------|
| `public/plugins/custom-pdf-render/src/pdf-parser.js` | Binary PDF parser, xref, object resolution, stream decode |
| `public/plugins/custom-pdf-render/src/pdf-security.js` | Action filter, URL validator, catalog/page sanitizer |
| `tests/test-runner.js` | Node.js test runner, reads corpus.json, reports PASS/FAIL |
| `tests/run1/results.md` | Test results from first run (25/25 PASS) |
| `agents-memory/checkpoints/phase1-parser.md` | Phase checkpoint |

---

## Public API: `PDFParser`

### Constructor
```js
const parser = new PDFParser(arrayBuffer);
// arrayBuffer: ArrayBuffer | Uint8Array
// throws ParseError if not a valid input type
```

### `async load()` → `{catalog, pages, pageCount}` or `{error: ParseError}`
Top-level parse entry point. Never throws — wraps everything in try/catch.
- On success: `{ catalog: Object, pages: Array<Object>, pageCount: Number }`
- On failure: `{ error: ParseError }`

### `parseHeader()` → `string`
Validates `%PDF-` magic bytes; sets `this.version`; returns version string (e.g. `"1.4"`).
Throws `ParseError` if not a PDF.

### `findStartxref()` → `number`
Scans last 1024 bytes for `startxref` keyword; returns the byte offset integer.
Throws `ParseError` if not found.

### `async parseXref(offset)` → `void`
Dispatches to `parseXrefTable` or `parseXrefStream` depending on what's at `offset`.
Populates `this.xrefOffsets` and `this.xrefGens`.

### `async parseXrefTable(offset)` → `void`
Parses traditional xref table sections. Handles multiple subsections and `/Prev` chains.
Populates `this.xrefOffsets`, `this.xrefGens`, `this.trailer`.

### `async parseXrefStream(offset)` → `void`
Parses PDF 1.5+ cross-reference stream. Handles `/W`, `/Index`, type-1 and type-2 entries.
Populates `this.xrefOffsets`, `this.xrefGens`, `this.trailer`.

### `parseTrailer(offset)` → `Object`
Parses trailer dictionary at `offset`. Returns the raw dict object.
(Mostly used internally; `load()` calls this automatically.)

### `async resolveObject(objNum, genNum, _seen?, _depth?)` → any
Resolves an indirect object by number. Returns the parsed value (dict, array, string, number, etc.).
- Cycle detection via `_seen` Set (keyed `"objNum/genNum"`) and `_depth` limit of 10.
- Returns `null` if object not found or depth exceeded.
- For stream objects: returns `{ isStream: true, dict, rawBytes, getBytes: async()=>Uint8Array }`.

### `async getPageTree(catalogObj)` → `Array<Object>`
Walks the `/Pages` tree from the catalog. Returns flat array of page dicts (up to 500 pages).

---

## Public API: `pdf-security.js`

### `sanitizeObject(obj, depth?)` → obj
Recursively mutates a parsed PDF object tree in place.
- Removes `/AA` (Additional Actions) at any level.
- Nulls out `/JS` and `/JavaScript` entries at any level.
- Nulls out action dicts (`/A`, `/Action`, any dict with `/S`) that are not in the allowlist.
- Max depth: 20. Max keys per level: 10,000.

### `isAllowedAction(actionDict)` → boolean
Returns true only for safe action types:
- `/S /GoTo` — always allowed (internal page navigation)
- `/S /URI` — allowed only if URI passes `validateURL()`
Everything else returns false.

### `validateURL(urlString)` → boolean
- Blocks: `javascript:`, `data:`, `blob:`, `file:`, `vbscript:`, `about:`
- Allows: relative paths (no scheme or starts with `/`)
- Allows: `http://` and `https://` absolute URLs
- In browser context: enforces same-origin via `window.location`
- In Node.js: accepts any `http/https` or relative URL

### `sanitizeCatalog(catalogObj)` → catalogObj
Deletes/nulls: `/OpenAction`, `/AA`, `/JavaScript`, `/Names./JavaScript`, `/Names./JS`.

### `sanitizePage(pageObj)` → pageObj
Deletes/nulls: `/AA`, `/A` (if not in allowlist).

---

## Parsed Object Schema

### Dictionary
Plain JS object with string keys starting with `/`:
```js
{ '/Type': '/Page', '/MediaBox': [0, 0, 612, 792], '/Contents': {...} }
```

### Indirect Reference (unresolved)
```js
{ isRef: true, objNum: 5, genNum: 0 }
```
After `resolveObject()`, replaced with actual value.

### Stream Object
```js
{
  isStream: true,
  dict: { '/Filter': '/FlateDecode', '/Length': 1234, ... },
  rawBytes: Uint8Array,
  getBytes: async () => Uint8Array   // decompressed bytes
}
```
`getBytes()` decompresses on-demand. Never throws — returns raw bytes on failure.

### Literal String
```js
{ value: Uint8Array, isLiteralString: true }
```
Bytes from `(...)` string. Use `String.fromCharCode(...arr)` to decode as Latin-1,
or interpret as UTF-16BE if starts with BOM `0xFE 0xFF`.

### Hex String
```js
{ value: Uint8Array, isHexString: true }
```
Decoded bytes from `<...>` hex string.

### Name
String starting with `/`: `'/FlateDecode'`, `'/Page'`, etc.

### Array
JS Array.

### Numbers, Booleans, Null
Native JS types.

---

## Name Convention for Filter Strings

`_normalizeFilters(filter)` normalizes `/Filter` values to bare strings:
- `/FlateDecode` → `'FlateDecode'`
- `['/FlateDecode', '/ASCIIHexDecode']` → `['FlateDecode', 'ASCIIHexDecode']`

`decodeStream(rawBytes, filters)` accepts the normalized (no-slash) form.

Supported filters: `FlateDecode`, `Fl`, `ASCIIHexDecode`, `AHx`, `ASCII85Decode`, `A85`.
Unknown filters pass bytes through unchanged.

---

## Test Results (25/25 PASS)

| PDF | Page Count | Result | Notes |
|-----|-----------|--------|-------|
| text-only.pdf | 3 | PASS | All 4 checks pass |
| images.pdf | 1 | PASS | All 4 checks pass |
| mixed.pdf | 1 | PASS | All 4 checks pass |
| links.pdf | 1 | PASS | All 4 checks pass |
| poc.pdf | 1 | PASS | 6 checks pass incl. JS sanitize |
| malformed.pdf | N/A | PASS | Returns ParseError, no crash |

---

## Assumptions Made

1. All FlateDecode streams in the corpus use zlib header (`0x78 0x9c`). The `decodeStream()`
   function detects the zlib header and uses the appropriate decompression path.
2. PDF name objects are stored with the leading `/` included in the string. All downstream
   code (renderer, viewer) must use `/Type`, `/Pages`, `/Contents`, etc. as dict keys.
3. Dictionary keys from `parseDictionary()` always include the leading `/` from `parseName()`.
4. After `load()`, all indirect references in the catalog and page tree are resolved eagerly
   via `_resolveRefs()`. Stream dict values are also resolved but stream body is lazy.
5. Page objects from `getPageTree()` have their properties resolved — use dict keys directly.
6. `/Resources` inside page dicts may itself be a resolved dict or a stream dict wrapper.

---

## Known Gaps / Deferred Decisions

1. **Linearized PDFs**: Not explicitly handled. The parser uses the xref at `startxref` offset
   and follows `/Prev` chains. Most linearized PDFs will work, but the linearization hint stream
   is ignored.

2. **Encrypted PDFs**: Not supported. If `/Encrypt` key exists in trailer, `load()` will return
   a result but rendering will produce garbled content. Phase 3 viewer should detect `/Encrypt`
   and display an error message.

3. **Cross-reference stream + table hybrid**: Not tested. The parser handles each `startxref`
   as either table or stream, following `/Prev` chains. Mixed-mode documents may work but
   are not explicitly tested.

4. **Type-2 xref entries (object streams)**: Implemented. Tested indirectly via poc.pdf (PDF 1.7).

5. **Stream decode errors**: `getBytes()` returns raw (compressed) bytes on failure rather than
   throwing. The renderer should be prepared for undecoded stream content.

6. **Unicode text in PDF strings**: Strings are returned as `Uint8Array`. Latin-1 and UTF-16BE
   (BOM `0xFE 0xFF`) decoding is the renderer's responsibility. Phase 2 renderer should
   implement `_pdfStringToText(uint8arr)` that handles both encodings.

---

## Notes for Phase 2 Renderer Agent

### How to use PDFParser

```js
const { PDFParser } = require('./src/pdf-parser.js');

const parser = new PDFParser(arrayBuffer);
const { catalog, pages, pageCount, error } = await parser.load();

if (error) {
  // Show error UI
  return;
}

// Render page N (0-indexed):
const pageDict = pages[n];
const mediaBox = pageDict['/MediaBox']; // [x1, y1, x2, y2]
const contents  = pageDict['/Contents']; // stream obj or array of stream objs
const resources = pageDict['/Resources']; // dict
```

### Getting page content stream bytes

```js
// /Contents may be a single stream or an array of streams
async function getContentBytes(contents) {
  if (!contents) return new Uint8Array(0);
  if (Array.isArray(contents)) {
    const parts = await Promise.all(contents.map(s => s.isStream ? s.getBytes() : Promise.resolve(new Uint8Array(0))));
    // Concatenate with a space separator (required by PDF spec)
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { result.set(p, offset); offset += p.length; result[offset++] = 0x20; }
    return result;
  }
  if (contents.isStream) return contents.getBytes();
  return new Uint8Array(0);
}
```

### Font resources

```js
const fonts = resources['/Font']; // dict: { '/F1': {...fontDict}, '/F2': {...} }
// fontDict keys: /Type, /Subtype, /BaseFont, /Encoding, /FontDescriptor, /Widths, /FirstChar, /LastChar
```

### XObject resources (images)

```js
const xobjects = resources['/XObject']; // dict: { '/Im1': {...streamObj}, '/Img0': {...} }
// Each value is a stream object with dict.'/Subtype' === '/Image'
// For images: dict['/Width'], dict['/Height'], dict['/ColorSpace'], dict['/BitsPerComponent']
// Image bytes: await xobjects['/Im1'].getBytes()
```

### Security

Always call `sanitizeCatalog(catalog)` and `sanitizeObject(page)` on each page
before passing to the renderer. The parser's `load()` already calls `sanitizeCatalogActions()`
but `sanitizeObject` provides deeper recursive sanitization.

### Canvas coordinate system

PDF user space has origin at bottom-left with Y increasing upward.
Canvas 2D has origin at top-left with Y increasing downward.
The renderer must apply a vertical flip transform:
```js
ctx.setTransform(scale, 0, 0, -scale, 0, height);
```
where `height` is `(mediaBox[3] - mediaBox[1]) * scale`.
