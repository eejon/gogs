/**
 * PDF Image Handling
 *
 * Decodes and renders image XObjects and inline images from PDF content streams.
 * Handles:
 *   - DCTDecode (JPEG) passthrough to browser
 *   - FlateDecode with PNG predictors for raster images
 *   - Raw (uncompressed) image data
 *   - BitsPerComponent: 1, 2, 4, 8
 *   - Color spaces: DeviceGray, DeviceRGB, DeviceCMYK, Indexed, ICCBased
 *   - Image masks (stencil masks, /ImageMask true)
 *   - Soft masks (/SMask)
 *   - Color key masks (/Mask array)
 *   - Inline images (BI/ID/EI)
 *
 * No external dependencies. All decoding is self-contained.
 *
 * Public interface:
 *   PDFImages.renderImageXObject(ctx, state, imgObj, resources, doc) - render image XObject
 *   PDFImages.renderInlineImage(ctx, state, imageDict, imageData, resources, doc) - render inline image
 */

'use strict';

// ============================================================================
// Dependencies
// ============================================================================

var _stream, _renderer;

if (typeof module !== 'undefined' && module.exports) {
  _stream = require('./pdf-stream.js');
  _renderer = require('./pdf-renderer.js');
} else if (typeof window !== 'undefined') {
  _stream = window.PDFStreamDecoders;
  _renderer = window.PDFRenderer;
}

// ============================================================================
// Constants
// ============================================================================

var MAX_IMAGE_PIXELS = 100 * 1024 * 1024; // 100 megapixels max
var MAX_IMAGE_DIMENSION = 16384; // Max canvas dimension

// ============================================================================
// Image XObject Rendering
// ============================================================================

/**
 * Render an image XObject onto the canvas context.
 * The image is drawn in a 1x1 unit square (scaled by the CTM to final size).
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas context (with CTM already applied)
 * @param {object} state - Current graphics state
 * @param {object} imgObj - The image XObject dictionary (with stream data)
 * @param {object} resources - Page resources
 * @param {object} doc - PDFDocument instance
 */
function renderImageXObject(ctx, state, imgObj, resources, doc) {
  var width = resolveValue(imgObj.Width, doc) || resolveValue(imgObj.W, doc) || 1;
  var height = resolveValue(imgObj.Height, doc) || resolveValue(imgObj.H, doc) || 1;

  // Validate dimensions
  if (width <= 0 || height <= 0 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    drawPlaceholder(ctx);
    return;
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    drawPlaceholder(ctx);
    return;
  }

  var bpc = resolveValue(imgObj.BitsPerComponent, doc) || resolveValue(imgObj.BPC, doc) || 8;
  var isImageMask = resolveValue(imgObj.ImageMask, doc) || resolveValue(imgObj.IM, doc) || false;
  var interpolate = resolveValue(imgObj.Interpolate, doc) || resolveValue(imgObj.I, doc) || false;

  // Resolve color space
  var csSpec = imgObj.ColorSpace || imgObj.CS;
  if (csSpec && typeof csSpec === 'object' && csSpec.isRef && doc) {
    csSpec = doc.resolveRef(csSpec);
  }

  // Handle image masks (stencil masks)
  if (isImageMask) {
    renderStencilMask(ctx, state, imgObj, width, height, doc);
    return;
  }

  // Get the filter to determine how to decode
  var filter = imgObj.Filter || imgObj.F;
  if (filter && typeof filter === 'object' && filter.isRef && doc) {
    filter = doc.resolveRef(filter);
  }
  var filterName = normalizeFilterName(filter);

  // DCTDecode (JPEG) - pass raw bytes to browser
  if (filterName === 'DCTDecode') {
    renderJPEGImage(ctx, imgObj, width, height, doc);
    return;
  }

  // JPXDecode (JPEG 2000) - attempt browser decode
  if (filterName === 'JPXDecode') {
    renderJPXImage(ctx, imgObj, width, height, doc);
    return;
  }

  // Get raw stream data (will be decoded by stream decoders for Flate, etc.)
  var rawData;
  try {
    rawData = doc.getStreamData(imgObj);
  } catch (e) {
    drawPlaceholder(ctx);
    return;
  }

  if (!rawData || rawData.length === 0) {
    drawPlaceholder(ctx);
    return;
  }

  // Resolve the color space
  var colorSpace = resolveImageColorSpace(csSpec, resources, doc);

  // Decode the pixel data
  var rgbaData = decodeImageData(rawData, width, height, bpc, colorSpace, imgObj, doc);
  if (!rgbaData) {
    drawPlaceholder(ctx);
    return;
  }

  // Apply soft mask if present
  var smask = imgObj.SMask;
  if (smask && typeof smask === 'object' && smask.isRef && doc) {
    smask = doc.resolveRef(smask);
  }
  if (smask && typeof smask === 'object' && smask._isStream) {
    applySoftMask(rgbaData, smask, width, height, doc);
  }

  // Apply color key mask if present (Mask as an array)
  var mask = imgObj.Mask;
  if (mask && typeof mask === 'object' && mask.isRef && doc) {
    mask = doc.resolveRef(mask);
  }
  if (Array.isArray(mask) && !mask.isRef) {
    applyColorKeyMask(rgbaData, mask, width, height, bpc, colorSpace);
  }

  // Apply /Decode array if present
  // (already handled in decodeImageData)

  // Draw to canvas
  drawImageData(ctx, rgbaData, width, height, interpolate);
}

/**
 * Render an inline image (from BI/ID/EI operators).
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {object} state - Current graphics state
 * @param {object} imageDict - Inline image dictionary (already expanded)
 * @param {Uint8Array} imageData - Raw image data bytes
 * @param {object} resources - Page resources
 * @param {object} doc - PDFDocument instance
 */
function renderInlineImage(ctx, state, imageDict, imageData, resources, doc) {
  var width = imageDict.Width || imageDict.W || 1;
  var height = imageDict.Height || imageDict.H || 1;
  var bpc = imageDict.BitsPerComponent || imageDict.BPC || 8;
  var isImageMask = imageDict.ImageMask || imageDict.IM || false;

  if (width <= 0 || height <= 0 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    return;
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    return;
  }

  var filter = imageDict.Filter || imageDict.F;
  var filterName = normalizeFilterName(filter);

  // Decode the stream data if filtered
  var decodedData = imageData;
  if (filter) {
    var decodeParms = imageDict.DecodeParms || imageDict.DP || null;
    try {
      decodedData = _stream.decodeStream(imageData, filter, decodeParms);
    } catch (e) {
      // If decode fails, try raw data
      decodedData = imageData;
    }
  }

  // DCTDecode inline images: raw JPEG data
  if (filterName === 'DCTDecode') {
    // Check for non-default /Decode array on inline JPEG
    var inlineDecode = imageDict.Decode || imageDict.D;
    if (!Array.isArray(inlineDecode)) { inlineDecode = null; }
    var inlineNeedsDecode = false;
    if (inlineDecode) {
      for (var di = 0; di < inlineDecode.length; di += 2) {
        var idmin = (typeof inlineDecode[di] === 'number') ? inlineDecode[di] : 0;
        var idmax = (di + 1 < inlineDecode.length && typeof inlineDecode[di + 1] === 'number') ? inlineDecode[di + 1] : 1;
        if (idmin !== 0 || idmax !== 1) { inlineNeedsDecode = true; break; }
      }
    }
    if (inlineNeedsDecode) {
      renderJPEGWithDecode(ctx, imageData, width, height, inlineDecode);
    } else {
      renderJPEGDataDirect(ctx, imageData, width, height);
    }
    return;
  }

  if (isImageMask) {
    renderInlineStencilMask(ctx, state, decodedData, width, height, bpc);
    return;
  }

  // Resolve color space
  var csSpec = imageDict.ColorSpace || imageDict.CS;
  var colorSpace = resolveImageColorSpace(csSpec, resources, doc);

  // Decode pixel data
  var rgbaData = decodeImageData(decodedData, width, height, bpc, colorSpace, imageDict, doc);
  if (!rgbaData) {
    return;
  }

  // Draw
  drawImageData(ctx, rgbaData, width, height, false);
}

// ============================================================================
// JPEG (DCTDecode) Handling
// ============================================================================

/**
 * Render a JPEG image by extracting raw stream bytes (pre-decode) and
 * passing them to the browser's native JPEG decoder via a blob URL.
 *
 * In Node.js test environment, this draws a placeholder since there's no
 * browser Image API.
 */
function renderJPEGImage(ctx, imgObj, width, height, doc) {
  // We need the raw (undecoded) stream bytes for JPEG
  var rawBytes;
  try {
    rawBytes = getRawStreamBytes(imgObj, doc);
  } catch (e) {
    drawPlaceholder(ctx);
    return;
  }

  if (!rawBytes || rawBytes.length === 0) {
    drawPlaceholder(ctx);
    return;
  }

  // Check if there is a /Decode array that requires post-processing.
  // JPEG images are normally passed straight to the browser decoder,
  // but a non-default /Decode array (e.g. [1 0] for DeviceGray, or
  // [1 0 1 0 1 0] for DeviceRGB) means the decoded pixel values must
  // be linearly remapped — typically to invert colors.
  var decode = imgObj.Decode || imgObj.D;
  if (decode && typeof decode === 'object' && decode.isRef && doc) {
    decode = doc.resolveRef(decode);
  }
  if (!Array.isArray(decode)) {
    decode = null;
  }

  var needsDecode = false;
  if (decode) {
    // Check whether the Decode array differs from the default [0 1 ...].
    // Default mapping for each component is Dmin=0, Dmax=1.
    for (var i = 0; i < decode.length; i += 2) {
      var dmin = (typeof decode[i] === 'number') ? decode[i] : 0;
      var dmax = (i + 1 < decode.length && typeof decode[i + 1] === 'number') ? decode[i + 1] : 1;
      if (dmin !== 0 || dmax !== 1) {
        needsDecode = true;
        break;
      }
    }
  }

  if (needsDecode) {
    renderJPEGWithDecode(ctx, rawBytes, width, height, decode);
  } else {
    renderJPEGDataDirect(ctx, rawBytes, width, height);
  }
}

/**
 * Render JPEG 2000 (JPXDecode) image.
 * Browsers generally do not support JPEG 2000 natively.
 * Draw a placeholder.
 */
function renderJPXImage(ctx, imgObj, width, height, doc) {
  // JPEG 2000 is not widely supported in browsers
  // Draw placeholder
  drawPlaceholder(ctx);
}

/**
 * Render raw JPEG bytes by creating an Image element.
 * In Node.js (testing), uses putImageData placeholder.
 *
 * IMPORTANT: Image loading is asynchronous. By the time img.onload fires,
 * the canvas context's transform will have changed (other operators have
 * executed). We capture the current transform at call time and restore it
 * inside the callback using ctx.save()/ctx.setTransform()/ctx.restore()
 * so the image is drawn with the correct CTM that was active when the
 * Do operator was executed.
 */
function renderJPEGDataDirect(ctx, jpegBytes, width, height) {
  if (typeof Image === 'undefined') {
    // Node.js environment - draw placeholder
    drawPlaceholder(ctx);
    return;
  }

  // Browser environment: create a blob URL and draw
  try {
    var blob = new Blob([jpegBytes], { type: 'image/jpeg' });
    var url = URL.createObjectURL(blob);

    // Capture the current transform matrix BEFORE the async load.
    // This is the CTM that the cm operator set up for this image's
    // 1x1 unit square.
    var savedTransform = null;
    if (typeof ctx.getTransform === 'function') {
      savedTransform = ctx.getTransform();
    }

    var img = new Image();
    img.onload = function() {
      ctx.save();

      // Restore the exact transform that was active when renderJPEGDataDirect
      // was called. Without this, the transform has moved on to later
      // operators and the image would be drawn in the wrong position/scale.
      if (savedTransform) {
        ctx.setTransform(
          savedTransform.a, savedTransform.b,
          savedTransform.c, savedTransform.d,
          savedTransform.e, savedTransform.f
        );
      }

      // Draw the image in the 1x1 unit square (CTM handles scaling)
      ctx.scale(1 / width, -1 / height);
      ctx.translate(0, -height);

      if ('imageSmoothingEnabled' in ctx) {
        ctx.imageSmoothingEnabled = true;
      }

      ctx.drawImage(img, 0, 0, width, height);
      ctx.restore();
      URL.revokeObjectURL(url);
    };
    img.onerror = function() {
      URL.revokeObjectURL(url);
    };
    img.src = url;
  } catch (e) {
    drawPlaceholder(ctx);
  }
}

/**
 * Render a JPEG image with a non-default /Decode array applied.
 *
 * The browser decodes the JPEG normally, then we read back the pixel data
 * from an offscreen canvas and apply the /Decode linear mapping to each
 * component before drawing the result onto the target context.
 *
 * The /Decode array contains pairs [Dmin, Dmax] for each color component.
 * Each decoded sample value v (in 0..255) is remapped to:
 *   v' = Dmin + (v / 255) * (Dmax - Dmin)
 * then scaled back to 0..255.
 *
 * For example, /Decode [1 0] on a grayscale JPEG inverts every pixel:
 *   v' = 1 + (v/255) * (0 - 1) = 1 - v/255  =>  mapped to 255 - v.
 */
function renderJPEGWithDecode(ctx, jpegBytes, width, height, decode) {
  if (typeof Image === 'undefined') {
    drawPlaceholder(ctx);
    return;
  }

  try {
    var blob = new Blob([jpegBytes], { type: 'image/jpeg' });
    var url = URL.createObjectURL(blob);

    // Capture the current transform before the async load
    var savedTransform = null;
    if (typeof ctx.getTransform === 'function') {
      savedTransform = ctx.getTransform();
    }

    var img = new Image();
    img.onload = function() {
      // Draw the JPEG onto a temporary offscreen canvas to read pixels
      var tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = width;
      tmpCanvas.height = height;
      var tmpCtx = tmpCanvas.getContext('2d');
      tmpCtx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);

      // Read back the decoded pixel data
      var imageData = tmpCtx.getImageData(0, 0, width, height);
      var pixels = imageData.data; // Uint8ClampedArray [R,G,B,A, R,G,B,A, ...]

      // Determine how many color components the Decode array covers.
      // Each component has a [Dmin, Dmax] pair.
      var numDecodeComponents = Math.floor(decode.length / 2);

      // Apply the /Decode mapping to each pixel's color channels.
      // Pixel layout is RGBA; we remap up to 3 channels (R, G, B).
      //
      // When the Decode array has only one component pair (DeviceGray
      // with e.g. /Decode [1 0]), the browser has already expanded the
      // grayscale JPEG to RGB (R=G=B), so we apply the same single
      // mapping to all three channels.
      //
      // When it has 3+ pairs (DeviceRGB), each channel gets its own
      // mapping. CMYK JPEGs decoded by browsers are converted to RGB,
      // so we cap at 3 channels.
      for (var p = 0; p < pixels.length; p += 4) {
        for (var ch = 0; ch < 3; ch++) {
          // For single-component Decode, reuse decode[0..1] for all channels
          var di = (numDecodeComponents === 1) ? 0 : ch;
          var dmin = (di * 2 < decode.length && typeof decode[di * 2] === 'number') ? decode[di * 2] : 0;
          var dmax = (di * 2 + 1 < decode.length && typeof decode[di * 2 + 1] === 'number') ? decode[di * 2 + 1] : 1;
          var sample = pixels[p + ch] / 255;
          var mapped = dmin + sample * (dmax - dmin);
          pixels[p + ch] = Math.round(clamp(mapped, 0, 1) * 255);
        }
        // Alpha channel (index 3) is left untouched
      }

      // Write the remapped pixels back to the temp canvas
      tmpCtx.putImageData(imageData, 0, 0);

      // Now draw the corrected image onto the real canvas with the
      // proper transform
      ctx.save();
      if (savedTransform) {
        ctx.setTransform(
          savedTransform.a, savedTransform.b,
          savedTransform.c, savedTransform.d,
          savedTransform.e, savedTransform.f
        );
      }

      ctx.scale(1 / width, -1 / height);
      ctx.translate(0, -height);

      if ('imageSmoothingEnabled' in ctx) {
        ctx.imageSmoothingEnabled = true;
      }

      ctx.drawImage(tmpCanvas, 0, 0, width, height);
      ctx.restore();
    };
    img.onerror = function() {
      URL.revokeObjectURL(url);
    };
    img.src = url;
  } catch (e) {
    drawPlaceholder(ctx);
  }
}

/**
 * Get raw (undecoded) stream bytes from an object.
 * This bypasses the stream decoder to get the original bytes for JPEG passthrough.
 */
function getRawStreamBytes(streamObj, doc) {
  if (!streamObj || !streamObj._isStream) return null;

  if (streamObj._streamData && streamObj._streamData.length > 0) {
    return streamObj._streamData;
  }

  if (!doc) return null;

  var offset = streamObj._streamOffset;
  var length = streamObj.Length;
  if (typeof length === 'object' && length && length.isRef && doc) {
    length = doc.resolveRef(length);
  }
  if (typeof length !== 'number' || length <= 0) {
    return null;
  }

  if (typeof offset === 'number' && offset >= 0 && doc.data) {
    var end = Math.min(offset + length, doc.data.length);
    return doc.data.subarray(offset, end);
  }

  return null;
}

// ============================================================================
// Stencil Mask (ImageMask) Rendering
// ============================================================================

/**
 * Render a stencil mask image.
 * When /ImageMask is true, the image is 1-bit and the current fill color
 * is painted where the mask bit is set (or clear, depending on /Decode).
 */
function renderStencilMask(ctx, state, imgObj, width, height, doc) {
  var rawData;
  try {
    rawData = doc.getStreamData(imgObj);
  } catch (e) {
    return;
  }

  if (!rawData || rawData.length === 0) return;

  // Check /Decode array - default for ImageMask is [0, 1]
  // meaning: 0 = paint (opaque), 1 = transparent
  var decode = imgObj.Decode || imgObj.D;
  if (decode && typeof decode === 'object' && decode.isRef && doc) {
    decode = doc.resolveRef(decode);
  }
  var invertMask = false;
  if (Array.isArray(decode) && decode.length >= 2) {
    // [1, 0] inverts the mask meaning
    invertMask = (decode[0] === 1 && decode[1] === 0);
  }

  renderMaskBits(ctx, state, rawData, width, height, invertMask);
}

/**
 * Render inline stencil mask.
 */
function renderInlineStencilMask(ctx, state, data, width, height, bpc) {
  renderMaskBits(ctx, state, data, width, height, false);
}

/**
 * Common stencil mask rendering: paint fill color where mask bits are set.
 */
function renderMaskBits(ctx, state, data, width, height, invert) {
  // Create RGBA image data
  var pixels = width * height;
  var rgbaData = new Uint8ClampedArray(pixels * 4);

  // Parse the fill color to R, G, B values
  var fillRGB = parseCSSColor(state.fillColor);

  // Unpack 1-bit data
  var byteIndex = 0;
  var bitIndex = 7;
  var bytesPerRow = Math.ceil(width / 8);

  for (var row = 0; row < height; row++) {
    byteIndex = row * bytesPerRow;
    bitIndex = 7;

    for (var col = 0; col < width; col++) {
      if (byteIndex >= data.length) break;

      var bit = (data[byteIndex] >> bitIndex) & 1;
      var pixelOffset = (row * width + col) * 4;

      // Default: bit=0 means paint (opaque), bit=1 means transparent
      // If inverted: bit=1 means paint, bit=0 means transparent
      var shouldPaint = invert ? (bit === 1) : (bit === 0);

      if (shouldPaint) {
        rgbaData[pixelOffset] = fillRGB[0];
        rgbaData[pixelOffset + 1] = fillRGB[1];
        rgbaData[pixelOffset + 2] = fillRGB[2];
        rgbaData[pixelOffset + 3] = Math.round(state.fillAlpha * 255);
      } else {
        rgbaData[pixelOffset] = 0;
        rgbaData[pixelOffset + 1] = 0;
        rgbaData[pixelOffset + 2] = 0;
        rgbaData[pixelOffset + 3] = 0;
      }

      bitIndex--;
      if (bitIndex < 0) {
        bitIndex = 7;
        byteIndex++;
      }
    }
  }

  drawImageData(ctx, rgbaData, width, height, false);
}

// ============================================================================
// Soft Mask (SMask) Application
// ============================================================================

/**
 * Apply a soft mask to RGBA image data.
 * The soft mask is a grayscale image that defines the alpha channel.
 */
function applySoftMask(rgbaData, smaskObj, imgWidth, imgHeight, doc) {
  var smaskWidth = resolveValue(smaskObj.Width, doc) || imgWidth;
  var smaskHeight = resolveValue(smaskObj.Height, doc) || imgHeight;
  var smaskBPC = resolveValue(smaskObj.BitsPerComponent, doc) || 8;

  var smaskData;
  try {
    smaskData = doc.getStreamData(smaskObj);
  } catch (e) {
    return; // Cannot decode soft mask, leave alpha unchanged
  }

  if (!smaskData || smaskData.length === 0) return;

  // The soft mask should be DeviceGray
  var maxVal = (1 << smaskBPC) - 1;

  // If the soft mask dimensions match the image, apply directly
  if (smaskWidth === imgWidth && smaskHeight === imgHeight) {
    var pixelCount = imgWidth * imgHeight;
    var smaskIndex = 0;
    var bitBuffer = 0;
    var bitsRemaining = 0;
    var bytesPerRowSrc = Math.ceil(smaskWidth * smaskBPC / 8);

    for (var row = 0; row < imgHeight; row++) {
      var rowStart = row * bytesPerRowSrc;
      smaskIndex = rowStart;
      bitsRemaining = 0;
      bitBuffer = 0;

      for (var col = 0; col < imgWidth; col++) {
        var alphaVal;
        if (smaskBPC === 8) {
          alphaVal = smaskIndex < smaskData.length ? smaskData[smaskIndex++] : 255;
        } else {
          alphaVal = readBits(smaskData, smaskIndex, bitsRemaining, bitBuffer, smaskBPC);
          var result = advanceBits(smaskIndex, bitsRemaining, smaskBPC);
          smaskIndex = result[0];
          bitsRemaining = result[1];
          alphaVal = Math.round((alphaVal / maxVal) * 255);
        }

        var pixelOffset = (row * imgWidth + col) * 4;
        if (pixelOffset + 3 < rgbaData.length) {
          // Multiply existing alpha with mask alpha
          rgbaData[pixelOffset + 3] = Math.round((rgbaData[pixelOffset + 3] / 255) * alphaVal);
        }
      }
    }
  } else {
    // Dimensions differ - scale the mask using nearest neighbor
    for (var y = 0; y < imgHeight; y++) {
      var srcY = Math.floor(y * smaskHeight / imgHeight);
      for (var x = 0; x < imgWidth; x++) {
        var srcX = Math.floor(x * smaskWidth / imgWidth);
        var smaskPixel;

        if (smaskBPC === 8) {
          var srcIdx = srcY * smaskWidth + srcX;
          smaskPixel = srcIdx < smaskData.length ? smaskData[srcIdx] : 255;
        } else {
          var srcBytesPerRow = Math.ceil(smaskWidth * smaskBPC / 8);
          var bitPos = srcY * srcBytesPerRow * 8 + srcX * smaskBPC;
          var bytePos = Math.floor(bitPos / 8);
          var bitOff = 8 - (bitPos % 8) - smaskBPC;
          if (bitOff < 0) bitOff = 0;
          smaskPixel = bytePos < smaskData.length ?
            ((smaskData[bytePos] >> bitOff) & ((1 << smaskBPC) - 1)) : maxVal;
          smaskPixel = Math.round((smaskPixel / maxVal) * 255);
        }

        var po = (y * imgWidth + x) * 4;
        if (po + 3 < rgbaData.length) {
          rgbaData[po + 3] = Math.round((rgbaData[po + 3] / 255) * smaskPixel);
        }
      }
    }
  }
}

// ============================================================================
// Color Key Mask Application
// ============================================================================

/**
 * Apply a color key mask to RGBA image data.
 * The /Mask array contains [min1, max1, min2, max2, ...] for each component.
 * Pixels whose component values fall within all ranges become transparent.
 */
function applyColorKeyMask(rgbaData, mask, width, height, bpc, colorSpace) {
  var numComponents = colorSpace.numComponents || 1;
  var maxVal = (1 << bpc) - 1;

  if (mask.length < numComponents * 2) return;

  // We need to check against the original decoded component values,
  // but we only have RGBA data at this point. For simplicity, we
  // convert the mask ranges to 0-255 and compare against R, G, B.
  var maskRanges = [];
  for (var i = 0; i < numComponents; i++) {
    var minVal = Math.round((mask[i * 2] / maxVal) * 255);
    var maxValRange = Math.round((mask[i * 2 + 1] / maxVal) * 255);
    maskRanges.push({ min: minVal, max: maxValRange });
  }

  var pixels = width * height;
  for (var p = 0; p < pixels; p++) {
    var offset = p * 4;
    var isTransparent = true;

    // Check each component
    for (var c = 0; c < maskRanges.length && c < 3; c++) {
      var val = rgbaData[offset + c];
      if (val < maskRanges[c].min || val > maskRanges[c].max) {
        isTransparent = false;
        break;
      }
    }

    if (isTransparent) {
      rgbaData[offset + 3] = 0; // Make transparent
    }
  }
}

// ============================================================================
// Image Data Decoding
// ============================================================================

/**
 * Decode raw image stream data into RGBA pixel data.
 *
 * @param {Uint8Array} data - Decoded stream bytes
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number} bpc - Bits per component (1, 2, 4, or 8)
 * @param {object} colorSpace - Resolved color space object
 * @param {object} imgDict - Image dictionary (for /Decode array)
 * @param {object} doc - PDFDocument instance
 * @returns {Uint8ClampedArray} RGBA pixel data (width*height*4 bytes)
 */
function decodeImageData(data, width, height, bpc, colorSpace, imgDict, doc) {
  var numComponents = colorSpace.numComponents || 1;
  var csType = colorSpace.type || 'DeviceGray';
  var pixels = width * height;

  // Get Decode array
  var decode = imgDict.Decode || imgDict.D;
  if (decode && typeof decode === 'object' && decode.isRef && doc) {
    decode = doc.resolveRef(decode);
  }
  if (!Array.isArray(decode)) {
    decode = null;
  }

  var maxVal = (1 << bpc) - 1;
  var rgbaData = new Uint8ClampedArray(pixels * 4);

  // For indexed color space, we only read 1 component per pixel (the index)
  var readComponents = (csType === 'Indexed') ? 1 : numComponents;

  // Calculate expected data length
  var bitsPerPixel = readComponents * bpc;
  var bytesPerRow = Math.ceil(width * bitsPerPixel / 8);
  // Some PDFs pad rows to byte boundaries

  // Read pixel data
  var bitPos = 0;
  for (var row = 0; row < height; row++) {
    // Each row may be byte-aligned
    var rowBitStart = row * bytesPerRow * 8;
    bitPos = rowBitStart;

    for (var col = 0; col < width; col++) {
      var components = [];
      for (var c = 0; c < readComponents; c++) {
        var byteIdx = Math.floor(bitPos / 8);
        var bitOffset = bitPos % 8;

        var val;
        if (bpc === 8) {
          val = byteIdx < data.length ? data[byteIdx] : 0;
          bitPos += 8;
        } else if (bpc === 1) {
          val = byteIdx < data.length ? ((data[byteIdx] >> (7 - bitOffset)) & 1) : 0;
          bitPos += 1;
        } else if (bpc === 2) {
          val = byteIdx < data.length ? ((data[byteIdx] >> (6 - bitOffset)) & 3) : 0;
          bitPos += 2;
        } else if (bpc === 4) {
          val = byteIdx < data.length ? ((data[byteIdx] >> (4 - bitOffset)) & 0xF) : 0;
          bitPos += 4;
        } else {
          val = byteIdx < data.length ? data[byteIdx] : 0;
          bitPos += bpc;
        }

        // Apply Decode mapping: value = Dmin + (val / maxVal) * (Dmax - Dmin)
        if (decode && csType !== 'Indexed') {
          var dmin = (c * 2 < decode.length && typeof decode[c * 2] === 'number') ? decode[c * 2] : 0;
          var dmax = (c * 2 + 1 < decode.length && typeof decode[c * 2 + 1] === 'number') ? decode[c * 2 + 1] : 1;
          val = dmin + (val / maxVal) * (dmax - dmin);
        } else if (csType !== 'Indexed') {
          // Normalize to 0..1
          val = val / maxVal;
        }

        components.push(val);
      }

      // Convert to RGBA
      var pixelOffset = (row * width + col) * 4;
      componentToRGBA(rgbaData, pixelOffset, components, colorSpace, doc);
    }
  }

  return rgbaData;
}

/**
 * Convert color components to RGBA values in the output array.
 */
function componentToRGBA(rgbaData, offset, components, colorSpace, doc) {
  var csType = colorSpace.type;
  var r, g, b;

  switch (csType) {
    case 'DeviceGray':
      var gray = clamp(components[0], 0, 1);
      r = g = b = Math.round(gray * 255);
      break;

    case 'DeviceRGB':
      r = Math.round(clamp(components[0] || 0, 0, 1) * 255);
      g = Math.round(clamp(components[1] || 0, 0, 1) * 255);
      b = Math.round(clamp(components[2] || 0, 0, 1) * 255);
      break;

    case 'DeviceCMYK':
      var c = clamp(components[0] || 0, 0, 1);
      var m = clamp(components[1] || 0, 0, 1);
      var y = clamp(components[2] || 0, 0, 1);
      var k = clamp(components[3] || 0, 0, 1);
      r = Math.round(255 * (1 - c) * (1 - k));
      g = Math.round(255 * (1 - m) * (1 - k));
      b = Math.round(255 * (1 - y) * (1 - k));
      break;

    case 'Indexed':
      var index = Math.round(components[0]);
      var lookup = colorSpace.lookup;
      var base = colorSpace.base || { type: 'DeviceRGB', numComponents: 3 };
      var hival = colorSpace.hival || 255;

      index = clamp(index, 0, hival);

      if (lookup && lookup instanceof Uint8Array) {
        var baseComponents = base.numComponents || 3;
        var lookupOffset = index * baseComponents;

        var lookupComps = [];
        for (var i = 0; i < baseComponents; i++) {
          var val = (lookupOffset + i < lookup.length) ? lookup[lookupOffset + i] : 0;
          lookupComps.push(val / 255);
        }

        // Recursively convert using the base color space
        componentToRGBA(rgbaData, offset, lookupComps, base, doc);
        return;
      } else if (typeof lookup === 'string') {
        // Lookup is a string of bytes
        var baseComp = base.numComponents || 3;
        var strOffset = index * baseComp;
        var strComps = [];
        for (var j = 0; j < baseComp; j++) {
          var charVal = j + strOffset < lookup.length ? lookup.charCodeAt(j + strOffset) : 0;
          strComps.push(charVal / 255);
        }
        componentToRGBA(rgbaData, offset, strComps, base, doc);
        return;
      } else {
        // No lookup - treat as gray
        r = g = b = Math.round((index / Math.max(hival, 1)) * 255);
      }
      break;

    case 'Separation':
    case 'DeviceN':
      // Fall back: treat the first component as gray
      // A proper implementation would evaluate the tint transform function
      var grayVal = clamp(components[0] || 0, 0, 1);
      r = g = b = Math.round((1 - grayVal) * 255); // Separation is subtractive
      break;

    default:
      // Unknown color space - treat as gray
      var fallback = clamp(components[0] || 0, 0, 1);
      r = g = b = Math.round(fallback * 255);
      break;
  }

  rgbaData[offset] = r;
  rgbaData[offset + 1] = g;
  rgbaData[offset + 2] = b;
  rgbaData[offset + 3] = 255; // Full opacity
}

// ============================================================================
// Color Space Resolution for Images
// ============================================================================

/**
 * Resolve image color space specification to a usable color space object.
 * Handles abbreviated names from inline images.
 */
function resolveImageColorSpace(csSpec, resources, doc) {
  if (!csSpec) return { type: 'DeviceGray', numComponents: 1 };

  // Handle string color space names (including abbreviated inline image names)
  if (typeof csSpec === 'string') {
    if (csSpec.charAt(0) === '/') csSpec = csSpec.substring(1);

    // Expand inline image abbreviations
    var expanded = expandColorSpaceName(csSpec);
    return _renderer.resolveColorSpace(expanded, resources, doc);
  }

  if (Array.isArray(csSpec)) {
    // Array form: [/name, ...params]
    var first = csSpec[0];
    if (typeof first === 'string' && first.charAt(0) === '/') {
      first = first.substring(1);
    }
    if (typeof first === 'object' && first && first.isRef && doc) {
      first = doc.resolveRef(first);
    }
    first = expandColorSpaceName(first);
    var newSpec = [first].concat(csSpec.slice(1));
    return _renderer.resolveColorSpace(newSpec, resources, doc);
  }

  if (typeof csSpec === 'object' && csSpec.isRef && doc) {
    csSpec = doc.resolveRef(csSpec);
    return resolveImageColorSpace(csSpec, resources, doc);
  }

  return _renderer.resolveColorSpace(csSpec, resources, doc);
}

/**
 * Expand abbreviated color space names from inline images.
 */
function expandColorSpaceName(name) {
  if (typeof name !== 'string') return name;
  var map = {
    'G': 'DeviceGray',
    'RGB': 'DeviceRGB',
    'CMYK': 'DeviceCMYK',
    'I': 'Indexed'
  };
  return map[name] || name;
}

// ============================================================================
// Drawing Utilities
// ============================================================================

/**
 * Draw RGBA pixel data onto the canvas context.
 * Images in PDF are drawn in a 1x1 unit square, with the CTM controlling
 * the actual size and position.
 *
 * IMPORTANT: ctx.putImageData() bypasses all canvas transforms and writes
 * directly to device pixels. We must instead paint the pixel data onto a
 * temporary canvas, then use ctx.drawImage() which IS affected by the
 * current transform (CTM). This ensures images are scaled and positioned
 * correctly by the CTM set via cm operators.
 */
function drawImageData(ctx, rgbaData, width, height, interpolate) {
  // Check if we have createImageData (browser or node-canvas)
  if (ctx.createImageData) {
    // Build the image on a temporary canvas so we can use drawImage
    // (drawImage respects the current transform; putImageData does not)
    var tmpCanvas = null;
    var tmpCtx = null;

    if (typeof document !== 'undefined' && document.createElement) {
      // Browser path
      tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = width;
      tmpCanvas.height = height;
      tmpCtx = tmpCanvas.getContext('2d');
    } else if (typeof ctx.canvas !== 'undefined' && ctx.canvas && ctx.canvas.constructor) {
      // Node.js canvas path (e.g., node-canvas or mock)
      try {
        tmpCanvas = new ctx.canvas.constructor(width, height);
        tmpCtx = tmpCanvas.getContext('2d');
      } catch (e) {
        tmpCanvas = null;
        tmpCtx = null;
      }
    }

    if (tmpCtx) {
      var imageData = tmpCtx.createImageData(width, height);
      imageData.data.set(rgbaData);
      tmpCtx.putImageData(imageData, 0, 0);

      // Draw onto the real context inside the 1x1 unit square.
      // PDF images occupy a 1x1 unit square with origin at bottom-left.
      // The image pixel data is stored top-to-bottom, so we flip Y.
      ctx.save();

      // Set image smoothing
      if ('imageSmoothingEnabled' in ctx) {
        ctx.imageSmoothingEnabled = !!interpolate;
      }

      // Map image: scale to 1x1 unit and flip vertically
      // scale(1/w, -1/h) followed by translate(0, -h) maps
      // the image's (0..w, 0..h) pixel rectangle into the (0..1, 0..1) unit square
      // with the correct bottom-left origin.
      ctx.scale(1 / width, -1 / height);
      ctx.translate(0, -height);
      ctx.drawImage(tmpCanvas, 0, 0);
      ctx.restore();
    } else {
      // Fallback: use putImageData directly (transforms will be ignored,
      // but this is better than not rendering at all; mainly for test mocks)
      var imgData = ctx.createImageData(width, height);
      imgData.data.set(rgbaData);
      ctx.save();
      ctx.scale(1 / width, -1 / height);
      ctx.translate(0, -height);
      ctx.putImageData(imgData, 0, 0);
      ctx.restore();
    }
  }
}

/**
 * Draw a gray placeholder rectangle for unsupported images.
 */
function drawPlaceholder(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgb(220,220,220)';
  ctx.fillRect(0, 0, 1, 1);
  ctx.restore();
}

// ============================================================================
// Utility Functions
// ============================================================================

function resolveValue(val, doc) {
  if (val && typeof val === 'object' && val.isRef && doc) {
    return doc.resolveRef(val);
  }
  return val;
}

function clamp(val, min, max) {
  if (val < min) return min;
  if (val > max) return max;
  return val;
}

/**
 * Normalize a filter name (or array of filter names) to a single string.
 * Returns the first filter name if chained.
 */
function normalizeFilterName(filter) {
  if (!filter) return null;
  if (Array.isArray(filter)) {
    filter = filter[0];
  }
  if (typeof filter === 'string') {
    if (filter.charAt(0) === '/') filter = filter.substring(1);
    // Expand abbreviations
    var map = {
      'AHx': 'ASCIIHexDecode', 'A85': 'ASCII85Decode',
      'LZW': 'LZWDecode', 'Fl': 'FlateDecode',
      'RL': 'RunLengthDecode', 'CCF': 'CCITTFaxDecode',
      'DCT': 'DCTDecode'
    };
    return map[filter] || filter;
  }
  return null;
}

/**
 * Parse a CSS color string like 'rgb(r,g,b)' to [r, g, b].
 */
function parseCSSColor(cssColor) {
  if (!cssColor || typeof cssColor !== 'string') return [0, 0, 0];

  var match = cssColor.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (match) {
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
  }

  return [0, 0, 0];
}

/**
 * Helper for sub-byte reading in bit streams.
 */
function readBits(data, byteIdx, bitsRemaining, bitBuffer, bpc) {
  var bitPos = byteIdx * 8 + (8 - bitsRemaining);
  var actualByteIdx = Math.floor(bitPos / 8);
  var actualBitOffset = bitPos % 8;

  if (bpc === 8) {
    return actualByteIdx < data.length ? data[actualByteIdx] : 0;
  }

  var val = 0;
  var bitsNeeded = bpc;
  while (bitsNeeded > 0 && actualByteIdx < data.length) {
    var available = 8 - actualBitOffset;
    var take = Math.min(bitsNeeded, available);
    var mask = ((1 << take) - 1) << (available - take);
    val = (val << take) | ((data[actualByteIdx] & mask) >> (available - take));
    bitsNeeded -= take;
    actualBitOffset += take;
    if (actualBitOffset >= 8) {
      actualByteIdx++;
      actualBitOffset = 0;
    }
  }

  return val;
}

function advanceBits(byteIdx, bitsRemaining, bpc) {
  var totalBits = byteIdx * 8 + (8 - bitsRemaining) + bpc;
  return [Math.floor(totalBits / 8), 8 - (totalBits % 8)];
}

// ============================================================================
// Exports
// ============================================================================

var PDFImages = {
  renderImageXObject: renderImageXObject,
  renderInlineImage: renderInlineImage,
  decodeImageData: decodeImageData,
  resolveImageColorSpace: resolveImageColorSpace,
  applySoftMask: applySoftMask,
  applyColorKeyMask: applyColorKeyMask,
  parseCSSColor: parseCSSColor,
  MAX_IMAGE_PIXELS: MAX_IMAGE_PIXELS,
  MAX_IMAGE_DIMENSION: MAX_IMAGE_DIMENSION
};

if (typeof window !== 'undefined') {
  window.PDFImages = PDFImages;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PDFImages;
}
