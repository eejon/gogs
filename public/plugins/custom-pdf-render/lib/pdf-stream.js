/**
 * PDF Stream Decoders
 *
 * Implements FlateDecode (zlib/deflate), ASCIIHexDecode, and ASCII85Decode
 * for decoding PDF stream data. All implementations are self-contained
 * with no external dependencies.
 *
 * Security: Enforces maximum decompressed size limits to prevent zip bombs.
 */

'use strict';

// ============================================================================
// Constants
// ============================================================================

var PDFStreamConstants = {
  MAX_DECOMPRESSED_SIZE: 100 * 1024 * 1024, // 100 MB
  MAX_INFLATE_RATIO: 1000, // Max decompression ratio (output/input)
  ZLIB_HEADER_SIZE: 2,
  ZLIB_CHECKSUM_SIZE: 4
};

// ============================================================================
// ASCIIHexDecode
// ============================================================================

/**
 * Decode an ASCIIHex-encoded stream.
 * Hex pairs are converted to bytes. '>' marks end of data (EOD).
 * Whitespace is ignored. An odd trailing nibble gets a zero appended.
 *
 * @param {Uint8Array} data - The encoded data
 * @returns {Uint8Array} Decoded bytes
 */
function asciiHexDecode(data) {
  var output = [];
  var pending = -1;

  for (var i = 0; i < data.length; i++) {
    var ch = data[i];

    // '>' is EOD marker
    if (ch === 0x3E) {
      break;
    }

    // Skip whitespace (space, tab, CR, LF, FF)
    if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D || ch === 0x0C) {
      continue;
    }

    var nibble;
    if (ch >= 0x30 && ch <= 0x39) {
      nibble = ch - 0x30; // '0'-'9'
    } else if (ch >= 0x41 && ch <= 0x46) {
      nibble = ch - 0x41 + 10; // 'A'-'F'
    } else if (ch >= 0x61 && ch <= 0x66) {
      nibble = ch - 0x61 + 10; // 'a'-'f'
    } else {
      // Invalid character - skip per PDF spec tolerance
      continue;
    }

    if (pending < 0) {
      pending = nibble;
    } else {
      output.push((pending << 4) | nibble);
      pending = -1;
    }
  }

  // If odd number of hex digits, append 0 to the last nibble
  if (pending >= 0) {
    output.push(pending << 4);
  }

  return new Uint8Array(output);
}

// ============================================================================
// ASCII85Decode
// ============================================================================

/**
 * Decode an ASCII85 (Base85) encoded stream.
 * Uses the Adobe encoding: groups of 5 ASCII chars -> 4 bytes.
 * 'z' is shorthand for 4 zero bytes. '~>' marks end of data.
 *
 * @param {Uint8Array} data - The encoded data
 * @returns {Uint8Array} Decoded bytes
 */
function ascii85Decode(data) {
  var output = [];
  var group = [];
  var i = 0;

  while (i < data.length) {
    var ch = data[i++];

    // Check for EOD marker '~>'
    if (ch === 0x7E) { // '~'
      if (i < data.length && data[i] === 0x3E) { // '>'
        break;
      }
      // lone '~' is technically invalid but continue
      continue;
    }

    // Skip whitespace
    if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D || ch === 0x0C) {
      continue;
    }

    // 'z' shorthand for four zero bytes
    if (ch === 0x7A) { // 'z'
      if (group.length !== 0) {
        throw new PDFStreamError('Invalid z in middle of ASCII85 group');
      }
      output.push(0, 0, 0, 0);
      continue;
    }

    // Valid base-85 chars are '!' (33) through 'u' (117)
    if (ch < 0x21 || ch > 0x75) {
      // Invalid character - skip
      continue;
    }

    group.push(ch - 0x21);

    if (group.length === 5) {
      // Decode 5 chars to 4 bytes
      var val = 0;
      for (var j = 0; j < 5; j++) {
        val = val * 85 + group[j];
      }
      // val is a 32-bit unsigned integer
      output.push((val >>> 24) & 0xFF);
      output.push((val >>> 16) & 0xFF);
      output.push((val >>> 8) & 0xFF);
      output.push(val & 0xFF);
      group = [];
    }
  }

  // Handle final partial group (2-4 chars)
  if (group.length > 1) {
    // Pad with 'u' (84) to make 5 chars
    var padded = group.slice();
    while (padded.length < 5) {
      padded.push(84);
    }
    var val2 = 0;
    for (var k = 0; k < 5; k++) {
      val2 = val2 * 85 + padded[k];
    }
    var numBytes = group.length - 1;
    for (var m = 0; m < numBytes; m++) {
      output.push((val2 >>> (24 - m * 8)) & 0xFF);
    }
  }

  return new Uint8Array(output);
}

// ============================================================================
// FlateDecode (Inflate / Zlib decompression)
// ============================================================================

/**
 * Pure JavaScript inflate implementation (RFC 1951).
 * Handles raw deflate, zlib-wrapped (RFC 1950), and gzip-wrapped data.
 *
 * This is a self-contained implementation with no external dependencies.
 */

// Fixed Huffman code lengths for literal/length alphabet (0-287)
var FIXED_LITERAL_LENGTHS = (function() {
  var lengths = new Uint8Array(288);
  var i;
  for (i = 0; i <= 143; i++) lengths[i] = 8;
  for (i = 144; i <= 255; i++) lengths[i] = 9;
  for (i = 256; i <= 279; i++) lengths[i] = 7;
  for (i = 280; i <= 287; i++) lengths[i] = 8;
  return lengths;
})();

// Fixed Huffman code lengths for distance alphabet (0-31)
var FIXED_DISTANCE_LENGTHS = (function() {
  var lengths = new Uint8Array(32);
  for (var i = 0; i < 32; i++) lengths[i] = 5;
  return lengths;
})();

// Length base values and extra bits for codes 257-285
var LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13,
  15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
  67, 83, 99, 115, 131, 163, 195, 227, 258
];

var LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1,
  1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0
];

// Distance base values and extra bits for codes 0-29
var DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25,
  33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
];

var DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3,
  4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13
];

// Order of code length code lengths (used in dynamic Huffman)
var CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
];

/**
 * Error class for stream decoding errors.
 */
function PDFStreamError(message) {
  this.name = 'PDFStreamError';
  this.message = message;
}
PDFStreamError.prototype = Object.create(Error.prototype);
PDFStreamError.prototype.constructor = PDFStreamError;

/**
 * Bit reader for deflate streams.
 */
function BitReader(data, offset) {
  this.data = data;
  this.pos = offset || 0;
  this.bitBuf = 0;
  this.bitCount = 0;
}

BitReader.prototype.readBits = function(n) {
  while (this.bitCount < n) {
    if (this.pos >= this.data.length) {
      throw new PDFStreamError('Unexpected end of deflate stream');
    }
    this.bitBuf |= this.data[this.pos++] << this.bitCount;
    this.bitCount += 8;
  }
  var val = this.bitBuf & ((1 << n) - 1);
  this.bitBuf >>>= n;
  this.bitCount -= n;
  return val;
};

BitReader.prototype.alignToByte = function() {
  var discard = this.bitCount & 7;
  if (discard > 0) {
    this.bitBuf >>>= discard;
    this.bitCount -= discard;
  }
};

/**
 * Build a Huffman decoding table from an array of code lengths.
 *
 * Returns an object with:
 *   - table: lookup table (direct for short codes)
 *   - maxBits: max code length
 */
function buildHuffmanTable(codeLengths) {
  var maxLen = 0;
  var i;
  for (i = 0; i < codeLengths.length; i++) {
    if (codeLengths[i] > maxLen) maxLen = codeLengths[i];
  }
  if (maxLen === 0) {
    return { table: [], maxBits: 0 };
  }

  // Count codes of each length
  var blCount = new Uint16Array(maxLen + 1);
  for (i = 0; i < codeLengths.length; i++) {
    if (codeLengths[i] > 0) {
      blCount[codeLengths[i]]++;
    }
  }

  // Find the value of the smallest code for each code length
  var nextCode = new Uint16Array(maxLen + 1);
  var code = 0;
  for (i = 1; i <= maxLen; i++) {
    code = (code + blCount[i - 1]) << 1;
    nextCode[i] = code;
  }

  // Build symbol -> code mapping (we need reverse: code -> symbol)
  // Use a lookup table indexed by reversed bit pattern
  var tableBits = Math.min(maxLen, 9); // Use up to 9 bits for first-level table
  var tableSize = 1 << tableBits;
  var table = new Int32Array(tableSize);
  // Initialize with -1 (invalid)
  for (i = 0; i < tableSize; i++) {
    table[i] = -1;
  }

  // For each symbol, compute its code and fill the table
  for (i = 0; i < codeLengths.length; i++) {
    var len = codeLengths[i];
    if (len === 0) continue;

    code = nextCode[len]++;

    // Reverse the bits of the code
    var reversed = 0;
    for (var j = 0; j < len; j++) {
      reversed = (reversed << 1) | (code & 1);
      code >>>= 1;
    }

    if (len <= tableBits) {
      // Fill all table entries that share this prefix
      var fillCount = 1 << (tableBits - len);
      for (var k = 0; k < fillCount; k++) {
        var idx = reversed | (k << len);
        // Encode: symbol in lower 16 bits, length in upper 16 bits
        table[idx] = (len << 16) | i;
      }
    } else {
      // For codes longer than tableBits, we use a simple approach:
      // Store the symbol with its full length. During decoding we may
      // need to do a linear search for long codes, but this is rare.
      // Actually, let's handle this properly with a secondary table approach.
      // For simplicity and correctness, store long codes too:
      var partialReversed = reversed & ((1 << tableBits) - 1);
      if (table[partialReversed] === -1) {
        // Mark this entry as a secondary table pointer
        // We'll use a different approach: just store long codes in an overflow list
        table[partialReversed] = -2; // marker for overflow
      }
    }
  }

  // Build overflow list for codes > tableBits
  var overflow = [];
  for (i = 0; i < codeLengths.length; i++) {
    var len2 = codeLengths[i];
    if (len2 > tableBits) {
      code = nextCode[len2] - 1; // Already incremented above, so subtract
      // Actually we need to recompute. Let's redo this properly.
    }
  }

  // Recompute for overflow
  var nextCode2 = new Uint16Array(maxLen + 1);
  code = 0;
  for (i = 1; i <= maxLen; i++) {
    code = (code + blCount[i - 1]) << 1;
    nextCode2[i] = code;
  }

  var overflowEntries = [];
  for (i = 0; i < codeLengths.length; i++) {
    var len3 = codeLengths[i];
    if (len3 === 0) continue;
    var theCode = nextCode2[len3]++;
    if (len3 > tableBits) {
      // Reverse the code
      var rev = 0;
      var tempCode = theCode;
      for (var b = 0; b < len3; b++) {
        rev = (rev << 1) | (tempCode & 1);
        tempCode >>>= 1;
      }
      overflowEntries.push({ code: rev, len: len3, symbol: i });
    }
  }

  return {
    table: table,
    tableBits: tableBits,
    maxBits: maxLen,
    overflow: overflowEntries
  };
}

/**
 * Decode a symbol using a Huffman table.
 */
function decodeSymbol(reader, huffman) {
  // Peek tableBits bits
  while (reader.bitCount < huffman.maxBits) {
    if (reader.pos >= reader.data.length) {
      // May be ok if we have enough bits already
      if (reader.bitCount < huffman.tableBits) {
        throw new PDFStreamError('Unexpected end of deflate data');
      }
      break;
    }
    reader.bitBuf |= reader.data[reader.pos++] << reader.bitCount;
    reader.bitCount += 8;
  }

  var lookupBits = Math.min(reader.bitCount, huffman.tableBits);
  var idx = reader.bitBuf & ((1 << lookupBits) - 1);
  var entry = huffman.table[idx];

  if (entry >= 0) {
    var len = entry >>> 16;
    var symbol = entry & 0xFFFF;
    reader.bitBuf >>>= len;
    reader.bitCount -= len;
    return symbol;
  }

  // Handle overflow (long codes)
  for (var i = 0; i < huffman.overflow.length; i++) {
    var oe = huffman.overflow[i];
    if (oe.len <= reader.bitCount) {
      var mask = (1 << oe.len) - 1;
      if ((reader.bitBuf & mask) === oe.code) {
        reader.bitBuf >>>= oe.len;
        reader.bitCount -= oe.len;
        return oe.symbol;
      }
    }
  }

  throw new PDFStreamError('Invalid Huffman code in deflate stream');
}

/**
 * Inflate (decompress) raw deflate data.
 *
 * @param {Uint8Array} data - Compressed data (raw deflate, no zlib/gzip wrapper)
 * @param {number} [startOffset=0] - Byte offset to start reading from
 * @param {number} [maxOutputSize] - Maximum allowed output size
 * @returns {Uint8Array} Decompressed data
 */
function inflateRaw(data, startOffset, maxOutputSize) {
  maxOutputSize = maxOutputSize || PDFStreamConstants.MAX_DECOMPRESSED_SIZE;
  var reader = new BitReader(data, startOffset || 0);
  var output = [];
  var outputSize = 0;
  var bfinal;

  do {
    bfinal = reader.readBits(1);
    var btype = reader.readBits(2);

    if (btype === 0) {
      // Stored (uncompressed) block
      reader.alignToByte();
      if (reader.pos + 4 > data.length) {
        throw new PDFStreamError('Invalid stored block in deflate');
      }
      var len = data[reader.pos] | (data[reader.pos + 1] << 8);
      var nlen = data[reader.pos + 2] | (data[reader.pos + 3] << 8);
      reader.pos += 4;
      // Reset bit buffer since we aligned
      reader.bitBuf = 0;
      reader.bitCount = 0;

      if ((len ^ nlen) !== 0xFFFF) {
        throw new PDFStreamError('Invalid stored block lengths in deflate');
      }

      if (reader.pos + len > data.length) {
        throw new PDFStreamError('Stored block extends past end of input');
      }

      outputSize += len;
      if (outputSize > maxOutputSize) {
        throw new PDFStreamError('Decompressed data exceeds size limit (' + maxOutputSize + ' bytes)');
      }

      for (var si = 0; si < len; si++) {
        output.push(data[reader.pos++]);
      }

    } else if (btype === 1 || btype === 2) {
      // Compressed block
      var litLenHuff, distHuff;

      if (btype === 1) {
        // Fixed Huffman codes
        litLenHuff = buildHuffmanTable(FIXED_LITERAL_LENGTHS);
        distHuff = buildHuffmanTable(FIXED_DISTANCE_LENGTHS);
      } else {
        // Dynamic Huffman codes
        var hlit = reader.readBits(5) + 257;
        var hdist = reader.readBits(5) + 1;
        var hclen = reader.readBits(4) + 4;

        // Read code length code lengths
        var clCodeLengths = new Uint8Array(19);
        for (var cli = 0; cli < hclen; cli++) {
          clCodeLengths[CODE_LENGTH_ORDER[cli]] = reader.readBits(3);
        }

        var clHuff = buildHuffmanTable(clCodeLengths);

        // Read literal/length + distance code lengths
        var totalCodes = hlit + hdist;
        var codeLengths = new Uint8Array(totalCodes);
        var ci = 0;

        while (ci < totalCodes) {
          var sym = decodeSymbol(reader, clHuff);

          if (sym < 16) {
            codeLengths[ci++] = sym;
          } else if (sym === 16) {
            // Repeat previous code 3-6 times
            var repeat = reader.readBits(2) + 3;
            var prev = ci > 0 ? codeLengths[ci - 1] : 0;
            for (var ri = 0; ri < repeat && ci < totalCodes; ri++) {
              codeLengths[ci++] = prev;
            }
          } else if (sym === 17) {
            // Repeat 0 for 3-10 times
            var zeros = reader.readBits(3) + 3;
            for (var zi = 0; zi < zeros && ci < totalCodes; zi++) {
              codeLengths[ci++] = 0;
            }
          } else if (sym === 18) {
            // Repeat 0 for 11-138 times
            var moreZeros = reader.readBits(7) + 11;
            for (var mzi = 0; mzi < moreZeros && ci < totalCodes; mzi++) {
              codeLengths[ci++] = 0;
            }
          }
        }

        var litLenLengths = codeLengths.subarray(0, hlit);
        var distLengths = codeLengths.subarray(hlit, totalCodes);

        litLenHuff = buildHuffmanTable(litLenLengths);
        distHuff = buildHuffmanTable(distLengths);
      }

      // Decode symbols
      while (true) {
        var symbol = decodeSymbol(reader, litLenHuff);

        if (symbol < 256) {
          // Literal byte
          outputSize++;
          if (outputSize > maxOutputSize) {
            throw new PDFStreamError('Decompressed data exceeds size limit (' + maxOutputSize + ' bytes)');
          }
          output.push(symbol);
        } else if (symbol === 256) {
          // End of block
          break;
        } else {
          // Length-distance pair
          var lengthCode = symbol - 257;
          if (lengthCode >= LENGTH_BASE.length) {
            throw new PDFStreamError('Invalid length code: ' + symbol);
          }
          var length = LENGTH_BASE[lengthCode];
          if (LENGTH_EXTRA[lengthCode] > 0) {
            length += reader.readBits(LENGTH_EXTRA[lengthCode]);
          }

          var distCode = decodeSymbol(reader, distHuff);
          if (distCode >= DISTANCE_BASE.length) {
            throw new PDFStreamError('Invalid distance code: ' + distCode);
          }
          var distance = DISTANCE_BASE[distCode];
          if (DISTANCE_EXTRA[distCode] > 0) {
            distance += reader.readBits(DISTANCE_EXTRA[distCode]);
          }

          outputSize += length;
          if (outputSize > maxOutputSize) {
            throw new PDFStreamError('Decompressed data exceeds size limit (' + maxOutputSize + ' bytes)');
          }

          // Copy from output buffer
          var copyPos = output.length - distance;
          if (copyPos < 0) {
            throw new PDFStreamError('Invalid distance in deflate: refers before start of output');
          }
          for (var ci2 = 0; ci2 < length; ci2++) {
            output.push(output[copyPos + ci2]);
          }
        }
      }
    } else {
      throw new PDFStreamError('Invalid block type in deflate: ' + btype);
    }
  } while (!bfinal);

  return new Uint8Array(output);
}

/**
 * Decode FlateDecode (zlib) compressed data.
 * Handles both zlib-wrapped and raw deflate data.
 *
 * @param {Uint8Array} data - Compressed data
 * @param {object} [decodeParms] - Decode parameters from the PDF stream dictionary
 * @param {number} [maxOutputSize] - Maximum allowed output size
 * @returns {Uint8Array} Decompressed data
 */
function flateDecode(data, decodeParms, maxOutputSize) {
  if (!data || data.length === 0) {
    return new Uint8Array(0);
  }

  maxOutputSize = maxOutputSize || PDFStreamConstants.MAX_DECOMPRESSED_SIZE;

  // Check compression ratio limit
  var maxAllowed = Math.min(maxOutputSize, data.length * PDFStreamConstants.MAX_INFLATE_RATIO);
  maxAllowed = Math.max(maxAllowed, 1024 * 1024); // at least 1MB
  maxAllowed = Math.min(maxAllowed, maxOutputSize);

  var offset = 0;
  var decompressed;

  // Try to detect zlib header (RFC 1950)
  // First byte: CMF (CM=8 for deflate, CINFO for window size)
  // Second byte: FLG (FCHECK, FDICT, FLEVEL)
  // (CMF * 256 + FLG) % 31 === 0
  if (data.length >= 2) {
    var cmf = data[0];
    var flg = data[1];
    var cm = cmf & 0x0F;
    var isZlib = (cm === 8) && ((cmf * 256 + flg) % 31 === 0);

    if (isZlib) {
      offset = 2;
      // Check for FDICT flag
      if (flg & 0x20) {
        offset += 4; // Skip DICTID
      }
    }
  }

  try {
    decompressed = inflateRaw(data, offset, maxOutputSize);
  } catch (e) {
    // If zlib parse failed, try raw deflate from start
    if (offset > 0) {
      try {
        decompressed = inflateRaw(data, 0, maxOutputSize);
      } catch (e2) {
        throw new PDFStreamError('FlateDecode failed: ' + e.message);
      }
    } else {
      throw new PDFStreamError('FlateDecode failed: ' + e.message);
    }
  }

  // Apply predictor if specified
  if (decodeParms) {
    var predictor = decodeParms.Predictor || 1;
    if (predictor > 1) {
      decompressed = applyPredictor(decompressed, decodeParms);
    }
  }

  return decompressed;
}

// ============================================================================
// PNG Predictor Support
// ============================================================================

/**
 * Apply PNG-style predictors to unfilter data.
 *
 * @param {Uint8Array} data - Raw decompressed data with filter bytes
 * @param {object} params - Decode parameters
 * @returns {Uint8Array} Unfiltered data
 */
function applyPredictor(data, params) {
  var predictor = params.Predictor || 1;

  if (predictor === 1) {
    return data; // No prediction
  }

  if (predictor === 2) {
    // TIFF Predictor 2
    return applyTIFFPredictor(data, params);
  }

  if (predictor >= 10 && predictor <= 15) {
    // PNG predictors
    return applyPNGPredictor(data, params);
  }

  // Unknown predictor, return as-is
  return data;
}

/**
 * Apply TIFF Predictor 2 (horizontal differencing).
 */
function applyTIFFPredictor(data, params) {
  var columns = params.Columns || 1;
  var colors = params.Colors || 1;
  var bpc = params.BitsPerComponent || 8;

  if (bpc !== 8) {
    // For non-8-bit, TIFF predictor is complex; return as-is
    return data;
  }

  var bytesPerPixel = colors;
  var bytesPerRow = columns * bytesPerPixel;
  var rows = Math.floor(data.length / bytesPerRow);
  var output = new Uint8Array(data.length);

  for (var row = 0; row < rows; row++) {
    var rowOffset = row * bytesPerRow;
    for (var col = 0; col < bytesPerRow; col++) {
      var val = data[rowOffset + col];
      if (col >= bytesPerPixel) {
        val = (val + output[rowOffset + col - bytesPerPixel]) & 0xFF;
      }
      output[rowOffset + col] = val;
    }
  }

  // Copy any remaining bytes
  for (var r = rows * bytesPerRow; r < data.length; r++) {
    output[r] = data[r];
  }

  return output;
}

/**
 * Apply PNG predictors (types 10-15).
 * Each row begins with a filter type byte, followed by filtered data.
 */
function applyPNGPredictor(data, params) {
  var columns = params.Columns || 1;
  var colors = params.Colors || 1;
  var bpc = params.BitsPerComponent || 8;

  var bytesPerPixel = Math.max(1, Math.ceil(colors * bpc / 8));
  var bytesPerRow = Math.ceil(columns * colors * bpc / 8);
  var rowStride = bytesPerRow + 1; // +1 for filter type byte

  var rows = Math.floor(data.length / rowStride);
  if (rows === 0) {
    return data;
  }

  var output = new Uint8Array(rows * bytesPerRow);
  var prevRow = new Uint8Array(bytesPerRow); // initialized to 0

  for (var row = 0; row < rows; row++) {
    var srcOffset = row * rowStride;
    var dstOffset = row * bytesPerRow;
    var filterType = data[srcOffset];

    for (var col = 0; col < bytesPerRow; col++) {
      var raw = data[srcOffset + 1 + col];
      var a = col >= bytesPerPixel ? output[dstOffset + col - bytesPerPixel] : 0; // left
      var b = prevRow[col]; // above
      var c = col >= bytesPerPixel ? prevRow[col - bytesPerPixel] : 0; // upper-left

      var result;
      switch (filterType) {
        case 0: // None
          result = raw;
          break;
        case 1: // Sub
          result = (raw + a) & 0xFF;
          break;
        case 2: // Up
          result = (raw + b) & 0xFF;
          break;
        case 3: // Average
          result = (raw + Math.floor((a + b) / 2)) & 0xFF;
          break;
        case 4: // Paeth
          result = (raw + paethPredictor(a, b, c)) & 0xFF;
          break;
        default:
          // Unknown filter type, treat as None
          result = raw;
          break;
      }

      output[dstOffset + col] = result;
    }

    // Current row becomes previous row
    prevRow.set(output.subarray(dstOffset, dstOffset + bytesPerRow));
  }

  return output;
}

/**
 * Paeth predictor function.
 */
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
// RunLengthDecode
// ============================================================================

/**
 * Decode a RunLength-encoded stream.
 * Format: length byte followed by data.
 * - 0-127: copy next (length+1) bytes literally
 * - 129-255: repeat next byte (257-length) times
 * - 128: EOD
 *
 * @param {Uint8Array} data - Encoded data
 * @returns {Uint8Array} Decoded data
 */
function runLengthDecode(data) {
  var output = [];
  var i = 0;

  while (i < data.length) {
    var control = data[i++];

    if (control === 128) {
      // EOD
      break;
    } else if (control < 128) {
      // Copy next (control+1) bytes literally
      var count = control + 1;
      for (var j = 0; j < count && i < data.length; j++) {
        output.push(data[i++]);
      }
    } else {
      // Repeat next byte (257-control) times
      var repeatCount = 257 - control;
      if (i < data.length) {
        var repeatByte = data[i++];
        for (var k = 0; k < repeatCount; k++) {
          output.push(repeatByte);
        }
      }
    }
  }

  return new Uint8Array(output);
}

// ============================================================================
// Decode Pipeline
// ============================================================================

/**
 * Apply a chain of decode filters to stream data.
 *
 * @param {Uint8Array} data - Raw stream data
 * @param {string|string[]} filters - Filter name(s) from the stream dictionary
 * @param {object|object[]} [decodeParms] - Decode parameters for each filter
 * @param {number} [maxOutputSize] - Maximum decompressed size
 * @returns {Uint8Array} Decoded data
 */
function decodeStream(data, filters, decodeParms, maxOutputSize) {
  if (!filters) return data;

  // Normalize to arrays
  var filterList = Array.isArray(filters) ? filters : [filters];
  var parmsList = Array.isArray(decodeParms) ? decodeParms : [decodeParms];

  var result = data;

  for (var i = 0; i < filterList.length; i++) {
    var filter = filterList[i];
    var parms = parmsList[i] || null;

    // Normalize filter name (remove leading '/')
    if (typeof filter === 'string' && filter.charAt(0) === '/') {
      filter = filter.substring(1);
    }

    switch (filter) {
      case 'FlateDecode':
      case 'Fl':
        result = flateDecode(result, parms, maxOutputSize);
        break;
      case 'ASCIIHexDecode':
      case 'AHx':
        result = asciiHexDecode(result);
        break;
      case 'ASCII85Decode':
      case 'A85':
        result = ascii85Decode(result);
        break;
      case 'RunLengthDecode':
      case 'RL':
        result = runLengthDecode(result);
        break;
      case 'LZWDecode':
      case 'LZW':
        throw new PDFStreamError('LZWDecode is not supported');
      case 'DCTDecode':
      case 'DCT':
        // JPEG - pass through, browser will decode
        break;
      case 'JPXDecode':
        // JPEG2000 - pass through
        break;
      case 'CCITTFaxDecode':
      case 'CCF':
        throw new PDFStreamError('CCITTFaxDecode is not supported');
      case 'JBIG2Decode':
        throw new PDFStreamError('JBIG2Decode is not supported');
      case 'Crypt':
        // Encryption - not supported
        throw new PDFStreamError('Encrypted streams are not supported');
      default:
        throw new PDFStreamError('Unknown stream filter: ' + filter);
    }
  }

  return result;
}

// ============================================================================
// Exports (global namespace for non-module usage)
// ============================================================================

if (typeof window !== 'undefined') {
  window.PDFStreamDecoders = {
    decodeStream: decodeStream,
    flateDecode: flateDecode,
    asciiHexDecode: asciiHexDecode,
    ascii85Decode: ascii85Decode,
    runLengthDecode: runLengthDecode,
    inflateRaw: inflateRaw,
    applyPredictor: applyPredictor,
    PDFStreamError: PDFStreamError,
    PDFStreamConstants: PDFStreamConstants
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    decodeStream: decodeStream,
    flateDecode: flateDecode,
    asciiHexDecode: asciiHexDecode,
    ascii85Decode: ascii85Decode,
    runLengthDecode: runLengthDecode,
    inflateRaw: inflateRaw,
    applyPredictor: applyPredictor,
    PDFStreamError: PDFStreamError,
    PDFStreamConstants: PDFStreamConstants
  };
}
