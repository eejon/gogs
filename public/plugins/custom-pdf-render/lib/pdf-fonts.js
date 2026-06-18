/**
 * PDF Font Metrics and Encoding Support
 *
 * Provides width tables and encoding maps for the 14 standard PDF fonts,
 * ToUnicode CMap parsing, /Encoding + /Differences handling, /Widths
 * and /W array parsing for embedded fonts, and CSS font family mapping.
 *
 * Public interface:
 *   PDFFonts.getStandardFontMetrics(fontName) - width table for standard font
 *   PDFFonts.getEncoding(encodingName) - code-to-unicode mapping
 *   PDFFonts.applyDifferences(baseEncoding, differences) - apply /Differences
 *   PDFFonts.parseToUnicodeCMap(cmapData) - parse CMap to code->unicode map
 *   PDFFonts.resolveFont(fontDict, doc) - build a usable font object
 *   PDFFonts.getCSSFontFamily(fontName) - map PDF font name to CSS family
 *   PDFFonts.getDefaultWidth(fontName) - default glyph width for a font
 */

'use strict';

// ============================================================================
// Standard Encoding Tables
// ============================================================================

/**
 * WinAnsiEncoding: Maps byte values 0x00-0xFF to Unicode code points.
 * This is the most common encoding in modern PDFs.
 * Based on Windows-1252 with PDF-specific mappings.
 */
var WIN_ANSI_ENCODING = (function() {
  var enc = {};
  // 0x00-0x7F: ASCII
  for (var i = 0; i < 128; i++) {
    enc[i] = i;
  }
  // 0x80-0x9F: Windows-1252 specific mappings
  enc[0x80] = 0x20AC; // Euro sign
  enc[0x81] = 0x0081; // undefined - use control char
  enc[0x82] = 0x201A; // single low-9 quotation mark
  enc[0x83] = 0x0192; // latin small f with hook
  enc[0x84] = 0x201E; // double low-9 quotation mark
  enc[0x85] = 0x2026; // horizontal ellipsis
  enc[0x86] = 0x2020; // dagger
  enc[0x87] = 0x2021; // double dagger
  enc[0x88] = 0x02C6; // modifier letter circumflex accent
  enc[0x89] = 0x2030; // per mille sign
  enc[0x8A] = 0x0160; // latin capital S with caron
  enc[0x8B] = 0x2039; // single left-pointing angle quotation mark
  enc[0x8C] = 0x0152; // latin capital ligature OE
  enc[0x8D] = 0x008D; // undefined
  enc[0x8E] = 0x017D; // latin capital Z with caron
  enc[0x8F] = 0x008F; // undefined
  enc[0x90] = 0x0090; // undefined
  enc[0x91] = 0x2018; // left single quotation mark
  enc[0x92] = 0x2019; // right single quotation mark
  enc[0x93] = 0x201C; // left double quotation mark
  enc[0x94] = 0x201D; // right double quotation mark
  enc[0x95] = 0x2022; // bullet
  enc[0x96] = 0x2013; // en dash
  enc[0x97] = 0x2014; // em dash
  enc[0x98] = 0x02DC; // small tilde
  enc[0x99] = 0x2122; // trade mark sign
  enc[0x9A] = 0x0161; // latin small s with caron
  enc[0x9B] = 0x203A; // single right-pointing angle quotation mark
  enc[0x9C] = 0x0153; // latin small ligature oe
  enc[0x9D] = 0x009D; // undefined
  enc[0x9E] = 0x017E; // latin small z with caron
  enc[0x9F] = 0x0178; // latin capital Y with diaeresis
  // 0xA0-0xFF: Latin-1 supplement
  for (var j = 0xA0; j <= 0xFF; j++) {
    enc[j] = j;
  }
  return enc;
})();

/**
 * MacRomanEncoding: Maps byte values to Unicode code points.
 * Used in some older PDFs, especially from Mac OS applications.
 */
var MAC_ROMAN_ENCODING = (function() {
  var enc = {};
  // 0x00-0x7F: ASCII
  for (var i = 0; i < 128; i++) {
    enc[i] = i;
  }
  // 0x80-0xFF: Mac Roman specific
  var macHighBytes = [
    0x00C4, 0x00C5, 0x00C7, 0x00C9, 0x00D1, 0x00D6, 0x00DC, 0x00E1, // 80-87
    0x00E0, 0x00E2, 0x00E4, 0x00E3, 0x00E5, 0x00E7, 0x00E9, 0x00E8, // 88-8F
    0x00EA, 0x00EB, 0x00ED, 0x00EC, 0x00EE, 0x00EF, 0x00F1, 0x00F3, // 90-97
    0x00F2, 0x00F4, 0x00F6, 0x00F5, 0x00FA, 0x00F9, 0x00FB, 0x00FC, // 98-9F
    0x2020, 0x00B0, 0x00A2, 0x00A3, 0x00A7, 0x2022, 0x00B6, 0x00DF, // A0-A7
    0x00AE, 0x00A9, 0x2122, 0x00B4, 0x00A8, 0x2260, 0x00C6, 0x00D8, // A8-AF
    0x221E, 0x00B1, 0x2264, 0x2265, 0x00A5, 0x00B5, 0x2202, 0x2211, // B0-B7
    0x220F, 0x03C0, 0x222B, 0x00AA, 0x00BA, 0x2126, 0x00E6, 0x00F8, // B8-BF
    0x00BF, 0x00A1, 0x00AC, 0x221A, 0x0192, 0x2248, 0x2206, 0x00AB, // C0-C7
    0x00BB, 0x2026, 0x00A0, 0x00C0, 0x00C3, 0x00D5, 0x0152, 0x0153, // C8-CF
    0x2013, 0x2014, 0x201C, 0x201D, 0x2018, 0x2019, 0x00F7, 0x25CA, // D0-D7
    0x00FF, 0x0178, 0x2044, 0x20AC, 0x2039, 0x203A, 0xFB01, 0xFB02, // D8-DF
    0x2021, 0x00B7, 0x201A, 0x201E, 0x2030, 0x00C2, 0x00CA, 0x00C1, // E0-E7
    0x00CB, 0x00C8, 0x00CD, 0x00CE, 0x00CF, 0x00CC, 0x00D3, 0x00D4, // E8-EF
    0xF8FF, 0x00D2, 0x00DA, 0x00DB, 0x00D9, 0x0131, 0x02C6, 0x02DC, // F0-F7
    0x00AF, 0x02D8, 0x02D9, 0x02DA, 0x00B8, 0x02DD, 0x02DB, 0x02C7  // F8-FF
  ];
  for (var k = 0; k < macHighBytes.length; k++) {
    enc[0x80 + k] = macHighBytes[k];
  }
  return enc;
})();

/**
 * StandardEncoding: The PDF standard encoding.
 * Maps byte values to Unicode, differing from Latin-1 in several positions.
 */
var STANDARD_ENCODING = (function() {
  var enc = {};
  // 0x00-0x7F: mostly ASCII
  for (var i = 0; i < 128; i++) {
    enc[i] = i;
  }
  // High byte mappings for StandardEncoding
  // Positions 0x80-0xFF
  enc[0x80] = 0x0080;
  enc[0x81] = 0x0081;
  enc[0x82] = 0x0082;
  enc[0x83] = 0x0083;
  enc[0x84] = 0x0084;
  enc[0x85] = 0x0085;
  enc[0x86] = 0x0086;
  enc[0x87] = 0x0087;
  enc[0x88] = 0x0088;
  enc[0x89] = 0x0089;
  enc[0x8A] = 0x008A;
  enc[0x8B] = 0x008B;
  enc[0x8C] = 0x008C;
  enc[0x8D] = 0x008D;
  enc[0x8E] = 0x008E;
  enc[0x8F] = 0x008F;
  enc[0x90] = 0x0090;
  enc[0x91] = 0x0091;
  enc[0x92] = 0x0092;
  enc[0x93] = 0x0093;
  enc[0x94] = 0x0094;
  enc[0x95] = 0x0095;
  enc[0x96] = 0x0096;
  enc[0x97] = 0x0097;
  enc[0x98] = 0x0098;
  enc[0x99] = 0x0099;
  enc[0x9A] = 0x009A;
  enc[0x9B] = 0x009B;
  enc[0x9C] = 0x009C;
  enc[0x9D] = 0x009D;
  enc[0x9E] = 0x009E;
  enc[0x9F] = 0x009F;
  enc[0xA0] = 0x0020; // space
  enc[0xA1] = 0x00A1; // exclamdown
  enc[0xA2] = 0x00A2; // cent
  enc[0xA3] = 0x00A3; // sterling
  enc[0xA4] = 0x2044; // fraction
  enc[0xA5] = 0x00A5; // yen
  enc[0xA6] = 0x0192; // florin
  enc[0xA7] = 0x00A7; // section
  enc[0xA8] = 0x00A4; // currency
  enc[0xA9] = 0x0027; // quotesingle
  enc[0xAA] = 0x201C; // quotedblleft
  enc[0xAB] = 0x00AB; // guillemotleft
  enc[0xAC] = 0x2039; // guilsinglleft
  enc[0xAD] = 0x203A; // guilsinglright
  enc[0xAE] = 0xFB01; // fi
  enc[0xAF] = 0xFB02; // fl
  enc[0xB0] = 0x0080; // undefined
  enc[0xB1] = 0x2013; // endash
  enc[0xB2] = 0x2020; // dagger
  enc[0xB3] = 0x2021; // daggerdbl
  enc[0xB4] = 0x00B7; // periodcentered
  enc[0xB5] = 0x0080; // undefined
  enc[0xB6] = 0x00B6; // paragraph
  enc[0xB7] = 0x2022; // bullet
  enc[0xB8] = 0x201A; // quotesinglbase
  enc[0xB9] = 0x201E; // quotedblbase
  enc[0xBA] = 0x201D; // quotedblright
  enc[0xBB] = 0x00BB; // guillemotright
  enc[0xBC] = 0x2026; // ellipsis
  enc[0xBD] = 0x2030; // perthousand
  enc[0xBE] = 0x0080; // undefined
  enc[0xBF] = 0x00BF; // questiondown
  enc[0xC0] = 0x0080; // undefined
  enc[0xC1] = 0x0060; // grave
  enc[0xC2] = 0x00B4; // acute
  enc[0xC3] = 0x02C6; // circumflex
  enc[0xC4] = 0x02DC; // tilde
  enc[0xC5] = 0x00AF; // macron
  enc[0xC6] = 0x02D8; // breve
  enc[0xC7] = 0x02D9; // dotaccent
  enc[0xC8] = 0x00A8; // dieresis
  enc[0xC9] = 0x0080; // undefined
  enc[0xCA] = 0x02DA; // ring
  enc[0xCB] = 0x00B8; // cedilla
  enc[0xCC] = 0x0080; // undefined
  enc[0xCD] = 0x02DD; // hungarumlaut
  enc[0xCE] = 0x02DB; // ogonek
  enc[0xCF] = 0x02C7; // caron
  enc[0xD0] = 0x2014; // emdash
  for (var d = 0xD1; d <= 0xFF; d++) {
    enc[d] = d;
  }
  enc[0xE1] = 0x00C6; // AE
  enc[0xE3] = 0x00AA; // ordfeminine
  enc[0xE8] = 0x0141; // Lslash
  enc[0xE9] = 0x00D8; // Oslash
  enc[0xEA] = 0x0152; // OE
  enc[0xEB] = 0x00BA; // ordmasculine
  enc[0xF1] = 0x00E6; // ae
  enc[0xF5] = 0x0131; // dotlessi
  enc[0xF8] = 0x0142; // lslash
  enc[0xF9] = 0x00F8; // oslash
  enc[0xFA] = 0x0153; // oe
  enc[0xFB] = 0x00DF; // germandbls
  return enc;
})();

// ============================================================================
// Adobe Glyph Name to Unicode Mapping (subset - most common glyphs)
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
  // Latin accented
  'Agrave': 0x00C0, 'Aacute': 0x00C1, 'Acircumflex': 0x00C2, 'Atilde': 0x00C3,
  'Adieresis': 0x00C4, 'Aring': 0x00C5, 'AE': 0x00C6, 'Ccedilla': 0x00C7,
  'Egrave': 0x00C8, 'Eacute': 0x00C9, 'Ecircumflex': 0x00CA, 'Edieresis': 0x00CB,
  'Igrave': 0x00CC, 'Iacute': 0x00CD, 'Icircumflex': 0x00CE, 'Idieresis': 0x00CF,
  'Eth': 0x00D0, 'Ntilde': 0x00D1, 'Ograve': 0x00D2, 'Oacute': 0x00D3,
  'Ocircumflex': 0x00D4, 'Otilde': 0x00D5, 'Odieresis': 0x00D6, 'multiply': 0x00D7,
  'Oslash': 0x00D8, 'Ugrave': 0x00D9, 'Uacute': 0x00DA, 'Ucircumflex': 0x00DB,
  'Udieresis': 0x00DC, 'Yacute': 0x00DD, 'Thorn': 0x00DE, 'germandbls': 0x00DF,
  'agrave': 0x00E0, 'aacute': 0x00E1, 'acircumflex': 0x00E2, 'atilde': 0x00E3,
  'adieresis': 0x00E4, 'aring': 0x00E5, 'ae': 0x00E6, 'ccedilla': 0x00E7,
  'egrave': 0x00E8, 'eacute': 0x00E9, 'ecircumflex': 0x00EA, 'edieresis': 0x00EB,
  'igrave': 0x00EC, 'iacute': 0x00ED, 'icircumflex': 0x00EE, 'idieresis': 0x00EF,
  'eth': 0x00F0, 'ntilde': 0x00F1, 'ograve': 0x00F2, 'oacute': 0x00F3,
  'ocircumflex': 0x00F4, 'otilde': 0x00F5, 'odieresis': 0x00F6, 'divide': 0x00F7,
  'oslash': 0x00F8, 'ugrave': 0x00F9, 'uacute': 0x00FA, 'ucircumflex': 0x00FB,
  'udieresis': 0x00FC, 'yacute': 0x00FD, 'thorn': 0x00FE, 'ydieresis': 0x00FF,
  // Typographic
  'endash': 0x2013, 'emdash': 0x2014, 'quoteleft': 0x2018, 'quoteright': 0x2019,
  'quotedblleft': 0x201C, 'quotedblright': 0x201D, 'bullet': 0x2022,
  'ellipsis': 0x2026, 'dagger': 0x2020, 'daggerdbl': 0x2021,
  'perthousand': 0x2030, 'guilsinglleft': 0x2039, 'guilsinglright': 0x203A,
  'fi': 0xFB01, 'fl': 0xFB02,
  'fraction': 0x2044, 'trademark': 0x2122,
  'Euro': 0x20AC, 'euro': 0x20AC,
  'minus': 0x2212,
  'quotesinglbase': 0x201A, 'quotedblbase': 0x201E,
  'florin': 0x0192,
  'OE': 0x0152, 'oe': 0x0153,
  'Scaron': 0x0160, 'scaron': 0x0161,
  'Zcaron': 0x017D, 'zcaron': 0x017E,
  'Ydieresis': 0x0178,
  'circumflex': 0x02C6, 'tilde': 0x02DC,
  'caron': 0x02C7, 'breve': 0x02D8, 'dotaccent': 0x02D9,
  'ring': 0x02DA, 'ogonek': 0x02DB, 'hungarumlaut': 0x02DD,
  'cedilla': 0x00B8, 'macron': 0x00AF,
  'dotlessi': 0x0131, 'Lslash': 0x0141, 'lslash': 0x0142,
  // Common symbols
  'degree': 0x00B0, 'section': 0x00A7, 'paragraph': 0x00B6,
  'copyright': 0x00A9, 'registered': 0x00AE,
  'cent': 0x00A2, 'sterling': 0x00A3, 'yen': 0x00A5, 'currency': 0x00A4,
  'exclamdown': 0x00A1, 'questiondown': 0x00BF,
  'guillemotleft': 0x00AB, 'guillemotright': 0x00BB,
  'ordfeminine': 0x00AA, 'ordmasculine': 0x00BA,
  'periodcentered': 0x00B7,
  'logicalnot': 0x00AC, 'plusminus': 0x00B1,
  'mu': 0x00B5, 'onehalf': 0x00BD, 'onequarter': 0x00BC, 'threequarters': 0x00BE,
  'onesuperior': 0x00B9, 'twosuperior': 0x00B2, 'threesuperior': 0x00B3,
  'brokenbar': 0x00A6, 'dieresis': 0x00A8, 'acute': 0x00B4,
  'nobreaakspace': 0x00A0, 'nbspace': 0x00A0,
  // Math
  'infinity': 0x221E, 'partialdiff': 0x2202, 'summation': 0x2211,
  'product': 0x220F, 'pi': 0x03C0, 'integral': 0x222B,
  'radical': 0x221A, 'approxequal': 0x2248, 'Delta': 0x0394,
  'notequal': 0x2260, 'lessequal': 0x2264, 'greaterequal': 0x2265,
  'lozenge': 0x25CA,
  'minus': 0x2212, 'multiply': 0x00D7, 'divide': 0x00F7,
  'proportional': 0x221D, 'similar': 0x223C, 'congruent': 0x2245,
  'perpendicular': 0x22A5, 'angle': 0x2220, 'element': 0x2208,
  'notelement': 0x2209, 'suchthat': 0x220B, 'therefore': 0x2234,
  'emptyset': 0x2205, 'nabla': 0x2207, 'gradient': 0x2207,
  'equivalence': 0x2261,
  // Arrows
  'arrowleft': 0x2190, 'arrowup': 0x2191, 'arrowright': 0x2192,
  'arrowdown': 0x2193, 'arrowboth': 0x2194, 'arrowdblup': 0x21D1,
  'arrowdbldown': 0x21D3, 'arrowdblleft': 0x21D0, 'arrowdblright': 0x21D2,
  'arrowdblboth': 0x21D4,
  // Greek lowercase
  'alpha': 0x03B1, 'beta': 0x03B2, 'gamma': 0x03B3, 'delta': 0x03B4,
  'epsilon': 0x03B5, 'zeta': 0x03B6, 'eta': 0x03B7, 'theta': 0x03B8,
  'iota': 0x03B9, 'kappa': 0x03BA, 'lambda': 0x03BB, 'nu': 0x03BD,
  'xi': 0x03BE, 'omicron': 0x03BF, 'rho': 0x03C1,
  'sigma': 0x03C3, 'tau': 0x03C4, 'upsilon': 0x03C5, 'phi': 0x03C6,
  'chi': 0x03C7, 'psi': 0x03C8, 'omega': 0x03C9,
  'sigma1': 0x03C2, 'phi1': 0x03D5, 'omega1': 0x03D6,
  // Greek uppercase
  'Alpha': 0x0391, 'Beta': 0x0392, 'Gamma': 0x0393,
  'Epsilon': 0x0395, 'Zeta': 0x0396, 'Eta': 0x0397, 'Theta': 0x0398,
  'Iota': 0x0399, 'Kappa': 0x039A, 'Lambda': 0x039B, 'Mu': 0x039C,
  'Nu': 0x039D, 'Xi': 0x039E, 'Omicron': 0x039F, 'Pi': 0x03A0,
  'Rho': 0x03A1, 'Sigma': 0x03A3, 'Tau': 0x03A4, 'Upsilon': 0x03A5,
  'Phi': 0x03A6, 'Chi': 0x03A7, 'Psi': 0x03A8, 'Omega': 0x03A9,
  '.notdef': 0xFFFD
};

// ============================================================================
// Standard 14 Font Metrics (Width tables)
// ============================================================================

// All widths are in 1/1000 of a unit (standard PDF font metrics scale).
// The default width for characters not in the table is typically 0 (not drawn)
// or the font's default width.

// Only the most common characters (0x20-0x7E) are specified for each font.
// Full tables would be much larger; these cover the ASCII printable range
// plus some common high-byte characters used with WinAnsiEncoding.

/**
 * Generate a width table for Helvetica (and similar sans-serif).
 * Widths are approximations of the real Adobe Helvetica metrics.
 */
var HELVETICA_WIDTHS = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556,
  64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556,
  96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556,
  104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556,
  111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556,
  118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334, 124: 260,
  125: 334, 126: 584
};

var HELVETICA_BOLD_WIDTHS = {
  32: 278, 33: 333, 34: 474, 35: 556, 36: 556, 37: 889, 38: 722, 39: 238,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 333, 59: 333, 60: 584, 61: 584, 62: 584, 63: 611,
  64: 975, 65: 722, 66: 722, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 556, 75: 722, 76: 611, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 333, 92: 278, 93: 333, 94: 584, 95: 556,
  96: 333, 97: 556, 98: 611, 99: 556, 100: 611, 101: 556, 102: 333, 103: 611,
  104: 611, 105: 278, 106: 278, 107: 556, 108: 278, 109: 889, 110: 611,
  111: 611, 112: 611, 113: 611, 114: 389, 115: 556, 116: 333, 117: 611,
  118: 556, 119: 778, 120: 556, 121: 556, 122: 500, 123: 389, 124: 280,
  125: 389, 126: 584
};

var TIMES_ROMAN_WIDTHS = {
  32: 250, 33: 333, 34: 408, 35: 500, 36: 500, 37: 833, 38: 778, 39: 180,
  40: 333, 41: 333, 42: 500, 43: 564, 44: 250, 45: 333, 46: 250, 47: 278,
  48: 500, 49: 500, 50: 500, 51: 500, 52: 500, 53: 500, 54: 500, 55: 500,
  56: 500, 57: 500, 58: 278, 59: 278, 60: 564, 61: 564, 62: 564, 63: 444,
  64: 921, 65: 722, 66: 667, 67: 667, 68: 722, 69: 611, 70: 556, 71: 722,
  72: 722, 73: 333, 74: 389, 75: 722, 76: 611, 77: 889, 78: 722, 79: 722,
  80: 556, 81: 722, 82: 667, 83: 556, 84: 611, 85: 722, 86: 722, 87: 944,
  88: 722, 89: 722, 90: 611, 91: 333, 92: 278, 93: 333, 94: 469, 95: 500,
  96: 333, 97: 444, 98: 500, 99: 444, 100: 500, 101: 444, 102: 333, 103: 500,
  104: 500, 105: 278, 106: 278, 107: 500, 108: 278, 109: 778, 110: 500,
  111: 500, 112: 500, 113: 500, 114: 333, 115: 389, 116: 278, 117: 500,
  118: 500, 119: 722, 120: 500, 121: 500, 122: 444, 123: 480, 124: 200,
  125: 480, 126: 541
};

var TIMES_BOLD_WIDTHS = {
  32: 250, 33: 333, 34: 555, 35: 500, 36: 500, 37: 1000, 38: 833, 39: 278,
  40: 333, 41: 333, 42: 500, 43: 570, 44: 250, 45: 333, 46: 250, 47: 278,
  48: 500, 49: 500, 50: 500, 51: 500, 52: 500, 53: 500, 54: 500, 55: 500,
  56: 500, 57: 500, 58: 333, 59: 333, 60: 570, 61: 570, 62: 570, 63: 500,
  64: 930, 65: 722, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 778, 73: 389, 74: 500, 75: 778, 76: 667, 77: 944, 78: 722, 79: 778,
  80: 611, 81: 778, 82: 722, 83: 556, 84: 667, 85: 722, 86: 722, 87: 1000,
  88: 722, 89: 722, 90: 667, 91: 333, 92: 278, 93: 333, 94: 581, 95: 500,
  96: 333, 97: 500, 98: 556, 99: 444, 100: 556, 101: 444, 102: 333, 103: 500,
  104: 556, 105: 278, 106: 333, 107: 556, 108: 278, 109: 833, 110: 556,
  111: 500, 112: 556, 113: 556, 114: 444, 115: 389, 116: 333, 117: 556,
  118: 500, 119: 722, 120: 500, 121: 500, 122: 444, 123: 394, 124: 220,
  125: 394, 126: 520
};

var TIMES_ITALIC_WIDTHS = {
  32: 250, 33: 333, 34: 420, 35: 500, 36: 500, 37: 833, 38: 778, 39: 214,
  40: 333, 41: 333, 42: 500, 43: 675, 44: 250, 45: 333, 46: 250, 47: 278,
  48: 500, 49: 500, 50: 500, 51: 500, 52: 500, 53: 500, 54: 500, 55: 500,
  56: 500, 57: 500, 58: 333, 59: 333, 60: 675, 61: 675, 62: 675, 63: 500,
  64: 920, 65: 611, 66: 611, 67: 667, 68: 722, 69: 611, 70: 611, 71: 722,
  72: 722, 73: 333, 74: 444, 75: 667, 76: 556, 77: 833, 78: 667, 79: 722,
  80: 611, 81: 722, 82: 611, 83: 500, 84: 556, 85: 722, 86: 611, 87: 833,
  88: 611, 89: 556, 90: 556, 91: 389, 92: 278, 93: 389, 94: 422, 95: 500,
  96: 333, 97: 500, 98: 500, 99: 444, 100: 500, 101: 444, 102: 278, 103: 500,
  104: 500, 105: 278, 106: 278, 107: 444, 108: 278, 109: 722, 110: 500,
  111: 500, 112: 500, 113: 500, 114: 389, 115: 389, 116: 278, 117: 500,
  118: 444, 119: 667, 120: 444, 121: 444, 122: 389, 123: 400, 124: 275,
  125: 400, 126: 541
};

var COURIER_WIDTHS = (function() {
  // Courier is monospaced: all glyphs are 600 units wide
  var w = {};
  for (var i = 32; i <= 126; i++) {
    w[i] = 600;
  }
  return w;
})();

// ============================================================================
// Standard 14 Font Registry
// ============================================================================

var STANDARD_FONTS = {
  'Helvetica':              { widths: HELVETICA_WIDTHS, defaultWidth: 556, css: 'Helvetica, Arial, sans-serif', style: '', weight: 'normal' },
  'Helvetica-Bold':         { widths: HELVETICA_BOLD_WIDTHS, defaultWidth: 556, css: 'Helvetica, Arial, sans-serif', style: '', weight: 'bold' },
  'Helvetica-Oblique':      { widths: HELVETICA_WIDTHS, defaultWidth: 556, css: 'Helvetica, Arial, sans-serif', style: 'italic', weight: 'normal' },
  'Helvetica-BoldOblique':  { widths: HELVETICA_BOLD_WIDTHS, defaultWidth: 556, css: 'Helvetica, Arial, sans-serif', style: 'italic', weight: 'bold' },
  'Times-Roman':            { widths: TIMES_ROMAN_WIDTHS, defaultWidth: 500, css: '"Times New Roman", Times, serif', style: '', weight: 'normal' },
  'Times-Bold':             { widths: TIMES_BOLD_WIDTHS, defaultWidth: 500, css: '"Times New Roman", Times, serif', style: '', weight: 'bold' },
  'Times-Italic':           { widths: TIMES_ITALIC_WIDTHS, defaultWidth: 500, css: '"Times New Roman", Times, serif', style: 'italic', weight: 'normal' },
  'Times-BoldItalic':       { widths: TIMES_BOLD_WIDTHS, defaultWidth: 500, css: '"Times New Roman", Times, serif', style: 'italic', weight: 'bold' },
  'Courier':                { widths: COURIER_WIDTHS, defaultWidth: 600, css: '"Courier New", Courier, monospace', style: '', weight: 'normal' },
  'Courier-Bold':           { widths: COURIER_WIDTHS, defaultWidth: 600, css: '"Courier New", Courier, monospace', style: '', weight: 'bold' },
  'Courier-Oblique':        { widths: COURIER_WIDTHS, defaultWidth: 600, css: '"Courier New", Courier, monospace', style: 'italic', weight: 'normal' },
  'Courier-BoldOblique':    { widths: COURIER_WIDTHS, defaultWidth: 600, css: '"Courier New", Courier, monospace', style: 'italic', weight: 'bold' },
  'Symbol':                 { widths: HELVETICA_WIDTHS, defaultWidth: 500, css: 'Symbol, serif', style: '', weight: 'normal' },
  'ZapfDingbats':           { widths: HELVETICA_WIDTHS, defaultWidth: 500, css: '"Zapf Dingbats", serif', style: '', weight: 'normal' }
};

// Aliases for common font name variants
var FONT_ALIASES = {
  'ArialMT': 'Helvetica',
  'Arial': 'Helvetica',
  'Arial-BoldMT': 'Helvetica-Bold',
  'Arial-ItalicMT': 'Helvetica-Oblique',
  'Arial-BoldItalicMT': 'Helvetica-BoldOblique',
  'TimesNewRomanPSMT': 'Times-Roman',
  'TimesNewRomanPS-BoldMT': 'Times-Bold',
  'TimesNewRomanPS-ItalicMT': 'Times-Italic',
  'TimesNewRomanPS-BoldItalicMT': 'Times-BoldItalic',
  'CourierNewPSMT': 'Courier',
  'CourierNewPS-BoldMT': 'Courier-Bold',
  'CourierNewPS-ItalicMT': 'Courier-Oblique',
  'CourierNewPS-BoldItalicMT': 'Courier-BoldOblique'
};

// ============================================================================
// Font Metric Functions
// ============================================================================

/**
 * Get the standard font metrics for a named font.
 *
 * @param {string} fontName - e.g., "Helvetica", "Times-Roman"
 * @returns {object|null} { widths, defaultWidth, css, style, weight }
 */
function getStandardFontMetrics(fontName) {
  if (!fontName) return null;
  // Try direct match
  if (STANDARD_FONTS[fontName]) return STANDARD_FONTS[fontName];
  // Try alias
  var aliased = FONT_ALIASES[fontName];
  if (aliased && STANDARD_FONTS[aliased]) return STANDARD_FONTS[aliased];
  return null;
}

/**
 * Get the default glyph width for a named font.
 *
 * @param {string} fontName - Font name
 * @returns {number} Default width in 1/1000 units
 */
function getDefaultWidth(fontName) {
  var metrics = getStandardFontMetrics(fontName);
  return metrics ? metrics.defaultWidth : 500;
}

/**
 * Map a PDF font name to a CSS font-family string.
 *
 * @param {string} fontName - The /BaseFont name from the font dictionary
 * @returns {string} CSS font-family value
 */
function getCSSFontFamily(fontName) {
  if (!fontName) return 'sans-serif';

  // Check standard fonts and aliases
  var metrics = getStandardFontMetrics(fontName);
  if (metrics) return metrics.css;

  // Strip subset prefix (e.g., "ABCDEF+TimesNewRoman" -> "TimesNewRoman")
  var cleaned = fontName;
  var plusIndex = fontName.indexOf('+');
  if (plusIndex > 0 && plusIndex <= 6) {
    cleaned = fontName.substring(plusIndex + 1);
    // Re-check standard fonts
    metrics = getStandardFontMetrics(cleaned);
    if (metrics) return metrics.css;
  }

  // Heuristic: classify by name keywords
  var lower = cleaned.toLowerCase();
  if (lower.indexOf('courier') !== -1 || lower.indexOf('mono') !== -1 ||
      lower.indexOf('consol') !== -1 || lower.indexOf('fixed') !== -1) {
    return '"Courier New", Courier, monospace';
  }
  if (lower.indexOf('times') !== -1 || lower.indexOf('serif') !== -1 ||
      lower.indexOf('roman') !== -1 || lower.indexOf('garamond') !== -1 ||
      lower.indexOf('georgia') !== -1 || lower.indexOf('palatin') !== -1 ||
      lower.indexOf('cambria') !== -1) {
    return '"Times New Roman", Times, serif';
  }
  if (lower.indexOf('helvetica') !== -1 || lower.indexOf('arial') !== -1 ||
      lower.indexOf('sans') !== -1 || lower.indexOf('calibri') !== -1 ||
      lower.indexOf('verdana') !== -1 || lower.indexOf('tahoma') !== -1 ||
      lower.indexOf('segoe') !== -1 || lower.indexOf('liberation') !== -1) {
    return 'Helvetica, Arial, sans-serif';
  }

  // LaTeX Computer Modern fonts
  if (lower.indexOf('cmr') !== -1 || lower.indexOf('cmbx') !== -1 ||
      lower.indexOf('cmti') !== -1 || lower.indexOf('cmsy') !== -1 ||
      lower.indexOf('cmmi') !== -1 || lower.indexOf('cmex') !== -1 ||
      lower.indexOf('cmss') !== -1) {
    // Computer Modern is a serif font
    return '"Times New Roman", Times, serif';
  }

  // Default to sans-serif
  return 'Helvetica, Arial, sans-serif';
}

/**
 * Determine CSS font-weight from a font name.
 *
 * @param {string} fontName
 * @returns {string} 'bold' or 'normal'
 */
function getCSSFontWeight(fontName) {
  if (!fontName) return 'normal';
  var metrics = getStandardFontMetrics(fontName);
  if (metrics) return metrics.weight;

  var lower = fontName.toLowerCase();
  if (lower.indexOf('bold') !== -1 || lower.indexOf('cmbx') !== -1 ||
      lower.indexOf('heavy') !== -1 || lower.indexOf('black') !== -1) {
    return 'bold';
  }
  return 'normal';
}

/**
 * Determine CSS font-style from a font name.
 *
 * @param {string} fontName
 * @returns {string} 'italic' or ''
 */
function getCSSFontStyle(fontName) {
  if (!fontName) return '';
  var metrics = getStandardFontMetrics(fontName);
  if (metrics) return metrics.style;

  var lower = fontName.toLowerCase();
  if (lower.indexOf('italic') !== -1 || lower.indexOf('oblique') !== -1 ||
      lower.indexOf('cmti') !== -1 || lower.indexOf('slant') !== -1) {
    return 'italic';
  }
  return '';
}

// ============================================================================
// Encoding Resolution
// ============================================================================

/**
 * Get a named encoding table.
 *
 * @param {string} encodingName - "WinAnsiEncoding", "MacRomanEncoding", "StandardEncoding"
 * @returns {object} Map of byte code -> Unicode code point
 */
function getEncoding(encodingName) {
  switch (encodingName) {
    case 'WinAnsiEncoding': return WIN_ANSI_ENCODING;
    case 'MacRomanEncoding': return MAC_ROMAN_ENCODING;
    case 'StandardEncoding': return STANDARD_ENCODING;
    case 'MacExpertEncoding': return STANDARD_ENCODING; // Fallback
    default: return WIN_ANSI_ENCODING; // Default to WinAnsi
  }
}

/**
 * Apply a /Differences array to a base encoding.
 * Differences is an array like: [code1, name1, name2, ..., code2, name3, ...]
 * where each code starts a run of glyph name replacements.
 *
 * @param {object} baseEncoding - Map of byte code -> Unicode code point
 * @param {Array} differences - The /Differences array from the PDF encoding dict
 * @returns {object} New encoding map with differences applied
 */
function applyDifferences(baseEncoding, differences) {
  if (!differences || !Array.isArray(differences) || differences.length === 0) {
    return baseEncoding;
  }

  // Clone the base encoding
  var result = {};
  for (var key in baseEncoding) {
    result[key] = baseEncoding[key];
  }

  var currentCode = 0;
  for (var i = 0; i < differences.length; i++) {
    var item = differences[i];
    if (typeof item === 'number') {
      currentCode = item;
    } else if (typeof item === 'string') {
      // Item is a glyph name - look up Unicode
      var unicode = glyphNameToUnicode(item);
      if (unicode !== null) {
        result[currentCode] = unicode;
      }
      currentCode++;
    }
  }

  return result;
}

/**
 * Convert a glyph name to a Unicode code point.
 *
 * @param {string} name - Glyph name (e.g., "space", "A", "endash")
 * @returns {number|null} Unicode code point or null if unknown
 */
function glyphNameToUnicode(name) {
  if (!name || name === '.notdef') return null;

  // Direct lookup
  if (GLYPH_NAME_TO_UNICODE[name] !== undefined) {
    return GLYPH_NAME_TO_UNICODE[name];
  }

  // Try "uniXXXX" format
  if (name.length === 7 && name.substring(0, 3) === 'uni') {
    var hex = name.substring(3);
    var code = parseInt(hex, 16);
    if (isFinite(code) && code > 0) return code;
  }

  // Try "uXXXX" or "uXXXXX" format
  if (name.length >= 5 && name.charAt(0) === 'u') {
    var hex2 = name.substring(1);
    var code2 = parseInt(hex2, 16);
    if (isFinite(code2) && code2 > 0) return code2;
  }

  // If it's a single character, use its code
  if (name.length === 1) {
    return name.charCodeAt(0);
  }

  return null;
}

// ============================================================================
// ToUnicode CMap Parsing
// ============================================================================

/**
 * Parse a ToUnicode CMap from decoded stream data.
 * Returns a map of character codes to Unicode strings.
 *
 * CMap format includes:
 *   beginbfchar/endbfchar: single character mappings
 *   beginbfrange/endbfrange: range mappings
 *
 * @param {Uint8Array|string} cmapData - CMap stream content
 * @returns {object} Map of charCode (number) -> unicode string
 */
function parseToUnicodeCMap(cmapData) {
  var text;
  if (cmapData instanceof Uint8Array) {
    text = '';
    for (var i = 0; i < cmapData.length; i++) {
      text += String.fromCharCode(cmapData[i]);
    }
  } else {
    text = String(cmapData);
  }

  var map = {};

  // Parse beginbfchar ... endbfchar sections
  var bfcharPattern = /beginbfchar\s+([\s\S]*?)endbfchar/g;
  var bfcharMatch;
  while ((bfcharMatch = bfcharPattern.exec(text)) !== null) {
    var lines = bfcharMatch[1].trim().split(/\n/);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (line.length === 0) continue;
      // Each line: <srcCode> <dstString>
      var hexParts = extractHexStrings(line);
      if (hexParts.length >= 2) {
        var srcCode = parseInt(hexParts[0], 16);
        var dstUnicode = hexToUnicodeString(hexParts[1]);
        if (isFinite(srcCode)) {
          map[srcCode] = dstUnicode;
        }
      }
    }
  }

  // Parse beginbfrange ... endbfrange sections
  var bfrangePattern = /beginbfrange\s+([\s\S]*?)endbfrange/g;
  var bfrangeMatch;
  while ((bfrangeMatch = bfrangePattern.exec(text)) !== null) {
    var rangeLines = bfrangeMatch[1].trim().split(/\n/);
    for (var ri = 0; ri < rangeLines.length; ri++) {
      var rline = rangeLines[ri].trim();
      if (rline.length === 0) continue;

      var rparts = extractHexStrings(rline);
      // Check if the third element is an array of hex strings (bracket notation)
      var bracketMatch = rline.match(/\[([^\]]+)\]/);

      if (bracketMatch) {
        // Range with array of destination strings
        var startCode = parseInt(rparts[0], 16);
        var endCode = parseInt(rparts[1], 16);
        var dstStrings = extractHexStrings(bracketMatch[1]);
        for (var c = startCode; c <= endCode && (c - startCode) < dstStrings.length; c++) {
          map[c] = hexToUnicodeString(dstStrings[c - startCode]);
        }
      } else if (rparts.length >= 3) {
        // Range with single start destination
        var startCode2 = parseInt(rparts[0], 16);
        var endCode2 = parseInt(rparts[1], 16);
        var dstStart = parseInt(rparts[2], 16);
        for (var c2 = startCode2; c2 <= endCode2; c2++) {
          var offset = c2 - startCode2;
          map[c2] = String.fromCharCode(dstStart + offset);
        }
      }
    }
  }

  return map;
}

/**
 * Extract hex strings (content between < and >) from a line.
 */
function extractHexStrings(line) {
  var result = [];
  var hexPattern = /<([0-9A-Fa-f]+)>/g;
  var match;
  while ((match = hexPattern.exec(line)) !== null) {
    result.push(match[1]);
  }
  return result;
}

/**
 * Convert a hex string to a Unicode string.
 * Hex string may be 2 bytes (BMP) or 4 bytes (surrogate pair).
 */
function hexToUnicodeString(hex) {
  var str = '';
  for (var i = 0; i + 3 < hex.length; i += 4) {
    var code = parseInt(hex.substring(i, i + 4), 16);
    if (isFinite(code)) {
      str += String.fromCharCode(code);
    }
  }
  // Handle 2-byte hex (single byte character code)
  if (hex.length === 2) {
    var code2 = parseInt(hex, 16);
    if (isFinite(code2)) {
      str = String.fromCharCode(code2);
    }
  }
  return str || String.fromCharCode(0xFFFD);
}

// ============================================================================
// Font Resolution
// ============================================================================

/**
 * Build a usable font object from a PDF font dictionary.
 * Resolves encoding, widths, ToUnicode, and CSS mapping.
 *
 * @param {object} fontDict - The font dictionary from PDF Resources/Font
 * @param {object} doc - The PDFDocument instance (for resolving refs)
 * @returns {object} Resolved font object with methods for rendering
 */
function resolveFont(fontDict, doc) {
  if (!fontDict || typeof fontDict !== 'object') {
    return createDefaultFont();
  }

  // Resolve the font dict if it's a reference
  if (fontDict.isRef && doc) {
    fontDict = doc.resolveRef(fontDict);
    if (!fontDict) return createDefaultFont();
  }

  var subtype = fontDict.Subtype || 'Type1';
  var baseFont = fontDict.BaseFont || '';
  if (typeof baseFont === 'object' && baseFont.isRef && doc) {
    baseFont = doc.resolveRef(baseFont) || '';
  }

  var font = {
    name: baseFont,
    subtype: subtype,
    cssFamily: getCSSFontFamily(baseFont),
    cssWeight: getCSSFontWeight(baseFont),
    cssStyle: getCSSFontStyle(baseFont),
    encoding: null,       // code -> unicode map
    toUnicode: null,      // code -> unicode string map (from ToUnicode CMap)
    widths: {},           // code -> width in 1/1000 units
    defaultWidth: 1000,   // default width for missing glyphs
    isComposite: false,   // Type0/CIDFont
    isTwoByteEncoding: false, // Identity-H/V uses 2-byte codes
    missingWidth: 0       // /MissingWidth from font descriptor
  };

  // Resolve encoding
  resolveEncoding(font, fontDict, doc);

  // Resolve widths
  resolveWidths(font, fontDict, doc);

  // Resolve ToUnicode
  resolveToUnicode(font, fontDict, doc);

  // For Type3 fonts, capture glyph content stream data
  if (subtype === 'Type3') {
    // The renderer module provides buildType3FontData; check for it lazily
    var rendererMod = null;
    if (typeof module !== 'undefined' && module.exports) {
      try { rendererMod = require('./pdf-renderer.js'); } catch (e) { rendererMod = null; }
    } else if (typeof window !== 'undefined') {
      rendererMod = window.PDFRenderer || null;
    }
    if (rendererMod && rendererMod.buildType3FontData) {
      font._type3Data = rendererMod.buildType3FontData(fontDict, doc);
    }
  }

  return font;
}

/**
 * Resolve encoding for a font.
 */
function resolveEncoding(font, fontDict, doc) {
  var encoding = fontDict.Encoding;
  if (encoding && typeof encoding === 'object' && encoding.isRef && doc) {
    encoding = doc.resolveRef(encoding);
  }

  if (typeof encoding === 'string') {
    // Named encoding
    font.encoding = getEncoding(encoding);
  } else if (encoding && typeof encoding === 'object' && !Array.isArray(encoding)) {
    // Encoding dictionary with BaseEncoding and/or Differences
    var baseEncodingName = encoding.BaseEncoding || 'StandardEncoding';
    if (typeof baseEncodingName === 'object' && baseEncodingName.isRef && doc) {
      baseEncodingName = doc.resolveRef(baseEncodingName) || 'StandardEncoding';
    }
    var baseEnc = getEncoding(baseEncodingName);

    var differences = encoding.Differences;
    if (differences && typeof differences === 'object' && differences.isRef && doc) {
      differences = doc.resolveRef(differences);
    }
    if (Array.isArray(differences)) {
      // Resolve any refs in the differences array
      var resolvedDiffs = [];
      for (var i = 0; i < differences.length; i++) {
        var item = differences[i];
        if (typeof item === 'object' && item && item.isRef && doc) {
          item = doc.resolveRef(item);
        }
        resolvedDiffs.push(item);
      }
      font.encoding = applyDifferences(baseEnc, resolvedDiffs);
    } else {
      font.encoding = baseEnc;
    }
  } else {
    // No explicit encoding - use defaults based on font type
    var standardMetrics = getStandardFontMetrics(font.name);
    if (standardMetrics) {
      font.encoding = getEncoding('StandardEncoding');
    } else {
      font.encoding = getEncoding('WinAnsiEncoding');
    }
  }
}

/**
 * Resolve width tables for a font.
 */
function resolveWidths(font, fontDict, doc) {
  var subtype = fontDict.Subtype || 'Type1';

  if (subtype === 'Type0') {
    // Composite font - get widths from descendant CIDFont
    font.isComposite = true;
    var descendants = fontDict.DescendantFonts;
    if (descendants && typeof descendants === 'object' && descendants.isRef && doc) {
      descendants = doc.resolveRef(descendants);
    }
    if (Array.isArray(descendants) && descendants.length > 0) {
      var cidFont = descendants[0];
      if (cidFont && typeof cidFont === 'object' && cidFont.isRef && doc) {
        cidFont = doc.resolveRef(cidFont);
      }
      if (cidFont) {
        resolveCIDFontWidths(font, cidFont, doc);

        // Check CMap encoding
        var cmapEncoding = fontDict.Encoding;
        if (cmapEncoding && typeof cmapEncoding === 'object' && cmapEncoding.isRef && doc) {
          cmapEncoding = doc.resolveRef(cmapEncoding);
        }
        if (typeof cmapEncoding === 'string') {
          if (cmapEncoding === 'Identity-H' || cmapEncoding === 'Identity-V') {
            font.isTwoByteEncoding = true;
          }
        }
      }
    }
  } else {
    // Simple font - Type1, TrueType, Type3
    resolveSimpleFontWidths(font, fontDict, doc);
  }
}

/**
 * Resolve widths for a simple (non-composite) font.
 */
function resolveSimpleFontWidths(font, fontDict, doc) {
  // Check for /Widths array
  var widths = fontDict.Widths;
  if (widths && typeof widths === 'object' && widths.isRef && doc) {
    widths = doc.resolveRef(widths);
  }

  var firstChar = fontDict.FirstChar;
  if (typeof firstChar === 'object' && firstChar && firstChar.isRef && doc) {
    firstChar = doc.resolveRef(firstChar);
  }
  firstChar = typeof firstChar === 'number' ? firstChar : 0;

  if (Array.isArray(widths)) {
    for (var i = 0; i < widths.length; i++) {
      var w = widths[i];
      if (typeof w === 'object' && w && w.isRef && doc) {
        w = doc.resolveRef(w);
      }
      if (typeof w === 'number') {
        font.widths[firstChar + i] = w;
      }
    }
    font.defaultWidth = 1000; // Will use widths table
  }

  // If no explicit widths, try standard font metrics
  if (Object.keys(font.widths).length === 0) {
    var standardMetrics = getStandardFontMetrics(font.name);
    if (standardMetrics) {
      font.widths = standardMetrics.widths;
      font.defaultWidth = standardMetrics.defaultWidth;
    }
  }

  // Get MissingWidth from font descriptor
  var descriptor = fontDict.FontDescriptor;
  if (descriptor && typeof descriptor === 'object' && descriptor.isRef && doc) {
    descriptor = doc.resolveRef(descriptor);
  }
  if (descriptor && typeof descriptor === 'object') {
    if (typeof descriptor.MissingWidth === 'number') {
      font.missingWidth = descriptor.MissingWidth;
    }
  }
}

/**
 * Resolve widths for a CIDFont (composite font descendant).
 * CIDFonts use /W arrays with a different format than simple fonts.
 */
function resolveCIDFontWidths(font, cidFont, doc) {
  // Default width
  var dw = cidFont.DW;
  if (typeof dw === 'object' && dw && dw.isRef && doc) {
    dw = doc.resolveRef(dw);
  }
  font.defaultWidth = typeof dw === 'number' ? dw : 1000;

  // /W array: alternating between [cid [w1 w2 ...]] and [cidFirst cidLast w]
  var wArray = cidFont.W;
  if (wArray && typeof wArray === 'object' && wArray.isRef && doc) {
    wArray = doc.resolveRef(wArray);
  }

  if (Array.isArray(wArray)) {
    var wi = 0;
    while (wi < wArray.length) {
      var item = wArray[wi];
      if (typeof item === 'object' && item && item.isRef && doc) {
        item = doc.resolveRef(item);
      }

      if (typeof item === 'number') {
        var nextItem = wi + 1 < wArray.length ? wArray[wi + 1] : null;
        if (nextItem && typeof nextItem === 'object' && nextItem.isRef && doc) {
          nextItem = doc.resolveRef(nextItem);
        }

        if (Array.isArray(nextItem)) {
          // Format: cid [w1 w2 w3 ...]
          var startCID = item;
          for (var wj = 0; wj < nextItem.length; wj++) {
            var wval = nextItem[wj];
            if (typeof wval === 'object' && wval && wval.isRef && doc) {
              wval = doc.resolveRef(wval);
            }
            if (typeof wval === 'number') {
              font.widths[startCID + wj] = wval;
            }
          }
          wi += 2;
        } else if (typeof nextItem === 'number') {
          // Format: cidFirst cidLast width
          var cidFirst = item;
          var cidLast = nextItem;
          var width = wi + 2 < wArray.length ? wArray[wi + 2] : font.defaultWidth;
          if (typeof width === 'object' && width && width.isRef && doc) {
            width = doc.resolveRef(width);
          }
          if (typeof width === 'number') {
            for (var c = cidFirst; c <= cidLast; c++) {
              font.widths[c] = width;
            }
          }
          wi += 3;
        } else {
          wi++;
        }
      } else {
        wi++;
      }
    }
  }

  // Get MissingWidth from font descriptor
  var descriptor = cidFont.FontDescriptor;
  if (descriptor && typeof descriptor === 'object' && descriptor.isRef && doc) {
    descriptor = doc.resolveRef(descriptor);
  }
  if (descriptor && typeof descriptor === 'object') {
    if (typeof descriptor.MissingWidth === 'number') {
      font.missingWidth = descriptor.MissingWidth;
    }
  }
}

/**
 * Resolve ToUnicode CMap for a font.
 */
function resolveToUnicode(font, fontDict, doc) {
  var toUnicode = fontDict.ToUnicode;
  if (toUnicode && typeof toUnicode === 'object' && toUnicode.isRef && doc) {
    toUnicode = doc.resolveRef(toUnicode);
  }

  if (toUnicode && typeof toUnicode === 'object' && toUnicode._isStream) {
    try {
      var cmapData = doc.getStreamData(toUnicode);
      font.toUnicode = parseToUnicodeCMap(cmapData);
    } catch (e) {
      // ToUnicode CMap parsing failed - continue without it
      font.toUnicode = null;
    }
  }
}

/**
 * Get the width of a character code in a resolved font.
 *
 * @param {object} font - Resolved font object from resolveFont()
 * @param {number} charCode - Character code
 * @returns {number} Width in 1/1000 units
 */
function getCharWidth(font, charCode) {
  if (font.widths[charCode] !== undefined) {
    return font.widths[charCode];
  }
  if (font.missingWidth > 0) {
    return font.missingWidth;
  }
  return font.defaultWidth;
}

/**
 * Convert a character code to a Unicode string using the font's encoding.
 *
 * @param {object} font - Resolved font object
 * @param {number} charCode - Character code from the PDF string
 * @returns {string} Unicode character(s)
 */
function charCodeToUnicode(font, charCode) {
  // ToUnicode CMap takes priority
  if (font.toUnicode && font.toUnicode[charCode] !== undefined) {
    return font.toUnicode[charCode];
  }

  // Use encoding table
  if (font.encoding && font.encoding[charCode] !== undefined) {
    return String.fromCharCode(font.encoding[charCode]);
  }

  // Fallback: direct mapping
  if (charCode >= 32 && charCode <= 126) {
    return String.fromCharCode(charCode);
  }

  // Last resort
  return String.fromCharCode(charCode || 0xFFFD);
}

/**
 * Create a default font for when resolution fails.
 */
function createDefaultFont() {
  return {
    name: 'Helvetica',
    subtype: 'Type1',
    cssFamily: 'Helvetica, Arial, sans-serif',
    cssWeight: 'normal',
    cssStyle: '',
    encoding: WIN_ANSI_ENCODING,
    toUnicode: null,
    widths: HELVETICA_WIDTHS,
    defaultWidth: 556,
    isComposite: false,
    isTwoByteEncoding: false,
    missingWidth: 0
  };
}

// ============================================================================
// Exports
// ============================================================================

var PDFFonts = {
  getStandardFontMetrics: getStandardFontMetrics,
  getDefaultWidth: getDefaultWidth,
  getCSSFontFamily: getCSSFontFamily,
  getCSSFontWeight: getCSSFontWeight,
  getCSSFontStyle: getCSSFontStyle,
  getEncoding: getEncoding,
  applyDifferences: applyDifferences,
  glyphNameToUnicode: glyphNameToUnicode,
  parseToUnicodeCMap: parseToUnicodeCMap,
  resolveFont: resolveFont,
  getCharWidth: getCharWidth,
  charCodeToUnicode: charCodeToUnicode,
  createDefaultFont: createDefaultFont,
  // Expose tables for testing
  WIN_ANSI_ENCODING: WIN_ANSI_ENCODING,
  MAC_ROMAN_ENCODING: MAC_ROMAN_ENCODING,
  STANDARD_ENCODING: STANDARD_ENCODING,
  GLYPH_NAME_TO_UNICODE: GLYPH_NAME_TO_UNICODE,
  STANDARD_FONTS: STANDARD_FONTS,
  FONT_ALIASES: FONT_ALIASES
};

if (typeof window !== 'undefined') {
  window.PDFFonts = PDFFonts;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PDFFonts;
}
