/**
 * pdf-renderer.js — Canvas rendering engine for the custom PDF renderer.
 * Part of the custom-pdf-render engine for Gogs.
 *
 * Entry point: PDFRenderer.renderPage(canvas, pageObj, scale, parser)
 *
 * Implements a PDF content stream operator interpreter that draws to an
 * HTML5 canvas. Handles text, path, graphics state, color, XObjects,
 * and clipping operators.
 *
 * Security constraints:
 *   - NO dynamic code execution (eval-like APIs or dynamic Function construction)
 *   - NO innerHTML with PDF-derived content
 *   - All PDF-derived data treated as untrusted bytes
 *
 * No external library imports.
 */

'use strict';

// ─── Import dependencies (Node.js) / expect globals (browser) ────────────────

let _getStandardFontCSS, _getStandardFontStyle, _pdfStringToText, _measureTextWidth, _getCharWidth;
let _parseToUnicodeCMap, _decodeWithToUnicode, _decodeWithEncoding, _resolveEncoding;
let _decodeImage, _decodeInlineImage;

if (typeof module !== 'undefined' && module.exports) {
  const fonts  = require('./pdf-fonts.js');
  const images = require('./pdf-images.js');
  _getStandardFontCSS   = fonts.getStandardFontCSS;
  _getStandardFontStyle = fonts.getStandardFontStyle;
  _pdfStringToText      = fonts.pdfStringToText;
  _measureTextWidth     = fonts.measureTextWidth;
  _getCharWidth         = fonts.getCharWidth;
  _parseToUnicodeCMap   = fonts.parseToUnicodeCMap;
  _decodeWithToUnicode  = fonts.decodeWithToUnicode;
  _decodeWithEncoding   = fonts.decodeWithEncoding;
  _resolveEncoding      = fonts.resolveEncoding;
  _decodeImage          = images.decodeImage;
  _decodeInlineImage    = images.decodeInlineImage;
} else {
  // Browser: expect globals set by script tags
  _getStandardFontCSS   = function(n) { return window.PDFFonts ? window.PDFFonts.getStandardFontCSS(n) : 'Arial, sans-serif'; };
  _getStandardFontStyle = function(n) { return window.PDFFonts ? window.PDFFonts.getStandardFontStyle(n) : { weight: 'normal', style: 'normal' }; };
  _pdfStringToText      = function(a, e) { return window.PDFFonts ? window.PDFFonts.pdfStringToText(a, e) : ''; };
  _measureTextWidth     = function(n, s, t) { return window.PDFFonts ? window.PDFFonts.measureTextWidth(n, s, t) : 0; };
  _getCharWidth         = function(n, c) { return window.PDFFonts ? window.PDFFonts.getCharWidth(n, c) : 556; };
  _parseToUnicodeCMap   = function(t) { return window.PDFFonts ? window.PDFFonts.parseToUnicodeCMap(t) : new Map(); };
  _decodeWithToUnicode  = function(b, m, c) { return window.PDFFonts ? window.PDFFonts.decodeWithToUnicode(b, m, c) : ''; };
  _decodeWithEncoding   = function(b, t) { return window.PDFFonts ? window.PDFFonts.decodeWithEncoding(b, t) : ''; };
  _resolveEncoding      = function(e) { return window.PDFFonts ? window.PDFFonts.resolveEncoding(e) : null; };
  _decodeImage          = function(s, p) { return window.PDFImages ? window.PDFImages.decodeImage(s, p) : Promise.resolve(null); };
  _decodeInlineImage    = function(o) { return window.PDFImages ? window.PDFImages.decodeInlineImage(o) : Promise.resolve(null); };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CONTENT_TOKENS    = 5_000_000; // max tokens in a content stream
const MAX_OPERATOR_ARGS     = 100;        // max operand stack depth
const MAX_GRAPHICS_STACK    = 64;         // max q/Q nesting depth
const MAX_INLINE_IMG_BYTES  = 10 * 1024 * 1024; // 10 MB inline image limit

// ─── GraphicsState ────────────────────────────────────────────────────────────

/**
 * Represents the current graphics state.
 * Cloned on 'q', restored on 'Q'.
 */
class GraphicsState {
  constructor() {
    // Current transformation matrix [a, b, c, d, e, f]
    this.ctm = [1, 0, 0, 1, 0, 0];
    // Fill color [r, g, b] 0-1
    this.fillColor   = [0, 0, 0];
    // Stroke color [r, g, b] 0-1
    this.strokeColor = [0, 0, 0];
    // Fill color CSS string
    this.fillColorCSS   = 'rgb(0,0,0)';
    this.strokeColorCSS = 'rgb(0,0,0)';
    // Line properties
    this.lineWidth     = 1;
    this.lineCap       = 0;   // butt
    this.lineJoin      = 0;   // miter
    this.miterLimit    = 10;
    this.dashArray     = [];
    this.dashPhase     = 0;
    // Text state
    this.fontName      = 'Helvetica';
    this.fontSize      = 12;
    this.fontCSS       = 'Helvetica, Arial, sans-serif';
    this.fontWeight    = 'normal';
    this.fontStyle     = 'normal';
    this.textMode      = 0;     // Tr — rendering mode (0=fill, 1=stroke, 2=fill+stroke, 3=invisible)
    this.charSpacing   = 0;     // Tc
    this.wordSpacing   = 0;     // Tw
    this.horizScaling  = 100;   // Tz (percent)
    this.leading       = 0;     // TL
    this.rise          = 0;     // Ts (text rise)
    // Font encoding — set by Tf operator
    this.toUnicodeMap  = null;  // Map<number,string> from /ToUnicode CMap, or null
    this.encodingTable = null;  // Uint32Array[256] from /Encoding, or null
    this.isCompositeFt = false; // true for Type0/CIDFont (2-byte char codes)
    // Rendering intent
    this.renderingIntent = 'RelativeColorimetric';
  }

  clone() {
    const s = new GraphicsState();
    s.ctm            = this.ctm.slice();
    s.fillColor      = this.fillColor.slice();
    s.strokeColor    = this.strokeColor.slice();
    s.fillColorCSS   = this.fillColorCSS;
    s.strokeColorCSS = this.strokeColorCSS;
    s.lineWidth      = this.lineWidth;
    s.lineCap        = this.lineCap;
    s.lineJoin       = this.lineJoin;
    s.miterLimit     = this.miterLimit;
    s.dashArray      = this.dashArray.slice();
    s.dashPhase      = this.dashPhase;
    s.fontName       = this.fontName;
    s.fontSize       = this.fontSize;
    s.fontCSS        = this.fontCSS;
    s.fontWeight     = this.fontWeight;
    s.fontStyle      = this.fontStyle;
    s.textMode       = this.textMode;
    s.charSpacing    = this.charSpacing;
    s.wordSpacing    = this.wordSpacing;
    s.horizScaling   = this.horizScaling;
    s.leading        = this.leading;
    s.rise           = this.rise;
    s.toUnicodeMap   = this.toUnicodeMap;   // shared reference (Map is not mutated)
    s.encodingTable  = this.encodingTable;  // shared reference (Uint32Array is not mutated)
    s.isCompositeFt  = this.isCompositeFt;
    s.renderingIntent = this.renderingIntent;
    return s;
  }
}

// ─── TextState ────────────────────────────────────────────────────────────────

/**
 * Text matrix state — separate from graphics state, reset at BT.
 */
class TextState {
  constructor() {
    this.tm  = [1, 0, 0, 1, 0, 0]; // text matrix
    this.tlm = [1, 0, 0, 1, 0, 0]; // text line matrix
  }

  reset() {
    this.tm  = [1, 0, 0, 1, 0, 0];
    this.tlm = [1, 0, 0, 1, 0, 0];
  }
}

// ─── PDFRenderer ─────────────────────────────────────────────────────────────

class PDFRenderer {
  constructor() {
    this._gsStack    = [];
    this._gs         = new GraphicsState();
    this._textState  = new TextState();
    this._inText     = false;
    this._ctx        = null;
    this._scale      = 1;
    this._mediaBox   = [0, 0, 612, 792];
    this._parser     = null;
    this._resources  = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * renderPage(canvas, pageObj, scale, parser)
   *
   * Render a single page to the given canvas.
   *
   * @param {HTMLCanvasElement|object} canvas  — target canvas (or mock)
   * @param {object}                   pageObj — one page dict from parser.pages[]
   * @param {number}                   scale   — zoom factor (1.0 = 100%)
   * @param {object}                   parser  — live PDFParser instance
   * @returns {Promise<void>}
   */
  async renderPage(canvas, pageObj, scale, parser) {
    if (!canvas || !pageObj) return;

    this._scale  = typeof scale === 'number' && scale > 0 ? scale : 1.0;
    this._parser = parser || null;

    // Extract media box (page size)
    const mb = pageObj['/MediaBox'];
    if (Array.isArray(mb) && mb.length >= 4) {
      this._mediaBox = mb.map(Number);
    } else {
      this._mediaBox = [0, 0, 612, 792];
    }

    const [x1, y1, x2, y2] = this._mediaBox;
    const pageWidth  = (x2 - x1) * this._scale;
    const pageHeight = (y2 - y1) * this._scale;

    // Set canvas dimensions
    canvas.width  = Math.ceil(pageWidth);
    canvas.height = Math.ceil(pageHeight);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    this._ctx = ctx;

    // Reset graphics state
    this._gs        = new GraphicsState();
    this._gsStack   = [];
    this._textState = new TextState();
    this._inText    = false;

    // Fill canvas background with white
    ctx.save();
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Set coordinate transform: PDF bottom-left origin, Y-up → canvas top-left, Y-down
    // Transform: x' = scale*(x - x1), y' = scale*(y2 - y)
    ctx.setTransform(this._scale, 0, 0, -this._scale, -x1 * this._scale, y2 * this._scale);

    // Extract resources
    this._resources = this._getResources(pageObj);

    // Get content stream bytes
    const contentBytes = await this._getContentBytes(pageObj);
    if (!contentBytes || contentBytes.length === 0) return;

    // Interpret content stream
    await this._interpretContentStream(contentBytes, this._resources);
  }

  // ── Content stream byte retrieval ───────────────────────────────────────────

  async _getContentBytes(pageObj) {
    const contents = pageObj['/Contents'];
    if (!contents) return new Uint8Array(0);

    if (Array.isArray(contents)) {
      const parts = [];
      for (const item of contents) {
        if (item && item.isStream) {
          try {
            const bytes = await item.getBytes();
            parts.push(bytes);
          } catch (_) {}
        }
      }
      if (parts.length === 0) return new Uint8Array(0);
      // Concatenate with space separator (PDF spec requirement)
      let total = 0;
      for (const p of parts) total += p.length + 1;
      const result = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        result.set(p, offset);
        offset += p.length;
        result[offset++] = 0x20; // space separator
      }
      return result;
    }

    if (contents && contents.isStream) {
      try {
        return await contents.getBytes();
      } catch (_) {
        return new Uint8Array(0);
      }
    }

    return new Uint8Array(0);
  }

  _getResources(pageObj) {
    const res = pageObj['/Resources'];
    if (!res) return {};
    if (res && typeof res === 'object' && !Array.isArray(res)) return res;
    return {};
  }

  // ── Content stream tokenizer ─────────────────────────────────────────────────

  /**
   * Tokenize a PDF content stream into a sequence of operands + operator calls.
   * Yields { type, value } objects:
   *   - { type: 'number', value: number }
   *   - { type: 'name', value: '/Name' }
   *   - { type: 'string', value: Uint8Array, stringType: 'literal'|'hex' }
   *   - { type: 'array', value: array }
   *   - { type: 'bool', value: boolean }
   *   - { type: 'null', value: null }
   *   - { type: 'op', value: 'operator-string' }
   *
   * This is a simplified tokenizer that does not recurse into dicts.
   * The inline image case is handled specially in the interpreter.
   */
  *_tokenize(bytes) {
    const len = bytes.length;
    let i = 0;
    let tokenCount = 0;

    while (i < len && tokenCount < MAX_CONTENT_TOKENS) {
      tokenCount++;

      // Skip whitespace
      while (i < len && _isWS(bytes[i])) i++;
      if (i >= len) break;

      const c = bytes[i];

      // Comment
      if (c === 0x25) { // '%'
        while (i < len && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
        continue;
      }

      // Literal string (...)
      if (c === 0x28) {
        const result = _parseLiteralString(bytes, i);
        yield { type: 'string', value: result.value, stringType: 'literal' };
        i = result.nextOffset;
        continue;
      }

      // Hex string <...> or dict << >>
      if (c === 0x3c) {
        if (i + 1 < len && bytes[i + 1] === 0x3c) {
          // Dict start — parse key-value pairs (used for inline image dicts)
          const result = _parseDict(bytes, i);
          yield { type: 'dict', value: result.value };
          i = result.nextOffset;
          continue;
        } else {
          const result = _parseHexString(bytes, i);
          yield { type: 'string', value: result.value, stringType: 'hex' };
          i = result.nextOffset;
          continue;
        }
      }

      // Array [...]
      if (c === 0x5b) {
        const result = _parseArray(bytes, i);
        yield { type: 'array', value: result.value };
        i = result.nextOffset;
        continue;
      }

      // Name /...
      if (c === 0x2f) {
        const result = _parseName(bytes, i);
        yield { type: 'name', value: result.value };
        i = result.nextOffset;
        continue;
      }

      // Number or keyword
      const result = _parseToken(bytes, i);
      if (result) {
        yield result;
        i = result.nextOffset;
      } else {
        i++; // skip unknown character
      }
    }
  }

  // ── Content stream interpreter ────────────────────────────────────────────

  async _interpretContentStream(bytes, resources) {
    const operandStack = [];
    const tokenIter    = this._tokenize(bytes);

    for (const token of tokenIter) {
      if (token.type !== 'op') {
        // Accumulate operands
        if (operandStack.length < MAX_OPERATOR_ARGS) {
          operandStack.push(token);
        }
        continue;
      }

      // Execute operator
      const op = token.value;
      try {
        const handled = await this._executeOp(op, operandStack, resources, bytes, tokenIter);
        if (!handled) {
          // Unknown operator — silently skip per spec
        }
      } catch (e) {
        // Per-operator try/catch: ignore errors, continue stream
      }
      operandStack.length = 0; // clear stack after each operator
    }
  }

  // ── Operator dispatch ─────────────────────────────────────────────────────

  async _executeOp(op, stack, resources, bytes, tokenIter) {
    const ctx = this._ctx;
    const gs  = this._gs;

    switch (op) {

      // ── Graphics state ──────────────────────────────────────────────────

      case 'q':
        // Save graphics state
        if (this._gsStack.length < MAX_GRAPHICS_STACK) {
          this._gsStack.push(gs.clone());
          ctx.save();
        }
        return true;

      case 'Q':
        // Restore graphics state
        if (this._gsStack.length > 0) {
          this._gs = this._gsStack.pop();
          ctx.restore();
        }
        return true;

      case 'cm': {
        // Concatenate matrix
        const [a, b, c, d, e, f] = _getNumbers(stack, 6);
        ctx.transform(a, b, c, d, e, f);
        // Update CTM
        gs.ctm = _matMul(gs.ctm, [a, b, c, d, e, f]);
        return true;
      }

      case 'w': {
        // Line width
        const w = _getNum(stack, 0, 1);
        gs.lineWidth = w;
        ctx.lineWidth = w;
        return true;
      }

      case 'J': {
        // Line cap
        const cap = _getInt(stack, 0, 0);
        gs.lineCap = cap;
        ctx.lineCap = ['butt', 'round', 'square'][cap] || 'butt';
        return true;
      }

      case 'j': {
        // Line join
        const join = _getInt(stack, 0, 0);
        gs.lineJoin = join;
        ctx.lineJoin = ['miter', 'round', 'bevel'][join] || 'miter';
        return true;
      }

      case 'M': {
        // Miter limit
        gs.miterLimit = _getNum(stack, 0, 10);
        ctx.miterLimit = gs.miterLimit;
        return true;
      }

      case 'd': {
        // Dash pattern
        if (stack.length >= 2) {
          const arrToken = stack[stack.length - 2];
          const phase    = _getNum(stack, 0, 0);
          if (arrToken && arrToken.type === 'array') {
            gs.dashArray = arrToken.value.map(t => typeof t === 'number' ? t : (t && t.value) || 0);
            gs.dashPhase = phase;
            ctx.setLineDash(gs.dashArray);
            ctx.lineDashOffset = gs.dashPhase;
          }
        }
        return true;
      }

      case 'ri':
        // Rendering intent — no canvas equivalent, just record
        if (stack.length > 0 && stack[stack.length - 1].type === 'name') {
          gs.renderingIntent = stack[stack.length - 1].value;
        }
        return true;

      case 'i':
        // Flatness — ignored
        return true;

      case 'gs': {
        // Graphics state dictionary from /ExtGState
        const nameToken = stack[stack.length - 1];
        if (nameToken && nameToken.type === 'name') {
          this._applyExtGState(nameToken.value, resources, ctx, gs);
        }
        return true;
      }

      // ── Color operators ─────────────────────────────────────────────────

      case 'RG': case 'rg': {
        // Set stroke (RG) or fill (rg) color in DeviceRGB
        const r = _getNum(stack, 2, 0);
        const g = _getNum(stack, 1, 0);
        const b = _getNum(stack, 0, 0);
        const css = _rgbCSS(r, g, b);
        if (op === 'RG') {
          gs.strokeColor    = [r, g, b];
          gs.strokeColorCSS = css;
          ctx.strokeStyle   = css;
        } else {
          gs.fillColor    = [r, g, b];
          gs.fillColorCSS = css;
          ctx.fillStyle   = css;
        }
        return true;
      }

      case 'G': case 'g': {
        // Set stroke (G) or fill (g) gray level
        const grayVal = _getNum(stack, 0, 0);
        const css = _rgbCSS(grayVal, grayVal, grayVal);
        if (op === 'G') {
          gs.strokeColor    = [grayVal, grayVal, grayVal];
          gs.strokeColorCSS = css;
          ctx.strokeStyle   = css;
        } else {
          gs.fillColor    = [grayVal, grayVal, grayVal];
          gs.fillColorCSS = css;
          ctx.fillStyle   = css;
        }
        return true;
      }

      case 'K': case 'k': {
        // Set stroke (K) or fill (k) color in CMYK
        const c2 = _getNum(stack, 3, 0);
        const m  = _getNum(stack, 2, 0);
        const y  = _getNum(stack, 1, 0);
        const k  = _getNum(stack, 0, 0);
        const [r2, g2, b2] = _cmykToRGB(c2, m, y, k);
        const css2 = _rgbCSS(r2, g2, b2);
        if (op === 'K') {
          gs.strokeColor    = [r2, g2, b2];
          gs.strokeColorCSS = css2;
          ctx.strokeStyle   = css2;
        } else {
          gs.fillColor    = [r2, g2, b2];
          gs.fillColorCSS = css2;
          ctx.fillStyle   = css2;
        }
        return true;
      }

      case 'CS': case 'cs': {
        // Set color space — accept and ignore (we default to black)
        return true;
      }

      case 'SC': case 'SCN': case 'sc': case 'scn': {
        // Set color in current color space
        // For simplicity: if 1 operand, treat as gray; if 3, as RGB; if 4, as CMYK
        const isStroke = (op === 'SC' || op === 'SCN');
        const nums = _getAvailableNumbers(stack);
        let css3 = 'rgb(0,0,0)';
        let col  = [0, 0, 0];
        if (nums.length >= 4) {
          col  = _cmykToRGB(nums[0], nums[1], nums[2], nums[3]);
          css3 = _rgbCSS(col[0], col[1], col[2]);
        } else if (nums.length >= 3) {
          col  = [nums[0], nums[1], nums[2]];
          css3 = _rgbCSS(col[0], col[1], col[2]);
        } else if (nums.length >= 1) {
          col  = [nums[0], nums[0], nums[0]];
          css3 = _rgbCSS(nums[0], nums[0], nums[0]);
        }
        if (isStroke) {
          gs.strokeColor = col; gs.strokeColorCSS = css3; ctx.strokeStyle = css3;
        } else {
          gs.fillColor   = col; gs.fillColorCSS   = css3; ctx.fillStyle   = css3;
        }
        return true;
      }

      // ── Path construction ────────────────────────────────────────────────

      case 'm': {
        const x = _getNum(stack, 1, 0), y = _getNum(stack, 0, 0);
        ctx.beginPath();
        ctx.moveTo(x, y);
        return true;
      }

      case 'l': {
        const x = _getNum(stack, 1, 0), y = _getNum(stack, 0, 0);
        ctx.lineTo(x, y);
        return true;
      }

      case 'c': {
        // Cubic bezier: x1 y1 x2 y2 x3 y3
        const x1 = _getNum(stack, 5, 0), y1 = _getNum(stack, 4, 0);
        const x2 = _getNum(stack, 3, 0), y2 = _getNum(stack, 2, 0);
        const x3 = _getNum(stack, 1, 0), y3 = _getNum(stack, 0, 0);
        ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3);
        return true;
      }

      case 'v': {
        // Cubic bezier, first control point = current point: x2 y2 x3 y3
        const x2 = _getNum(stack, 3, 0), y2 = _getNum(stack, 2, 0);
        const x3 = _getNum(stack, 1, 0), y3 = _getNum(stack, 0, 0);
        ctx.bezierCurveTo(x2, y2, x2, y2, x3, y3);
        return true;
      }

      case 'y': {
        // Cubic bezier, second control point = final point: x1 y1 x3 y3
        const x1 = _getNum(stack, 3, 0), y1 = _getNum(stack, 2, 0);
        const x3 = _getNum(stack, 1, 0), y3 = _getNum(stack, 0, 0);
        ctx.bezierCurveTo(x1, y1, x3, y3, x3, y3);
        return true;
      }

      case 'h':
        // Close path
        ctx.closePath();
        return true;

      case 're': {
        // Rectangle: x y w h
        const rx = _getNum(stack, 3, 0), ry = _getNum(stack, 2, 0);
        const rw = _getNum(stack, 1, 0), rh = _getNum(stack, 0, 0);
        ctx.beginPath();
        ctx.rect(rx, ry, rw, rh);
        return true;
      }

      // ── Path painting ────────────────────────────────────────────────────

      case 'f': case 'F': {
        // Fill using nonzero winding
        ctx.fillStyle = gs.fillColorCSS;
        ctx.fill('nonzero');
        return true;
      }

      case 'f*': {
        // Fill using even-odd rule
        ctx.fillStyle = gs.fillColorCSS;
        ctx.fill('evenodd');
        return true;
      }

      case 'S': {
        // Stroke
        ctx.strokeStyle = gs.strokeColorCSS;
        ctx.lineWidth   = gs.lineWidth;
        ctx.stroke();
        return true;
      }

      case 's': {
        // Close and stroke
        ctx.closePath();
        ctx.strokeStyle = gs.strokeColorCSS;
        ctx.lineWidth   = gs.lineWidth;
        ctx.stroke();
        return true;
      }

      case 'B': {
        // Fill then stroke (nonzero)
        ctx.fillStyle   = gs.fillColorCSS;
        ctx.strokeStyle = gs.strokeColorCSS;
        ctx.lineWidth   = gs.lineWidth;
        ctx.fill('nonzero');
        ctx.stroke();
        return true;
      }

      case 'B*': {
        // Fill then stroke (even-odd)
        ctx.fillStyle   = gs.fillColorCSS;
        ctx.strokeStyle = gs.strokeColorCSS;
        ctx.lineWidth   = gs.lineWidth;
        ctx.fill('evenodd');
        ctx.stroke();
        return true;
      }

      case 'b': {
        // Close, fill (nonzero), stroke
        ctx.closePath();
        ctx.fillStyle   = gs.fillColorCSS;
        ctx.strokeStyle = gs.strokeColorCSS;
        ctx.lineWidth   = gs.lineWidth;
        ctx.fill('nonzero');
        ctx.stroke();
        return true;
      }

      case 'b*': {
        // Close, fill (even-odd), stroke
        ctx.closePath();
        ctx.fillStyle   = gs.fillColorCSS;
        ctx.strokeStyle = gs.strokeColorCSS;
        ctx.lineWidth   = gs.lineWidth;
        ctx.fill('evenodd');
        ctx.stroke();
        return true;
      }

      case 'n': {
        // End path with no paint
        ctx.beginPath();
        return true;
      }

      // ── Clipping ─────────────────────────────────────────────────────────

      case 'W': {
        // Clip (nonzero winding)
        ctx.clip('nonzero');
        return true;
      }

      case 'W*': {
        // Clip (even-odd)
        ctx.clip('evenodd');
        return true;
      }

      // ── Text operators ────────────────────────────────────────────────────

      case 'BT': {
        // Begin text
        this._inText = true;
        this._textState.reset();
        ctx.save();
        return true;
      }

      case 'ET': {
        // End text
        this._inText = false;
        ctx.restore();
        return true;
      }

      case 'Tf': {
        // Set font: name size
        const sizeToken = stack[stack.length - 1];
        const nameToken = stack.length >= 2 ? stack[stack.length - 2] : null;
        const fontSize  = sizeToken ? _tokenToNum(sizeToken, 12) : 12;
        let fontName    = 'Helvetica';
        if (nameToken && nameToken.type === 'name') {
          fontName = nameToken.value.startsWith('/') ? nameToken.value.slice(1) : nameToken.value;
        }
        gs.fontSize = fontSize;
        // Resolve font from resources
        const resolvedFont = await this._resolveFontAsync(fontName, resources);
        gs.fontName       = resolvedFont.baseFontName || fontName;
        gs.toUnicodeMap   = resolvedFont.toUnicodeMap  || null;
        gs.encodingTable  = resolvedFont.encodingTable || null;
        gs.isCompositeFt  = resolvedFont.isComposite   || false;
        const cssFamily = _getStandardFontCSS(gs.fontName);
        const cssStyle  = _getStandardFontStyle(gs.fontName);
        gs.fontCSS     = cssFamily;
        gs.fontWeight  = cssStyle.weight;
        gs.fontStyle   = cssStyle.style;
        return true;
      }

      case 'Tr': {
        // Text rendering mode
        gs.textMode = _getInt(stack, 0, 0);
        return true;
      }

      case 'Tc': {
        // Character spacing
        gs.charSpacing = _getNum(stack, 0, 0);
        return true;
      }

      case 'Tw': {
        // Word spacing
        gs.wordSpacing = _getNum(stack, 0, 0);
        return true;
      }

      case 'Tz': {
        // Horizontal scaling
        gs.horizScaling = _getNum(stack, 0, 100);
        return true;
      }

      case 'TL': {
        // Text leading
        gs.leading = _getNum(stack, 0, 0);
        return true;
      }

      case 'Ts': {
        // Text rise
        gs.rise = _getNum(stack, 0, 0);
        return true;
      }

      case 'Td': {
        // Move to next line, offset by (tx, ty)
        const tx = _getNum(stack, 1, 0), ty = _getNum(stack, 0, 0);
        const ts = this._textState;
        ts.tlm = _matTranslate(ts.tlm, tx, ty);
        ts.tm  = ts.tlm.slice();
        return true;
      }

      case 'TD': {
        // Move to next line, set leading to -ty
        const tx = _getNum(stack, 1, 0), ty = _getNum(stack, 0, 0);
        gs.leading = -ty;
        const ts = this._textState;
        ts.tlm = _matTranslate(ts.tlm, tx, ty);
        ts.tm  = ts.tlm.slice();
        return true;
      }

      case 'Tm': {
        // Set text matrix
        const a = _getNum(stack, 5, 1), b = _getNum(stack, 4, 0);
        const c = _getNum(stack, 3, 0), d = _getNum(stack, 2, 1);
        const e = _getNum(stack, 1, 0), f = _getNum(stack, 0, 0);
        this._textState.tm  = [a, b, c, d, e, f];
        this._textState.tlm = [a, b, c, d, e, f];
        return true;
      }

      case 'T*': {
        // Move to start of next line
        const ts = this._textState;
        ts.tlm = _matTranslate(ts.tlm, 0, -gs.leading);
        ts.tm  = ts.tlm.slice();
        return true;
      }

      case 'Tj': {
        // Show string
        const strToken = stack[stack.length - 1];
        if (strToken && strToken.type === 'string') {
          this._showText(strToken.value, ctx, gs);
        }
        return true;
      }

      case 'TJ': {
        // Show array of strings/numbers
        const arrToken = stack[stack.length - 1];
        if (arrToken && arrToken.type === 'array') {
          for (const item of arrToken.value) {
            if (item && (item.isLiteralString || item.isHexString || item instanceof Uint8Array)) {
              const bytes2 = item instanceof Uint8Array ? item : item.value;
              this._showText(bytes2, ctx, gs);
            } else if (typeof item === 'number') {
              // Kern adjustment: negative = move right (in text space 1/1000 unit)
              const adjust = -item * gs.fontSize / 1000;
              this._textState.tm = _matTranslate(this._textState.tm, adjust, 0);
            } else if (item && typeof item === 'object' && 'value' in item && item.value instanceof Uint8Array) {
              this._showText(item.value, ctx, gs);
            }
          }
        }
        return true;
      }

      case "'": {
        // Move to next line and show string
        const ts = this._textState;
        ts.tlm = _matTranslate(ts.tlm, 0, -gs.leading);
        ts.tm  = ts.tlm.slice();
        const strToken2 = stack[stack.length - 1];
        if (strToken2 && strToken2.type === 'string') {
          this._showText(strToken2.value, ctx, gs);
        }
        return true;
      }

      case '"': {
        // Set word/char spacing, move to next line, show string
        gs.wordSpacing = _getNum(stack, 2, 0);
        gs.charSpacing = _getNum(stack, 1, 0);
        const ts2 = this._textState;
        ts2.tlm = _matTranslate(ts2.tlm, 0, -gs.leading);
        ts2.tm  = ts2.tlm.slice();
        const strToken3 = stack[stack.length - 1];
        if (strToken3 && strToken3.type === 'string') {
          this._showText(strToken3.value, ctx, gs);
        }
        return true;
      }

      // ── XObjects ──────────────────────────────────────────────────────────

      case 'Do': {
        // Invoke XObject
        const nameToken2 = stack[stack.length - 1];
        if (nameToken2 && nameToken2.type === 'name') {
          await this._invokeXObject(nameToken2.value, resources, ctx, gs);
        }
        return true;
      }

      // ── Inline images ─────────────────────────────────────────────────────

      case 'BI': {
        // Begin inline image — handled specially by tokenizer integration
        return true;
      }

      // ── Shading ───────────────────────────────────────────────────────────

      case 'sh': {
        // Shading — skip (complex, rarely needed for basic rendering)
        return true;
      }

      // ── Type 3 font glyph ─────────────────────────────────────────────────

      case 'd0': case 'd1': {
        // Glyph width / bounding box for Type 3 fonts — skip
        return true;
      }

      // ── Marked content ────────────────────────────────────────────────────

      case 'BMC': case 'BDC': case 'EMC':
      case 'MP': case 'DP':
        return true;

      // ── Compatibility ─────────────────────────────────────────────────────

      case 'BX': case 'EX':
        return true;

      default:
        return false; // unknown operator — caller skips silently
    }
  }

  // ── Text rendering ────────────────────────────────────────────────────────

  /**
   * Render a text string at the current text matrix position.
   * @param {Uint8Array} bytes — raw PDF string bytes
   * @param {CanvasRenderingContext2D} ctx
   * @param {GraphicsState} gs
   */
  _showText(bytes, ctx, gs) {
    if (!bytes || bytes.length === 0) return;
    if (!this._inText) return;

    // Decode bytes to Unicode string using font encoding info
    let text;
    if (gs.toUnicodeMap && gs.toUnicodeMap.size > 0) {
      // Use ToUnicode CMap (handles both composite/Type0 and simple fonts)
      text = _decodeWithToUnicode(bytes, gs.toUnicodeMap, gs.isCompositeFt);
    } else if (gs.encodingTable) {
      // Use explicit /Encoding table (simple fonts only)
      text = _decodeWithEncoding(bytes, gs.encodingTable);
    } else {
      // Fallback: standard Latin-1 decoding
      text = _pdfStringToText(bytes);
    }
    if (!text || text.length === 0) return;

    // Build canvas font string
    // fontSize in PDF user space; canvas already has the transform applied
    const fontStr = `${gs.fontStyle} ${gs.fontWeight} ${gs.fontSize}px ${gs.fontCSS}`;
    ctx.font = fontStr;

    // Text rendering mode: 3 = invisible, skip drawing
    if (gs.textMode === 3) {
      // Still advance the text matrix
      this._advanceTextMatrix(text, gs);
      return;
    }

    // Get text matrix position
    const tm = this._textState.tm;
    const [a, b, c, d, e, f] = tm;

    // Save canvas state around text drawing
    ctx.save();

    // Apply text matrix as additional transform
    // tm is in PDF user space, which already has the page transform
    ctx.transform(a, b, c, d, e, f);

    // Apply horizontal scaling and rise
    const scaleX = gs.horizScaling / 100;
    if (scaleX !== 1 || gs.rise !== 0) {
      ctx.transform(scaleX, 0, 0, 1, 0, gs.rise);
    }

    // Canvas text is rendered with Y-up issues: in our setup,
    // the page transform flips Y (scale -1 in Y direction).
    // Text in PDF is defined in glyph space with Y-up.
    // We need to flip Y back for text rendering.
    ctx.transform(1, 0, 0, -1, 0, 0);

    // Set text colors based on rendering mode
    const mode = gs.textMode;
    if (mode === 0 || mode === 2 || mode === 4 || mode === 6) {
      ctx.fillStyle = gs.fillColorCSS;
    }
    if (mode === 1 || mode === 2 || mode === 5 || mode === 6) {
      ctx.strokeStyle  = gs.strokeColorCSS;
      ctx.lineWidth    = gs.lineWidth;
    }

    // Draw the text character by character to handle char/word spacing.
    // xOffset accumulates in the local glyph coordinate space (after text matrix).
    // The text matrix transforms these coordinates to page space when drawing.
    // We use font width tables to ensure consistent advance (not canvas measureText
    // which would be in canvas-transformed space).
    let xOffset = 0;
    const Tc2  = gs.charSpacing;
    const Tw2  = gs.wordSpacing;
    const Th2  = gs.horizScaling / 100;

    for (let i = 0; i < text.length; i++) {
      const ch   = text[i];
      const code = text.charCodeAt(i);

      if (mode === 0 || mode === 2 || mode === 4 || mode === 6) {
        ctx.fillText(ch, xOffset, 0);
      }
      if (mode === 1 || mode === 2 || mode === 5 || mode === 6) {
        ctx.strokeText(ch, xOffset, 0);
      }

      // Advance per PDF spec: (w0 * Tfs / 1000 + Tc + (space ? Tw : 0)) * Th
      const w0 = _getGlyphWidth1000(gs.fontName, code);
      xOffset += (w0 * gs.fontSize / 1000 + Tc2 + (code === 32 ? Tw2 : 0)) * Th2;
    }

    ctx.restore();

    // Advance text matrix by the total text advance
    // The advancement is in text space (un-transformed), so we need
    // to compute it in the original PDF coordinate space.
    this._advanceTextMatrix(text, gs);
  }

  /**
   * Advance the text matrix by the width of the given text string.
   * All calculations are in PDF text space (user space) units.
   *
   * Per PDF spec, glyph advance = (w0 * fontSize / 1000 + Tc + (space ? Tw : 0)) * Th
   *
   * @param {string} text
   * @param {GraphicsState} gs
   */
  _advanceTextMatrix(text, gs) {
    if (!text) return;

    const fontSize = gs.fontSize;
    const Tc       = gs.charSpacing;
    const Tw       = gs.wordSpacing;
    const Th       = gs.horizScaling / 100;
    const fontName = gs.fontName;

    let totalAdvance = 0;

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);

      // Get glyph width in 1/1000 text units from AFM table
      const glyphWidth1000 = _getGlyphWidth1000(fontName, code);

      // Glyph advance in text space (PDF spec formula):
      // tx = (w0 * Tfs / 1000 + Tc + (space ? Tw : 0)) * Th
      const advance = (glyphWidth1000 * fontSize / 1000 + Tc + (code === 32 ? Tw : 0)) * Th;

      totalAdvance += advance;
    }

    // Advance tm along the x axis in text space
    this._textState.tm = _matTranslate(this._textState.tm, totalAdvance, 0);
  }

  // ── Font resolution ────────────────────────────────────────────────────────

  /**
   * Resolve a font resource name to its PDF font dict.
   * Returns an object with { baseFontName, encoding }.
   * Falls back to Helvetica if not found.
   * @deprecated Use _resolveFontAsync for full ToUnicode support.
   */
  _resolveFont(fontRefName, resources) {
    const fonts = resources && resources['/Font'];
    if (!fonts || typeof fonts !== 'object') {
      return { baseFontName: fontRefName };
    }

    // Try with and without leading slash
    const key1 = '/' + fontRefName;
    const key2 = fontRefName;
    const fontDict = fonts[key1] || fonts[key2];

    if (!fontDict) return { baseFontName: fontRefName };

    // fontDict may be a resolved dict or a stream
    const dict = fontDict.isStream ? fontDict.dict : fontDict;
    if (!dict || typeof dict !== 'object') return { baseFontName: fontRefName };

    const baseFont = dict['/BaseFont'];
    if (typeof baseFont === 'string') {
      return {
        baseFontName: baseFont.startsWith('/') ? baseFont.slice(1) : baseFont,
        encoding: dict['/Encoding'],
      };
    }

    return { baseFontName: fontRefName };
  }

  /**
   * Async font resolution: resolves /ToUnicode CMap and /Encoding.
   *
   * Returns:
   *   { baseFontName, toUnicodeMap, encodingTable, isComposite }
   *
   * - toUnicodeMap: Map<charCode, unicodeStr> from /ToUnicode, or null
   * - encodingTable: Uint32Array[256] from /Encoding, or null
   * - isComposite: true for Type0/CIDFont (2-byte char codes in content streams)
   */
  async _resolveFontAsync(fontRefName, resources) {
    const fonts = resources && resources['/Font'];
    if (!fonts || typeof fonts !== 'object') {
      return { baseFontName: fontRefName, isComposite: false };
    }

    const key1 = '/' + fontRefName;
    const key2 = fontRefName;
    let fontEntry = fonts[key1] || fonts[key2];

    if (!fontEntry) return { baseFontName: fontRefName, isComposite: false };

    // Resolve indirect references
    if (fontEntry && fontEntry.isRef && this._parser) {
      try {
        fontEntry = await this._parser.resolveObject(fontEntry.objNum, fontEntry.genNum);
      } catch (_) {}
    }

    const dict = (fontEntry && fontEntry.isStream) ? fontEntry.dict : fontEntry;
    if (!dict || typeof dict !== 'object') {
      return { baseFontName: fontRefName, isComposite: false };
    }

    // Determine base font name
    let baseFontName = fontRefName;
    const baseFont = dict['/BaseFont'];
    if (typeof baseFont === 'string') {
      baseFontName = baseFont.startsWith('/') ? baseFont.slice(1) : baseFont;
    }

    // Determine if composite (Type0/CIDFont) — uses 2-byte char codes
    const subtype = dict['/Subtype'];
    const isComposite = (subtype === '/Type0' || subtype === 'Type0');

    // Resolve /ToUnicode CMap
    let toUnicodeMap = null;
    const tuEntry = dict['/ToUnicode'];
    if (tuEntry) {
      try {
        let tuStream = tuEntry;
        // Resolve indirect ref
        if (tuEntry.isRef && this._parser) {
          tuStream = await this._parser.resolveObject(tuEntry.objNum, tuEntry.genNum);
        }
        if (tuStream && tuStream.isStream) {
          const tuBytes = await tuStream.getBytes();
          const tuText  = _uint8ArrayToString(tuBytes);
          toUnicodeMap  = _parseToUnicodeCMap(tuText);
        }
      } catch (_) {}
    }

    // Resolve /Encoding (only relevant for simple fonts without ToUnicode)
    let encodingTable = null;
    if (!toUnicodeMap && !isComposite) {
      const encEntry = dict['/Encoding'];
      if (encEntry) {
        try {
          let encValue = encEntry;
          // Resolve indirect ref
          if (encEntry.isRef && this._parser) {
            encValue = await this._parser.resolveObject(encEntry.objNum, encEntry.genNum);
          }
          encodingTable = _resolveEncoding(encValue);
        } catch (_) {}
      }
    }

    return { baseFontName, toUnicodeMap, encodingTable, isComposite };
  }

  // ── XObject invocation ────────────────────────────────────────────────────

  /**
   * Invoke an XObject (image or form).
   * @param {string} name — XObject resource name (e.g. '/Im1')
   * @param {object} resources
   * @param {CanvasRenderingContext2D} ctx
   * @param {GraphicsState} gs
   */
  async _invokeXObject(name, resources, ctx, gs) {
    const xobjects = resources && resources['/XObject'];
    if (!xobjects || typeof xobjects !== 'object') return;

    const key1 = name.startsWith('/') ? name : '/' + name;
    const key2 = name.startsWith('/') ? name.slice(1) : name;
    const xobj = xobjects[key1] || xobjects[key2];

    if (!xobj) return;

    const dict     = xobj.isStream ? xobj.dict : xobj;
    const subtype  = dict && (dict['/Subtype'] || dict['/S']);

    if (subtype === '/Image') {
      await this._drawImageXObject(xobj, ctx, gs);
    } else if (subtype === '/Form') {
      await this._drawFormXObject(xobj, resources, ctx, gs);
    }
    // Other subtypes (PS, etc.) are ignored
  }

  /**
   * Draw an image XObject to the canvas.
   */
  async _drawImageXObject(imageStream, ctx, gs) {
    let img;
    try {
      img = await _decodeImage(imageStream, this._parser);
    } catch (_) {
      img = null;
    }

    if (!img) {
      // Show a light gray placeholder rectangle for missing images
      const dict   = imageStream.isStream ? imageStream.dict : imageStream;
      const width  = (dict && dict['/Width'])  || 100;
      const height = (dict && dict['/Height']) || 100;
      ctx.save();
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(0, 0, width, -height); // -height because Y is flipped
      ctx.restore();
      return;
    }

    const dict   = imageStream.isStream ? imageStream.dict : imageStream;
    const width  = (dict && dict['/Width'])  || (img.width  || 0);
    const height = (dict && dict['/Height']) || (img.height || 0);

    if (!width || !height) return;

    ctx.save();
    // Scale image from 1×1 user space to actual dimensions
    // In PDF, images are placed in a 1×1 user-space box; the CTM scales them.
    // We scale to image pixel size and flip Y since image origin is top-left.
    ctx.transform(1/width, 0, 0, -1/height, 0, 1);
    try {
      ctx.drawImage(img, 0, 0, width, height);
    } catch (_) {}
    ctx.restore();
  }

  /**
   * Draw a Form XObject (embedded PDF page fragment).
   * Recursively interprets the form's content stream.
   */
  async _drawFormXObject(formStream, parentResources, ctx, gs) {
    if (!formStream || !formStream.isStream) return;

    const dict = formStream.dict || {};
    let formBytes;
    try {
      formBytes = await formStream.getBytes();
    } catch (_) {
      return;
    }

    if (!formBytes || formBytes.length === 0) return;

    // Form has its own resources (merged with parent)
    const formResources = dict['/Resources'];
    const resources = _mergeResources(formResources, parentResources);

    // Apply form matrix if present
    const matrix = dict['/Matrix'];
    ctx.save();
    if (Array.isArray(matrix) && matrix.length >= 6) {
      ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    }

    // Apply clipping bbox if present
    const bbox = dict['/BBox'];
    if (Array.isArray(bbox) && bbox.length >= 4) {
      ctx.beginPath();
      ctx.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
      ctx.clip();
    }

    // Save graphics state and interpret form content
    this._gsStack.push(gs.clone());
    await this._interpretContentStream(formBytes, resources);
    if (this._gsStack.length > 0) {
      this._gs = this._gsStack.pop();
    }

    ctx.restore();
  }

  // ── Extended graphics state ────────────────────────────────────────────────

  /**
   * Apply an /ExtGState dictionary entry.
   * Only handles common properties (opacity, blend mode, line width).
   */
  _applyExtGState(name, resources, ctx, gs) {
    const extGState = resources && resources['/ExtGState'];
    if (!extGState) return;

    const key1 = name.startsWith('/') ? name : '/' + name;
    const gsDict = extGState[key1] || extGState[name.replace(/^\//, '')];
    if (!gsDict || typeof gsDict !== 'object') return;

    // /ca — fill opacity (non-stroking)
    if (typeof gsDict['/ca'] === 'number') {
      ctx.globalAlpha = Math.max(0, Math.min(1, gsDict['/ca']));
    }
    // /CA — stroke opacity
    if (typeof gsDict['/CA'] === 'number') {
      ctx.globalAlpha = Math.max(0, Math.min(1, gsDict['/CA']));
    }
    // /LW — line width
    if (typeof gsDict['/LW'] === 'number') {
      gs.lineWidth = gsDict['/LW'];
      ctx.lineWidth = gs.lineWidth;
    }
    // /BM — blend mode (ignored, no Canvas equivalent for PDF blend modes)
    // /SMask — soft mask (ignored)
  }
}

// ─── Inline matrix helpers ────────────────────────────────────────────────────

function _matMul(m1, m2) {
  // [a, b, c, d, e, f] represents:
  // [ a c e ]
  // [ b d f ]
  // [ 0 0 1 ]
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1*a2 + c1*b2,
    b1*a2 + d1*b2,
    a1*c2 + c1*d2,
    b1*c2 + d1*d2,
    a1*e2 + c1*f2 + e1,
    b1*e2 + d1*f2 + f1,
  ];
}

function _matTranslate(m, tx, ty) {
  // Apply translation to matrix
  const [a, b, c, d, e, f] = m;
  return [a, b, c, d, a*tx + c*ty + e, b*tx + d*ty + f];
}

// ─── Glyph width helper ───────────────────────────────────────────────────────

/**
 * _getGlyphWidth1000(fontName, charCode) → number
 *
 * Returns glyph advance width in 1/1000 of text unit for a given font
 * and character code. Uses the fonts module's getCharWidth if available.
 */
function _getGlyphWidth1000(fontName, charCode) {
  if (typeof _getCharWidth === 'function') {
    const w = _getCharWidth(fontName, charCode);
    if (typeof w === 'number' && w > 0) return w;
  }
  // Generic fallback for unknown/non-standard fonts
  // Use a reasonable average advance for typical proportional fonts
  if (charCode === 32) return 278;  // space
  if (charCode >= 48 && charCode <= 57) return 556; // digits
  if (charCode >= 65 && charCode <= 90) return 667; // uppercase
  if (charCode >= 97 && charCode <= 122) return 500; // lowercase
  return 556;
}

// ─── Color helpers ─────────────────────────────────────────────────────────────

function _rgbCSS(r, g, b) {
  const ri = Math.round(Math.max(0, Math.min(1, r)) * 255);
  const gi = Math.round(Math.max(0, Math.min(1, g)) * 255);
  const bi = Math.round(Math.max(0, Math.min(1, b)) * 255);
  return 'rgb(' + ri + ',' + gi + ',' + bi + ')';
}

function _cmykToRGB(c, m, y, k) {
  return [
    (1 - Math.min(1, c + k)),
    (1 - Math.min(1, m + k)),
    (1 - Math.min(1, y + k)),
  ];
}

// ─── String helper ────────────────────────────────────────────────────────────

/**
 * Convert a Uint8Array to a Latin-1 string (for CMap text parsing).
 * PDF CMaps are ASCII-safe so Latin-1 is sufficient.
 */
function _uint8ArrayToString(bytes) {
  if (!bytes || bytes.length === 0) return '';
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

// ─── Resource helpers ──────────────────────────────────────────────────────────

function _mergeResources(formRes, parentRes) {
  if (!formRes) return parentRes || {};
  if (!parentRes) return formRes || {};
  // Form resources take precedence
  return Object.assign({}, parentRes, formRes);
}

// ─── Stack helpers ─────────────────────────────────────────────────────────────

/** Get a number from the operand stack at position from the end (0 = top). */
function _getNum(stack, posFromEnd, defaultVal) {
  if (!stack || stack.length === 0) return defaultVal !== undefined ? defaultVal : 0;
  const idx = stack.length - 1 - (posFromEnd || 0);
  if (idx < 0 || idx >= stack.length) return defaultVal !== undefined ? defaultVal : 0;
  return _tokenToNum(stack[idx], defaultVal !== undefined ? defaultVal : 0);
}

/** Get an integer from the operand stack. */
function _getInt(stack, posFromEnd, defaultVal) {
  return Math.round(_getNum(stack, posFromEnd, defaultVal));
}

/** Get N numbers from the stack (bottom-to-top order). */
function _getNumbers(stack, n) {
  const result = [];
  for (let i = n - 1; i >= 0; i--) {
    result.push(_getNum(stack, i, 0));
  }
  return result;
}

/** Get all available numbers from the stack (in order). */
function _getAvailableNumbers(stack) {
  const nums = [];
  for (let i = 0; i < stack.length; i++) {
    const t = stack[i];
    if (t && t.type === 'number') nums.push(t.value);
  }
  return nums;
}

function _tokenToNum(token, defaultVal) {
  if (!token) return defaultVal !== undefined ? defaultVal : 0;
  if (token.type === 'number') return token.value;
  if (typeof token === 'number') return token;
  return defaultVal !== undefined ? defaultVal : 0;
}

// ─── Content stream tokenizer helpers ────────────────────────────────────────

function _isWS(c) {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x00;
}

function _isDelim(c) {
  return c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e ||
         c === 0x5b || c === 0x5d || c === 0x2f || c === 0x25;
}

function _isRegular(c) {
  return !_isWS(c) && !_isDelim(c);
}

function _hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return 0;
}

function _parseName(bytes, offset) {
  let i = offset + 1;
  const len = bytes.length;
  let name = '';
  while (i < len && _isRegular(bytes[i])) {
    const c = bytes[i];
    if (c === 0x23 && i + 2 < len) {
      name += String.fromCharCode((_hexVal(bytes[i+1]) << 4) | _hexVal(bytes[i+2]));
      i += 3;
    } else {
      name += String.fromCharCode(c);
      i++;
    }
  }
  return { type: 'name', value: '/' + name, nextOffset: i };
}

function _parseLiteralString(bytes, offset) {
  let i = offset + 1;
  const len = bytes.length;
  const out = [];
  let depth = 1;
  while (i < len && depth > 0) {
    const c = bytes[i];
    if (c === 0x5c) { // backslash
      i++;
      if (i >= len) break;
      const esc = bytes[i];
      switch (esc) {
        case 0x6e: out.push(0x0a); break;
        case 0x72: out.push(0x0d); break;
        case 0x74: out.push(0x09); break;
        case 0x62: out.push(0x08); break;
        case 0x66: out.push(0x0c); break;
        case 0x28: out.push(0x28); break;
        case 0x29: out.push(0x29); break;
        case 0x5c: out.push(0x5c); break;
        case 0x0a: break;
        case 0x0d:
          if (i + 1 < len && bytes[i+1] === 0x0a) i++;
          break;
        default:
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
    } else if (c === 0x28) {
      depth++;
      out.push(c);
    } else if (c === 0x29) {
      depth--;
      if (depth > 0) out.push(c);
    } else {
      out.push(c);
    }
    i++;
  }
  return {
    type: 'string',
    value: new Uint8Array(out),
    stringType: 'literal',
    nextOffset: i,
  };
}

function _parseHexString(bytes, offset) {
  let i = offset + 1;
  const len = bytes.length;
  const hex = [];
  while (i < len && bytes[i] !== 0x3e) {
    const c = bytes[i];
    if (!_isWS(c)) hex.push(c);
    i++;
  }
  if (i < len) i++; // skip '>'
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let j = 0; j < out.length; j++) {
    const hi = _hexVal(hex[j * 2]);
    const lo = j * 2 + 1 < hex.length ? _hexVal(hex[j * 2 + 1]) : 0;
    out[j] = (hi << 4) | lo;
  }
  return {
    type: 'string',
    value: out,
    stringType: 'hex',
    nextOffset: i,
  };
}

function _parseArray(bytes, offset) {
  let i = offset + 1;
  const len = bytes.length;
  const arr = [];
  while (i < len) {
    while (i < len && _isWS(bytes[i])) i++;
    if (i >= len || bytes[i] === 0x5d) { i++; break; }
    const c = bytes[i];
    if (c === 0x28) {
      const r = _parseLiteralString(bytes, i);
      arr.push(r);
      i = r.nextOffset;
    } else if (c === 0x3c) {
      if (i + 1 < len && bytes[i+1] === 0x3c) {
        // Skip nested dict in array (rare in content streams)
        i += 2;
        let depth = 1;
        while (i < len && depth > 0) {
          if (i + 1 < len && bytes[i] === 0x3c && bytes[i+1] === 0x3c) { depth++; i += 2; }
          else if (i + 1 < len && bytes[i] === 0x3e && bytes[i+1] === 0x3e) { depth--; i += 2; }
          else i++;
        }
      } else {
        const r = _parseHexString(bytes, i);
        arr.push(r);
        i = r.nextOffset;
      }
    } else if (c === 0x2f) {
      const r = _parseName(bytes, i);
      arr.push(r);
      i = r.nextOffset;
    } else {
      // Number or token
      const r = _parseToken(bytes, i);
      if (r) {
        arr.push(r.type === 'number' ? r.value : r);
        i = r.nextOffset;
      } else {
        i++;
      }
    }
  }
  return { type: 'array', value: arr, nextOffset: i };
}

function _parseDict(bytes, offset) {
  // Simple dict parser for content stream dicts (inline image params, etc.)
  let i = offset + 2; // skip '<<'
  const len = bytes.length;
  const dict = {};
  while (i < len) {
    while (i < len && _isWS(bytes[i])) i++;
    if (i + 1 < len && bytes[i] === 0x3e && bytes[i+1] === 0x3e) { i += 2; break; }
    if (i >= len) break;
    if (bytes[i] !== 0x2f) { i++; continue; } // expect name key
    const keyResult = _parseName(bytes, i);
    i = keyResult.nextOffset;
    while (i < len && _isWS(bytes[i])) i++;
    if (i >= len) break;
    // Parse value
    const c = bytes[i];
    let val;
    if (c === 0x2f) {
      const r = _parseName(bytes, i);
      val = r.value;
      i = r.nextOffset;
    } else if (c === 0x28) {
      const r = _parseLiteralString(bytes, i);
      val = r.value;
      i = r.nextOffset;
    } else if (c === 0x3c) {
      if (i + 1 < len && bytes[i+1] === 0x3c) {
        const r = _parseDict(bytes, i);
        val = r.value;
        i = r.nextOffset;
      } else {
        const r = _parseHexString(bytes, i);
        val = r.value;
        i = r.nextOffset;
      }
    } else if (c === 0x5b) {
      const r = _parseArray(bytes, i);
      val = r.value;
      i = r.nextOffset;
    } else {
      const r = _parseToken(bytes, i);
      if (r) { val = r.type === 'number' ? r.value : r.value; i = r.nextOffset; }
      else { i++; val = null; }
    }
    dict[keyResult.value] = val;
  }
  return { type: 'dict', value: dict, nextOffset: i };
}

function _parseToken(bytes, offset) {
  const len = bytes.length;
  let i = offset;
  let tok = '';
  while (i < len && _isRegular(bytes[i])) {
    tok += String.fromCharCode(bytes[i]);
    i++;
  }
  if (tok === '') return null;

  if (tok === 'true')  return { type: 'bool',  value: true,  nextOffset: i };
  if (tok === 'false') return { type: 'bool',  value: false, nextOffset: i };
  if (tok === 'null')  return { type: 'null',  value: null,  nextOffset: i };

  const n = parseFloat(tok);
  if (!isNaN(n) && tok.length > 0) {
    return { type: 'number', value: n, nextOffset: i };
  }

  // It's an operator keyword
  return { type: 'op', value: tok, nextOffset: i };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PDFRenderer };
} else {
  window.PDFRenderer = PDFRenderer;
}
