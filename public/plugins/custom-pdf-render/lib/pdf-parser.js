/**
 * PDF Binary Parser
 *
 * Parses PDF binary format from an ArrayBuffer into a structured document.
 * Handles: header validation, cross-reference tables (traditional + stream),
 * trailer resolution, catalog/page tree traversal, indirect object resolution,
 * and stream decoding.
 *
 * Public interface:
 *   PDFDocument(arrayBuffer) - constructor
 *   PDFDocument.prototype.parse() - parse the PDF structure
 *   PDFDocument.prototype.getPageCount() - returns number of pages
 *   PDFDocument.prototype.getPage(n) - returns page dict with inherited resources
 *   PDFDocument.prototype.getObject(ref) - resolves an indirect reference
 *
 * Security: Uses ResourceTracker for limits. Never evals PDF content.
 */

'use strict';

// ============================================================================
// PDF Error
// ============================================================================

function PDFParseError(message) {
  this.name = 'PDFParseError';
  this.message = message;
}
PDFParseError.prototype = Object.create(Error.prototype);
PDFParseError.prototype.constructor = PDFParseError;

// ============================================================================
// Character classification helpers
// ============================================================================

function isWhitespace(ch) {
  return ch === 0x00 || ch === 0x09 || ch === 0x0A || ch === 0x0C || ch === 0x0D || ch === 0x20;
}

function isDelimiter(ch) {
  return ch === 0x28 || ch === 0x29 || // ( )
         ch === 0x3C || ch === 0x3E || // < >
         ch === 0x5B || ch === 0x5D || // [ ]
         ch === 0x7B || ch === 0x7D || // { }
         ch === 0x2F ||               // /
         ch === 0x25;                 // %
}

function isDigit(ch) {
  return ch >= 0x30 && ch <= 0x39;
}

function isEOL(ch) {
  return ch === 0x0A || ch === 0x0D;
}

// ============================================================================
// PDF Tokenizer
// ============================================================================

/**
 * Low-level tokenizer that reads from a Uint8Array.
 */
function PDFTokenizer(data) {
  this.data = data;
  this.pos = 0;
  this.length = data.length;
}

PDFTokenizer.prototype.atEnd = function() {
  return this.pos >= this.length;
};

PDFTokenizer.prototype.peekByte = function() {
  if (this.pos >= this.length) return -1;
  return this.data[this.pos];
};

PDFTokenizer.prototype.readByte = function() {
  if (this.pos >= this.length) return -1;
  return this.data[this.pos++];
};

PDFTokenizer.prototype.skipWhitespace = function() {
  while (this.pos < this.length) {
    var ch = this.data[this.pos];
    if (isWhitespace(ch)) {
      this.pos++;
    } else if (ch === 0x25) { // '%' - comment
      this.skipComment();
    } else {
      break;
    }
  }
};

PDFTokenizer.prototype.skipComment = function() {
  // Skip until EOL
  while (this.pos < this.length) {
    var ch = this.data[this.pos++];
    if (ch === 0x0A || ch === 0x0D) break;
  }
};

/**
 * Read a keyword or number token.
 */
PDFTokenizer.prototype.readToken = function() {
  this.skipWhitespace();
  if (this.pos >= this.length) return null;

  var ch = this.data[this.pos];

  // Name
  if (ch === 0x2F) { // '/'
    return this.readName();
  }

  // Literal string
  if (ch === 0x28) { // '('
    return this.readLiteralString();
  }

  // Hex string or dictionary
  if (ch === 0x3C) { // '<'
    if (this.pos + 1 < this.length && this.data[this.pos + 1] === 0x3C) {
      return this.readDictStart();
    }
    return this.readHexString();
  }

  // Dictionary end
  if (ch === 0x3E) { // '>'
    if (this.pos + 1 < this.length && this.data[this.pos + 1] === 0x3E) {
      this.pos += 2;
      return { type: 'dictEnd' };
    }
    this.pos++;
    return { type: 'unknown', value: '>' };
  }

  // Array start
  if (ch === 0x5B) { // '['
    this.pos++;
    return { type: 'arrayStart' };
  }

  // Array end
  if (ch === 0x5D) { // ']'
    this.pos++;
    return { type: 'arrayEnd' };
  }

  // Number or keyword
  if (isDigit(ch) || ch === 0x2B || ch === 0x2D || ch === 0x2E) { // +, -, .
    return this.readNumber();
  }

  // Keyword (true, false, null, obj, endobj, stream, endstream, xref, trailer, startxref, R, etc.)
  return this.readKeyword();
};

/**
 * Read a PDF name object (e.g., /Type, /Pages).
 */
PDFTokenizer.prototype.readName = function() {
  this.pos++; // skip '/'
  var start = this.pos;
  while (this.pos < this.length) {
    var ch = this.data[this.pos];
    if (isWhitespace(ch) || isDelimiter(ch)) break;
    this.pos++;
  }

  var nameBytes = this.data.subarray(start, this.pos);
  var name = '';

  for (var i = 0; i < nameBytes.length; i++) {
    if (nameBytes[i] === 0x23 && i + 2 < nameBytes.length) { // '#' hex escape
      var hex = String.fromCharCode(nameBytes[i + 1]) + String.fromCharCode(nameBytes[i + 2]);
      var code = parseInt(hex, 16);
      if (!isNaN(code)) {
        name += String.fromCharCode(code);
        i += 2;
        continue;
      }
    }
    name += String.fromCharCode(nameBytes[i]);
  }

  return { type: 'name', value: name };
};

/**
 * Read a literal string (parenthesized).
 */
PDFTokenizer.prototype.readLiteralString = function() {
  this.pos++; // skip '('
  var result = [];
  var depth = 1;

  while (this.pos < this.length && depth > 0) {
    var ch = this.data[this.pos++];

    if (ch === 0x5C) { // backslash escape
      if (this.pos >= this.length) break;
      var next = this.data[this.pos++];
      switch (next) {
        case 0x6E: result.push(0x0A); break; // \n
        case 0x72: result.push(0x0D); break; // \r
        case 0x74: result.push(0x09); break; // \t
        case 0x62: result.push(0x08); break; // \b
        case 0x66: result.push(0x0C); break; // \f
        case 0x28: result.push(0x28); break; // \(
        case 0x29: result.push(0x29); break; // \)
        case 0x5C: result.push(0x5C); break; // \\
        case 0x0D: // \<CR> or \<CR><LF> - line continuation
          if (this.pos < this.length && this.data[this.pos] === 0x0A) {
            this.pos++;
          }
          break;
        case 0x0A: // \<LF> - line continuation
          break;
        default:
          // Octal escape
          if (next >= 0x30 && next <= 0x37) {
            var octal = next - 0x30;
            if (this.pos < this.length && this.data[this.pos] >= 0x30 && this.data[this.pos] <= 0x37) {
              octal = octal * 8 + (this.data[this.pos++] - 0x30);
              if (this.pos < this.length && this.data[this.pos] >= 0x30 && this.data[this.pos] <= 0x37) {
                octal = octal * 8 + (this.data[this.pos++] - 0x30);
              }
            }
            result.push(octal & 0xFF);
          } else {
            result.push(next);
          }
          break;
      }
    } else if (ch === 0x28) { // '('
      depth++;
      result.push(ch);
    } else if (ch === 0x29) { // ')'
      depth--;
      if (depth > 0) {
        result.push(ch);
      }
    } else {
      result.push(ch);
    }
  }

  return { type: 'string', value: new Uint8Array(result) };
};

/**
 * Read a hex string.
 */
PDFTokenizer.prototype.readHexString = function() {
  this.pos++; // skip '<'
  var hexChars = [];

  while (this.pos < this.length) {
    var ch = this.data[this.pos];
    if (ch === 0x3E) { // '>'
      this.pos++;
      break;
    }
    if (!isWhitespace(ch)) {
      hexChars.push(ch);
    }
    this.pos++;
  }

  // Convert hex pairs to bytes
  var result = [];
  for (var i = 0; i < hexChars.length; i += 2) {
    var hi = hexCharToNibble(hexChars[i]);
    var lo = (i + 1 < hexChars.length) ? hexCharToNibble(hexChars[i + 1]) : 0;
    result.push((hi << 4) | lo);
  }

  return { type: 'string', value: new Uint8Array(result) };
};

function hexCharToNibble(ch) {
  if (ch >= 0x30 && ch <= 0x39) return ch - 0x30;
  if (ch >= 0x41 && ch <= 0x46) return ch - 0x41 + 10;
  if (ch >= 0x61 && ch <= 0x66) return ch - 0x61 + 10;
  return 0;
}

/**
 * Read dictionary start marker '<<'.
 */
PDFTokenizer.prototype.readDictStart = function() {
  this.pos += 2;
  return { type: 'dictStart' };
};

/**
 * Read a number (integer or real).
 */
PDFTokenizer.prototype.readNumber = function() {
  var start = this.pos;
  var hasDecimal = false;

  if (this.data[this.pos] === 0x2B || this.data[this.pos] === 0x2D) {
    this.pos++; // sign
  }

  while (this.pos < this.length) {
    var ch = this.data[this.pos];
    if (isDigit(ch)) {
      this.pos++;
    } else if (ch === 0x2E && !hasDecimal) { // '.'
      hasDecimal = true;
      this.pos++;
    } else {
      break;
    }
  }

  var str = '';
  for (var i = start; i < this.pos; i++) {
    str += String.fromCharCode(this.data[i]);
  }

  var num = hasDecimal ? parseFloat(str) : parseInt(str, 10);
  if (!isFinite(num)) {
    return { type: 'number', value: 0 };
  }
  return { type: 'number', value: num };
};

/**
 * Read a keyword token.
 */
PDFTokenizer.prototype.readKeyword = function() {
  var start = this.pos;
  while (this.pos < this.length) {
    var ch = this.data[this.pos];
    if (isWhitespace(ch) || isDelimiter(ch)) break;
    this.pos++;
  }

  var keyword = '';
  for (var i = start; i < this.pos; i++) {
    keyword += String.fromCharCode(this.data[i]);
  }

  if (keyword === 'true') return { type: 'boolean', value: true };
  if (keyword === 'false') return { type: 'boolean', value: false };
  if (keyword === 'null') return { type: 'null', value: null };
  if (keyword === 'R') return { type: 'R' };

  return { type: 'keyword', value: keyword };
};

/**
 * Read a substring at current position for searching.
 */
PDFTokenizer.prototype.peekString = function(len) {
  var end = Math.min(this.pos + len, this.length);
  var s = '';
  for (var i = this.pos; i < end; i++) {
    s += String.fromCharCode(this.data[i]);
  }
  return s;
};

/**
 * Match a string at the current position.
 */
PDFTokenizer.prototype.matchString = function(str) {
  if (this.pos + str.length > this.length) return false;
  for (var i = 0; i < str.length; i++) {
    if (this.data[this.pos + i] !== str.charCodeAt(i)) return false;
  }
  return true;
};

// ============================================================================
// High-level parser (reads PDF objects from tokenizer)
// ============================================================================

/**
 * Parse a PDF object (value) at the current tokenizer position.
 * Returns the parsed value: number, string (Uint8Array), name (string),
 * array, dictionary (plain object), boolean, null, or a reference { objNum, genNum }.
 */
function parseValue(tokenizer, tracker, depth) {
  depth = depth || 0;
  if (tracker) {
    if (depth > (tracker.limits || {}).MAX_NESTING_DEPTH || depth > 100) {
      throw new PDFParseError('Object nesting depth exceeded');
    }
    tracker.checkTimeout();
  }

  var token = tokenizer.readToken();
  if (!token) return null;

  switch (token.type) {
    case 'number':
      // Could be an indirect reference: N M R
      // Peek ahead for gen number and 'R'
      var savedPos = tokenizer.pos;
      tokenizer.skipWhitespace();
      var nextStart = tokenizer.pos;

      if (nextStart < tokenizer.length && (isDigit(tokenizer.data[nextStart]) || tokenizer.data[nextStart] === 0x2B || tokenizer.data[nextStart] === 0x2D)) {
        var token2 = tokenizer.readToken();
        if (token2 && token2.type === 'number') {
          tokenizer.skipWhitespace();
          var token3Pos = tokenizer.pos;
          if (token3Pos < tokenizer.length) {
            // Check for 'R'
            var rCheck = tokenizer.peekString(1);
            if (rCheck === 'R') {
              // Check the next character after 'R' is whitespace/delimiter/end
              if (token3Pos + 1 >= tokenizer.length ||
                  isWhitespace(tokenizer.data[token3Pos + 1]) ||
                  isDelimiter(tokenizer.data[token3Pos + 1])) {
                tokenizer.pos = token3Pos + 1;
                return { objNum: Math.floor(token.value), genNum: Math.floor(token2.value), isRef: true };
              }
            }
            // Check for 'obj'
            if (tokenizer.matchString('obj')) {
              var afterObj = token3Pos + 3;
              if (afterObj >= tokenizer.length ||
                  isWhitespace(tokenizer.data[afterObj]) ||
                  isDelimiter(tokenizer.data[afterObj])) {
                // This is an object definition marker, restore position
                // The caller should handle 'obj' at a higher level
                tokenizer.pos = savedPos;
                return token.value;
              }
            }
          }
        }
        // Not a reference, restore position
        tokenizer.pos = savedPos;
      } else {
        tokenizer.pos = savedPos;
      }
      return token.value;

    case 'string':
      return token.value; // Uint8Array

    case 'name':
      return token.value; // string without leading '/'

    case 'boolean':
      return token.value;

    case 'null':
      return null;

    case 'arrayStart':
      return parseArray(tokenizer, tracker, depth + 1);

    case 'dictStart':
      return parseDictionary(tokenizer, tracker, depth + 1);

    case 'keyword':
      // Return keywords as-is (for 'stream', 'endobj', etc.)
      return token.value;

    default:
      return token.value !== undefined ? token.value : null;
  }
}

/**
 * Parse a PDF array.
 */
function parseArray(tokenizer, tracker, depth) {
  var arr = [];
  var maxLen = (tracker && tracker.limits) ? tracker.limits.MAX_ARRAY_LENGTH : 65536;

  while (!tokenizer.atEnd()) {
    tokenizer.skipWhitespace();
    if (tokenizer.pos >= tokenizer.length) break;

    // Check for ']'
    if (tokenizer.data[tokenizer.pos] === 0x5D) {
      tokenizer.pos++;
      break;
    }

    var val = parseValue(tokenizer, tracker, depth);
    arr.push(val);

    if (arr.length > maxLen) {
      throw new PDFParseError('Array length exceeds limit (' + maxLen + ')');
    }
  }

  return arr;
}

/**
 * Parse a PDF dictionary.
 */
function parseDictionary(tokenizer, tracker, depth) {
  var dict = {};
  var maxEntries = (tracker && tracker.limits) ? tracker.limits.MAX_DICT_ENTRIES : 4096;
  var count = 0;

  while (!tokenizer.atEnd()) {
    tokenizer.skipWhitespace();
    if (tokenizer.pos >= tokenizer.length) break;

    // Check for '>>'
    if (tokenizer.data[tokenizer.pos] === 0x3E) {
      if (tokenizer.pos + 1 < tokenizer.length && tokenizer.data[tokenizer.pos + 1] === 0x3E) {
        tokenizer.pos += 2;
        break;
      }
    }

    // Read key (must be a name)
    var keyToken = tokenizer.readToken();
    if (!keyToken) break;

    if (keyToken.type === 'dictEnd') break;

    if (keyToken.type !== 'name') {
      // Unexpected token - try to recover
      continue;
    }

    var key = keyToken.value;

    // Read value
    var val = parseValue(tokenizer, tracker, depth);
    dict[key] = val;

    count++;
    if (count > maxEntries) {
      throw new PDFParseError('Dictionary entry count exceeds limit (' + maxEntries + ')');
    }
  }

  return dict;
}

// ============================================================================
// PDF Document
// ============================================================================

/**
 * Represents a parsed PDF document.
 *
 * @param {ArrayBuffer} arrayBuffer - Raw PDF bytes
 */
function PDFDocument(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) && !(arrayBuffer instanceof Uint8Array)) {
    throw new PDFParseError('Expected ArrayBuffer or Uint8Array');
  }
  this.data = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  this.xrefEntries = {}; // obj num -> { offset, gen, free }
  this.trailer = null;
  this.catalog = null;
  this.pagesRoot = null;
  this.pages = []; // Flattened page list
  this.version = '';
  this.tracker = null;
  this._objectCache = {};
  this._streamDecoders = null; // Set externally or use global
}

/**
 * Parse the PDF document structure.
 * Must be called before any getPage/getObject calls.
 */
PDFDocument.prototype.parse = function() {
  // Get stream decoders
  if (typeof module !== 'undefined' && module.exports) {
    this._streamDecoders = require('./pdf-stream.js');
    var security = require('./pdf-security.js');
    this.tracker = new security.ResourceTracker();
  } else if (typeof window !== 'undefined') {
    this._streamDecoders = window.PDFStreamDecoders;
    this.tracker = new window.PDFSecurity.ResourceTracker();
  }

  if (!this._streamDecoders) {
    throw new PDFParseError('Stream decoders not available');
  }

  // Step 1: Validate header
  this._parseHeader();

  // Step 2: Find startxref
  var startxref = this._findStartXRef();

  // Step 3: Parse xref table(s)
  this._parseXRef(startxref);

  // Step 4: Resolve catalog
  this._resolveCatalog();

  // Step 5: Parse page tree
  this._parsePageTree();

  return this;
};

// ============================================================================
// Header Parsing
// ============================================================================

PDFDocument.prototype._parseHeader = function() {
  // PDF spec allows up to 1024 bytes of leading whitespace before %PDF-
  var searchLimit = Math.min(1024, this.data.length);
  var found = false;

  for (var i = 0; i < searchLimit; i++) {
    if (this.data[i] === 0x25 && // %
        i + 4 < this.data.length &&
        this.data[i + 1] === 0x50 && // P
        this.data[i + 2] === 0x44 && // D
        this.data[i + 3] === 0x46 && // F
        this.data[i + 4] === 0x2D) { // -
      // Read version
      var verStart = i + 5;
      var verEnd = verStart;
      while (verEnd < this.data.length && !isEOL(this.data[verEnd])) {
        verEnd++;
      }
      var version = '';
      for (var j = verStart; j < verEnd; j++) {
        version += String.fromCharCode(this.data[j]);
      }
      this.version = version.trim();
      found = true;
      break;
    }
  }

  if (!found) {
    throw new PDFParseError('Invalid PDF: missing %PDF- header');
  }
};

// ============================================================================
// Find startxref
// ============================================================================

PDFDocument.prototype._findStartXRef = function() {
  // Search backwards from end of file for 'startxref'
  var searchStart = Math.max(0, this.data.length - 1024);
  var pos = -1;

  // Build the string to search for
  var needle = 'startxref';

  for (var i = this.data.length - needle.length; i >= searchStart; i--) {
    var match = true;
    for (var j = 0; j < needle.length; j++) {
      if (this.data[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) {
      pos = i;
      break;
    }
  }

  if (pos < 0) {
    throw new PDFParseError('Cannot find startxref marker');
  }

  // Read the offset number after 'startxref'
  var tokenizer = new PDFTokenizer(this.data);
  tokenizer.pos = pos + needle.length;
  tokenizer.skipWhitespace();

  var numStr = '';
  while (tokenizer.pos < tokenizer.length && isDigit(tokenizer.data[tokenizer.pos])) {
    numStr += String.fromCharCode(tokenizer.data[tokenizer.pos++]);
  }

  var offset = parseInt(numStr, 10);
  if (!isFinite(offset) || offset < 0) {
    throw new PDFParseError('Invalid startxref offset: ' + numStr);
  }

  return offset;
};

// ============================================================================
// Cross-Reference Table Parsing
// ============================================================================

PDFDocument.prototype._parseXRef = function(offset) {
  this._parseXRefAt(offset, 0);
};

/**
 * Parse xref at the given offset. Handles both traditional xref tables
 * and xref streams. Follows /Prev links for incremental updates.
 *
 * @param {number} offset - Byte offset of xref
 * @param {number} depth - Recursion depth (for /Prev chains)
 */
PDFDocument.prototype._parseXRefAt = function(offset, depth) {
  if (depth > 20) {
    throw new PDFParseError('Too many xref /Prev links (possible cycle)');
  }

  if (offset >= this.data.length) {
    throw new PDFParseError('Xref offset beyond file size: ' + offset);
  }

  this.tracker.checkTimeout();

  // Check if this is a traditional xref table or an xref stream
  var tokenizer = new PDFTokenizer(this.data);
  tokenizer.pos = offset;
  tokenizer.skipWhitespace();

  var probe = tokenizer.peekString(4);

  if (probe.substring(0, 4) === 'xref') {
    // Traditional xref table
    this._parseTraditionalXRef(tokenizer, depth);
  } else {
    // Might be an xref stream (starts with object number)
    this._parseXRefStream(offset, depth);
  }
};

/**
 * Parse a traditional xref table.
 */
PDFDocument.prototype._parseTraditionalXRef = function(tokenizer, depth) {
  // Skip 'xref' keyword
  tokenizer.pos += 4;
  tokenizer.skipWhitespace();

  // Read subsection entries
  while (!tokenizer.atEnd()) {
    tokenizer.skipWhitespace();

    // Check if we've hit 'trailer'
    if (tokenizer.matchString('trailer')) {
      break;
    }

    // Read subsection header: startObjNum count
    var startObj = '';
    while (tokenizer.pos < tokenizer.length && isDigit(tokenizer.data[tokenizer.pos])) {
      startObj += String.fromCharCode(tokenizer.data[tokenizer.pos++]);
    }
    tokenizer.skipWhitespace();

    var count = '';
    while (tokenizer.pos < tokenizer.length && isDigit(tokenizer.data[tokenizer.pos])) {
      count += String.fromCharCode(tokenizer.data[tokenizer.pos++]);
    }

    var startNum = parseInt(startObj, 10);
    var objCount = parseInt(count, 10);

    if (!isFinite(startNum) || !isFinite(objCount)) {
      throw new PDFParseError('Invalid xref subsection header');
    }

    if (objCount > this.tracker.limits.MAX_OBJECT_COUNT) {
      throw new PDFParseError('Xref object count exceeds limit');
    }

    // Read entries
    for (var i = 0; i < objCount; i++) {
      tokenizer.skipWhitespace();

      // Each entry is exactly "oooooooooo ggggg n|f" (20 bytes)
      var entryOffset = '';
      for (var oi = 0; oi < 10; oi++) {
        if (tokenizer.pos < tokenizer.length) {
          entryOffset += String.fromCharCode(tokenizer.data[tokenizer.pos++]);
        }
      }
      tokenizer.pos++; // skip space

      var entryGen = '';
      for (var gi = 0; gi < 5; gi++) {
        if (tokenizer.pos < tokenizer.length) {
          entryGen += String.fromCharCode(tokenizer.data[tokenizer.pos++]);
        }
      }
      tokenizer.pos++; // skip space

      var entryType = -1;
      if (tokenizer.pos < tokenizer.length) {
        entryType = tokenizer.data[tokenizer.pos++];
      }

      // Skip EOL (could be CR, LF, or CRLF) - skip up to 2 EOL chars
      if (tokenizer.pos < tokenizer.length && isEOL(tokenizer.data[tokenizer.pos])) {
        if (tokenizer.data[tokenizer.pos] === 0x0D && tokenizer.pos + 1 < tokenizer.length && tokenizer.data[tokenizer.pos + 1] === 0x0A) {
          tokenizer.pos += 2;
        } else {
          tokenizer.pos++;
        }
      } else if (tokenizer.pos < tokenizer.length && isWhitespace(tokenizer.data[tokenizer.pos])) {
        tokenizer.pos++; // Some PDFs use space instead of EOL
      }

      var objNum = startNum + i;
      var off = parseInt(entryOffset.trim(), 10);
      var gen = parseInt(entryGen.trim(), 10);
      var isFree = (entryType === 0x66); // 'f'

      // Only store if not already present (later xref sections have priority for incremental updates,
      // and we process from newest to oldest)
      if (!(objNum in this.xrefEntries)) {
        this.xrefEntries[objNum] = {
          offset: off,
          gen: gen,
          free: isFree,
          inStream: false
        };
      }
    }
  }

  // Parse trailer
  tokenizer.skipWhitespace();
  if (tokenizer.matchString('trailer')) {
    tokenizer.pos += 7;
    tokenizer.skipWhitespace();

    var trailer = parseValue(tokenizer, this.tracker, 0);
    if (trailer && typeof trailer === 'object' && !Array.isArray(trailer)) {
      // First trailer found is the primary one (most recent)
      if (!this.trailer) {
        this.trailer = trailer;
      }

      // Follow /Prev link
      if (trailer.Prev !== undefined && trailer.Prev !== null) {
        var prevOffset = typeof trailer.Prev === 'number' ? trailer.Prev : parseInt(trailer.Prev, 10);
        if (isFinite(prevOffset) && prevOffset >= 0) {
          this._parseXRefAt(prevOffset, depth + 1);
        }
      }
    }
  }
};

/**
 * Parse an xref stream (PDF 1.5+).
 */
PDFDocument.prototype._parseXRefStream = function(offset, depth) {
  // Read the object definition at this offset
  var tokenizer = new PDFTokenizer(this.data);
  tokenizer.pos = offset;
  tokenizer.skipWhitespace();

  // Read: objNum genNum obj
  var objNum = parseValue(tokenizer, this.tracker, 0);
  var genNum = parseValue(tokenizer, this.tracker, 0);
  tokenizer.skipWhitespace();

  // Expect 'obj'
  if (!tokenizer.matchString('obj')) {
    throw new PDFParseError('Expected obj keyword at xref stream offset ' + offset);
  }
  tokenizer.pos += 3;
  tokenizer.skipWhitespace();

  // Parse the stream dictionary
  var dict = parseValue(tokenizer, this.tracker, 0);
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
    throw new PDFParseError('Invalid xref stream dictionary');
  }

  // Verify it's an XRef type
  if (dict.Type !== 'XRef') {
    throw new PDFParseError('Expected /Type /XRef in xref stream, got: ' + dict.Type);
  }

  // Use this dict as trailer if we don't have one yet
  if (!this.trailer) {
    this.trailer = dict;
  }

  // Read the stream data
  tokenizer.skipWhitespace();
  if (!tokenizer.matchString('stream')) {
    throw new PDFParseError('Expected stream keyword in xref stream');
  }
  tokenizer.pos += 6;
  // Skip EOL after 'stream'
  if (tokenizer.pos < tokenizer.length && tokenizer.data[tokenizer.pos] === 0x0D) {
    tokenizer.pos++;
  }
  if (tokenizer.pos < tokenizer.length && tokenizer.data[tokenizer.pos] === 0x0A) {
    tokenizer.pos++;
  }

  var streamLength = dict.Length;
  if (typeof streamLength === 'object' && streamLength && streamLength.isRef) {
    // Length is an indirect reference - resolve it
    // For xref streams at parse time, we may not have the xref table yet,
    // so we need to find 'endstream' manually
    streamLength = this._findEndStream(tokenizer.pos);
  }

  if (typeof streamLength !== 'number' || streamLength < 0) {
    streamLength = this._findEndStream(tokenizer.pos);
  }

  var streamData = this.data.subarray(tokenizer.pos, tokenizer.pos + streamLength);

  // Decode the stream
  var filter = dict.Filter;
  var decodeParms = dict.DecodeParms || null;
  var decoded;

  try {
    decoded = this._streamDecoders.decodeStream(streamData, filter, decodeParms);
  } catch (e) {
    throw new PDFParseError('Failed to decode xref stream: ' + e.message);
  }

  this.tracker.trackDecompression(decoded.length);

  // Parse W array (field widths)
  var w = dict.W;
  if (!Array.isArray(w) || w.length < 3) {
    throw new PDFParseError('Invalid /W array in xref stream');
  }

  var w0 = w[0], w1 = w[1], w2 = w[2];
  var entrySize = w0 + w1 + w2;

  if (entrySize === 0) {
    throw new PDFParseError('Xref stream entry size is zero');
  }

  // Parse Index array (subsection ranges)
  var index = dict.Index;
  if (!index) {
    // Default: single subsection starting at 0
    var size = dict.Size || 0;
    index = [0, size];
  }

  // Process entries
  var dataPos = 0;
  for (var si = 0; si < index.length; si += 2) {
    var firstObj = index[si];
    var entryCount = index[si + 1];

    for (var ei = 0; ei < entryCount; ei++) {
      if (dataPos + entrySize > decoded.length) break;

      // Read fields
      var field0 = readXRefField(decoded, dataPos, w0);
      var field1 = readXRefField(decoded, dataPos + w0, w1);
      var field2 = readXRefField(decoded, dataPos + w0 + w1, w2);
      dataPos += entrySize;

      var currentObjNum = firstObj + ei;

      // Default type is 1 if w0 is 0
      var type = (w0 === 0) ? 1 : field0;

      if (!(currentObjNum in this.xrefEntries)) {
        if (type === 0) {
          // Free object
          this.xrefEntries[currentObjNum] = {
            offset: 0,
            gen: field2,
            free: true,
            inStream: false
          };
        } else if (type === 1) {
          // Uncompressed object
          this.xrefEntries[currentObjNum] = {
            offset: field1,
            gen: field2,
            free: false,
            inStream: false
          };
        } else if (type === 2) {
          // Compressed in object stream
          this.xrefEntries[currentObjNum] = {
            streamObjNum: field1,
            indexInStream: field2,
            gen: 0,
            free: false,
            inStream: true
          };
        }
      }
    }
  }

  // Follow /Prev
  if (dict.Prev !== undefined && dict.Prev !== null) {
    var prevOffset = typeof dict.Prev === 'number' ? dict.Prev : parseInt(dict.Prev, 10);
    if (isFinite(prevOffset) && prevOffset >= 0) {
      this._parseXRefAt(prevOffset, depth + 1);
    }
  }
};

/**
 * Read a multi-byte big-endian integer field from xref stream data.
 */
function readXRefField(data, offset, width) {
  if (width === 0) return 0;
  var val = 0;
  for (var i = 0; i < width; i++) {
    val = (val << 8) | (offset + i < data.length ? data[offset + i] : 0);
  }
  return val;
}

/**
 * Find the length of stream data by searching for 'endstream'.
 */
PDFDocument.prototype._findEndStream = function(startPos) {
  var needle = 'endstream';
  for (var i = startPos; i < this.data.length - needle.length + 1; i++) {
    var match = true;
    for (var j = 0; j < needle.length; j++) {
      if (this.data[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) {
      // endstream found - calculate length
      var len = i - startPos;
      // Strip trailing whitespace
      while (len > 0 && isWhitespace(this.data[startPos + len - 1])) {
        len--;
      }
      return len;
    }
  }
  throw new PDFParseError('Cannot find endstream marker');
};

// ============================================================================
// Object Resolution
// ============================================================================

/**
 * Resolve an indirect reference to its value.
 *
 * @param {object|*} ref - Either a reference { objNum, genNum, isRef } or a direct value
 * @returns {*} The resolved value
 */
PDFDocument.prototype.resolveRef = function(ref) {
  if (!ref || typeof ref !== 'object' || !ref.isRef) {
    return ref; // Direct value
  }
  return this.getObject(ref.objNum, ref.genNum);
};

/**
 * Get a parsed object by its object number.
 *
 * @param {number} objNum - Object number
 * @param {number} [genNum] - Generation number (default 0)
 * @returns {*} The parsed object value
 */
PDFDocument.prototype.getObject = function(objNum, genNum) {
  genNum = genNum || 0;
  var cacheKey = objNum + '_' + genNum;

  // Check cache
  if (cacheKey in this._objectCache) {
    return this._objectCache[cacheKey];
  }

  // Cycle detection
  if (!this.tracker.beginResolve(cacheKey)) {
    // Circular reference detected
    return null;
  }

  this.tracker.pushDepth();
  this.tracker.trackObject();

  try {
    var entry = this.xrefEntries[objNum];
    if (!entry || entry.free) {
      this._objectCache[cacheKey] = null;
      return null;
    }

    var result;

    if (entry.inStream) {
      // Object is in an object stream
      result = this._getObjectFromStream(entry.streamObjNum, entry.indexInStream);
    } else {
      // Object is at a byte offset
      result = this._parseObjectAt(entry.offset);
    }

    this._objectCache[cacheKey] = result;
    return result;
  } finally {
    this.tracker.popDepth();
    this.tracker.endResolve(cacheKey);
  }
};

/**
 * Parse an object definition at a byte offset.
 */
PDFDocument.prototype._parseObjectAt = function(offset) {
  if (offset >= this.data.length) {
    return null;
  }

  var tokenizer = new PDFTokenizer(this.data);
  tokenizer.pos = offset;
  tokenizer.skipWhitespace();

  // Read: objNum genNum obj
  // Skip objNum
  while (tokenizer.pos < tokenizer.length && !isWhitespace(tokenizer.data[tokenizer.pos])) {
    tokenizer.pos++;
  }
  tokenizer.skipWhitespace();
  // Skip genNum
  while (tokenizer.pos < tokenizer.length && !isWhitespace(tokenizer.data[tokenizer.pos])) {
    tokenizer.pos++;
  }
  tokenizer.skipWhitespace();

  // Skip 'obj'
  if (tokenizer.matchString('obj')) {
    tokenizer.pos += 3;
  }
  tokenizer.skipWhitespace();

  // Parse the object value
  var value = parseValue(tokenizer, this.tracker, 0);

  // Check if this is a stream object
  tokenizer.skipWhitespace();
  if (tokenizer.matchString('stream')) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // This is a stream dictionary - attach stream data
      tokenizer.pos += 6; // skip 'stream'
      // Skip EOL (CR, LF, or CRLF)
      if (tokenizer.pos < tokenizer.length && tokenizer.data[tokenizer.pos] === 0x0D) {
        tokenizer.pos++;
      }
      if (tokenizer.pos < tokenizer.length && tokenizer.data[tokenizer.pos] === 0x0A) {
        tokenizer.pos++;
      }

      var streamLength = value.Length;
      if (typeof streamLength === 'object' && streamLength && streamLength.isRef) {
        // Resolve the length reference
        streamLength = this.resolveRef(streamLength);
      }

      if (typeof streamLength === 'number' && streamLength >= 0) {
        value._streamData = this.data.subarray(tokenizer.pos, tokenizer.pos + streamLength);
      } else {
        // Find endstream
        var foundLen = this._findEndStream(tokenizer.pos);
        value._streamData = this.data.subarray(tokenizer.pos, tokenizer.pos + foundLen);
      }
      value._isStream = true;
    }
  }

  return value;
};

/**
 * Get an object from an object stream.
 */
PDFDocument.prototype._getObjectFromStream = function(streamObjNum, index) {
  var streamObj = this.getObject(streamObjNum);
  if (!streamObj || !streamObj._isStream) {
    return null;
  }

  // Decode the object stream
  var cacheKey = 'objstream_' + streamObjNum;
  var objects;

  if (cacheKey in this._objectCache) {
    objects = this._objectCache[cacheKey];
  } else {
    objects = this._decodeObjectStream(streamObj);
    this._objectCache[cacheKey] = objects;
  }

  if (index >= 0 && index < objects.length) {
    return objects[index];
  }
  return null;
};

/**
 * Decode an object stream and return an array of objects.
 */
PDFDocument.prototype._decodeObjectStream = function(streamObj) {
  var n = streamObj.N; // number of objects
  var first = streamObj.First; // byte offset of first object in decoded data

  if (typeof n !== 'number' || typeof first !== 'number') {
    throw new PDFParseError('Invalid object stream: missing N or First');
  }

  // Decode stream data
  var decoded = this._decodeStreamData(streamObj);
  this.tracker.trackDecompression(decoded.length);

  // Parse the offset table (N pairs of objNum + offset)
  var tokenizer = new PDFTokenizer(decoded);
  var offsets = [];

  for (var i = 0; i < n; i++) {
    tokenizer.skipWhitespace();
    var objNumToken = tokenizer.readToken();
    tokenizer.skipWhitespace();
    var offsetToken = tokenizer.readToken();

    if (objNumToken && offsetToken) {
      offsets.push({
        objNum: objNumToken.value,
        offset: offsetToken.value
      });
    }
  }

  // Parse each object
  var objects = [];
  for (var j = 0; j < offsets.length; j++) {
    var objOffset = first + offsets[j].offset;
    tokenizer.pos = objOffset;
    var val = parseValue(tokenizer, this.tracker, 0);
    objects.push(val);
  }

  return objects;
};

/**
 * Decode stream data using the stream's filter(s).
 */
PDFDocument.prototype._decodeStreamData = function(streamObj) {
  if (!streamObj._streamData) {
    return new Uint8Array(0);
  }

  var filter = streamObj.Filter;
  var decodeParms = streamObj.DecodeParms || null;

  // Resolve filter if it's a reference
  if (filter && typeof filter === 'object' && filter.isRef) {
    filter = this.resolveRef(filter);
  }

  // Resolve decodeParms if it's a reference
  if (decodeParms && typeof decodeParms === 'object' && decodeParms.isRef) {
    decodeParms = this.resolveRef(decodeParms);
  }

  // Resolve decodeParms array entries
  if (Array.isArray(decodeParms)) {
    decodeParms = decodeParms.map(function(p) {
      if (p && typeof p === 'object' && p.isRef) {
        return this.resolveRef(p);
      }
      return p;
    }.bind(this));
  }

  if (!filter) {
    return streamObj._streamData;
  }

  return this._streamDecoders.decodeStream(streamObj._streamData, filter, decodeParms);
};

/**
 * Get decoded stream data for an object.
 * This is the public API for getting decoded stream content.
 *
 * @param {object} streamObj - A stream dictionary object (with _isStream and _streamData)
 * @returns {Uint8Array} Decoded stream data
 */
PDFDocument.prototype.getStreamData = function(streamObj) {
  if (!streamObj || !streamObj._isStream) {
    throw new PDFParseError('Object is not a stream');
  }
  return this._decodeStreamData(streamObj);
};

// ============================================================================
// Catalog and Page Tree
// ============================================================================

PDFDocument.prototype._resolveCatalog = function() {
  if (!this.trailer) {
    throw new PDFParseError('No trailer found');
  }

  // Get Root reference
  var rootRef = this.trailer.Root;
  if (!rootRef) {
    throw new PDFParseError('Trailer has no /Root entry');
  }

  this.catalog = this.resolveRef(rootRef);
  if (!this.catalog || typeof this.catalog !== 'object') {
    throw new PDFParseError('Cannot resolve document catalog');
  }

  // Get Pages reference
  var pagesRef = this.catalog.Pages;
  if (!pagesRef) {
    throw new PDFParseError('Catalog has no /Pages entry');
  }

  this.pagesRoot = this.resolveRef(pagesRef);
  if (!this.pagesRoot || typeof this.pagesRoot !== 'object') {
    throw new PDFParseError('Cannot resolve page tree root');
  }
};

/**
 * Parse the page tree and build a flat array of page objects.
 */
PDFDocument.prototype._parsePageTree = function() {
  this.pages = [];
  this._traversePageTree(this.pagesRoot, {}, 0);

  if (this.pages.length === 0) {
    throw new PDFParseError('No pages found in document');
  }

  if (this.pages.length > this.tracker.limits.MAX_PAGE_COUNT) {
    throw new PDFParseError('Page count exceeds limit (' + this.tracker.limits.MAX_PAGE_COUNT + ')');
  }
};

/**
 * Recursively traverse the page tree, collecting leaf page nodes.
 * Inheritable properties from parent nodes are merged down.
 *
 * @param {object} node - Current page tree node
 * @param {object} inherited - Inherited properties from parent nodes
 * @param {number} depth - Current tree depth
 */
PDFDocument.prototype._traversePageTree = function(node, inherited, depth) {
  if (depth > this.tracker.limits.MAX_RECURSION_DEPTH) {
    throw new PDFParseError('Page tree depth exceeds limit');
  }

  this.tracker.checkTimeout();

  if (!node || typeof node !== 'object') return;

  var type = node.Type;

  // Build inherited properties
  var props = {};
  for (var key in inherited) {
    props[key] = inherited[key];
  }

  // Inheritable page properties (PDF spec Table 30)
  var inheritableKeys = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
  for (var ik = 0; ik < inheritableKeys.length; ik++) {
    var ikey = inheritableKeys[ik];
    if (node[ikey] !== undefined) {
      props[ikey] = node[ikey];
    }
  }

  if (type === 'Pages') {
    // Intermediate node - recurse into Kids
    var kids = node.Kids;
    if (!Array.isArray(kids)) return;

    for (var i = 0; i < kids.length; i++) {
      var kid = this.resolveRef(kids[i]);
      if (kid) {
        this._traversePageTree(kid, props, depth + 1);
      }
    }
  } else if (type === 'Page') {
    // Leaf page node - add to pages array
    var page = {};
    for (var pkey in node) {
      page[pkey] = node[pkey];
    }

    // Apply inherited properties where not directly specified
    for (var ipkey in props) {
      if (!(ipkey in page) || page[ipkey] === undefined) {
        page[ipkey] = props[ipkey];
      }
    }

    this.pages.push(page);
  } else {
    // Type might be missing, try to determine from content
    if (node.Kids && Array.isArray(node.Kids)) {
      // Treat as Pages node
      var kids2 = node.Kids;
      for (var j = 0; j < kids2.length; j++) {
        var kid2 = this.resolveRef(kids2[j]);
        if (kid2) {
          this._traversePageTree(kid2, props, depth + 1);
        }
      }
    } else if (node.MediaBox || node.Contents) {
      // Treat as Page node
      var page2 = {};
      for (var pk2 in node) {
        page2[pk2] = node[pk2];
      }
      for (var ipk2 in props) {
        if (!(ipk2 in page2) || page2[ipk2] === undefined) {
          page2[ipk2] = props[ipk2];
        }
      }
      this.pages.push(page2);
    }
  }
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Get the number of pages in the document.
 * @returns {number}
 */
PDFDocument.prototype.getPageCount = function() {
  return this.pages.length;
};

/**
 * Get a page by its 1-based page number.
 *
 * @param {number} pageNum - 1-based page number
 * @returns {object} Page dictionary with inherited resources and MediaBox
 */
PDFDocument.prototype.getPage = function(pageNum) {
  if (pageNum < 1 || pageNum > this.pages.length) {
    throw new PDFParseError('Page number out of range: ' + pageNum +
      ' (document has ' + this.pages.length + ' pages)');
  }

  var page = this.pages[pageNum - 1];

  // Resolve important references
  var result = {};
  for (var key in page) {
    result[key] = page[key];
  }

  // Resolve MediaBox
  if (result.MediaBox) {
    result.MediaBox = this._resolveArray(result.MediaBox);
  }
  if (result.CropBox) {
    result.CropBox = this._resolveArray(result.CropBox);
  }

  // Validate page dimensions
  var box = result.CropBox || result.MediaBox;
  if (box) {
    this.tracker.validatePageDimensions(box);
  }

  return result;
};

/**
 * Resolve all references in an array.
 */
PDFDocument.prototype._resolveArray = function(arr) {
  if (!Array.isArray(arr)) {
    arr = this.resolveRef(arr);
    if (!Array.isArray(arr)) return arr;
  }

  var result = [];
  for (var i = 0; i < arr.length; i++) {
    var val = arr[i];
    if (val && typeof val === 'object' && val.isRef) {
      result.push(this.resolveRef(val));
    } else {
      result.push(val);
    }
  }
  return result;
};

/**
 * Recursively resolve all references in a value (up to a depth limit).
 * Useful for fully resolving a dictionary or array.
 *
 * @param {*} val - Value to resolve
 * @param {number} [depth=0] - Current depth
 * @param {number} [maxDepth=10] - Maximum depth
 * @returns {*} Resolved value
 */
PDFDocument.prototype.resolveDeep = function(val, depth, maxDepth) {
  depth = depth || 0;
  maxDepth = maxDepth || 10;

  if (depth > maxDepth) return val;

  // Resolve reference
  if (val && typeof val === 'object' && val.isRef) {
    val = this.resolveRef(val);
  }

  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;

  // Skip stream objects (don't recurse into their data)
  if (val._isStream) return val;

  if (Array.isArray(val)) {
    var arr = [];
    for (var i = 0; i < val.length; i++) {
      arr.push(this.resolveDeep(val[i], depth + 1, maxDepth));
    }
    return arr;
  }

  // Dictionary
  var dict = {};
  for (var key in val) {
    if (key.charAt(0) === '_') {
      dict[key] = val[key]; // Preserve internal properties
    } else {
      dict[key] = this.resolveDeep(val[key], depth + 1, maxDepth);
    }
  }
  return dict;
};

/**
 * Get the page's content stream data (decoded).
 * Handles both single stream and array of streams (concatenated).
 *
 * @param {number} pageNum - 1-based page number
 * @returns {Uint8Array} Decoded content stream data
 */
PDFDocument.prototype.getPageContentStream = function(pageNum) {
  var page = this.getPage(pageNum);
  var contents = page.Contents;

  if (!contents) {
    return new Uint8Array(0);
  }

  contents = this.resolveRef(contents);

  if (Array.isArray(contents)) {
    // Concatenate multiple content streams
    var parts = [];
    var totalLen = 0;

    for (var i = 0; i < contents.length; i++) {
      var streamObj = this.resolveRef(contents[i]);
      if (streamObj && streamObj._isStream) {
        var decoded = this._decodeStreamData(streamObj);
        parts.push(decoded);
        totalLen += decoded.length;
        // Add a space separator between streams
        totalLen += 1;
      }
    }

    var combined = new Uint8Array(totalLen);
    var offset = 0;
    for (var j = 0; j < parts.length; j++) {
      combined.set(parts[j], offset);
      offset += parts[j].length;
      // Add space separator
      combined[offset] = 0x20;
      offset += 1;
    }
    return combined;
  }

  if (contents && contents._isStream) {
    return this._decodeStreamData(contents);
  }

  return new Uint8Array(0);
};

/**
 * Get page resources (resolved).
 *
 * @param {number} pageNum - 1-based page number
 * @returns {object} Resources dictionary
 */
PDFDocument.prototype.getPageResources = function(pageNum) {
  var page = this.getPage(pageNum);
  var resources = page.Resources;

  if (!resources) {
    return {};
  }

  return this.resolveRef(resources) || {};
};

/**
 * Convert a PDF string (Uint8Array) to a JavaScript string.
 * Handles UTF-16BE BOM and PDFDocEncoding.
 *
 * @param {Uint8Array|string} pdfStr - PDF string value
 * @returns {string} JavaScript string
 */
PDFDocument.prototype.stringToJS = function(pdfStr) {
  if (typeof pdfStr === 'string') return pdfStr;
  if (!(pdfStr instanceof Uint8Array)) return String(pdfStr);

  // Check for UTF-16BE BOM (0xFE 0xFF)
  if (pdfStr.length >= 2 && pdfStr[0] === 0xFE && pdfStr[1] === 0xFF) {
    var result = '';
    for (var i = 2; i < pdfStr.length - 1; i += 2) {
      result += String.fromCharCode((pdfStr[i] << 8) | pdfStr[i + 1]);
    }
    return result;
  }

  // Check for UTF-8 BOM (0xEF 0xBB 0xBF)
  if (pdfStr.length >= 3 && pdfStr[0] === 0xEF && pdfStr[1] === 0xBB && pdfStr[2] === 0xBF) {
    return utf8Decode(pdfStr, 3);
  }

  // PDFDocEncoding (mostly Latin-1 with some differences in 0x80-0x9F range)
  var str = '';
  for (var j = 0; j < pdfStr.length; j++) {
    var code = pdfStr[j];
    if (code >= 0x80 && code <= 0x9F) {
      // PDFDocEncoding differences from Latin-1 in this range
      str += PDFDOC_ENCODING[code - 0x80] || String.fromCharCode(code);
    } else {
      str += String.fromCharCode(code);
    }
  }
  return str;
};

// PDFDocEncoding mapping for 0x80-0x9F (differs from Windows-1252)
var PDFDOC_ENCODING = [
  '•', '†', '‡', '…', '—', '–', 'ƒ', '⁄', // 80-87
  '‹', '›', '−', '‰', '„', '“', '”', '‘', // 88-8F
  '’', '‚', '™', 'ﬁ', 'ﬂ', 'Ł', 'Œ', 'Š', // 90-97
  'Ÿ', 'Ž', 'ı', 'ł', 'œ', 'š', 'ž', '�', // 98-9F
];

function utf8Decode(data, offset) {
  var result = '';
  var i = offset || 0;
  while (i < data.length) {
    var c = data[i];
    if (c < 0x80) {
      result += String.fromCharCode(c);
      i++;
    } else if (c < 0xE0) {
      result += String.fromCharCode(((c & 0x1F) << 6) | (data[i + 1] & 0x3F));
      i += 2;
    } else if (c < 0xF0) {
      result += String.fromCharCode(((c & 0x0F) << 12) | ((data[i + 1] & 0x3F) << 6) | (data[i + 2] & 0x3F));
      i += 3;
    } else {
      var cp = ((c & 0x07) << 18) | ((data[i + 1] & 0x3F) << 12) | ((data[i + 2] & 0x3F) << 6) | (data[i + 3] & 0x3F);
      if (cp > 0xFFFF) {
        cp -= 0x10000;
        result += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else {
        result += String.fromCharCode(cp);
      }
      i += 4;
    }
  }
  return result;
}

// ============================================================================
// Exports
// ============================================================================

if (typeof window !== 'undefined') {
  window.PDFParser = {
    PDFDocument: PDFDocument,
    PDFParseError: PDFParseError,
    PDFTokenizer: PDFTokenizer,
    parseValue: parseValue
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PDFDocument: PDFDocument,
    PDFParseError: PDFParseError,
    PDFTokenizer: PDFTokenizer,
    parseValue: parseValue
  };
}
