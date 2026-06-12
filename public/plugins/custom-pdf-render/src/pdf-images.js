/**
 * pdf-images.js -- PDF Image Rendering Module
 *
 * Provides:
 *   - JPEG passthrough (DCTDecode): create Image from raw bytes
 *   - FlateDecode image reconstruction for 8bpc DeviceRGB/DeviceGray
 *   - Inline image (BI/ID/EI) data parsing
 *   - Image XObject rendering to canvas context
 *   - Color space conversion helpers (CMYK -> RGB, Gray -> RGB)
 *
 * Phase 2b will extend with:
 *   - Multi-bpc support (1, 2, 4 bpc)
 *   - PNG predictor filter handling
 *   - Indexed color spaces
 *   - ICCBased color spaces
 *   - Image masks and soft masks
 *
 * No external imports. All code is self-contained.
 */

'use strict';

// ============================================================================
// Color Space Conversion
// ============================================================================

/**
 * Convert CMYK values (0-1 range) to RGB (0-255 range).
 * Uses the standard subtractive color model.
 *
 * @param {number} c - Cyan (0-1)
 * @param {number} m - Magenta (0-1)
 * @param {number} y - Yellow (0-1)
 * @param {number} k - Key/Black (0-1)
 * @returns {number[]} [r, g, b] each 0-255
 */
function cmykToRGB(c, m, y, k) {
  var r = 255 * (1 - c) * (1 - k);
  var g = 255 * (1 - m) * (1 - k);
  var b = 255 * (1 - y) * (1 - k);
  return [
    Math.max(0, Math.min(255, Math.round(r))),
    Math.max(0, Math.min(255, Math.round(g))),
    Math.max(0, Math.min(255, Math.round(b)))
  ];
}

/**
 * Resolve a color space name to a canonical form.
 * @param {*} cs - color space specification
 * @returns {string} canonical color space name
 */
function resolveColorSpace(cs) {
  if (!cs) return 'DeviceRGB';
  if (typeof cs === 'string') {
    var name = cs;
    if (name.charAt(0) === '/') name = name.substring(1);
    // Inline image abbreviations
    var abbrevMap = {
      'G': 'DeviceGray', 'RGB': 'DeviceRGB', 'CMYK': 'DeviceCMYK',
      'I': 'Indexed',
    };
    if (abbrevMap[name]) return abbrevMap[name];
    return name;
  }
  if (Array.isArray(cs) && cs.length > 0) {
    var spaceName = cs[0];
    if (typeof spaceName === 'string') {
      if (spaceName.charAt(0) === '/') spaceName = spaceName.substring(1);
      return spaceName;
    }
  }
  return 'DeviceRGB';
}

/**
 * Get the number of color components for a color space.
 * @param {string} cs - canonical color space name
 * @returns {number}
 */
function getColorComponents(cs) {
  switch (cs) {
    case 'DeviceGray': case 'CalGray': return 1;
    case 'DeviceRGB': case 'CalRGB': return 3;
    case 'DeviceCMYK': return 4;
    case 'Indexed': return 1;
    default: return 3; // assume RGB for unknown
  }
}

// ============================================================================
// PNG Predictor Filter Reversal
// ============================================================================

/**
 * Reverse PNG predictor filters applied to FlateDecode image data.
 *
 * PNG predictors (Predictor 10-15) operate per-scanline. Each scanline has a
 * filter byte prefix followed by the filtered pixel bytes:
 *   0 = None, 1 = Sub, 2 = Up, 3 = Average, 4 = Paeth
 *
 * The Predictor parameter from the PDF DecodeParms dictionary tells us:
 *   1  = no prediction
 *   2  = TIFF predictor (not PNG)
 *   10 = PNG None on every row
 *   11 = PNG Sub on every row
 *   12 = PNG Up on every row
 *   13 = PNG Average on every row
 *   14 = PNG Paeth on every row
 *   15 = PNG Optimum (per-row filter byte selects the filter)
 *
 * For predictors 10-14, the data MAY or MAY NOT include a per-row filter byte.
 * For predictor 15, each row MUST have a filter byte.
 *
 * @param {Uint8Array} data - raw decoded (post-inflate) data with predictor filters
 * @param {number} width - image width in pixels
 * @param {number} bpc - bits per component
 * @param {number} components - number of color components per pixel
 * @param {number} predictor - predictor value (10-15)
 * @returns {Uint8Array} unfiltered pixel data
 */
function reversePNGPredictors(data, width, bpc, components, predictor) {
  if (!data || data.length === 0) return data;
  if (predictor < 10 || predictor > 15) return data;

  // Bytes per pixel (minimum 1 for the filter algorithm)
  var bitsPerPixel = bpc * components;
  var bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));

  // Row width in bytes (without the filter byte)
  var rowBytes = Math.ceil(width * bitsPerPixel / 8);

  // Determine if the data includes per-row filter bytes.
  // For predictor 15, it always does.
  // For 10-14, check: if data length == height * (rowBytes + 1), filter bytes present.
  //   If data length == height * rowBytes, no filter bytes.
  var hasFilterByte;
  var rowStride;

  // We need to figure out height from the data length
  if (predictor === 15) {
    // Optimum: each row has a filter byte
    hasFilterByte = true;
    rowStride = rowBytes + 1;
  } else {
    // Fixed predictor (10-14): try with filter bytes first
    rowStride = rowBytes + 1;
    var heightWithFilter = Math.floor(data.length / rowStride);
    var heightWithout = Math.floor(data.length / rowBytes);

    if (heightWithFilter * rowStride === data.length && rowBytes > 0) {
      hasFilterByte = true;
    } else if (heightWithout * rowBytes === data.length && rowBytes > 0) {
      hasFilterByte = false;
      rowStride = rowBytes;
    } else {
      // Ambiguous: prefer with filter byte
      hasFilterByte = true;
    }
  }

  var height = Math.floor(data.length / rowStride);
  if (height <= 0) return data;

  var output = new Uint8Array(height * rowBytes);
  var prevRow = new Uint8Array(rowBytes); // initialized to 0

  for (var row = 0; row < height; row++) {
    var srcOffset = row * rowStride;
    var dstOffset = row * rowBytes;

    var filterType;
    var dataOffset;
    if (hasFilterByte) {
      filterType = data[srcOffset];
      dataOffset = srcOffset + 1;
    } else {
      // Use the fixed predictor type
      filterType = predictor - 10; // 10->0 (None), 11->1 (Sub), etc.
      dataOffset = srcOffset;
    }

    // Clamp filter type to valid range
    if (filterType > 4) filterType = 0;

    for (var col = 0; col < rowBytes; col++) {
      var raw = (dataOffset + col < data.length) ? data[dataOffset + col] : 0;
      var a = (col >= bytesPerPixel) ? output[dstOffset + col - bytesPerPixel] : 0; // left
      var b = prevRow[col]; // above
      var c = (col >= bytesPerPixel) ? prevRow[col - bytesPerPixel] : 0; // upper-left

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
          result = raw;
      }
      output[dstOffset + col] = result;
    }

    // Copy current row to prevRow for next iteration
    for (var col = 0; col < rowBytes; col++) {
      prevRow[col] = output[dstOffset + col];
    }
  }

  return output;
}

/**
 * Paeth predictor function used in PNG filtering.
 * Selects the value closest to p = a + b - c.
 *
 * @param {number} a - left byte
 * @param {number} b - above byte
 * @param {number} c - upper-left byte
 * @returns {number} predicted byte value
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

/**
 * Reverse TIFF predictor 2 (horizontal differencing).
 * Each sample is stored as the difference from the preceding sample
 * in the same row.
 *
 * @param {Uint8Array} data - raw decoded data
 * @param {number} width - image width in pixels
 * @param {number} components - number of color components per pixel
 * @param {number} bpc - bits per component (must be 8 for TIFF predictor 2)
 * @returns {Uint8Array} unfiltered pixel data
 */
function reverseTIFFPredictor(data, width, components, bpc) {
  if (!data || data.length === 0) return data;
  if (bpc !== 8) return data; // TIFF predictor 2 only defined for 8bpc

  var rowBytes = width * components;
  var height = Math.floor(data.length / rowBytes);
  if (height <= 0) return data;

  var output = new Uint8Array(data);

  for (var row = 0; row < height; row++) {
    var rowOffset = row * rowBytes;
    for (var col = components; col < rowBytes; col++) {
      output[rowOffset + col] = (output[rowOffset + col] + output[rowOffset + col - components]) & 0xFF;
    }
  }

  return output;
}

// ============================================================================
// Image Data Reconstruction
// ============================================================================

/**
 * Build RGBA ImageData from raw decoded image bytes.
 *
 * @param {Uint8Array} data - decoded pixel data
 * @param {number} width - image width in pixels
 * @param {number} height - image height in pixels
 * @param {number} bpc - bits per component (supports 1, 2, 4, 8)
 * @param {string} colorSpace - canonical color space name
 * @param {object} [options] - additional options (palette, etc.)
 * @returns {Uint8ClampedArray} RGBA pixel data (width*height*4 bytes)
 */
function buildRGBAData(data, width, height, bpc, colorSpace, options) {
  var pixelCount = width * height;
  var rgba = new Uint8ClampedArray(pixelCount * 4);

  if (!data || data.length === 0) {
    // Return transparent image
    return rgba;
  }

  var components = getColorComponents(colorSpace);

  if (bpc === 8) {
    return buildRGBA8bpc(data, width, height, colorSpace, components, rgba, options);
  } else if (bpc === 1) {
    return buildRGBA1bpc(data, width, height, colorSpace, rgba, options);
  } else if (bpc === 2) {
    return buildRGBANbpc(data, width, height, 2, colorSpace, components, rgba, options);
  } else if (bpc === 4) {
    return buildRGBANbpc(data, width, height, 4, colorSpace, components, rgba, options);
  }

  // Fallback: treat as 8bpc RGB
  return buildRGBA8bpc(data, width, height, colorSpace, components, rgba, options);
}

function buildRGBA8bpc(data, width, height, colorSpace, components, rgba, options) {
  var pixelCount = width * height;
  var srcIdx = 0;

  if (colorSpace === 'DeviceGray' || colorSpace === 'CalGray') {
    for (var i = 0; i < pixelCount; i++) {
      var g = srcIdx < data.length ? data[srcIdx++] : 0;
      var out = i * 4;
      rgba[out]     = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = 255;
    }
  } else if (colorSpace === 'DeviceRGB' || colorSpace === 'CalRGB') {
    for (var i = 0; i < pixelCount; i++) {
      var out = i * 4;
      rgba[out]     = srcIdx < data.length ? data[srcIdx++] : 0;
      rgba[out + 1] = srcIdx < data.length ? data[srcIdx++] : 0;
      rgba[out + 2] = srcIdx < data.length ? data[srcIdx++] : 0;
      rgba[out + 3] = 255;
    }
  } else if (colorSpace === 'DeviceCMYK') {
    for (var i = 0; i < pixelCount; i++) {
      var c = (srcIdx < data.length ? data[srcIdx++] : 0) / 255;
      var m = (srcIdx < data.length ? data[srcIdx++] : 0) / 255;
      var y = (srcIdx < data.length ? data[srcIdx++] : 0) / 255;
      var k = (srcIdx < data.length ? data[srcIdx++] : 0) / 255;
      var rgb = cmykToRGB(c, m, y, k);
      var out = i * 4;
      rgba[out]     = rgb[0];
      rgba[out + 1] = rgb[1];
      rgba[out + 2] = rgb[2];
      rgba[out + 3] = 255;
    }
  } else if (colorSpace === 'Indexed' && options && options.palette) {
    var palette = options.palette;
    var baseCS = options.baseColorSpace || 'DeviceRGB';
    var baseComponents = getColorComponents(baseCS);
    for (var i = 0; i < pixelCount; i++) {
      var idx = srcIdx < data.length ? data[srcIdx++] : 0;
      var pIdx = idx * baseComponents;
      var out = i * 4;
      if (baseCS === 'DeviceRGB' || baseCS === 'CalRGB') {
        rgba[out]     = pIdx < palette.length ? palette[pIdx]     : 0;
        rgba[out + 1] = pIdx + 1 < palette.length ? palette[pIdx + 1] : 0;
        rgba[out + 2] = pIdx + 2 < palette.length ? palette[pIdx + 2] : 0;
      } else if (baseCS === 'DeviceGray' || baseCS === 'CalGray') {
        var g = pIdx < palette.length ? palette[pIdx] : 0;
        rgba[out]     = g;
        rgba[out + 1] = g;
        rgba[out + 2] = g;
      } else if (baseCS === 'DeviceCMYK') {
        var pc = pIdx < palette.length ? palette[pIdx] / 255 : 0;
        var pm = pIdx + 1 < palette.length ? palette[pIdx + 1] / 255 : 0;
        var py = pIdx + 2 < palette.length ? palette[pIdx + 2] / 255 : 0;
        var pk = pIdx + 3 < palette.length ? palette[pIdx + 3] / 255 : 0;
        var rgb = cmykToRGB(pc, pm, py, pk);
        rgba[out]     = rgb[0];
        rgba[out + 1] = rgb[1];
        rgba[out + 2] = rgb[2];
      } else {
        // assume RGB palette
        rgba[out]     = pIdx < palette.length ? palette[pIdx]     : 0;
        rgba[out + 1] = pIdx + 1 < palette.length ? palette[pIdx + 1] : 0;
        rgba[out + 2] = pIdx + 2 < palette.length ? palette[pIdx + 2] : 0;
      }
      rgba[out + 3] = 255;
    }
  } else {
    // Unknown color space: assume RGB
    for (var i = 0; i < pixelCount; i++) {
      var out = i * 4;
      rgba[out]     = srcIdx < data.length ? data[srcIdx++] : 0;
      rgba[out + 1] = srcIdx < data.length ? data[srcIdx++] : 0;
      rgba[out + 2] = srcIdx < data.length ? data[srcIdx++] : 0;
      rgba[out + 3] = 255;
    }
  }

  return rgba;
}

function buildRGBA1bpc(data, width, height, colorSpace, rgba, options) {
  var pixelCount = width * height;
  var byteWidth = Math.ceil(width / 8);

  for (var row = 0; row < height; row++) {
    for (var col = 0; col < width; col++) {
      var byteIdx = row * byteWidth + Math.floor(col / 8);
      var bitIdx = 7 - (col % 8);
      var bit = byteIdx < data.length ? ((data[byteIdx] >> bitIdx) & 1) : 0;
      var out = (row * width + col) * 4;

      // In PDF, for DeviceGray 1bpc: 0=black, 1=white
      var g = bit ? 255 : 0;
      rgba[out]     = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = 255;
    }
  }

  return rgba;
}

function buildRGBANbpc(data, width, height, bpc, colorSpace, components, rgba, options) {
  var pixelCount = width * height;
  var maxVal = (1 << bpc) - 1;
  var bitPos = 0;

  function readBits(n) {
    var val = 0;
    for (var i = 0; i < n; i++) {
      var byteIdx = Math.floor(bitPos / 8);
      var bitIdx = 7 - (bitPos % 8);
      if (byteIdx < data.length) {
        val = (val << 1) | ((data[byteIdx] >> bitIdx) & 1);
      } else {
        val = val << 1;
      }
      bitPos++;
    }
    return val;
  }

  for (var i = 0; i < pixelCount; i++) {
    var out = i * 4;
    if (colorSpace === 'DeviceGray' || colorSpace === 'CalGray' || components === 1) {
      var g = readBits(bpc);
      g = Math.round((g / maxVal) * 255);
      rgba[out]     = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = 255;
    } else if (components === 3) {
      var r = readBits(bpc);
      var g = readBits(bpc);
      var b = readBits(bpc);
      rgba[out]     = Math.round((r / maxVal) * 255);
      rgba[out + 1] = Math.round((g / maxVal) * 255);
      rgba[out + 2] = Math.round((b / maxVal) * 255);
      rgba[out + 3] = 255;
    } else if (components === 4) {
      var c = readBits(bpc) / maxVal;
      var m = readBits(bpc) / maxVal;
      var y = readBits(bpc) / maxVal;
      var k = readBits(bpc) / maxVal;
      var rgb = cmykToRGB(c, m, y, k);
      rgba[out]     = rgb[0];
      rgba[out + 1] = rgb[1];
      rgba[out + 2] = rgb[2];
      rgba[out + 3] = 255;
    } else {
      rgba[out]     = 0;
      rgba[out + 1] = 0;
      rgba[out + 2] = 0;
      rgba[out + 3] = 255;
    }
  }

  return rgba;
}

// ============================================================================
// JPEG Image Handling
// ============================================================================

/**
 * Create a drawable image from JPEG bytes.
 * In browser context, creates a blob URL and loads into an Image.
 * In Node.js context (testing), returns a mock.
 *
 * @param {Uint8Array} jpegBytes - raw JPEG data
 * @returns {Promise<Object>} image-like object with width/height, drawable with ctx.drawImage
 */
function createJPEGImage(jpegBytes) {
  // Browser environment: create a blob and load into Image
  if (typeof Blob !== 'undefined' && typeof Image !== 'undefined' && typeof URL !== 'undefined') {
    return new Promise(function(resolve, reject) {
      try {
        var blob = new Blob([jpegBytes], { type: 'image/jpeg' });
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function() {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = function() {
          URL.revokeObjectURL(url);
          reject(new Error('Failed to load JPEG image'));
        };
        img.src = url;
      } catch (e) {
        reject(e);
      }
    });
  }

  // Node.js / test environment: return a mock image
  return Promise.resolve({
    width: 1,
    height: 1,
    _isMock: true,
  });
}

// ============================================================================
// Image XObject Rendering
// ============================================================================

/**
 * Draw an image XObject to a canvas context.
 * The caller is responsible for setting up the CTM (the image occupies
 * a 1x1 unit square in user space when drawn with Do).
 *
 * Supports:
 *   - JPEG passthrough (DCTDecode)
 *   - FlateDecode with PNG predictor filters (Predictor 10-15)
 *   - TIFF predictor 2 (horizontal differencing)
 *   - Multi-bpc (1, 2, 4, 8)
 *   - DeviceRGB, DeviceGray, DeviceCMYK, ICCBased, Indexed, CalRGB, CalGray
 *   - Image masks (/ImageMask true): stencil with current fill color
 *   - Soft masks (/SMask): alpha channel application
 *
 * @param {CanvasRenderingContext2D} ctx - canvas context
 * @param {object} imageObj - image XObject (stream object from parser)
 * @param {object} parser - PDF parser instance for reference resolution
 * @param {object} [renderState] - optional render state for image mask fill color
 * @returns {Promise<void>}
 */
async function drawImageXObject(ctx, imageObj, parser, renderState) {
  if (!imageObj || !ctx) return;

  var dict = imageObj.dict || imageObj;
  var width = resolveValue(dict['/Width'], parser) || resolveValue(dict['/W'], parser) || 1;
  var height = resolveValue(dict['/Height'], parser) || resolveValue(dict['/H'], parser) || 1;
  var bpc = resolveValue(dict['/BitsPerComponent'], parser) || resolveValue(dict['/BPC'], parser) || 8;
  var filter = resolveValue(dict['/Filter'], parser) || resolveValue(dict['/F'], parser);
  var colorSpace = resolveValue(dict['/ColorSpace'], parser) || resolveValue(dict['/CS'], parser);
  var decodeParms = resolveValue(dict['/DecodeParms'], parser) || resolveValue(dict['/DP'], parser);

  // Determine the filter name
  var filterName = '';
  if (typeof filter === 'string') {
    filterName = filter;
    if (filterName.charAt(0) === '/') filterName = filterName.substring(1);
  } else if (Array.isArray(filter) && filter.length > 0) {
    filterName = typeof filter[0] === 'string' ? filter[0] : '';
    if (filterName.charAt(0) === '/') filterName = filterName.substring(1);
  }

  // Check for image mask
  var isImageMask = dict['/ImageMask'] === true || resolveValue(dict['/IM'], parser) === true;

  // For image masks, bpc defaults to 1
  if (isImageMask) {
    bpc = 1;
  }

  // Resolve color space
  var csName = resolveColorSpace(colorSpace);

  // Handle ICCBased -> fallback to device color space
  if (csName === 'ICCBased') {
    var iccStream = null;
    if (Array.isArray(colorSpace) && colorSpace.length > 1) {
      iccStream = resolveValue(colorSpace[1], parser);
    }
    if (iccStream) {
      var iccDict = iccStream.dict || iccStream;
      var n = resolveValue(iccDict['/N'], parser);
      if (n === 1) csName = 'DeviceGray';
      else if (n === 3) csName = 'DeviceRGB';
      else if (n === 4) csName = 'DeviceCMYK';
      else csName = 'DeviceRGB';
    } else {
      csName = 'DeviceRGB';
    }
  }

  // Handle Indexed color space
  var palette = null;
  var baseColorSpace = null;
  if (csName === 'Indexed' && Array.isArray(colorSpace)) {
    baseColorSpace = resolveColorSpace(resolveValue(colorSpace[1], parser));
    // Handle ICCBased as base of Indexed
    if (baseColorSpace === 'ICCBased') {
      var iccBase = resolveValue(colorSpace[1], parser);
      if (Array.isArray(iccBase) && iccBase.length > 1) {
        var iccBaseStream = resolveValue(iccBase[1], parser);
        if (iccBaseStream) {
          var iccBaseDict = iccBaseStream.dict || iccBaseStream;
          var iccN = resolveValue(iccBaseDict['/N'], parser);
          if (iccN === 1) baseColorSpace = 'DeviceGray';
          else if (iccN === 3) baseColorSpace = 'DeviceRGB';
          else if (iccN === 4) baseColorSpace = 'DeviceCMYK';
          else baseColorSpace = 'DeviceRGB';
        }
      }
    }
    // colorSpace[2] is hival, colorSpace[3] is lookup table
    var lookupData = resolveValue(colorSpace[3], parser);
    if (lookupData) {
      if (lookupData.isStream) {
        try { palette = lookupData.getBytes(); } catch(e) { palette = null; }
      } else if (lookupData instanceof Uint8Array) {
        palette = lookupData;
      } else if (typeof lookupData === 'string') {
        palette = new Uint8Array(lookupData.length);
        for (var pi = 0; pi < lookupData.length; pi++) palette[pi] = lookupData.charCodeAt(pi);
      }
    }
  }

  // JPEG passthrough: let browser decode it natively
  if (filterName === 'DCTDecode' || filterName === 'DCT') {
    try {
      var rawBytes = imageObj.rawBytes || (typeof imageObj.getBytes === 'function' ? null : null);
      if (!rawBytes && imageObj.isStream) {
        rawBytes = imageObj.rawBytes;
      }
      if (!rawBytes) {
        // Fall through to pixel reconstruction
      } else {
        var img = await createJPEGImage(rawBytes);
        if (img && !img._isMock) {
          ctx.drawImage(img, 0, 0, 1, 1);
          return;
        }
        if (img && img._isMock) {
          ctx.drawImage(img, 0, 0, 1, 1);
          return;
        }
      }
    } catch (e) {
      console.warn('JPEG passthrough failed, trying pixel reconstruction:', e.message);
    }
  }

  // Get decoded pixel data
  var pixelData;
  try {
    if (typeof imageObj.getBytes === 'function') {
      pixelData = imageObj.getBytes();
    } else if (imageObj.data) {
      pixelData = imageObj.data;
    } else {
      return; // no data available
    }
  } catch (e) {
    console.warn('Failed to decode image data:', e.message);
    return;
  }

  if (!pixelData || pixelData.length === 0) return;

  // Apply predictor reversal if needed (for FlateDecode images)
  // The parser may have already reversed predictors during stream decode,
  // but if DecodeParms specifies PNG predictors, we apply them here.
  if (decodeParms && typeof decodeParms === 'object') {
    var dpObj = decodeParms;
    if (Array.isArray(decodeParms)) {
      dpObj = decodeParms[0] || {};
      if (dpObj && typeof dpObj === 'object' && dpObj.type === 'ref') {
        dpObj = resolveValue(dpObj, parser) || {};
      }
    }
    if (dpObj && typeof dpObj === 'object' && dpObj.type === 'ref') {
      dpObj = resolveValue(dpObj, parser) || {};
    }

    var predictor = resolveValue(dpObj['/Predictor'], parser);
    if (typeof predictor === 'number' && predictor > 1) {
      var dpColumns = resolveValue(dpObj['/Columns'], parser) || width;
      var dpColors = resolveValue(dpObj['/Colors'], parser) || getColorComponents(csName);
      var dpBPC = resolveValue(dpObj['/BitsPerComponent'], parser) || bpc;

      if (predictor >= 10) {
        pixelData = reversePNGPredictors(pixelData, dpColumns, dpBPC, dpColors, predictor);
      } else if (predictor === 2) {
        pixelData = reverseTIFFPredictor(pixelData, dpColumns, dpColors, dpBPC);
      }
    }
  }

  // Build RGBA data
  var options = {};
  if (palette) {
    options.palette = palette;
    options.baseColorSpace = baseColorSpace;
  }

  var rgbaData = buildRGBAData(pixelData, width, height, bpc, csName, options);

  // Handle image mask: render as stencil using current fill color
  if (isImageMask && renderState) {
    var fillColor = renderState.fillColor || [0, 0, 0];
    var fillCS = renderState.fillColorSpace || 'DeviceGray';

    // Determine the RGB fill color
    var maskR, maskG, maskB;
    if (fillCS === 'DeviceGray' || fillCS === 'CalGray' || fillColor.length === 1) {
      var gv = Math.max(0, Math.min(255, Math.round((fillColor[0] || 0) * 255)));
      maskR = gv; maskG = gv; maskB = gv;
    } else if (fillCS === 'DeviceCMYK' || fillColor.length === 4) {
      var mRGB = cmykToRGB(fillColor[0] || 0, fillColor[1] || 0, fillColor[2] || 0, fillColor[3] || 0);
      maskR = mRGB[0]; maskG = mRGB[1]; maskB = mRGB[2];
    } else {
      maskR = Math.max(0, Math.min(255, Math.round((fillColor[0] || 0) * 255)));
      maskG = Math.max(0, Math.min(255, Math.round((fillColor[1] || 0) * 255)));
      maskB = Math.max(0, Math.min(255, Math.round((fillColor[2] || 0) * 255)));
    }

    // Check for /Decode array (inverts the mask sense)
    var decode = resolveValue(dict['/Decode'], parser) || resolveValue(dict['/D'], parser);
    var invert = false;
    if (Array.isArray(decode) && decode.length >= 2 && decode[0] === 1 && decode[1] === 0) {
      invert = true;
    }

    // Apply mask: 0 bits => paint fill color (opaque), 1 bits => transparent
    // (unless /Decode [1 0] inverts)
    var pixelCount = width * height;
    for (var i = 0; i < pixelCount; i++) {
      var out = i * 4;
      // In the rgbaData from buildRGBA1bpc, 0=black (bit=0), 255=white (bit=1)
      var isSet = rgbaData[out] > 128; // bit was 1
      var paintThis = invert ? isSet : !isSet;

      if (paintThis) {
        rgbaData[out]     = maskR;
        rgbaData[out + 1] = maskG;
        rgbaData[out + 2] = maskB;
        rgbaData[out + 3] = 255;
      } else {
        rgbaData[out]     = 0;
        rgbaData[out + 1] = 0;
        rgbaData[out + 2] = 0;
        rgbaData[out + 3] = 0; // transparent
      }
    }
  }

  // Handle soft mask (/SMask): apply as alpha channel
  var smaskRef = resolveValue(dict['/SMask'], parser);
  if (smaskRef && typeof smaskRef === 'object' && !Array.isArray(smaskRef)) {
    try {
      var smaskData = await buildSoftMaskAlpha(smaskRef, width, height, parser);
      if (smaskData) {
        var pixelCount = width * height;
        for (var i = 0; i < pixelCount; i++) {
          rgbaData[i * 4 + 3] = smaskData[i];
        }
      }
    } catch (e) {
      console.warn('Soft mask processing failed:', e.message);
    }
  }

  // Draw to canvas using putImageData (via temp canvas for scaling)
  drawRGBAToCanvas(ctx, rgbaData, width, height);
}

/**
 * Build alpha channel data from a soft mask (SMask) stream.
 *
 * @param {object} smaskObj - soft mask stream object
 * @param {number} targetWidth - target image width
 * @param {number} targetHeight - target image height
 * @param {object} parser - PDF parser instance
 * @returns {Uint8Array|null} alpha values (one byte per pixel, 0-255)
 */
async function buildSoftMaskAlpha(smaskObj, targetWidth, targetHeight, parser) {
  if (!smaskObj) return null;

  var dict = smaskObj.dict || smaskObj;
  var smWidth = resolveValue(dict['/Width'], parser) || targetWidth;
  var smHeight = resolveValue(dict['/Height'], parser) || targetHeight;
  var smBPC = resolveValue(dict['/BitsPerComponent'], parser) || 8;
  var smCS = resolveValue(dict['/ColorSpace'], parser);
  var smCSName = resolveColorSpace(smCS);

  // Soft masks are typically DeviceGray
  if (smCSName === 'ICCBased' && Array.isArray(smCS) && smCS.length > 1) {
    var iccS = resolveValue(smCS[1], parser);
    if (iccS) {
      var iccSD = iccS.dict || iccS;
      var sn = resolveValue(iccSD['/N'], parser);
      if (sn === 1) smCSName = 'DeviceGray';
    }
  }

  // Get decoded soft mask data
  var smData;
  try {
    if (typeof smaskObj.getBytes === 'function') {
      smData = smaskObj.getBytes();
    } else if (smaskObj.data) {
      smData = smaskObj.data;
    }
  } catch (e) {
    return null;
  }

  if (!smData || smData.length === 0) return null;

  // Apply predictor reversal if needed
  var dpSM = resolveValue(dict['/DecodeParms'], parser);
  if (dpSM && typeof dpSM === 'object') {
    if (Array.isArray(dpSM)) dpSM = dpSM[0];
    if (dpSM && dpSM.type === 'ref') dpSM = resolveValue(dpSM, parser);
    if (dpSM) {
      var predSM = resolveValue(dpSM['/Predictor'], parser);
      if (typeof predSM === 'number' && predSM >= 10) {
        var colsSM = resolveValue(dpSM['/Columns'], parser) || smWidth;
        smData = reversePNGPredictors(smData, colsSM, smBPC, 1, predSM);
      }
    }
  }

  // Build alpha values from the soft mask grayscale data
  var alpha = new Uint8Array(smWidth * smHeight);
  var maxVal = (1 << smBPC) - 1;
  if (maxVal <= 0) maxVal = 255;

  if (smBPC === 8) {
    for (var i = 0; i < alpha.length; i++) {
      alpha[i] = i < smData.length ? smData[i] : 255;
    }
  } else {
    // Handle non-8bpc soft masks
    var bitPos = 0;
    for (var i = 0; i < alpha.length; i++) {
      var val = 0;
      for (var bit = 0; bit < smBPC; bit++) {
        var byteIdx = Math.floor(bitPos / 8);
        var bitIdx = 7 - (bitPos % 8);
        if (byteIdx < smData.length) {
          val = (val << 1) | ((smData[byteIdx] >> bitIdx) & 1);
        } else {
          val = val << 1;
        }
        bitPos++;
      }
      alpha[i] = Math.round((val / maxVal) * 255);
    }
  }

  // If soft mask dimensions differ from target, scale the alpha channel
  if (smWidth !== targetWidth || smHeight !== targetHeight) {
    alpha = scaleAlphaChannel(alpha, smWidth, smHeight, targetWidth, targetHeight);
  }

  return alpha;
}

/**
 * Scale an alpha channel array using nearest-neighbor interpolation.
 *
 * @param {Uint8Array} alpha - source alpha values
 * @param {number} srcW - source width
 * @param {number} srcH - source height
 * @param {number} dstW - destination width
 * @param {number} dstH - destination height
 * @returns {Uint8Array} scaled alpha values
 */
function scaleAlphaChannel(alpha, srcW, srcH, dstW, dstH) {
  var result = new Uint8Array(dstW * dstH);
  var xRatio = srcW / dstW;
  var yRatio = srcH / dstH;

  for (var y = 0; y < dstH; y++) {
    var sy = Math.min(Math.floor(y * yRatio), srcH - 1);
    for (var x = 0; x < dstW; x++) {
      var sx = Math.min(Math.floor(x * xRatio), srcW - 1);
      result[y * dstW + x] = alpha[sy * srcW + sx];
    }
  }

  return result;
}

/**
 * Draw RGBA data to a canvas context using a temp canvas for proper scaling.
 * Handles browser, OffscreenCanvas, and Node.js test environments.
 *
 * @param {CanvasRenderingContext2D} ctx - target canvas context
 * @param {Uint8ClampedArray} rgbaData - RGBA pixel data
 * @param {number} width - image width
 * @param {number} height - image height
 */
function drawRGBAToCanvas(ctx, rgbaData, width, height) {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      var tempCanvas = new OffscreenCanvas(width, height);
      var tempCtx = tempCanvas.getContext('2d');
      var imgData = tempCtx.createImageData(width, height);
      imgData.data.set(rgbaData);
      tempCtx.putImageData(imgData, 0, 0);
      ctx.drawImage(tempCanvas, 0, 0, 1, 1);
    } else if (typeof document !== 'undefined') {
      var tempCanvas = document.createElement('canvas');
      tempCanvas.width = width;
      tempCanvas.height = height;
      var tempCtx = tempCanvas.getContext('2d');
      var imgData = tempCtx.createImageData(width, height);
      imgData.data.set(rgbaData);
      tempCtx.putImageData(imgData, 0, 0);
      ctx.drawImage(tempCanvas, 0, 0, 1, 1);
    } else {
      // Node.js test environment: just call drawImage for the mock
      ctx.drawImage({ width: width, height: height, _isMock: true }, 0, 0, 1, 1);
    }
  } catch (e) {
    console.warn('Failed to draw image to canvas:', e.message);
    try {
      ctx.drawImage({ width: width, height: height }, 0, 0, 1, 1);
    } catch (e2) {
      // ignore
    }
  }
}

/**
 * Draw an inline image to a canvas context.
 *
 * @param {CanvasRenderingContext2D} ctx - canvas context
 * @param {object} inlineImageDict - parsed inline image dictionary
 * @param {Uint8Array} inlineImageData - raw inline image data
 * @returns {Promise<void>}
 */
async function drawInlineImage(ctx, inlineImageDict, inlineImageData) {
  if (!ctx || !inlineImageDict || !inlineImageData) return;

  var width = inlineImageDict['/Width'] || 1;
  var height = inlineImageDict['/Height'] || 1;
  var bpc = inlineImageDict['/BitsPerComponent'] || 8;
  var colorSpace = inlineImageDict['/ColorSpace'];
  var csName = resolveColorSpace(colorSpace);
  var components = getColorComponents(csName);

  // Check for DCTDecode (inline JPEG)
  var filter = inlineImageDict['/Filter'];
  if (typeof filter === 'string') {
    var fn = filter.charAt(0) === '/' ? filter.substring(1) : filter;
    if (fn === 'DCTDecode' || fn === 'DCT') {
      try {
        var img = await createJPEGImage(inlineImageData);
        if (img) {
          ctx.drawImage(img, 0, 0, 1, 1);
          return;
        }
      } catch (e) {
        // Fall through
      }
    }
  }

  // Build RGBA data from the pixel bytes
  var rgbaData = buildRGBAData(inlineImageData, width, height, bpc, csName, {});

  drawRGBAToCanvas(ctx, rgbaData, width, height);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a value that might be an indirect reference.
 */
function resolveValue(val, parser) {
  if (!val) return val;
  if (typeof val === 'object' && val.type === 'ref' && parser && typeof parser.resolveRef === 'function') {
    return parser.resolveRef(val);
  }
  return val;
}

// ============================================================================
// Module exports
// ============================================================================

var _PDFImagesExports = {
  cmykToRGB: cmykToRGB,
  resolveColorSpace: resolveColorSpace,
  getColorComponents: getColorComponents,
  buildRGBAData: buildRGBAData,
  createJPEGImage: createJPEGImage,
  drawImageXObject: drawImageXObject,
  drawInlineImage: drawInlineImage,
  drawRGBAToCanvas: drawRGBAToCanvas,
  resolveValue: resolveValue,
  reversePNGPredictors: reversePNGPredictors,
  reverseTIFFPredictor: reverseTIFFPredictor,
  paethPredictor: paethPredictor,
  buildSoftMaskAlpha: buildSoftMaskAlpha,
  scaleAlphaChannel: scaleAlphaChannel,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _PDFImagesExports;
}

// Browser: expose as window.PDFImages so pdf-renderer.js can find it
if (typeof window !== 'undefined') {
  window.PDFImages = _PDFImagesExports;
}
