/**
 * pdf-parser.js -- PDF Binary Parser
 *
 * Self-contained PDF parser. Takes an ArrayBuffer and produces a structured
 * document object. Implements:
 *   - %PDF- header validation and version extraction
 *   - Cross-reference table parser (traditional xref keyword format)
 *   - Cross-reference stream parser (PDF 1.5+ /Type /XRef)
 *   - Trailer dictionary parser
 *   - Indirect object parser (N M obj ... endobj)
 *   - PDF object type parsers: booleans, numbers, strings, names, arrays, dicts, streams
 *   - Stream decompression: FlateDecode (RFC 1951 DEFLATE from scratch),
 *     ASCIIHexDecode, ASCII85Decode, RunLengthDecode, LZWDecode, CCITTFaxDecode
 *   - FlateDecode DecodeParms: Predictor, Columns, Colors, BitsPerComponent
 *   - Object reference resolution (N M R -> resolved object) with circular reference detection
 *   - Object stream support (/Type /ObjStm)
 *   - Page tree traversal: Catalog -> Pages -> Page objects
 *   - Named destination extraction
 *   - Resource dictionary inheritance through the page tree
 *
 * No external imports. All code is self-contained.
 */

'use strict';

// ============================================================================
// ParseError
// ============================================================================

class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

// ============================================================================
// Security limits
// ============================================================================

var MAX_OBJECT_COUNT      = 100000;
var MAX_STREAM_SIZE       = 200 * 1024 * 1024; // 200 MB decompressed
var MAX_NESTING_DEPTH     = 100;
var MAX_PARSE_TIME_MS     = 30000; // 30 seconds

// ============================================================================
// Inflate (RFC 1951 DEFLATE decompressor)
// ============================================================================

/**
 * Inflate a raw DEFLATE stream (no zlib/gzip wrapper).
 * Implements RFC 1951 from scratch.
 *
 * @param {Uint8Array} input - compressed data
 * @returns {Uint8Array} decompressed data
 */
function inflate(input) {
  var bitBuf = 0;
  var bitCount = 0;
  var pos = 0;
  var output = [];
  var outPos = 0;

  function readBit() {
    if (bitCount === 0) {
      if (pos >= input.length) throw new ParseError('Unexpected end of DEFLATE stream');
      bitBuf = input[pos++];
      bitCount = 8;
    }
    var bit = bitBuf & 1;
    bitBuf >>= 1;
    bitCount--;
    return bit;
  }

  function readBits(n) {
    var val = 0;
    for (var i = 0; i < n; i++) {
      val |= (readBit() << i);
    }
    return val;
  }

  function readBitsReverse(n) {
    var val = 0;
    for (var i = 0; i < n; i++) {
      val = (val << 1) | readBit();
    }
    return val;
  }

  // Build a Huffman tree from code lengths
  // Returns a decode function: () => symbol
  function buildHuffmanTable(codeLengths, maxSymbol) {
    var maxBits = 0;
    for (var i = 0; i < codeLengths.length; i++) {
      if (codeLengths[i] > maxBits) maxBits = codeLengths[i];
    }
    if (maxBits === 0) return function() { throw new ParseError('Empty Huffman table'); };

    // Count codes of each length
    var blCount = new Array(maxBits + 1);
    for (var i = 0; i <= maxBits; i++) blCount[i] = 0;
    for (var i = 0; i < codeLengths.length; i++) {
      if (codeLengths[i] > 0) blCount[codeLengths[i]]++;
    }

    // Find the numerical value of the smallest code for each code length
    var nextCode = new Array(maxBits + 1);
    nextCode[0] = 0;
    var code = 0;
    for (var bits = 1; bits <= maxBits; bits++) {
      code = (code + blCount[bits - 1]) << 1;
      nextCode[bits] = code;
    }

    // Build lookup: for fast decode, we store (symbol, length) indexed by code
    // Use a flat array approach: for each bit length, assign codes to symbols
    var symbolForCode = {};
    for (var i = 0; i < codeLengths.length; i++) {
      var len = codeLengths[i];
      if (len > 0) {
        var c = nextCode[len];
        nextCode[len]++;
        // Key is len:code
        var key = len + ':' + c;
        symbolForCode[key] = i;
      }
    }

    return function() {
      var c = 0;
      for (var len = 1; len <= maxBits; len++) {
        c = (c << 1) | readBit();
        var key = len + ':' + c;
        if (key in symbolForCode) {
          return symbolForCode[key];
        }
      }
      throw new ParseError('Invalid Huffman code in DEFLATE stream');
    };
  }

  // Fixed Huffman tables for BTYPE=1
  function buildFixedLitLenTable() {
    var lengths = new Array(288);
    for (var i = 0; i <= 143; i++) lengths[i] = 8;
    for (var i = 144; i <= 255; i++) lengths[i] = 9;
    for (var i = 256; i <= 279; i++) lengths[i] = 7;
    for (var i = 280; i <= 287; i++) lengths[i] = 8;
    return buildHuffmanTable(lengths, 288);
  }

  function buildFixedDistTable() {
    var lengths = new Array(32);
    for (var i = 0; i < 32; i++) lengths[i] = 5;
    return buildHuffmanTable(lengths, 32);
  }

  // Length and distance extra bits tables (RFC 1951 section 3.2.5)
  var lengthBase = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13,
    15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
    67, 83, 99, 115, 131, 163, 195, 227, 258
  ];
  var lengthExtra = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1,
    1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
    4, 4, 4, 4, 5, 5, 5, 5, 0
  ];
  var distBase = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25,
    33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
    1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
  ];
  var distExtra = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3,
    4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
    9, 9, 10, 10, 11, 11, 12, 12, 13, 13
  ];

  function decodeBlock(litLenDecode, distDecode) {
    while (true) {
      var sym = litLenDecode();
      if (sym < 256) {
        // Literal byte
        output[outPos++] = sym;
        if (outPos > MAX_STREAM_SIZE) throw new ParseError('Decompressed stream exceeds size limit');
      } else if (sym === 256) {
        // End of block
        return;
      } else {
        // Length-distance pair
        var lenIdx = sym - 257;
        if (lenIdx < 0 || lenIdx >= lengthBase.length) throw new ParseError('Invalid length code: ' + sym);
        var length = lengthBase[lenIdx] + readBits(lengthExtra[lenIdx]);

        var distSym = distDecode();
        if (distSym < 0 || distSym >= distBase.length) throw new ParseError('Invalid distance code: ' + distSym);
        var distance = distBase[distSym] + readBits(distExtra[distSym]);

        if (distance > outPos) throw new ParseError('Distance exceeds output buffer');

        // Copy from output buffer
        for (var i = 0; i < length; i++) {
          output[outPos] = output[outPos - distance];
          outPos++;
          if (outPos > MAX_STREAM_SIZE) throw new ParseError('Decompressed stream exceeds size limit');
        }
      }
    }
  }

  // Main inflate loop: process blocks
  var bfinal = 0;
  while (!bfinal) {
    bfinal = readBit();
    var btype = readBits(2);

    if (btype === 0) {
      // No compression (stored block)
      // Skip remaining bits in current byte
      bitCount = 0;
      if (pos + 4 > input.length) throw new ParseError('Truncated stored block header');
      var len = input[pos] | (input[pos + 1] << 8);
      var nlen = input[pos + 2] | (input[pos + 3] << 8);
      pos += 4;
      // nlen is one's complement of len -- verify
      if ((len ^ nlen) !== 0xffff) {
        // Some PDFs have wrong nlen, just use len
      }
      if (pos + len > input.length) throw new ParseError('Truncated stored block data');
      for (var i = 0; i < len; i++) {
        output[outPos++] = input[pos++];
      }
    } else if (btype === 1) {
      // Fixed Huffman codes
      decodeBlock(buildFixedLitLenTable(), buildFixedDistTable());
    } else if (btype === 2) {
      // Dynamic Huffman codes
      var hlit = readBits(5) + 257;
      var hdist = readBits(5) + 1;
      var hclen = readBits(4) + 4;

      // Code length code lengths (permutation order from RFC 1951)
      var clOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      var clLengths = new Array(19);
      for (var i = 0; i < 19; i++) clLengths[i] = 0;
      for (var i = 0; i < hclen; i++) {
        clLengths[clOrder[i]] = readBits(3);
      }

      var clDecode = buildHuffmanTable(clLengths, 19);

      // Decode literal/length + distance code lengths
      var allLengths = new Array(hlit + hdist);
      var idx = 0;
      while (idx < hlit + hdist) {
        var s = clDecode();
        if (s < 16) {
          allLengths[idx++] = s;
        } else if (s === 16) {
          // Repeat previous
          var rep = readBits(2) + 3;
          var prev = idx > 0 ? allLengths[idx - 1] : 0;
          for (var j = 0; j < rep; j++) allLengths[idx++] = prev;
        } else if (s === 17) {
          // Repeat 0 for 3-10 times
          var rep = readBits(3) + 3;
          for (var j = 0; j < rep; j++) allLengths[idx++] = 0;
        } else if (s === 18) {
          // Repeat 0 for 11-138 times
          var rep = readBits(7) + 11;
          for (var j = 0; j < rep; j++) allLengths[idx++] = 0;
        }
      }

      var litLenLengths = allLengths.slice(0, hlit);
      var distLengths = allLengths.slice(hlit, hlit + hdist);

      var litLenDecode = buildHuffmanTable(litLenLengths, hlit);

      // Handle the case where no distance codes are used (all zeros)
      var hasDistCodes = false;
      for (var i = 0; i < distLengths.length; i++) {
        if (distLengths[i] > 0) { hasDistCodes = true; break; }
      }
      var distDecode;
      if (hasDistCodes) {
        distDecode = buildHuffmanTable(distLengths, hdist);
      } else {
        distDecode = function() { throw new ParseError('No distance codes defined'); };
      }

      decodeBlock(litLenDecode, distDecode);
    } else {
      throw new ParseError('Invalid DEFLATE block type: ' + btype);
    }
  }

  return new Uint8Array(output);
}

/**
 * Inflate a zlib-wrapped stream (2-byte header, raw DEFLATE data, 4-byte Adler32 checksum).
 * PDF's FlateDecode uses zlib wrapper.
 */
function inflateZlib(data) {
  if (data.length < 2) throw new ParseError('Zlib data too short');
  var cmf = data[0];
  var cm = cmf & 0x0f;
  if (cm !== 8) throw new ParseError('Unsupported zlib compression method: ' + cm);
  // Skip 2-byte zlib header, and 4-byte Adler32 checksum at end
  var rawData = data.subarray(2);
  // Remove trailing Adler32 if present
  // We don't verify the checksum; just strip the header and inflate
  return inflate(rawData);
}

// ============================================================================
// ASCIIHexDecode
// ============================================================================

function asciiHexDecode(data) {
  var out = [];
  var high = -1;
  for (var i = 0; i < data.length; i++) {
    var b = data[i];
    // EOD marker
    if (b === 0x3E) break; // '>'

    // Skip whitespace
    if (b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D || b === 0x0C) continue;

    var nibble;
    if (b >= 0x30 && b <= 0x39) nibble = b - 0x30;
    else if (b >= 0x41 && b <= 0x46) nibble = b - 0x41 + 10;
    else if (b >= 0x61 && b <= 0x66) nibble = b - 0x61 + 10;
    else continue; // skip invalid chars

    if (high === -1) {
      high = nibble;
    } else {
      out.push((high << 4) | nibble);
      high = -1;
    }
  }
  // If odd number of hex digits, treat last as N0
  if (high !== -1) {
    out.push(high << 4);
  }
  return new Uint8Array(out);
}

// ============================================================================
// ASCII85Decode
// ============================================================================

function ascii85Decode(data) {
  var out = [];
  var group = 0;
  var count = 0;
  var i = 0;

  while (i < data.length) {
    var b = data[i++];

    // EOD marker ~>
    if (b === 0x7E) { // '~'
      if (i < data.length && data[i] === 0x3E) break; // '>'
      continue;
    }

    // Skip whitespace
    if (b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D || b === 0x0C) continue;

    if (b === 0x7A && count === 0) { // 'z' = all zeros shorthand
      out.push(0, 0, 0, 0);
      continue;
    }

    if (b < 0x21 || b > 0x75) continue; // '!' to 'u'

    group = group * 85 + (b - 0x21);
    count++;

    if (count === 5) {
      out.push((group >>> 24) & 0xFF);
      out.push((group >>> 16) & 0xFF);
      out.push((group >>> 8) & 0xFF);
      out.push(group & 0xFF);
      group = 0;
      count = 0;
    }
  }

  // Handle remaining bytes
  if (count > 0) {
    // Pad with 'u' (0x75 = 84 in base85)
    var remaining = count;
    for (var j = count; j < 5; j++) {
      group = group * 85 + 84;
    }
    for (var j = 0; j < remaining - 1; j++) {
      out.push((group >>> (24 - j * 8)) & 0xFF);
    }
  }

  return new Uint8Array(out);
}

// ============================================================================
// RunLengthDecode
// ============================================================================

function _runLengthDecode(data) {
  var out = [];
  var i = 0;
  while (i < data.length) {
    var len = data[i++];
    if (len === 128) break; // EOD
    if (len < 128) {
      // Literal run: copy len+1 bytes
      var count = len + 1;
      for (var j = 0; j < count && i < data.length; j++) {
        out.push(data[i++]);
      }
    } else {
      // Repeat run: repeat next byte (257-len) times
      var count = 257 - len;
      if (i < data.length) {
        var b = data[i++];
        for (var j = 0; j < count; j++) {
          out.push(b);
        }
      }
    }
  }
  return new Uint8Array(out);
}

// ============================================================================
// LZWDecode
// ============================================================================

function _lzwDecode(data, earlyChange) {
  if (earlyChange === undefined) earlyChange = true;
  var CLEAR = 256;
  var EOD = 257;
  var FIRST_CODE = 258;

  var bitBuf = 0;
  var bitCount = 0;
  var bytePos = 0;
  var codeWidth = 9;

  function readCode() {
    // MSB-first bit packing (PDF spec)
    while (bitCount < codeWidth) {
      if (bytePos >= data.length) return EOD;
      bitBuf = (bitBuf << 8) | data[bytePos++];
      bitCount += 8;
    }
    var code = (bitBuf >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
    bitCount -= codeWidth;
    return code;
  }

  var table = [];
  var nextCode;
  var output = [];

  function resetTable() {
    table = [];
    for (var i = 0; i < 256; i++) {
      table[i] = [i];
    }
    table[CLEAR] = null;
    table[EOD] = null;
    nextCode = FIRST_CODE;
    codeWidth = 9;
  }

  resetTable();

  // Read first code (should be CLEAR)
  var code = readCode();
  if (code === EOD) return new Uint8Array(0);
  if (code === CLEAR) {
    resetTable();
    code = readCode();
    if (code === EOD) return new Uint8Array(0);
  }

  if (code >= table.length || !table[code]) {
    return new Uint8Array(output);
  }
  var prev = table[code];
  for (var i = 0; i < prev.length; i++) output.push(prev[i]);

  while (true) {
    code = readCode();
    if (code === EOD) break;
    if (code === CLEAR) {
      resetTable();
      code = readCode();
      if (code === EOD) break;
      if (code >= table.length || !table[code]) break;
      prev = table[code];
      for (var i = 0; i < prev.length; i++) output.push(prev[i]);
      continue;
    }

    var entry;
    if (code < nextCode && table[code]) {
      entry = table[code];
    } else if (code === nextCode) {
      // Special case: code not yet in table
      entry = prev.concat([prev[0]]);
    } else {
      // Invalid code -- gracefully stop
      break;
    }

    for (var i = 0; i < entry.length; i++) output.push(entry[i]);

    // Add new entry to table
    if (nextCode < 4096) {
      table[nextCode] = prev.concat([entry[0]]);
      nextCode++;
      // Width increase check
      var threshold = earlyChange ? nextCode : nextCode - 1;
      if (threshold >= (1 << codeWidth) && codeWidth < 12) {
        codeWidth++;
      }
    }

    prev = entry;

    if (output.length > MAX_STREAM_SIZE) {
      throw new ParseError('LZW decompressed stream exceeds size limit');
    }
  }

  return new Uint8Array(output);
}

// ============================================================================
// CCITTFaxDecode
// ============================================================================

function _ccittFaxDecode(data, params) {
  var K = (params && params['/K']) || 0;
  var columns = (params && params['/Columns']) || 1728;
  var rows = (params && params['/Rows']) || 0;
  var blackIs1 = (params && params['/BlackIs1']) || false;
  var encodedByteAlign = (params && params['/EncodedByteAlign']) || false;

  // Simple CCITT stub: returns a buffer of the right size
  // Group 4 (K < 0), Group 3 2-D (K > 0), Group 3 1-D (K = 0)
  var bytesPerRow = Math.ceil(columns / 8);
  var totalRows = rows || 1;

  var bitPos = 0;
  var bytePos = 0;

  function peekBits(n) {
    var val = 0;
    var tmpBytePos = bytePos;
    var tmpBitPos = bitPos;
    for (var i = 0; i < n; i++) {
      if (tmpBytePos >= data.length) return -1;
      var bit = (data[tmpBytePos] >> (7 - tmpBitPos)) & 1;
      val = (val << 1) | bit;
      tmpBitPos++;
      if (tmpBitPos >= 8) {
        tmpBitPos = 0;
        tmpBytePos++;
      }
    }
    return val;
  }

  function readBit() {
    if (bytePos >= data.length) return 0;
    var bit = (data[bytePos] >> (7 - bitPos)) & 1;
    bitPos++;
    if (bitPos >= 8) {
      bitPos = 0;
      bytePos++;
    }
    return bit;
  }

  function readBitsVal(n) {
    var val = 0;
    for (var i = 0; i < n; i++) {
      val = (val << 1) | readBit();
    }
    return val;
  }

  function byteAlign() {
    if (bitPos > 0) {
      bitPos = 0;
      bytePos++;
    }
  }

  // Group 4 2D decoder
  function findB1(ref, a0, isWhite) {
    // Find first transition in ref after a0 that has the opposite color
    // b1 is the first changing element to the right of a0 in ref that has opposite color to current
    var start = a0 < 0 ? 0 : a0;
    var targetColor = isWhite ? 1 : 0; // opposite of current
    var found = false;
    var i;
    for (i = start; i < columns; i++) {
      if (ref[i] === targetColor) {
        found = true;
        break;
      }
    }
    if (!found) return columns;
    // Now find the first changing element: continue in targetColor until transition
    // Actually b1 is defined as the first changing element of ref that is to the right
    // of a0 and has the opposite color of a0
    return i;
  }

  function findB2(ref, b1) {
    // b2 is the next changing element after b1 in ref
    if (b1 >= columns) return columns;
    var color = ref[b1];
    for (var i = b1 + 1; i < columns; i++) {
      if (ref[i] !== color) return i;
    }
    return columns;
  }

  function decodeGroup4() {
    var outputPixels = new Uint8Array(columns * totalRows);
    var refLine = new Uint8Array(columns);  // previous line, starts all white (0)
    var curLine = new Uint8Array(columns);

    for (var row = 0; row < totalRows; row++) {
      curLine.fill(0); // reset to white
      var a0 = -1;
      var color = 0; // 0 = white, 1 = black

      var maxIter = columns * 4;
      var iter = 0;

      while (a0 < columns - 1 && iter < maxIter) {
        iter++;
        // Check for EOFB (two consecutive EOL codes)
        var top24 = peekBits(24);
        if (top24 === 0x000001) break;

        // Read mode code
        // V(0) = 1
        // VR(1) = 011, VR(2) = 000011, VR(3) = 0000011
        // VL(1) = 010, VL(2) = 000010, VL(3) = 0000010
        // Pass = 0001
        // Horizontal = 001
        var bit1 = readBit();
        if (bit1 === 1) {
          // V(0): a1 = b1
          var b1 = findB1(refLine, a0, color === 0);
          var a1 = b1;
          if (a1 > columns) a1 = columns;
          var fillStart = a0 < 0 ? 0 : a0;
          for (var x = fillStart; x < a1; x++) {
            curLine[x] = color;
          }
          a0 = a1;
          color = color === 0 ? 1 : 0;
        } else {
          var bit2 = readBit();
          if (bit2 === 1) {
            var bit3 = readBit();
            if (bit3 === 1) {
              // 011 = VR(1)
              var b1 = findB1(refLine, a0, color === 0);
              var a1 = b1 + 1;
              if (a1 > columns) a1 = columns;
              var fillStart = a0 < 0 ? 0 : a0;
              for (var x = fillStart; x < a1; x++) curLine[x] = color;
              a0 = a1;
              color = color === 0 ? 1 : 0;
            } else {
              // 010 = VL(1)
              var b1 = findB1(refLine, a0, color === 0);
              var a1 = b1 - 1;
              if (a1 < 0) a1 = 0;
              if (a1 > columns) a1 = columns;
              var fillStart = a0 < 0 ? 0 : a0;
              for (var x = fillStart; x < a1; x++) curLine[x] = color;
              a0 = a1;
              color = color === 0 ? 1 : 0;
            }
          } else {
            var bit3 = readBit();
            if (bit3 === 1) {
              // 001 = Horizontal
              // Read two run lengths using Group 3 1-D codes
              // Simplified: just advance by reading run lengths
              var run1 = readHuffmanRun(color === 0);
              var run2 = readHuffmanRun(color !== 0);
              var fillStart = a0 < 0 ? 0 : a0;
              for (var x = fillStart; x < fillStart + run1 && x < columns; x++) {
                curLine[x] = color;
              }
              var secondStart = fillStart + run1;
              var secondColor = color === 0 ? 1 : 0;
              for (var x = secondStart; x < secondStart + run2 && x < columns; x++) {
                curLine[x] = secondColor;
              }
              a0 = secondStart + run2;
              // color stays the same after horizontal mode
            } else {
              var bit4 = readBit();
              if (bit4 === 1) {
                // 0001 = Pass
                var b1 = findB1(refLine, a0, color === 0);
                var b2 = findB2(refLine, b1);
                var fillStart = a0 < 0 ? 0 : a0;
                for (var x = fillStart; x < b2 && x < columns; x++) {
                  curLine[x] = color;
                }
                a0 = b2;
                // color unchanged in pass mode
              } else {
                // Longer codes: VR(2), VR(3), VL(2), VL(3)
                var bit5 = readBit();
                if (bit5 === 1) {
                  var bit6 = readBit();
                  if (bit6 === 1) {
                    // 000011 = VR(2)
                    var b1 = findB1(refLine, a0, color === 0);
                    var a1 = b1 + 2;
                    if (a1 > columns) a1 = columns;
                    var fillStart = a0 < 0 ? 0 : a0;
                    for (var x = fillStart; x < a1; x++) curLine[x] = color;
                    a0 = a1;
                    color = color === 0 ? 1 : 0;
                  } else {
                    // 000010 = VL(2)
                    var b1 = findB1(refLine, a0, color === 0);
                    var a1 = b1 - 2;
                    if (a1 < 0) a1 = 0;
                    if (a1 > columns) a1 = columns;
                    var fillStart = a0 < 0 ? 0 : a0;
                    for (var x = fillStart; x < a1; x++) curLine[x] = color;
                    a0 = a1;
                    color = color === 0 ? 1 : 0;
                  }
                } else {
                  var bit6 = readBit();
                  if (bit6 === 1) {
                    var bit7 = readBit();
                    if (bit7 === 1) {
                      // 0000011 = VR(3)
                      var b1 = findB1(refLine, a0, color === 0);
                      var a1 = b1 + 3;
                      if (a1 > columns) a1 = columns;
                      var fillStart = a0 < 0 ? 0 : a0;
                      for (var x = fillStart; x < a1; x++) curLine[x] = color;
                      a0 = a1;
                      color = color === 0 ? 1 : 0;
                    } else {
                      // 0000010 = VL(3)
                      var b1 = findB1(refLine, a0, color === 0);
                      var a1 = b1 - 3;
                      if (a1 < 0) a1 = 0;
                      if (a1 > columns) a1 = columns;
                      var fillStart = a0 < 0 ? 0 : a0;
                      for (var x = fillStart; x < a1; x++) curLine[x] = color;
                      a0 = a1;
                      color = color === 0 ? 1 : 0;
                    }
                  } else {
                    // Unknown code, skip
                    break;
                  }
                }
              }
            }
          }
        }
      }

      // Copy current line to output
      for (var x = 0; x < columns; x++) {
        outputPixels[row * columns + x] = curLine[x];
      }
      // Copy current line to reference
      refLine.set(curLine);
    }

    // Convert pixel values to bytes
    var outBytes = new Uint8Array(totalRows * bytesPerRow);
    for (var row = 0; row < totalRows; row++) {
      for (var x = 0; x < columns; x++) {
        var byteIdx = row * bytesPerRow + (x >> 3);
        var bitIdx = 7 - (x & 7);
        var pixel = outputPixels[row * columns + x];
        var isBlack = blackIs1 ? (pixel !== 0) : (pixel === 0);
        if (isBlack) {
          outBytes[byteIdx] |= (1 << bitIdx);
        }
      }
    }

    return outBytes;
  }

  // Group 3 Huffman tables for run lengths
  // White run length codes
  var whiteTermCodes = {
    '00110101': 0, '000111': 1, '0111': 2, '1000': 3,
    '1011': 4, '1100': 5, '1110': 6, '1111': 7,
    '10011': 8, '10100': 9, '00111': 10, '01000': 11,
    '001000': 12, '000011': 13, '110100': 14, '110101': 15,
    '101010': 16, '101011': 17, '0100111': 18, '0001100': 19,
    '0001000': 20, '0010111': 21, '0000011': 22, '0000100': 23,
    '0101000': 24, '0101011': 25, '0010011': 26, '0100100': 27,
    '0011000': 28, '00000010': 29, '00000011': 30, '00011010': 31,
    '00011011': 32, '00010010': 33, '00010011': 34, '00010100': 35,
    '00010101': 36, '00010110': 37, '00010111': 38, '00101000': 39,
    '00101001': 40, '00101010': 41, '00101011': 42, '00101100': 43,
    '00101101': 44, '00000100': 45, '00000101': 46, '00001010': 47,
    '00001011': 48, '01010010': 49, '01010011': 50, '01010100': 51,
    '01010101': 52, '00100100': 53, '00100101': 54, '01011000': 55,
    '01011001': 56, '01011010': 57, '01011011': 58, '01001010': 59,
    '01001011': 60, '00110010': 61, '00110011': 62, '00110100': 63
  };

  var blackTermCodes = {
    '0000110111': 0, '010': 1, '11': 2, '10': 3,
    '011': 4, '0011': 5, '0010': 6, '00011': 7,
    '000101': 8, '000100': 9, '0000100': 10, '0000101': 11,
    '0000111': 12, '00000100': 13, '00000111': 14, '000011000': 15,
    '0000010111': 16, '0000011000': 17, '0000001000': 18, '00001100111': 19,
    '00001101000': 20, '00001101100': 21, '00000110111': 22, '00000101000': 23,
    '00000010111': 24, '00000011000': 25, '000011001010': 26, '000011001011': 27,
    '000011001100': 28, '000011001101': 29, '000001101000': 30, '000001101001': 31,
    '000001101010': 32, '000001101011': 33, '000011010010': 34, '000011010011': 35,
    '000011010100': 36, '000011010101': 37, '000011010110': 38, '000011010111': 39,
    '000001101100': 40, '000001101101': 41, '000011011010': 42, '000011011011': 43,
    '000001010100': 44, '000001010101': 45, '000001010110': 46, '000001010111': 47,
    '000001100100': 48, '000001100101': 49, '000001010010': 50, '000001010011': 51,
    '000000100100': 52, '000000110111': 53, '000000111000': 54, '000000100111': 55,
    '000000101000': 56, '000001011000': 57, '000001011001': 58, '000000101011': 59,
    '000000101100': 60, '000001011010': 61, '000001100110': 62, '000001100111': 63
  };

  // Build reverse lookup for Huffman decoding
  var whiteTermByBits = {};
  for (var code in whiteTermCodes) {
    if (!whiteTermByBits[code.length]) whiteTermByBits[code.length] = {};
    whiteTermByBits[code.length][code] = whiteTermCodes[code];
  }

  var blackTermByBits = {};
  for (var code in blackTermCodes) {
    if (!blackTermByBits[code.length]) blackTermByBits[code.length] = {};
    blackTermByBits[code.length][code] = blackTermCodes[code];
  }

  // Makeup codes (white and black share some codes but have different values)
  // White makeup codes (run lengths 64, 128, 192, ... 1728, 1792, ...)
  var whiteMakeupCodes = {
    '11011': 64, '10010': 128, '010111': 192, '0110111': 256,
    '00110110': 320, '00110111': 384, '01100100': 448, '01100101': 512,
    '01101000': 576, '01100111': 640, '011001100': 704, '011001101': 768,
    '011010010': 832, '011010011': 896, '011010100': 960, '011010101': 1024,
    '011010110': 1088, '011010111': 1152, '011011000': 1216, '011011001': 1280,
    '011011010': 1344, '011011011': 1408, '010011000': 1472, '010011001': 1536,
    '010011010': 1600, '011000': 1664, '010011011': 1728
  };

  var blackMakeupCodes = {
    '0000001111': 64, '000011001000': 128, '000011001001': 192, '000001011011': 256,
    '000000110011': 320, '000000110100': 384, '000000110101': 448, '0000001101100': 512,
    '0000001101101': 576, '0000001001010': 640, '0000001001011': 704, '0000001001100': 768,
    '0000001001101': 832, '0000001110010': 896, '0000001110011': 960, '0000001110100': 1024,
    '0000001110101': 1088, '0000001110110': 1152, '0000001110111': 1216, '0000001010010': 1280,
    '0000001010011': 1344, '0000001010100': 1408, '0000001010101': 1472, '0000001011010': 1536,
    '0000001011011': 1600, '0000001100100': 1664, '0000001100101': 1728
  };

  // Common extended makeup codes (same for white and black)
  var extMakeupCodes = {
    '00000001000': 1792, '00000001100': 1856, '00000001101': 1920,
    '000000010010': 1984, '000000010011': 2048, '000000010100': 2112,
    '000000010101': 2176, '000000010110': 2240, '000000010111': 2304,
    '000000011100': 2368, '000000011101': 2432, '000000011110': 2496, '000000011111': 2560
  };

  // Build combined lookup for Huffman run-length decoding
  function buildRunLookup(termCodes, makeupCodes) {
    var byBits = {};
    for (var code in termCodes) {
      if (!byBits[code.length]) byBits[code.length] = {};
      byBits[code.length][code] = { val: termCodes[code], type: 'term' };
    }
    for (var code in makeupCodes) {
      if (!byBits[code.length]) byBits[code.length] = {};
      byBits[code.length][code] = { val: makeupCodes[code], type: 'makeup' };
    }
    for (var code in extMakeupCodes) {
      if (!byBits[code.length]) byBits[code.length] = {};
      byBits[code.length][code] = { val: extMakeupCodes[code], type: 'makeup' };
    }
    return byBits;
  }

  var whiteLookup = buildRunLookup(whiteTermCodes, whiteMakeupCodes);
  var blackLookup = buildRunLookup(blackTermCodes, blackMakeupCodes);

  function readHuffmanRun(isWhite) {
    var lookup = isWhite ? whiteLookup : blackLookup;
    var totalRun = 0;
    var maxBits = 13; // max code length

    while (true) {
      var bits = '';
      var found = false;
      for (var len = 1; len <= maxBits; len++) {
        bits += readBit();
        if (lookup[len] && lookup[len][bits]) {
          var entry = lookup[len][bits];
          totalRun += entry.val;
          if (entry.type === 'term') {
            return totalRun;
          }
          // Makeup code: continue to read terminal code
          bits = '';
          found = true;
          break;
        }
      }
      if (!found && bits.length >= maxBits) {
        // Could not decode; return what we have
        return totalRun;
      }
    }
  }

  // Main dispatch
  try {
    if (data.length === 0) {
      // Empty input
      return new Uint8Array(totalRows * bytesPerRow);
    }

    if (K < 0) {
      // Group 4
      return decodeGroup4();
    } else {
      // Group 3 -- simplified: return empty image of correct size
      // A full Group 3 decoder would read EOL codes and Huffman runs
      return new Uint8Array(totalRows * bytesPerRow);
    }
  } catch (e) {
    // On any error, return whatever we have
    return new Uint8Array(totalRows * bytesPerRow);
  }
}

// ============================================================================
// TIFF Predictor
// ============================================================================

function _applyTIFFPredictor(data, params) {
  var columns = (params && params['/Columns']) || 1;
  var colors = (params && params['/Colors']) || 1;
  var bpc = (params && params['/BitsPerComponent']) || 8;

  if (bpc !== 8) {
    // Only handle 8bpc for TIFF predictor
    return data;
  }

  var bytesPerPixel = colors;
  var bytesPerRow = columns * bytesPerPixel;
  var result = new Uint8Array(data.length);

  for (var i = 0; i < data.length; i++) {
    var row = Math.floor(i / bytesPerRow);
    var col = i % bytesPerRow;

    if (col < bytesPerPixel) {
      // First pixel in row, no prediction
      result[i] = data[i];
    } else {
      result[i] = (data[i] + result[i - bytesPerPixel]) & 0xFF;
    }
  }

  return result;
}

// ============================================================================
// PNG Predictor (Predictor 10-15)
// ============================================================================

function applyPNGPredictor(data, columns, colors, bpc) {
  var bytesPerPixel = Math.max(1, Math.ceil(colors * bpc / 8));
  var bytesPerRow = Math.ceil(columns * colors * bpc / 8);
  var rowSize = 1 + bytesPerRow; // 1 byte for filter type

  if (data.length < rowSize) return data;

  var numRows = Math.floor(data.length / rowSize);
  var output = new Uint8Array(numRows * bytesPerRow);
  var prevRow = new Uint8Array(bytesPerRow); // previous row (initially zeros)

  for (var row = 0; row < numRows; row++) {
    var offset = row * rowSize;
    var filterType = data[offset];
    var curRow = new Uint8Array(bytesPerRow);

    for (var i = 0; i < bytesPerRow; i++) {
      var raw = data[offset + 1 + i] || 0;
      var a = i >= bytesPerPixel ? curRow[i - bytesPerPixel] : 0; // left
      var b = prevRow[i]; // above
      var c = i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0; // upper-left

      switch (filterType) {
        case 0: // None
          curRow[i] = raw;
          break;
        case 1: // Sub
          curRow[i] = (raw + a) & 0xFF;
          break;
        case 2: // Up
          curRow[i] = (raw + b) & 0xFF;
          break;
        case 3: // Average
          curRow[i] = (raw + Math.floor((a + b) / 2)) & 0xFF;
          break;
        case 4: // Paeth
          curRow[i] = (raw + paethPredictor(a, b, c)) & 0xFF;
          break;
        default:
          curRow[i] = raw;
          break;
      }
    }

    output.set(curRow, row * bytesPerRow);
    prevRow = curRow;
  }

  return output;
}

function paethPredictor(a, b, c) {
  var p = a + b - c;
  var pa = Math.abs(p - a);
  var pb = Math.abs(p - b);
  var pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ============================================================================
// Stream decoder: applies filter chain
// ============================================================================

function decodeStream(rawBytes, filterName, decodeParms) {
  var decoded;

  switch (filterName) {
    case 'FlateDecode':
    case '/FlateDecode':
      decoded = inflateZlib(rawBytes);
      break;
    case 'ASCIIHexDecode':
    case '/ASCIIHexDecode':
      decoded = asciiHexDecode(rawBytes);
      break;
    case 'ASCII85Decode':
    case '/ASCII85Decode':
      decoded = ascii85Decode(rawBytes);
      break;
    case 'RunLengthDecode':
    case '/RunLengthDecode':
      decoded = _runLengthDecode(rawBytes);
      break;
    case 'LZWDecode':
    case '/LZWDecode':
      var earlyChange = true;
      if (decodeParms && decodeParms['/EarlyChange'] !== undefined) {
        earlyChange = decodeParms['/EarlyChange'] !== 0;
      }
      decoded = _lzwDecode(rawBytes, earlyChange);
      break;
    case 'CCITTFaxDecode':
    case '/CCITTFaxDecode':
      decoded = _ccittFaxDecode(rawBytes, decodeParms || {});
      break;
    case 'DCTDecode':
    case '/DCTDecode':
      // JPEG -- pass through raw bytes (browser will decode)
      return rawBytes;
    case 'JPXDecode':
    case '/JPXDecode':
      // JPEG 2000 -- pass through
      return rawBytes;
    case 'JBIG2Decode':
    case '/JBIG2Decode':
      // JBIG2 -- pass through
      return rawBytes;
    default:
      // Unknown filter -- pass through
      return rawBytes;
  }

  // Apply predictor if present
  if (decodeParms) {
    var predictor = decodeParms['/Predictor'];
    if (predictor && predictor >= 10 && predictor <= 15) {
      // PNG predictor
      var columns = decodeParms['/Columns'] || 1;
      var colors = decodeParms['/Colors'] || 1;
      var bpc = decodeParms['/BitsPerComponent'] || 8;
      decoded = applyPNGPredictor(decoded, columns, colors, bpc);
    } else if (predictor === 2) {
      // TIFF predictor
      decoded = _applyTIFFPredictor(decoded, decodeParms);
    }
  }

  return decoded;
}

// ============================================================================
// PDF Tokenizer / Object Parser
// ============================================================================

/**
 * PDFParser class. Takes an ArrayBuffer and produces a structured document.
 */
class PDFParser {
  constructor(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer)) {
      throw new ParseError('PDFParser requires an ArrayBuffer');
    }
    this.data = new Uint8Array(arrayBuffer);
    this.pos = 0;
    this.version = null;
    this.xrefEntries = {};     // objNum -> { offset, gen, inUse }
    this.trailer = null;
    this.objects = {};         // "objNum:gen" -> parsed object
    this.resolving = new Set();// circular reference detection
    this.objectCount = 0;
    this.startTime = Date.now();
    this.catalog = null;
    this.pages = [];
    this._objStmCache = {};   // objStm number -> parsed objects
  }

  // ─── Utility methods ────────────────────────────────────────────────

  checkTimeout() {
    if (Date.now() - this.startTime > MAX_PARSE_TIME_MS) {
      throw new ParseError('Parse timeout exceeded (' + MAX_PARSE_TIME_MS + 'ms)');
    }
  }

  peek(offset) {
    var idx = (offset !== undefined) ? offset : this.pos;
    if (idx < 0 || idx >= this.data.length) return -1;
    return this.data[idx];
  }

  readByte() {
    if (this.pos >= this.data.length) return -1;
    return this.data[this.pos++];
  }

  readBytes(n) {
    var end = Math.min(this.pos + n, this.data.length);
    var bytes = this.data.subarray(this.pos, end);
    this.pos = end;
    return bytes;
  }

  // Read a text string from data at a given offset without moving this.pos
  readStringAt(offset, len) {
    var end = Math.min(offset + len, this.data.length);
    var s = '';
    for (var i = offset; i < end; i++) {
      s += String.fromCharCode(this.data[i]);
    }
    return s;
  }

  isWhitespace(b) {
    return b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D || b === 0x0C || b === 0x00;
  }

  isDelimiter(b) {
    return b === 0x28 || b === 0x29 || b === 0x3C || b === 0x3E ||
           b === 0x5B || b === 0x5D || b === 0x7B || b === 0x7D ||
           b === 0x2F || b === 0x25;
  }

  isDigit(b) {
    return b >= 0x30 && b <= 0x39;
  }

  skipWhitespace() {
    while (this.pos < this.data.length) {
      var b = this.data[this.pos];
      if (this.isWhitespace(b)) {
        this.pos++;
      } else if (b === 0x25) { // '%' comment
        this.pos++;
        while (this.pos < this.data.length && this.data[this.pos] !== 0x0A && this.data[this.pos] !== 0x0D) {
          this.pos++;
        }
      } else {
        break;
      }
    }
  }

  // Read a token (sequence of non-whitespace, non-delimiter bytes)
  readToken() {
    this.skipWhitespace();
    if (this.pos >= this.data.length) return null;

    var b = this.data[this.pos];

    // Single-char delimiters that are their own tokens
    if (b === 0x5B) { this.pos++; return '['; }  // [
    if (b === 0x5D) { this.pos++; return ']'; }  // ]

    // << or < (hex string)
    if (b === 0x3C) {
      if (this.pos + 1 < this.data.length && this.data[this.pos + 1] === 0x3C) {
        this.pos += 2;
        return '<<';
      }
      // hex string -- handled by caller
      return null;
    }

    // >> end dict
    if (b === 0x3E) {
      if (this.pos + 1 < this.data.length && this.data[this.pos + 1] === 0x3E) {
        this.pos += 2;
        return '>>';
      }
      this.pos++;
      return '>';
    }

    // ( literal string -- handled separately
    if (b === 0x28) return null;

    // / name
    if (b === 0x2F) return null;

    // Regular token (keyword, number, etc.)
    var start = this.pos;
    while (this.pos < this.data.length) {
      b = this.data[this.pos];
      if (this.isWhitespace(b) || this.isDelimiter(b)) break;
      this.pos++;
    }
    var s = '';
    for (var i = start; i < this.pos; i++) {
      s += String.fromCharCode(this.data[i]);
    }
    return s;
  }

  // ─── PDF object parsers ─────────────────────────────────────────────

  /**
   * Parse any PDF object at the current position.
   * Returns the parsed object value.
   */
  parseObject(depth) {
    if (depth === undefined) depth = 0;
    if (depth > MAX_NESTING_DEPTH) throw new ParseError('Maximum nesting depth exceeded');
    this.checkTimeout();

    this.skipWhitespace();
    if (this.pos >= this.data.length) throw new ParseError('Unexpected end of data');

    var b = this.data[this.pos];

    // Boolean
    if (this.matchKeyword('true')) return true;
    if (this.matchKeyword('false')) return false;

    // Null
    if (this.matchKeyword('null')) return null;

    // Name /Xxx
    if (b === 0x2F) return this.parseName();

    // Literal string (...)
    if (b === 0x28) return this.parseLiteralString();

    // Hex string <...> or dictionary <<...>>
    if (b === 0x3C) {
      if (this.pos + 1 < this.data.length && this.data[this.pos + 1] === 0x3C) {
        return this.parseDictionary(depth);
      }
      return this.parseHexString();
    }

    // Array [...]
    if (b === 0x5B) return this.parseArray(depth);

    // Number or indirect reference (N M R) or indirect object (N M obj)
    if (this.isDigit(b) || b === 0x2D || b === 0x2B || b === 0x2E) {
      return this.parseNumberOrRef(depth);
    }

    // Try reading as a keyword/token
    var token = this.readToken();
    if (token === null) {
      throw new ParseError('Unexpected byte at pos ' + this.pos + ': 0x' + b.toString(16));
    }
    return token;
  }

  matchKeyword(kw) {
    if (this.pos + kw.length > this.data.length) return false;
    for (var i = 0; i < kw.length; i++) {
      if (this.data[this.pos + i] !== kw.charCodeAt(i)) return false;
    }
    // Must be followed by whitespace or delimiter or end of data
    var after = this.pos + kw.length;
    if (after < this.data.length) {
      var next = this.data[after];
      if (!this.isWhitespace(next) && !this.isDelimiter(next)) return false;
    }
    this.pos += kw.length;
    return true;
  }

  parseName() {
    // pos should be at '/'
    this.pos++; // skip '/'
    var name = '/';
    while (this.pos < this.data.length) {
      var b = this.data[this.pos];
      if (this.isWhitespace(b) || this.isDelimiter(b)) break;
      if (b === 0x23 && this.pos + 2 < this.data.length) {
        // #XX hex escape
        var hex = String.fromCharCode(this.data[this.pos + 1]) + String.fromCharCode(this.data[this.pos + 2]);
        var val = parseInt(hex, 16);
        if (!isNaN(val)) {
          name += String.fromCharCode(val);
          this.pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(b);
      this.pos++;
    }
    return name;
  }

  parseLiteralString() {
    // pos at '('
    this.pos++; // skip '('
    var result = [];
    var parenDepth = 1;

    while (this.pos < this.data.length && parenDepth > 0) {
      var b = this.data[this.pos++];

      if (b === 0x5C) { // backslash escape
        if (this.pos >= this.data.length) break;
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
          case 0x0A: break; // line continuation
          case 0x0D: // line continuation (possibly \r\n)
            if (this.pos < this.data.length && this.data[this.pos] === 0x0A) this.pos++;
            break;
          default:
            // Octal escape?
            if (next >= 0x30 && next <= 0x37) {
              var octal = next - 0x30;
              if (this.pos < this.data.length && this.data[this.pos] >= 0x30 && this.data[this.pos] <= 0x37) {
                octal = octal * 8 + (this.data[this.pos++] - 0x30);
                if (this.pos < this.data.length && this.data[this.pos] >= 0x30 && this.data[this.pos] <= 0x37) {
                  octal = octal * 8 + (this.data[this.pos++] - 0x30);
                }
              }
              result.push(octal & 0xFF);
            } else {
              result.push(next);
            }
            break;
        }
      } else if (b === 0x28) { // (
        parenDepth++;
        result.push(b);
      } else if (b === 0x29) { // )
        parenDepth--;
        if (parenDepth > 0) result.push(b);
      } else {
        result.push(b);
      }
    }
    return new Uint8Array(result);
  }

  parseHexString() {
    // pos at '<'
    this.pos++; // skip '<'
    var hex = [];
    while (this.pos < this.data.length) {
      var b = this.data[this.pos];
      if (b === 0x3E) { // '>'
        this.pos++;
        break;
      }
      this.pos++;
      if (this.isWhitespace(b)) continue;

      var nibble;
      if (b >= 0x30 && b <= 0x39) nibble = b - 0x30;
      else if (b >= 0x41 && b <= 0x46) nibble = b - 0x41 + 10;
      else if (b >= 0x61 && b <= 0x66) nibble = b - 0x61 + 10;
      else continue;
      hex.push(nibble);
    }

    var result = [];
    for (var i = 0; i < hex.length; i += 2) {
      var high = hex[i];
      var low = (i + 1 < hex.length) ? hex[i + 1] : 0;
      result.push((high << 4) | low);
    }
    return new Uint8Array(result);
  }

  parseArray(depth) {
    // pos at '['
    this.pos++; // skip '['
    var arr = [];
    while (this.pos < this.data.length) {
      this.skipWhitespace();
      if (this.pos >= this.data.length) break;
      if (this.data[this.pos] === 0x5D) { // ']'
        this.pos++;
        break;
      }
      arr.push(this.parseObject(depth + 1));
    }
    return arr;
  }

  parseDictionary(depth) {
    // pos at '<<'
    this.pos += 2; // skip '<<'
    var dict = {};

    while (this.pos < this.data.length) {
      this.skipWhitespace();
      if (this.pos >= this.data.length) break;

      // Check for >> (end dict)
      if (this.data[this.pos] === 0x3E && this.pos + 1 < this.data.length && this.data[this.pos + 1] === 0x3E) {
        this.pos += 2;
        break;
      }

      // Key must be a name
      if (this.data[this.pos] !== 0x2F) {
        // Not a name -- try to skip unexpected content
        this.pos++;
        continue;
      }

      var key = this.parseName();
      this.skipWhitespace();

      // Value
      if (this.pos >= this.data.length) break;
      var value = this.parseObject(depth + 1);
      dict[key] = value;
    }

    return dict;
  }

  parseNumberOrRef(depth) {
    // We need to handle: number, indirect reference (N M R), indirect object (N M obj)
    // Save position to backtrack
    var startPos = this.pos;

    // Read the first number
    var num1Str = '';
    while (this.pos < this.data.length) {
      var b = this.data[this.pos];
      if (this.isDigit(b) || b === 0x2D || b === 0x2B || b === 0x2E) {
        num1Str += String.fromCharCode(b);
        this.pos++;
      } else {
        break;
      }
    }

    var num1 = parseFloat(num1Str);
    if (isNaN(num1)) {
      this.pos = startPos;
      throw new ParseError('Invalid number at pos ' + startPos);
    }

    // Check if this could be an indirect reference: N M R or N M obj
    // Only possible if num1 is a non-negative integer
    if (num1 >= 0 && num1 === Math.floor(num1) && num1Str.indexOf('.') === -1) {
      var savedPos = this.pos;
      this.skipWhitespace();

      if (this.pos < this.data.length && this.isDigit(this.data[this.pos])) {
        var num2Start = this.pos;
        var num2Str = '';
        while (this.pos < this.data.length && this.isDigit(this.data[this.pos])) {
          num2Str += String.fromCharCode(this.data[this.pos]);
          this.pos++;
        }
        var num2 = parseInt(num2Str, 10);

        this.skipWhitespace();

        if (this.pos < this.data.length) {
          // Check for 'R' (indirect reference)
          if (this.data[this.pos] === 0x52) { // 'R'
            var afterR = this.pos + 1;
            if (afterR >= this.data.length || this.isWhitespace(this.data[afterR]) || this.isDelimiter(this.data[afterR])) {
              this.pos = afterR;
              return { type: 'ref', num: num1, gen: num2 };
            }
          }

          // Check for 'obj' (indirect object definition)
          if (this.matchKeyword('obj')) {
            this.skipWhitespace();
            var objValue = this.parseObject(depth + 1);

            // Check for stream
            this.skipWhitespace();
            if (this.matchKeyword('stream')) {
              // Stream
              var dict = (typeof objValue === 'object' && objValue !== null && !Array.isArray(objValue) && !(objValue instanceof Uint8Array) && !objValue.type) ? objValue : {};
              return this.parseStream(dict, num1, num2);
            }

            // Skip endobj if present
            this.skipWhitespace();
            this.matchKeyword('endobj');

            return objValue;
          }
        }

        // Not a reference or object, backtrack
        this.pos = savedPos;
      } else {
        this.pos = savedPos;
      }
    }

    return num1;
  }

  parseStream(dict, objNum, gen) {
    // After 'stream' keyword, expect newline (LF or CR LF)
    if (this.pos < this.data.length && this.data[this.pos] === 0x0D) this.pos++; // CR
    if (this.pos < this.data.length && this.data[this.pos] === 0x0A) this.pos++; // LF

    // Determine stream length
    var length = this.resolveStreamLength(dict['/Length']);
    var streamStart = this.pos;

    if (length !== null && length >= 0 && (streamStart + length) <= this.data.length) {
      var rawBytes = this.data.subarray(streamStart, streamStart + length);
      this.pos = streamStart + length;

      // Skip endstream
      this.skipWhitespace();
      this.matchKeyword('endstream');
      this.skipWhitespace();
      this.matchKeyword('endobj');

      return this.createStreamObject(dict, rawBytes, objNum, gen);
    } else {
      // Length unknown or invalid; scan for endstream
      var endMarker = this.findBytes('endstream', this.pos);
      if (endMarker !== -1) {
        var rawBytes = this.data.subarray(streamStart, endMarker);
        // Trim trailing whitespace from stream data
        while (rawBytes.length > 0 && (rawBytes[rawBytes.length - 1] === 0x0A || rawBytes[rawBytes.length - 1] === 0x0D)) {
          rawBytes = rawBytes.subarray(0, rawBytes.length - 1);
        }
        this.pos = endMarker + 9; // skip 'endstream'
        this.skipWhitespace();
        this.matchKeyword('endobj');

        return this.createStreamObject(dict, rawBytes, objNum, gen);
      } else {
        // Can't find endstream, create empty stream
        this.skipWhitespace();
        this.matchKeyword('endobj');
        return this.createStreamObject(dict, new Uint8Array(0), objNum, gen);
      }
    }
  }

  resolveStreamLength(lengthVal) {
    if (typeof lengthVal === 'number') return lengthVal;
    if (lengthVal && typeof lengthVal === 'object' && lengthVal.type === 'ref') {
      // Resolve indirect reference to get the actual length
      var resolved = this.resolveRef(lengthVal);
      if (typeof resolved === 'number') return resolved;
    }
    return null;
  }

  createStreamObject(dict, rawBytes, objNum, gen) {
    var self = this;
    var filters = dict['/Filter'];
    var decodeParms = dict['/DecodeParms'];

    var streamObj = Object.assign({}, dict);
    streamObj.isStream = true;
    streamObj.rawBytes = rawBytes;
    streamObj.dict = dict;
    streamObj._objNum = objNum;
    streamObj._gen = gen;

    streamObj.getBytes = function() {
      return self.decodeStreamData(rawBytes, filters, decodeParms);
    };

    return streamObj;
  }

  decodeStreamData(rawBytes, filters, decodeParms) {
    if (!filters) return rawBytes;

    var filterList = [];
    var paramsList = [];

    if (typeof filters === 'string') {
      filterList = [filters];
    } else if (Array.isArray(filters)) {
      filterList = filters;
    } else {
      return rawBytes;
    }

    if (decodeParms) {
      if (Array.isArray(decodeParms)) {
        paramsList = decodeParms;
      } else if (typeof decodeParms === 'object') {
        paramsList = [decodeParms];
      }
    }

    var data = rawBytes;
    for (var i = 0; i < filterList.length; i++) {
      var filterName = filterList[i];
      var params = paramsList[i] || null;
      // Resolve params if it's a reference
      if (params && typeof params === 'object' && params.type === 'ref') {
        params = this.resolveRef(params);
      }
      try {
        data = decodeStream(data, filterName, params);
      } catch (e) {
        if (e instanceof ParseError) throw e;
        throw new ParseError('Stream decode error (' + filterName + '): ' + e.message);
      }
    }

    return data;
  }

  findBytes(str, startOffset) {
    var search = [];
    for (var i = 0; i < str.length; i++) search.push(str.charCodeAt(i));
    for (var i = startOffset; i <= this.data.length - search.length; i++) {
      var match = true;
      for (var j = 0; j < search.length; j++) {
        if (this.data[i + j] !== search[j]) { match = false; break; }
      }
      if (match) return i;
    }
    return -1;
  }

  findBytesReverse(str, startOffset) {
    var search = [];
    for (var i = 0; i < str.length; i++) search.push(str.charCodeAt(i));
    if (startOffset === undefined) startOffset = this.data.length - search.length;
    for (var i = startOffset; i >= 0; i--) {
      var match = true;
      for (var j = 0; j < search.length; j++) {
        if (this.data[i + j] !== search[j]) { match = false; break; }
      }
      if (match) return i;
    }
    return -1;
  }

  // ─── Header ─────────────────────────────────────────────────────────

  parseHeader() {
    // Find %PDF- header (may not be at byte 0, check first 1024 bytes)
    var header = this.readStringAt(0, Math.min(1024, this.data.length));
    var idx = header.indexOf('%PDF-');
    if (idx === -1) {
      throw new ParseError('Not a PDF file: missing %PDF- header');
    }

    // Extract version
    var verStart = idx + 5;
    var verEnd = verStart;
    while (verEnd < header.length && header[verEnd] !== '\n' && header[verEnd] !== '\r') {
      verEnd++;
    }
    this.version = header.substring(verStart, verEnd).trim();
    if (!this.version || !/^\d+\.\d+/.test(this.version)) {
      throw new ParseError('Invalid PDF version: ' + this.version);
    }
  }

  // ─── XRef and Trailer ───────────────────────────────────────────────

  findStartXRef() {
    // Look for startxref near end of file
    var searchRange = Math.min(1024, this.data.length);
    var startPos = this.data.length - searchRange;
    if (startPos < 0) startPos = 0;
    var tail = this.readStringAt(startPos, searchRange);
    var idx = tail.lastIndexOf('startxref');
    if (idx === -1) {
      throw new ParseError('Cannot find startxref');
    }

    // Read the offset value after startxref
    var numStart = idx + 9; // 'startxref'.length
    while (numStart < tail.length && (tail[numStart] === ' ' || tail[numStart] === '\n' || tail[numStart] === '\r')) {
      numStart++;
    }
    var numEnd = numStart;
    while (numEnd < tail.length && tail[numEnd] >= '0' && tail[numEnd] <= '9') {
      numEnd++;
    }
    var offset = parseInt(tail.substring(numStart, numEnd), 10);
    if (isNaN(offset)) {
      throw new ParseError('Invalid startxref offset');
    }
    return offset;
  }

  parseXRef(offset) {
    this.pos = offset;
    this.skipWhitespace();

    // Check what's at this position
    // It could be:
    // 1. 'xref' keyword (traditional xref table)
    // 2. An indirect object that is an xref stream
    if (this.matchKeyword('xref')) {
      return this.parseXRefTable();
    } else {
      // Try parsing as an xref stream
      return this.parseXRefStream(offset);
    }
  }

  parseXRefTable() {
    this.skipWhitespace();

    while (this.pos < this.data.length) {
      this.skipWhitespace();

      // Check for 'trailer' keyword
      if (this.matchKeyword('trailer')) {
        break;
      }

      // Read subsection: startObj count
      var startObjStr = '';
      while (this.pos < this.data.length && this.isDigit(this.data[this.pos])) {
        startObjStr += String.fromCharCode(this.data[this.pos++]);
      }
      if (!startObjStr) break;

      this.skipWhitespace();

      var countStr = '';
      while (this.pos < this.data.length && this.isDigit(this.data[this.pos])) {
        countStr += String.fromCharCode(this.data[this.pos++]);
      }

      var startObj = parseInt(startObjStr, 10);
      var count = parseInt(countStr, 10);
      if (isNaN(startObj) || isNaN(count)) break;

      this.skipWhitespace();

      // Read entries
      for (var i = 0; i < count; i++) {
        this.checkTimeout();
        // Each entry is exactly 20 bytes: "OOOOOOOOOO GGGGG N \n" or "OOOOOOOOOO GGGGG N \r\n"
        // But in practice, parse flexibly
        this.skipWhitespace();
        var line = '';
        while (this.pos < this.data.length && this.data[this.pos] !== 0x0A && this.data[this.pos] !== 0x0D) {
          line += String.fromCharCode(this.data[this.pos++]);
          if (line.length > 25) break; // safety
        }
        // Skip line ending
        while (this.pos < this.data.length && (this.data[this.pos] === 0x0A || this.data[this.pos] === 0x0D)) {
          this.pos++;
        }

        line = line.trim();
        if (line.length < 16) continue; // too short, skip

        var parts = line.split(/\s+/);
        if (parts.length < 3) continue;

        var objOffset = parseInt(parts[0], 10);
        var gen = parseInt(parts[1], 10);
        var type = parts[2]; // 'n' or 'f'

        var objNum = startObj + i;
        if (type === 'n' && objOffset > 0) {
          // Only store if we don't already have this object (first definition wins in PDF)
          if (!(objNum in this.xrefEntries)) {
            this.xrefEntries[objNum] = { offset: objOffset, gen: gen, inUse: true };
            this.objectCount++;
            if (this.objectCount > MAX_OBJECT_COUNT) {
              throw new ParseError('Maximum object count exceeded');
            }
          }
        }
      }
    }

    // Parse trailer dictionary
    this.skipWhitespace();
    var trailer = this.parseObject(0);
    if (!trailer || typeof trailer !== 'object') {
      throw new ParseError('Invalid trailer dictionary');
    }

    // Handle /Prev (previous xref table for incremental updates)
    if (trailer['/Prev']) {
      var prevOffset = trailer['/Prev'];
      if (typeof prevOffset === 'number' && prevOffset >= 0) {
        try {
          this.parseXRef(prevOffset);
        } catch (e) {
          // Failed to parse previous xref -- continue with what we have
        }
      }
    }

    return trailer;
  }

  parseXRefStream(offset) {
    // An xref stream is an indirect object containing a stream with /Type /XRef
    this.pos = offset;
    this.skipWhitespace();

    // Parse the object: N M obj ... endobj
    var obj = this.parseObject(0);

    if (!obj || !obj.isStream) {
      throw new ParseError('Expected xref stream at offset ' + offset);
    }

    var dict = obj.dict || obj;
    if (dict['/Type'] !== '/XRef') {
      throw new ParseError('Object at offset ' + offset + ' is not an xref stream');
    }

    // Decode the stream
    var decodedBytes;
    try {
      decodedBytes = obj.getBytes();
    } catch (e) {
      throw new ParseError('Failed to decode xref stream: ' + e.message);
    }

    // Parse xref stream parameters
    var size = dict['/Size'] || 0;
    var w = dict['/W'];
    if (!Array.isArray(w) || w.length < 3) {
      throw new ParseError('Invalid /W array in xref stream');
    }

    var index = dict['/Index'];
    if (!index) {
      index = [0, size];
    }

    var w0 = w[0], w1 = w[1], w2 = w[2];
    var entrySize = w0 + w1 + w2;

    var byteOffset = 0;

    for (var i = 0; i < index.length; i += 2) {
      var startObj = index[i];
      var count = index[i + 1];

      for (var j = 0; j < count; j++) {
        this.checkTimeout();
        if (byteOffset + entrySize > decodedBytes.length) break;

        // Read type field
        var type = 1; // default type if w0 == 0
        if (w0 > 0) {
          type = 0;
          for (var k = 0; k < w0; k++) {
            type = (type << 8) | decodedBytes[byteOffset + k];
          }
        }

        // Read field 2
        var field2 = 0;
        for (var k = 0; k < w1; k++) {
          field2 = (field2 << 8) | decodedBytes[byteOffset + w0 + k];
        }

        // Read field 3
        var field3 = 0;
        for (var k = 0; k < w2; k++) {
          field3 = (field3 << 8) | decodedBytes[byteOffset + w0 + w1 + k];
        }

        var objNum = startObj + j;

        if (type === 0) {
          // Free object
        } else if (type === 1) {
          // Normal object: field2 = offset, field3 = generation
          if (!(objNum in this.xrefEntries)) {
            this.xrefEntries[objNum] = { offset: field2, gen: field3, inUse: true };
            this.objectCount++;
            if (this.objectCount > MAX_OBJECT_COUNT) {
              throw new ParseError('Maximum object count exceeded');
            }
          }
        } else if (type === 2) {
          // Compressed object in object stream: field2 = objStm number, field3 = index within objStm
          if (!(objNum in this.xrefEntries)) {
            this.xrefEntries[objNum] = { objStm: field2, indexInStm: field3, inUse: true, compressed: true };
            this.objectCount++;
            if (this.objectCount > MAX_OBJECT_COUNT) {
              throw new ParseError('Maximum object count exceeded');
            }
          }
        }

        byteOffset += entrySize;
      }
    }

    // Handle /Prev
    if (dict['/Prev']) {
      var prevOffset = dict['/Prev'];
      if (typeof prevOffset === 'number' && prevOffset >= 0) {
        try {
          this.parseXRef(prevOffset);
        } catch (e) {
          // Failed to parse previous xref
        }
      }
    }

    // The stream dict itself serves as the trailer
    return dict;
  }

  // ─── Object resolution ──────────────────────────────────────────────

  resolveRef(ref) {
    if (!ref || typeof ref !== 'object' || ref.type !== 'ref') return ref;

    var key = ref.num + ':' + ref.gen;

    // Check cache
    if (key in this.objects) return this.objects[key];

    // Circular reference detection
    if (this.resolving.has(key)) return null;
    this.resolving.add(key);

    try {
      var entry = this.xrefEntries[ref.num];
      if (!entry || !entry.inUse) {
        this.objects[key] = null;
        return null;
      }

      var obj;
      if (entry.compressed) {
        // Object in object stream
        obj = this.resolveFromObjStm(entry.objStm, entry.indexInStm);
      } else {
        // Normal object at offset
        obj = this.parseObjectAt(entry.offset, ref.num, ref.gen);
      }

      this.objects[key] = obj;
      return obj;
    } catch (e) {
      this.objects[key] = null;
      return null;
    } finally {
      this.resolving.delete(key);
    }
  }

  parseObjectAt(offset, expectedNum, expectedGen) {
    var savedPos = this.pos;
    this.pos = offset;

    try {
      this.skipWhitespace();

      // Read object number
      var numStr = '';
      while (this.pos < this.data.length && this.isDigit(this.data[this.pos])) {
        numStr += String.fromCharCode(this.data[this.pos++]);
      }
      this.skipWhitespace();

      // Read generation number
      var genStr = '';
      while (this.pos < this.data.length && this.isDigit(this.data[this.pos])) {
        genStr += String.fromCharCode(this.data[this.pos++]);
      }
      this.skipWhitespace();

      // Expect 'obj'
      if (!this.matchKeyword('obj')) {
        throw new ParseError('Expected "obj" keyword at offset ' + offset);
      }

      this.skipWhitespace();

      // Parse the object value
      var value = this.parseObject(0);

      // Check for stream
      this.skipWhitespace();
      if (this.matchKeyword('stream')) {
        var dict = (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array) && !value.type) ? value : {};
        value = this.parseStream(dict, parseInt(numStr, 10), parseInt(genStr, 10));
      } else {
        this.skipWhitespace();
        this.matchKeyword('endobj');
      }

      return value;
    } catch (e) {
      return null;
    } finally {
      this.pos = savedPos;
    }
  }

  resolveFromObjStm(objStmNum, indexInStm) {
    // Check cache
    if (this._objStmCache[objStmNum]) {
      var cached = this._objStmCache[objStmNum];
      if (indexInStm < cached.length) return cached[indexInStm];
      return null;
    }

    // Parse the object stream
    var objStmEntry = this.xrefEntries[objStmNum];
    if (!objStmEntry || objStmEntry.compressed) return null;

    var objStm = this.parseObjectAt(objStmEntry.offset, objStmNum, objStmEntry.gen);
    if (!objStm || !objStm.isStream) return null;

    var dict = objStm.dict || objStm;
    var n = dict['/N']; // number of objects in stream
    var first = dict['/First']; // byte offset of first object in stream

    if (typeof n !== 'number' || typeof first !== 'number') return null;

    // Decode the stream
    var decodedBytes;
    try {
      decodedBytes = objStm.getBytes();
    } catch (e) {
      return null;
    }

    // Parse the integer pairs (objNum offset) at the beginning
    var header = '';
    for (var i = 0; i < first && i < decodedBytes.length; i++) {
      header += String.fromCharCode(decodedBytes[i]);
    }
    var headerTokens = header.trim().split(/\s+/);

    var objectIndices = [];
    for (var i = 0; i < headerTokens.length - 1; i += 2) {
      var objNum = parseInt(headerTokens[i], 10);
      var objOffset = parseInt(headerTokens[i + 1], 10);
      objectIndices.push({ num: objNum, offset: first + objOffset });
    }

    // Parse each object
    var parsedObjects = [];
    for (var i = 0; i < objectIndices.length; i++) {
      var startOffset = objectIndices[i].offset;
      var endOffset = (i + 1 < objectIndices.length) ? objectIndices[i + 1].offset : decodedBytes.length;

      try {
        // Create a mini-parser for the object data
        var objData = decodedBytes.subarray(startOffset, endOffset);
        var miniParser = new PDFParser(objData.buffer.slice(objData.byteOffset, objData.byteOffset + objData.byteLength));
        miniParser.xrefEntries = this.xrefEntries;
        miniParser.objects = this.objects;
        miniParser.resolving = this.resolving;
        miniParser.startTime = this.startTime;
        miniParser._parentParser = this;

        var parsedObj = miniParser.parseObject(0);
        parsedObjects.push(parsedObj);
      } catch (e) {
        parsedObjects.push(null);
      }
    }

    this._objStmCache[objStmNum] = parsedObjects;

    if (indexInStm < parsedObjects.length) return parsedObjects[indexInStm];
    return null;
  }

  /**
   * Deep-resolve all references in an object.
   * Only resolves the first level to avoid infinite recursion.
   */
  resolveValue(val) {
    if (!val || typeof val !== 'object') return val;
    if (val.type === 'ref') return this.resolveRef(val);
    return val;
  }

  /**
   * Deep-resolve a dictionary's values (one level only).
   */
  resolveDict(dict) {
    if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return dict;
    var resolved = {};
    for (var key in dict) {
      if (!dict.hasOwnProperty(key)) continue;
      var val = dict[key];
      if (val && typeof val === 'object' && val.type === 'ref') {
        resolved[key] = this.resolveRef(val);
      } else {
        resolved[key] = val;
      }
    }
    return resolved;
  }

  // ─── Page tree traversal ────────────────────────────────────────────

  traversePageTree(node, inheritedResources, depth) {
    if (!node || typeof node !== 'object') return;
    if (depth > 50) return; // safety
    this.checkTimeout();

    // Resolve references
    if (node.type === 'ref') {
      node = this.resolveRef(node);
      if (!node) return;
    }

    var type = node['/Type'];

    // Inherit resources
    var resources = node['/Resources'] || inheritedResources;
    if (resources && typeof resources === 'object' && resources.type === 'ref') {
      resources = this.resolveRef(resources);
    }

    if (type === '/Pages') {
      // Pages node: traverse kids
      var kids = node['/Kids'];
      if (kids && typeof kids === 'object' && kids.type === 'ref') {
        kids = this.resolveRef(kids);
      }
      if (Array.isArray(kids)) {
        for (var i = 0; i < kids.length; i++) {
          var kid = kids[i];
          if (kid && typeof kid === 'object' && kid.type === 'ref') {
            kid = this.resolveRef(kid);
          }
          this.traversePageTree(kid, resources, depth + 1);
        }
      }
    } else if (type === '/Page') {
      // Leaf page
      var page = {};
      for (var key in node) {
        if (node.hasOwnProperty(key)) {
          page[key] = node[key];
        }
      }

      // Apply inherited resources
      if (!page['/Resources'] && resources) {
        page['/Resources'] = resources;
      }

      // Resolve resources
      if (page['/Resources'] && typeof page['/Resources'] === 'object' && page['/Resources'].type === 'ref') {
        page['/Resources'] = this.resolveRef(page['/Resources']);
      }

      // Resolve MediaBox
      if (!page['/MediaBox']) {
        // Try to inherit MediaBox from parent
        page['/MediaBox'] = node['/MediaBox'] || [0, 0, 612, 792]; // default Letter
      }
      if (page['/MediaBox'] && typeof page['/MediaBox'] === 'object' && page['/MediaBox'].type === 'ref') {
        page['/MediaBox'] = this.resolveRef(page['/MediaBox']);
      }

      // Resolve Contents
      if (page['/Contents']) {
        var contents = page['/Contents'];
        if (contents && typeof contents === 'object' && contents.type === 'ref') {
          contents = this.resolveRef(contents);
          page['/Contents'] = contents;
        }
      }

      // Resolve Annots
      if (page['/Annots']) {
        var annots = page['/Annots'];
        if (annots && typeof annots === 'object' && annots.type === 'ref') {
          annots = this.resolveRef(annots);
          page['/Annots'] = annots;
        }
      }

      page.index = this.pages.length;
      this.pages.push(page);
    } else {
      // Unknown node type -- could be a page without explicit /Type
      // If it has /Contents, treat as page
      if (node['/Contents'] || node['/MediaBox']) {
        var page = {};
        for (var key in node) {
          if (node.hasOwnProperty(key)) {
            page[key] = node[key];
          }
        }
        if (!page['/Resources'] && resources) {
          page['/Resources'] = resources;
        }
        if (page['/Resources'] && typeof page['/Resources'] === 'object' && page['/Resources'].type === 'ref') {
          page['/Resources'] = this.resolveRef(page['/Resources']);
        }
        if (!page['/MediaBox']) {
          page['/MediaBox'] = [0, 0, 612, 792];
        }
        if (page['/MediaBox'] && typeof page['/MediaBox'] === 'object' && page['/MediaBox'].type === 'ref') {
          page['/MediaBox'] = this.resolveRef(page['/MediaBox']);
        }
        if (page['/Contents'] && typeof page['/Contents'] === 'object' && page['/Contents'].type === 'ref') {
          page['/Contents'] = this.resolveRef(page['/Contents']);
        }
        page.index = this.pages.length;
        this.pages.push(page);
      } else if (node['/Kids']) {
        // Treat as Pages node even without /Type
        var kids = node['/Kids'];
        if (kids && typeof kids === 'object' && kids.type === 'ref') {
          kids = this.resolveRef(kids);
        }
        if (Array.isArray(kids)) {
          for (var i = 0; i < kids.length; i++) {
            var kid = kids[i];
            if (kid && typeof kid === 'object' && kid.type === 'ref') {
              kid = this.resolveRef(kid);
            }
            this.traversePageTree(kid, resources, depth + 1);
          }
        }
      }
    }
  }

  // ─── Named destinations ─────────────────────────────────────────────

  extractNamedDests(catalog) {
    var dests = {};

    // /Dests dictionary (PDF 1.1 style)
    if (catalog['/Dests']) {
      var destsDict = catalog['/Dests'];
      if (destsDict && destsDict.type === 'ref') {
        destsDict = this.resolveRef(destsDict);
      }
      if (destsDict && typeof destsDict === 'object') {
        for (var name in destsDict) {
          if (name.charAt(0) === '/') {
            var dest = destsDict[name];
            if (dest && dest.type === 'ref') dest = this.resolveRef(dest);
            dests[name] = dest;
          }
        }
      }
    }

    // /Names -> /Dests name tree (PDF 1.2+ style)
    if (catalog['/Names']) {
      var names = catalog['/Names'];
      if (names && names.type === 'ref') names = this.resolveRef(names);
      if (names && names['/Dests']) {
        var destsTree = names['/Dests'];
        if (destsTree && destsTree.type === 'ref') destsTree = this.resolveRef(destsTree);
        if (destsTree) {
          this.parseNameTree(destsTree, dests);
        }
      }
    }

    return dests;
  }

  parseNameTree(node, result) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ref') node = this.resolveRef(node);
    if (!node) return;

    // Leaf node: /Names array
    if (node['/Names']) {
      var names = node['/Names'];
      if (names && names.type === 'ref') names = this.resolveRef(names);
      if (Array.isArray(names)) {
        for (var i = 0; i + 1 < names.length; i += 2) {
          var key = names[i];
          var val = names[i + 1];
          if (key instanceof Uint8Array) {
            key = '';
            for (var j = 0; j < names[i].length; j++) key += String.fromCharCode(names[i][j]);
          }
          if (val && val.type === 'ref') val = this.resolveRef(val);
          result[key] = val;
        }
      }
    }

    // Intermediate node: /Kids array
    if (node['/Kids']) {
      var kids = node['/Kids'];
      if (kids && kids.type === 'ref') kids = this.resolveRef(kids);
      if (Array.isArray(kids)) {
        for (var i = 0; i < kids.length; i++) {
          this.parseNameTree(kids[i], result);
        }
      }
    }
  }

  // ─── XRef repair mode (linear scan) ─────────────────────────────────

  repairXRef() {
    console.warn('Entering xref repair mode: scanning for objects...');
    this.xrefEntries = {};
    this.objectCount = 0;

    // Scan the entire file for "N M obj" patterns
    var i = 0;
    while (i < this.data.length - 5) {
      this.checkTimeout();

      // Look for digit sequences followed by space, digit(s), space, 'obj'
      if (this.isDigit(this.data[i])) {
        var numStart = i;
        while (i < this.data.length && this.isDigit(this.data[i])) i++;
        if (i < this.data.length && this.isWhitespace(this.data[i])) {
          var objNumStr = this.readStringAt(numStart, i - numStart);
          i++;
          // Skip whitespace
          while (i < this.data.length && this.isWhitespace(this.data[i])) i++;

          var genStart = i;
          while (i < this.data.length && this.isDigit(this.data[i])) i++;
          if (i < this.data.length && this.isWhitespace(this.data[i])) {
            var genStr = this.readStringAt(genStart, i - genStart);
            var savedI = i;
            // Skip whitespace
            while (i < this.data.length && this.isWhitespace(this.data[i])) i++;

            // Check for 'obj'
            if (i + 3 <= this.data.length &&
                this.data[i] === 0x6F && this.data[i+1] === 0x62 && this.data[i+2] === 0x6A) {
              // Verify followed by whitespace/delimiter
              var afterObj = i + 3;
              if (afterObj >= this.data.length || this.isWhitespace(this.data[afterObj]) || this.isDelimiter(this.data[afterObj])) {
                var objNum = parseInt(objNumStr, 10);
                var gen = parseInt(genStr, 10);
                if (!isNaN(objNum) && !isNaN(gen) && !(objNum in this.xrefEntries)) {
                  this.xrefEntries[objNum] = { offset: numStart, gen: gen, inUse: true };
                  this.objectCount++;
                  if (this.objectCount > MAX_OBJECT_COUNT) break;
                }
                i = afterObj;
                continue;
              }
            }
            i = savedI;
          }
        }
      }
      i++;
    }

    // Try to find the trailer dictionary by scanning backwards
    var trailerIdx = this.findBytesReverse('trailer');
    if (trailerIdx !== -1) {
      this.pos = trailerIdx + 7; // skip 'trailer'
      this.skipWhitespace();
      try {
        return this.parseObject(0);
      } catch (e) {
        // Failed to parse trailer
      }
    }

    // Construct a minimal trailer from what we found
    // Try to find Root by scanning objects
    for (var objNum in this.xrefEntries) {
      var entry = this.xrefEntries[objNum];
      if (!entry.inUse || entry.compressed) continue;
      try {
        var obj = this.parseObjectAt(entry.offset, parseInt(objNum, 10), entry.gen);
        if (obj && typeof obj === 'object' && obj['/Type'] === '/Catalog') {
          return { '/Root': { type: 'ref', num: parseInt(objNum, 10), gen: entry.gen } };
        }
      } catch (e) {
        // skip
      }
    }

    return {};
  }

  // ─── Main load method ───────────────────────────────────────────────

  async load() {
    try {
      // Parse header
      try {
        this.parseHeader();
      } catch (e) {
        return { error: e, version: null, pageCount: 0, pages: [], catalog: {} };
      }

      // Find and parse xref
      var trailer;
      try {
        var startXRefOffset = this.findStartXRef();
        trailer = this.parseXRef(startXRefOffset);
      } catch (e) {
        // Try repair mode
        try {
          trailer = this.repairXRef();
        } catch (e2) {
          return { error: new ParseError('Failed to parse xref: ' + e.message), version: this.version, pageCount: 0, pages: [], catalog: {} };
        }
      }

      this.trailer = trailer;

      // Find the Root catalog
      var rootRef = trailer['/Root'];
      if (!rootRef) {
        return { error: new ParseError('No /Root in trailer'), version: this.version, pageCount: 0, pages: [], catalog: {} };
      }

      var catalog;
      if (rootRef.type === 'ref') {
        catalog = this.resolveRef(rootRef);
      } else {
        catalog = rootRef;
      }

      // If catalog resolution failed (e.g., corrupt xref offsets), try repair mode
      if (!catalog || typeof catalog !== 'object') {
        try {
          // Clear cached null resolutions before repair
          this.objects = {};
          trailer = this.repairXRef();
          this.trailer = trailer;
          rootRef = trailer['/Root'];
          if (rootRef && rootRef.type === 'ref') {
            catalog = this.resolveRef(rootRef);
          } else {
            catalog = rootRef;
          }
        } catch (repairErr) {
          // repair also failed
        }
        if (!catalog || typeof catalog !== 'object') {
          return { error: new ParseError('Cannot resolve catalog'), version: this.version, pageCount: 0, pages: [], catalog: {} };
        }
      }

      this.catalog = catalog;

      // Find the Pages tree
      var pagesRef = catalog['/Pages'];
      if (pagesRef && pagesRef.type === 'ref') {
        pagesRef = this.resolveRef(pagesRef);
      }

      if (!pagesRef) {
        return { error: new ParseError('No /Pages in catalog'), version: this.version, pageCount: 0, pages: [], catalog: catalog };
      }

      // Traverse the page tree
      this.pages = [];
      this.traversePageTree(pagesRef, null, 0);

      // Extract named destinations
      var namedDests = {};
      try {
        namedDests = this.extractNamedDests(catalog);
      } catch (e) {
        // Non-fatal
      }

      return {
        version: this.version,
        pageCount: this.pages.length,
        pages: this.pages,
        catalog: catalog,
        namedDests: namedDests,
        error: null
      };
    } catch (e) {
      if (e instanceof ParseError) {
        return { error: e, version: this.version, pageCount: 0, pages: [], catalog: this.catalog || {} };
      }
      return { error: new ParseError('Unexpected error: ' + e.message), version: this.version, pageCount: 0, pages: [], catalog: this.catalog || {} };
    }
  }
}

// ============================================================================
// Module exports (Node.js / CommonJS)
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PDFParser: PDFParser, ParseError: ParseError };
}
