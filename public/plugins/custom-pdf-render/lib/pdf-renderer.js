/**
 * PDF Page Renderer
 *
 * Content stream interpreter and canvas-based renderer for PDF pages.
 * Handles: graphics state (q/Q/cm), text operators (Tf, Tj, TJ, Tm, etc.),
 * path operators (m, l, c, re, S, f, etc.), clipping (W/W*),
 * color operators (g/G, rg/RG, k/K, cs/CS, sc/SC), and coordinate transforms.
 *
 * Built on top of Phase 1's PDFDocument and Phase 2a's PDFFonts.
 *
 * Public interface:
 *   PDFRenderer.renderPage(doc, pageNum, canvas, scale) - render a page
 *   PDFRenderer.PDFRenderError - error class
 */

'use strict';

// ============================================================================
// Dependencies (loaded via globals in browser, require in Node)
// ============================================================================

var _fonts, _parser, _security, _images, _shading;

if (typeof module !== 'undefined' && module.exports) {
  _fonts = require('./pdf-fonts.js');
  _parser = require('./pdf-parser.js');
  _security = require('./pdf-security.js');
  // Phase 2b modules - loaded lazily to avoid circular dependency at require time
  _images = null;
  _shading = null;
} else if (typeof window !== 'undefined') {
  _fonts = window.PDFFonts;
  _parser = window.PDFParser;
  _security = window.PDFSecurity;
  // Phase 2b modules will be available after their script tags load
  _images = null;
  _shading = null;
}

/**
 * Lazy-load Phase 2b modules to break circular dependency.
 * pdf-images.js and pdf-shading.js both require pdf-renderer.js,
 * so we load them after pdf-renderer.js has finished its initial exports.
 */
function getImages() {
  if (!_images) {
    if (typeof module !== 'undefined' && module.exports) {
      try { _images = require('./pdf-images.js'); } catch (e) { _images = null; }
    } else if (typeof window !== 'undefined') {
      _images = window.PDFImages || null;
    }
  }
  return _images;
}

function getShading() {
  if (!_shading) {
    if (typeof module !== 'undefined' && module.exports) {
      try { _shading = require('./pdf-shading.js'); } catch (e) { _shading = null; }
    } else if (typeof window !== 'undefined') {
      _shading = window.PDFShading || null;
    }
  }
  return _shading;
}

// ============================================================================
// Error
// ============================================================================

function PDFRenderError(message) {
  this.name = 'PDFRenderError';
  this.message = message;
}
PDFRenderError.prototype = Object.create(Error.prototype);
PDFRenderError.prototype.constructor = PDFRenderError;

// ============================================================================
// Constants
// ============================================================================

var MAX_OPERATORS = 1000000;  // Max operators per page
var MAX_NESTING_DEPTH = 50;   // Max q/Q nesting
var MAX_FORM_XOBJECT_DEPTH = 20; // Max recursive Form XObject depth

// ============================================================================
// Graphics State
// ============================================================================

/**
 * Represents the current graphics state.
 * The state is pushed/popped with q/Q operators.
 */
function GraphicsState() {
  // Current transformation matrix [a, b, c, d, e, f]
  // Maps user space to device space. Initialized to identity.
  this.ctm = [1, 0, 0, 1, 0, 0];

  // Fill color (CSS string)
  this.fillColor = 'rgb(0,0,0)';
  // Stroke color (CSS string)
  this.strokeColor = 'rgb(0,0,0)';

  // Fill color space name
  this.fillColorSpace = 'DeviceGray';
  // Stroke color space name
  this.strokeColorSpace = 'DeviceGray';

  // Line style
  this.lineWidth = 1.0;
  this.lineCap = 0;   // 0=butt, 1=round, 2=square
  this.lineJoin = 0;  // 0=miter, 1=round, 2=bevel
  this.miterLimit = 10.0;
  this.dashArray = [];
  this.dashPhase = 0;

  // Text state
  this.font = null;         // Resolved font object
  this.fontSize = 0;        // Font size in user units
  this.charSpacing = 0;     // Tc
  this.wordSpacing = 0;     // Tw
  this.horizontalScaling = 100; // Th (percentage)
  this.leading = 0;         // TL
  this.renderMode = 0;      // Tr (0=fill, 1=stroke, 2=fill+stroke, 3=invisible, etc.)
  this.rise = 0;            // Ts (text rise / superscript offset)

  // Text matrix and text line matrix (set by Tm, updated by Td/TD/T*/etc.)
  this.textMatrix = [1, 0, 0, 1, 0, 0];
  this.textLineMatrix = [1, 0, 0, 1, 0, 0];

  // Alpha
  this.fillAlpha = 1.0;     // ca
  this.strokeAlpha = 1.0;   // CA

  // Blend mode
  this.blendMode = 'Normal';

  // Active soft mask (SMask from ExtGState)
  this.activeSMask = null;

  // Clipping - tracked but applied via canvas clip
  this.hasClip = false;
  this.clipRule = 'nonzero'; // 'nonzero' or 'evenodd'
}

/**
 * Clone the graphics state (for q/push).
 */
GraphicsState.prototype.clone = function() {
  var gs = new GraphicsState();
  gs.ctm = this.ctm.slice();
  gs.fillColor = this.fillColor;
  gs.strokeColor = this.strokeColor;
  gs.fillColorSpace = this.fillColorSpace;
  gs.strokeColorSpace = this.strokeColorSpace;
  gs.lineWidth = this.lineWidth;
  gs.lineCap = this.lineCap;
  gs.lineJoin = this.lineJoin;
  gs.miterLimit = this.miterLimit;
  gs.dashArray = this.dashArray.slice();
  gs.dashPhase = this.dashPhase;
  gs.font = this.font;
  gs.fontSize = this.fontSize;
  gs.charSpacing = this.charSpacing;
  gs.wordSpacing = this.wordSpacing;
  gs.horizontalScaling = this.horizontalScaling;
  gs.leading = this.leading;
  gs.renderMode = this.renderMode;
  gs.rise = this.rise;
  gs.textMatrix = this.textMatrix.slice();
  gs.textLineMatrix = this.textLineMatrix.slice();
  gs.fillAlpha = this.fillAlpha;
  gs.strokeAlpha = this.strokeAlpha;
  gs.blendMode = this.blendMode;
  gs.activeSMask = this.activeSMask;
  gs.hasClip = false;       // Clip is not inherited in the cloned state
  gs.clipRule = 'nonzero';
  return gs;
};

// ============================================================================
// Matrix Operations
// ============================================================================

/**
 * Multiply two 3x2 affine matrices.
 * Matrices are stored as [a, b, c, d, e, f] representing:
 *   | a  b  0 |
 *   | c  d  0 |
 *   | e  f  1 |
 *
 * result = m1 x m2
 */
function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ];
}

/**
 * Transform a point [x, y] by a matrix.
 */
function transformPoint(m, x, y) {
  return [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5]
  ];
}

// ============================================================================
// Content Stream Tokenizer
// ============================================================================

/**
 * Tokenize a content stream into operator sequences.
 * Content streams use a postfix notation: operands precede the operator.
 *
 * Returns an array of { op: string, args: [] } objects.
 */
function tokenizeContentStream(data) {
  if (!data || data.length === 0) return [];

  var ops = [];
  var operandStack = [];
  var pos = 0;
  var len = data.length;
  var opCount = 0;

  while (pos < len) {
    // Skip whitespace
    while (pos < len && isContentWhitespace(data[pos])) {
      pos++;
    }
    if (pos >= len) break;

    var ch = data[pos];

    // Comment
    if (ch === 0x25) { // %
      while (pos < len && data[pos] !== 0x0A && data[pos] !== 0x0D) {
        pos++;
      }
      continue;
    }

    // Number (digit, sign, or decimal point)
    if (isDigitOrSign(ch) || ch === 0x2E) {
      var num = readContentNumber(data, pos);
      operandStack.push(num.value);
      pos = num.end;
      continue;
    }

    // Literal string (
    if (ch === 0x28) {
      var str = readContentLiteralString(data, pos);
      operandStack.push(str.value);
      pos = str.end;
      continue;
    }

    // Hex string <
    if (ch === 0x3C) {
      if (pos + 1 < len && data[pos + 1] === 0x3C) {
        // Dictionary << - treat as operator
        // In content streams, dictionaries appear in inline images (BI)
        var dict = readContentDictionary(data, pos);
        operandStack.push(dict.value);
        pos = dict.end;
        continue;
      }
      var hexStr = readContentHexString(data, pos);
      operandStack.push(hexStr.value);
      pos = hexStr.end;
      continue;
    }

    // Name /
    if (ch === 0x2F) {
      var name = readContentName(data, pos);
      operandStack.push(name.value);
      pos = name.end;
      continue;
    }

    // Array [
    if (ch === 0x5B) {
      var arr = readContentArray(data, pos);
      operandStack.push(arr.value);
      pos = arr.end;
      continue;
    }

    // Keyword / operator
    if (isAlpha(ch)) {
      var kw = readContentKeyword(data, pos);
      pos = kw.end;

      var keyword = kw.value;

      // Check if this is 'true', 'false', or 'null'
      if (keyword === 'true') {
        operandStack.push(true);
        continue;
      }
      if (keyword === 'false') {
        operandStack.push(false);
        continue;
      }
      if (keyword === 'null') {
        operandStack.push(null);
        continue;
      }

      // It's an operator - consume operands from stack
      ops.push({
        op: keyword,
        args: operandStack.splice(0)
      });

      opCount++;
      if (opCount > MAX_OPERATORS) {
        throw new PDFRenderError('Content stream operator count exceeds limit');
      }

      // Special handling for inline images (BI ... ID ... EI)
      if (keyword === 'BI') {
        var inlineImg = readInlineImage(data, pos);
        // Push the inline image dict and data as an operator
        ops[ops.length - 1].imageDict = inlineImg.dict;
        ops[ops.length - 1].imageData = inlineImg.data;
        pos = inlineImg.end;
      }

      continue;
    }

    // Unknown byte - skip
    pos++;
  }

  return ops;
}

// ---- Content stream tokenizer helpers ----

function isContentWhitespace(ch) {
  return ch === 0x00 || ch === 0x09 || ch === 0x0A || ch === 0x0C || ch === 0x0D || ch === 0x20;
}

function isDigitOrSign(ch) {
  return (ch >= 0x30 && ch <= 0x39) || ch === 0x2B || ch === 0x2D;
}

function isAlpha(ch) {
  return (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A) ||
         ch === 0x27 || ch === 0x22; // ' and " are also operators
}

function readContentNumber(data, pos) {
  var start = pos;
  var hasDecimal = false;
  if (data[pos] === 0x2B || data[pos] === 0x2D) pos++; // sign
  while (pos < data.length) {
    var ch = data[pos];
    if (ch >= 0x30 && ch <= 0x39) {
      pos++;
    } else if (ch === 0x2E && !hasDecimal) {
      hasDecimal = true;
      pos++;
    } else {
      break;
    }
  }
  var str = '';
  for (var i = start; i < pos; i++) str += String.fromCharCode(data[i]);
  var val = hasDecimal ? parseFloat(str) : parseInt(str, 10);
  if (!isFinite(val)) val = 0;
  return { value: val, end: pos };
}

function readContentLiteralString(data, pos) {
  pos++; // skip (
  var result = [];
  var depth = 1;
  while (pos < data.length && depth > 0) {
    var ch = data[pos++];
    if (ch === 0x5C) { // backslash
      if (pos >= data.length) break;
      var next = data[pos++];
      switch (next) {
        case 0x6E: result.push(0x0A); break;
        case 0x72: result.push(0x0D); break;
        case 0x74: result.push(0x09); break;
        case 0x62: result.push(0x08); break;
        case 0x66: result.push(0x0C); break;
        case 0x28: result.push(0x28); break;
        case 0x29: result.push(0x29); break;
        case 0x5C: result.push(0x5C); break;
        case 0x0D:
          if (pos < data.length && data[pos] === 0x0A) pos++;
          break;
        case 0x0A: break;
        default:
          if (next >= 0x30 && next <= 0x37) {
            var octal = next - 0x30;
            if (pos < data.length && data[pos] >= 0x30 && data[pos] <= 0x37) {
              octal = octal * 8 + (data[pos++] - 0x30);
              if (pos < data.length && data[pos] >= 0x30 && data[pos] <= 0x37) {
                octal = octal * 8 + (data[pos++] - 0x30);
              }
            }
            result.push(octal & 0xFF);
          } else {
            result.push(next);
          }
      }
    } else if (ch === 0x28) {
      depth++;
      result.push(ch);
    } else if (ch === 0x29) {
      depth--;
      if (depth > 0) result.push(ch);
    } else {
      result.push(ch);
    }
  }
  return { value: new Uint8Array(result), end: pos };
}

function readContentHexString(data, pos) {
  pos++; // skip <
  var hexChars = [];
  while (pos < data.length) {
    var ch = data[pos];
    if (ch === 0x3E) { pos++; break; }
    if (!isContentWhitespace(ch)) hexChars.push(ch);
    pos++;
  }
  var result = [];
  for (var i = 0; i < hexChars.length; i += 2) {
    var hi = hexNibble(hexChars[i]);
    var lo = (i + 1 < hexChars.length) ? hexNibble(hexChars[i + 1]) : 0;
    result.push((hi << 4) | lo);
  }
  return { value: new Uint8Array(result), end: pos };
}

function hexNibble(ch) {
  if (ch >= 0x30 && ch <= 0x39) return ch - 0x30;
  if (ch >= 0x41 && ch <= 0x46) return ch - 0x41 + 10;
  if (ch >= 0x61 && ch <= 0x66) return ch - 0x61 + 10;
  return 0;
}

function readContentName(data, pos) {
  pos++; // skip /
  var name = '';
  while (pos < data.length) {
    var ch = data[pos];
    if (isContentWhitespace(ch) || isContentDelimiter(ch)) break;
    if (ch === 0x23 && pos + 2 < data.length) {
      var hex = String.fromCharCode(data[pos + 1]) + String.fromCharCode(data[pos + 2]);
      var code = parseInt(hex, 16);
      if (!isNaN(code)) {
        name += String.fromCharCode(code);
        pos += 3;
        continue;
      }
    }
    name += String.fromCharCode(ch);
    pos++;
  }
  return { value: '/' + name, end: pos };
}

function readContentKeyword(data, pos) {
  var start = pos;
  while (pos < data.length) {
    var ch = data[pos];
    if (isContentWhitespace(ch) || isContentDelimiter(ch)) break;
    // Stop at the special quote/double-quote operators if they follow a number context
    pos++;
  }
  var kw = '';
  for (var i = start; i < pos; i++) kw += String.fromCharCode(data[i]);
  return { value: kw, end: pos };
}

function readContentArray(data, pos) {
  pos++; // skip [
  var arr = [];
  while (pos < data.length) {
    while (pos < data.length && isContentWhitespace(data[pos])) pos++;
    if (pos >= data.length) break;
    if (data[pos] === 0x5D) { pos++; break; } // ]

    var ch = data[pos];

    if (isDigitOrSign(ch) || ch === 0x2E) {
      var num = readContentNumber(data, pos);
      arr.push(num.value);
      pos = num.end;
    } else if (ch === 0x28) {
      var str = readContentLiteralString(data, pos);
      arr.push(str.value);
      pos = str.end;
    } else if (ch === 0x3C) {
      var hex = readContentHexString(data, pos);
      arr.push(hex.value);
      pos = hex.end;
    } else if (ch === 0x2F) {
      var name = readContentName(data, pos);
      arr.push(name.value);
      pos = name.end;
    } else if (ch === 0x5B) {
      var nested = readContentArray(data, pos);
      arr.push(nested.value);
      pos = nested.end;
    } else {
      // Skip unknown
      pos++;
    }
  }
  return { value: arr, end: pos };
}

function readContentDictionary(data, pos) {
  pos += 2; // skip <<
  var dict = {};
  while (pos < data.length) {
    while (pos < data.length && isContentWhitespace(data[pos])) pos++;
    if (pos >= data.length) break;
    // Check for >>
    if (data[pos] === 0x3E && pos + 1 < data.length && data[pos + 1] === 0x3E) {
      pos += 2;
      break;
    }
    // Read key (name)
    if (data[pos] !== 0x2F) { pos++; continue; }
    var key = readContentName(data, pos);
    pos = key.end;
    var keyStr = key.value.substring(1); // remove leading /

    while (pos < data.length && isContentWhitespace(data[pos])) pos++;
    if (pos >= data.length) break;

    // Read value
    var ch = data[pos];
    if (isDigitOrSign(ch) || ch === 0x2E) {
      var num = readContentNumber(data, pos);
      dict[keyStr] = num.value;
      pos = num.end;
    } else if (ch === 0x2F) {
      var name = readContentName(data, pos);
      dict[keyStr] = name.value.substring(1);
      pos = name.end;
    } else if (ch === 0x28) {
      var str = readContentLiteralString(data, pos);
      dict[keyStr] = str.value;
      pos = str.end;
    } else if (ch === 0x3C) {
      if (pos + 1 < data.length && data[pos + 1] === 0x3C) {
        var nestedDict = readContentDictionary(data, pos);
        dict[keyStr] = nestedDict.value;
        pos = nestedDict.end;
      } else {
        var hexStr = readContentHexString(data, pos);
        dict[keyStr] = hexStr.value;
        pos = hexStr.end;
      }
    } else if (ch === 0x5B) {
      var arr = readContentArray(data, pos);
      dict[keyStr] = arr.value;
      pos = arr.end;
    } else if (isAlpha(ch)) {
      var kw = readContentKeyword(data, pos);
      pos = kw.end;
      if (kw.value === 'true') dict[keyStr] = true;
      else if (kw.value === 'false') dict[keyStr] = false;
      else if (kw.value === 'null') dict[keyStr] = null;
      else dict[keyStr] = kw.value;
    } else {
      pos++;
    }
  }
  return { value: dict, end: pos };
}

function isContentDelimiter(ch) {
  return ch === 0x28 || ch === 0x29 || // ( )
         ch === 0x3C || ch === 0x3E || // < >
         ch === 0x5B || ch === 0x5D || // [ ]
         ch === 0x7B || ch === 0x7D || // { }
         ch === 0x2F ||               // /
         ch === 0x25;                 // %
}

/**
 * Read inline image data (after BI operator was consumed).
 * Reads the dictionary, then finds ID, then reads raw data until EI.
 */
function readInlineImage(data, pos) {
  // Parse inline image dictionary entries until 'ID'
  var dict = {};
  while (pos < data.length) {
    while (pos < data.length && isContentWhitespace(data[pos])) pos++;
    if (pos >= data.length) break;

    // Check for ID keyword
    if (data[pos] === 0x49 && pos + 1 < data.length && data[pos + 1] === 0x44) { // ID
      pos += 2;
      // Skip single whitespace after ID
      if (pos < data.length && (data[pos] === 0x20 || data[pos] === 0x0A || data[pos] === 0x0D)) {
        pos++;
      }
      break;
    }

    // Read key (name)
    if (data[pos] === 0x2F) {
      var key = readContentName(data, pos);
      pos = key.end;
      var keyStr = key.value.substring(1);

      // Expand abbreviated keys
      keyStr = expandInlineImageKey(keyStr);

      while (pos < data.length && isContentWhitespace(data[pos])) pos++;

      // Read value
      var ch = data[pos];
      if (isDigitOrSign(ch) || ch === 0x2E) {
        var num = readContentNumber(data, pos);
        dict[keyStr] = num.value;
        pos = num.end;
      } else if (ch === 0x2F) {
        var name = readContentName(data, pos);
        dict[keyStr] = expandInlineImageValue(name.value.substring(1));
        pos = name.end;
      } else if (ch === 0x5B) {
        var arr = readContentArray(data, pos);
        dict[keyStr] = arr.value;
        pos = arr.end;
      } else if (isAlpha(ch)) {
        var kw = readContentKeyword(data, pos);
        pos = kw.end;
        if (kw.value === 'true') dict[keyStr] = true;
        else if (kw.value === 'false') dict[keyStr] = false;
        else dict[keyStr] = expandInlineImageValue(kw.value);
      } else {
        pos++;
      }
    } else {
      // Not a name - check if it's the ID keyword
      var kw2 = readContentKeyword(data, pos);
      pos = kw2.end;
      if (kw2.value === 'ID') {
        if (pos < data.length && (data[pos] === 0x20 || data[pos] === 0x0A || data[pos] === 0x0D)) {
          pos++;
        }
        break;
      }
    }
  }

  // Read image data until EI
  var dataStart = pos;
  // Search for \nEI or \rEI or \r\nEI or <whitespace>EI<whitespace>
  while (pos < data.length - 1) {
    if (data[pos] === 0x45 && data[pos + 1] === 0x49) { // EI
      // Check that it's preceded by whitespace and followed by whitespace/EOF
      if (pos > dataStart &&
          isContentWhitespace(data[pos - 1]) &&
          (pos + 2 >= data.length || isContentWhitespace(data[pos + 2]) || isContentDelimiter(data[pos + 2]))) {
        break;
      }
    }
    pos++;
  }

  var imageDataBytes = data.subarray(dataStart, pos > 0 ? pos - 1 : pos); // exclude trailing whitespace before EI
  pos += 2; // skip EI

  return { dict: dict, data: imageDataBytes, end: pos };
}

function expandInlineImageKey(key) {
  var map = {
    'BPC': 'BitsPerComponent', 'CS': 'ColorSpace', 'D': 'Decode',
    'DP': 'DecodeParms', 'F': 'Filter', 'H': 'Height',
    'IM': 'ImageMask', 'I': 'Interpolate', 'W': 'Width'
  };
  return map[key] || key;
}

function expandInlineImageValue(val) {
  var map = {
    'G': 'DeviceGray', 'RGB': 'DeviceRGB', 'CMYK': 'DeviceCMYK',
    'I': 'Indexed', 'AHx': 'ASCIIHexDecode', 'A85': 'ASCII85Decode',
    'LZW': 'LZWDecode', 'Fl': 'FlateDecode', 'RL': 'RunLengthDecode',
    'CCF': 'CCITTFaxDecode', 'DCT': 'DCTDecode'
  };
  return map[val] || val;
}

// ============================================================================
// Color Space Resolution
// ============================================================================

/**
 * Resolve a color space name/array to a usable color space description.
 * Returns an object with { type, numComponents, lookup? }.
 */
function resolveColorSpace(cs, resources, doc) {
  if (!cs) return { type: 'DeviceGray', numComponents: 1 };

  if (typeof cs === 'string') {
    // Remove leading /
    if (cs.charAt(0) === '/') cs = cs.substring(1);

    switch (cs) {
      case 'DeviceGray': case 'G': return { type: 'DeviceGray', numComponents: 1 };
      case 'DeviceRGB': case 'RGB': return { type: 'DeviceRGB', numComponents: 3 };
      case 'DeviceCMYK': case 'CMYK': return { type: 'DeviceCMYK', numComponents: 4 };
      case 'Pattern': return { type: 'Pattern', numComponents: 0 };
      default:
        // Look up in resources ColorSpace dictionary
        if (resources && resources.ColorSpace) {
          var csDict = resources.ColorSpace;
          if (csDict && typeof csDict === 'object' && csDict.isRef && doc) {
            csDict = doc.resolveRef(csDict);
          }
          if (csDict && csDict[cs]) {
            var resolved = csDict[cs];
            if (resolved && typeof resolved === 'object' && resolved.isRef && doc) {
              resolved = doc.resolveRef(resolved);
            }
            return resolveColorSpace(resolved, resources, doc);
          }
        }
        return { type: 'DeviceGray', numComponents: 1 };
    }
  }

  if (Array.isArray(cs)) {
    var csType = cs[0];
    if (typeof csType === 'string' && csType.charAt(0) === '/') {
      csType = csType.substring(1);
    }
    if (typeof csType === 'object' && csType && csType.isRef && doc) {
      csType = doc.resolveRef(csType);
    }

    switch (csType) {
      case 'DeviceGray': return { type: 'DeviceGray', numComponents: 1 };
      case 'DeviceRGB': return { type: 'DeviceRGB', numComponents: 3 };
      case 'DeviceCMYK': return { type: 'DeviceCMYK', numComponents: 4 };
      case 'CalGray': return { type: 'DeviceGray', numComponents: 1 }; // Fallback
      case 'CalRGB': return { type: 'DeviceRGB', numComponents: 3 };  // Fallback
      case 'Lab': return { type: 'DeviceRGB', numComponents: 3 };     // Fallback
      case 'ICCBased':
        // Use the /N component count to determine the underlying color space
        if (cs.length > 1) {
          var iccStream = cs[1];
          if (iccStream && typeof iccStream === 'object' && iccStream.isRef && doc) {
            iccStream = doc.resolveRef(iccStream);
          }
          if (iccStream && typeof iccStream === 'object') {
            var n = iccStream.N || 1;
            if (n === 1) return { type: 'DeviceGray', numComponents: 1 };
            if (n === 3) return { type: 'DeviceRGB', numComponents: 3 };
            if (n === 4) return { type: 'DeviceCMYK', numComponents: 4 };
          }
        }
        return { type: 'DeviceRGB', numComponents: 3 };
      case 'Indexed':
        // Indexed [base hival lookup]
        var baseCS = cs.length > 1 ? resolveColorSpace(cs[1], resources, doc) : { type: 'DeviceRGB', numComponents: 3 };
        var hival = cs.length > 2 ? cs[2] : 255;
        if (typeof hival === 'object' && hival && hival.isRef && doc) {
          hival = doc.resolveRef(hival);
        }
        var lookup = cs.length > 3 ? cs[3] : null;
        if (lookup && typeof lookup === 'object' && lookup.isRef && doc) {
          lookup = doc.resolveRef(lookup);
        }
        // Resolve lookup if it is a stream
        if (lookup && typeof lookup === 'object' && lookup._isStream && doc) {
          try { lookup = doc.getStreamData(lookup); } catch (e) { lookup = null; }
        }
        return { type: 'Indexed', numComponents: 1, base: baseCS, hival: hival, lookup: lookup };
      case 'Separation':
        // [/Separation name alternateCS tintTransform]
        if (cs.length > 2) {
          var altCS = resolveColorSpace(cs[2], resources, doc);
          return { type: 'Separation', numComponents: 1, alternate: altCS };
        }
        return { type: 'DeviceGray', numComponents: 1 };
      case 'DeviceN':
        if (cs.length > 2) {
          var altCS2 = resolveColorSpace(cs[2], resources, doc);
          var numNames = Array.isArray(cs[1]) ? cs[1].length : 1;
          return { type: 'DeviceN', numComponents: numNames, alternate: altCS2 };
        }
        return { type: 'DeviceRGB', numComponents: 3 };
      case 'Pattern':
        return { type: 'Pattern', numComponents: 0 };
      default:
        return { type: 'DeviceGray', numComponents: 1 };
    }
  }

  return { type: 'DeviceGray', numComponents: 1 };
}

/**
 * Convert color components to a CSS color string.
 *
 * @param {string} colorSpaceType - e.g., 'DeviceGray', 'DeviceRGB', 'DeviceCMYK'
 * @param {Array<number>} components - Color component values (0.0 to 1.0)
 * @returns {string} CSS color string
 */
function colorToCSS(colorSpaceType, components) {
  if (!components || components.length === 0) return 'rgb(0,0,0)';

  switch (colorSpaceType) {
    case 'DeviceGray':
      var gray = Math.round(clamp(components[0], 0, 1) * 255);
      return 'rgb(' + gray + ',' + gray + ',' + gray + ')';

    case 'DeviceRGB':
      var r = Math.round(clamp(components[0] || 0, 0, 1) * 255);
      var g = Math.round(clamp(components[1] || 0, 0, 1) * 255);
      var b = Math.round(clamp(components[2] || 0, 0, 1) * 255);
      return 'rgb(' + r + ',' + g + ',' + b + ')';

    case 'DeviceCMYK':
      // CMYK to RGB approximation
      var c = clamp(components[0] || 0, 0, 1);
      var m = clamp(components[1] || 0, 0, 1);
      var y = clamp(components[2] || 0, 0, 1);
      var k = clamp(components[3] || 0, 0, 1);
      var rr = Math.round(255 * (1 - c) * (1 - k));
      var gg = Math.round(255 * (1 - m) * (1 - k));
      var bb = Math.round(255 * (1 - y) * (1 - k));
      return 'rgb(' + rr + ',' + gg + ',' + bb + ')';

    default:
      // Fallback: treat as gray
      if (components.length === 1) {
        var grayVal = Math.round(clamp(components[0], 0, 1) * 255);
        return 'rgb(' + grayVal + ',' + grayVal + ',' + grayVal + ')';
      }
      if (components.length >= 3) {
        return 'rgb(' +
          Math.round(clamp(components[0], 0, 1) * 255) + ',' +
          Math.round(clamp(components[1], 0, 1) * 255) + ',' +
          Math.round(clamp(components[2], 0, 1) * 255) + ')';
      }
      return 'rgb(0,0,0)';
  }
}

function clamp(val, min, max) {
  if (val < min) return min;
  if (val > max) return max;
  return val;
}

// ============================================================================
// Page Renderer
// ============================================================================

/**
 * Render a PDF page to a canvas.
 *
 * @param {object} doc - PDFDocument instance (parsed)
 * @param {number} pageNum - 1-based page number
 * @param {HTMLCanvasElement|object} canvas - Canvas element (or mock for testing)
 * @param {number} [scale=1.0] - Scale factor (1.0 = 72 DPI)
 * @returns {object} Render result { width, height, operatorCount }
 */
function renderPage(doc, pageNum, canvas, scale) {
  scale = scale || 1.0;

  var page = doc.getPage(pageNum);
  var mediaBox = page.CropBox || page.MediaBox;
  if (!mediaBox || !Array.isArray(mediaBox) || mediaBox.length < 4) {
    throw new PDFRenderError('Page has no valid MediaBox');
  }

  // Resolve MediaBox values
  for (var mi = 0; mi < mediaBox.length; mi++) {
    if (typeof mediaBox[mi] === 'object' && mediaBox[mi] && mediaBox[mi].isRef) {
      mediaBox[mi] = doc.resolveRef(mediaBox[mi]);
    }
    mediaBox[mi] = typeof mediaBox[mi] === 'number' ? mediaBox[mi] : 0;
  }

  var pageX = mediaBox[0];
  var pageY = mediaBox[1];
  var pageWidth = mediaBox[2] - mediaBox[0];
  var pageHeight = mediaBox[3] - mediaBox[1];

  // Handle rotation
  var rotate = page.Rotate || 0;
  if (typeof rotate === 'object' && rotate && rotate.isRef) {
    rotate = doc.resolveRef(rotate);
  }
  rotate = typeof rotate === 'number' ? rotate : 0;
  // Normalize rotation to 0, 90, 180, 270
  rotate = ((rotate % 360) + 360) % 360;

  var canvasWidth, canvasHeight;
  if (rotate === 90 || rotate === 270) {
    canvasWidth = Math.abs(pageHeight) * scale;
    canvasHeight = Math.abs(pageWidth) * scale;
  } else {
    canvasWidth = Math.abs(pageWidth) * scale;
    canvasHeight = Math.abs(pageHeight) * scale;
  }

  // Set canvas size
  canvas.width = Math.ceil(canvasWidth);
  canvas.height = Math.ceil(canvasHeight);

  var ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new PDFRenderError('Cannot get 2D rendering context');
  }

  // Clear canvas to white
  ctx.fillStyle = 'rgb(255,255,255)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Set up the initial transformation:
  // PDF coordinate system: origin at lower-left, y increases upward
  // Canvas coordinate system: origin at upper-left, y increases downward
  // We need to flip Y and scale.

  ctx.save();

  // Apply scale
  ctx.scale(scale, scale);

  // Apply rotation and flip
  switch (rotate) {
    case 0:
      // Flip Y: translate to bottom, scale y by -1
      ctx.transform(1, 0, 0, -1, -pageX, pageHeight + pageY);
      break;
    case 90:
      ctx.transform(0, -1, -1, 0, pageHeight + pageY, pageWidth + pageX);
      break;
    case 180:
      ctx.transform(-1, 0, 0, 1, pageWidth + pageX, -pageY);
      break;
    case 270:
      ctx.transform(0, 1, 1, 0, -pageY, -pageX);
      break;
  }

  // Get page resources
  var resources = page.Resources;
  if (resources && typeof resources === 'object' && resources.isRef) {
    resources = doc.resolveRef(resources);
  }
  resources = resources || {};

  // Get content stream
  var contentData;
  try {
    contentData = doc.getPageContentStream(pageNum);
  } catch (e) {
    ctx.restore();
    throw new PDFRenderError('Failed to decode content stream: ' + e.message);
  }

  // Tokenize the content stream
  var ops;
  try {
    ops = tokenizeContentStream(contentData);
  } catch (e) {
    ctx.restore();
    throw new PDFRenderError('Failed to tokenize content stream: ' + e.message);
  }

  // Execute operators
  var state = new GraphicsState();
  var stateStack = [];
  var operatorCount = 0;

  try {
    executeOperators(ctx, ops, state, stateStack, resources, doc, 0);
    operatorCount = ops.length;
  } catch (e) {
    // Log but don't throw - partial rendering is better than nothing
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('Render warning: ' + e.message);
    }
  }

  ctx.restore();

  return {
    width: canvas.width,
    height: canvas.height,
    operatorCount: operatorCount
  };
}

// ============================================================================
// Operator Execution
// ============================================================================

/**
 * Execute a sequence of content stream operators.
 */
function executeOperators(ctx, ops, state, stateStack, resources, doc, formDepth) {
  if (formDepth > MAX_FORM_XOBJECT_DEPTH) {
    throw new PDFRenderError('Form XObject nesting depth exceeded');
  }

  // Resolve font resources once
  var fontResources = null;
  if (resources && resources.Font) {
    fontResources = resources.Font;
    if (fontResources && typeof fontResources === 'object' && fontResources.isRef) {
      fontResources = doc.resolveRef(fontResources);
    }
  }

  // Cache resolved fonts
  var fontCache = {};
  var needsNewPath = true;

  var _trace = (typeof window !== 'undefined' && window._traceOps);
  var _traceLog = _trace ? [] : null;

  for (var i = 0; i < ops.length; i++) {
    var entry = ops[i];
    var op = entry.op;
    var args = entry.args;

    if (_trace && (op === 'q' || op === 'Q' || op === 'gs' || op === 'S' || op === 'f' || op === 'F' || op === 'f*' || op === 'B' || op === 'B*' || op === 'n' || op === 'Do')) {
      var info = op;
      if (op === 'gs') info += ' ' + args[0];
      if (op === 'S' || op === 'f' || op === 'F') info += ' sA=' + state.strokeAlpha.toFixed(3) + ' fA=' + state.fillAlpha.toFixed(3);
      if (op === 'Do') info += ' ' + args[0];
      _traceLog.push(info);
      if (_traceLog.length >= 500) { console.log('[TRACE depth=' + formDepth + '] ' + _traceLog.join(' | ')); _traceLog = []; }
    }

    switch (op) {
      // ---- Graphics State Operators ----
      case 'q': // Save graphics state
        if (stateStack.length >= MAX_NESTING_DEPTH) {
          throw new PDFRenderError('Graphics state stack overflow');
        }
        stateStack.push(state.clone());
        ctx.save();
        break;

      case 'Q': // Restore graphics state
        if (stateStack.length > 0) {
          var prevAlpha = state.strokeAlpha;
          state = stateStack.pop();
          if (window._dbgGS && prevAlpha < 0.99 && state.strokeAlpha > 0.99) {
            console.log('[Q] alpha restored from ' + prevAlpha.toFixed(4) + ' to ' + state.strokeAlpha.toFixed(4));
          }
          ctx.restore();
        }
        break;

      case 'cm': // Concatenate matrix
        if (args.length >= 6) {
          var cm = [args[0], args[1], args[2], args[3], args[4], args[5]];
          state.ctm = multiplyMatrix(cm, state.ctm);
          ctx.transform(args[0], args[1], args[2], args[3], args[4], args[5]);
        }
        break;

      case 'w': // Set line width
        if (args.length >= 1) {
          state.lineWidth = args[0];
          ctx.lineWidth = args[0];
        }
        break;

      case 'J': // Set line cap
        if (args.length >= 1) {
          state.lineCap = args[0];
          ctx.lineCap = ['butt', 'round', 'square'][args[0]] || 'butt';
        }
        break;

      case 'j': // Set line join
        if (args.length >= 1) {
          state.lineJoin = args[0];
          ctx.lineJoin = ['miter', 'round', 'bevel'][args[0]] || 'miter';
        }
        break;

      case 'M': // Set miter limit
        if (args.length >= 1) {
          state.miterLimit = args[0];
          ctx.miterLimit = args[0];
        }
        break;

      case 'd': // Set dash pattern
        if (args.length >= 2) {
          var dashArr = Array.isArray(args[0]) ? args[0] : [];
          var dashPhase = typeof args[1] === 'number' ? args[1] : 0;
          state.dashArray = dashArr;
          state.dashPhase = dashPhase;
          if (ctx.setLineDash) {
            ctx.setLineDash(dashArr);
            ctx.lineDashOffset = dashPhase;
          }
        }
        break;

      case 'ri': // Set rendering intent (ignored - canvas doesn't support it)
        break;

      case 'i': // Set flatness tolerance (ignored)
        break;

      case 'gs': // Set graphics state from ExtGState
        if (args.length >= 1) {
          applyExtGState(ctx, state, args[0], resources, doc);
        }
        break;

      // ---- Path Construction Operators ----
      case 'm': // moveTo (starts a new subpath, not a new path)
        if (args.length >= 2) {
          if (needsNewPath) {
            ctx.beginPath();
            needsNewPath = false;
          }
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

      case 'v': // curveTo (first control point = current point)
        if (args.length >= 4) {
          // Get current point - approximate with args
          ctx.bezierCurveTo(args[0], args[1], args[0], args[1], args[2], args[3]);
        }
        break;

      case 'y': // curveTo (second control point = end point)
        if (args.length >= 4) {
          ctx.bezierCurveTo(args[0], args[1], args[2], args[3], args[2], args[3]);
        }
        break;

      case 'h': // closePath
        ctx.closePath();
        break;

      case 're': // rectangle (appends to current path)
        if (args.length >= 4) {
          if (needsNewPath) {
            ctx.beginPath();
            needsNewPath = false;
          }
          ctx.rect(args[0], args[1], args[2], args[3]);
        }
        break;

      // ---- Path Painting Operators ----
      case 'S': // Stroke
        applyStrokeStyle(ctx, state);
        if (window._dbgGS && window._dbgStroke && window._dbgStroke-- > 0) {
          console.log('[S] lw=' + state.lineWidth + ' strokeA=' + state.strokeAlpha.toFixed(4) + ' fillA=' + state.fillAlpha.toFixed(4) + ' color=' + state.strokeColor);
        }
        ctx.stroke();
        if (state.hasClip) {
          applyClip(ctx, state);
        }
        needsNewPath = true;
        break;

      case 's': // Close and stroke
        ctx.closePath();
        applyStrokeStyle(ctx, state);
        ctx.stroke();
        if (state.hasClip) {
          applyClip(ctx, state);
        }
        needsNewPath = true;
        break;

      case 'f': // Fill (nonzero winding)
      case 'F': // Fill (same as f, PDF 1.0 compatibility)
        applyFillStyle(ctx, state);
        if (window._dbgGS && window._dbgStroke && window._dbgStroke-- > 0) {
          console.log('[f] fillA=' + state.fillAlpha.toFixed(4) + ' color=' + state.fillColor);
        }
        ctx.fill('nonzero');
        if (state.hasClip) {
          applyClip(ctx, state);
        }
        needsNewPath = true;
        break;

      case 'f*': // Fill (even-odd)
        applyFillStyle(ctx, state);
        ctx.fill('evenodd');
        if (state.hasClip) {
          applyClip(ctx, state);
        }
        needsNewPath = true;
        break;

      case 'B': // Fill and stroke (nonzero)
        applyFillStyle(ctx, state);
        ctx.fill('nonzero');
        applyStrokeStyle(ctx, state);
        ctx.stroke();
        if (state.hasClip) {
          applyClip(ctx, state);
        }
        needsNewPath = true;
        break;

      case 'B*': // Fill and stroke (even-odd)
        applyFillStyle(ctx, state);
        ctx.fill('evenodd');
        applyStrokeStyle(ctx, state);
        ctx.stroke();
        if (state.hasClip) {
          applyClip(ctx, state);
        }
        needsNewPath = true;
        break;

      case 'b': // Close, fill and stroke (nonzero)
        ctx.closePath();
        applyFillStyle(ctx, state);
        ctx.fill('nonzero');
        applyStrokeStyle(ctx, state);
        ctx.stroke();
        if (state.hasClip) {
          applyClip(ctx, state);
        }
        needsNewPath = true;
        break;

      case 'b*': // Close, fill and stroke (even-odd)
        ctx.closePath();
        applyFillStyle(ctx, state);
        ctx.fill('evenodd');
        applyStrokeStyle(ctx, state);
        ctx.stroke();
        if (state.hasClip) {
          applyClip(ctx, state);
        }
        needsNewPath = true;
        break;

      case 'n': // End path without fill or stroke (path used for clipping only)
        if (state.hasClip) {
          applyClip(ctx, state);
        }
        needsNewPath = true;
        break;

      // ---- Clipping Operators ----
      case 'W': // Clip (nonzero)
        state.hasClip = true;
        state.clipRule = 'nonzero';
        break;

      case 'W*': // Clip (even-odd)
        state.hasClip = true;
        state.clipRule = 'evenodd';
        break;

      // ---- Text State Operators ----
      case 'Tc': // Set character spacing
        if (args.length >= 1) state.charSpacing = args[0];
        break;

      case 'Tw': // Set word spacing
        if (args.length >= 1) state.wordSpacing = args[0];
        break;

      case 'Tz': // Set horizontal scaling
        if (args.length >= 1) state.horizontalScaling = args[0];
        break;

      case 'TL': // Set text leading
        if (args.length >= 1) state.leading = args[0];
        break;

      case 'Tf': // Set font and size
        if (args.length >= 2) {
          var fontName = args[0];
          if (typeof fontName === 'string' && fontName.charAt(0) === '/') {
            fontName = fontName.substring(1);
          }
          state.fontSize = args[1];

          // Resolve the font from resources
          if (fontResources && fontResources[fontName]) {
            if (!fontCache[fontName]) {
              var fontRef = fontResources[fontName];
              if (fontRef && typeof fontRef === 'object' && fontRef.isRef) {
                fontRef = doc.resolveRef(fontRef);
              }
              fontCache[fontName] = _fonts.resolveFont(fontRef, doc);
            }
            state.font = fontCache[fontName];
          } else {
            // Create a default font
            state.font = _fonts.createDefaultFont();
          }
        }
        break;

      case 'Tr': // Set text rendering mode
        if (args.length >= 1) state.renderMode = args[0];
        break;

      case 'Ts': // Set text rise
        if (args.length >= 1) state.rise = args[0];
        break;

      // ---- Text Object Operators ----
      case 'BT': // Begin text object
        state.textMatrix = [1, 0, 0, 1, 0, 0];
        state.textLineMatrix = [1, 0, 0, 1, 0, 0];
        break;

      case 'ET': // End text object
        break;

      // ---- Text Positioning Operators ----
      case 'Td': // Move to start of next line
        if (args.length >= 2) {
          var tx = args[0], ty = args[1];
          state.textLineMatrix = multiplyMatrix([1, 0, 0, 1, tx, ty], state.textLineMatrix);
          state.textMatrix = state.textLineMatrix.slice();
        }
        break;

      case 'TD': // Move to start of next line, set leading
        if (args.length >= 2) {
          state.leading = -args[1]; // TL = -ty
          state.textLineMatrix = multiplyMatrix([1, 0, 0, 1, args[0], args[1]], state.textLineMatrix);
          state.textMatrix = state.textLineMatrix.slice();
        }
        break;

      case 'Tm': // Set text matrix
        if (args.length >= 6) {
          state.textMatrix = [args[0], args[1], args[2], args[3], args[4], args[5]];
          state.textLineMatrix = state.textMatrix.slice();
        }
        break;

      case 'T*': // Move to start of next line (using leading)
        state.textLineMatrix = multiplyMatrix([1, 0, 0, 1, 0, -state.leading], state.textLineMatrix);
        state.textMatrix = state.textLineMatrix.slice();
        break;

      // ---- Text Showing Operators ----
      case 'Tj': // Show string
        if (args.length >= 1) {
          renderTextString(ctx, state, args[0], resources, doc);
        }
        break;

      case 'TJ': // Show string array (with positioning)
        if (args.length >= 1 && Array.isArray(args[0])) {
          renderTextArray(ctx, state, args[0], resources, doc);
        }
        break;

      case "'": // Move to next line and show string (quote)
        // Equivalent to: T* Tj
        state.textLineMatrix = multiplyMatrix([1, 0, 0, 1, 0, -state.leading], state.textLineMatrix);
        state.textMatrix = state.textLineMatrix.slice();
        if (args.length >= 1) {
          renderTextString(ctx, state, args[0], resources, doc);
        }
        break;

      case '"': // Set spacing, move to next line, show string (double quote)
        // Equivalent to: Tw aw Tc ac T* Tj
        if (args.length >= 3) {
          state.wordSpacing = args[0];
          state.charSpacing = args[1];
          state.textLineMatrix = multiplyMatrix([1, 0, 0, 1, 0, -state.leading], state.textLineMatrix);
          state.textMatrix = state.textLineMatrix.slice();
          renderTextString(ctx, state, args[2], resources, doc);
        }
        break;

      // ---- Color Operators ----
      case 'CS': // Set stroke color space
        if (args.length >= 1) {
          var csName = args[0];
          if (typeof csName === 'string' && csName.charAt(0) === '/') csName = csName.substring(1);
          state.strokeColorSpace = csName;
        }
        break;

      case 'cs': // Set fill color space
        if (args.length >= 1) {
          var csName2 = args[0];
          if (typeof csName2 === 'string' && csName2.charAt(0) === '/') csName2 = csName2.substring(1);
          state.fillColorSpace = csName2;
        }
        break;

      case 'SC': // Set stroke color (DeviceGray/RGB/CMYK)
      case 'SCN': // Set stroke color (any color space, with optional pattern)
        if (args.length >= 1) {
          // Check for Pattern color space
          if (state.strokeColorSpace === 'Pattern' && op === 'SCN') {
            var patNameS = args[args.length - 1];
            if (typeof patNameS === 'string') {
              if (patNameS.charAt(0) === '/') patNameS = patNameS.substring(1);
              var shadingS = getShading();
              if (shadingS) {
                var patFillS = shadingS.resolvePatternFill(ctx, patNameS, resources, doc);
                if (patFillS) {
                  state.strokeColor = patFillS;
                  break;
                }
              }
            }
          }
          var resolved = resolveColorSpaceName(state.strokeColorSpace, resources, doc);
          state.strokeColor = colorToCSS(resolved, args);
        }
        break;

      case 'sc': // Set fill color
      case 'scn': // Set fill color (any color space, with optional pattern)
        if (args.length >= 1) {
          // Check for Pattern color space
          if (state.fillColorSpace === 'Pattern' && op === 'scn') {
            var patNameF = args[args.length - 1];
            if (typeof patNameF === 'string') {
              if (patNameF.charAt(0) === '/') patNameF = patNameF.substring(1);
              var shadingF = getShading();
              if (shadingF) {
                var patFillF = shadingF.resolvePatternFill(ctx, patNameF, resources, doc);
                if (patFillF) {
                  state.fillColor = patFillF;
                  break;
                }
              }
            }
          }
          var resolved2 = resolveColorSpaceName(state.fillColorSpace, resources, doc);
          state.fillColor = colorToCSS(resolved2, args);
        }
        break;

      case 'G': // Set stroke color (DeviceGray)
        if (args.length >= 1) {
          state.strokeColorSpace = 'DeviceGray';
          state.strokeColor = colorToCSS('DeviceGray', [args[0]]);
        }
        break;

      case 'g': // Set fill color (DeviceGray)
        if (args.length >= 1) {
          state.fillColorSpace = 'DeviceGray';
          state.fillColor = colorToCSS('DeviceGray', [args[0]]);
        }
        break;

      case 'RG': // Set stroke color (DeviceRGB)
        if (args.length >= 3) {
          state.strokeColorSpace = 'DeviceRGB';
          state.strokeColor = colorToCSS('DeviceRGB', [args[0], args[1], args[2]]);
        }
        break;

      case 'rg': // Set fill color (DeviceRGB)
        if (args.length >= 3) {
          state.fillColorSpace = 'DeviceRGB';
          state.fillColor = colorToCSS('DeviceRGB', [args[0], args[1], args[2]]);
        }
        break;

      case 'K': // Set stroke color (DeviceCMYK)
        if (args.length >= 4) {
          state.strokeColorSpace = 'DeviceCMYK';
          state.strokeColor = colorToCSS('DeviceCMYK', [args[0], args[1], args[2], args[3]]);
        }
        break;

      case 'k': // Set fill color (DeviceCMYK)
        if (args.length >= 4) {
          state.fillColorSpace = 'DeviceCMYK';
          state.fillColor = colorToCSS('DeviceCMYK', [args[0], args[1], args[2], args[3]]);
        }
        break;

      // ---- XObject / Form / Image Operators ----
      case 'Do': // Invoke named XObject
        if (args.length >= 1) {
          var xobjName = args[0];
          if (typeof xobjName === 'string' && xobjName.charAt(0) === '/') {
            xobjName = xobjName.substring(1);
          }
          renderXObject(ctx, state, stateStack, xobjName, resources, doc, formDepth);
        }
        break;

      // ---- Inline Image ----
      case 'BI':
        // Inline image was parsed during tokenization
        // The dict and data are attached to the op entry
        if (entry.imageDict && entry.imageData) {
          var images2 = getImages();
          if (images2) {
            images2.renderInlineImage(ctx, state, entry.imageDict, entry.imageData, resources, doc);
          }
        }
        break;

      // ---- Marked Content (ignored) ----
      case 'BMC': case 'BDC': case 'EMC': case 'MP': case 'DP':
        break;

      // ---- Compatibility (ignored) ----
      case 'BX': case 'EX':
        break;

      // ---- Type 3 Font (d0, d1) ----
      case 'd0': case 'd1':
        break;

      // ---- Shading ----
      case 'sh':
        if (args.length >= 1) {
          var shadingMod = getShading();
          if (shadingMod) {
            shadingMod.renderShading(ctx, state, args[0], resources, doc);
          }
        }
        break;

      default:
        // Unknown operator - ignore
        break;
    }
  }

  if (_trace && _traceLog && _traceLog.length > 0) {
    console.log('[TRACE depth=' + formDepth + '] ' + _traceLog.join(' | '));
  }
  return state;
}

// ============================================================================
// Helper Functions for Rendering
// ============================================================================

/**
 * Resolve a color space name through resources to its type string.
 */
function resolveColorSpaceName(csName, resources, doc) {
  if (!csName) return 'DeviceGray';

  switch (csName) {
    case 'DeviceGray': case 'G': return 'DeviceGray';
    case 'DeviceRGB': case 'RGB': return 'DeviceRGB';
    case 'DeviceCMYK': case 'CMYK': return 'DeviceCMYK';
    default:
      // Look up in resources
      if (resources && resources.ColorSpace) {
        var csDict = resources.ColorSpace;
        if (csDict && typeof csDict === 'object' && csDict.isRef && doc) {
          csDict = doc.resolveRef(csDict);
        }
        if (csDict && csDict[csName]) {
          var csSpec = csDict[csName];
          if (csSpec && typeof csSpec === 'object' && csSpec.isRef && doc) {
            csSpec = doc.resolveRef(csSpec);
          }
          var resolved = resolveColorSpace(csSpec, resources, doc);
          return resolved.type;
        }
      }
      return 'DeviceGray';
  }
}

/**
 * Apply fill style to canvas context from current state.
 */
function applyFillStyle(ctx, state) {
  ctx.fillStyle = state.fillColor;
  ctx.globalAlpha = state.fillAlpha;
}

/**
 * Apply stroke style to canvas context from current state.
 */
function applyStrokeStyle(ctx, state) {
  ctx.strokeStyle = state.strokeColor;
  ctx.lineWidth = state.lineWidth;
  ctx.globalAlpha = state.strokeAlpha;
}

/**
 * Apply clipping from current state.
 */
function applyClip(ctx, state) {
  if (state.clipRule === 'evenodd') {
    ctx.clip('evenodd');
  } else {
    ctx.clip('nonzero');
  }
  state.hasClip = false;
}

/**
 * Apply ExtGState parameters.
 */
function applyExtGState(ctx, state, gsName, resources, doc) {
  if (typeof gsName === 'string' && gsName.charAt(0) === '/') {
    gsName = gsName.substring(1);
  }

  if (!resources || !resources.ExtGState) return;

  var gsDict = resources.ExtGState;
  if (gsDict && typeof gsDict === 'object' && gsDict.isRef && doc) {
    gsDict = doc.resolveRef(gsDict);
  }
  if (!gsDict || !gsDict[gsName]) return;

  var gs = gsDict[gsName];
  if (gs && typeof gs === 'object' && gs.isRef && doc) {
    gs = doc.resolveRef(gs);
  }
  if (!gs || typeof gs !== 'object') return;

  // Fill alpha
  if (typeof gs.ca === 'number') {
    state.fillAlpha = clamp(gs.ca, 0, 1);
  }
  // Stroke alpha
  if (typeof gs.CA === 'number') {
    state.strokeAlpha = clamp(gs.CA, 0, 1);
  }
  // debug removed
  // Line width
  if (typeof gs.LW === 'number') {
    state.lineWidth = gs.LW;
    ctx.lineWidth = gs.LW;
  }
  // Line cap
  if (typeof gs.LC === 'number') {
    state.lineCap = gs.LC;
    ctx.lineCap = ['butt', 'round', 'square'][gs.LC] || 'butt';
  }
  // Line join
  if (typeof gs.LJ === 'number') {
    state.lineJoin = gs.LJ;
    ctx.lineJoin = ['miter', 'round', 'bevel'][gs.LJ] || 'miter';
  }
  // Miter limit
  if (typeof gs.ML === 'number') {
    state.miterLimit = gs.ML;
    ctx.miterLimit = gs.ML;
  }
  // Blend mode
  if (gs.BM !== undefined && gs.BM !== null) {
    var bmName;
    if (Array.isArray(gs.BM)) {
      bmName = gs.BM[0]; // Use first blend mode if array
    } else {
      bmName = gs.BM;
    }
    if (typeof bmName === 'string') {
      if (bmName.charAt(0) === '/') bmName = bmName.substring(1);
      state.blendMode = bmName;
      ctx.globalCompositeOperation = pdfBlendModeToCanvas(bmName);
    }
  }
  // Soft mask from ExtGState (/SMask)
  if (gs.SMask !== undefined) {
    var smaskVal = gs.SMask;
    if (smaskVal && typeof smaskVal === 'object' && smaskVal.isRef && doc) {
      smaskVal = doc.resolveRef(smaskVal);
    }
    if (smaskVal === 'None' || smaskVal === '/None') {
      state.activeSMask = null;
    } else if (smaskVal && typeof smaskVal === 'object') {
      state.activeSMask = smaskVal;
    }
  }
  // Font
  if (Array.isArray(gs.Font) && gs.Font.length >= 2) {
    // gs.Font = [fontRef, size]
    state.fontSize = gs.Font[1];
  }
  // Dash pattern
  if (Array.isArray(gs.D) && gs.D.length >= 2) {
    var dashArr = Array.isArray(gs.D[0]) ? gs.D[0] : [];
    var dashPhase = typeof gs.D[1] === 'number' ? gs.D[1] : 0;
    state.dashArray = dashArr;
    state.dashPhase = dashPhase;
    if (ctx.setLineDash) {
      ctx.setLineDash(dashArr);
      ctx.lineDashOffset = dashPhase;
    }
  }
}

/**
 * Map PDF blend mode to canvas globalCompositeOperation.
 */
function pdfBlendModeToCanvas(bm) {
  var map = {
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
    'Exclusion': 'exclusion'
  };
  return map[bm] || 'source-over';
}

// ============================================================================
// Text Rendering
// ============================================================================

/**
 * Render a text string (Tj operator).
 */
function renderTextString(ctx, state, strData, resources, doc) {
  if (!state.font || state.fontSize === 0) return;

  var font = state.font;
  var fontSize = state.fontSize;
  var charSpacing = state.charSpacing;
  var wordSpacing = state.wordSpacing;
  var hScale = state.horizontalScaling / 100;
  var rise = state.rise;
  var renderMode = state.renderMode;

  // Use a fixed CSS font unit size for rendering. This avoids browser
  // quirks with very small/large font sizes (e.g., minimum font size
  // clamping, sub-pixel hinting differences). The actual visual size is
  // achieved entirely through the canvas transform matrix.
  //
  // The PDF text rendering matrix (Trm) per ISO 32000 sec 9.4.4 is:
  //   Trm = [Tfs*Th, 0, 0, Tfs, 0, Trise] * Tm * CTM
  //
  // We factor it as:  CSS_UNIT * (Tfs/CSS_UNIT) * [Th,0,0,1,0,rise] * Tm * CTM
  // The CSS font is rendered at CSS_UNIT px, and (Tfs/CSS_UNIT) goes into the transform.
  var CSS_UNIT = 100;
  var fontScale = fontSize / CSS_UNIT; // may be negative (mirrored text)

  var fontStyle = font.cssStyle || '';
  var fontWeight = font.cssWeight || 'normal';
  var fontFamily = font.cssFamily || 'sans-serif';

  ctx.font = (fontStyle ? fontStyle + ' ' : '') + fontWeight + ' ' + CSS_UNIT + 'px ' + fontFamily;

  // Process each character in the string
  var bytes;
  if (strData instanceof Uint8Array) {
    bytes = strData;
  } else if (typeof strData === 'string') {
    bytes = new Uint8Array(strData.length);
    for (var si = 0; si < strData.length; si++) bytes[si] = strData.charCodeAt(si);
  } else {
    return;
  }

  var byteIndex = 0;
  while (byteIndex < bytes.length) {
    var charCode;
    if (font.isTwoByteEncoding && byteIndex + 1 < bytes.length) {
      charCode = (bytes[byteIndex] << 8) | bytes[byteIndex + 1];
      byteIndex += 2;
    } else {
      charCode = bytes[byteIndex];
      byteIndex += 1;
    }

    // Get the Unicode character
    var unicodeChar = _fonts.charCodeToUnicode(font, charCode);

    // Get the glyph width
    var glyphWidth = _fonts.getCharWidth(font, charCode);

    // Calculate the text rendering position
    // The text matrix combines with the CTM
    var tm = state.textMatrix;

    // Compute the Text Rendering Matrix (Trm) translation component.
    // Per the PDF spec, the text state matrix is:
    //   [Tfs*Th, 0, 0, Tfs, 0, Trise]
    // Multiplied by Tm gives the translation:
    //   tx = Trise * Tm[2] + Tm[4]
    //   ty = Trise * Tm[3] + Tm[5]
    var tx = rise * tm[2] + tm[4];
    var ty = rise * tm[3] + tm[5];

    // Compute the Trm scale/rotation components (without CTM, which is
    // already on the canvas):
    //   Trm_a = Tfs * Th * Tm[0],  Trm_b = Tfs * Th * Tm[1]
    //   Trm_c = Tfs * Tm[2],       Trm_d = Tfs * Tm[3]
    //
    // Since we render at CSS_UNIT px, we need the transform to contribute
    // a factor of (fontSize / CSS_UNIT) in each component, so:
    //   transform_a = fontScale * Th * Tm[0]  etc.
    var trm_a = fontScale * hScale * tm[0];
    var trm_b = fontScale * hScale * tm[1];
    var trm_c = fontScale * tm[2];
    var trm_d = fontScale * tm[3];

    // Check for Type3 font - render glyph via content stream
    if (font.subtype === 'Type3' && font._type3Data) {
      renderType3Glyph(ctx, state, font, charCode, tm, hScale, rise, resources, doc);
    } else {
      // Render the character using canvas text API
      if (renderMode === 0 || renderMode === 2 || renderMode === 4 || renderMode === 6) {
        // Fill
        ctx.save();
        ctx.fillStyle = state.fillColor;
        ctx.globalAlpha = state.fillAlpha;

        ctx.save();
        ctx.transform(trm_a, trm_b, trm_c, trm_d, tx, ty);
        ctx.scale(1, -1); // Flip text right-side up in the flipped coordinate system
        ctx.fillText(unicodeChar, 0, 0);
        ctx.restore();
        ctx.restore();
      }

      if (renderMode === 1 || renderMode === 2 || renderMode === 5 || renderMode === 6) {
        // Stroke
        ctx.save();
        ctx.strokeStyle = state.strokeColor;
        ctx.globalAlpha = state.strokeAlpha;
        ctx.save();
        ctx.transform(trm_a, trm_b, trm_c, trm_d, tx, ty);
        ctx.scale(1, -1);
        ctx.strokeText(unicodeChar, 0, 0);
        ctx.restore();
        ctx.restore();
      }
    }

    // Advance the text position
    // tx = (w0 * Tfs + Tc + Tw) * Th
    // where w0 is the glyph width in text space units (divide by 1000)
    var w0 = glyphWidth / 1000;
    var advance = (w0 * fontSize + charSpacing) * hScale;

    // Add word spacing for space characters (character code 32)
    if (charCode === 32) {
      advance += wordSpacing * hScale;
    }

    // Update text matrix
    state.textMatrix = multiplyMatrix([1, 0, 0, 1, advance, 0], state.textMatrix);
  }
}

/**
 * Render a text array (TJ operator).
 * Array contains strings and numeric adjustments.
 * Numeric values are in thousandths of a unit of text space and shift
 * the text position (negative = forward, which is left in standard LTR text).
 */
function renderTextArray(ctx, state, arr, resources, doc) {
  if (!state.font || state.fontSize === 0) return;

  for (var i = 0; i < arr.length; i++) {
    var item = arr[i];
    if (typeof item === 'number') {
      // Adjust text position
      // Negative number moves right (forward in reading direction)
      var adjustment = -item / 1000 * state.fontSize * (state.horizontalScaling / 100);
      state.textMatrix = multiplyMatrix([1, 0, 0, 1, adjustment, 0], state.textMatrix);
    } else if (item instanceof Uint8Array || typeof item === 'string') {
      renderTextString(ctx, state, item, resources, doc);
    }
  }
}

// ============================================================================
// XObject Rendering (Form XObjects)
// ============================================================================

/**
 * Render an XObject (form or image).
 */
function renderXObject(ctx, state, stateStack, name, resources, doc, formDepth) {
  if (!resources || !resources.XObject) return;

  var xobjectDict = resources.XObject;
  if (xobjectDict && typeof xobjectDict === 'object' && xobjectDict.isRef && doc) {
    xobjectDict = doc.resolveRef(xobjectDict);
  }
  if (!xobjectDict || !xobjectDict[name]) return;

  var xobj = xobjectDict[name];
  if (xobj && typeof xobj === 'object' && xobj.isRef && doc) {
    xobj = doc.resolveRef(xobj);
  }
  if (!xobj || typeof xobj !== 'object') return;

  var subtype = xobj.Subtype;
  if (typeof subtype === 'object' && subtype && subtype.isRef && doc) {
    subtype = doc.resolveRef(subtype);
  }

  if (subtype === 'Form') {
    renderFormXObject(ctx, state, stateStack, xobj, resources, doc, formDepth);
  } else if (subtype === 'Image') {
    var images = getImages();
    if (images) {
      images.renderImageXObject(ctx, state, xobj, resources, doc);
    } else {
      renderImagePlaceholder(ctx, state, xobj, doc);
    }
  }
}

/**
 * Render a Form XObject.
 * Form XObjects contain their own content stream, resources, and matrix.
 */
function renderFormXObject(ctx, state, stateStack, formObj, parentResources, doc, formDepth) {
  if (formDepth >= MAX_FORM_XOBJECT_DEPTH) return;

  if (!formObj._isStream) return;

  // Check if we should use SMask-based offscreen rendering
  if (state.activeSMask && typeof document !== 'undefined') {
    renderFormWithSMask(ctx, state, stateStack, formObj, parentResources, doc, formDepth);
    return;
  }

  // Save graphics state
  stateStack.push(state.clone());
  ctx.save();

  // Apply Form matrix if present
  var matrix = formObj.Matrix;
  if (matrix && typeof matrix === 'object' && matrix.isRef && doc) {
    matrix = doc.resolveRef(matrix);
  }
  if (Array.isArray(matrix) && matrix.length >= 6) {
    ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    state.ctm = multiplyMatrix(matrix, state.ctm);
  }

  // Apply BBox clipping if present
  var bbox = formObj.BBox;
  if (bbox && typeof bbox === 'object' && bbox.isRef && doc) {
    bbox = doc.resolveRef(bbox);
  }
  if (Array.isArray(bbox) && bbox.length >= 4) {
    ctx.beginPath();
    ctx.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
    ctx.clip();
  }

  // Resolve Form's resources (fall back to parent resources)
  var formResources = formObj.Resources;
  if (formResources && typeof formResources === 'object' && formResources.isRef && doc) {
    formResources = doc.resolveRef(formResources);
  }
  var effectiveResources = mergeResources(formResources, parentResources);

  // Decode and tokenize the Form's content stream
  var contentData;
  try {
    contentData = doc.getStreamData(formObj);
  } catch (e) {
    ctx.restore();
    state = stateStack.pop();
    return;
  }

  var ops;
  try {
    ops = tokenizeContentStream(contentData);
  } catch (e) {
    ctx.restore();
    state = stateStack.pop();
    return;
  }

  // Execute the Form's operators
  var newState = new GraphicsState();
  newState.fillColor = state.fillColor;
  newState.strokeColor = state.strokeColor;
  newState.fillAlpha = state.fillAlpha;
  newState.strokeAlpha = state.strokeAlpha;
  newState.font = state.font;
  newState.fontSize = state.fontSize;
  var innerStack = [];

  try {
    executeOperators(ctx, ops, newState, innerStack, effectiveResources, doc, formDepth + 1);
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('Form XObject render error: ' + e.message);
    }
  }

  // Restore graphics state
  ctx.restore();
  state = stateStack.pop();
}

function renderFormWithSMask(ctx, state, stateStack, formObj, parentResources, doc, formDepth) {
  stateStack.push(state.clone());
  ctx.save();

  var smask = state.activeSMask;
  var canvasW = ctx.canvas.width;
  var canvasH = ctx.canvas.height;

  // Resolve the SMask /G group (Form XObject for the mask)
  var maskGroup = smask.G;
  if (maskGroup && typeof maskGroup === 'object' && maskGroup.isRef && doc) {
    maskGroup = doc.resolveRef(maskGroup);
  }

  var isLuminosity = true;
  var subtype = smask.S;
  if (subtype && typeof subtype === 'object' && subtype.isRef && doc) {
    subtype = doc.resolveRef(subtype);
  }
  if (subtype === 'Alpha' || subtype === '/Alpha') {
    isLuminosity = false;
  }

  // --- Render the content form to an offscreen canvas ---
  var contentCanvas = document.createElement('canvas');
  contentCanvas.width = canvasW;
  contentCanvas.height = canvasH;
  var contentCtx = contentCanvas.getContext('2d');

  // Copy the current transform from the main canvas
  var curTransform = ctx.getTransform();
  contentCtx.setTransform(curTransform);

  // Apply Form matrix
  var matrix = formObj.Matrix;
  if (matrix && typeof matrix === 'object' && matrix.isRef && doc) {
    matrix = doc.resolveRef(matrix);
  }
  if (Array.isArray(matrix) && matrix.length >= 6) {
    contentCtx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
  }

  // Apply BBox clipping
  var bbox = formObj.BBox;
  if (bbox && typeof bbox === 'object' && bbox.isRef && doc) {
    bbox = doc.resolveRef(bbox);
  }
  if (Array.isArray(bbox) && bbox.length >= 4) {
    contentCtx.beginPath();
    contentCtx.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
    contentCtx.clip();
  }

  var formResources = formObj.Resources;
  if (formResources && typeof formResources === 'object' && formResources.isRef && doc) {
    formResources = doc.resolveRef(formResources);
  }
  var effectiveResources = mergeResources(formResources, parentResources);

  var contentData;
  try { contentData = doc.getStreamData(formObj); } catch (e) {
    ctx.restore(); state = stateStack.pop(); return;
  }
  var ops;
  try { ops = tokenizeContentStream(contentData); } catch (e) {
    ctx.restore(); state = stateStack.pop(); return;
  }

  // Render content at full opacity — SMask controls the final alpha
  var contentState = new GraphicsState();
  contentState.fillColor = state.fillColor;
  contentState.strokeColor = state.strokeColor;
  contentState.fillAlpha = 1.0;
  contentState.strokeAlpha = 1.0;
  contentState.font = state.font;
  contentState.fontSize = state.fontSize;
  contentState.activeSMask = null;
  var contentStack = [];

  try {
    executeOperators(contentCtx, ops, contentState, contentStack, effectiveResources, doc, formDepth + 1);
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('SMask content render error: ' + e.message);
    }
  }

  // --- Render the mask group to another offscreen canvas ---
  if (maskGroup && maskGroup._isStream) {
    var maskCanvas = document.createElement('canvas');
    maskCanvas.width = canvasW;
    maskCanvas.height = canvasH;
    var maskCtx = maskCanvas.getContext('2d');

    // White background for luminosity masks (luminosity of white = 1.0 = fully opaque)
    if (isLuminosity) {
      maskCtx.fillStyle = 'rgb(0,0,0)';
      maskCtx.fillRect(0, 0, canvasW, canvasH);
    }

    maskCtx.setTransform(curTransform);

    // Apply mask group's own matrix
    var maskMatrix = maskGroup.Matrix;
    if (maskMatrix && typeof maskMatrix === 'object' && maskMatrix.isRef && doc) {
      maskMatrix = doc.resolveRef(maskMatrix);
    }
    if (Array.isArray(maskMatrix) && maskMatrix.length >= 6) {
      maskCtx.transform(maskMatrix[0], maskMatrix[1], maskMatrix[2], maskMatrix[3], maskMatrix[4], maskMatrix[5]);
    }

    // Apply mask BBox clipping
    var maskBBox = maskGroup.BBox;
    if (maskBBox && typeof maskBBox === 'object' && maskBBox.isRef && doc) {
      maskBBox = doc.resolveRef(maskBBox);
    }
    if (Array.isArray(maskBBox) && maskBBox.length >= 4) {
      maskCtx.beginPath();
      maskCtx.rect(maskBBox[0], maskBBox[1], maskBBox[2] - maskBBox[0], maskBBox[3] - maskBBox[1]);
      maskCtx.clip();
    }

    // Resolve mask group resources
    var maskResources = maskGroup.Resources;
    if (maskResources && typeof maskResources === 'object' && maskResources.isRef && doc) {
      maskResources = doc.resolveRef(maskResources);
    }
    var effectiveMaskResources = mergeResources(maskResources, parentResources);

    var maskData;
    try { maskData = doc.getStreamData(maskGroup); } catch (e) { maskData = null; }
    var maskOps;
    if (maskData) {
      try { maskOps = tokenizeContentStream(maskData); } catch (e) { maskOps = null; }
    }

    if (maskOps) {
      var maskState = new GraphicsState();
      maskState.activeSMask = null;
      var maskStack = [];
      try {
        executeOperators(maskCtx, maskOps, maskState, maskStack, effectiveMaskResources, doc, formDepth + 1);
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('SMask group render error: ' + e.message);
        }
      }
    }

    // --- Apply mask to content pixel by pixel ---
    var contentImgData = contentCtx.getImageData(0, 0, canvasW, canvasH);
    var maskImgData = maskCtx.getImageData(0, 0, canvasW, canvasH);
    var cPix = contentImgData.data;
    var mPix = maskImgData.data;

    for (var p = 0; p < cPix.length; p += 4) {
      var maskAlpha;
      if (isLuminosity) {
        // Luminosity = 0.2126R + 0.7152G + 0.0722B (standard sRGB luminance)
        maskAlpha = (0.2126 * mPix[p] + 0.7152 * mPix[p + 1] + 0.0722 * mPix[p + 2]) / 255;
      } else {
        // Alpha mode: use the mask's alpha channel directly
        maskAlpha = mPix[p + 3] / 255;
      }
      cPix[p + 3] = Math.round(cPix[p + 3] * maskAlpha);
    }

    contentCtx.putImageData(contentImgData, 0, 0);
  }

  // --- Composite the masked content onto the main canvas ---
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1.0;
  ctx.drawImage(contentCanvas, 0, 0);
  ctx.restore();

  ctx.restore();
  state = stateStack.pop();
}

/**
 * Merge two resource dictionaries. Form resources take priority.
 */
function mergeResources(formRes, parentRes) {
  if (!formRes) return parentRes || {};
  if (!parentRes) return formRes;

  var merged = {};
  // Copy parent resources first
  for (var key in parentRes) {
    merged[key] = parentRes[key];
  }
  // Overlay form resources
  for (var key2 in formRes) {
    if (formRes[key2] !== undefined && formRes[key2] !== null) {
      merged[key2] = formRes[key2];
    }
  }
  return merged;
}

/**
 * Render a placeholder for an image XObject (Phase 2b will replace this).
 */
function renderImagePlaceholder(ctx, state, imgObj, doc) {
  var width = imgObj.Width || 1;
  var height = imgObj.Height || 1;

  if (typeof width === 'object' && width && width.isRef && doc) {
    width = doc.resolveRef(width);
  }
  if (typeof height === 'object' && height && height.isRef && doc) {
    height = doc.resolveRef(height);
  }

  // Images are drawn in a 1x1 unit space, scaled by the CTM
  ctx.save();
  ctx.fillStyle = 'rgb(220,220,220)';
  ctx.fillRect(0, 0, 1, 1);
  ctx.restore();
}

// ============================================================================
// Type3 Font Glyph Rendering
// ============================================================================

/**
 * Render a Type3 font glyph by executing its content stream.
 * Type3 fonts define each glyph as a small content stream in CharProcs.
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {object} state - Current graphics state
 * @param {object} font - Resolved font info (with _type3Data)
 * @param {number} charCode - Character code to render
 * @param {number[]} tm - Current text matrix
 * @param {number} hScale - Horizontal scaling factor
 * @param {number} rise - Text rise
 * @param {object} resources - Page resources
 * @param {object} doc - PDFDocument instance
 */
function renderType3Glyph(ctx, state, font, charCode, tm, hScale, rise, resources, doc) {
  var type3 = font._type3Data;
  if (!type3 || !type3.charProcs || !doc) return;

  // Get the glyph name for this character code.
  // First try the encodingNames map (built from /Differences), which maps
  // character codes directly to glyph names -- this is the primary lookup
  // for Type3 fonts.  Fall back to the encoding table only when
  // encodingNames has no entry.
  var glyphName = null;
  if (type3.encodingNames && type3.encodingNames[charCode] !== undefined) {
    glyphName = type3.encodingNames[charCode];
  } else if (font.encoding && font.encoding[charCode] !== undefined) {
    // The encoding maps char codes to Unicode code points; try to reverse-map
    // to a glyph name that exists in CharProcs
    glyphName = null;
  }

  if (!glyphName) {
    // Fallback: try common naming conventions
    glyphName = 'g' + charCode;
  }

  // Look up the glyph content stream in CharProcs
  var charProcs = type3.charProcs;
  var glyphStream = charProcs[glyphName];
  if (glyphStream && typeof glyphStream === 'object' && glyphStream.isRef && doc) {
    glyphStream = doc.resolveRef(glyphStream);
  }

  if (!glyphStream || !glyphStream._isStream) {
    // No glyph stream found - fall back to canvas text
    var unicodeChar = _fonts.charCodeToUnicode(font, charCode);
    var fontSize = state.fontSize;
    var CSS_UNIT = 100;
    var fontScale = fontSize / CSS_UNIT;
    ctx.save();
    ctx.fillStyle = state.fillColor;
    ctx.globalAlpha = state.fillAlpha;
    ctx.font = 'normal ' + CSS_UNIT + 'px sans-serif';
    ctx.save();
    var tx = rise * tm[2] + tm[4];
    var ty = rise * tm[3] + tm[5];
    ctx.transform(fontScale * hScale * tm[0], fontScale * hScale * tm[1],
                  fontScale * tm[2], fontScale * tm[3], tx, ty);
    ctx.scale(1, -1);
    ctx.fillText(unicodeChar, 0, 0);
    ctx.restore();
    ctx.restore();
    return;
  }

  // Decode and tokenize the glyph content stream
  var glyphData;
  try {
    glyphData = doc.getStreamData(glyphStream);
  } catch (e) {
    return;
  }

  var glyphOps;
  try {
    glyphOps = tokenizeContentStream(glyphData);
  } catch (e) {
    return;
  }

  // Set up transform for the glyph
  ctx.save();

  // Apply the full text rendering matrix (Trm) for Type3 glyphs.
  // Trm = [Tfs*Th, 0, 0, Tfs, 0, Trise] * Tm * CTM
  // CTM is already on the canvas, so we apply [Tfs*Th, 0, 0, Tfs, 0, Trise] * Tm.
  var t3FontSize = state.fontSize;
  var tx2 = rise * tm[2] + tm[4];
  var ty2 = rise * tm[3] + tm[5];
  ctx.transform(t3FontSize * hScale * tm[0], t3FontSize * hScale * tm[1],
                t3FontSize * tm[2], t3FontSize * tm[3], tx2, ty2);

  // Apply the font matrix (Type3 fonts define their own coordinate system)
  if (type3.fontMatrix) {
    var fm = type3.fontMatrix;
    ctx.transform(fm[0], fm[1], fm[2], fm[3], fm[4], fm[5]);
  }

  // Merge font resources with page resources
  var glyphResources = type3.resources ?
    mergeResources(type3.resources, resources) : resources;

  // Execute the glyph operators
  var glyphState = new GraphicsState();
  glyphState.fillColor = state.fillColor;
  glyphState.strokeColor = state.strokeColor;
  glyphState.fillAlpha = state.fillAlpha;
  glyphState.strokeAlpha = state.strokeAlpha;
  var glyphStack = [];

  try {
    executeOperators(ctx, glyphOps, glyphState, glyphStack, glyphResources, doc, MAX_FORM_XOBJECT_DEPTH - 1);
  } catch (e) {
    // Silently fail for individual glyphs
  }

  ctx.restore();
}

/**
 * Build Type3 font data from the font dictionary.
 * Captures CharProcs, FontMatrix, Resources, and encoding info.
 *
 * @param {object} fontDict - The font dictionary
 * @param {object} doc - PDFDocument instance
 * @returns {object|null} Type3 font data or null
 */
function buildType3FontData(fontDict, doc) {
  if (!fontDict) return null;

  var charProcs = fontDict.CharProcs;
  if (charProcs && typeof charProcs === 'object' && charProcs.isRef && doc) {
    charProcs = doc.resolveRef(charProcs);
  }
  if (!charProcs) return null;

  // Font matrix (defaults to [0.001, 0, 0, 0.001, 0, 0] for 1000-unit em square)
  var fontMatrix = fontDict.FontMatrix;
  if (fontMatrix && typeof fontMatrix === 'object' && fontMatrix.isRef && doc) {
    fontMatrix = doc.resolveRef(fontMatrix);
  }
  if (!Array.isArray(fontMatrix) || fontMatrix.length < 6) {
    fontMatrix = [0.001, 0, 0, 0.001, 0, 0];
  }

  // Resources for the glyph content streams
  var fontResources = fontDict.Resources;
  if (fontResources && typeof fontResources === 'object' && fontResources.isRef && doc) {
    fontResources = doc.resolveRef(fontResources);
  }

  // Build encoding name map (charCode -> glyph name)
  var encodingNames = {};
  var encoding = fontDict.Encoding;
  if (encoding && typeof encoding === 'object' && encoding.isRef && doc) {
    encoding = doc.resolveRef(encoding);
  }
  if (encoding && typeof encoding === 'object' && !Array.isArray(encoding)) {
    // Dictionary encoding with Differences
    var diffs = encoding.Differences;
    if (diffs && typeof diffs === 'object' && diffs.isRef && doc) {
      diffs = doc.resolveRef(diffs);
    }
    if (Array.isArray(diffs)) {
      var code = 0;
      for (var i = 0; i < diffs.length; i++) {
        var item = diffs[i];
        if (typeof item === 'number') {
          code = item;
        } else if (typeof item === 'string') {
          var name = item;
          if (name.charAt(0) === '/') name = name.substring(1);
          encodingNames[code] = name;
          code++;
        }
      }
    }
  }

  return {
    charProcs: charProcs,
    fontMatrix: fontMatrix,
    resources: fontResources,
    encodingNames: encodingNames
  };
}

// ============================================================================
// Exports
// ============================================================================

var PDFRenderer = {
  renderPage: renderPage,
  tokenizeContentStream: tokenizeContentStream,
  GraphicsState: GraphicsState,
  multiplyMatrix: multiplyMatrix,
  transformPoint: transformPoint,
  colorToCSS: colorToCSS,
  resolveColorSpace: resolveColorSpace,
  buildType3FontData: buildType3FontData,
  PDFRenderError: PDFRenderError
};

if (typeof window !== 'undefined') {
  window.PDFRenderer = PDFRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PDFRenderer;
}
