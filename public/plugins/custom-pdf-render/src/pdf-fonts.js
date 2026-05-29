/**
 * pdf-fonts.js — Font metrics and string decoding for the custom PDF renderer.
 * Part of the custom-pdf-render engine for Gogs.
 *
 * Provides:
 *   - getStandardFontCSS(pdfFontName) — CSS font-family for the 14 standard PDF fonts
 *   - pdfStringToText(uint8arr, encoding) — decode PDF string bytes to JS string
 *
 * No external library imports. No font file loading.
 * Uses canvas ctx.measureText as fallback for non-standard fonts.
 */

'use strict';

// ─── Standard PDF Font → CSS mapping ─────────────────────────────────────────

/**
 * The 14 standard PDF fonts and their CSS equivalents.
 * Keys are the base font names as they appear in PDF /BaseFont.
 */
const STANDARD_FONT_MAP = {
  // Helvetica family
  'Helvetica':             'Helvetica, Arial, sans-serif',
  'Helvetica-Bold':        'Helvetica, Arial, sans-serif',
  'Helvetica-Oblique':     'Helvetica, Arial, sans-serif',
  'Helvetica-BoldOblique': 'Helvetica, Arial, sans-serif',

  // Times family
  'Times-Roman':           '"Times New Roman", Times, serif',
  'Times-Bold':            '"Times New Roman", Times, serif',
  'Times-Italic':          '"Times New Roman", Times, serif',
  'Times-BoldItalic':      '"Times New Roman", Times, serif',

  // Courier family
  'Courier':               '"Courier New", Courier, monospace',
  'Courier-Bold':          '"Courier New", Courier, monospace',
  'Courier-Oblique':       '"Courier New", Courier, monospace',
  'Courier-BoldOblique':   '"Courier New", Courier, monospace',

  // Symbol and Zapf Dingbats
  'Symbol':                'Symbol, serif',
  'ZapfDingbats':          '"Zapf Dingbats", serif',
};

/**
 * CSS font-style and font-weight modifiers derived from font name suffixes.
 */
const FONT_STYLE_MODIFIERS = {
  'Helvetica-Bold':        { weight: 'bold',   style: 'normal' },
  'Helvetica-Oblique':     { weight: 'normal', style: 'oblique' },
  'Helvetica-BoldOblique': { weight: 'bold',   style: 'oblique' },
  'Times-Bold':            { weight: 'bold',   style: 'normal' },
  'Times-Italic':          { weight: 'normal', style: 'italic' },
  'Times-BoldItalic':      { weight: 'bold',   style: 'italic' },
  'Courier-Bold':          { weight: 'bold',   style: 'normal' },
  'Courier-Oblique':       { weight: 'normal', style: 'oblique' },
  'Courier-BoldOblique':   { weight: 'bold',   style: 'oblique' },
};

// ─── Standard font width tables (in 1/1000 of text space units) ───────────────
// Sourced from Adobe AFM files (public domain data).
// Each array has 256 entries indexed by character code 0–255.
// Missing/undefined codes default to 278 (a reasonable fallback).

const DEFAULT_WIDTH = 278;

/**
 * Helvetica widths (non-bold, non-italic variant).
 * Codes 32–126 are the standard printable ASCII range.
 */
const HELVETICA_WIDTHS = (function() {
  const w = new Array(256).fill(278);
  // Space and basic punctuation
  w[32]  = 278;  // space
  w[33]  = 278;  // !
  w[34]  = 355;  // "
  w[35]  = 556;  // #
  w[36]  = 556;  // $
  w[37]  = 889;  // %
  w[38]  = 667;  // &
  w[39]  = 222;  // '
  w[40]  = 333;  // (
  w[41]  = 333;  // )
  w[42]  = 389;  // *
  w[43]  = 584;  // +
  w[44]  = 278;  // ,
  w[45]  = 333;  // -
  w[46]  = 278;  // .
  w[47]  = 278;  // /
  // Digits
  w[48]  = 556; w[49]  = 556; w[50]  = 556; w[51]  = 556;
  w[52]  = 556; w[53]  = 556; w[54]  = 556; w[55]  = 556;
  w[56]  = 556; w[57]  = 556;
  w[58]  = 278;  // :
  w[59]  = 278;  // ;
  w[60]  = 584;  // <
  w[61]  = 584;  // =
  w[62]  = 584;  // >
  w[63]  = 556;  // ?
  w[64]  = 1015; // @
  // Uppercase
  w[65]  = 667; w[66]  = 667; w[67]  = 722; w[68]  = 722;
  w[69]  = 667; w[70]  = 611; w[71]  = 778; w[72]  = 722;
  w[73]  = 278; w[74]  = 500; w[75]  = 667; w[76]  = 556;
  w[77]  = 833; w[78]  = 722; w[79]  = 778; w[80]  = 667;
  w[81]  = 778; w[82]  = 722; w[83]  = 667; w[84]  = 611;
  w[85]  = 722; w[86]  = 667; w[87]  = 944; w[88]  = 667;
  w[89]  = 667; w[90]  = 611;
  w[91]  = 278;  // [
  w[92]  = 278;  // backslash
  w[93]  = 278;  // ]
  w[94]  = 469;  // ^
  w[95]  = 556;  // _
  w[96]  = 222;  // `
  // Lowercase
  w[97]  = 556; w[98]  = 556; w[99]  = 500; w[100] = 556;
  w[101] = 556; w[102] = 278; w[103] = 556; w[104] = 556;
  w[105] = 222; w[106] = 222; w[107] = 500; w[108] = 222;
  w[109] = 833; w[110] = 556; w[111] = 556; w[112] = 556;
  w[113] = 556; w[114] = 333; w[115] = 500; w[116] = 278;
  w[117] = 556; w[118] = 500; w[119] = 722; w[120] = 500;
  w[121] = 500; w[122] = 500;
  w[123] = 334;  // {
  w[124] = 260;  // |
  w[125] = 334;  // }
  w[126] = 584;  // ~
  return w;
})();

/**
 * Times-Roman widths.
 */
const TIMES_ROMAN_WIDTHS = (function() {
  const w = new Array(256).fill(250);
  w[32]  = 250;  // space
  w[33]  = 333;  // !
  w[34]  = 408;  // "
  w[35]  = 500;  // #
  w[36]  = 500;  // $
  w[37]  = 833;  // %
  w[38]  = 778;  // &
  w[39]  = 333;  // '
  w[40]  = 333;  // (
  w[41]  = 333;  // )
  w[42]  = 500;  // *
  w[43]  = 564;  // +
  w[44]  = 250;  // ,
  w[45]  = 333;  // -
  w[46]  = 250;  // .
  w[47]  = 278;  // /
  w[48]  = 500; w[49]  = 500; w[50]  = 500; w[51]  = 500;
  w[52]  = 500; w[53]  = 500; w[54]  = 500; w[55]  = 500;
  w[56]  = 500; w[57]  = 500;
  w[58]  = 278;  // :
  w[59]  = 278;  // ;
  w[60]  = 564;  // <
  w[61]  = 564;  // =
  w[62]  = 564;  // >
  w[63]  = 444;  // ?
  w[64]  = 921;  // @
  w[65]  = 722; w[66]  = 667; w[67]  = 667; w[68]  = 722;
  w[69]  = 611; w[70]  = 556; w[71]  = 722; w[72]  = 722;
  w[73]  = 333; w[74]  = 389; w[75]  = 722; w[76]  = 611;
  w[77]  = 889; w[78]  = 722; w[79]  = 722; w[80]  = 556;
  w[81]  = 722; w[82]  = 667; w[83]  = 556; w[84]  = 611;
  w[85]  = 722; w[86]  = 722; w[87]  = 944; w[88]  = 722;
  w[89]  = 722; w[90]  = 611;
  w[91]  = 333;  // [
  w[92]  = 278;  // backslash
  w[93]  = 333;  // ]
  w[94]  = 469;  // ^
  w[95]  = 500;  // _
  w[96]  = 333;  // `
  w[97]  = 444; w[98]  = 500; w[99]  = 444; w[100] = 500;
  w[101] = 444; w[102] = 333; w[103] = 500; w[104] = 500;
  w[105] = 278; w[106] = 278; w[107] = 500; w[108] = 278;
  w[109] = 778; w[110] = 500; w[111] = 500; w[112] = 500;
  w[113] = 500; w[114] = 333; w[115] = 389; w[116] = 278;
  w[117] = 500; w[118] = 500; w[119] = 722; w[120] = 500;
  w[121] = 500; w[122] = 444;
  w[123] = 480;  // {
  w[124] = 200;  // |
  w[125] = 480;  // }
  w[126] = 541;  // ~
  return w;
})();

/**
 * Courier widths — monospaced, all characters are 600 units wide.
 */
const COURIER_WIDTHS = new Array(256).fill(600);

/**
 * Map from standard PDF font name to its width array.
 * For font variants (Bold, Italic, etc.) we reuse the same array
 * since only the CSS style changes; the advance widths vary slightly
 * but this is an acceptable approximation for our purposes.
 */
const FONT_WIDTH_TABLES = {
  'Helvetica':             HELVETICA_WIDTHS,
  'Helvetica-Bold':        HELVETICA_WIDTHS,
  'Helvetica-Oblique':     HELVETICA_WIDTHS,
  'Helvetica-BoldOblique': HELVETICA_WIDTHS,
  'Times-Roman':           TIMES_ROMAN_WIDTHS,
  'Times-Bold':            TIMES_ROMAN_WIDTHS,
  'Times-Italic':          TIMES_ROMAN_WIDTHS,
  'Times-BoldItalic':      TIMES_ROMAN_WIDTHS,
  'Courier':               COURIER_WIDTHS,
  'Courier-Bold':          COURIER_WIDTHS,
  'Courier-Oblique':       COURIER_WIDTHS,
  'Courier-BoldOblique':   COURIER_WIDTHS,
  'Symbol':                new Array(256).fill(500),
  'ZapfDingbats':          new Array(256).fill(500),
};

// ─── getStandardFontCSS ───────────────────────────────────────────────────────

/**
 * getStandardFontCSS(pdfFontName) → string
 *
 * Map a PDF /BaseFont name to a CSS font-family string.
 * Handles the 14 standard PDF fonts.
 * For non-standard font names, returns a generic sans-serif fallback.
 *
 * @param {string} pdfFontName — e.g. 'Helvetica', 'Times-Roman', 'Courier-Bold'
 * @returns {string} CSS font-family value
 */
function getStandardFontCSS(pdfFontName) {
  if (typeof pdfFontName !== 'string') return 'Arial, sans-serif';
  // Strip leading slash if present (PDF name object format)
  const name = pdfFontName.startsWith('/') ? pdfFontName.slice(1) : pdfFontName;
  return STANDARD_FONT_MAP[name] || 'Arial, sans-serif';
}

/**
 * getStandardFontStyle(pdfFontName) → { weight, style }
 *
 * Returns the CSS font-weight and font-style for a standard font name.
 *
 * @param {string} pdfFontName
 * @returns {{ weight: string, style: string }}
 */
function getStandardFontStyle(pdfFontName) {
  if (typeof pdfFontName !== 'string') return { weight: 'normal', style: 'normal' };
  const name = pdfFontName.startsWith('/') ? pdfFontName.slice(1) : pdfFontName;
  return FONT_STYLE_MODIFIERS[name] || { weight: 'normal', style: 'normal' };
}

/**
 * getCharWidth(fontName, charCode) → number
 *
 * Returns the advance width for the given character code in units of 1/1000
 * of the text space unit for the named standard PDF font.
 *
 * @param {string} fontName — bare font name without leading slash
 * @param {number} charCode — character code 0–255
 * @returns {number} width in 1/1000 text space units
 */
function getCharWidth(fontName, charCode) {
  const table = FONT_WIDTH_TABLES[fontName];
  if (!table) return DEFAULT_WIDTH;
  if (charCode < 0 || charCode >= table.length) return DEFAULT_WIDTH;
  return table[charCode];
}

/**
 * measureTextWidth(fontName, fontSize, text) → number
 *
 * Estimate the width of a text string in PDF user space units using the
 * embedded width tables. Falls back to a character-count heuristic for
 * non-standard fonts.
 *
 * @param {string} fontName — PDF /BaseFont name (no leading slash)
 * @param {number} fontSize — font size in PDF user space units
 * @param {string} text     — the text string
 * @returns {number} estimated width in PDF user space units
 */
function measureTextWidth(fontName, fontSize, text) {
  if (!text || text.length === 0) return 0;
  const table = FONT_WIDTH_TABLES[fontName];
  if (!table) {
    // Fallback: approximate 0.6 × fontSize per character for sans-serif
    return text.length * fontSize * 0.6;
  }
  let totalWidth = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    totalWidth += (code < table.length ? table[code] : DEFAULT_WIDTH);
  }
  // Width tables are in 1/1000 units; multiply by fontSize/1000
  return (totalWidth / 1000) * fontSize;
}

// ─── pdfStringToText ──────────────────────────────────────────────────────────

/**
 * pdfStringToText(uint8arr, fontEncoding) → string
 *
 * Decode a PDF string (Uint8Array of raw bytes) to a JavaScript string.
 * Handles:
 *   - UTF-16BE with BOM (0xFE 0xFF): decode as UTF-16BE
 *   - Latin-1 (ISO-8859-1): byte → char code directly
 *
 * fontEncoding is currently unused but reserved for future per-font
 * encoding maps (e.g. MacRomanEncoding, WinAnsiEncoding).
 *
 * @param {Uint8Array|null} uint8arr  — raw PDF string bytes
 * @param {string}          [fontEncoding] — hint for encoding (unused)
 * @returns {string}
 */
function pdfStringToText(uint8arr, fontEncoding) {
  if (!uint8arr || uint8arr.length === 0) return '';

  // UTF-16BE BOM detection: 0xFE 0xFF
  if (uint8arr.length >= 2 && uint8arr[0] === 0xFE && uint8arr[1] === 0xFF) {
    return _decodeUTF16BE(uint8arr, 2);
  }

  // UTF-16LE BOM detection: 0xFF 0xFE (less common in PDFs but handle it)
  if (uint8arr.length >= 2 && uint8arr[0] === 0xFF && uint8arr[1] === 0xFE) {
    return _decodeUTF16LE(uint8arr, 2);
  }

  // Default: Latin-1 (PDFDocEncoding fallback)
  return _decodeLatin1(uint8arr);
}

/**
 * _decodeLatin1(bytes) → string
 * Decode bytes as Latin-1 (ISO-8859-1): each byte maps directly to its
 * Unicode code point.
 */
function _decodeLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

/**
 * _decodeUTF16BE(bytes, startOffset) → string
 * Decode bytes as UTF-16 big-endian starting at startOffset.
 * Handles surrogate pairs for characters outside BMP.
 */
function _decodeUTF16BE(bytes, startOffset) {
  let s = '';
  let i = startOffset || 0;
  while (i + 1 < bytes.length) {
    const hi = bytes[i];
    const lo = bytes[i + 1];
    i += 2;
    const code = (hi << 8) | lo;
    // Surrogate pair detection
    if (code >= 0xD800 && code <= 0xDBFF) {
      // High surrogate — need a low surrogate
      if (i + 1 < bytes.length) {
        const hi2 = bytes[i];
        const lo2 = bytes[i + 1];
        const low  = (hi2 << 8) | lo2;
        if (low >= 0xDC00 && low <= 0xDFFF) {
          // Valid surrogate pair
          const codePoint = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
          s += String.fromCodePoint(codePoint);
          i += 2;
          continue;
        }
      }
      // Lone high surrogate — output replacement character
      s += '�';
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      // Lone low surrogate
      s += '�';
    } else {
      s += String.fromCharCode(code);
    }
  }
  return s;
}

/**
 * _decodeUTF16LE(bytes, startOffset) → string
 * Decode bytes as UTF-16 little-endian starting at startOffset.
 */
function _decodeUTF16LE(bytes, startOffset) {
  let s = '';
  let i = startOffset || 0;
  while (i + 1 < bytes.length) {
    const lo = bytes[i];
    const hi = bytes[i + 1];
    i += 2;
    const code = (hi << 8) | lo;
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < bytes.length) {
      const lo2 = bytes[i];
      const hi2 = bytes[i + 1];
      const low  = (hi2 << 8) | lo2;
      if (low >= 0xDC00 && low <= 0xDFFF) {
        const codePoint = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        s += String.fromCodePoint(codePoint);
        i += 2;
        continue;
      }
    }
    s += String.fromCharCode(code);
  }
  return s;
}

// ─── Standard encoding tables ─────────────────────────────────────────────────

/**
 * WinAnsiEncoding: code point → Unicode codepoint.
 * Covers the 256-entry Windows-1252 character set commonly used in PDFs.
 * Codes 0x00–0x7F match ASCII. Codes 0x80–0x9F follow CP1252 extensions.
 * Codes 0xA0–0xFF match Latin-1 Supplement.
 */
const WIN_ANSI_ENCODING = (function () {
  const t = new Array(256);
  for (let i = 0; i < 256; i++) t[i] = i; // default: identity (Latin-1)
  // Windows-1252 overrides in 0x80–0x9F range
  t[0x80] = 0x20AC; // €
  t[0x82] = 0x201A; // ‚
  t[0x83] = 0x0192; // ƒ
  t[0x84] = 0x201E; // „
  t[0x85] = 0x2026; // …
  t[0x86] = 0x2020; // †
  t[0x87] = 0x2021; // ‡
  t[0x88] = 0x02C6; // ˆ
  t[0x89] = 0x2030; // ‰
  t[0x8A] = 0x0160; // Š
  t[0x8B] = 0x2039; // ‹
  t[0x8C] = 0x0152; // Œ
  t[0x8E] = 0x017D; // Ž
  t[0x91] = 0x2018; // '
  t[0x92] = 0x2019; // '
  t[0x93] = 0x201C; // "
  t[0x94] = 0x201D; // "
  t[0x95] = 0x2022; // •
  t[0x96] = 0x2013; // –
  t[0x97] = 0x2014; // —
  t[0x98] = 0x02DC; // ˜
  t[0x99] = 0x2122; // ™
  t[0x9A] = 0x0161; // š
  t[0x9B] = 0x203A; // ›
  t[0x9C] = 0x0153; // œ
  t[0x9E] = 0x017E; // ž
  t[0x9F] = 0x0178; // Ÿ
  return t;
})();

/**
 * MacRomanEncoding: code point → Unicode codepoint.
 * Standard Mac Roman character set used in older Mac PDFs.
 */
const MAC_ROMAN_ENCODING = (function () {
  const t = new Array(256);
  for (let i = 0; i < 128; i++) t[i] = i; // ASCII
  // Mac Roman high bytes (0x80–0xFF)
  const high = [
    0x00C4,0x00C5,0x00C7,0x00C9,0x00D1,0x00D6,0x00DC,0x00E1,
    0x00E0,0x00E2,0x00E4,0x00E5,0x00E7,0x00E9,0x00E8,0x00EA,
    0x00EB,0x00ED,0x00EC,0x00EE,0x00EF,0x00F1,0x00F3,0x00F2,
    0x00F4,0x00F6,0x00FA,0x00F9,0x00FB,0x00FC,0x2020,0x00B0,
    0x00A2,0x00A3,0x00A7,0x2022,0x00B6,0x00DF,0x00AE,0x00A9,
    0x2122,0x00B4,0x00A8,0x2260,0x00C6,0x00D8,0x221E,0x00B1,
    0x2264,0x2265,0x00A5,0x00B5,0x2202,0x2211,0x220F,0x03C0,
    0x222B,0x00AA,0x00BA,0x03A9,0x00E6,0x00F8,0x00BF,0x00A1,
    0x00AC,0x221A,0x0192,0x2248,0x2206,0x00AB,0x00BB,0x2026,
    0x00A0,0x00C0,0x00C3,0x00D5,0x0152,0x0153,0x2013,0x2014,
    0x201C,0x201D,0x2018,0x2019,0x00F7,0x25CA,0x00FF,0x0178,
    0x2044,0x20AC,0x2039,0x203A,0xFB01,0xFB02,0x2021,0x00B7,
    0x201A,0x201E,0x2030,0x00C2,0x00CA,0x00C1,0x00CB,0x00C8,
    0x00CD,0x00CE,0x00CF,0x00CC,0x00D3,0x00D4,0xF8FF,0x00D2,
    0x00DA,0x00DB,0x00D9,0x0131,0x02C6,0x02DC,0x00AF,0x02D8,
    0x02D9,0x02DA,0x00B8,0x02DD,0x02DB,0x02C7,0x0000,0x0000,
  ];
  for (let i = 0; i < high.length; i++) t[0x80 + i] = high[i];
  return t;
})();

/**
 * StandardEncoding: code point → Unicode codepoint.
 * Adobe Standard Encoding for Type1 fonts.
 */
const STANDARD_ENCODING = (function () {
  const t = new Array(256).fill(0);
  // ASCII range 0x20–0x7E
  for (let i = 0x20; i <= 0x7E; i++) t[i] = i;
  // Notable overrides
  t[0x60] = 0x2018; // quoteleft → '
  t[0x27] = 0x2019; // quoteright → '
  t[0xA1] = 0x00A1; t[0xA2] = 0x00A2; t[0xA3] = 0x00A3;
  t[0xA4] = 0x2044; t[0xA5] = 0x00A5; t[0xA6] = 0x0192;
  t[0xA7] = 0x00A7; t[0xA8] = 0x00A4; t[0xA9] = 0x0027;
  t[0xAA] = 0x201C; t[0xAB] = 0x00AB; t[0xAC] = 0x2039;
  t[0xAD] = 0x203A; t[0xAE] = 0xFB01; t[0xAF] = 0xFB02;
  t[0xB0] = 0x2013; t[0xB1] = 0x2020; t[0xB2] = 0x2021;
  t[0xB3] = 0x00B7; t[0xB4] = 0x2022; t[0xB5] = 0x2026;
  t[0xB6] = 0x2030; t[0xB7] = 0x00BF; t[0xB8] = 0x0060;
  t[0xB9] = 0x00B4; t[0xBA] = 0x02C6; t[0xBB] = 0x02DC;
  t[0xBC] = 0x00AF; t[0xBD] = 0x02D8; t[0xBE] = 0x02D9;
  t[0xBF] = 0x02DA; t[0xC0] = 0x00B8; t[0xC1] = 0x02DD;
  t[0xC2] = 0x02DB; t[0xC3] = 0x02C7; t[0xC4] = 0x2014;
  t[0xC5] = 0x00C6; t[0xC6] = 0x00AA; t[0xC7] = 0x00BA;
  t[0xC8] = 0x00D8; t[0xC9] = 0x00C5; t[0xCA] = 0x0110;
  t[0xCB] = 0x014A; t[0xCC] = 0x00D0; t[0xCD] = 0x00DE;
  return t;
})();

/**
 * Map encoding name → encoding table
 */
const NAMED_ENCODINGS = {
  'WinAnsiEncoding':   WIN_ANSI_ENCODING,
  'MacRomanEncoding':  MAC_ROMAN_ENCODING,
  'StandardEncoding':  STANDARD_ENCODING,
};

/**
 * resolveEncoding(encodingEntry) → Uint32Array (256 entries, code → Unicode codepoint)
 *
 * Given a PDF font's /Encoding value (either a name string or a dict with
 * optional /BaseEncoding + /Differences), returns a 256-entry mapping from
 * character code to Unicode codepoint.
 *
 * @param {string|object|null} encodingEntry
 * @returns {Uint32Array} 256-length array: index=charCode, value=Unicode codepoint (0=unmapped)
 */
function resolveEncoding(encodingEntry) {
  if (!encodingEntry) {
    // Default: Latin-1 (identity for 0–255)
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) t[i] = i;
    return t;
  }

  // Bare name: '/WinAnsiEncoding' or 'WinAnsiEncoding'
  if (typeof encodingEntry === 'string') {
    const name = encodingEntry.startsWith('/') ? encodingEntry.slice(1) : encodingEntry;
    const base = NAMED_ENCODINGS[name];
    if (base) {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) t[i] = base[i] || 0;
      return t;
    }
    // Unknown encoding name — fall back to Latin-1
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) t[i] = i;
    return t;
  }

  // Dict with optional /BaseEncoding and /Differences
  if (typeof encodingEntry === 'object' && !Array.isArray(encodingEntry)) {
    const baseEnc = encodingEntry['/BaseEncoding'];
    let base;
    if (typeof baseEnc === 'string') {
      const name = baseEnc.startsWith('/') ? baseEnc.slice(1) : baseEnc;
      base = NAMED_ENCODINGS[name] || WIN_ANSI_ENCODING;
    } else {
      base = WIN_ANSI_ENCODING;
    }

    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) t[i] = base[i] || 0;

    // Apply /Differences array: [firstCode /GlyphName /GlyphName ...]
    const diffs = encodingEntry['/Differences'];
    if (Array.isArray(diffs)) {
      let code = 0;
      for (const item of diffs) {
        if (typeof item === 'number') {
          code = Math.round(item);
        } else if (item && item.type === 'number' && typeof item.value === 'number') {
          code = Math.round(item.value);
        } else {
          // It's a glyph name
          let glyphName;
          if (typeof item === 'string') {
            glyphName = item.startsWith('/') ? item.slice(1) : item;
          } else if (item && item.type === 'name' && typeof item.value === 'string') {
            glyphName = item.value.startsWith('/') ? item.value.slice(1) : item.value;
          }
          if (glyphName && code >= 0 && code < 256) {
            const cp = ADOBE_GLYPH_LIST[glyphName];
            if (cp !== undefined) t[code] = cp;
          }
          code++;
        }
      }
    }

    return t;
  }

  // Fallback
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) t[i] = i;
  return t;
}

/**
 * parseToUnicodeCMap(text) → Map<number, string>
 *
 * Parse a PDF ToUnicode CMap stream text and return a Map from
 * character code (number) to Unicode string.
 *
 * Handles both single-byte and multi-byte (2-byte) character codes.
 * Supports 'beginbfchar'/'endbfchar' and 'beginbfrange'/'endbfrange' sections.
 *
 * @param {string} text — the CMap stream content as a string
 * @returns {Map<number, string>}
 */
function parseToUnicodeCMap(text) {
  const map = new Map();
  if (!text || typeof text !== 'string') return map;

  // Parse beginbfchar ... endbfchar sections
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfcharRe.exec(text)) !== null) {
    const section = m[1];
    // Each entry: <srcCode> <dstCode>
    const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let e;
    while ((e = entryRe.exec(section)) !== null) {
      const srcCode = parseInt(e[1], 16);
      const dstStr  = _hexToUnicodeString(e[2]);
      map.set(srcCode, dstStr);
    }
  }

  // Parse beginbfrange ... endbfrange sections
  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrangeRe.exec(text)) !== null) {
    const section = m[1];
    // Each entry: <start> <end> <dstBase>  OR  <start> <end> [<d0> <d1> ...]
    const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:\[([^\]]*)\]|<([0-9A-Fa-f]+)>)/g;
    let e;
    while ((e = entryRe.exec(section)) !== null) {
      const start = parseInt(e[1], 16);
      const end   = parseInt(e[2], 16);
      if (e[3] !== undefined) {
        // Array form
        const items = [];
        const hexRe = /<([0-9A-Fa-f]+)>/g;
        let h;
        while ((h = hexRe.exec(e[3])) !== null) {
          items.push(_hexToUnicodeString(h[1]));
        }
        for (let i = start; i <= end && (i - start) < items.length; i++) {
          map.set(i, items[i - start]);
        }
      } else {
        // Range form: dst is start + offset
        const dstBase = parseInt(e[4], 16);
        for (let i = start; i <= end; i++) {
          map.set(i, String.fromCodePoint(dstBase + (i - start)));
        }
      }
    }
  }

  return map;
}

/**
 * decodeWithToUnicode(bytes, toUnicodeMap, isComposite) → string
 *
 * Decode a PDF string byte array to a Unicode string using a ToUnicode CMap.
 * For composite fonts (Type0), character codes are 2 bytes wide.
 * For simple fonts, character codes are 1 byte wide.
 *
 * @param {Uint8Array} bytes         — raw PDF string bytes
 * @param {Map<number,string>} map   — ToUnicode map from parseToUnicodeCMap()
 * @param {boolean} isComposite      — true for Type0/CIDFont (2-byte codes)
 * @returns {string}
 */
function decodeWithToUnicode(bytes, map, isComposite) {
  if (!bytes || bytes.length === 0) return '';
  let result = '';
  if (isComposite) {
    // 2-byte character codes
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      const ch = map.get(code);
      if (ch !== undefined) {
        result += ch;
      } else {
        // No mapping: output replacement character
        result += '�';
      }
    }
    // Handle odd trailing byte
    if (bytes.length % 2 !== 0) {
      const code = bytes[bytes.length - 1];
      const ch = map.get(code);
      result += ch !== undefined ? ch : '�';
    }
  } else {
    // 1-byte character codes
    for (let i = 0; i < bytes.length; i++) {
      const code = bytes[i];
      const ch = map.get(code);
      if (ch !== undefined) {
        result += ch;
      } else {
        result += String.fromCharCode(code);
      }
    }
  }
  return result;
}

/**
 * decodeWithEncoding(bytes, encodingTable) → string
 *
 * Decode a 1-byte-per-character PDF string using an encoding table
 * (as produced by resolveEncoding()).
 *
 * @param {Uint8Array} bytes
 * @param {Uint32Array} encodingTable — 256-entry code→Unicode map
 * @returns {string}
 */
function decodeWithEncoding(bytes, encodingTable) {
  if (!bytes || bytes.length === 0) return '';
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes[i];
    const cp = encodingTable[code];
    result += cp ? String.fromCodePoint(cp) : String.fromCharCode(code);
  }
  return result;
}

// ─── Adobe Glyph List (compact, ~300 most common names) ───────────────────────

/**
 * Compact Adobe Glyph List mapping glyph name → Unicode codepoint.
 * Covers the most commonly encountered glyph names in PDF font Differences arrays.
 * Reference: https://github.com/adobe-type-tools/agl-aglfn
 */
const ADOBE_GLYPH_LIST = {
  // Basic Latin
  'space': 0x0020, 'exclam': 0x0021, 'quotedbl': 0x0022, 'numbersign': 0x0023,
  'dollar': 0x0024, 'percent': 0x0025, 'ampersand': 0x0026, 'quotesingle': 0x0027,
  'parenleft': 0x0028, 'parenright': 0x0029, 'asterisk': 0x002A, 'plus': 0x002B,
  'comma': 0x002C, 'hyphen': 0x002D, 'period': 0x002E, 'slash': 0x002F,
  'zero': 0x0030, 'one': 0x0031, 'two': 0x0032, 'three': 0x0033,
  'four': 0x0034, 'five': 0x0035, 'six': 0x0036, 'seven': 0x0037,
  'eight': 0x0038, 'nine': 0x0039,
  'colon': 0x003A, 'semicolon': 0x003B, 'less': 0x003C, 'equal': 0x003D,
  'greater': 0x003E, 'question': 0x003F, 'at': 0x0040,
  'A': 0x0041, 'B': 0x0042, 'C': 0x0043, 'D': 0x0044, 'E': 0x0045,
  'F': 0x0046, 'G': 0x0047, 'H': 0x0048, 'I': 0x0049, 'J': 0x004A,
  'K': 0x004B, 'L': 0x004C, 'M': 0x004D, 'N': 0x004E, 'O': 0x004F,
  'P': 0x0050, 'Q': 0x0051, 'R': 0x0052, 'S': 0x0053, 'T': 0x0054,
  'U': 0x0055, 'V': 0x0056, 'W': 0x0057, 'X': 0x0058, 'Y': 0x0059,
  'Z': 0x005A,
  'bracketleft': 0x005B, 'backslash': 0x005C, 'bracketright': 0x005D,
  'asciicircum': 0x005E, 'underscore': 0x005F, 'grave': 0x0060,
  'a': 0x0061, 'b': 0x0062, 'c': 0x0063, 'd': 0x0064, 'e': 0x0065,
  'f': 0x0066, 'g': 0x0067, 'h': 0x0068, 'i': 0x0069, 'j': 0x006A,
  'k': 0x006B, 'l': 0x006C, 'm': 0x006D, 'n': 0x006E, 'o': 0x006F,
  'p': 0x0070, 'q': 0x0071, 'r': 0x0072, 's': 0x0073, 't': 0x0074,
  'u': 0x0075, 'v': 0x0076, 'w': 0x0077, 'x': 0x0078, 'y': 0x0079,
  'z': 0x007A,
  'braceleft': 0x007B, 'bar': 0x007C, 'braceright': 0x007D, 'asciitilde': 0x007E,
  // Latin Extended
  'Aacute': 0x00C1, 'Agrave': 0x00C0, 'Acircumflex': 0x00C2, 'Adieresis': 0x00C4,
  'Aring': 0x00C5, 'Atilde': 0x00C3, 'AE': 0x00C6, 'Ccedilla': 0x00C7,
  'Eacute': 0x00C9, 'Egrave': 0x00C8, 'Ecircumflex': 0x00CA, 'Edieresis': 0x00CB,
  'Iacute': 0x00CD, 'Igrave': 0x00CC, 'Icircumflex': 0x00CE, 'Idieresis': 0x00CF,
  'Eth': 0x00D0, 'Ntilde': 0x00D1, 'Oacute': 0x00D3, 'Ograve': 0x00D2,
  'Ocircumflex': 0x00D4, 'Odieresis': 0x00D6, 'Otilde': 0x00D5, 'Oslash': 0x00D8,
  'Uacute': 0x00DA, 'Ugrave': 0x00D9, 'Ucircumflex': 0x00DB, 'Udieresis': 0x00DC,
  'Yacute': 0x00DD, 'Thorn': 0x00DE, 'germandbls': 0x00DF,
  'aacute': 0x00E1, 'agrave': 0x00E0, 'acircumflex': 0x00E2, 'adieresis': 0x00E4,
  'aring': 0x00E5, 'atilde': 0x00E3, 'ae': 0x00E6, 'ccedilla': 0x00E7,
  'eacute': 0x00E9, 'egrave': 0x00E8, 'ecircumflex': 0x00EA, 'edieresis': 0x00EB,
  'iacute': 0x00ED, 'igrave': 0x00EC, 'icircumflex': 0x00EE, 'idieresis': 0x00EF,
  'eth': 0x00F0, 'ntilde': 0x00F1, 'oacute': 0x00F3, 'ograve': 0x00F2,
  'ocircumflex': 0x00F4, 'odieresis': 0x00F6, 'otilde': 0x00F5, 'oslash': 0x00F8,
  'uacute': 0x00FA, 'ugrave': 0x00F9, 'ucircumflex': 0x00FB, 'udieresis': 0x00FC,
  'yacute': 0x00FD, 'thorn': 0x00FE, 'ydieresis': 0x00FF,
  // Typography
  'endash': 0x2013, 'emdash': 0x2014, 'quotedblleft': 0x201C, 'quotedblright': 0x201D,
  'quoteleft': 0x2018, 'quoteright': 0x2019, 'quotesinglbase': 0x201A,
  'quotedblbase': 0x201E, 'ellipsis': 0x2026, 'dagger': 0x2020, 'daggerdbl': 0x2021,
  'bullet': 0x2022, 'perthousand': 0x2030, 'guilsinglleft': 0x2039,
  'guilsinglright': 0x203A, 'guillemotleft': 0x00AB, 'guillemotright': 0x00BB,
  'trademark': 0x2122, 'copyright': 0x00A9, 'registered': 0x00AE,
  'degree': 0x00B0, 'multiply': 0x00D7, 'divide': 0x00F7, 'plusminus': 0x00B1,
  'mu': 0x00B5, 'paragraph': 0x00B6, 'periodcentered': 0x00B7,
  'onesuperior': 0x00B9, 'twosuperior': 0x00B2, 'threesuperior': 0x00B3,
  'onequarter': 0x00BC, 'onehalf': 0x00BD, 'threequarters': 0x00BE,
  'fi': 0xFB01, 'fl': 0xFB02,
  'fraction': 0x2044, 'Euro': 0x20AC, 'florin': 0x0192,
  'circumflex': 0x02C6, 'tilde': 0x02DC, 'macron': 0x00AF,
  'breve': 0x02D8, 'dotaccent': 0x02D9, 'ring': 0x02DA,
  'cedilla': 0x00B8, 'hungarumlaut': 0x02DD, 'ogonek': 0x02DB, 'caron': 0x02C7,
  'lslash': 0x0142, 'Lslash': 0x0141, 'oe': 0x0153, 'OE': 0x0152,
  'scaron': 0x0161, 'Scaron': 0x0160, 'zcaron': 0x017E, 'Zcaron': 0x017D,
  'dotlessi': 0x0131, 'currency': 0x00A4,
  'exclamdown': 0x00A1, 'questiondown': 0x00BF,
  'ordfeminine': 0x00AA, 'ordmasculine': 0x00BA,
  'acute': 0x00B4, 'dieresis': 0x00A8, 'middot': 0x00B7,
  'cent': 0x00A2, 'sterling': 0x00A3, 'yen': 0x00A5,
  'section': 0x00A7, 'brokenbar': 0x00A6, 'notsign': 0x00AC,
  'softhyphen': 0x00AD, 'nbspace': 0x00A0, 'nonbreakingspace': 0x00A0,
};

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * _hexToUnicodeString(hex) → string
 * Convert a hex string (from a CMap <...> token) to a Unicode string.
 * Handles 2-byte, 4-byte etc. sequences (UTF-16BE encoding).
 */
function _hexToUnicodeString(hex) {
  if (!hex || hex.length === 0) return '';
  // Pad to even length
  if (hex.length % 2 !== 0) hex = '0' + hex;
  if (hex.length === 2) {
    // Single byte
    return String.fromCharCode(parseInt(hex, 16));
  }
  if (hex.length === 4) {
    // Two bytes — treat as UTF-16BE codepoint
    const cp = parseInt(hex, 16);
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      // High surrogate without low — return replacement
      return '�';
    }
    return String.fromCodePoint(cp);
  }
  // Longer sequences — decode as UTF-16BE
  let result = '';
  for (let i = 0; i < hex.length; i += 4) {
    const chunk = hex.substring(i, i + 4).padStart(4, '0');
    const cp = parseInt(chunk, 16);
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 4 < hex.length) {
      const next = parseInt(hex.substring(i + 4, i + 8).padStart(4, '0'), 16);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        const full = 0x10000 + ((cp - 0xD800) << 10) + (next - 0xDC00);
        result += String.fromCodePoint(full);
        i += 4;
        continue;
      }
    }
    result += cp < 0xD800 || cp > 0xDFFF ? String.fromCodePoint(cp) : '�';
  }
  return result;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getStandardFontCSS,
    getStandardFontStyle,
    getCharWidth,
    measureTextWidth,
    pdfStringToText,
    FONT_WIDTH_TABLES,
    STANDARD_FONT_MAP,
    // New encoding/CMap functions
    resolveEncoding,
    parseToUnicodeCMap,
    decodeWithToUnicode,
    decodeWithEncoding,
    ADOBE_GLYPH_LIST,
  };
} else {
  window.PDFFonts = {
    getStandardFontCSS,
    getStandardFontStyle,
    getCharWidth,
    measureTextWidth,
    pdfStringToText,
    FONT_WIDTH_TABLES,
    STANDARD_FONT_MAP,
    // New encoding/CMap functions
    resolveEncoding,
    parseToUnicodeCMap,
    decodeWithToUnicode,
    decodeWithEncoding,
    ADOBE_GLYPH_LIST,
  };
}
