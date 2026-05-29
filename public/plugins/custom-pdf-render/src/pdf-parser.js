/**
 * pdf-parser.js — Pure JavaScript PDF binary parser
 * Part of the custom-pdf-render engine for Gogs.
 *
 * No external library imports. Uses only browser/Node built-ins.
 * All loops over PDF-derived data have iteration limits.
 * All array index operations have bounds checks.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_PAGES           = 500;
const MAX_XREF_OBJECTS    = 1_000_000;
const MAX_STREAM_BYTES    = 50 * 1024 * 1024; // 50 MB
const MAX_RESOLVE_DEPTH   = 10;
const MAX_PARSE_ITERATIONS = 10_000_000;
const MAX_XREF_SECTIONS   = 50_000;

// ─── Errors ───────────────────────────────────────────────────────────────────

class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

// ─── Token constants ──────────────────────────────────────────────────────────

const CHAR_SPACE     = 0x20;
const CHAR_TAB       = 0x09;
const CHAR_LF        = 0x0a;
const CHAR_CR        = 0x0d;
const CHAR_FF        = 0x0c;
const CHAR_NULL      = 0x00;
const CHAR_PERCENT   = 0x25;
const CHAR_LANGLE    = 0x3c;
const CHAR_RANGLE    = 0x3e;
const CHAR_LBRACKET  = 0x5b;
const CHAR_RBRACKET  = 0x5d;
const CHAR_LPAREN    = 0x28;
const CHAR_RPAREN    = 0x29;
const CHAR_SLASH     = 0x2f;
const CHAR_HASH      = 0x23;

function isWhitespace(c) {
  return c === CHAR_SPACE || c === CHAR_TAB || c === CHAR_LF ||
         c === CHAR_CR    || c === CHAR_FF   || c === CHAR_NULL;
}

function isDelimiter(c) {
  return c === CHAR_LANGLE  || c === CHAR_RANGLE  ||
         c === CHAR_LBRACKET || c === CHAR_RBRACKET ||
         c === CHAR_LPAREN  || c === CHAR_RPAREN   ||
         c === CHAR_SLASH   || c === CHAR_PERCENT;
}

function isRegularChar(c) {
  return !isWhitespace(c) && !isDelimiter(c);
}

// ─── Byte utilities ───────────────────────────────────────────────────────────

/** Decode a sequence of ASCII bytes as a string. */
function bytesToString(bytes, start, end) {
  if (start === undefined) start = 0;
  if (end === undefined) end = bytes.length;
  end = Math.min(end, bytes.length);
  let s = '';
  for (let i = start; i < end; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

/** Find a byte sequence (needle) in bytes starting at fromIndex. Returns -1 if not found. */
function findBytes(bytes, needle, fromIndex) {
  if (fromIndex === undefined) fromIndex = 0;
  const len = bytes.length;
  const nlen = needle.length;
  if (nlen === 0) return fromIndex;
  outer: for (let i = fromIndex; i <= len - nlen; i++) {
    for (let j = 0; j < nlen; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Find last occurrence of needle in bytes[0..limit]. */
function findLastBytes(bytes, needle, limit) {
  if (limit === undefined) limit = bytes.length;
  const nlen = needle.length;
  let found = -1;
  let pos = 0;
  while (pos <= limit - nlen) {
    outer: {
      for (let j = 0; j < nlen; j++) {
        if (bytes[pos + j] !== needle[j]) break outer;
      }
      found = pos;
    }
    pos++;
  }
  return found;
}

/** Read ASCII integer at bytes[offset], return {value, nextOffset}. */
function readInt(bytes, offset) {
  let i = offset;
  let sign = 1;
  if (i < bytes.length && bytes[i] === 0x2d) { sign = -1; i++; }
  else if (i < bytes.length && bytes[i] === 0x2b) { i++; }
  let n = 0;
  let hasDigit = false;
  while (i < bytes.length) {
    const c = bytes[i];
    if (c >= 0x30 && c <= 0x39) {
      n = n * 10 + (c - 0x30);
      hasDigit = true;
      i++;
    } else {
      break;
    }
  }
  if (!hasDigit) return null;
  return { value: sign * n, nextOffset: i };
}

/** Skip whitespace and comments starting at offset, return new offset. */
function skipWhitespace(bytes, offset) {
  const len = bytes.length;
  let i = offset;
  let iterations = 0;
  while (i < len) {
    if (++iterations > MAX_PARSE_ITERATIONS) break;
    const c = bytes[i];
    if (isWhitespace(c)) {
      i++;
    } else if (c === CHAR_PERCENT) {
      // comment — skip to end of line
      while (i < len && bytes[i] !== CHAR_LF && bytes[i] !== CHAR_CR) i++;
    } else {
      break;
    }
  }
  return i;
}

// ─── Stream decompression ─────────────────────────────────────────────────────

/**
 * Decompress stream bytes using the given filters array.
 * Supports FlateDecode. Passes through unknown filters unchanged.
 * Uses DecompressionStream if available, otherwise falls back to Node.js zlib.
 *
 * Returns a Promise<Uint8Array>.
 */
async function decodeStream(rawBytes, filters) {
  if (!filters || filters.length === 0) return rawBytes;

  let data = rawBytes;
  for (let fi = 0; fi < filters.length; fi++) {
    const filter = filters[fi];
    if (filter === 'FlateDecode' || filter === 'Fl') {
      data = await _flateDecode(data);
    } else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
      data = _asciiHexDecode(data);
    } else if (filter === 'ASCII85Decode' || filter === 'A85') {
      data = _ascii85Decode(data);
    } else {
      // Unknown filter — return raw bytes as-is for this filter
      // (e.g. DCTDecode, CCITTFaxDecode are handled by renderer)
    }
  }
  return data;
}

async function _flateDecode(bytes) {
  // Check for zlib header (CMF byte 0x78)
  const hasZlibHeader = bytes.length >= 2 && bytes[0] === 0x78;

  // Enforce output size limit
  if (bytes.length > MAX_STREAM_BYTES) {
    throw new ParseError('FlateDecode input exceeds 50 MB limit');
  }

  // Try browser/WHATWG DecompressionStream first
  if (typeof DecompressionStream !== 'undefined') {
    const format = hasZlibHeader ? 'deflate' : 'deflate-raw';
    try {
      return await _decompressWithStream(bytes, format);
    } catch (e) {
      // deflate-raw may not be supported in older browsers/Node 18; try deflate
      if (!hasZlibHeader) {
        try {
          return await _decompressWithStream(bytes, 'deflate');
        } catch (_) {}
      }
      throw new ParseError('FlateDecode decompression failed: ' + e.message);
    }
  }

  // Node.js fallback: use zlib module
  if (typeof require !== 'undefined') {
    try {
      const zlib = require('zlib');
      return await new Promise((resolve, reject) => {
        const fn = hasZlibHeader ? zlib.inflate : zlib.inflateRaw;
        fn(Buffer.from(bytes), { maxOutputLength: MAX_STREAM_BYTES }, (err, buf) => {
          if (err) reject(new ParseError('FlateDecode zlib error: ' + err.message));
          else resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        });
      });
    } catch (e) {
      throw new ParseError('FlateDecode Node.js zlib error: ' + e.message);
    }
  }

  throw new ParseError('FlateDecode: no decompression engine available');
}

async function _decompressWithStream(bytes, format) {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});

  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_STREAM_BYTES) {
      throw new ParseError('FlateDecode decompressed output exceeds 50 MB limit');
    }
    chunks.push(value);
  }

  // Concatenate chunks
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function _asciiHexDecode(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i];
    if (c === 0x3e) break; // '>'
    if (isWhitespace(c)) { i++; continue; }
    const hi = _hexVal(c);
    i++;
    let lo = 0;
    if (i < bytes.length && bytes[i] !== 0x3e && !isWhitespace(bytes[i])) {
      lo = _hexVal(bytes[i]);
      i++;
    }
    out.push((hi << 4) | lo);
  }
  return new Uint8Array(out);
}

function _hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return 0;
}

function _ascii85Decode(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i];
    if (c === 0x7e && i + 1 < bytes.length && bytes[i + 1] === 0x3e) break; // '~>'
    if (isWhitespace(c)) { i++; continue; }
    if (c === 0x7a) { // 'z'
      out.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const chars = [];
    let j = i;
    while (chars.length < 5 && j < bytes.length) {
      const ch = bytes[j];
      if (!isWhitespace(ch)) chars.push(ch - 0x21);
      j++;
    }
    while (chars.length < 5) chars.push(84); // pad with 'u'
    let v = chars[0] * 52200625 + chars[1] * 614125 + chars[2] * 7225 + chars[3] * 85 + chars[4];
    const nBytes = Math.min(4, j - i - (5 - (j - i > 5 ? 0 : 5 - (j - i))));
    const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    const count = chars.length === 5 ? 4 : chars.length - 1;
    for (let k = 0; k < count; k++) out.push(b[k]);
    i = j;
  }
  return new Uint8Array(out);
}

// ─── PDF Object Parser ────────────────────────────────────────────────────────

/**
 * Parse a PDF object starting at bytes[offset].
 * Returns { value, nextOffset } or throws ParseError.
 *
 * Handles: dict, array, name, literal string, hex string,
 * integer, real, boolean, null, indirect reference (N G R).
 * Streams are returned as { streamOffset, streamLength, dict } and
 * decoded lazily by the caller.
 */
function parsePDFObject(bytes, offset) {
  const len = bytes.length;
  if (offset >= len) throw new ParseError('Unexpected EOF at offset ' + offset);

  offset = skipWhitespace(bytes, offset);
  if (offset >= len) throw new ParseError('Unexpected EOF after whitespace at ' + offset);

  const c = bytes[offset];

  // Dictionary <<...>> or hex string <...>
  if (c === CHAR_LANGLE) {
    if (offset + 1 < len && bytes[offset + 1] === CHAR_LANGLE) {
      return parseDictionary(bytes, offset);
    } else {
      return parseHexString(bytes, offset);
    }
  }

  // Array [...]
  if (c === CHAR_LBRACKET) {
    return parseArray(bytes, offset);
  }

  // Literal string (...)
  if (c === CHAR_LPAREN) {
    return parseLiteralString(bytes, offset);
  }

  // Name /...
  if (c === CHAR_SLASH) {
    return parseName(bytes, offset);
  }

  // Try to read a token (number, keyword, indirect ref)
  return parseToken(bytes, offset);
}

function parseName(bytes, offset) {
  // offset points to '/'
  let i = offset + 1;
  const len = bytes.length;
  let name = '';
  while (i < len && isRegularChar(bytes[i])) {
    const c = bytes[i];
    if (c === CHAR_HASH && i + 2 < len) {
      // Hex escape #XX
      const hi = _hexVal(bytes[i + 1]);
      const lo = _hexVal(bytes[i + 2]);
      name += String.fromCharCode((hi << 4) | lo);
      i += 3;
    } else {
      name += String.fromCharCode(c);
      i++;
    }
  }
  return { value: '/' + name, nextOffset: i };
}

function parseHexString(bytes, offset) {
  // offset points to '<'
  let i = offset + 1;
  const len = bytes.length;
  const hex = [];
  let iterations = 0;
  while (i < len && bytes[i] !== CHAR_RANGLE) {
    if (++iterations > MAX_PARSE_ITERATIONS) throw new ParseError('Hex string too long');
    const c = bytes[i];
    if (!isWhitespace(c)) hex.push(c);
    i++;
  }
  if (i >= len) throw new ParseError('Unterminated hex string');
  i++; // skip '>'
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let j = 0; j < out.length; j++) {
    const hi = _hexVal(hex[j * 2]);
    const lo = j * 2 + 1 < hex.length ? _hexVal(hex[j * 2 + 1]) : 0;
    out[j] = (hi << 4) | lo;
  }
  return { value: out, isHexString: true, nextOffset: i };
}

function parseLiteralString(bytes, offset) {
  // offset points to '('
  let i = offset + 1;
  const len = bytes.length;
  const out = [];
  let depth = 1;
  let iterations = 0;
  while (i < len && depth > 0) {
    if (++iterations > MAX_PARSE_ITERATIONS) throw new ParseError('Literal string too long');
    const c = bytes[i];
    if (c === 0x5c) { // backslash
      i++;
      if (i >= len) break;
      const esc = bytes[i];
      switch (esc) {
        case 0x6e: out.push(0x0a); break; // \n
        case 0x72: out.push(0x0d); break; // \r
        case 0x74: out.push(0x09); break; // \t
        case 0x62: out.push(0x08); break; // \b
        case 0x66: out.push(0x0c); break; // \f
        case 0x28: out.push(0x28); break; // \(
        case 0x29: out.push(0x29); break; // \)
        case 0x5c: out.push(0x5c); break; // \\
        case CHAR_LF: break; // line continuation
        case CHAR_CR:
          if (i + 1 < len && bytes[i + 1] === CHAR_LF) i++;
          break;
        default:
          // Octal \ddd
          if (esc >= 0x30 && esc <= 0x37) {
            let oct = esc - 0x30;
            let j = i + 1;
            if (j < len && bytes[j] >= 0x30 && bytes[j] <= 0x37) {
              oct = oct * 8 + (bytes[j] - 0x30); j++;
              if (j < len && bytes[j] >= 0x30 && bytes[j] <= 0x37) {
                oct = oct * 8 + (bytes[j] - 0x30); j++;
              }
            }
            out.push(oct & 0xff);
            i = j - 1;
          } else {
            out.push(esc);
          }
      }
    } else if (c === CHAR_LPAREN) {
      depth++;
      out.push(c);
    } else if (c === CHAR_RPAREN) {
      depth--;
      if (depth > 0) out.push(c);
    } else {
      out.push(c);
    }
    i++;
  }
  return { value: new Uint8Array(out), isLiteralString: true, nextOffset: i };
}

function parseArray(bytes, offset) {
  // offset points to '['
  let i = offset + 1;
  const len = bytes.length;
  const arr = [];
  let iterations = 0;
  while (i < len) {
    if (++iterations > MAX_PARSE_ITERATIONS) throw new ParseError('Array too large');
    i = skipWhitespace(bytes, i);
    if (i >= len) throw new ParseError('Unterminated array');
    if (bytes[i] === CHAR_RBRACKET) { i++; break; }
    const result = parsePDFObject(bytes, i);
    arr.push(result.value);
    i = result.nextOffset;
  }
  return { value: arr, nextOffset: i };
}

function parseDictionary(bytes, offset) {
  // offset points to '<<'
  let i = offset + 2;
  const len = bytes.length;
  const dict = {};
  let iterations = 0;
  while (i < len) {
    if (++iterations > MAX_PARSE_ITERATIONS) throw new ParseError('Dictionary too large');
    i = skipWhitespace(bytes, i);
    if (i >= len) throw new ParseError('Unterminated dictionary');
    if (bytes[i] === CHAR_RANGLE && i + 1 < len && bytes[i + 1] === CHAR_RANGLE) {
      i += 2;
      break;
    }
    // Expect name key
    if (bytes[i] !== CHAR_SLASH) {
      throw new ParseError('Expected name key in dictionary at offset ' + i);
    }
    const keyResult = parseName(bytes, i);
    const key = keyResult.value;
    i = keyResult.nextOffset;
    i = skipWhitespace(bytes, i);
    if (i >= len) throw new ParseError('Dictionary key without value');
    const valResult = parsePDFObject(bytes, i);
    dict[key] = valResult.value;
    i = valResult.nextOffset;
  }

  // Check for 'stream' keyword after dictionary
  const savedI = i;
  i = skipWhitespace(bytes, i);
  if (i < len) {
    // Check if "stream" follows
    if (i + 6 <= len &&
        bytes[i]   === 0x73 && bytes[i+1] === 0x74 && bytes[i+2] === 0x72 &&
        bytes[i+3] === 0x65 && bytes[i+4] === 0x61 && bytes[i+5] === 0x6d) {
      // Found stream keyword
      let streamStart = i + 6;
      // Skip mandatory EOL after 'stream'
      if (streamStart < len && bytes[streamStart] === CHAR_CR) streamStart++;
      if (streamStart < len && bytes[streamStart] === CHAR_LF) streamStart++;
      return { value: dict, isStream: true, streamOffset: streamStart, dictOffset: offset, nextOffset: savedI };
    }
  }

  return { value: dict, nextOffset: savedI };
}

function parseToken(bytes, offset) {
  const len = bytes.length;
  let i = offset;

  // Read token
  let token = '';
  while (i < len && isRegularChar(bytes[i])) {
    token += String.fromCharCode(bytes[i]);
    i++;
  }

  if (token === '') {
    throw new ParseError('Unexpected character 0x' + bytes[offset].toString(16) + ' at offset ' + offset);
  }

  // Boolean
  if (token === 'true')  return { value: true,  nextOffset: i };
  if (token === 'false') return { value: false, nextOffset: i };
  if (token === 'null')  return { value: null,  nextOffset: i };

  // Could be number, or first part of indirect reference (N G R)
  const n1 = parseFloat(token);
  if (!isNaN(n1)) {
    // peek ahead for indirect reference pattern
    const savedI = i;
    const ws1 = skipWhitespace(bytes, i);
    if (ws1 < len && isRegularChar(bytes[ws1])) {
      let token2 = '';
      let j = ws1;
      while (j < len && isRegularChar(bytes[j])) {
        token2 += String.fromCharCode(bytes[j]);
        j++;
      }
      const n2 = parseInt(token2, 10);
      if (!isNaN(n2) && String(n2) === token2) {
        // peek for 'R' or 'obj'
        const ws2 = skipWhitespace(bytes, j);
        if (ws2 < len) {
          if (bytes[ws2] === 0x52) { // 'R'
            // Indirect reference: N G R
            return {
              value: { isRef: true, objNum: Math.floor(n1), genNum: n2 },
              nextOffset: ws2 + 1
            };
          }
          if (ws2 + 2 < len &&
              bytes[ws2] === 0x6f && bytes[ws2+1] === 0x62 && bytes[ws2+2] === 0x6a) {
            // 'obj' keyword — this is the start of an indirect object definition
            // Return the object number/gen pair as special marker
            return {
              value: { isObjDef: true, objNum: Math.floor(n1), genNum: n2 },
              nextOffset: ws2 + 3
            };
          }
        }
      }
    }
    // Just a number
    return { value: Number.isInteger(n1) && !token.includes('.') ? Math.floor(n1) : n1, nextOffset: i };
  }

  // Keyword (stream, endobj, endstream, xref, trailer, startxref, etc.)
  return { value: { keyword: token }, nextOffset: i };
}

// ─── PDFParser class ──────────────────────────────────────────────────────────

class PDFParser {
  constructor(arrayBuffer) {
    if (arrayBuffer instanceof ArrayBuffer) {
      this.bytes = new Uint8Array(arrayBuffer);
    } else if (arrayBuffer instanceof Uint8Array) {
      this.bytes = arrayBuffer;
    } else {
      throw new ParseError('PDFParser: expected ArrayBuffer or Uint8Array');
    }
    this.xrefOffsets = {};   // objNum -> byteOffset
    this.xrefGens    = {};   // objNum -> genNum
    this.trailer     = null;
    this.version     = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Top-level parse. Returns { catalog, pages, pageCount } or { error: ParseError }.
   */
  async load() {
    try {
      this.parseHeader();
      const startxref = this.findStartxref();
      await this.parseXref(startxref);
      if (!this.trailer) throw new ParseError('No trailer dictionary found');

      const rootRef = this.trailer['/Root'];
      if (!rootRef || !rootRef.isRef) throw new ParseError('Trailer missing /Root reference');

      const catalog = await this.resolveObject(rootRef.objNum, rootRef.genNum);
      if (!catalog || typeof catalog !== 'object') throw new ParseError('Could not resolve catalog');

      await this.sanitizeCatalogActions(catalog);

      const pages = await this.getPageTree(catalog);
      return { catalog, pages, pageCount: pages.length };
    } catch (e) {
      if (e instanceof ParseError) return { error: e };
      return { error: new ParseError(e.message || String(e)) };
    }
  }

  // ── Header ──────────────────────────────────────────────────────────────────

  parseHeader() {
    const bytes = this.bytes;
    if (bytes.length < 5) throw new ParseError('File too short to be a PDF');
    if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 ||
        bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
      throw new ParseError('Not a PDF file: missing %PDF- header');
    }
    // Parse version
    let i = 5;
    let version = '';
    while (i < bytes.length && i < 12 && !isWhitespace(bytes[i])) {
      version += String.fromCharCode(bytes[i++]);
    }
    this.version = version;
    return version;
  }

  // ── startxref ───────────────────────────────────────────────────────────────

  findStartxref() {
    const bytes = this.bytes;
    // Search last 1024 bytes for 'startxref'
    const searchStart = Math.max(0, bytes.length - 1024);
    const needle = [0x73,0x74,0x61,0x72,0x74,0x78,0x72,0x65,0x66]; // 'startxref'
    let found = -1;
    for (let i = bytes.length - needle.length; i >= searchStart; i--) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) { match = false; break; }
      }
      if (match) { found = i; break; }
    }
    if (found === -1) throw new ParseError('startxref not found');

    let i = skipWhitespace(bytes, found + needle.length);
    const r = readInt(bytes, i);
    if (!r) throw new ParseError('Invalid startxref value');
    return r.value;
  }

  // ── Cross-reference table / stream ──────────────────────────────────────────

  async parseXref(offset) {
    const bytes = this.bytes;
    if (offset < 0 || offset >= bytes.length) {
      throw new ParseError('xref offset out of bounds: ' + offset);
    }
    let i = skipWhitespace(bytes, offset);

    // Traditional xref table starts with keyword 'xref'
    if (i + 4 <= bytes.length &&
        bytes[i] === 0x78 && bytes[i+1] === 0x72 &&
        bytes[i+2] === 0x65 && bytes[i+3] === 0x66) {
      await this.parseXrefTable(i);
    } else {
      // PDF 1.5+ cross-reference stream
      await this.parseXrefStream(i);
    }
  }

  async parseXrefTable(offset) {
    const bytes = this.bytes;
    let i = offset + 4; // skip 'xref'
    let sectionCount = 0;

    while (i < bytes.length && sectionCount < MAX_XREF_SECTIONS) {
      i = skipWhitespace(bytes, i);
      if (i >= bytes.length) break;

      // Check for 'trailer'
      if (i + 7 <= bytes.length &&
          bytes[i] === 0x74 && bytes[i+1] === 0x72 && bytes[i+2] === 0x61 &&
          bytes[i+3] === 0x69 && bytes[i+4] === 0x6c && bytes[i+5] === 0x65 && bytes[i+6] === 0x72) {
        // Found trailer
        i += 7;
        i = skipWhitespace(bytes, i);
        const result = parseDictionary(bytes, i);
        const trailerDict = result.value;
        if (!this.trailer) this.trailer = trailerDict;
        i = result.nextOffset;

        // Check for prev xref
        if (trailerDict['/Prev'] !== undefined && typeof trailerDict['/Prev'] === 'number') {
          const prevOffset = trailerDict['/Prev'];
          if (prevOffset > 0 && prevOffset < bytes.length) {
            await this.parseXref(prevOffset);
          }
        }
        break;
      }

      // Parse subsection header: firstObj count
      const r1 = readInt(bytes, i);
      if (!r1) break;
      let firstObj = r1.value;
      i = skipWhitespace(bytes, r1.nextOffset);
      const r2 = readInt(bytes, i);
      if (!r2) break;
      let count = r2.value;
      i = r2.nextOffset;

      // Bounds check: limit count
      if (count < 0 || count > MAX_XREF_OBJECTS) {
        throw new ParseError('xref subsection count out of bounds: ' + count);
      }

      // Skip EOL after subsection header
      if (i < bytes.length && bytes[i] === CHAR_SPACE) i++;
      if (i < bytes.length && bytes[i] === CHAR_CR) i++;
      if (i < bytes.length && bytes[i] === CHAR_LF) i++;

      // Each entry is exactly 20 bytes: "nnnnnnnnnn ggggg n/f\r\n"
      for (let e = 0; e < count; e++) {
        const objNum = firstObj + e;
        if (i + 20 > bytes.length) break;
        if (objNum < 0 || objNum >= MAX_XREF_OBJECTS) { i += 20; continue; }

        const offsetStr = bytesToString(bytes, i, i + 10);
        const genStr    = bytesToString(bytes, i + 11, i + 16);
        const typeChar  = String.fromCharCode(bytes[i + 17]);

        const byteOffset = parseInt(offsetStr, 10);
        const gen        = parseInt(genStr, 10);

        if (typeChar === 'n' && !isNaN(byteOffset) && byteOffset >= 0) {
          // Only add if not already in table (later xrefs take precedence)
          if (!(objNum in this.xrefOffsets)) {
            this.xrefOffsets[objNum] = byteOffset;
            this.xrefGens[objNum]    = isNaN(gen) ? 0 : gen;
          }
        }
        i += 20;
      }
      sectionCount++;
    }
  }

  async parseXrefStream(offset) {
    const bytes = this.bytes;
    // Parse the stream object
    const result = parseDictionary(bytes, offset);
    if (!result.isStream) throw new ParseError('Expected xref stream at offset ' + offset);

    const dict = result.value;
    if (!this.trailer) this.trailer = dict;

    // Determine stream length
    let length = dict['/Length'];
    if (typeof length === 'object' && length && length.isRef) {
      length = await this.resolveObject(length.objNum, length.genNum);
    }
    if (typeof length !== 'number') throw new ParseError('xref stream missing /Length');

    // Clamp length to available bytes
    const streamStart = result.streamOffset;
    const streamEnd   = Math.min(streamStart + length, bytes.length);
    const rawStream   = bytes.slice(streamStart, streamEnd);

    // Decode stream
    const filters = _normalizeFilters(dict['/Filter']);
    const decoded = await decodeStream(rawStream, filters);

    // Parse /W (field widths)
    const W = dict['/W'];
    if (!Array.isArray(W) || W.length < 3) throw new ParseError('xref stream missing /W');
    const w1 = W[0], w2 = W[1], w3 = W[2];
    const entrySize = w1 + w2 + w3;
    if (entrySize <= 0) throw new ParseError('xref stream /W entry size is zero');

    // Parse /Index (subsection pairs)
    let index = dict['/Index'];
    if (!Array.isArray(index)) {
      const size = dict['/Size'] || 0;
      index = [0, size];
    }

    let pos = 0;
    for (let idx = 0; idx + 1 < index.length; idx += 2) {
      const firstObj = index[idx];
      const count    = index[idx + 1];
      if (typeof firstObj !== 'number' || typeof count !== 'number') continue;
      if (count < 0 || count > MAX_XREF_OBJECTS) continue;

      for (let e = 0; e < count; e++) {
        if (pos + entrySize > decoded.length) break;
        const objNum = firstObj + e;
        if (objNum < 0 || objNum >= MAX_XREF_OBJECTS) { pos += entrySize; continue; }

        const type   = _readField(decoded, pos, w1);
        const field2 = _readField(decoded, pos + w1, w2);
        const field3 = _readField(decoded, pos + w1 + w2, w3);
        pos += entrySize;

        // type 1 = uncompressed object at byte offset
        // type 2 = compressed object in object stream
        // type 0 = free object
        const entryType = w1 > 0 ? type : 1; // default type is 1
        if (entryType === 1) {
          if (!(objNum in this.xrefOffsets)) {
            this.xrefOffsets[objNum] = field2;
            this.xrefGens[objNum]    = field3;
          }
        } else if (entryType === 2) {
          // Object in object stream: field2=stream objNum, field3=index
          if (!(objNum in this.xrefOffsets)) {
            this.xrefOffsets[objNum] = { inObjStream: field2, index: field3 };
            this.xrefGens[objNum]    = 0;
          }
        }
      }
    }

    // Handle prev xref
    if (dict['/Prev'] !== undefined && typeof dict['/Prev'] === 'number') {
      const prev = dict['/Prev'];
      if (prev > 0 && prev < bytes.length) {
        await this.parseXref(prev);
      }
    }
  }

  // ── Object resolution ────────────────────────────────────────────────────────

  /**
   * Resolve an indirect object reference.
   * Returns the parsed value (not the raw object definition).
   * Uses a seen-set and depth limit for cycle detection.
   */
  async resolveObject(objNum, genNum, _seen, _depth) {
    if (_seen === undefined) _seen = new Set();
    if (_depth === undefined) _depth = 0;

    if (_depth > MAX_RESOLVE_DEPTH) throw new ParseError('Object resolution depth limit exceeded');
    const key = objNum + '/' + (genNum || 0);
    if (_seen.has(key)) throw new ParseError('Circular reference detected for object ' + objNum);
    _seen.add(key);

    const entry = this.xrefOffsets[objNum];
    if (entry === undefined) return null;

    // Compressed object in object stream
    if (typeof entry === 'object' && entry.inObjStream !== undefined) {
      return await this._resolveFromObjStream(entry.inObjStream, entry.index, _seen, _depth + 1);
    }

    if (typeof entry !== 'number' || entry < 0 || entry >= this.bytes.length) return null;

    const bytes = this.bytes;
    let i = skipWhitespace(bytes, entry);

    // Parse "N G obj"
    const r1 = readInt(bytes, i);
    if (!r1) return null;
    i = skipWhitespace(bytes, r1.nextOffset);
    const r2 = readInt(bytes, i);
    if (!r2) return null;
    i = skipWhitespace(bytes, r2.nextOffset);
    // expect 'obj'
    if (i + 3 > bytes.length ||
        bytes[i] !== 0x6f || bytes[i+1] !== 0x62 || bytes[i+2] !== 0x6a) {
      return null;
    }
    i += 3;
    i = skipWhitespace(bytes, i);

    // Parse the object value
    let result;
    try {
      result = parsePDFObject(bytes, i);
    } catch (e) {
      return null;
    }

    let value = result.value;

    // Handle stream
    if (result.isStream) {
      value = await this._buildStreamObject(value, result.streamOffset);
    }

    // Recursively resolve references in the value
    value = await this._resolveRefs(value, _seen, _depth + 1);

    return value;
  }

  async _buildStreamObject(dict, streamOffset) {
    // Return a lazy-decodable stream object
    let length = dict['/Length'];
    if (typeof length === 'object' && length && length.isRef) {
      try {
        length = await this.resolveObject(length.objNum, length.genNum);
      } catch (_) { length = null; }
    }
    if (typeof length !== 'number' || length < 0) length = 0;
    // Clamp to available bytes
    const end = Math.min(streamOffset + length, this.bytes.length);
    const rawBytes = this.bytes.slice(streamOffset, end);

    return {
      isStream: true,
      dict: dict,
      rawBytes: rawBytes,
      // Lazy decoder — call getBytes() to decompress
      getBytes: async () => {
        const filters = _normalizeFilters(dict['/Filter']);
        try {
          return await decodeStream(rawBytes, filters);
        } catch (e) {
          return rawBytes; // return raw on decode failure
        }
      }
    };
  }

  async _resolveFromObjStream(streamObjNum, objIndex, _seen, _depth) {
    if (_depth > MAX_RESOLVE_DEPTH) throw new ParseError('Object stream resolution depth limit');

    const streamObj = await this.resolveObject(streamObjNum, 0, new Set(_seen), _depth);
    if (!streamObj || !streamObj.isStream) return null;

    const streamBytes = await streamObj.getBytes();
    const n = streamObj.dict['/N'];
    const first = streamObj.dict['/First'];
    if (typeof n !== 'number' || typeof first !== 'number') return null;

    // Parse offset table at start of stream
    const offsets = [];
    let pos = 0;
    for (let k = 0; k < n && k < MAX_XREF_OBJECTS; k++) {
      pos = skipWhitespace(streamBytes, pos);
      const r1 = readInt(streamBytes, pos);
      if (!r1) break;
      const _objNum = r1.value;
      pos = skipWhitespace(streamBytes, r1.nextOffset);
      const r2 = readInt(streamBytes, pos);
      if (!r2) break;
      const localOffset = r2.value;
      pos = r2.nextOffset;
      offsets.push({ objNum: _objNum, offset: first + localOffset });
    }

    if (objIndex < 0 || objIndex >= offsets.length) return null;
    const { offset } = offsets[objIndex];
    if (offset < 0 || offset >= streamBytes.length) return null;

    try {
      const result = parsePDFObject(streamBytes, offset);
      return await this._resolveRefs(result.value, _seen, _depth + 1);
    } catch (_) {
      return null;
    }
  }

  /** Recursively replace { isRef } objects with resolved values. */
  async _resolveRefs(value, _seen, _depth) {
    if (_depth > MAX_RESOLVE_DEPTH) return value;
    if (value === null || value === undefined) return value;

    if (typeof value === 'object' && value.isRef) {
      try {
        return await this.resolveObject(value.objNum, value.genNum, new Set(_seen), _depth);
      } catch (_) {
        return null;
      }
    }

    if (Array.isArray(value)) {
      const result = [];
      for (let i = 0; i < value.length && i < MAX_XREF_OBJECTS; i++) {
        result.push(await this._resolveRefs(value[i], _seen, _depth + 1));
      }
      return result;
    }

    // Plain dict (not a stream)
    if (typeof value === 'object' && !value.isStream && !value.isRef) {
      // Don't resolve refs inside stream dicts (they'll be resolved on demand)
      const result = {};
      for (const key of Object.keys(value)) {
        result[key] = await this._resolveRefs(value[key], _seen, _depth + 1);
      }
      return result;
    }

    return value;
  }

  // ── Page tree ────────────────────────────────────────────────────────────────

  /**
   * Walk the Pages tree rooted at catalogObj.
   * Returns a flat array of page dicts, capped at MAX_PAGES.
   */
  async getPageTree(catalogObj) {
    const pagesRef = catalogObj['/Pages'];
    if (!pagesRef) throw new ParseError('Catalog missing /Pages');

    const pagesNode = (typeof pagesRef === 'object' && pagesRef.isRef)
      ? await this.resolveObject(pagesRef.objNum, pagesRef.genNum)
      : pagesRef;

    const pages = [];
    await this._walkPageTree(pagesNode, pages, new Set(), 0);
    return pages;
  }

  async _walkPageTree(node, pages, seen, depth) {
    if (!node || typeof node !== 'object') return;
    if (depth > 100) return; // prevent deep recursion on malformed trees
    if (pages.length >= MAX_PAGES) return;

    // Detect cycles using object identity
    const nodeId = node['/Type'] + '_' + Object.keys(node).join(',');
    if (seen.has(node)) return;
    seen.add(node);

    const nodeType = node['/Type'];

    if (nodeType === '/Pages') {
      const kids = node['/Kids'];
      if (!Array.isArray(kids)) return;
      for (let i = 0; i < kids.length && pages.length < MAX_PAGES; i++) {
        let kid = kids[i];
        if (typeof kid === 'object' && kid && kid.isRef) {
          try {
            kid = await this.resolveObject(kid.objNum, kid.genNum);
          } catch (_) { continue; }
        }
        await this._walkPageTree(kid, pages, seen, depth + 1);
      }
    } else if (nodeType === '/Page') {
      pages.push(node);
    } else {
      // Might be a page node without explicit /Type — check for /MediaBox
      if (node['/MediaBox'] || node['/Contents']) {
        pages.push(node);
      }
    }
  }

  // ── Trailer ──────────────────────────────────────────────────────────────────

  parseTrailer(offset) {
    const bytes = this.bytes;
    let i = skipWhitespace(bytes, offset);
    // Skip 'trailer' keyword if present
    if (i + 7 <= bytes.length &&
        bytes[i] === 0x74 && bytes[i+1] === 0x72 && bytes[i+2] === 0x61 &&
        bytes[i+3] === 0x69 && bytes[i+4] === 0x6c && bytes[i+5] === 0x65 && bytes[i+6] === 0x72) {
      i += 7;
      i = skipWhitespace(bytes, i);
    }
    const result = parseDictionary(bytes, i);
    return result.value;
  }

  // ── Internal: catalog-level security cleanup ──────────────────────────────

  async sanitizeCatalogActions(catalog) {
    // Remove potentially dangerous catalog entries
    delete catalog['/OpenAction'];
    delete catalog['/AA'];
    // Remove /JavaScript name tree
    const names = catalog['/Names'];
    if (names && typeof names === 'object') {
      delete names['/JavaScript'];
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Read a big-endian integer of `width` bytes from bytes at pos. */
function _readField(bytes, pos, width) {
  if (width === 0) return 0;
  let val = 0;
  for (let k = 0; k < width && pos + k < bytes.length; k++) {
    val = (val * 256 + bytes[pos + k]) >>> 0;
  }
  return val;
}

/** Normalize /Filter value to an array of filter name strings. */
function _normalizeFilters(filter) {
  if (!filter) return [];
  if (typeof filter === 'string') return [filter.startsWith('/') ? filter.slice(1) : filter];
  if (Array.isArray(filter)) {
    return filter.map(f => {
      if (typeof f === 'string') return f.startsWith('/') ? f.slice(1) : f;
      return '';
    }).filter(Boolean);
  }
  return [];
}

// ─── Exports ──────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PDFParser, ParseError, parsePDFObject, decodeStream, _normalizeFilters };
} else {
  window.PDFParser   = PDFParser;
  window.ParseError  = ParseError;
}
