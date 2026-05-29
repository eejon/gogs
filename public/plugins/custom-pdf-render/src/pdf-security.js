/**
 * pdf-security.js — Security filter for the custom PDF renderer.
 * Part of the custom-pdf-render engine for Gogs.
 *
 * Responsibilities:
 *  - Strip dangerous PDF action types (JavaScript, Launch, etc.)
 *  - Whitelist only safe action subtypes (URI with http/https, GoTo)
 *  - Validate URLs (same-origin, scheme whitelist)
 *  - Sanitize catalog and page dicts
 *
 * No external library imports.
 */

'use strict';

// Maximum recursion depth for sanitizeObject traversal
const MAX_SANITIZE_DEPTH = 20;
// Maximum keys/elements per level before truncating
const MAX_OBJECT_KEYS    = 10_000;

/**
 * Blocked PDF action subtypes.
 * Any action dictionary whose /S value appears in this set is removed.
 */
const BLOCKED_ACTION_SUBTYPES = new Set([
  '/JavaScript',
  '/JS',          // alias used by some generators
  '/Launch',
  '/SubmitForm',
  '/ImportData',
  '/Movie',
  '/Sound',
  '/Rendition',
  '/Trans',
  '/GoToE',       // embedded file target — can trigger file access
  '/Named',       // named action — can trigger menu/application actions
  '/SetOCGState',
  '/ResetForm',
  '/Hide',
  // Keep this list conservative; only the whitelist below is allowed
]);

/**
 * Allowed PDF action subtypes and their additional validation.
 *
 * /S /URI  — external link; URL must pass validateURL()
 * /S /GoTo — internal navigation (page jump); safe
 */
const ALLOWED_ACTION_SUBTYPES = new Set([
  '/URI',
  '/GoTo',
]);

// ─── isAllowedAction ──────────────────────────────────────────────────────────

/**
 * isAllowedAction(actionDict) → boolean
 *
 * Returns true only if the action dictionary represents a safe action:
 *   - /S /GoTo  — always allowed (internal navigation)
 *   - /S /URI   — allowed only if the URI passes validateURL()
 *
 * All other action subtypes are blocked.
 *
 * @param {object} actionDict — resolved PDF action dictionary
 * @returns {boolean}
 */
function isAllowedAction(actionDict) {
  if (!actionDict || typeof actionDict !== 'object') return false;

  const subtype = actionDict['/S'];
  if (typeof subtype !== 'string') return false;

  if (!ALLOWED_ACTION_SUBTYPES.has(subtype)) return false;

  if (subtype === '/URI') {
    const uri = actionDict['/URI'];
    let uriStr;
    if (typeof uri === 'string') {
      uriStr = uri;
    } else if (uri instanceof Uint8Array) {
      uriStr = _uint8ToStr(uri);
    } else {
      return false; // no URI — block it
    }
    return validateURL(uriStr);
  }

  // /GoTo — always allowed
  return true;
}

// ─── validateURL ──────────────────────────────────────────────────────────────

/**
 * validateURL(urlString) → boolean
 *
 * Returns true if the URL is safe to expose as a link:
 *   - Scheme must be http: or https: (case-insensitive)
 *   - OR the URL is a relative path (no scheme, no authority)
 *   - Never allows: javascript:, data:, blob:, file:, vbscript:, or any
 *     cross-origin absolute URL when running in a browser context.
 *
 * In a browser context, cross-origin absolute URLs are blocked.
 * In a Node.js context (testing), any http/https URL or relative path is accepted.
 *
 * @param {string} urlString
 * @returns {boolean}
 */
function validateURL(urlString) {
  if (typeof urlString !== 'string') return false;
  const trimmed = urlString.trim();
  if (trimmed.length === 0) return false;

  // Block dangerous schemes (case-insensitive)
  const lower = trimmed.toLowerCase();
  const BLOCKED_SCHEMES = [
    'javascript:', 'data:', 'blob:', 'file:', 'vbscript:', 'about:',
  ];
  for (const scheme of BLOCKED_SCHEMES) {
    if (lower.startsWith(scheme)) return false;
  }

  // Check if it's a relative URL (no scheme, no //)
  if (!trimmed.includes(':') || trimmed.startsWith('/')) {
    // Relative or root-relative path — allowed
    return true;
  }

  // Must have http or https scheme
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return false;
  }

  // In browser context: enforce same-origin
  if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
    try {
      const parsed  = new URL(trimmed);
      const current = new URL(window.location.href);
      if (parsed.origin !== current.origin) return false;
    } catch (_) {
      return false;
    }
  }

  return true;
}

// ─── sanitizeObject ───────────────────────────────────────────────────────────

/**
 * sanitizeObject(obj, depth) → obj (mutated in place)
 *
 * Recursively walks the parsed PDF object tree and removes/nullifies
 * dangerous constructs:
 *   - Action dicts whose /S is in BLOCKED_ACTION_SUBTYPES
 *   - /AA (Additional Actions) dicts on any object
 *   - /JS and /JavaScript entries
 *   - URI actions that fail validateURL()
 *
 * Mutates the object and also returns it for convenience.
 *
 * @param {any}    obj   — any parsed PDF value
 * @param {number} depth — current recursion depth (default 0)
 * @returns {any}
 */
function sanitizeObject(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > MAX_SANITIZE_DEPTH) return obj;
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  // Don't recurse into streams' rawBytes
  if (obj.isStream) {
    sanitizeObject(obj.dict, depth + 1);
    return obj;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length && i < MAX_OBJECT_KEYS; i++) {
      obj[i] = sanitizeObject(obj[i], depth + 1);
    }
    return obj;
  }

  // Plain dict
  const keys = Object.keys(obj);
  for (let ki = 0; ki < keys.length && ki < MAX_OBJECT_KEYS; ki++) {
    const key = keys[ki];

    // Remove any /JS or /JavaScript keys at any level
    if (key === '/JS' || key === '/JavaScript') {
      obj[key] = null;
      continue;
    }

    // Remove /AA (Additional Actions)
    if (key === '/AA') {
      obj[key] = null;
      continue;
    }

    // Check action dicts
    if (key === '/A' || key === '/Action') {
      const action = obj[key];
      if (action && typeof action === 'object' && !Array.isArray(action) && !action.isRef) {
        if (!isAllowedAction(action)) {
          obj[key] = null;
          continue;
        }
      }
    }

    // Recursively sanitize all values
    if (obj[key] !== null && typeof obj[key] === 'object') {
      // If this is an action dict, check it directly
      if (obj[key]['/S'] !== undefined) {
        if (!isAllowedAction(obj[key])) {
          obj[key] = null;
          continue;
        }
      }
      sanitizeObject(obj[key], depth + 1);
    }
  }

  return obj;
}

// ─── sanitizeCatalog ──────────────────────────────────────────────────────────

/**
 * sanitizeCatalog(catalogObj) → catalogObj (mutated)
 *
 * Remove dangerous top-level catalog entries:
 *   - /OpenAction — auto-execute action on document open
 *   - /AA         — additional actions on the catalog
 *   - /JavaScript — JavaScript name tree
 *   - /Names./JavaScript — JavaScript name tree under /Names
 *
 * @param {object} catalogObj
 * @returns {object}
 */
function sanitizeCatalog(catalogObj) {
  if (!catalogObj || typeof catalogObj !== 'object') return catalogObj;

  delete catalogObj['/OpenAction'];
  catalogObj['/OpenAction'] = null;

  delete catalogObj['/AA'];
  catalogObj['/AA'] = null;

  // Clean /JavaScript top-level (non-standard but seen in wild)
  delete catalogObj['/JavaScript'];
  catalogObj['/JavaScript'] = null;

  // Clean /Names dictionary
  const names = catalogObj['/Names'];
  if (names && typeof names === 'object' && !Array.isArray(names) && !names.isRef) {
    delete names['/JavaScript'];
    names['/JavaScript'] = null;
    // Also clean /JS
    delete names['/JS'];
    names['/JS'] = null;
  }

  return catalogObj;
}

// ─── sanitizePage ─────────────────────────────────────────────────────────────

/**
 * sanitizePage(pageObj) → pageObj (mutated)
 *
 * Remove dangerous page-level entries:
 *   - /AA — additional actions triggered by page events
 *   - Any /A action that is not in the allowed set
 *
 * @param {object} pageObj
 * @returns {object}
 */
function sanitizePage(pageObj) {
  if (!pageObj || typeof pageObj !== 'object') return pageObj;

  delete pageObj['/AA'];
  pageObj['/AA'] = null;

  // Check /Actions array if present
  if (pageObj['/A'] !== null && typeof pageObj['/A'] === 'object') {
    if (!isAllowedAction(pageObj['/A'])) {
      pageObj['/A'] = null;
    }
  }

  return pageObj;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _uint8ToStr(arr) {
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return s;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sanitizeObject,
    isAllowedAction,
    validateURL,
    sanitizeCatalog,
    sanitizePage,
  };
} else {
  window.PDFSecurity = {
    sanitizeObject,
    isAllowedAction,
    validateURL,
    sanitizeCatalog,
    sanitizePage,
  };
}
