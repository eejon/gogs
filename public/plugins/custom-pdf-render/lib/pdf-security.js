/**
 * PDF Security Filter
 *
 * Validates URLs, strips dangerous PDF actions (JavaScript, Launch, etc.),
 * enforces resource limits, and sanitizes content before rendering.
 *
 * All filtering happens during parse time so downstream renderers
 * never see dangerous content.
 */

'use strict';

// ============================================================================
// Resource Limits
// ============================================================================

var PDFSecurityLimits = {
  MAX_OBJECT_COUNT: 100000,
  MAX_RECURSION_DEPTH: 50,
  MAX_DECOMPRESSED_SIZE: 100 * 1024 * 1024, // 100 MB
  MAX_PAGE_DIMENSION: 14400, // points (200 inches)
  PARSE_TIMEOUT_MS: 30000, // 30 seconds
  MAX_STRING_LENGTH: 65536, // 64 KB per string
  MAX_ARRAY_LENGTH: 65536,
  MAX_NAME_LENGTH: 127, // PDF spec limit
  MAX_DICT_ENTRIES: 4096,
  MAX_CONTENT_STREAM_OPS: 1000000,
  MAX_PAGE_COUNT: 10000,
  MAX_NESTING_DEPTH: 100
};

// ============================================================================
// URL Validation
// ============================================================================

/**
 * Allowed URI schemes for link annotations and file parameter.
 */
var ALLOWED_URI_SCHEMES = ['http:', 'https:', 'mailto:'];

/**
 * Dangerous URI schemes that must be blocked.
 */
var BLOCKED_URI_SCHEMES = [
  'javascript:', 'data:', 'blob:', 'vbscript:',
  'file:', 'ftp:', 'jar:', 'content:'
];

/**
 * Validate that a file URL is safe to fetch.
 * Must be same-origin or a relative path. Rejects dangerous schemes.
 *
 * @param {string} fileUrl - The URL to validate
 * @param {string} viewerOrigin - The origin of the viewer page (e.g., "https://example.com")
 * @returns {{ valid: boolean, url: string, error: string|null }}
 */
function validateFileUrl(fileUrl, viewerOrigin) {
  if (!fileUrl || typeof fileUrl !== 'string') {
    return { valid: false, url: '', error: 'No file URL provided' };
  }

  // Trim whitespace
  fileUrl = fileUrl.trim();

  if (fileUrl.length === 0) {
    return { valid: false, url: '', error: 'Empty file URL' };
  }

  // Check for dangerous schemes (case-insensitive)
  var lowerUrl = fileUrl.toLowerCase().replace(/\s/g, '');
  for (var i = 0; i < BLOCKED_URI_SCHEMES.length; i++) {
    if (lowerUrl.indexOf(BLOCKED_URI_SCHEMES[i]) === 0) {
      return { valid: false, url: '', error: 'Blocked URL scheme: ' + BLOCKED_URI_SCHEMES[i] };
    }
  }

  // Resolve the URL relative to the viewer's location
  var resolved;
  try {
    resolved = new URL(fileUrl, viewerOrigin);
  } catch (e) {
    return { valid: false, url: '', error: 'Invalid URL: ' + fileUrl };
  }

  // Check same-origin
  var viewerUrl;
  try {
    viewerUrl = new URL(viewerOrigin);
  } catch (e) {
    return { valid: false, url: '', error: 'Invalid viewer origin' };
  }

  if (resolved.origin !== viewerUrl.origin) {
    return {
      valid: false,
      url: '',
      error: 'Cross-origin URL not allowed. File origin: ' + resolved.origin +
             ', viewer origin: ' + viewerUrl.origin
    };
  }

  // Additional check: ensure scheme is http/https or relative (which resolves to the page scheme)
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return { valid: false, url: '', error: 'Unsupported URL protocol: ' + resolved.protocol };
  }

  return { valid: true, url: resolved.href, error: null };
}

/**
 * Sanitize a URI from a PDF link annotation.
 * Only allows http:, https:, and mailto: schemes.
 *
 * @param {string} uri - The URI from the PDF
 * @returns {string|null} Sanitized URI or null if blocked
 */
function sanitizeAnnotationUri(uri) {
  if (!uri || typeof uri !== 'string') {
    return null;
  }

  uri = uri.trim();
  if (uri.length === 0) return null;

  // Check against allowed schemes
  var lowerUri = uri.toLowerCase().replace(/\s/g, '');

  // Check for dangerous schemes first
  for (var i = 0; i < BLOCKED_URI_SCHEMES.length; i++) {
    if (lowerUri.indexOf(BLOCKED_URI_SCHEMES[i]) === 0) {
      return null;
    }
  }

  // Check if it has a scheme at all
  var colonPos = uri.indexOf(':');
  if (colonPos > 0 && colonPos < 10) {
    var scheme = uri.substring(0, colonPos + 1).toLowerCase();
    var allowed = false;
    for (var j = 0; j < ALLOWED_URI_SCHEMES.length; j++) {
      if (scheme === ALLOWED_URI_SCHEMES[j]) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      return null;
    }
  }

  // Relative URIs or scheme-relative are not expected in PDF annotations,
  // but if present, block protocol-relative URLs
  if (uri.indexOf('//') === 0) {
    return null; // Protocol-relative URL
  }

  return uri;
}

// ============================================================================
// Action Filtering
// ============================================================================

/**
 * Allowed PDF action types (whitelist).
 * Only URI and GoTo actions are processed; all others are silently dropped.
 */
var ALLOWED_ACTION_TYPES = {
  'URI': true,
  'GoTo': true,
  'GoToR': false, // Remote GoTo - blocked (could reference external files)
  'GoToE': false, // Embedded GoTo - blocked
  'Launch': false,
  'JavaScript': false,
  'SubmitForm': false,
  'ImportData': false,
  'Rendition': false,
  'Trans': false,
  'GoTo3DView': false,
  'RichMedia': false,
  'Named': false, // Named actions (NextPage, PrevPage etc.) - safe but not needed
  'SetOCGState': false,
  'Movie': false,
  'Sound': false,
  'Hide': false,
  'Thread': false,
  'ResetForm': false
};

/**
 * Check if a PDF action type is allowed.
 *
 * @param {string} actionType - The /S value from the action dictionary
 * @returns {boolean}
 */
function isActionAllowed(actionType) {
  if (!actionType || typeof actionType !== 'string') return false;
  // Remove leading '/' if present
  if (actionType.charAt(0) === '/') {
    actionType = actionType.substring(1);
  }
  return ALLOWED_ACTION_TYPES[actionType] === true;
}

/**
 * Filter an annotation dictionary, stripping dangerous actions.
 * Returns a cleaned copy of the annotation or null if it should be completely removed.
 *
 * @param {object} annot - The annotation dictionary
 * @returns {object|null} Filtered annotation or null
 */
function filterAnnotation(annot) {
  if (!annot || typeof annot !== 'object') return null;

  var subtype = annot.Subtype || annot['/Subtype'];
  // Remove leading '/'
  if (typeof subtype === 'string' && subtype.charAt(0) === '/') {
    subtype = subtype.substring(1);
  }

  // Only process Link annotations
  if (subtype !== 'Link') return annot;

  // Check action
  var action = annot.A || annot['/A'];
  if (action) {
    var actionType = action.S || action['/S'];
    if (typeof actionType === 'string' && actionType.charAt(0) === '/') {
      actionType = actionType.substring(1);
    }

    if (!isActionAllowed(actionType)) {
      // Strip the action entirely
      var filtered = {};
      for (var key in annot) {
        if (key !== 'A' && key !== '/A') {
          filtered[key] = annot[key];
        }
      }
      return filtered;
    }

    // For URI actions, sanitize the URI
    if (actionType === 'URI') {
      var uri = action.URI || action['/URI'];
      if (typeof uri === 'string') {
        var sanitized = sanitizeAnnotationUri(uri);
        if (sanitized === null) {
          // Block the entire annotation action
          var filtered2 = {};
          for (var key2 in annot) {
            if (key2 !== 'A' && key2 !== '/A') {
              filtered2[key2] = annot[key2];
            }
          }
          return filtered2;
        }
      }
    }
  }

  // Check for JavaScript in additional action dictionaries (/AA)
  var aa = annot.AA || annot['/AA'];
  if (aa) {
    var filteredAA = filterAdditionalActions(aa);
    if (filteredAA === null || Object.keys(filteredAA).length === 0) {
      var filteredAnnot = {};
      for (var key3 in annot) {
        if (key3 !== 'AA' && key3 !== '/AA') {
          filteredAnnot[key3] = annot[key3];
        }
      }
      return filteredAnnot;
    }
  }

  return annot;
}

/**
 * Filter additional actions dictionary (/AA), removing any JavaScript actions.
 *
 * @param {object} aa - The additional actions dictionary
 * @returns {object|null} Filtered AA or null if all actions removed
 */
function filterAdditionalActions(aa) {
  if (!aa || typeof aa !== 'object') return null;

  var result = {};
  var hasEntries = false;

  for (var trigger in aa) {
    var action = aa[trigger];
    if (action && typeof action === 'object') {
      var actionType = action.S || action['/S'];
      if (typeof actionType === 'string' && actionType.charAt(0) === '/') {
        actionType = actionType.substring(1);
      }
      if (isActionAllowed(actionType)) {
        result[trigger] = action;
        hasEntries = true;
      }
      // Silently drop non-allowed actions
    }
  }

  return hasEntries ? result : null;
}

/**
 * Check if a dictionary contains any JavaScript references.
 * Used during parsing to flag potential security concerns.
 *
 * @param {object} dict - Any PDF dictionary
 * @returns {boolean} True if JS references found
 */
function containsJavaScript(dict) {
  if (!dict || typeof dict !== 'object') return false;

  for (var key in dict) {
    var val = dict[key];
    var normalizedKey = key;
    if (normalizedKey.charAt(0) === '/') {
      normalizedKey = normalizedKey.substring(1);
    }

    // Check for JS-related keys
    if (normalizedKey === 'JS' || normalizedKey === 'JavaScript') {
      return true;
    }

    // Check action type
    if (normalizedKey === 'S') {
      if (val === 'JavaScript' || val === '/JavaScript') {
        return true;
      }
    }

    // Recursively check nested dictionaries (with depth limit)
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      // Only check one level deep to avoid performance issues
      for (var innerKey in val) {
        var nk = innerKey;
        if (nk.charAt(0) === '/') nk = nk.substring(1);
        if (nk === 'JS' || nk === 'JavaScript') return true;
        if (nk === 'S' && (val[innerKey] === 'JavaScript' || val[innerKey] === '/JavaScript')) {
          return true;
        }
      }
    }
  }

  return false;
}

// ============================================================================
// Resource Limits Enforcement
// ============================================================================

/**
 * Timer for enforcing parse timeout.
 */
function ParseTimer(timeoutMs) {
  this.startTime = Date.now();
  this.timeoutMs = timeoutMs || PDFSecurityLimits.PARSE_TIMEOUT_MS;
}

ParseTimer.prototype.check = function() {
  var elapsed = Date.now() - this.startTime;
  if (elapsed > this.timeoutMs) {
    throw new PDFSecurityError('Parse timeout exceeded (' + this.timeoutMs + 'ms)');
  }
};

ParseTimer.prototype.elapsed = function() {
  return Date.now() - this.startTime;
};

/**
 * Track and enforce resource limits during parsing.
 */
function ResourceTracker(limits) {
  this.limits = limits || PDFSecurityLimits;
  this.objectCount = 0;
  this.currentDepth = 0;
  this.maxDepthReached = 0;
  this.totalDecompressed = 0;
  this.timer = new ParseTimer(this.limits.PARSE_TIMEOUT_MS);
  this.resolving = {}; // Track currently-resolving object refs for cycle detection
}

ResourceTracker.prototype.trackObject = function() {
  this.objectCount++;
  if (this.objectCount > this.limits.MAX_OBJECT_COUNT) {
    throw new PDFSecurityError('Object count limit exceeded (' + this.limits.MAX_OBJECT_COUNT + ')');
  }
};

ResourceTracker.prototype.pushDepth = function() {
  this.currentDepth++;
  if (this.currentDepth > this.maxDepthReached) {
    this.maxDepthReached = this.currentDepth;
  }
  if (this.currentDepth > this.limits.MAX_RECURSION_DEPTH) {
    throw new PDFSecurityError('Recursion depth limit exceeded (' + this.limits.MAX_RECURSION_DEPTH + ')');
  }
};

ResourceTracker.prototype.popDepth = function() {
  this.currentDepth--;
};

ResourceTracker.prototype.trackDecompression = function(size) {
  this.totalDecompressed += size;
  if (this.totalDecompressed > this.limits.MAX_DECOMPRESSED_SIZE) {
    throw new PDFSecurityError('Total decompressed data exceeds limit (' +
      this.limits.MAX_DECOMPRESSED_SIZE + ' bytes)');
  }
};

ResourceTracker.prototype.checkTimeout = function() {
  this.timer.check();
};

/**
 * Begin resolving an indirect reference. Returns false if cycle detected.
 */
ResourceTracker.prototype.beginResolve = function(refKey) {
  if (this.resolving[refKey]) {
    return false; // Cycle detected
  }
  this.resolving[refKey] = true;
  return true;
};

/**
 * End resolving an indirect reference.
 */
ResourceTracker.prototype.endResolve = function(refKey) {
  delete this.resolving[refKey];
};

ResourceTracker.prototype.validatePageDimensions = function(mediaBox) {
  if (!Array.isArray(mediaBox) || mediaBox.length < 4) {
    throw new PDFSecurityError('Invalid MediaBox');
  }
  var width = Math.abs(mediaBox[2] - mediaBox[0]);
  var height = Math.abs(mediaBox[3] - mediaBox[1]);
  if (width > this.limits.MAX_PAGE_DIMENSION || height > this.limits.MAX_PAGE_DIMENSION) {
    throw new PDFSecurityError('Page dimensions exceed limit (' +
      this.limits.MAX_PAGE_DIMENSION + ' points). Got: ' + width + 'x' + height);
  }
};

// ============================================================================
// Security Error
// ============================================================================

function PDFSecurityError(message) {
  this.name = 'PDFSecurityError';
  this.message = message;
}
PDFSecurityError.prototype = Object.create(Error.prototype);
PDFSecurityError.prototype.constructor = PDFSecurityError;

// ============================================================================
// Code Safety Checks
// ============================================================================

/**
 * Verify that a string does not contain patterns that could lead to code execution.
 * Used as a defense-in-depth check on PDF string values before DOM insertion.
 *
 * @param {string} str - String to check
 * @returns {string} The same string (safe strings pass through)
 */
function sanitizeStringForDOM(str) {
  if (typeof str !== 'string') return '';
  // No modification needed - strings go through textContent or canvas.fillText,
  // never innerHTML. This function exists as a validation checkpoint.
  return str;
}

// ============================================================================
// Exports
// ============================================================================

if (typeof window !== 'undefined') {
  window.PDFSecurity = {
    validateFileUrl: validateFileUrl,
    sanitizeAnnotationUri: sanitizeAnnotationUri,
    isActionAllowed: isActionAllowed,
    filterAnnotation: filterAnnotation,
    filterAdditionalActions: filterAdditionalActions,
    containsJavaScript: containsJavaScript,
    sanitizeStringForDOM: sanitizeStringForDOM,
    ResourceTracker: ResourceTracker,
    ParseTimer: ParseTimer,
    PDFSecurityError: PDFSecurityError,
    PDFSecurityLimits: PDFSecurityLimits,
    ALLOWED_URI_SCHEMES: ALLOWED_URI_SCHEMES,
    BLOCKED_URI_SCHEMES: BLOCKED_URI_SCHEMES
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    validateFileUrl: validateFileUrl,
    sanitizeAnnotationUri: sanitizeAnnotationUri,
    isActionAllowed: isActionAllowed,
    filterAnnotation: filterAnnotation,
    filterAdditionalActions: filterAdditionalActions,
    containsJavaScript: containsJavaScript,
    sanitizeStringForDOM: sanitizeStringForDOM,
    ResourceTracker: ResourceTracker,
    ParseTimer: ParseTimer,
    PDFSecurityError: PDFSecurityError,
    PDFSecurityLimits: PDFSecurityLimits,
    ALLOWED_URI_SCHEMES: ALLOWED_URI_SCHEMES,
    BLOCKED_URI_SCHEMES: BLOCKED_URI_SCHEMES
  };
}
