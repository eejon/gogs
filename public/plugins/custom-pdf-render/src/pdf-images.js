/**
 * pdf-images.js — Image decode helpers for the custom PDF renderer.
 * Part of the custom-pdf-render engine for Gogs.
 *
 * Provides:
 *   - decodeImage(imageStream, parser) — decode an image XObject stream
 *     to ImageBitmap (browser) or a canvas-compatible object (Node.js mock)
 *
 * Supported image types:
 *   - DCTDecode (JPEG)     — via Blob + createImageBitmap
 *   - FlateDecode raw pixels — build ImageData from decoded bytes
 *   - DeviceGray color space — convert to RGBA
 *   - DeviceRGB color space  — convert to RGBA
 *   - DeviceCMYK color space — approximate CMYK → RGB → RGBA
 *
 * Unknown filter or decode error: returns null (renderer shows placeholder).
 *
 * No external library imports.
 */

'use strict';

// ─── decodeImage ──────────────────────────────────────────────────────────────

/**
 * decodeImage(imageStream, parser) → Promise<ImageBitmap|ImageData|null>
 *
 * Given a PDF stream object with /Subtype /Image, returns an ImageBitmap
 * (browser) or ImageData (fallback) suitable for ctx.drawImage().
 * Returns null on any error.
 *
 * @param {object} imageStream — stream object from PDFParser: { isStream, dict, rawBytes, getBytes }
 * @param {object} [parser]    — live PDFParser instance (not currently needed, reserved)
 * @returns {Promise<ImageBitmap|ImageData|null>}
 */
async function decodeImage(imageStream, parser) {
  if (!imageStream || !imageStream.isStream) return null;

  const dict = imageStream.dict || {};
  const width  = _imgGetNum(dict['/Width']  || dict['/W']);
  const height = _imgGetNum(dict['/Height'] || dict['/H']);
  if (!width || !height || width <= 0 || height <= 0) return null;

  const bitsPerComponent = _imgGetNum(dict['/BitsPerComponent'] || dict['/BPC']) || 8;
  const colorSpace = _imgGetColorSpaceName(dict['/ColorSpace'] || dict['/CS']);

  // Determine which filters are present (may be a name or array)
  const filters = _imgNormalizeFilters(dict['/Filter'] || dict['/F']);

  // Get raw stream bytes
  let rawBytes;
  try {
    rawBytes = imageStream.rawBytes;
    if (!rawBytes || rawBytes.length === 0) {
      rawBytes = await imageStream.getBytes();
    }
  } catch (e) {
    return null;
  }

  if (!rawBytes || rawBytes.length === 0) return null;

  // ── JPEG (DCTDecode) path ──
  if (filters.length > 0 && (filters[0] === 'DCTDecode' || filters[0] === 'DCT')) {
    return _decodeJPEG(rawBytes);
  }

  // ── All other filters: decompress then interpret pixel data ──
  let pixelBytes;
  try {
    pixelBytes = await imageStream.getBytes();
  } catch (e) {
    return null;
  }

  if (!pixelBytes || pixelBytes.length === 0) return null;

  const imageData = _decodeRawPixels(pixelBytes, width, height, colorSpace, bitsPerComponent);
  if (!imageData) return null;

  // In the browser, ctx.drawImage() requires an ImageBitmap/HTMLImageElement/canvas,
  // not a raw ImageData. Convert ImageData → ImageBitmap so drawImage() works.
  if (typeof createImageBitmap !== 'undefined' && typeof ImageData !== 'undefined' &&
      imageData instanceof ImageData) {
    try {
      return await createImageBitmap(imageData);
    } catch (_) {
      return imageData; // fall back — caller will handle gracefully
    }
  }

  // Node.js / test environment: return the ImageData-like object directly
  return imageData;
}

// ─── _decodeJPEG ─────────────────────────────────────────────────────────────

/**
 * _decodeJPEG(bytes) → Promise<ImageBitmap|null>
 *
 * Decode JPEG bytes to an ImageBitmap using Blob + createImageBitmap.
 * Falls back to creating an ImageData by parsing the JPEG manually
 * if createImageBitmap is unavailable (Node.js test environment).
 *
 * @param {Uint8Array} bytes — raw JPEG bytes
 * @returns {Promise<ImageBitmap|null>}
 */
async function _decodeJPEG(bytes) {
  // Browser path: use Blob + createImageBitmap
  if (typeof createImageBitmap !== 'undefined' && typeof Blob !== 'undefined') {
    try {
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      return await createImageBitmap(blob);
    } catch (e) {
      // Fall through to null
      return null;
    }
  }

  // Node.js test environment: return a placeholder object
  // that the mock canvas renderer can detect
  return {
    _isJPEGPlaceholder: true,
    width: 0,
    height: 0,
  };
}

// ─── _decodeRawPixels ─────────────────────────────────────────────────────────

/**
 * _decodeRawPixels(bytes, width, height, colorSpace, bitsPerComponent)
 *   → ImageData|null
 *
 * Build an RGBA ImageData from raw pixel bytes.
 * Handles DeviceGray, DeviceRGB, DeviceCMYK.
 * Only 8 bits per component is supported; other bit depths are not common
 * in practice and would require bit-packing math not implemented here.
 *
 * @param {Uint8Array} bytes
 * @param {number}     width
 * @param {number}     height
 * @param {string}     colorSpace
 * @param {number}     bitsPerComponent
 * @returns {ImageData|null}
 */
function _decodeRawPixels(bytes, width, height, colorSpace, bitsPerComponent) {
  if (bitsPerComponent !== 8) {
    // For simplicity, only handle 8-bit. Treat other depths as unknown.
    if (bitsPerComponent === 1) {
      return _decode1BitGray(bytes, width, height);
    }
    return null;
  }

  const pixelCount = width * height;
  let rgba;

  if (colorSpace === 'DeviceGray' || colorSpace === 'G') {
    if (bytes.length < pixelCount) return null;
    rgba = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
      const g = bytes[i];
      const o = i * 4;
      rgba[o]     = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = 255;
    }
  } else if (colorSpace === 'DeviceRGB' || colorSpace === 'RGB') {
    if (bytes.length < pixelCount * 3) return null;
    rgba = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
      const s = i * 3;
      const o = i * 4;
      rgba[o]     = bytes[s];
      rgba[o + 1] = bytes[s + 1];
      rgba[o + 2] = bytes[s + 2];
      rgba[o + 3] = 255;
    }
  } else if (colorSpace === 'DeviceCMYK' || colorSpace === 'CMYK') {
    if (bytes.length < pixelCount * 4) return null;
    rgba = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
      const s = i * 4;
      // CMYK to RGB approximation
      const c = bytes[s]     / 255;
      const m = bytes[s + 1] / 255;
      const y = bytes[s + 2] / 255;
      const k = bytes[s + 3] / 255;
      const o = i * 4;
      rgba[o]     = Math.round(255 * (1 - c) * (1 - k));
      rgba[o + 1] = Math.round(255 * (1 - m) * (1 - k));
      rgba[o + 2] = Math.round(255 * (1 - y) * (1 - k));
      rgba[o + 3] = 255;
    }
  } else {
    // Unknown color space — attempt to treat as DeviceRGB if byte count matches
    if (bytes.length >= pixelCount * 3) {
      return _decodeRawPixels(bytes, width, height, 'DeviceRGB', bitsPerComponent);
    } else if (bytes.length >= pixelCount) {
      return _decodeRawPixels(bytes, width, height, 'DeviceGray', bitsPerComponent);
    }
    return null;
  }

  // Build ImageData — only available in browser context
  if (typeof ImageData !== 'undefined') {
    return new ImageData(rgba, width, height);
  }

  // Node.js: return a plain object with ImageData-like shape for testing
  return { data: rgba, width, height, _isImageData: true };
}

/**
 * _decode1BitGray(bytes, width, height) → ImageData|null
 * Decode a 1-bit-per-pixel grayscale image (common in scanned docs).
 */
function _decode1BitGray(bytes, width, height) {
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex  = 7 - (i % 8); // MSB first
    const bit       = byteIndex < bytes.length ? (bytes[byteIndex] >> bitIndex) & 1 : 0;
    // PDF convention: 0 = black, 1 = white
    const g = bit ? 255 : 0;
    const o = i * 4;
    rgba[o]     = g;
    rgba[o + 1] = g;
    rgba[o + 2] = g;
    rgba[o + 3] = 255;
  }
  if (typeof ImageData !== 'undefined') {
    return new ImageData(rgba, width, height);
  }
  return { data: rgba, width, height, _isImageData: true };
}

// ─── Inline image decoding ────────────────────────────────────────────────────

/**
 * decodeInlineImage(inlineImageObj) → Promise<ImageBitmap|ImageData|null>
 *
 * Decode an inline image parsed from a content stream (BI...ID...EI block).
 * `inlineImageObj` is { dict, data: Uint8Array }.
 *
 * @param {{ dict: object, data: Uint8Array }} inlineImageObj
 * @returns {Promise<ImageBitmap|ImageData|null>}
 */
async function decodeInlineImage(inlineImageObj) {
  if (!inlineImageObj || !inlineImageObj.data) return null;

  const dict = inlineImageObj.dict || {};
  const width  = _imgGetNum(dict['/W'] || dict['/Width']);
  const height = _imgGetNum(dict['/H'] || dict['/Height']);
  if (!width || !height) return null;

  const bitsPerComponent = _imgGetNum(dict['/BPC'] || dict['/BitsPerComponent']) || 8;
  const colorSpace = _imgGetColorSpaceName(dict['/CS'] || dict['/ColorSpace']);
  const filters    = _imgNormalizeFilters(dict['/F'] || dict['/Filter']);

  let bytes = inlineImageObj.data;

  // If JPEG inline, use the JPEG path
  if (filters.length > 0 && (filters[0] === 'DCTDecode' || filters[0] === 'DCT')) {
    return _decodeJPEG(bytes);
  }

  // For FlateDecode and others, the parser should have already decoded.
  // If not, try to pass raw bytes to pixel decoder.
  return _decodeRawPixels(bytes, width, height, colorSpace, bitsPerComponent);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _imgGetNum(val) {
  if (typeof val === 'number') return val;
  if (val && typeof val === 'object' && 'value' in val) return val.value;
  return 0;
}

/**
 * _imgGetColorSpaceName(cs) → string
 * Extract a canonical color space name string from a parsed value.
 * PDF color spaces can be:
 *   - A name string: '/DeviceRGB', 'DeviceRGB'
 *   - An array: ['/DeviceRGB'] or ['/ICCBased', streamRef]
 */
function _imgGetColorSpaceName(cs) {
  if (!cs) return 'DeviceRGB';
  if (typeof cs === 'string') {
    const s = cs.startsWith('/') ? cs.slice(1) : cs;
    return _imgNormalizeColorSpace(s);
  }
  if (Array.isArray(cs) && cs.length > 0) {
    // First element is the color space name
    const first = cs[0];
    if (typeof first === 'string') {
      const s = first.startsWith('/') ? first.slice(1) : first;
      return _imgNormalizeColorSpace(s);
    }
  }
  return 'DeviceRGB';
}

function _imgNormalizeColorSpace(name) {
  switch (name) {
    case 'DeviceGray': case 'G': return 'DeviceGray';
    case 'DeviceRGB':  case 'RGB': return 'DeviceRGB';
    case 'DeviceCMYK': case 'CMYK': return 'DeviceCMYK';
    // ICCBased and Indexed often wrap a base space — default to RGB
    case 'ICCBased':  return 'DeviceRGB';
    case 'Indexed':   return 'DeviceGray'; // simplified
    case 'CalRGB':    return 'DeviceRGB';
    case 'CalGray':   return 'DeviceGray';
    default:          return 'DeviceRGB';
  }
}

/**
 * _imgNormalizeFilters(filter) → string[]
 * Normalize /Filter value to an array of bare filter name strings.
 */
function _imgNormalizeFilters(filter) {
  if (!filter) return [];
  if (typeof filter === 'string') {
    return [filter.startsWith('/') ? filter.slice(1) : filter];
  }
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
  module.exports = {
    decodeImage,
    decodeInlineImage,
  };
} else {
  window.PDFImages = {
    decodeImage,
    decodeInlineImage,
  };
}
