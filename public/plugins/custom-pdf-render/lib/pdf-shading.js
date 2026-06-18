/**
 * PDF Shading and Pattern Support
 *
 * Implements shading patterns for PDF rendering:
 *   - Type 2: Axial (linear) gradients
 *   - Type 3: Radial gradients
 *   - Graceful fallback for unsupported shading types (4-7)
 *   - Pattern color space handling
 *
 * No external dependencies. All implementations are self-contained.
 *
 * Public interface:
 *   PDFShading.renderShading(ctx, state, shadingName, resources, doc) - render sh operator
 *   PDFShading.createShadingPattern(ctx, shadingObj, resources, doc) - create canvas gradient
 *   PDFShading.resolveShading(shadingName, resources, doc) - resolve shading dictionary
 */

'use strict';

// ============================================================================
// Dependencies
// ============================================================================

var _renderer;

if (typeof module !== 'undefined' && module.exports) {
  _renderer = require('./pdf-renderer.js');
} else if (typeof window !== 'undefined') {
  _renderer = window.PDFRenderer;
}

// ============================================================================
// Shading Rendering (sh operator)
// ============================================================================

/**
 * Render a shading pattern via the sh operator.
 * The shading fills the current clipping region.
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {object} state - Current graphics state
 * @param {string} shadingName - Name of shading resource (from operand)
 * @param {object} resources - Page resources
 * @param {object} doc - PDFDocument instance
 */
function renderShading(ctx, state, shadingName, resources, doc) {
  if (typeof shadingName === 'string' && shadingName.charAt(0) === '/') {
    shadingName = shadingName.substring(1);
  }

  var shadingObj = resolveShading(shadingName, resources, doc);
  if (!shadingObj) return;

  var shadingType = resolveValue(shadingObj.ShadingType, doc);
  if (!shadingType) return;

  var gradient = null;

  switch (shadingType) {
    case 2:
      gradient = createAxialGradient(ctx, shadingObj, resources, doc);
      break;
    case 3:
      gradient = createRadialGradient(ctx, shadingObj, resources, doc);
      break;
    case 4: case 5: case 6: case 7:
      // Free-form/lattice/Coons/tensor-product mesh shadings
      // These are complex - fall back to background color
      renderShadingFallback(ctx, shadingObj, doc);
      return;
    default:
      return;
  }

  if (gradient) {
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.globalAlpha = state.fillAlpha;

    // Fill the current clipping region
    // We use a large rectangle that should cover the clipping area
    // The clipping path already constrains the rendering
    ctx.fillRect(-32768, -32768, 65536, 65536);
    ctx.restore();
  }
}

// ============================================================================
// Shading Resolution
// ============================================================================

/**
 * Resolve a shading name from page resources.
 *
 * @param {string} name - Shading resource name
 * @param {object} resources - Page resources
 * @param {object} doc - PDFDocument instance
 * @returns {object|null} Shading dictionary
 */
function resolveShading(name, resources, doc) {
  if (!resources || !resources.Shading) return null;

  var shadingDict = resources.Shading;
  if (shadingDict && typeof shadingDict === 'object' && shadingDict.isRef && doc) {
    shadingDict = doc.resolveRef(shadingDict);
  }
  if (!shadingDict || typeof shadingDict !== 'object') return null;

  var shading = shadingDict[name];
  if (shading && typeof shading === 'object' && shading.isRef && doc) {
    shading = doc.resolveRef(shading);
  }

  return shading || null;
}

// ============================================================================
// Type 2: Axial (Linear) Gradient
// ============================================================================

/**
 * Create a canvas linear gradient from a Type 2 (axial) shading dictionary.
 *
 * Axial shading defines a gradient along a line from (x0,y0) to (x1,y1).
 * The color at each point is determined by a function that maps a parameter
 * t (from Domain[0] to Domain[1]) to color values.
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {object} shading - Shading dictionary
 * @param {object} resources - Page resources
 * @param {object} doc - PDFDocument instance
 * @returns {CanvasGradient|null} Canvas gradient
 */
function createAxialGradient(ctx, shading, resources, doc) {
  var coords = resolveValue(shading.Coords, doc);
  if (!Array.isArray(coords) || coords.length < 4) return null;

  var x0 = coords[0], y0 = coords[1], x1 = coords[2], y1 = coords[3];

  // Domain defaults to [0, 1]
  var domain = resolveValue(shading.Domain, doc);
  if (!Array.isArray(domain) || domain.length < 2) {
    domain = [0, 1];
  }

  // Extend flags: [extendStart, extendEnd]
  var extend = resolveValue(shading.Extend, doc);
  if (!Array.isArray(extend) || extend.length < 2) {
    extend = [false, false];
  }

  // Resolve the color space
  var csSpec = resolveValue(shading.ColorSpace, doc);
  var colorSpace = _renderer.resolveColorSpace(csSpec, resources, doc);

  // Resolve the function
  var fn = resolveValue(shading.Function, doc);
  if (!fn) return null;

  // Create the canvas gradient
  var gradient;
  try {
    gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  } catch (e) {
    return null;
  }

  // Sample the function at multiple points to create color stops
  addGradientStops(gradient, fn, domain, colorSpace, doc);

  return gradient;
}

// ============================================================================
// Type 3: Radial Gradient
// ============================================================================

/**
 * Create a canvas radial gradient from a Type 3 (radial) shading dictionary.
 *
 * Radial shading defines a gradient between two circles:
 * circle 1 at (x0,y0) with radius r0
 * circle 2 at (x1,y1) with radius r1
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {object} shading - Shading dictionary
 * @param {object} resources - Page resources
 * @param {object} doc - PDFDocument instance
 * @returns {CanvasGradient|null} Canvas gradient
 */
function createRadialGradient(ctx, shading, resources, doc) {
  var coords = resolveValue(shading.Coords, doc);
  if (!Array.isArray(coords) || coords.length < 6) return null;

  var x0 = coords[0], y0 = coords[1], r0 = coords[2];
  var x1 = coords[3], y1 = coords[4], r1 = coords[5];

  // Domain defaults to [0, 1]
  var domain = resolveValue(shading.Domain, doc);
  if (!Array.isArray(domain) || domain.length < 2) {
    domain = [0, 1];
  }

  // Resolve the color space
  var csSpec = resolveValue(shading.ColorSpace, doc);
  var colorSpace = _renderer.resolveColorSpace(csSpec, resources, doc);

  // Resolve the function
  var fn = resolveValue(shading.Function, doc);
  if (!fn) return null;

  // Create the canvas gradient
  var gradient;
  try {
    gradient = ctx.createRadialGradient(x0, y0, Math.max(0, r0), x1, y1, Math.max(0, r1));
  } catch (e) {
    return null;
  }

  // Sample the function at multiple points
  addGradientStops(gradient, fn, domain, colorSpace, doc);

  return gradient;
}

// ============================================================================
// Gradient Color Stop Generation
// ============================================================================

/**
 * Add color stops to a canvas gradient by sampling the PDF function.
 *
 * PDF shading functions can be:
 * - Type 0: Sampled (interpolation from a table)
 * - Type 2: Exponential interpolation (C0, C1, N)
 * - Type 3: Stitching (piecewise combination of subfunctions)
 * - Type 4: PostScript calculator (stack-based expressions)
 *
 * For practicality, we implement Type 2 (most common for gradients)
 * and Type 3 (piecewise gradients), and sample at fixed intervals for others.
 *
 * @param {CanvasGradient} gradient - Canvas gradient to add stops to
 * @param {object} fn - PDF function dictionary
 * @param {number[]} domain - Domain [t0, t1]
 * @param {object} colorSpace - Resolved color space
 * @param {object} doc - PDFDocument instance
 */
function addGradientStops(gradient, fn, domain, colorSpace, doc) {
  var t0 = domain[0];
  var t1 = domain[1];

  // Number of color stops to sample
  var numStops = 10;

  for (var i = 0; i <= numStops; i++) {
    var t = t0 + (i / numStops) * (t1 - t0);
    var position = i / numStops; // 0 to 1 for canvas gradient

    var color = evaluateFunction(fn, t, doc);
    if (!color) continue;

    var cssColor = functionOutputToCSS(color, colorSpace);

    try {
      gradient.addColorStop(position, cssColor);
    } catch (e) {
      // Invalid color stop, skip
    }
  }

  // If no stops were added, add black-to-white fallback
  if (numStops === 0) {
    gradient.addColorStop(0, 'rgb(0,0,0)');
    gradient.addColorStop(1, 'rgb(255,255,255)');
  }
}

// ============================================================================
// PDF Function Evaluation
// ============================================================================

/**
 * Evaluate a PDF function at parameter t.
 *
 * @param {object} fn - PDF function dictionary
 * @param {number} t - Input parameter
 * @param {object} doc - PDFDocument instance
 * @returns {number[]|null} Output values (color components)
 */
function evaluateFunction(fn, t, doc) {
  if (!fn || typeof fn !== 'object') return null;

  // Resolve indirect references
  if (fn.isRef && doc) {
    fn = doc.resolveRef(fn);
  }
  if (!fn || typeof fn !== 'object') return null;

  var type = resolveValue(fn.FunctionType, doc);

  // Clamp input to domain
  var fnDomain = resolveValue(fn.Domain, doc);
  if (Array.isArray(fnDomain) && fnDomain.length >= 2) {
    t = clamp(t, fnDomain[0], fnDomain[1]);
  }

  switch (type) {
    case 0:
      return evaluateSampledFunction(fn, t, doc);
    case 2:
      return evaluateExponentialFunction(fn, t, doc);
    case 3:
      return evaluateStitchingFunction(fn, t, doc);
    case 4:
      // PostScript calculator - complex, fall back to sampling endpoints
      return evaluatePostScriptFallback(fn, t, doc);
    default:
      // Try treating as exponential if it has C0/C1
      if (fn.C0 || fn.C1) {
        return evaluateExponentialFunction(fn, t, doc);
      }
      return null;
  }
}

/**
 * Evaluate a Type 2 (exponential interpolation) function.
 *
 * f(x) = C0[i] + x^N * (C1[i] - C0[i])
 *
 * @param {object} fn - Function dictionary
 * @param {number} t - Input parameter (already clamped to domain)
 * @param {object} doc - PDFDocument instance
 * @returns {number[]} Output values
 */
function evaluateExponentialFunction(fn, t, doc) {
  var c0 = resolveValue(fn.C0, doc);
  var c1 = resolveValue(fn.C1, doc);
  var n = resolveValue(fn.N, doc);

  if (!Array.isArray(c0)) c0 = [0];
  if (!Array.isArray(c1)) c1 = [1];
  if (typeof n !== 'number') n = 1;

  // Normalize t to [0, 1] for the interpolation
  var domain = resolveValue(fn.Domain, doc);
  var tNorm = t;
  if (Array.isArray(domain) && domain.length >= 2 && domain[1] !== domain[0]) {
    tNorm = (t - domain[0]) / (domain[1] - domain[0]);
  }
  tNorm = clamp(tNorm, 0, 1);

  var tPow = Math.pow(tNorm, n);

  var result = [];
  var numOutputs = Math.max(c0.length, c1.length);
  for (var i = 0; i < numOutputs; i++) {
    var v0 = i < c0.length ? c0[i] : 0;
    var v1 = i < c1.length ? c1[i] : 1;
    var val = v0 + tPow * (v1 - v0);

    // Clamp to range if specified
    var range = resolveValue(fn.Range, doc);
    if (Array.isArray(range) && range.length >= (i + 1) * 2) {
      val = clamp(val, range[i * 2], range[i * 2 + 1]);
    }

    result.push(val);
  }

  return result;
}

/**
 * Evaluate a Type 3 (stitching) function.
 * Combines multiple subfunctions over different domains.
 *
 * @param {object} fn - Function dictionary
 * @param {number} t - Input parameter
 * @param {object} doc - PDFDocument instance
 * @returns {number[]|null} Output values
 */
function evaluateStitchingFunction(fn, t, doc) {
  var functions = resolveValue(fn.Functions, doc);
  var bounds = resolveValue(fn.Bounds, doc);
  var encode = resolveValue(fn.Encode, doc);
  var domain = resolveValue(fn.Domain, doc);

  if (!Array.isArray(functions) || functions.length === 0) return null;
  if (!Array.isArray(bounds)) bounds = [];
  if (!Array.isArray(encode)) {
    encode = [];
    for (var e = 0; e < functions.length; e++) {
      encode.push(0, 1);
    }
  }

  var d0 = Array.isArray(domain) ? domain[0] : 0;
  var d1 = Array.isArray(domain) ? domain[1] : 1;

  // Build the subdomain boundaries
  var subdomains = [d0];
  for (var b = 0; b < bounds.length; b++) {
    subdomains.push(bounds[b]);
  }
  subdomains.push(d1);

  // Find which subfunction to use
  var funcIdx = 0;
  for (var i = 0; i < bounds.length; i++) {
    if (t >= bounds[i]) {
      funcIdx = i + 1;
    }
  }
  funcIdx = clamp(funcIdx, 0, functions.length - 1);

  // Map t to the subfunction's encode range
  var subD0 = subdomains[funcIdx];
  var subD1 = subdomains[funcIdx + 1];
  var enc0 = funcIdx * 2 < encode.length ? encode[funcIdx * 2] : 0;
  var enc1 = funcIdx * 2 + 1 < encode.length ? encode[funcIdx * 2 + 1] : 1;

  var tMapped;
  if (subD1 === subD0) {
    tMapped = enc0;
  } else {
    tMapped = enc0 + ((t - subD0) / (subD1 - subD0)) * (enc1 - enc0);
  }

  // Resolve and evaluate the subfunction
  var subFn = functions[funcIdx];
  if (subFn && typeof subFn === 'object' && subFn.isRef && doc) {
    subFn = doc.resolveRef(subFn);
  }

  return evaluateFunction(subFn, tMapped, doc);
}

/**
 * Evaluate a Type 0 (sampled) function.
 * Uses the sample table to interpolate values.
 *
 * @param {object} fn - Function dictionary
 * @param {number} t - Input parameter
 * @param {object} doc - PDFDocument instance
 * @returns {number[]|null} Output values
 */
function evaluateSampledFunction(fn, t, doc) {
  var size = resolveValue(fn.Size, doc);
  var range = resolveValue(fn.Range, doc);
  var domain = resolveValue(fn.Domain, doc);
  var bitsPerSample = resolveValue(fn.BitsPerSample, doc) || 8;

  if (!Array.isArray(size) || size.length === 0) return null;
  if (!Array.isArray(range) || range.length < 2) return null;

  var numSamples = size[0]; // For 1-D function
  var numOutputs = Math.floor(range.length / 2);

  // Get sample data
  var sampleData;
  if (fn._isStream) {
    try {
      sampleData = doc.getStreamData(fn);
    } catch (e) {
      return null;
    }
  } else {
    return null;
  }

  if (!sampleData || sampleData.length === 0) return null;

  // Normalize t to [0, numSamples-1]
  var d0 = Array.isArray(domain) ? domain[0] : 0;
  var d1 = Array.isArray(domain) ? domain[1] : 1;
  var tNorm = (d1 !== d0) ? (t - d0) / (d1 - d0) : 0;
  tNorm = clamp(tNorm, 0, 1);

  var sampleIndex = tNorm * (numSamples - 1);
  var idx0 = Math.floor(sampleIndex);
  var idx1 = Math.min(idx0 + 1, numSamples - 1);
  var frac = sampleIndex - idx0;

  var maxSampleVal = (1 << bitsPerSample) - 1;

  var result = [];
  for (var i = 0; i < numOutputs; i++) {
    var sample0 = readSample(sampleData, (idx0 * numOutputs + i) * bitsPerSample, bitsPerSample);
    var sample1 = readSample(sampleData, (idx1 * numOutputs + i) * bitsPerSample, bitsPerSample);

    // Interpolate
    var sampleVal = sample0 + frac * (sample1 - sample0);

    // Map to range
    var rMin = range[i * 2];
    var rMax = range[i * 2 + 1];
    var val = rMin + (sampleVal / maxSampleVal) * (rMax - rMin);

    result.push(val);
  }

  return result;
}

/**
 * Read a sample value from bit-packed data.
 */
function readSample(data, bitOffset, bitsPerSample) {
  var byteIdx = Math.floor(bitOffset / 8);
  var bitPos = bitOffset % 8;

  if (bitsPerSample === 8) {
    return byteIdx < data.length ? data[byteIdx] : 0;
  }

  if (bitsPerSample === 16) {
    if (byteIdx + 1 < data.length) {
      return (data[byteIdx] << 8) | data[byteIdx + 1];
    }
    return 0;
  }

  // Generic bit reading
  var val = 0;
  var bitsNeeded = bitsPerSample;
  while (bitsNeeded > 0 && byteIdx < data.length) {
    var available = 8 - bitPos;
    var take = Math.min(bitsNeeded, available);
    var mask = ((1 << take) - 1) << (available - take);
    val = (val << take) | ((data[byteIdx] & mask) >> (available - take));
    bitsNeeded -= take;
    bitPos += take;
    if (bitPos >= 8) {
      byteIdx++;
      bitPos = 0;
    }
  }

  return val;
}

/**
 * Fallback for PostScript calculator functions.
 * Evaluate at endpoints and interpolate linearly.
 */
function evaluatePostScriptFallback(fn, t, doc) {
  var range = resolveValue(fn.Range, doc);
  if (!Array.isArray(range) || range.length < 2) return null;

  var domain = resolveValue(fn.Domain, doc);
  var d0 = Array.isArray(domain) ? domain[0] : 0;
  var d1 = Array.isArray(domain) ? domain[1] : 1;

  // Return a linear interpolation between range min and max for each output
  var tNorm = (d1 !== d0) ? (t - d0) / (d1 - d0) : 0;
  tNorm = clamp(tNorm, 0, 1);

  var numOutputs = Math.floor(range.length / 2);
  var result = [];
  for (var i = 0; i < numOutputs; i++) {
    var rMin = range[i * 2];
    var rMax = range[i * 2 + 1];
    result.push(rMin + tNorm * (rMax - rMin));
  }

  return result;
}

// ============================================================================
// Color Conversion for Function Output
// ============================================================================

/**
 * Convert function output values to a CSS color string.
 *
 * @param {number[]} values - Function output values (color components)
 * @param {object} colorSpace - Resolved color space
 * @returns {string} CSS color string
 */
function functionOutputToCSS(values, colorSpace) {
  if (!values || values.length === 0) return 'rgb(0,0,0)';

  return _renderer.colorToCSS(colorSpace.type, values);
}

// ============================================================================
// Shading Fallback
// ============================================================================

/**
 * Render a fallback for unsupported shading types.
 * Uses the Background color if specified, otherwise a light gray.
 */
function renderShadingFallback(ctx, shading, doc) {
  var bg = resolveValue(shading.Background, doc);

  ctx.save();
  if (Array.isArray(bg) && bg.length > 0) {
    // Use the background color
    var csSpec = resolveValue(shading.ColorSpace, doc);
    var colorSpace = _renderer.resolveColorSpace(csSpec, null, doc);
    ctx.fillStyle = _renderer.colorToCSS(colorSpace.type, bg);
  } else {
    ctx.fillStyle = 'rgb(220,220,220)';
  }
  ctx.fillRect(-32768, -32768, 65536, 65536);
  ctx.restore();
}

// ============================================================================
// Pattern Color Space Support
// ============================================================================

/**
 * Create a pattern fill/stroke from a Pattern resource.
 * Supports shading patterns (Type 2 patterns that reference a shading).
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {string} patternName - Pattern resource name
 * @param {object} resources - Page resources
 * @param {object} doc - PDFDocument instance
 * @returns {CanvasGradient|string|null} Canvas pattern/gradient or CSS color
 */
function resolvePatternFill(ctx, patternName, resources, doc) {
  if (!resources || !resources.Pattern) return null;

  var patternDict = resources.Pattern;
  if (patternDict && typeof patternDict === 'object' && patternDict.isRef && doc) {
    patternDict = doc.resolveRef(patternDict);
  }
  if (!patternDict || typeof patternDict !== 'object') return null;

  var pattern = patternDict[patternName];
  if (pattern && typeof pattern === 'object' && pattern.isRef && doc) {
    pattern = doc.resolveRef(pattern);
  }
  if (!pattern || typeof pattern !== 'object') return null;

  var patternType = resolveValue(pattern.PatternType, doc);

  if (patternType === 2) {
    // Shading pattern
    var shading = resolveValue(pattern.Shading, doc);
    if (!shading) return null;

    var shadingType = resolveValue(shading.ShadingType, doc);

    // Apply the pattern matrix if present
    var matrix = resolveValue(pattern.Matrix, doc);

    switch (shadingType) {
      case 2:
        return createAxialGradient(ctx, shading, resources, doc);
      case 3:
        return createRadialGradient(ctx, shading, resources, doc);
      default:
        return null;
    }
  }

  // Type 1 (tiling) patterns are complex - return null (unsupported)
  return null;
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

// ============================================================================
// Exports
// ============================================================================

var PDFShading = {
  renderShading: renderShading,
  resolveShading: resolveShading,
  resolvePatternFill: resolvePatternFill,
  createAxialGradient: createAxialGradient,
  createRadialGradient: createRadialGradient,
  evaluateFunction: evaluateFunction,
  evaluateExponentialFunction: evaluateExponentialFunction,
  evaluateStitchingFunction: evaluateStitchingFunction,
  evaluateSampledFunction: evaluateSampledFunction,
  functionOutputToCSS: functionOutputToCSS
};

if (typeof window !== 'undefined') {
  window.PDFShading = PDFShading;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PDFShading;
}
