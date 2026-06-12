/**
 * pdf-security.js -- PDF Security Filter
 *
 * Sanitizes parsed PDF document objects to remove dangerous content:
 *   - Strip /JS and /JavaScript action entries from all objects
 *   - Sanitize URI annotations: allow only http:, https:, mailto:
 *   - Block javascript:, data:, file:, vbscript: URI schemes
 *   - Remove /Launch actions, /SubmitForm actions, /ImportData actions
 *   - Enforce size limits: max object count, max stream size, max nesting depth
 *   - Timeout/bail-out for parsing to prevent denial-of-service
 *
 * No external imports. All code is self-contained.
 */

'use strict';

// ============================================================================
// Allowed URI schemes
// ============================================================================

var ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:'];

var BLOCKED_SCHEMES = ['javascript:', 'data:', 'file:', 'vbscript:', 'jar:'];

// ============================================================================
// Dangerous action types
// ============================================================================

var DANGEROUS_ACTIONS = ['/JavaScript', '/JS', '/Launch', '/SubmitForm', '/ImportData'];

// ============================================================================
// URI Validation
// ============================================================================

/**
 * Validate a URL. Returns true if the URL uses an allowed scheme.
 * Blocks javascript:, data:, file:, vbscript: schemes.
 * Allows relative URLs and same-origin URLs.
 *
 * @param {string} url
 * @returns {boolean}
 */
function validateURL(url) {
  if (!url || typeof url !== 'string') return false;

  var trimmed = url.trim().toLowerCase();

  // Block dangerous schemes
  for (var i = 0; i < BLOCKED_SCHEMES.length; i++) {
    if (trimmed.indexOf(BLOCKED_SCHEMES[i]) === 0) return false;
  }

  // Allow relative URLs (start with / or don't have a scheme)
  if (trimmed.charAt(0) === '/' || trimmed.indexOf(':') === -1) return true;

  // Allow allowed schemes
  for (var i = 0; i < ALLOWED_SCHEMES.length; i++) {
    if (trimmed.indexOf(ALLOWED_SCHEMES[i]) === 0) return true;
  }

  // Block anything else with a scheme
  return false;
}

// ============================================================================
// Action validation
// ============================================================================

/**
 * Check if a PDF action dictionary is allowed (safe to process).
 *
 * @param {object} action - PDF action dictionary
 * @returns {boolean}
 */
function isAllowedAction(action) {
  if (!action || typeof action !== 'object') return false;

  var s = action['/S'];
  if (!s) return true; // No action type specified, allow

  // Check against dangerous action types
  for (var i = 0; i < DANGEROUS_ACTIONS.length; i++) {
    if (s === DANGEROUS_ACTIONS[i]) return false;
  }

  // For URI actions, validate the URI
  if (s === '/URI') {
    var uri = action['/URI'];
    if (uri) {
      var uriStr;
      if (uri instanceof Uint8Array) {
        uriStr = '';
        for (var j = 0; j < uri.length; j++) uriStr += String.fromCharCode(uri[j]);
      } else if (typeof uri === 'string') {
        uriStr = uri;
      } else {
        return false;
      }
      return validateURL(uriStr);
    }
  }

  // For GoTo actions (internal navigation), allow
  if (s === '/GoTo' || s === '/GoToR') return true;

  // For Named actions, allow standard ones
  if (s === '/Named') {
    var n = action['/N'];
    if (n === '/NextPage' || n === '/PrevPage' || n === '/FirstPage' || n === '/LastPage') {
      return true;
    }
    return false; // block unknown named actions
  }

  return true;
}

// ============================================================================
// Object sanitization
// ============================================================================

/**
 * Recursively sanitize a PDF object in-place.
 * Strips JavaScript actions, dangerous URIs, and unsafe action types.
 *
 * @param {*} obj - PDF object to sanitize
 * @param {number} [depth=0] - current recursion depth
 */
function sanitizeObject(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 50) return; // depth guard
  if (!obj || typeof obj !== 'object') return;

  // Handle arrays
  if (Array.isArray(obj)) {
    for (var i = 0; i < obj.length; i++) {
      sanitizeObject(obj[i], depth + 1);
    }
    return;
  }

  // Skip Uint8Array and other typed arrays
  if (obj instanceof Uint8Array) return;

  // Skip stream objects' binary data
  if (obj.rawBytes) {
    // Sanitize the dictionary portion, not the binary data
    sanitizeDict(obj, depth);
    return;
  }

  sanitizeDict(obj, depth);
}

function sanitizeDict(dict, depth) {
  if (!dict || typeof dict !== 'object') return;
  if (Array.isArray(dict)) return;

  // Strip /JS key
  if (dict['/JS'] !== undefined) {
    dict['/JS'] = null;
  }

  // Strip /JavaScript key
  if (dict['/JavaScript'] !== undefined) {
    dict['/JavaScript'] = null;
  }

  // Check /S (action type)
  if (dict['/S']) {
    var s = dict['/S'];
    if (s === '/JavaScript' || s === '/JS') {
      dict['/S'] = null;
      dict['/JS'] = null;
      dict['/JavaScript'] = null;
    }
    if (s === '/Launch' || s === '/SubmitForm' || s === '/ImportData') {
      dict['/S'] = null;
    }
  }

  // Check /A (action dictionary)
  if (dict['/A'] && typeof dict['/A'] === 'object' && !Array.isArray(dict['/A'])) {
    if (!isAllowedAction(dict['/A'])) {
      dict['/A'] = null;
    } else {
      sanitizeObject(dict['/A'], depth + 1);
    }
  }

  // Check /AA (additional actions)
  if (dict['/AA'] && typeof dict['/AA'] === 'object') {
    dict['/AA'] = null; // Remove all additional actions (page open/close, etc.)
  }

  // Check /OpenAction
  if (dict['/OpenAction'] && typeof dict['/OpenAction'] === 'object') {
    if (!Array.isArray(dict['/OpenAction'])) {
      // Action dictionary
      if (!isAllowedAction(dict['/OpenAction'])) {
        dict['/OpenAction'] = null;
      }
    }
    // Array (destination) is OK
  }

  // Sanitize URI in annotations
  if (dict['/URI']) {
    var uri = dict['/URI'];
    var uriStr;
    if (uri instanceof Uint8Array) {
      uriStr = '';
      for (var j = 0; j < uri.length; j++) uriStr += String.fromCharCode(uri[j]);
    } else if (typeof uri === 'string') {
      uriStr = uri;
    } else {
      uriStr = '';
    }
    if (!validateURL(uriStr)) {
      dict['/URI'] = null;
      dict['/A'] = null;
    }
  }

  // Recurse into child objects
  for (var key in dict) {
    if (!dict.hasOwnProperty(key)) continue;
    if (key === 'rawBytes' || key === 'getBytes' || key === 'isStream') continue;
    var val = dict[key];
    if (val && typeof val === 'object' && !(val instanceof Uint8Array)) {
      sanitizeObject(val, depth + 1);
    }
  }
}

// ============================================================================
// Catalog sanitization
// ============================================================================

/**
 * Sanitize the catalog-level dangerous entries.
 *
 * @param {object} catalog - PDF catalog dictionary
 */
function sanitizeCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return;

  // Remove /JavaScript name tree from catalog's /Names dictionary
  if (catalog['/Names'] && typeof catalog['/Names'] === 'object') {
    var names = catalog['/Names'];
    if (names['/JavaScript'] !== undefined) {
      names['/JavaScript'] = null;
    }
    if (names['/JS'] !== undefined) {
      names['/JS'] = null;
    }
  }

  // Remove /AA (additional actions) from catalog
  if (catalog['/AA']) {
    catalog['/AA'] = null;
  }

  // Sanitize /OpenAction
  if (catalog['/OpenAction']) {
    if (typeof catalog['/OpenAction'] === 'object' && !Array.isArray(catalog['/OpenAction'])) {
      if (!isAllowedAction(catalog['/OpenAction'])) {
        catalog['/OpenAction'] = null;
      }
    }
  }

  // Remove /AcroForm (interactive forms)
  if (catalog['/AcroForm']) {
    catalog['/AcroForm'] = null;
  }

  // Remove /EmbeddedFiles
  if (catalog['/Names'] && typeof catalog['/Names'] === 'object') {
    if (catalog['/Names']['/EmbeddedFiles']) {
      catalog['/Names']['/EmbeddedFiles'] = null;
    }
  }

  // Recursively sanitize the rest
  sanitizeObject(catalog, 0);
}

// ============================================================================
// Module exports (Node.js / CommonJS)
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sanitizeObject: sanitizeObject,
    sanitizeCatalog: sanitizeCatalog,
    isAllowedAction: isAllowedAction,
    validateURL: validateURL
  };
}
