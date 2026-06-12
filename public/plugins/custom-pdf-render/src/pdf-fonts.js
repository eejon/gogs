/**
 * pdf-fonts.js -- PDF Font Handling Module
 *
 * Provides:
 *   - Standard 14 PDF font CSS mappings
 *   - Character width tables for standard 14 fonts (AFM data)
 *   - Standard PDF encodings: WinAnsiEncoding, MacRomanEncoding, StandardEncoding
 *   - PDFDocEncoding (code-point table)
 *   - Encoding differences array application
 *   - ToUnicode CMap parsing
 *   - PDF string to text conversion (Latin-1 and UTF-16BE)
 *
 * No external imports. All code is self-contained.
 */

'use strict';

// ============================================================================
// Standard 14 PDF Fonts -> CSS Font Families
// ============================================================================

var STANDARD_FONT_CSS = {
  'Helvetica':             '"Helvetica Neue", Helvetica, Arial, sans-serif',
  'Helvetica-Bold':        '"Helvetica Neue", Helvetica, Arial, sans-serif',
  'Helvetica-Oblique':     '"Helvetica Neue", Helvetica, Arial, sans-serif',
  'Helvetica-BoldOblique': '"Helvetica Neue", Helvetica, Arial, sans-serif',
  'Times-Roman':           '"Times New Roman", Times, serif',
  'Times-Bold':            '"Times New Roman", Times, serif',
  'Times-Italic':          '"Times New Roman", Times, serif',
  'Times-BoldItalic':      '"Times New Roman", Times, serif',
  'Courier':               '"Courier New", Courier, monospace',
  'Courier-Bold':          '"Courier New", Courier, monospace',
  'Courier-Oblique':       '"Courier New", Courier, monospace',
  'Courier-BoldOblique':   '"Courier New", Courier, monospace',
  'Symbol':                'Symbol, serif',
  'ZapfDingbats':          'ZapfDingbats, serif',
};

// Aliases for common alternate names
var FONT_ALIASES = {
  'TimesNewRoman':       'Times-Roman',
  'TimesNewRomanPS':     'Times-Roman',
  'TimesNewRomanPSMT':   'Times-Roman',
  'Arial':               'Helvetica',
  'ArialMT':             'Helvetica',
  'ArialBlack':          'Helvetica-Bold',
  'CourierNew':          'Courier',
  'CourierNewPSMT':      'Courier',
};

/**
 * Get the CSS font-family string for a PDF font name.
 * Returns a fallback for unknown fonts.
 *
 * @param {string} fontName - PDF font name (e.g., "Helvetica", "Times-Roman")
 * @returns {string} CSS font-family value
 */
function getStandardFontCSS(fontName) {
  if (!fontName) return 'sans-serif';

  // Strip leading slash if present
  var name = fontName;
  if (name.charAt(0) === '/') name = name.substring(1);

  // Strip subset prefix (e.g., "ABCDEF+Helvetica" -> "Helvetica")
  var plusIdx = name.indexOf('+');
  if (plusIdx >= 0 && plusIdx <= 6) {
    name = name.substring(plusIdx + 1);
  }

  // Strip trailing modifiers for matching
  var baseName = name.replace(/-?(Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Medium|Light|Condensed|MT|PS|PSMT)/gi, '');

  // Direct match
  if (STANDARD_FONT_CSS[name]) return STANDARD_FONT_CSS[name];

  // Alias match
  if (FONT_ALIASES[name]) return STANDARD_FONT_CSS[FONT_ALIASES[name]];
  if (FONT_ALIASES[baseName]) return STANDARD_FONT_CSS[FONT_ALIASES[baseName]];

  // Partial match on base name
  for (var key in STANDARD_FONT_CSS) {
    if (name.indexOf(key) >= 0 || key.indexOf(baseName) >= 0) {
      return STANDARD_FONT_CSS[key];
    }
  }

  // Heuristic: name contains "Times" or "Serif"
  if (/times|serif/i.test(name)) return '"Times New Roman", Times, serif';
  if (/courier|mono/i.test(name)) return '"Courier New", Courier, monospace';
  if (/helvetica|arial|sans/i.test(name)) return '"Helvetica Neue", Helvetica, Arial, sans-serif';

  // Default fallback
  return 'sans-serif';
}

/**
 * Determine if a font name implies bold styling.
 * @param {string} fontName
 * @returns {boolean}
 */
function isBoldFont(fontName) {
  if (!fontName) return false;
  return /bold/i.test(fontName);
}

/**
 * Determine if a font name implies italic/oblique styling.
 * @param {string} fontName
 * @returns {boolean}
 */
function isItalicFont(fontName) {
  if (!fontName) return false;
  return /italic|oblique/i.test(fontName);
}

// ============================================================================
// Character Width Tables (AFM data for standard 14 fonts)
// ============================================================================
// Widths are in 1/1000 of a text unit.

// Helvetica character widths (ISO Latin 1 encoding, chars 0-255)
// Source: Helvetica AFM data
var HELVETICA_WIDTHS = [
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,333,556,556,556,556,260,556,333,737,370,556,584,0,737,333,
  400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,
  667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,
  722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,
  556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,
  556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500
];

// Times-Roman character widths
var TIMES_ROMAN_WIDTHS = [
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,
  921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,
  556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,
  333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,
  500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,333,500,500,500,500,200,500,333,760,276,500,564,0,760,333,
  400,564,300,300,333,500,453,250,333,300,310,500,750,750,750,444,
  722,722,722,722,722,722,889,667,611,611,611,611,333,333,333,333,
  722,722,722,722,722,722,722,564,722,722,722,722,722,722,556,500,
  444,444,444,444,444,444,667,444,444,444,444,444,278,278,278,278,
  500,500,500,500,500,500,500,564,500,500,500,500,500,500,500,500
];

// Courier character widths (all characters are 600 units wide)
var COURIER_WIDTHS = [];
for (var i = 0; i < 256; i++) COURIER_WIDTHS[i] = 600;
// Fix non-printable control characters
for (var i = 0; i < 32; i++) COURIER_WIDTHS[i] = 0;
COURIER_WIDTHS[32] = 600; // space

// Map font base names to width arrays
var FONT_WIDTHS = {
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
  'Symbol':                HELVETICA_WIDTHS,
  'ZapfDingbats':          HELVETICA_WIDTHS,
};

/**
 * Get the character width for a given font and character code.
 * @param {string} fontName - PDF font name
 * @param {number} charCode - character code (0-255)
 * @returns {number} width in 1/1000 text units
 */
function getCharWidth(fontName, charCode) {
  if (!fontName || typeof charCode !== 'number') return 500;

  var name = fontName;
  if (name.charAt(0) === '/') name = name.substring(1);

  // Strip subset prefix
  var plusIdx = name.indexOf('+');
  if (plusIdx >= 0 && plusIdx <= 6) {
    name = name.substring(plusIdx + 1);
  }

  var widths = FONT_WIDTHS[name];

  // Try partial matching
  if (!widths) {
    for (var key in FONT_WIDTHS) {
      if (name.indexOf(key) >= 0) {
        widths = FONT_WIDTHS[key];
        break;
      }
    }
  }

  // Heuristic fallback
  if (!widths) {
    if (/courier|mono/i.test(name)) widths = COURIER_WIDTHS;
    else if (/times|serif/i.test(name)) widths = TIMES_ROMAN_WIDTHS;
    else widths = HELVETICA_WIDTHS;
  }

  var code = charCode & 0xFF;
  var w = widths[code];
  return (typeof w === 'number' && w > 0) ? w : 500;
}

// ============================================================================
// PDF Encodings
// ============================================================================

// PDFDocEncoding: maps byte values 0-255 to Unicode code points.
// Identical to Latin-1 except for range 0x80-0x9F.
var pdfDocEncoding = new Array(256);
for (var i = 0; i < 256; i++) pdfDocEncoding[i] = i;

// Override 0x80-0x9F with PDFDocEncoding-specific mappings
pdfDocEncoding[0x80] = 0x2022; // BULLET
pdfDocEncoding[0x81] = 0x2020; // DAGGER
pdfDocEncoding[0x82] = 0x2021; // DOUBLE DAGGER
pdfDocEncoding[0x83] = 0x2026; // HORIZONTAL ELLIPSIS
pdfDocEncoding[0x84] = 0x2014; // EM DASH
pdfDocEncoding[0x85] = 0x2013; // EN DASH
pdfDocEncoding[0x86] = 0x0192; // LATIN SMALL LETTER F WITH HOOK
pdfDocEncoding[0x87] = 0x2044; // FRACTION SLASH
pdfDocEncoding[0x88] = 0x2039; // SINGLE LEFT-POINTING ANGLE QUOTATION MARK
pdfDocEncoding[0x89] = 0x203A; // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
pdfDocEncoding[0x8A] = 0x2212; // MINUS SIGN
pdfDocEncoding[0x8B] = 0x2030; // PER MILLE SIGN
pdfDocEncoding[0x8C] = 0x201E; // DOUBLE LOW-9 QUOTATION MARK
pdfDocEncoding[0x8D] = 0x201C; // LEFT DOUBLE QUOTATION MARK
pdfDocEncoding[0x8E] = 0x201D; // RIGHT DOUBLE QUOTATION MARK
pdfDocEncoding[0x8F] = 0x2018; // LEFT SINGLE QUOTATION MARK
pdfDocEncoding[0x90] = 0x2019; // RIGHT SINGLE QUOTATION MARK
pdfDocEncoding[0x91] = 0x201A; // SINGLE LOW-9 QUOTATION MARK
pdfDocEncoding[0x92] = 0x2122; // TRADE MARK SIGN
pdfDocEncoding[0x93] = 0xFB01; // LATIN SMALL LIGATURE FI
pdfDocEncoding[0x94] = 0xFB02; // LATIN SMALL LIGATURE FL
pdfDocEncoding[0x95] = 0x0141; // LATIN CAPITAL LETTER L WITH STROKE
pdfDocEncoding[0x96] = 0x0152; // LATIN CAPITAL LIGATURE OE
pdfDocEncoding[0x97] = 0x0160; // LATIN CAPITAL LETTER S WITH CARON
pdfDocEncoding[0x98] = 0x0178; // LATIN CAPITAL LETTER Y WITH DIAERESIS
pdfDocEncoding[0x99] = 0x017D; // LATIN CAPITAL LETTER Z WITH CARON
pdfDocEncoding[0x9A] = 0x0131; // LATIN SMALL LETTER DOTLESS I
pdfDocEncoding[0x9B] = 0x0142; // LATIN SMALL LETTER L WITH STROKE
pdfDocEncoding[0x9C] = 0x0153; // LATIN SMALL LIGATURE OE
pdfDocEncoding[0x9D] = 0x0161; // LATIN SMALL LETTER S WITH CARON
pdfDocEncoding[0x9E] = 0x017E; // LATIN SMALL LETTER Z WITH CARON
pdfDocEncoding[0x9F] = 0xFFFD; // UNDEFINED → REPLACEMENT CHARACTER
pdfDocEncoding[0xA0] = 0x20AC; // EURO SIGN (PDF 1.7 maps 0xA0 to Euro in PDFDocEncoding)
// Actually, 0xA0 should be NO-BREAK SPACE in standard PDFDocEncoding.
// Correct:
pdfDocEncoding[0xA0] = 0x00A0; // NO-BREAK SPACE (same as Latin-1)
pdfDocEncoding[0xAD] = 0x00AD; // SOFT HYPHEN

// WinAnsiEncoding: identical to Windows-1252 (superset of ISO 8859-1)
var winAnsiEncoding = new Array(256);
for (var i = 0; i < 256; i++) winAnsiEncoding[i] = i;
// Override 0x80-0x9F with Windows-1252 mappings
winAnsiEncoding[0x80] = 0x20AC; // EURO SIGN
winAnsiEncoding[0x81] = 0x0081; // undefined → keep
winAnsiEncoding[0x82] = 0x201A; // SINGLE LOW-9 QUOTATION MARK
winAnsiEncoding[0x83] = 0x0192; // LATIN SMALL LETTER F WITH HOOK
winAnsiEncoding[0x84] = 0x201E; // DOUBLE LOW-9 QUOTATION MARK
winAnsiEncoding[0x85] = 0x2026; // HORIZONTAL ELLIPSIS
winAnsiEncoding[0x86] = 0x2020; // DAGGER
winAnsiEncoding[0x87] = 0x2021; // DOUBLE DAGGER
winAnsiEncoding[0x88] = 0x02C6; // MODIFIER LETTER CIRCUMFLEX ACCENT
winAnsiEncoding[0x89] = 0x2030; // PER MILLE SIGN
winAnsiEncoding[0x8A] = 0x0160; // LATIN CAPITAL LETTER S WITH CARON
winAnsiEncoding[0x8B] = 0x2039; // SINGLE LEFT-POINTING ANGLE QUOTATION MARK
winAnsiEncoding[0x8C] = 0x0152; // LATIN CAPITAL LIGATURE OE
winAnsiEncoding[0x8D] = 0x008D; // undefined → keep
winAnsiEncoding[0x8E] = 0x017D; // LATIN CAPITAL LETTER Z WITH CARON
winAnsiEncoding[0x8F] = 0x008F; // undefined → keep
winAnsiEncoding[0x90] = 0x0090; // undefined → keep
winAnsiEncoding[0x91] = 0x2018; // LEFT SINGLE QUOTATION MARK
winAnsiEncoding[0x92] = 0x2019; // RIGHT SINGLE QUOTATION MARK
winAnsiEncoding[0x93] = 0x201C; // LEFT DOUBLE QUOTATION MARK
winAnsiEncoding[0x94] = 0x201D; // RIGHT DOUBLE QUOTATION MARK
winAnsiEncoding[0x95] = 0x2022; // BULLET
winAnsiEncoding[0x96] = 0x2013; // EN DASH
winAnsiEncoding[0x97] = 0x2014; // EM DASH
winAnsiEncoding[0x98] = 0x02DC; // SMALL TILDE
winAnsiEncoding[0x99] = 0x2122; // TRADE MARK SIGN
winAnsiEncoding[0x9A] = 0x0161; // LATIN SMALL LETTER S WITH CARON
winAnsiEncoding[0x9B] = 0x203A; // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
winAnsiEncoding[0x9C] = 0x0153; // LATIN SMALL LIGATURE OE
winAnsiEncoding[0x9D] = 0x009D; // undefined → keep
winAnsiEncoding[0x9E] = 0x017E; // LATIN SMALL LETTER Z WITH CARON
winAnsiEncoding[0x9F] = 0x0178; // LATIN CAPITAL LETTER Y WITH DIAERESIS

// MacRomanEncoding
var macRomanEncoding = new Array(256);
for (var i = 0; i < 128; i++) macRomanEncoding[i] = i;
var macRomanHigh = [
  0x00C4,0x00C5,0x00C7,0x00C9,0x00D1,0x00D6,0x00DC,0x00E1,
  0x00E0,0x00E2,0x00E4,0x00E3,0x00E5,0x00E7,0x00E9,0x00E8,
  0x00EA,0x00EB,0x00ED,0x00EC,0x00EE,0x00EF,0x00F1,0x00F3,
  0x00F2,0x00F4,0x00F6,0x00F5,0x00FA,0x00F9,0x00FB,0x00FC,
  0x2020,0x00B0,0x00A2,0x00A3,0x00A7,0x2022,0x00B6,0x00DF,
  0x00AE,0x00A9,0x2122,0x00B4,0x00A8,0x2260,0x00C6,0x00D8,
  0x221E,0x00B1,0x2264,0x2265,0x00A5,0x00B5,0x2202,0x2211,
  0x220F,0x03C0,0x222B,0x00AA,0x00BA,0x03A9,0x00E6,0x00F8,
  0x00BF,0x00A1,0x00AC,0x221A,0x0192,0x2248,0x2206,0x00AB,
  0x00BB,0x2026,0x00A0,0x00C0,0x00C3,0x00D5,0x0152,0x0153,
  0x2013,0x2014,0x201C,0x201D,0x2018,0x2019,0x00F7,0x25CA,
  0x00FF,0x0178,0x2044,0x20AC,0x2039,0x203A,0xFB01,0xFB02,
  0x2021,0x00B7,0x201A,0x201E,0x2030,0x00C2,0x00CA,0x00C1,
  0x00CB,0x00C8,0x00CD,0x00CE,0x00CF,0x00CC,0x00D3,0x00D4,
  0xF8FF,0x00D2,0x00DA,0x00DB,0x00D9,0x0131,0x02C6,0x02DC,
  0x00AF,0x02D8,0x02D9,0x02DA,0x00B8,0x02DD,0x02DB,0x02C7
];
for (var i = 0; i < 128; i++) macRomanEncoding[128 + i] = macRomanHigh[i];

// StandardEncoding (Adobe Standard Encoding)
var standardEncoding = new Array(256);
for (var i = 0; i < 256; i++) standardEncoding[i] = i; // Default: identity for printable ASCII
// Key differences from Latin-1:
standardEncoding[0x27] = 0x2019; // quoteright
standardEncoding[0x60] = 0x2018; // quoteleft
standardEncoding[0xA1] = 0x00A1; // exclamdown
standardEncoding[0xA2] = 0x00A2; // cent
standardEncoding[0xA3] = 0x00A3; // sterling
standardEncoding[0xA4] = 0x2044; // fraction
standardEncoding[0xA5] = 0x00A5; // yen
standardEncoding[0xA6] = 0x0192; // florin
standardEncoding[0xA7] = 0x00A7; // section
standardEncoding[0xA8] = 0x00A4; // currency
standardEncoding[0xA9] = 0x0027; // quotesingle
standardEncoding[0xAA] = 0x201C; // quotedblleft
standardEncoding[0xAB] = 0x00AB; // guillemotleft
standardEncoding[0xAC] = 0x2039; // guilsinglleft
standardEncoding[0xAD] = 0x203A; // guilsinglright
standardEncoding[0xAE] = 0xFB01; // fi
standardEncoding[0xAF] = 0xFB02; // fl
standardEncoding[0xB1] = 0x2013; // endash
standardEncoding[0xB2] = 0x2020; // dagger
standardEncoding[0xB3] = 0x2021; // daggerdbl
standardEncoding[0xB4] = 0x00B7; // periodcentered
standardEncoding[0xB6] = 0x00B6; // paragraph
standardEncoding[0xB7] = 0x2022; // bullet
standardEncoding[0xB8] = 0x201A; // quotesinglbase
standardEncoding[0xB9] = 0x201E; // quotedblbase
standardEncoding[0xBA] = 0x201D; // quotedblright
standardEncoding[0xBB] = 0x00BB; // guillemotright
standardEncoding[0xBC] = 0x2026; // ellipsis
standardEncoding[0xBD] = 0x2030; // perthousand
standardEncoding[0xC1] = 0x0060; // grave
standardEncoding[0xC2] = 0x00B4; // acute
standardEncoding[0xC3] = 0x02C6; // circumflex
standardEncoding[0xC4] = 0x02DC; // tilde
standardEncoding[0xC5] = 0x00AF; // macron
standardEncoding[0xC6] = 0x02D8; // breve
standardEncoding[0xC7] = 0x02D9; // dotaccent
standardEncoding[0xC8] = 0x00A8; // dieresis
standardEncoding[0xCA] = 0x02DA; // ring
standardEncoding[0xCB] = 0x00B8; // cedilla
standardEncoding[0xCD] = 0x02DD; // hungarumlaut
standardEncoding[0xCE] = 0x02DB; // ogonek
standardEncoding[0xCF] = 0x02C7; // caron
standardEncoding[0xD0] = 0x2014; // emdash
standardEncoding[0xE1] = 0x00C6; // AE
standardEncoding[0xE3] = 0x00AA; // ordfeminine
standardEncoding[0xE8] = 0x0141; // Lslash
standardEncoding[0xE9] = 0x00D8; // Oslash
standardEncoding[0xEA] = 0x0152; // OE
standardEncoding[0xEB] = 0x00BA; // ordmasculine
standardEncoding[0xF1] = 0x00E6; // ae
standardEncoding[0xF5] = 0x0131; // dotlessi
standardEncoding[0xF8] = 0x0142; // lslash
standardEncoding[0xF9] = 0x00F8; // oslash
standardEncoding[0xFA] = 0x0153; // oe
standardEncoding[0xFB] = 0x00DF; // germandbls

// ============================================================================
// Named Encodings Map
// ============================================================================

var NAMED_ENCODINGS = {
  'WinAnsiEncoding':   winAnsiEncoding,
  'MacRomanEncoding':  macRomanEncoding,
  'StandardEncoding':  standardEncoding,
  'PDFDocEncoding':    pdfDocEncoding,
};

/**
 * Resolve an encoding name to its code-point table.
 * @param {string} name - encoding name (e.g., "WinAnsiEncoding")
 * @returns {number[]|null} array of 256 Unicode code points, or null
 */
function resolveEncoding(name) {
  if (!name) return null;
  // Strip leading slash
  var n = name;
  if (n.charAt(0) === '/') n = n.substring(1);
  return NAMED_ENCODINGS[n] || null;
}

// ============================================================================
// Adobe Glyph Name to Unicode mapping (common glyphs only)
// ============================================================================

var GLYPH_NAME_TO_UNICODE = {
  'space': 0x0020, 'exclam': 0x0021, 'quotedbl': 0x0022, 'numbersign': 0x0023,
  'dollar': 0x0024, 'percent': 0x0025, 'ampersand': 0x0026, 'quotesingle': 0x0027,
  'parenleft': 0x0028, 'parenright': 0x0029, 'asterisk': 0x002A, 'plus': 0x002B,
  'comma': 0x002C, 'hyphen': 0x002D, 'period': 0x002E, 'slash': 0x002F,
  'zero': 0x0030, 'one': 0x0031, 'two': 0x0032, 'three': 0x0033,
  'four': 0x0034, 'five': 0x0035, 'six': 0x0036, 'seven': 0x0037,
  'eight': 0x0038, 'nine': 0x0039, 'colon': 0x003A, 'semicolon': 0x003B,
  'less': 0x003C, 'equal': 0x003D, 'greater': 0x003E, 'question': 0x003F,
  'at': 0x0040, 'A': 0x0041, 'B': 0x0042, 'C': 0x0043, 'D': 0x0044,
  'E': 0x0045, 'F': 0x0046, 'G': 0x0047, 'H': 0x0048, 'I': 0x0049,
  'J': 0x004A, 'K': 0x004B, 'L': 0x004C, 'M': 0x004D, 'N': 0x004E,
  'O': 0x004F, 'P': 0x0050, 'Q': 0x0051, 'R': 0x0052, 'S': 0x0053,
  'T': 0x0054, 'U': 0x0055, 'V': 0x0056, 'W': 0x0057, 'X': 0x0058,
  'Y': 0x0059, 'Z': 0x005A, 'bracketleft': 0x005B, 'backslash': 0x005C,
  'bracketright': 0x005D, 'asciicircum': 0x005E, 'underscore': 0x005F,
  'grave': 0x0060, 'a': 0x0061, 'b': 0x0062, 'c': 0x0063, 'd': 0x0064,
  'e': 0x0065, 'f': 0x0066, 'g': 0x0067, 'h': 0x0068, 'i': 0x0069,
  'j': 0x006A, 'k': 0x006B, 'l': 0x006C, 'm': 0x006D, 'n': 0x006E,
  'o': 0x006F, 'p': 0x0070, 'q': 0x0071, 'r': 0x0072, 's': 0x0073,
  't': 0x0074, 'u': 0x0075, 'v': 0x0076, 'w': 0x0077, 'x': 0x0078,
  'y': 0x0079, 'z': 0x007A, 'braceleft': 0x007B, 'bar': 0x007C,
  'braceright': 0x007D, 'asciitilde': 0x007E,
  'bullet': 0x2022, 'dagger': 0x2020, 'daggerdbl': 0x2021,
  'ellipsis': 0x2026, 'emdash': 0x2014, 'endash': 0x2013,
  'fi': 0xFB01, 'fl': 0xFB02,
  'fraction': 0x2044, 'guillemotleft': 0x00AB, 'guillemotright': 0x00BB,
  'guilsinglleft': 0x2039, 'guilsinglright': 0x203A,
  'minus': 0x2212, 'perthousand': 0x2030,
  'quotedblbase': 0x201E, 'quotedblleft': 0x201C, 'quotedblright': 0x201D,
  'quoteleft': 0x2018, 'quoteright': 0x2019, 'quotesinglbase': 0x201A,
  'trademark': 0x2122,
  'Agrave': 0x00C0, 'Aacute': 0x00C1, 'Acircumflex': 0x00C2,
  'Atilde': 0x00C3, 'Adieresis': 0x00C4, 'Aring': 0x00C5,
  'AE': 0x00C6, 'Ccedilla': 0x00C7, 'Egrave': 0x00C8,
  'Eacute': 0x00C9, 'Ecircumflex': 0x00CA, 'Edieresis': 0x00CB,
  'Igrave': 0x00CC, 'Iacute': 0x00CD, 'Icircumflex': 0x00CE,
  'Idieresis': 0x00CF, 'Eth': 0x00D0, 'Ntilde': 0x00D1,
  'Ograve': 0x00D2, 'Oacute': 0x00D3, 'Ocircumflex': 0x00D4,
  'Otilde': 0x00D5, 'Odieresis': 0x00D6, 'Oslash': 0x00D8,
  'Ugrave': 0x00D9, 'Uacute': 0x00DA, 'Ucircumflex': 0x00DB,
  'Udieresis': 0x00DC, 'Yacute': 0x00DD, 'Thorn': 0x00DE,
  'germandbls': 0x00DF,
  'agrave': 0x00E0, 'aacute': 0x00E1, 'acircumflex': 0x00E2,
  'atilde': 0x00E3, 'adieresis': 0x00E4, 'aring': 0x00E5,
  'ae': 0x00E6, 'ccedilla': 0x00E7, 'egrave': 0x00E8,
  'eacute': 0x00E9, 'ecircumflex': 0x00EA, 'edieresis': 0x00EB,
  'igrave': 0x00EC, 'iacute': 0x00ED, 'icircumflex': 0x00EE,
  'idieresis': 0x00EF, 'eth': 0x00F0, 'ntilde': 0x00F1,
  'ograve': 0x00F2, 'oacute': 0x00F3, 'ocircumflex': 0x00F4,
  'otilde': 0x00F5, 'odieresis': 0x00F6, 'oslash': 0x00F8,
  'ugrave': 0x00F9, 'uacute': 0x00FA, 'ucircumflex': 0x00FB,
  'udieresis': 0x00FC, 'yacute': 0x00FD, 'thorn': 0x00FE,
  'ydieresis': 0x00FF,
  'Lslash': 0x0141, 'lslash': 0x0142, 'OE': 0x0152, 'oe': 0x0153,
  'Scaron': 0x0160, 'scaron': 0x0161, 'Zcaron': 0x017D, 'zcaron': 0x017E,
  'Ydieresis': 0x0178, 'dotlessi': 0x0131, 'florin': 0x0192,
  'circumflex': 0x02C6, 'tilde': 0x02DC, 'ring': 0x02DA,
  'breve': 0x02D8, 'dotaccent': 0x02D9, 'hungarumlaut': 0x02DD,
  'ogonek': 0x02DB, 'caron': 0x02C7, 'cedilla': 0x00B8,
  'macron': 0x00AF, 'acute': 0x00B4, 'dieresis': 0x00A8,
  'multiply': 0x00D7, 'divide': 0x00F7,
  'degree': 0x00B0, 'registered': 0x00AE, 'copyright': 0x00A9,
  'paragraph': 0x00B6, 'section': 0x00A7,
  'Euro': 0x20AC, 'sterling': 0x00A3, 'yen': 0x00A5, 'cent': 0x00A2,
  'currency': 0x00A4, 'logicalnot': 0x00AC, 'plusminus': 0x00B1,
  'mu': 0x00B5, 'ordfeminine': 0x00AA, 'ordmasculine': 0x00BA,
  'onequarter': 0x00BC, 'onehalf': 0x00BD, 'threequarters': 0x00BE,
  'exclamdown': 0x00A1, 'questiondown': 0x00BF,
  'brokenbar': 0x00A6, 'middledot': 0x00B7, 'periodcentered': 0x00B7,
  'onesuperior': 0x00B9, 'twosuperior': 0x00B2, 'threesuperior': 0x00B3,
  'nbspace': 0x00A0,
};

/**
 * Apply a /Differences array to a base encoding table.
 * Differences is an array like: [32, /space, /exclam, 64, /at, ...]
 * where numbers set the starting code, and names override the code slot.
 *
 * @param {number[]} baseTable - base encoding table (256 entries, will be cloned)
 * @param {Array} differences - PDF /Differences array
 * @returns {number[]} modified encoding table
 */
function applyDifferences(baseTable, differences) {
  var table = baseTable.slice(); // clone
  if (!Array.isArray(differences)) return table;

  var code = 0;
  for (var i = 0; i < differences.length; i++) {
    var item = differences[i];
    if (typeof item === 'number') {
      code = item;
    } else if (typeof item === 'string') {
      // item is a glyph name like "/space" or "space"
      var glyphName = item;
      if (glyphName.charAt(0) === '/') glyphName = glyphName.substring(1);

      // Look up the Unicode code point for this glyph name
      var unicode = GLYPH_NAME_TO_UNICODE[glyphName];
      if (typeof unicode === 'number') {
        table[code] = unicode;
      }
      // If glyph name matches "uniXXXX" pattern
      else if (/^uni[0-9A-Fa-f]{4}$/.test(glyphName)) {
        table[code] = parseInt(glyphName.substring(3), 16);
      }
      code++;
    }
  }

  return table;
}

// ============================================================================
// Decode bytes with encoding table
// ============================================================================

/**
 * Decode a Uint8Array of character codes using an encoding table.
 * @param {Uint8Array} bytes - character code bytes
 * @param {number[]} encodingTable - 256-entry code-point table
 * @returns {string} decoded text
 */
function decodeWithEncoding(bytes, encodingTable) {
  if (!bytes || bytes.length === 0) return '';
  if (!encodingTable) {
    // Fall back to Latin-1
    var str = '';
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return str;
  }
  var result = '';
  for (var i = 0; i < bytes.length; i++) {
    var cp = encodingTable[bytes[i]];
    if (typeof cp === 'number' && cp > 0) {
      result += String.fromCodePoint(cp);
    } else {
      result += String.fromCharCode(bytes[i]);
    }
  }
  return result;
}

// ============================================================================
// ToUnicode CMap Parsing
// ============================================================================

/**
 * Parse a ToUnicode CMap text into a Map(charCode -> unicodeString).
 * Handles beginbfchar/endbfchar and beginbfrange/endbfrange sections.
 *
 * @param {string} cmapText - CMap text content
 * @returns {Map} charCode -> unicode string
 */
function parseToUnicodeCMap(cmapText) {
  var map = new Map();
  if (!cmapText || typeof cmapText !== 'string') return map;

  // Parse beginbfchar sections
  var bfcharRe = /beginbfchar\s*([\s\S]*?)endbfchar/g;
  var match;
  while ((match = bfcharRe.exec(cmapText)) !== null) {
    var block = match[1];
    var lineRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    var lineMatch;
    while ((lineMatch = lineRe.exec(block)) !== null) {
      var srcCode = parseInt(lineMatch[1], 16);
      var dstHex = lineMatch[2];
      var unicodeStr = hexToUnicodeString(dstHex);
      map.set(srcCode, unicodeStr);
    }
  }

  // Parse beginbfrange sections
  var bfrangeRe = /beginbfrange\s*([\s\S]*?)endbfrange/g;
  while ((match = bfrangeRe.exec(cmapText)) !== null) {
    var block = match[1];
    // Match lines like: <XX> <XX> <XXXX>
    // or: <XX> <XX> [<XXXX> <XXXX> ...]
    var lineRe2 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[\s\S]*?\]|<[0-9A-Fa-f]+>)/g;
    var lineMatch2;
    while ((lineMatch2 = lineRe2.exec(block)) !== null) {
      var srcStart = parseInt(lineMatch2[1], 16);
      var srcEnd = parseInt(lineMatch2[2], 16);
      var dstSpec = lineMatch2[3].trim();

      if (dstSpec.charAt(0) === '[') {
        // Array of individual mappings
        var arrayRe = /<([0-9A-Fa-f]+)>/g;
        var arrayMatch;
        var code = srcStart;
        while ((arrayMatch = arrayRe.exec(dstSpec)) !== null && code <= srcEnd) {
          map.set(code, hexToUnicodeString(arrayMatch[1]));
          code++;
        }
      } else {
        // Sequential range from a starting code point
        var baseDstHex = dstSpec.substring(1, dstSpec.length - 1); // strip < >
        var baseDst = parseInt(baseDstHex, 16);
        for (var code = srcStart; code <= srcEnd; code++) {
          var cp = baseDst + (code - srcStart);
          map.set(code, String.fromCodePoint(cp));
        }
      }
    }
  }

  return map;
}

/**
 * Convert a hex string to a Unicode string.
 * e.g., "0041" -> "A", "00410042" -> "AB"
 */
function hexToUnicodeString(hex) {
  var result = '';
  // Determine if this is a 2-byte or 4-byte (or longer) encoding
  if (hex.length <= 4) {
    // Single code point
    result = String.fromCodePoint(parseInt(hex, 16));
  } else {
    // Multiple 2-byte code points (UTF-16)
    for (var i = 0; i + 3 < hex.length; i += 4) {
      result += String.fromCodePoint(parseInt(hex.substring(i, i + 4), 16));
    }
  }
  return result;
}

/**
 * Decode bytes using a ToUnicode CMap.
 * @param {Uint8Array} bytes - character code bytes
 * @param {Map} toUnicodeMap - from parseToUnicodeCMap
 * @param {boolean} isTwoByte - if true, interpret bytes as 2-byte CID codes
 * @returns {string} decoded text
 */
function decodeWithToUnicode(bytes, toUnicodeMap, isTwoByte) {
  if (!bytes || bytes.length === 0) return '';
  if (!toUnicodeMap || toUnicodeMap.size === 0) return '';

  var result = '';
  if (isTwoByte) {
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      var code = (bytes[i] << 8) | bytes[i + 1];
      var mapped = toUnicodeMap.get(code);
      if (mapped !== undefined) {
        result += mapped;
      } else {
        result += String.fromCharCode(code);
      }
    }
  } else {
    for (var i = 0; i < bytes.length; i++) {
      var code = bytes[i];
      var mapped = toUnicodeMap.get(code);
      if (mapped !== undefined) {
        result += mapped;
      } else {
        result += String.fromCharCode(code);
      }
    }
  }

  return result;
}

// ============================================================================
// PDF String Conversion
// ============================================================================

/**
 * Convert a PDF string (Uint8Array) to a JavaScript string.
 * Handles both Latin-1 and UTF-16BE (with BOM) encodings.
 *
 * @param {Uint8Array} bytes - raw PDF string bytes
 * @returns {string}
 */
function pdfStringToText(bytes) {
  if (!bytes || bytes.length === 0) return '';
  if (!(bytes instanceof Uint8Array)) {
    if (typeof bytes === 'string') return bytes;
    return '';
  }

  // Check for UTF-16BE BOM (0xFE 0xFF)
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    var result = '';
    for (var i = 2; i + 1 < bytes.length; i += 2) {
      var code = (bytes[i] << 8) | bytes[i + 1];
      // Handle surrogate pairs
      if (code >= 0xD800 && code <= 0xDBFF && i + 3 < bytes.length) {
        var low = (bytes[i + 2] << 8) | bytes[i + 3];
        if (low >= 0xDC00 && low <= 0xDFFF) {
          var cp = ((code - 0xD800) << 10) + (low - 0xDC00) + 0x10000;
          result += String.fromCodePoint(cp);
          i += 2;
          continue;
        }
      }
      result += String.fromCharCode(code);
    }
    return result;
  }

  // Check for UTF-8 BOM (0xEF 0xBB 0xBF)
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    try {
      var decoder = new TextDecoder('utf-8');
      return decoder.decode(bytes.subarray(3));
    } catch (e) {
      // Fall through to Latin-1
    }
  }

  // Default: Latin-1 / PDFDocEncoding
  var result = '';
  for (var i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

// ============================================================================
// Module exports
// ============================================================================

var _PDFFontsExports = {
  getStandardFontCSS: getStandardFontCSS,
  isBoldFont: isBoldFont,
  isItalicFont: isItalicFont,
  getCharWidth: getCharWidth,
  pdfDocEncoding: pdfDocEncoding,
  NAMED_ENCODINGS: NAMED_ENCODINGS,
  resolveEncoding: resolveEncoding,
  applyDifferences: applyDifferences,
  decodeWithEncoding: decodeWithEncoding,
  parseToUnicodeCMap: parseToUnicodeCMap,
  decodeWithToUnicode: decodeWithToUnicode,
  pdfStringToText: pdfStringToText,
  GLYPH_NAME_TO_UNICODE: GLYPH_NAME_TO_UNICODE,
  HELVETICA_WIDTHS: HELVETICA_WIDTHS,
  TIMES_ROMAN_WIDTHS: TIMES_ROMAN_WIDTHS,
  COURIER_WIDTHS: COURIER_WIDTHS,
  FONT_WIDTHS: FONT_WIDTHS,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _PDFFontsExports;
}

// Browser: expose as window.PDFFonts so pdf-renderer.js can find it
if (typeof window !== 'undefined') {
  window.PDFFonts = _PDFFontsExports;
}
