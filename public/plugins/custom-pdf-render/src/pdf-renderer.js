/**
 * pdf-renderer.js -- PDF Content Stream Interpreter and Canvas Renderer
 *
 * Takes parsed page data from the parser (Phase 1) and renders it to an
 * HTML5 Canvas element. Implements:
 *   - Content stream tokenizer (PostScript-like operator streams)
 *   - Graphics state machine (q/Q save/restore stack)
 *   - Text rendering operators (BT/ET, Tf, Td/TD/Tm/T*, Tj/TJ/'/")
 *   - Path construction and painting operators
 *   - Color operators (g/G, rg/RG, k/K, cs/CS, sc/SC/scn/SCN)
 *   - XObject invocation (Do) for images and form XObjects
 *   - Inline images (BI/ID/EI)
 *   - Coordinate transforms (PDF bottom-left -> Canvas top-left)
 *   - Font resolution and text width calculations
 *
 * Depends on: pdf-fonts.js, pdf-images.js
 *
 * No external imports. All code is self-contained.
 */

'use strict';

// ============================================================================
// Load dependencies (Node.js / browser compatible)
// ============================================================================

var PDFFonts, PDFImages;

if (typeof require !== 'undefined') {
  try {
    var path = require('path');
    var fontsPath = path.join(__dirname, 'pdf-fonts.js');
    var imagesPath = path.join(__dirname, 'pdf-images.js');
    PDFFonts = require(fontsPath);
    PDFImages = require(imagesPath);
  } catch (e) {
    // In browser, these are loaded via script tags and available globally
  }
}

// Browser fallback: check for globally defined modules
if (!PDFFonts && typeof window !== 'undefined') {
  PDFFonts = window.PDFFonts;
}
if (!PDFImages && typeof window !== 'undefined') {
  PDFImages = window.PDFImages;
}

// ============================================================================
// Inline Image Block Parser
// ============================================================================

/**
 * Parse a BI ... ID ... EI inline image block from raw content stream bytes.
 *
 * @param {Uint8Array} bytes - content stream bytes
 * @param {number} startPos - position just after "BI" operator
 * @returns {object} { dict, data, nextOffset } or null on failure
 */
function _parseInlineImageBlock(bytes, startPos) {
  if (!bytes || bytes.length === 0) return null;

  var pos = startPos;

  // Skip leading whitespace
  while (pos < bytes.length && isWhitespaceChar(bytes[pos])) pos++;

  // Parse the inline image dictionary key/value pairs until "ID"
  var dict = {};
  while (pos < bytes.length) {
    // Skip whitespace
    while (pos < bytes.length && isWhitespaceChar(bytes[pos])) pos++;
    if (pos >= bytes.length) break;

    // Check for "ID" keyword (marks end of dictionary, start of data)
    if (bytes[pos] === 0x49 /* I */ && pos + 1 < bytes.length && bytes[pos + 1] === 0x44 /* D */) {
      // Verify ID is followed by whitespace (single space or newline)
      if (pos + 2 >= bytes.length || isWhitespaceChar(bytes[pos + 2])) {
        pos += 2; // skip "ID"
        // Skip exactly one whitespace byte after ID
        if (pos < bytes.length && isWhitespaceChar(bytes[pos])) pos++;
        break;
      }
    }

    // Parse a key (name object starting with '/')
    if (bytes[pos] === 0x2F) { // '/'
      var nameStart = pos;
      pos++; // skip '/'
      while (pos < bytes.length && !isWhitespaceChar(bytes[pos]) && !isDelimiterChar(bytes[pos])) {
        pos++;
      }
      var keyName = '/' + bytesToString(bytes, nameStart + 1, pos);

      // Skip whitespace
      while (pos < bytes.length && isWhitespaceChar(bytes[pos])) pos++;

      // Parse the value
      var value = parseInlineValue(bytes, pos);
      if (value !== null) {
        dict[keyName] = value.value;
        pos = value.nextPos;
      }
    } else {
      // Skip unexpected byte
      pos++;
    }
  }

  // Normalize abbreviated inline image key names to full names
  normalizeInlineImageDict(dict);

  // Now find the image data: scan for "\nEI " or "\rEI " or "\r\nEI "
  var dataStart = pos;
  var dataEnd = -1;
  var eiEnd = -1;

  // Scan for EI marker: must be preceded by whitespace and followed by whitespace or EOF
  for (var i = dataStart; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x45 /* E */ && bytes[i + 1] === 0x49 /* I */) {
      // Check for whitespace before EI
      var hasPre = (i === dataStart) || isWhitespaceChar(bytes[i - 1]);
      // Check for whitespace or EOF after EI
      var hasPost = (i + 2 >= bytes.length) || isWhitespaceChar(bytes[i + 2]);
      if (hasPre && hasPost) {
        dataEnd = i;
        // Trim trailing whitespace from data
        while (dataEnd > dataStart && isWhitespaceChar(bytes[dataEnd - 1])) {
          dataEnd--;
        }
        eiEnd = i + 2;
        // Skip whitespace after EI
        while (eiEnd < bytes.length && isWhitespaceChar(bytes[eiEnd])) eiEnd++;
        break;
      }
    }
  }

  if (dataEnd === -1) {
    // EI not found, use rest of stream
    dataEnd = bytes.length;
    eiEnd = bytes.length;
  }

  var data = bytes.slice(dataStart, dataEnd);

  return {
    dict: dict,
    data: data,
    nextOffset: eiEnd,
  };
}

/**
 * Parse a single value from inline image dictionary bytes.
 */
function parseInlineValue(bytes, pos) {
  if (pos >= bytes.length) return null;

  var ch = bytes[pos];

  // Name: /SomeName
  if (ch === 0x2F) {
    var start = pos;
    pos++; // skip '/'
    while (pos < bytes.length && !isWhitespaceChar(bytes[pos]) && !isDelimiterChar(bytes[pos])) {
      pos++;
    }
    return { value: '/' + bytesToString(bytes, start + 1, pos), nextPos: pos };
  }

  // Number
  if (isDigitChar(ch) || ch === 0x2D || ch === 0x2E) {
    var numStr = '';
    while (pos < bytes.length && (isDigitChar(bytes[pos]) || bytes[pos] === 0x2D || bytes[pos] === 0x2E)) {
      numStr += String.fromCharCode(bytes[pos]);
      pos++;
    }
    var num = parseFloat(numStr);
    if (isNaN(num)) num = 0;
    // If it's an integer, return as integer
    if (numStr.indexOf('.') === -1) num = parseInt(numStr, 10);
    return { value: num, nextPos: pos };
  }

  // Boolean: true/false
  if (ch === 0x74 && bytesMatch(bytes, pos, 'true')) {
    return { value: true, nextPos: pos + 4 };
  }
  if (ch === 0x66 && bytesMatch(bytes, pos, 'false')) {
    return { value: false, nextPos: pos + 5 };
  }

  // Array: [...]
  if (ch === 0x5B) {
    pos++; // skip '['
    var arr = [];
    while (pos < bytes.length && bytes[pos] !== 0x5D) {
      while (pos < bytes.length && isWhitespaceChar(bytes[pos])) pos++;
      if (pos >= bytes.length || bytes[pos] === 0x5D) break;
      var elem = parseInlineValue(bytes, pos);
      if (elem) {
        arr.push(elem.value);
        pos = elem.nextPos;
      } else {
        pos++; // skip unparseable byte
      }
    }
    if (pos < bytes.length) pos++; // skip ']'
    return { value: arr, nextPos: pos };
  }

  // Hex string: <...>
  if (ch === 0x3C && (pos + 1 >= bytes.length || bytes[pos + 1] !== 0x3C)) {
    pos++; // skip '<'
    var hexStr = '';
    while (pos < bytes.length && bytes[pos] !== 0x3E) {
      if (!isWhitespaceChar(bytes[pos])) {
        hexStr += String.fromCharCode(bytes[pos]);
      }
      pos++;
    }
    if (pos < bytes.length) pos++; // skip '>'
    // Convert hex to Uint8Array
    if (hexStr.length % 2 !== 0) hexStr += '0';
    var hexBytes = new Uint8Array(hexStr.length / 2);
    for (var i = 0; i < hexBytes.length; i++) {
      hexBytes[i] = parseInt(hexStr.substring(i * 2, i * 2 + 2), 16);
    }
    return { value: hexBytes, nextPos: pos };
  }

  // Skip unexpected character
  return { value: null, nextPos: pos + 1 };
}

/**
 * Normalize abbreviated inline image dictionary keys.
 * PDF spec Table 93.
 */
function normalizeInlineImageDict(dict) {
  var keyMap = {
    '/BPC': '/BitsPerComponent',
    '/CS':  '/ColorSpace',
    '/D':   '/Decode',
    '/DP':  '/DecodeParms',
    '/F':   '/Filter',
    '/H':   '/Height',
    '/IM':  '/ImageMask',
    '/I':   '/Interpolate',
    '/W':   '/Width',
    '/L':   '/Length',
  };
  var filterMap = {
    '/AHx': '/ASCIIHexDecode',
    '/A85': '/ASCII85Decode',
    '/LZW': '/LZWDecode',
    '/Fl':  '/FlateDecode',
    '/RL':  '/RunLengthDecode',
    '/CCF': '/CCITTFaxDecode',
    '/DCT': '/DCTDecode',
  };
  var csMap = {
    '/G':    '/DeviceGray',
    '/RGB':  '/DeviceRGB',
    '/CMYK': '/DeviceCMYK',
    '/I':    '/Indexed',
  };

  for (var abbr in keyMap) {
    if (dict[abbr] !== undefined && dict[keyMap[abbr]] === undefined) {
      dict[keyMap[abbr]] = dict[abbr];
      delete dict[abbr];
    }
  }

  // Normalize filter values
  if (dict['/Filter'] && typeof dict['/Filter'] === 'string') {
    if (filterMap[dict['/Filter']]) dict['/Filter'] = filterMap[dict['/Filter']];
  }

  // Normalize color space values
  if (dict['/ColorSpace'] && typeof dict['/ColorSpace'] === 'string') {
    if (csMap[dict['/ColorSpace']]) dict['/ColorSpace'] = csMap[dict['/ColorSpace']];
  }
}

// ============================================================================
// Content Stream Tokenizer
// ============================================================================

/**
 * Tokenize a PDF content stream into an array of operators with their operands.
 *
 * Returns an array of { op: string, args: array } objects.
 * Inline images are returned as { op: 'BI', type: 'inlineImage', dict: {...}, data: Uint8Array }.
 *
 * @param {Uint8Array} bytes - decoded content stream bytes
 * @returns {Array} array of operator objects
 */
function tokenizeContentStream(bytes) {
  if (!bytes || bytes.length === 0) return [];

  var tokens = [];
  var operands = [];
  var pos = 0;
  var len = bytes.length;

  while (pos < len) {
    // Skip whitespace
    while (pos < len && isWhitespaceChar(bytes[pos])) pos++;
    if (pos >= len) break;

    var ch = bytes[pos];

    // Comment: skip to end of line
    if (ch === 0x25) { // '%'
      while (pos < len && bytes[pos] !== 0x0A && bytes[pos] !== 0x0D) pos++;
      continue;
    }

    // Number (including negative and decimal)
    if (isDigitChar(ch) || ch === 0x2D || ch === 0x2B || ch === 0x2E) {
      var numStart = pos;
      if (ch === 0x2D || ch === 0x2B) pos++;
      var hasDot = (ch === 0x2E);
      if (hasDot) pos++;
      while (pos < len && (isDigitChar(bytes[pos]) || (!hasDot && bytes[pos] === 0x2E))) {
        if (bytes[pos] === 0x2E) hasDot = true;
        pos++;
      }
      var numStr = bytesToString(bytes, numStart, pos);
      var num = hasDot ? parseFloat(numStr) : parseInt(numStr, 10);
      if (isNaN(num)) num = 0;
      operands.push(num);
      continue;
    }

    // Name: /SomeName
    if (ch === 0x2F) { // '/'
      pos++; // skip '/'
      var nameStart = pos;
      while (pos < len && !isWhitespaceChar(bytes[pos]) && !isDelimiterChar(bytes[pos])) {
        pos++;
      }
      operands.push('/' + bytesToString(bytes, nameStart, pos));
      continue;
    }

    // String literal: (...)
    if (ch === 0x28) { // '('
      pos++; // skip '('
      var strBytes = [];
      var parenDepth = 1;
      while (pos < len && parenDepth > 0) {
        var b = bytes[pos];
        if (b === 0x5C) { // backslash escape
          pos++;
          if (pos >= len) break;
          b = bytes[pos];
          switch (b) {
            case 0x6E: strBytes.push(0x0A); break; // \n
            case 0x72: strBytes.push(0x0D); break; // \r
            case 0x74: strBytes.push(0x09); break; // \t
            case 0x62: strBytes.push(0x08); break; // \b
            case 0x66: strBytes.push(0x0C); break; // \f
            case 0x28: strBytes.push(0x28); break; // \(
            case 0x29: strBytes.push(0x29); break; // \)
            case 0x5C: strBytes.push(0x5C); break; // \\
            case 0x0A: break; // line continuation
            case 0x0D:
              // line continuation; skip optional LF
              if (pos + 1 < len && bytes[pos + 1] === 0x0A) pos++;
              break;
            default:
              // Octal escape
              if (b >= 0x30 && b <= 0x37) {
                var oct = b - 0x30;
                if (pos + 1 < len && bytes[pos + 1] >= 0x30 && bytes[pos + 1] <= 0x37) {
                  pos++;
                  oct = oct * 8 + (bytes[pos] - 0x30);
                  if (pos + 1 < len && bytes[pos + 1] >= 0x30 && bytes[pos + 1] <= 0x37) {
                    pos++;
                    oct = oct * 8 + (bytes[pos] - 0x30);
                  }
                }
                strBytes.push(oct & 0xFF);
              } else {
                strBytes.push(b);
              }
          }
        } else if (b === 0x28) { // (
          parenDepth++;
          strBytes.push(b);
        } else if (b === 0x29) { // )
          parenDepth--;
          if (parenDepth > 0) strBytes.push(b);
        } else {
          strBytes.push(b);
        }
        pos++;
      }
      operands.push(new Uint8Array(strBytes));
      continue;
    }

    // Hex string: <...>
    if (ch === 0x3C) { // '<'
      if (pos + 1 < len && bytes[pos + 1] === 0x3C) {
        // Dictionary start "<<" - shouldn't appear in content streams normally
        // but push as marker
        pos += 2;
        operands.push('<<');
        continue;
      }
      pos++; // skip '<'
      var hexStr = '';
      while (pos < len && bytes[pos] !== 0x3E) {
        if (!isWhitespaceChar(bytes[pos])) {
          hexStr += String.fromCharCode(bytes[pos]);
        }
        pos++;
      }
      if (pos < len) pos++; // skip '>'
      // Odd length hex strings get a trailing 0
      if (hexStr.length % 2 !== 0) hexStr += '0';
      var hexBytes = new Uint8Array(hexStr.length / 2);
      for (var hi = 0; hi < hexBytes.length; hi++) {
        hexBytes[hi] = parseInt(hexStr.substring(hi * 2, hi * 2 + 2), 16) || 0;
      }
      operands.push(hexBytes);
      continue;
    }

    // Dictionary end ">>"
    if (ch === 0x3E && pos + 1 < len && bytes[pos + 1] === 0x3E) {
      pos += 2;
      operands.push('>>');
      continue;
    }

    // Array start "["
    if (ch === 0x5B) {
      pos++;
      operands.push('[');
      continue;
    }

    // Array end "]"
    if (ch === 0x5D) {
      pos++;
      // Collect array from operands stack
      var arr = [];
      while (operands.length > 0) {
        var last = operands[operands.length - 1];
        if (last === '[') {
          operands.pop();
          break;
        }
        arr.unshift(operands.pop());
      }
      operands.push(arr);
      continue;
    }

    // Keyword / operator
    if (isAlphaChar(ch) || ch === 0x27 || ch === 0x22) {
      var kwStart = pos;
      while (pos < len && !isWhitespaceChar(bytes[pos]) && !isDelimiterChar(bytes[pos])) {
        pos++;
      }
      var keyword = bytesToString(bytes, kwStart, pos);

      // Check for special keywords that are operands
      if (keyword === 'true') {
        operands.push(true);
        continue;
      }
      if (keyword === 'false') {
        operands.push(false);
        continue;
      }
      if (keyword === 'null') {
        operands.push(null);
        continue;
      }

      // Handle inline image: BI ... ID ... EI
      if (keyword === 'BI') {
        var inlineResult = _parseInlineImageBlock(bytes, pos);
        if (inlineResult) {
          tokens.push({
            op: 'BI',
            type: 'inlineImage',
            dict: inlineResult.dict,
            data: inlineResult.data,
            args: [],
          });
          pos = inlineResult.nextOffset;
          operands = [];
        }
        continue;
      }

      // This is an operator
      tokens.push({
        op: keyword,
        args: operands.slice(),
      });
      operands = [];
      continue;
    }

    // Skip unknown byte
    pos++;
  }

  return tokens;
}

// ============================================================================
// Graphics State
// ============================================================================

/**
 * Create a new default graphics state.
 */
function createDefaultGraphicsState() {
  return {
    // Current Transformation Matrix: [a, b, c, d, e, f]
    ctm: [1, 0, 0, 1, 0, 0],

    // Colors
    fillColor: [0, 0, 0],        // RGB, each 0-1
    strokeColor: [0, 0, 0],      // RGB, each 0-1
    fillColorSpace: 'DeviceGray',
    strokeColorSpace: 'DeviceGray',

    // Line style
    lineWidth: 1,
    lineCap: 0,    // 0=butt, 1=round, 2=square
    lineJoin: 0,   // 0=miter, 1=round, 2=bevel
    miterLimit: 10,
    dashArray: [],
    dashPhase: 0,

    // Text state
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScaling: 100,
    leading: 0,
    fontName: '',
    fontSize: 0,
    textRenderMode: 0,
    textRise: 0,

    // Text matrices
    textMatrix: [1, 0, 0, 1, 0, 0],
    textLineMatrix: [1, 0, 0, 1, 0, 0],

    // Font resolution cache
    fontCSS: 'sans-serif',
    fontBold: false,
    fontItalic: false,
    fontWidthsType: 'none',  // 'none', 'simple', 'cidmap'
    fontWidths: null,
    fontFirstChar: 0,
    fontDefaultWidth: 1000,
    fontEncoding: null,
    fontToUnicode: null,
    fontIsTwoByte: false,

    // Transparency
    fillAlpha: 1,
    strokeAlpha: 1,

    // Clipping
    clipPath: null,

    // Type3 font fields
    isType3: false,
    type3CharProcs: null,
    type3FontMatrix: null,
    type3FontBBox: null,
    type3Resources: null,
  };
}

/**
 * Clone a graphics state (shallow clone of arrays, deep enough for our needs).
 */
function cloneGraphicsState(gs) {
  var newGS = {};
  for (var key in gs) {
    if (!gs.hasOwnProperty(key)) continue;
    var val = gs[key];
    if (Array.isArray(val)) {
      newGS[key] = val.slice();
    } else if (val instanceof Map) {
      newGS[key] = new Map(val);
    } else if (val instanceof Float64Array) {
      newGS[key] = new Float64Array(val);
    } else {
      newGS[key] = val;
    }
  }
  return newGS;
}

// ============================================================================
// Matrix Operations
// ============================================================================

/**
 * Multiply two 3x3 affine matrices represented as [a, b, c, d, e, f].
 *
 * Matrix form:
 *   | a  b  0 |   | a2  b2  0 |
 *   | c  d  0 | x | c2  d2  0 |
 *   | e  f  1 |   | e2  f2  1 |
 *
 * Result: m1 x m2 (m2 applied first, then m1)
 *
 * @param {number[]} m1 - first matrix [a, b, c, d, e, f]
 * @param {number[]} m2 - second matrix
 * @returns {number[]} result matrix
 */
function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/**
 * Transform a point by a matrix.
 * @param {number[]} matrix - [a, b, c, d, e, f]
 * @param {number} x
 * @param {number} y
 * @returns {number[]} [tx, ty]
 */
function transformPoint(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

// ============================================================================
// Glyph Advance Width
// ============================================================================

/**
 * Get the glyph advance width in 1/1000 text units.
 * Uses font widths from the PDF font dictionary if available,
 * falls back to AFM widths for standard fonts.
 *
 * @param {object} gs - graphics state with font info
 * @param {number} byteVal - character code byte value
 * @returns {number} advance width in 1/1000 text units
 */
function _getGlyphAdvance1000(gs, byteVal) {
  // Check PDF-embedded widths first
  if (gs.fontWidthsType === 'simple' && gs.fontWidths) {
    var idx = byteVal - gs.fontFirstChar;
    if (idx >= 0 && idx < gs.fontWidths.length) {
      var w = gs.fontWidths[idx];
      if (typeof w === 'number' && w > 0) return w;
    }
    // Out of range: return default width
    return gs.fontDefaultWidth || 1000;
  }

  if (gs.fontWidthsType === 'cidmap' && gs.fontWidths) {
    var w = gs.fontWidths.get(byteVal);
    if (typeof w === 'number') return w;
    return gs.fontDefaultWidth || 1000;
  }

  // Fallback to AFM widths for standard fonts
  if (PDFFonts && typeof PDFFonts.getCharWidth === 'function') {
    return PDFFonts.getCharWidth(gs.fontName, byteVal);
  }

  return 500; // ultimate fallback
}

// ============================================================================
// Color Helpers
// ============================================================================

/**
 * Convert an array of color components to a CSS color string.
 * @param {number[]} components - color components (0-1 range)
 * @param {string} colorSpace - color space name
 * @returns {string} CSS color string
 */
function colorToCSS(components, colorSpace) {
  if (!components || components.length === 0) return 'rgb(0,0,0)';

  if (colorSpace === 'DeviceGray' || colorSpace === 'CalGray' || components.length === 1) {
    var g = Math.max(0, Math.min(255, Math.round(components[0] * 255)));
    return 'rgb(' + g + ',' + g + ',' + g + ')';
  }

  if (colorSpace === 'DeviceCMYK' || components.length === 4) {
    var rgb = PDFImages ? PDFImages.cmykToRGB(components[0], components[1], components[2], components[3])
              : [0, 0, 0];
    return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
  }

  // Default: RGB
  var r = Math.max(0, Math.min(255, Math.round((components[0] || 0) * 255)));
  var g = Math.max(0, Math.min(255, Math.round((components[1] || 0) * 255)));
  var b = Math.max(0, Math.min(255, Math.round((components[2] || 0) * 255)));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// ============================================================================
// PDFRenderer Class
// ============================================================================

/**
 * PDF page renderer. Takes a parsed page object and renders it to a canvas.
 */
function PDFRenderer() {
  this._parser = null;
  this._ctx = null;
  this._gs = createDefaultGraphicsState();
  this._gsStack = [];
  this._fontCache = {};
  this._formDepth = 0;
  this._activeFormIds = new Set();
  this._maxFormDepth = 10;
  // Base canvas transform (PDF coord -> canvas coord).
  // Stored so text rendering can compose TRM with it.
  this._baseTransform = [1, 0, 0, 1, 0, 0];
}

/**
 * Render a page to a canvas element.
 *
 * @param {HTMLCanvasElement|object} canvas - canvas element (or mock)
 * @param {object} pageData - parsed page object from parser
 * @param {number} scale - rendering scale factor
 * @param {object} parser - PDFParser instance for reference resolution
 * @returns {Promise<void>}
 */
PDFRenderer.prototype.renderPage = async function(canvas, pageData, scale, parser) {
  if (!canvas || !pageData) return;

  this._parser = parser || null;
  scale = scale || 1.0;

  // Get page dimensions from MediaBox
  var mediaBox = pageData['/MediaBox'] || [0, 0, 612, 792];
  if (this._parser && mediaBox && typeof mediaBox === 'object' && mediaBox.type === 'ref') {
    mediaBox = this._parser.resolveRef(mediaBox);
  }
  if (!Array.isArray(mediaBox) || mediaBox.length < 4) {
    mediaBox = [0, 0, 612, 792];
  }

  // Handle CropBox (use it if present, otherwise use MediaBox)
  var cropBox = pageData['/CropBox'];
  if (this._parser && cropBox && typeof cropBox === 'object' && cropBox.type === 'ref') {
    cropBox = this._parser.resolveRef(cropBox);
  }
  if (Array.isArray(cropBox) && cropBox.length >= 4) {
    mediaBox = cropBox;
  }

  var pageX = mediaBox[0] || 0;
  var pageY = mediaBox[1] || 0;
  var pageWidth = (mediaBox[2] || 612) - pageX;
  var pageHeight = (mediaBox[3] || 792) - pageY;

  // Set canvas dimensions
  canvas.width = Math.ceil(pageWidth * scale);
  canvas.height = Math.ceil(pageHeight * scale);

  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  this._ctx = ctx;

  // Reset graphics state
  this._gs = createDefaultGraphicsState();
  this._gsStack = [];
  this._fontCache = {};
  this._formDepth = 0;
  this._activeFormIds = new Set();

  // Set up coordinate transform:
  // 1. Scale by user scale factor
  // 2. Flip Y axis (PDF: origin bottom-left, Canvas: origin top-left)
  // 3. Translate for page origin offset
  this._baseTransform = [scale, 0, 0, -scale, -pageX * scale, pageHeight * scale + pageY * scale];
  ctx.setTransform(scale, 0, 0, -scale, -pageX * scale, pageHeight * scale + pageY * scale);

  // Fill with white background
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  // Restore the PDF coordinate transform after the background fill
  ctx.setTransform(scale, 0, 0, -scale, -pageX * scale, pageHeight * scale + pageY * scale);

  // Get content streams
  var contents = pageData['/Contents'];
  if (!contents) return;

  // Resolve if reference
  if (this._parser && contents && typeof contents === 'object' && contents.type === 'ref') {
    contents = this._parser.resolveRef(contents);
  }

  // Get resources
  var resources = pageData['/Resources'] || {};
  if (this._parser && resources && typeof resources === 'object' && resources.type === 'ref') {
    resources = this._parser.resolveRef(resources);
  }

  // Get decoded content stream bytes
  var streamBytes;
  try {
    if (Array.isArray(contents)) {
      // Multiple content streams: concatenate
      var allBytes = [];
      var totalLen = 0;
      for (var i = 0; i < contents.length; i++) {
        var stream = contents[i];
        if (this._parser && stream && typeof stream === 'object' && stream.type === 'ref') {
          stream = this._parser.resolveRef(stream);
        }
        if (stream && stream.isStream && typeof stream.getBytes === 'function') {
          var decoded = stream.getBytes();
          allBytes.push(decoded);
          totalLen += decoded.length;
          // Add a space separator between streams
          allBytes.push(new Uint8Array([0x20]));
          totalLen += 1;
        }
      }
      streamBytes = new Uint8Array(totalLen);
      var offset = 0;
      for (var i = 0; i < allBytes.length; i++) {
        streamBytes.set(allBytes[i], offset);
        offset += allBytes[i].length;
      }
    } else if (contents && contents.isStream && typeof contents.getBytes === 'function') {
      streamBytes = contents.getBytes();
    } else {
      return; // No usable content stream
    }
  } catch (e) {
    console.warn('Failed to decode content stream:', e.message);
    return;
  }

  if (!streamBytes || streamBytes.length === 0) return;

  // Tokenize and execute
  await this._executeContentStream(streamBytes, resources, ctx);
};

/**
 * Execute a tokenized content stream.
 */
PDFRenderer.prototype._executeContentStream = async function(streamBytes, resources, ctx) {
  var tokens;
  try {
    tokens = tokenizeContentStream(streamBytes);
  } catch (e) {
    console.warn('Tokenization error:', e.message);
    return;
  }

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    try {
      await this._executeOperator(token, resources, ctx);
    } catch (e) {
      // Skip operator on error, don't crash
      console.warn('Operator error (' + token.op + '):', e.message);
    }
  }
};

/**
 * Execute a single operator.
 */
PDFRenderer.prototype._executeOperator = async function(token, resources, ctx) {
  var op = token.op;
  var args = token.args;
  var gs = this._gs;

  switch (op) {
    // ─── Graphics State ────────────────────────────────────────────
    case 'q':
      this._gsStack.push(cloneGraphicsState(gs));
      ctx.save();
      break;

    case 'Q':
      if (this._gsStack.length > 0) {
        this._gs = this._gsStack.pop();
        gs = this._gs;
      }
      ctx.restore();
      // After restore, resync the canvas transform with the restored CTM
      {
        var restoredTransform = multiplyMatrix(gs.ctm, this._baseTransform);
        ctx.setTransform(restoredTransform[0], restoredTransform[1], restoredTransform[2], restoredTransform[3], restoredTransform[4], restoredTransform[5]);
      }
      break;

    case 'cm': // Concat matrix
      if (args.length >= 6) {
        var m = [args[0], args[1], args[2], args[3], args[4], args[5]];
        gs.ctm = multiplyMatrix(m, gs.ctm);
        // Recompute the full canvas transform: CTM * baseTransform
        // This ensures correct ordering (PDF pre-multiply vs canvas post-multiply)
        var fullTransform = multiplyMatrix(gs.ctm, this._baseTransform);
        ctx.setTransform(fullTransform[0], fullTransform[1], fullTransform[2], fullTransform[3], fullTransform[4], fullTransform[5]);
      }
      break;

    case 'w': // Line width
      gs.lineWidth = args[0] || 0;
      ctx.lineWidth = gs.lineWidth;
      break;

    case 'J': // Line cap
      gs.lineCap = args[0] || 0;
      var capMap = ['butt', 'round', 'square'];
      ctx.lineCap = capMap[gs.lineCap] || 'butt';
      break;

    case 'j': // Line join
      gs.lineJoin = args[0] || 0;
      var joinMap = ['miter', 'round', 'bevel'];
      ctx.lineJoin = joinMap[gs.lineJoin] || 'miter';
      break;

    case 'M': // Miter limit
      gs.miterLimit = args[0] || 10;
      ctx.miterLimit = gs.miterLimit;
      break;

    case 'd': // Dash pattern
      if (args.length >= 2 && Array.isArray(args[0])) {
        gs.dashArray = args[0];
        gs.dashPhase = args[1] || 0;
        ctx.setLineDash(gs.dashArray);
        ctx.lineDashOffset = gs.dashPhase;
      }
      break;

    case 'ri': // Rendering intent (ignore)
      break;

    case 'i': // Flatness (ignore)
      break;

    case 'gs': // Extended graphics state
      await this._applyExtGState(args[0], resources, ctx);
      break;

    // ─── Path Construction ─────────────────────────────────────────
    case 'm': // moveTo
      if (args.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(args[0], args[1]);
      }
      break;

    case 'l': // lineTo
      if (args.length >= 2) {
        ctx.lineTo(args[0], args[1]);
      }
      break;

    case 'c': // curveTo (cubic Bezier)
      if (args.length >= 6) {
        ctx.bezierCurveTo(args[0], args[1], args[2], args[3], args[4], args[5]);
      }
      break;

    case 'v': // curveTo (initial point replicated)
      if (args.length >= 4) {
        // Current point is first control point
        ctx.bezierCurveTo(args[0], args[1], args[0], args[1], args[2], args[3]);
      }
      break;

    case 'y': // curveTo (final point replicated)
      if (args.length >= 4) {
        ctx.bezierCurveTo(args[0], args[1], args[2], args[3], args[2], args[3]);
      }
      break;

    case 'h': // closePath
      ctx.closePath();
      break;

    case 're': // rectangle
      if (args.length >= 4) {
        ctx.beginPath();
        ctx.rect(args[0], args[1], args[2], args[3]);
      }
      break;

    // ─── Path Painting ─────────────────────────────────────────────
    case 'S': // Stroke
      this._applyStrokeStyle(ctx, gs);
      ctx.stroke();
      break;

    case 's': // Close and stroke
      ctx.closePath();
      this._applyStrokeStyle(ctx, gs);
      ctx.stroke();
      break;

    case 'f': // Fill (nonzero winding)
    case 'F': // Fill (same as f, PDF 1.0 compat)
      this._applyFillStyle(ctx, gs);
      ctx.fill('nonzero');
      break;

    case 'f*': // Fill (even-odd)
      this._applyFillStyle(ctx, gs);
      ctx.fill('evenodd');
      break;

    case 'B': // Fill and stroke (nonzero)
      this._applyFillStyle(ctx, gs);
      ctx.fill('nonzero');
      this._applyStrokeStyle(ctx, gs);
      ctx.stroke();
      break;

    case 'B*': // Fill and stroke (even-odd)
      this._applyFillStyle(ctx, gs);
      ctx.fill('evenodd');
      this._applyStrokeStyle(ctx, gs);
      ctx.stroke();
      break;

    case 'b': // Close, fill and stroke (nonzero)
      ctx.closePath();
      this._applyFillStyle(ctx, gs);
      ctx.fill('nonzero');
      this._applyStrokeStyle(ctx, gs);
      ctx.stroke();
      break;

    case 'b*': // Close, fill and stroke (even-odd)
      ctx.closePath();
      this._applyFillStyle(ctx, gs);
      ctx.fill('evenodd');
      this._applyStrokeStyle(ctx, gs);
      ctx.stroke();
      break;

    case 'n': // End path (no paint)
      // No-op painting: just discard the path
      ctx.beginPath();
      break;

    // ─── Clipping ──────────────────────────────────────────────────
    case 'W': // Clip (nonzero)
      ctx.clip('nonzero');
      break;

    case 'W*': // Clip (even-odd)
      ctx.clip('evenodd');
      break;

    // ─── Color Operators ───────────────────────────────────────────
    case 'CS': // Set stroke color space
      if (args.length >= 1) {
        gs.strokeColorSpace = resolveCSName(args[0]);
      }
      break;

    case 'cs': // Set fill color space
      if (args.length >= 1) {
        gs.fillColorSpace = resolveCSName(args[0]);
      }
      break;

    case 'SC': // Set stroke color
    case 'SCN': // Set stroke color (extended)
      gs.strokeColor = args.slice();
      this._applyStrokeStyle(ctx, gs);
      break;

    case 'sc': // Set fill color
    case 'scn': // Set fill color (extended)
      gs.fillColor = args.slice();
      this._applyFillStyle(ctx, gs);
      break;

    case 'G': // Set stroke gray
      if (args.length >= 1) {
        gs.strokeColorSpace = 'DeviceGray';
        gs.strokeColor = [args[0]];
        this._applyStrokeStyle(ctx, gs);
      }
      break;

    case 'g': // Set fill gray
      if (args.length >= 1) {
        gs.fillColorSpace = 'DeviceGray';
        gs.fillColor = [args[0]];
        this._applyFillStyle(ctx, gs);
      }
      break;

    case 'RG': // Set stroke RGB
      if (args.length >= 3) {
        gs.strokeColorSpace = 'DeviceRGB';
        gs.strokeColor = [args[0], args[1], args[2]];
        this._applyStrokeStyle(ctx, gs);
      }
      break;

    case 'rg': // Set fill RGB
      if (args.length >= 3) {
        gs.fillColorSpace = 'DeviceRGB';
        gs.fillColor = [args[0], args[1], args[2]];
        this._applyFillStyle(ctx, gs);
      }
      break;

    case 'K': // Set stroke CMYK
      if (args.length >= 4) {
        gs.strokeColorSpace = 'DeviceCMYK';
        gs.strokeColor = [args[0], args[1], args[2], args[3]];
        this._applyStrokeStyle(ctx, gs);
      }
      break;

    case 'k': // Set fill CMYK
      if (args.length >= 4) {
        gs.fillColorSpace = 'DeviceCMYK';
        gs.fillColor = [args[0], args[1], args[2], args[3]];
        this._applyFillStyle(ctx, gs);
      }
      break;

    // ─── Text State ────────────────────────────────────────────────
    case 'Tc': // Character spacing
      gs.charSpacing = args[0] || 0;
      break;

    case 'Tw': // Word spacing
      gs.wordSpacing = args[0] || 0;
      break;

    case 'Tz': // Horizontal scaling
      gs.horizontalScaling = args[0] || 100;
      break;

    case 'TL': // Text leading
      gs.leading = args[0] || 0;
      break;

    case 'Tf': // Set font and size
      if (args.length >= 2) {
        var fontNameArg = args[0];
        var fontSize = args[1];

        // fontNameArg is typically a name like '/F1'
        var fontKey = fontNameArg;
        if (typeof fontKey === 'string' && fontKey.charAt(0) === '/') {
          fontKey = fontKey.substring(1);
        }

        gs.fontName = fontKey;
        gs.fontSize = fontSize;

        // Resolve font from resources
        await this._resolveFont(fontKey, resources);
      }
      break;

    case 'Tr': // Text render mode
      gs.textRenderMode = args[0] || 0;
      break;

    case 'Ts': // Text rise
      gs.textRise = args[0] || 0;
      break;

    // ─── Text Objects ──────────────────────────────────────────────
    case 'BT': // Begin text object
      gs.textMatrix = [1, 0, 0, 1, 0, 0];
      gs.textLineMatrix = [1, 0, 0, 1, 0, 0];
      break;

    case 'ET': // End text object
      break;

    // ─── Text Positioning ──────────────────────────────────────────
    case 'Td': // Move text position
      if (args.length >= 2) {
        var tx = args[0];
        var ty = args[1];
        gs.textLineMatrix = [
          gs.textLineMatrix[0], gs.textLineMatrix[1],
          gs.textLineMatrix[2], gs.textLineMatrix[3],
          gs.textLineMatrix[0] * tx + gs.textLineMatrix[2] * ty + gs.textLineMatrix[4],
          gs.textLineMatrix[1] * tx + gs.textLineMatrix[3] * ty + gs.textLineMatrix[5],
        ];
        gs.textMatrix = gs.textLineMatrix.slice();
      }
      break;

    case 'TD': // Move text position and set leading
      if (args.length >= 2) {
        gs.leading = -args[1];
        // Same as Td
        var tx = args[0];
        var ty = args[1];
        gs.textLineMatrix = [
          gs.textLineMatrix[0], gs.textLineMatrix[1],
          gs.textLineMatrix[2], gs.textLineMatrix[3],
          gs.textLineMatrix[0] * tx + gs.textLineMatrix[2] * ty + gs.textLineMatrix[4],
          gs.textLineMatrix[1] * tx + gs.textLineMatrix[3] * ty + gs.textLineMatrix[5],
        ];
        gs.textMatrix = gs.textLineMatrix.slice();
      }
      break;

    case 'Tm': // Set text matrix
      if (args.length >= 6) {
        gs.textMatrix = [args[0], args[1], args[2], args[3], args[4], args[5]];
        gs.textLineMatrix = gs.textMatrix.slice();
      }
      break;

    case 'T*': // Move to start of next line
      {
        var tx = 0;
        var ty = -gs.leading;
        gs.textLineMatrix = [
          gs.textLineMatrix[0], gs.textLineMatrix[1],
          gs.textLineMatrix[2], gs.textLineMatrix[3],
          gs.textLineMatrix[0] * tx + gs.textLineMatrix[2] * ty + gs.textLineMatrix[4],
          gs.textLineMatrix[1] * tx + gs.textLineMatrix[3] * ty + gs.textLineMatrix[5],
        ];
        gs.textMatrix = gs.textLineMatrix.slice();
      }
      break;

    // ─── Text Showing ──────────────────────────────────────────────
    case 'Tj': // Show text string
      if (args.length >= 1) {
        await this._showText(args[0], ctx, gs, resources);
      }
      break;

    case 'TJ': // Show text with kerning
      if (args.length >= 1 && Array.isArray(args[0])) {
        await this._showTextArray(args[0], ctx, gs, resources);
      }
      break;

    case "'": // Move to next line and show text
      {
        // Equivalent to: T* followed by Tj
        var txN = 0;
        var tyN = -gs.leading;
        gs.textLineMatrix = [
          gs.textLineMatrix[0], gs.textLineMatrix[1],
          gs.textLineMatrix[2], gs.textLineMatrix[3],
          gs.textLineMatrix[0] * txN + gs.textLineMatrix[2] * tyN + gs.textLineMatrix[4],
          gs.textLineMatrix[1] * txN + gs.textLineMatrix[3] * tyN + gs.textLineMatrix[5],
        ];
        gs.textMatrix = gs.textLineMatrix.slice();
        if (args.length >= 1) {
          await this._showText(args[0], ctx, gs, resources);
        }
      }
      break;

    case '"': // Set spacing, move to next line, show text
      if (args.length >= 3) {
        gs.wordSpacing = args[0];
        gs.charSpacing = args[1];
        // T*
        var txD = 0;
        var tyD = -gs.leading;
        gs.textLineMatrix = [
          gs.textLineMatrix[0], gs.textLineMatrix[1],
          gs.textLineMatrix[2], gs.textLineMatrix[3],
          gs.textLineMatrix[0] * txD + gs.textLineMatrix[2] * tyD + gs.textLineMatrix[4],
          gs.textLineMatrix[1] * txD + gs.textLineMatrix[3] * tyD + gs.textLineMatrix[5],
        ];
        gs.textMatrix = gs.textLineMatrix.slice();
        // Tj
        await this._showText(args[2], ctx, gs, resources);
      }
      break;

    // ─── XObject ───────────────────────────────────────────────────
    case 'Do': // Paint XObject
      if (args.length >= 1) {
        await this._invokeXObject(args[0], resources, ctx);
      }
      break;

    // ─── Inline Image ──────────────────────────────────────────────
    case 'BI': // Begin inline image (handled in tokenizer)
      if (token.type === 'inlineImage') {
        await this._drawInlineImage(token.dict, token.data, ctx);
      }
      break;

    // ─── Shading ───────────────────────────────────────────────────
    case 'sh': // Paint shading
      if (args.length >= 1) {
        await this._paintShading(args[0], resources, ctx);
      }
      break;

    // ─── Marked Content ────────────────────────────────────────────
    case 'BMC': // Begin marked content
    case 'BDC': // Begin marked content with properties
    case 'EMC': // End marked content
    case 'MP':  // Marked content point
    case 'DP':  // Marked content point with properties
      // Marked content is metadata for accessibility/structure -- ignore
      break;

    // ─── Type 3 Font Operators ─────────────────────────────────────
    case 'd0': // Type 3 glyph width declaration
      // d0: wx wy
      // Declares the horizontal and vertical displacement of the glyph.
      // The glyph may use any color operators.
      // We use this for advance width but the actual advance is computed
      // from the font's /Widths array (which takes precedence in practice).
      break;

    case 'd1': // Type 3 glyph width and bounding box
      // d1: wx wy llx lly urx ury
      // Declares displacement + bounding box. The glyph's appearance
      // must use only path and image operators (no color operators).
      // The bounding box is used for caching; we don't cache, so just
      // note the displacement.
      break;

    // ─── Compatibility ─────────────────────────────────────────────
    case 'BX': // Begin compatibility section
    case 'EX': // End compatibility section
      break;

    default:
      // Unknown operator: skip gracefully
      break;
  }
};

// ============================================================================
// Style Application
// ============================================================================

PDFRenderer.prototype._applyFillStyle = function(ctx, gs) {
  ctx.fillStyle = colorToCSS(gs.fillColor, gs.fillColorSpace);
  ctx.globalAlpha = gs.fillAlpha;
};

PDFRenderer.prototype._applyStrokeStyle = function(ctx, gs) {
  ctx.strokeStyle = colorToCSS(gs.strokeColor, gs.strokeColorSpace);
  ctx.lineWidth = gs.lineWidth;
  ctx.globalAlpha = gs.strokeAlpha;
};

// ============================================================================
// Font Resolution
// ============================================================================

PDFRenderer.prototype._resolveFont = async function(fontKey, resources) {
  var gs = this._gs;

  // Check cache
  if (this._fontCache[fontKey]) {
    var cached = this._fontCache[fontKey];
    gs.fontCSS = cached.fontCSS;
    gs.fontBold = cached.fontBold;
    gs.fontItalic = cached.fontItalic;
    gs.fontWidthsType = cached.fontWidthsType;
    gs.fontWidths = cached.fontWidths;
    gs.fontFirstChar = cached.fontFirstChar;
    gs.fontDefaultWidth = cached.fontDefaultWidth;
    gs.fontEncoding = cached.fontEncoding;
    gs.fontToUnicode = cached.fontToUnicode;
    gs.fontIsTwoByte = cached.fontIsTwoByte;
    gs.fontName = cached.baseFontName || fontKey;
    gs.isType3 = cached.isType3 || false;
    gs.type3CharProcs = cached.type3CharProcs || null;
    gs.type3FontMatrix = cached.type3FontMatrix || null;
    gs.type3FontBBox = cached.type3FontBBox || null;
    gs.type3Resources = cached.type3Resources || null;
    return;
  }

  var resolved = await this._resolveFontAsync(fontKey, resources);

  // Apply to gs
  gs.fontCSS = resolved.fontCSS;
  gs.fontBold = resolved.fontBold;
  gs.fontItalic = resolved.fontItalic;
  gs.fontWidthsType = resolved.fontWidthsType;
  gs.fontWidths = resolved.fontWidths;
  gs.fontFirstChar = resolved.fontFirstChar;
  gs.fontDefaultWidth = resolved.fontDefaultWidth;
  gs.fontEncoding = resolved.fontEncoding;
  gs.fontToUnicode = resolved.fontToUnicode;
  gs.fontIsTwoByte = resolved.fontIsTwoByte;
  gs.fontName = resolved.baseFontName || fontKey;
  gs.isType3 = resolved.isType3 || false;
  gs.type3CharProcs = resolved.type3CharProcs || null;
  gs.type3FontMatrix = resolved.type3FontMatrix || null;
  gs.type3FontBBox = resolved.type3FontBBox || null;
  gs.type3Resources = resolved.type3Resources || null;

  // Cache
  this._fontCache[fontKey] = resolved;
};

/**
 * Resolve a font dictionary from resources and extract rendering info.
 * Exposed on the prototype for testing.
 */
PDFRenderer.prototype._resolveFontAsync = async function(fontKey, resources) {
  var result = {
    fontCSS: 'sans-serif',
    fontBold: false,
    fontItalic: false,
    fontWidthsType: 'none',
    fontWidths: null,
    fontFirstChar: 0,
    fontDefaultWidth: 1000,
    fontEncoding: null,
    fontToUnicode: null,
    fontIsTwoByte: false,
    baseFontName: fontKey,
    // Type3 font fields
    isType3: false,
    type3CharProcs: null,
    type3FontMatrix: null,
    type3FontBBox: null,
    type3Resources: null,
  };

  if (!resources || !resources['/Font']) return result;

  var fontDict = resources['/Font']['/' + fontKey];
  if (!fontDict) return result;

  // Resolve reference
  if (this._parser && fontDict && typeof fontDict === 'object' && fontDict.type === 'ref') {
    fontDict = this._parser.resolveRef(fontDict);
  }
  if (!fontDict || typeof fontDict !== 'object') return result;

  // Get base font name
  var baseFont = fontDict['/BaseFont'];
  if (this._parser && baseFont && typeof baseFont === 'object' && baseFont.type === 'ref') {
    baseFont = this._parser.resolveRef(baseFont);
  }
  if (typeof baseFont === 'string') {
    if (baseFont.charAt(0) === '/') baseFont = baseFont.substring(1);
    result.baseFontName = baseFont;
  }

  // Determine CSS font family
  if (PDFFonts) {
    result.fontCSS = PDFFonts.getStandardFontCSS(result.baseFontName);
    result.fontBold = PDFFonts.isBoldFont(result.baseFontName);
    result.fontItalic = PDFFonts.isItalicFont(result.baseFontName);
  }

  // Check font subtype
  var subtype = fontDict['/Subtype'];
  if (typeof subtype === 'string' && subtype.charAt(0) === '/') subtype = subtype.substring(1);

  // Determine if this is a CID (two-byte) font
  if (subtype === 'Type0' || subtype === 'CIDFontType0' || subtype === 'CIDFontType2') {
    result.fontIsTwoByte = true;
  }

  // Handle Type3 font: extract CharProcs, FontMatrix, FontBBox, Resources
  if (subtype === 'Type3') {
    result.isType3 = true;

    // /FontMatrix transforms glyph space to text space (required for Type3)
    var fontMatrix = fontDict['/FontMatrix'];
    if (this._parser && fontMatrix && typeof fontMatrix === 'object' && fontMatrix.type === 'ref') {
      fontMatrix = this._parser.resolveRef(fontMatrix);
    }
    if (Array.isArray(fontMatrix) && fontMatrix.length >= 6) {
      result.type3FontMatrix = fontMatrix;
    } else {
      // Default font matrix: 1/1000 text units (same as Type1)
      result.type3FontMatrix = [0.001, 0, 0, 0.001, 0, 0];
    }

    // /FontBBox for the bounding box of the font
    var fontBBox = fontDict['/FontBBox'];
    if (this._parser && fontBBox && typeof fontBBox === 'object' && fontBBox.type === 'ref') {
      fontBBox = this._parser.resolveRef(fontBBox);
    }
    if (Array.isArray(fontBBox) && fontBBox.length >= 4) {
      result.type3FontBBox = fontBBox;
    }

    // /CharProcs dictionary: maps glyph names to content streams
    var charProcs = fontDict['/CharProcs'];
    if (this._parser && charProcs && typeof charProcs === 'object' && charProcs.type === 'ref') {
      charProcs = this._parser.resolveRef(charProcs);
    }
    if (charProcs && typeof charProcs === 'object') {
      result.type3CharProcs = charProcs;
    }

    // /Resources for the Type3 font's own glyph streams
    var type3Resources = fontDict['/Resources'];
    if (this._parser && type3Resources && typeof type3Resources === 'object' && type3Resources.type === 'ref') {
      type3Resources = this._parser.resolveRef(type3Resources);
    }
    result.type3Resources = type3Resources || null;
  }

  // Extract /Widths array (Type1 and TrueType fonts)
  var firstChar = fontDict['/FirstChar'];
  var lastChar = fontDict['/LastChar'];
  var widthsArray = fontDict['/Widths'];

  if (this._parser && widthsArray && typeof widthsArray === 'object' && widthsArray.type === 'ref') {
    widthsArray = this._parser.resolveRef(widthsArray);
  }

  if (typeof firstChar === 'number' && typeof lastChar === 'number' && Array.isArray(widthsArray)) {
    var count = lastChar - firstChar + 1;
    var widths = new Float64Array(count);
    for (var wi = 0; wi < count && wi < widthsArray.length; wi++) {
      var wVal = widthsArray[wi];
      if (this._parser && wVal && typeof wVal === 'object' && wVal.type === 'ref') {
        wVal = this._parser.resolveRef(wVal);
      }
      widths[wi] = typeof wVal === 'number' ? wVal : 0;
    }
    result.fontWidthsType = 'simple';
    result.fontWidths = widths;
    result.fontFirstChar = firstChar;
  }

  // Extract CID font /W array (Type0 CID fonts)
  if (subtype === 'Type0') {
    var descendantFonts = fontDict['/DescendantFonts'];
    if (this._parser && descendantFonts && typeof descendantFonts === 'object' && descendantFonts.type === 'ref') {
      descendantFonts = this._parser.resolveRef(descendantFonts);
    }
    if (Array.isArray(descendantFonts) && descendantFonts.length > 0) {
      var cidFont = descendantFonts[0];
      if (this._parser && cidFont && typeof cidFont === 'object' && cidFont.type === 'ref') {
        cidFont = this._parser.resolveRef(cidFont);
      }
      if (cidFont && typeof cidFont === 'object') {
        var wArray = cidFont['/W'];
        if (this._parser && wArray && typeof wArray === 'object' && wArray.type === 'ref') {
          wArray = this._parser.resolveRef(wArray);
        }
        if (Array.isArray(wArray)) {
          var cidMap = this._parseCIDWidths(wArray);
          result.fontWidthsType = 'cidmap';
          result.fontWidths = cidMap;
        }

        // Get default width from CID font
        var dw = cidFont['/DW'];
        if (typeof dw === 'number') result.fontDefaultWidth = dw;
      }
    }
    result.fontIsTwoByte = true;
  }

  // Extract encoding
  var encoding = fontDict['/Encoding'];
  if (this._parser && encoding && typeof encoding === 'object' && encoding.type === 'ref') {
    encoding = this._parser.resolveRef(encoding);
  }
  if (typeof encoding === 'string') {
    var encName = encoding;
    if (encName.charAt(0) === '/') encName = encName.substring(1);
    if (PDFFonts) {
      result.fontEncoding = PDFFonts.resolveEncoding(encName);
    }
  } else if (encoding && typeof encoding === 'object') {
    // Dictionary encoding with /BaseEncoding and /Differences
    var baseEncName = encoding['/BaseEncoding'];
    if (typeof baseEncName === 'string') {
      if (baseEncName.charAt(0) === '/') baseEncName = baseEncName.substring(1);
      if (PDFFonts) {
        result.fontEncoding = PDFFonts.resolveEncoding(baseEncName);
      }
    }
    if (!result.fontEncoding && PDFFonts) {
      result.fontEncoding = PDFFonts.resolveEncoding('WinAnsiEncoding');
    }
    var differences = encoding['/Differences'];
    if (this._parser && differences && typeof differences === 'object' && differences.type === 'ref') {
      differences = this._parser.resolveRef(differences);
    }
    if (Array.isArray(differences) && result.fontEncoding && PDFFonts) {
      result.fontEncoding = PDFFonts.applyDifferences(result.fontEncoding, differences);
    }
  }

  // Extract ToUnicode CMap
  var toUnicode = fontDict['/ToUnicode'];
  if (this._parser && toUnicode && typeof toUnicode === 'object' && toUnicode.type === 'ref') {
    toUnicode = this._parser.resolveRef(toUnicode);
  }
  if (toUnicode && toUnicode.isStream && typeof toUnicode.getBytes === 'function') {
    try {
      var cmapBytes = toUnicode.getBytes();
      var cmapText = '';
      for (var ci = 0; ci < cmapBytes.length; ci++) {
        cmapText += String.fromCharCode(cmapBytes[ci]);
      }
      if (PDFFonts) {
        result.fontToUnicode = PDFFonts.parseToUnicodeCMap(cmapText);
      }
    } catch (e) {
      // Non-fatal: skip ToUnicode
    }
  }

  return result;
};

/**
 * Parse a CID /W (widths) array into a Map(cid -> width).
 */
PDFRenderer.prototype._parseCIDWidths = function(wArray) {
  var map = new Map();
  var i = 0;
  while (i < wArray.length) {
    var first = wArray[i];
    if (typeof first !== 'number') { i++; continue; }

    if (i + 1 < wArray.length && Array.isArray(wArray[i + 1])) {
      // Format: c [w1 w2 w3 ...]
      var widths = wArray[i + 1];
      for (var wi = 0; wi < widths.length; wi++) {
        var wVal = widths[wi];
        if (this._parser && wVal && typeof wVal === 'object' && wVal.type === 'ref') {
          wVal = this._parser.resolveRef(wVal);
        }
        map.set(first + wi, typeof wVal === 'number' ? wVal : 1000);
      }
      i += 2;
    } else if (i + 2 < wArray.length && typeof wArray[i + 1] === 'number' && typeof wArray[i + 2] === 'number') {
      // Format: c_first c_last w
      var last = wArray[i + 1];
      var w = wArray[i + 2];
      for (var cid = first; cid <= last; cid++) {
        map.set(cid, w);
      }
      i += 3;
    } else {
      i++;
    }
  }
  return map;
};

// ============================================================================
// Text Rendering
// ============================================================================

/**
 * Show a text string on the canvas.
 * Handles both standard fonts (fillText) and Type3 fonts (CharProc streams).
 */
PDFRenderer.prototype._showText = async function(strArg, ctx, gs, resources) {
  if (!strArg) return;

  var bytes;
  if (strArg instanceof Uint8Array) {
    bytes = strArg;
  } else if (typeof strArg === 'string') {
    bytes = new Uint8Array(strArg.length);
    for (var i = 0; i < strArg.length; i++) {
      bytes[i] = strArg.charCodeAt(i) & 0xFF;
    }
  } else {
    return;
  }

  // Type3 font: render each glyph by interpreting its CharProc content stream
  if (gs.isType3 && gs.type3CharProcs) {
    await this._showTextType3(bytes, ctx, gs, resources);
    return;
  }

  // Decode bytes to Unicode text
  var text = this._decodeTextBytes(bytes, gs);

  // Render the text glyph by glyph for proper spacing
  var fontSize = gs.fontSize;
  var hScale = gs.horizontalScaling / 100;

  // Set font on context
  var fontStyle = '';
  if (gs.fontItalic) fontStyle += 'italic ';
  if (gs.fontBold) fontStyle += 'bold ';
  var fontStr = fontStyle + Math.abs(fontSize) + 'px ' + gs.fontCSS;
  ctx.font = fontStr;

  // Apply fill/stroke color based on render mode
  this._applyFillStyle(ctx, gs);

  // Compose the base canvas transform with the TRM for correct positioning.
  // TRM is in PDF coordinate space; we must map it through the base transform
  // (which handles Y-flip and scale) to get the correct canvas position.
  var bt = this._baseTransform;

  if (gs.fontIsTwoByte) {
    // Two-byte font: process 2 bytes at a time
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      var code = (bytes[i] << 8) | bytes[i + 1];
      var charIdx = Math.floor(i / 2);
      var ch = charIdx < text.length ? text.charAt(charIdx) : String.fromCharCode(code);

      // Calculate text rendering matrix (TRM) in PDF space
      var trm = multiplyMatrix(gs.textMatrix, gs.ctm);

      // Compose TRM with base canvas transform to get final canvas transform
      var canvasTrm = multiplyMatrix(trm, bt);

      // Draw the character
      ctx.save();
      ctx.setTransform(canvasTrm[0], canvasTrm[1], canvasTrm[2], canvasTrm[3], canvasTrm[4], canvasTrm[5]);
      // Scale horizontally and flip Y for text (canvas fillText expects Y-down)
      ctx.scale(hScale, -1);
      var yOffset = -gs.textRise;
      this._renderChar(ctx, gs, ch, 0, yOffset);
      ctx.restore();

      // Advance text position
      var advance = _getGlyphAdvance1000(gs, code);
      var tx = (advance / 1000 * fontSize + gs.charSpacing) * hScale;
      if (code === 32) tx += gs.wordSpacing * hScale;
      gs.textMatrix[4] += tx * gs.textMatrix[0];
      gs.textMatrix[5] += tx * gs.textMatrix[1];
    }
  } else {
    // Single-byte font
    for (var i = 0; i < bytes.length; i++) {
      var byteVal = bytes[i];
      var ch = i < text.length ? text.charAt(i) : String.fromCharCode(byteVal);

      // Calculate text rendering matrix (TRM) in PDF space
      var trm = multiplyMatrix(gs.textMatrix, gs.ctm);

      // Compose TRM with base canvas transform to get final canvas transform
      var canvasTrm = multiplyMatrix(trm, bt);

      // Draw the character
      ctx.save();
      ctx.setTransform(canvasTrm[0], canvasTrm[1], canvasTrm[2], canvasTrm[3], canvasTrm[4], canvasTrm[5]);
      // Scale horizontally and flip Y for text (canvas fillText expects Y-down)
      ctx.scale(hScale, -1);
      var yOffset = -gs.textRise;
      this._renderChar(ctx, gs, ch, 0, yOffset);
      ctx.restore();

      // Advance text position
      var advance = _getGlyphAdvance1000(gs, byteVal);
      var tx = (advance / 1000 * fontSize + gs.charSpacing) * hScale;
      if (byteVal === 32) tx += gs.wordSpacing * hScale;
      gs.textMatrix[4] += tx * gs.textMatrix[0];
      gs.textMatrix[5] += tx * gs.textMatrix[1];
    }
  }
};

/**
 * Show a TJ array (text with kerning adjustments).
 */
PDFRenderer.prototype._showTextArray = async function(arr, ctx, gs, resources) {
  for (var i = 0; i < arr.length; i++) {
    var elem = arr[i];
    if (typeof elem === 'number') {
      // Kerning adjustment: negative value moves right, positive moves left
      // Value is in thousandths of a unit of text space
      var adjustment = -elem / 1000 * gs.fontSize * (gs.horizontalScaling / 100);
      gs.textMatrix[4] += adjustment * gs.textMatrix[0];
      gs.textMatrix[5] += adjustment * gs.textMatrix[1];
    } else {
      // Text string
      await this._showText(elem, ctx, gs, resources);
    }
  }
};

/**
 * Render a single character using the appropriate render mode.
 */
PDFRenderer.prototype._renderChar = function(ctx, gs, ch, x, y) {
  switch (gs.textRenderMode) {
    case 0: // Fill
      ctx.fillText(ch, x, y);
      break;
    case 1: // Stroke
      ctx.strokeText(ch, x, y);
      break;
    case 2: // Fill then stroke
      ctx.fillText(ch, x, y);
      ctx.strokeText(ch, x, y);
      break;
    case 3: // Invisible
      break;
    case 4: // Fill and add to clip
      ctx.fillText(ch, x, y);
      break;
    case 5: // Stroke and add to clip
      ctx.strokeText(ch, x, y);
      break;
    case 6: // Fill, stroke, and add to clip
      ctx.fillText(ch, x, y);
      ctx.strokeText(ch, x, y);
      break;
    case 7: // Add to clip only
      break;
    default:
      ctx.fillText(ch, x, y);
  }
};

/**
 * Render text using a Type3 font.
 * Each glyph is rendered by interpreting its CharProc content stream.
 *
 * @param {Uint8Array} bytes - character code bytes
 * @param {CanvasRenderingContext2D} ctx - canvas context
 * @param {object} gs - graphics state
 * @param {object} resources - page resources
 */
PDFRenderer.prototype._showTextType3 = async function(bytes, ctx, gs, resources) {
  var charProcs = gs.type3CharProcs;
  var fontMatrix = gs.type3FontMatrix || [0.001, 0, 0, 0.001, 0, 0];
  var fontSize = gs.fontSize;
  var hScale = gs.horizontalScaling / 100;

  // Build encoding table: maps byte values to glyph names
  // Type3 fonts use their /Encoding to map codes to glyph names in /CharProcs
  var encoding = gs.fontEncoding; // array of Unicode code points indexed by byte value

  for (var i = 0; i < bytes.length; i++) {
    var byteVal = bytes[i];

    // Look up glyph name from encoding
    var glyphName = null;

    // If there is an encoding table, we need the glyph name
    // The encoding table stores Unicode codepoints, but CharProcs keys are glyph names
    // We need to map byte value -> glyph name
    // The encoding differences array populates this mapping
    if (encoding) {
      // Try to get the glyph name from GLYPH_NAME_TO_UNICODE reverse lookup
      var cp = encoding[byteVal];
      if (cp && PDFFonts && PDFFonts.GLYPH_NAME_TO_UNICODE) {
        // Reverse lookup: find glyph name that maps to this code point
        var gntu = PDFFonts.GLYPH_NAME_TO_UNICODE;
        for (var gn in gntu) {
          if (gntu[gn] === cp) {
            glyphName = gn;
            break;
          }
        }
      }
    }

    // If no glyph name found, try common patterns
    if (!glyphName) {
      // Try standard names
      if (byteVal >= 65 && byteVal <= 90) {
        glyphName = String.fromCharCode(byteVal); // A-Z
      } else if (byteVal >= 97 && byteVal <= 122) {
        glyphName = String.fromCharCode(byteVal); // a-z
      } else if (byteVal >= 48 && byteVal <= 57) {
        glyphName = String.fromCharCode(byteVal); // 0-9
      } else if (byteVal === 32) {
        glyphName = 'space';
      } else if (byteVal === 46) {
        glyphName = 'period';
      } else if (byteVal === 44) {
        glyphName = 'comma';
      } else {
        glyphName = '.notdef';
      }
    }

    // Look up the CharProc stream for this glyph
    var charProcStream = charProcs['/' + glyphName];
    if (!charProcStream && charProcs[glyphName]) {
      charProcStream = charProcs[glyphName];
    }

    // Resolve reference
    if (this._parser && charProcStream && typeof charProcStream === 'object' && charProcStream.type === 'ref') {
      charProcStream = this._parser.resolveRef(charProcStream);
    }

    // Calculate text rendering matrix
    // Trm = FontMatrix x TextMatrix x CTM
    var tmScaled = [
      gs.textMatrix[0] * fontSize * hScale,
      gs.textMatrix[1] * fontSize * hScale,
      gs.textMatrix[2] * fontSize,
      gs.textMatrix[3] * fontSize,
      gs.textMatrix[4],
      gs.textMatrix[5],
    ];
    var trm = multiplyMatrix(tmScaled, gs.ctm);

    if (charProcStream && charProcStream.isStream && typeof charProcStream.getBytes === 'function') {
      // Render the glyph by interpreting its content stream
      ctx.save();

      // Set up the transform: FontMatrix x TRM, then compose with base transform
      var glyphTransform = multiplyMatrix(fontMatrix, trm);
      var canvasGlyph = multiplyMatrix(glyphTransform, this._baseTransform);
      ctx.setTransform(
        canvasGlyph[0], canvasGlyph[1],
        canvasGlyph[2], canvasGlyph[3],
        canvasGlyph[4], canvasGlyph[5]
      );

      // Execute the glyph's content stream
      // Depth guard: reuse form depth tracking
      if (this._formDepth < this._maxFormDepth) {
        this._formDepth++;
        try {
          var glyphBytes = charProcStream.getBytes();
          if (glyphBytes && glyphBytes.length > 0) {
            // Use the Type3 font's own resources if available, else page resources
            var glyphResources = gs.type3Resources || resources;
            await this._executeContentStream(glyphBytes, glyphResources, ctx);
          }
        } catch (e) {
          console.warn('Type3 glyph rendering error for /' + glyphName + ':', e.message);
        }
        this._formDepth--;
      }

      ctx.restore();
    }
    // If no CharProc found, the glyph is simply skipped (invisible)

    // Advance text position using the font's widths
    var advance = _getGlyphAdvance1000(gs, byteVal);
    var tx = (advance / 1000 * fontSize + gs.charSpacing) * hScale;
    if (byteVal === 32) tx += gs.wordSpacing * hScale;
    gs.textMatrix[4] += tx * gs.textMatrix[0];
    gs.textMatrix[5] += tx * gs.textMatrix[1];
  }
};

/**
 * Decode raw text bytes to Unicode string using font encoding.
 */
PDFRenderer.prototype._decodeTextBytes = function(bytes, gs) {
  if (!bytes || bytes.length === 0) return '';

  // Try ToUnicode CMap first (highest priority)
  if (gs.fontToUnicode && gs.fontToUnicode.size > 0 && PDFFonts) {
    return PDFFonts.decodeWithToUnicode(bytes, gs.fontToUnicode, gs.fontIsTwoByte);
  }

  // Try encoding table
  if (gs.fontEncoding && PDFFonts) {
    return PDFFonts.decodeWithEncoding(bytes, gs.fontEncoding);
  }

  // Fallback: Latin-1
  if (PDFFonts) {
    return PDFFonts.pdfStringToText(bytes);
  }

  var str = '';
  for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return str;
};

// ============================================================================
// XObject Invocation
// ============================================================================

/**
 * Invoke an XObject (image or form).
 */
PDFRenderer.prototype._invokeXObject = async function(nameArg, resources, ctx) {
  if (!resources || !resources['/XObject']) return;

  var xobjName = nameArg;
  if (typeof xobjName !== 'string') return;

  var xobj = resources['/XObject'][xobjName];
  if (!xobj) {
    // Try without leading slash
    var altName = xobjName.charAt(0) === '/' ? xobjName : '/' + xobjName;
    xobj = resources['/XObject'][altName];
  }
  if (!xobj) return;

  // Resolve reference
  if (this._parser && xobj && typeof xobj === 'object' && xobj.type === 'ref') {
    xobj = this._parser.resolveRef(xobj);
  }
  if (!xobj) return;

  // Determine subtype
  var subtype = xobj['/Subtype'] || (xobj.dict && xobj.dict['/Subtype']);
  if (this._parser && subtype && typeof subtype === 'object' && subtype.type === 'ref') {
    subtype = this._parser.resolveRef(subtype);
  }
  if (typeof subtype === 'string') {
    if (subtype.charAt(0) === '/') subtype = subtype.substring(1);
  }

  if (subtype === 'Image') {
    await this._drawImage(xobj, ctx);
  } else if (subtype === 'Form') {
    await this._drawFormXObject(xobj, resources, ctx, this._gs);
  } else {
    // Unknown subtype -- try as image
    if (xobj['/Width'] || xobj['/Height']) {
      await this._drawImage(xobj, ctx);
    }
  }
};

/**
 * Draw an image XObject.
 */
PDFRenderer.prototype._drawImage = async function(imageObj, ctx) {
  if (!PDFImages) return;

  ctx.save();
  try {
    // PDF images occupy a 1x1 unit square and rely on the CTM for placement.
    // The base transform flips Y (scale 0,0,-scale,...) so paths/text render
    // correctly, but ctx.drawImage() always paints top-to-bottom, causing
    // images to appear upside-down.  Compensate by flipping Y within the
    // 1x1 image unit square: scale(1,-1) + translate(0,-1).
    ctx.transform(1, 0, 0, -1, 0, 1);

    // Pass current fill color as render state for image mask support
    var renderState = {
      fillColor: this._gs.fillColor,
      fillColorSpace: this._gs.fillColorSpace,
      fillAlpha: this._gs.fillAlpha,
    };
    await PDFImages.drawImageXObject(ctx, imageObj, this._parser, renderState);
  } catch (e) {
    console.warn('Image rendering error:', e.message);
  }
  ctx.restore();
};

/**
 * Draw a form XObject (a sub-content-stream).
 */
PDFRenderer.prototype._drawFormXObject = async function(formStream, pageResources, ctx, gs) {
  // Depth guard
  if (this._formDepth >= this._maxFormDepth) {
    console.warn('Form XObject depth limit reached (' + this._formDepth + ')');
    return;
  }

  // Cycle guard
  if (this._activeFormIds.has(formStream)) {
    console.warn('Form XObject cycle detected');
    return;
  }

  this._formDepth++;
  this._activeFormIds.add(formStream);

  try {
    var dict = formStream.dict || formStream;

    // Get BBox
    var bbox = dict['/BBox'] || [0, 0, 1, 1];
    if (this._parser && bbox && typeof bbox === 'object' && bbox.type === 'ref') {
      bbox = this._parser.resolveRef(bbox);
    }
    if (!Array.isArray(bbox)) bbox = [0, 0, 1, 1];

    // Get Matrix (optional)
    var matrix = dict['/Matrix'];
    if (this._parser && matrix && typeof matrix === 'object' && matrix.type === 'ref') {
      matrix = this._parser.resolveRef(matrix);
    }

    // Get resources (form may have its own, else inherit from page)
    var formResources = dict['/Resources'];
    if (this._parser && formResources && typeof formResources === 'object' && formResources.type === 'ref') {
      formResources = this._parser.resolveRef(formResources);
    }
    if (!formResources) formResources = pageResources;

    // Save graphics state
    ctx.save();
    var savedGS = cloneGraphicsState(this._gs);

    // Apply form matrix if present (same logic as 'cm' operator)
    if (Array.isArray(matrix) && matrix.length >= 6) {
      this._gs.ctm = multiplyMatrix(matrix, this._gs.ctm);
      var formFullTransform = multiplyMatrix(this._gs.ctm, this._baseTransform);
      ctx.setTransform(formFullTransform[0], formFullTransform[1], formFullTransform[2], formFullTransform[3], formFullTransform[4], formFullTransform[5]);
    }

    // Clip to BBox
    ctx.beginPath();
    ctx.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
    ctx.clip();

    // Decode and execute the form's content stream
    if (formStream.isStream && typeof formStream.getBytes === 'function') {
      try {
        var formBytes = formStream.getBytes();
        if (formBytes && formBytes.length > 0) {
          await this._executeContentStream(formBytes, formResources, ctx);
        }
      } catch (e) {
        console.warn('Form XObject content stream error:', e.message);
      }
    }

    // Restore graphics state
    this._gs = savedGS;
    ctx.restore();
  } finally {
    this._formDepth--;
    this._activeFormIds.delete(formStream);
  }
};

// ============================================================================
// Inline Image Drawing
// ============================================================================

PDFRenderer.prototype._drawInlineImage = async function(dict, data, ctx) {
  if (!PDFImages) return;

  ctx.save();
  try {
    // Same Y-flip compensation as _drawImage — see comment there.
    ctx.transform(1, 0, 0, -1, 0, 1);

    await PDFImages.drawInlineImage(ctx, dict, data);
  } catch (e) {
    console.warn('Inline image rendering error:', e.message);
  }
  ctx.restore();
};

// ============================================================================
// ExtGState
// ============================================================================

PDFRenderer.prototype._applyExtGState = async function(nameArg, resources, ctx) {
  if (!resources || !resources['/ExtGState']) return;

  var gsName = nameArg;
  if (typeof gsName !== 'string') return;

  var extGS = resources['/ExtGState'][gsName];
  if (!extGS) {
    var altName = gsName.charAt(0) === '/' ? gsName : '/' + gsName;
    extGS = resources['/ExtGState'][altName];
  }
  if (!extGS) return;

  if (this._parser && extGS && typeof extGS === 'object' && extGS.type === 'ref') {
    extGS = this._parser.resolveRef(extGS);
  }
  if (!extGS || typeof extGS !== 'object') return;

  var gs = this._gs;

  // /CA - stroke alpha
  if (typeof extGS['/CA'] === 'number') {
    gs.strokeAlpha = extGS['/CA'];
  }

  // /ca - fill alpha
  if (typeof extGS['/ca'] === 'number') {
    gs.fillAlpha = extGS['/ca'];
  }

  // /LW - line width
  if (typeof extGS['/LW'] === 'number') {
    gs.lineWidth = extGS['/LW'];
    ctx.lineWidth = gs.lineWidth;
  }

  // /LC - line cap
  if (typeof extGS['/LC'] === 'number') {
    gs.lineCap = extGS['/LC'];
    var capMap = ['butt', 'round', 'square'];
    ctx.lineCap = capMap[gs.lineCap] || 'butt';
  }

  // /LJ - line join
  if (typeof extGS['/LJ'] === 'number') {
    gs.lineJoin = extGS['/LJ'];
    var joinMap = ['miter', 'round', 'bevel'];
    ctx.lineJoin = joinMap[gs.lineJoin] || 'miter';
  }

  // /ML - miter limit
  if (typeof extGS['/ML'] === 'number') {
    gs.miterLimit = extGS['/ML'];
    ctx.miterLimit = gs.miterLimit;
  }

  // /Font - set font from ExtGState
  if (Array.isArray(extGS['/Font']) && extGS['/Font'].length >= 2) {
    var fontRef = extGS['/Font'][0];
    var fontSize = extGS['/Font'][1];
    gs.fontSize = fontSize;
    // Font resolution would need the font dict -- simplified for now
  }

  // /BM - blend mode
  if (extGS['/BM']) {
    var bm = extGS['/BM'];
    if (typeof bm === 'string') {
      if (bm.charAt(0) === '/') bm = bm.substring(1);
      // Map PDF blend modes to Canvas globalCompositeOperation values
      var blendMap = {
        'Normal': 'source-over',
        'Multiply': 'multiply',
        'Screen': 'screen',
        'Overlay': 'overlay',
        'Darken': 'darken',
        'Lighten': 'lighten',
        'ColorDodge': 'color-dodge',
        'ColorBurn': 'color-burn',
        'HardLight': 'hard-light',
        'SoftLight': 'soft-light',
        'Difference': 'difference',
        'Exclusion': 'exclusion',
      };
      var compOp = blendMap[bm];
      if (compOp) {
        try { ctx.globalCompositeOperation = compOp; } catch (e) { /* ignore */ }
      }
    }
  }

  // /SMask - soft mask dictionary (basic support)
  // SMask in ExtGState is a soft mask dictionary with /G (group), /S (subtype), /BC (backdrop)
  // Full implementation would require rendering the group to an offscreen canvas.
  // We handle the simple case where /SMask is /None (resets soft mask)
  if (extGS['/SMask'] !== undefined) {
    var smask = extGS['/SMask'];
    if (typeof smask === 'string') {
      var smaskVal = smask.charAt(0) === '/' ? smask.substring(1) : smask;
      if (smaskVal === 'None') {
        // Reset soft mask -- restore full opacity behavior
        // This is commonly used after a transparency group
      }
    }
    // Complex SMask dictionaries (with /G transparency groups) are deferred
    // as they require a full offscreen rendering pipeline
  }

  // /D - dash pattern [array phase]
  if (Array.isArray(extGS['/D']) && extGS['/D'].length >= 2) {
    var dashArr = extGS['/D'][0];
    var dashPhase = extGS['/D'][1];
    if (Array.isArray(dashArr)) {
      gs.dashArray = dashArr;
      gs.dashPhase = typeof dashPhase === 'number' ? dashPhase : 0;
      ctx.setLineDash(gs.dashArray);
      ctx.lineDashOffset = gs.dashPhase;
    }
  }

  // /RI - rendering intent (informational, no visual effect on canvas)
  // /OP, /op - overprint (CMYK-specific, not applicable to RGB canvas)
  // /OPM - overprint mode (CMYK-specific)
  // /SA - stroke adjustment (ignored)
  // /AIS - alpha is shape (advanced compositing, ignored)
  // /TK - text knockout (ignored)
};

// ============================================================================
// Shading Patterns
// ============================================================================

/**
 * Paint a shading pattern using the sh operator.
 *
 * Supports:
 *   - Type 2: Axial (linear) gradient
 *   - Type 3: Radial gradient
 *
 * @param {string} nameArg - shading resource name
 * @param {object} resources - page resources
 * @param {CanvasRenderingContext2D} ctx - canvas context
 */
PDFRenderer.prototype._paintShading = async function(nameArg, resources, ctx) {
  if (!resources || !resources['/Shading']) return;

  var shadingName = nameArg;
  if (typeof shadingName !== 'string') return;

  var shading = resources['/Shading'][shadingName];
  if (!shading) {
    var altName = shadingName.charAt(0) === '/' ? shadingName : '/' + shadingName;
    shading = resources['/Shading'][altName];
  }
  if (!shading) return;

  if (this._parser && shading && typeof shading === 'object' && shading.type === 'ref') {
    shading = this._parser.resolveRef(shading);
  }
  if (!shading || typeof shading !== 'object') return;

  var dict = shading.dict || shading;
  var shadingType = this._resolveVal(dict['/ShadingType']);
  if (typeof shadingType !== 'number') return;

  // Resolve the color space
  var cs = this._resolveVal(dict['/ColorSpace']);
  var csName = 'DeviceRGB';
  if (typeof cs === 'string') {
    csName = cs.charAt(0) === '/' ? cs.substring(1) : cs;
  } else if (Array.isArray(cs) && cs.length > 0) {
    var csFirst = typeof cs[0] === 'string' ? cs[0] : '';
    csName = csFirst.charAt(0) === '/' ? csFirst.substring(1) : csFirst;
  }

  // Handle ICCBased -> fallback
  if (csName === 'ICCBased') {
    if (Array.isArray(cs) && cs.length > 1) {
      var iccStream = this._resolveVal(cs[1]);
      if (iccStream) {
        var iccDict = iccStream.dict || iccStream;
        var n = this._resolveVal(iccDict['/N']);
        if (n === 1) csName = 'DeviceGray';
        else if (n === 3) csName = 'DeviceRGB';
        else if (n === 4) csName = 'DeviceCMYK';
        else csName = 'DeviceRGB';
      }
    } else {
      csName = 'DeviceRGB';
    }
  }

  try {
    if (shadingType === 2) {
      this._paintAxialShading(dict, csName, ctx);
    } else if (shadingType === 3) {
      this._paintRadialShading(dict, csName, ctx);
    }
    // Other shading types (1, 4-7) are not commonly used; skip gracefully
  } catch (e) {
    console.warn('Shading rendering error:', e.message);
  }
};

/**
 * Helper to resolve a value that may be a reference.
 */
PDFRenderer.prototype._resolveVal = function(val) {
  if (!val) return val;
  if (this._parser && typeof val === 'object' && val.type === 'ref') {
    return this._parser.resolveRef(val);
  }
  return val;
};

/**
 * Render an axial (linear) gradient shading (Type 2).
 *
 * @param {object} dict - shading dictionary
 * @param {string} csName - color space name
 * @param {CanvasRenderingContext2D} ctx - canvas context
 */
PDFRenderer.prototype._paintAxialShading = function(dict, csName, ctx) {
  var coords = this._resolveVal(dict['/Coords']);
  if (!Array.isArray(coords) || coords.length < 4) return;

  var x0 = coords[0], y0 = coords[1], x1 = coords[2], y1 = coords[3];

  // Resolve the shading function
  var funcSpec = this._resolveVal(dict['/Function']);
  var evalFunc = this._buildShadingFunction(funcSpec, csName);

  // /Extend: [boolean, boolean] - whether to extend beyond endpoints
  var extend = this._resolveVal(dict['/Extend']) || [false, false];

  // /Domain: [t0, t1] - default [0, 1]
  var domain = this._resolveVal(dict['/Domain']) || [0, 1];

  // Sample the function to build gradient stops
  var numStops = 10;
  var gradient;

  try {
    gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  } catch (e) {
    // If createLinearGradient is not available (mock), skip
    return;
  }

  for (var si = 0; si <= numStops; si++) {
    var t = si / numStops;
    var domainT = domain[0] + t * (domain[1] - domain[0]);
    var color = evalFunc(domainT);
    var cssColor = this._shadingColorToCSS(color, csName);
    try {
      gradient.addColorStop(t, cssColor);
    } catch (e) {
      // Invalid color stop
    }
  }

  ctx.save();
  ctx.fillStyle = gradient;
  // Fill the entire current clip region
  // Use a large rect to cover the typical page area
  ctx.fillRect(-10000, -10000, 20000, 20000);
  ctx.restore();
};

/**
 * Render a radial gradient shading (Type 3).
 *
 * @param {object} dict - shading dictionary
 * @param {string} csName - color space name
 * @param {CanvasRenderingContext2D} ctx - canvas context
 */
PDFRenderer.prototype._paintRadialShading = function(dict, csName, ctx) {
  var coords = this._resolveVal(dict['/Coords']);
  if (!Array.isArray(coords) || coords.length < 6) return;

  var x0 = coords[0], y0 = coords[1], r0 = coords[2];
  var x1 = coords[3], y1 = coords[4], r1 = coords[5];

  var funcSpec = this._resolveVal(dict['/Function']);
  var evalFunc = this._buildShadingFunction(funcSpec, csName);

  var domain = this._resolveVal(dict['/Domain']) || [0, 1];

  var numStops = 10;
  var gradient;

  try {
    gradient = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  } catch (e) {
    return;
  }

  for (var si = 0; si <= numStops; si++) {
    var t = si / numStops;
    var domainT = domain[0] + t * (domain[1] - domain[0]);
    var color = evalFunc(domainT);
    var cssColor = this._shadingColorToCSS(color, csName);
    try {
      gradient.addColorStop(t, cssColor);
    } catch (e) {
      // Invalid color stop
    }
  }

  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(-10000, -10000, 20000, 20000);
  ctx.restore();
};

/**
 * Build a callable function from a PDF shading function specification.
 *
 * Supports:
 *   - Type 2: Exponential interpolation
 *   - Type 3: Stitching (multiple sub-functions)
 *   - Array of functions: evaluate each and concatenate results
 *   - Unsupported types: flat color fallback using endpoint values
 *
 * @param {object|Array} funcSpec - function specification from PDF
 * @param {string} csName - color space name
 * @returns {Function} f(t) -> array of color component values (0-1 range)
 */
PDFRenderer.prototype._buildShadingFunction = function(funcSpec, csName) {
  if (!funcSpec) {
    // No function: return black
    return function() { return [0, 0, 0]; };
  }

  // If it's an array of functions, build each and concatenate results
  if (Array.isArray(funcSpec)) {
    var subFuncs = [];
    for (var fi = 0; fi < funcSpec.length; fi++) {
      var subSpec = this._resolveVal(funcSpec[fi]);
      subFuncs.push(this._buildSingleFunction(subSpec));
    }
    return function(t) {
      var result = [];
      for (var fi = 0; fi < subFuncs.length; fi++) {
        var vals = subFuncs[fi](t);
        for (var vi = 0; vi < vals.length; vi++) {
          result.push(vals[vi]);
        }
      }
      return result;
    };
  }

  return this._buildSingleFunction(funcSpec);
};

/**
 * Build a single PDF function evaluator.
 *
 * @param {object} funcSpec - function dictionary
 * @returns {Function} f(t) -> array of output values
 */
PDFRenderer.prototype._buildSingleFunction = function(funcSpec) {
  if (!funcSpec || typeof funcSpec !== 'object') {
    return function() { return [0]; };
  }

  var funcType = this._resolveVal(funcSpec['/FunctionType']);
  if (typeof funcType !== 'number') {
    var fDict = funcSpec.dict || funcSpec;
    funcType = this._resolveVal(fDict['/FunctionType']);
  }

  if (funcType === 2) {
    return this._buildExponentialFunction(funcSpec);
  } else if (funcType === 3) {
    return this._buildStitchingFunction(funcSpec);
  } else if (funcType === 0) {
    // Type 0 (sampled): fallback to endpoint interpolation
    return this._buildFallbackFunction(funcSpec);
  } else if (funcType === 4) {
    // Type 4 (PostScript calculator): fallback to endpoint values
    return this._buildFallbackFunction(funcSpec);
  }

  // Unknown: try fallback
  return this._buildFallbackFunction(funcSpec);
};

/**
 * Build a Type 2 (exponential interpolation) function.
 * f(x) = C0 + x^N * (C1 - C0)
 *
 * @param {object} funcSpec - function dictionary
 * @returns {Function} f(t) -> array of values
 */
PDFRenderer.prototype._buildExponentialFunction = function(funcSpec) {
  var dict = funcSpec.dict || funcSpec;
  var c0 = this._resolveVal(dict['/C0']);
  var c1 = this._resolveVal(dict['/C1']);
  var n = this._resolveVal(dict['/N']);
  var domain = this._resolveVal(dict['/Domain']) || [0, 1];

  if (!Array.isArray(c0)) c0 = [0];
  if (!Array.isArray(c1)) c1 = [1];
  if (typeof n !== 'number') n = 1;

  return function(t) {
    // Clamp t to domain
    var dMin = domain[0] || 0;
    var dMax = domain[1] || 1;
    if (dMax === dMin) t = dMin;
    else t = Math.max(dMin, Math.min(dMax, t));

    // Normalize t to [0, 1] within domain
    var x = (dMax !== dMin) ? (t - dMin) / (dMax - dMin) : 0;

    var xn = Math.pow(Math.max(0, x), n);
    var result = [];
    for (var i = 0; i < c0.length; i++) {
      var v0 = typeof c0[i] === 'number' ? c0[i] : 0;
      var v1 = i < c1.length && typeof c1[i] === 'number' ? c1[i] : 1;
      result.push(v0 + xn * (v1 - v0));
    }
    return result;
  };
};

/**
 * Build a Type 3 (stitching) function.
 * Stitches together multiple sub-functions over domain intervals.
 *
 * @param {object} funcSpec - function dictionary
 * @returns {Function} f(t) -> array of values
 */
PDFRenderer.prototype._buildStitchingFunction = function(funcSpec) {
  var dict = funcSpec.dict || funcSpec;
  var functions = this._resolveVal(dict['/Functions']);
  var bounds = this._resolveVal(dict['/Bounds']);
  var encode = this._resolveVal(dict['/Encode']);
  var domain = this._resolveVal(dict['/Domain']) || [0, 1];

  if (!Array.isArray(functions) || !Array.isArray(bounds)) {
    return this._buildFallbackFunction(funcSpec);
  }

  // Build sub-functions
  var subFuncs = [];
  for (var fi = 0; fi < functions.length; fi++) {
    var subSpec = this._resolveVal(functions[fi]);
    subFuncs.push(this._buildSingleFunction(subSpec));
  }

  var self = this;

  return function(t) {
    // Clamp t to domain
    var dMin = domain[0] || 0;
    var dMax = domain[1] || 1;
    t = Math.max(dMin, Math.min(dMax, t));

    // Determine which sub-function to use based on bounds
    var k = subFuncs.length;
    var subIdx = 0;

    // bounds defines k-1 boundary values between domain[0] and domain[1]
    // Sub-function i covers [bounds[i-1], bounds[i]] (with bounds[-1]=domain[0], bounds[k-1]=domain[1])
    for (var bi = 0; bi < bounds.length; bi++) {
      if (t < bounds[bi]) {
        subIdx = bi;
        break;
      }
      subIdx = bi + 1;
    }

    if (subIdx >= k) subIdx = k - 1;

    // Determine the sub-domain for this segment
    var segStart = (subIdx === 0) ? dMin : bounds[subIdx - 1];
    var segEnd = (subIdx >= bounds.length) ? dMax : bounds[subIdx];

    // Encode: map [segStart, segEnd] -> [encode[2i], encode[2i+1]]
    var encStart = 0, encEnd = 1;
    if (Array.isArray(encode) && encode.length >= (subIdx * 2 + 2)) {
      encStart = encode[subIdx * 2];
      encEnd = encode[subIdx * 2 + 1];
    }

    // Linear interpolation
    var segT;
    if (segEnd === segStart) {
      segT = encStart;
    } else {
      segT = encStart + (t - segStart) / (segEnd - segStart) * (encEnd - encStart);
    }

    return subFuncs[subIdx](segT);
  };
};

/**
 * Build a fallback function for unsupported function types.
 * Uses endpoint values for a simple linear interpolation.
 *
 * @param {object} funcSpec - function dictionary
 * @returns {Function} f(t) -> array of values
 */
PDFRenderer.prototype._buildFallbackFunction = function(funcSpec) {
  var dict = funcSpec.dict || funcSpec;
  var range = this._resolveVal(dict['/Range']);
  var domain = this._resolveVal(dict['/Domain']) || [0, 1];

  // Try to extract meaningful endpoint colors from /Range
  if (Array.isArray(range) && range.length >= 2) {
    // Use the midpoint of each range pair as the constant color
    var values = [];
    for (var i = 0; i < range.length; i += 2) {
      var lo = typeof range[i] === 'number' ? range[i] : 0;
      var hi = typeof range[i + 1] === 'number' ? range[i + 1] : 1;
      values.push((lo + hi) / 2);
    }
    return function(t) { return values.slice(); };
  }

  // Default: return neutral gray
  return function(t) { return [0.5, 0.5, 0.5]; };
};

/**
 * Convert shading function output to a CSS color string.
 *
 * @param {number[]} color - array of color component values (0-1 range)
 * @param {string} csName - color space name
 * @returns {string} CSS color string
 */
PDFRenderer.prototype._shadingColorToCSS = function(color, csName) {
  if (!color || color.length === 0) return 'rgb(0,0,0)';

  if (csName === 'DeviceGray' || csName === 'CalGray' || color.length === 1) {
    var g = Math.max(0, Math.min(255, Math.round(color[0] * 255)));
    return 'rgb(' + g + ',' + g + ',' + g + ')';
  }

  if (csName === 'DeviceCMYK' || color.length === 4) {
    if (PDFImages) {
      var rgb = PDFImages.cmykToRGB(color[0], color[1], color[2], color[3]);
      return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
    }
    return 'rgb(0,0,0)';
  }

  // Default: RGB
  var r = Math.max(0, Math.min(255, Math.round((color[0] || 0) * 255)));
  var g = Math.max(0, Math.min(255, Math.round((color[1] || 0) * 255)));
  var b = Math.max(0, Math.min(255, Math.round((color[2] || 0) * 255)));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
};

// ============================================================================
// Character / Byte Utility Functions
// ============================================================================

function isWhitespaceChar(b) {
  return b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D || b === 0x0C || b === 0x00;
}

function isDelimiterChar(b) {
  return b === 0x28 || b === 0x29 || b === 0x3C || b === 0x3E ||
         b === 0x5B || b === 0x5D || b === 0x7B || b === 0x7D ||
         b === 0x2F || b === 0x25;
}

function isDigitChar(b) {
  return b >= 0x30 && b <= 0x39;
}

function isAlphaChar(b) {
  return (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A);
}

function bytesToString(bytes, start, end) {
  var str = '';
  for (var i = start; i < end; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}

function bytesMatch(bytes, pos, str) {
  for (var i = 0; i < str.length; i++) {
    if (pos + i >= bytes.length || bytes[pos + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

function resolveCSName(arg) {
  if (typeof arg === 'string') {
    var name = arg;
    if (name.charAt(0) === '/') name = name.substring(1);
    return name;
  }
  return 'DeviceGray';
}

// ============================================================================
// Module exports
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PDFRenderer: PDFRenderer,
    _parseInlineImageBlock: _parseInlineImageBlock,
    _getGlyphAdvance1000: _getGlyphAdvance1000,
    tokenizeContentStream: tokenizeContentStream,
    multiplyMatrix: multiplyMatrix,
    transformPoint: transformPoint,
    createDefaultGraphicsState: createDefaultGraphicsState,
    cloneGraphicsState: cloneGraphicsState,
    colorToCSS: colorToCSS,
  };
}
