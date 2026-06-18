/**
 * PDF Annotation Parser
 *
 * Parses link annotations from PDF pages and creates positioned overlay elements.
 * Handles URI actions (open in new tab) and GoTo actions (internal page navigation).
 * All URIs are sanitized through PDFSecurity before use.
 *
 * Public interface:
 *   PDFAnnotations.getPageAnnotations(doc, pageNum) - extract link annotations
 *   PDFAnnotations.createAnnotationOverlay(annotations, pageWidth, pageHeight, scale, onGoTo) - create DOM overlay
 */

'use strict';

var _security;

if (typeof module !== 'undefined' && module.exports) {
  _security = require('./pdf-security.js');
} else if (typeof window !== 'undefined') {
  _security = window.PDFSecurity;
}

// ============================================================================
// Annotation Extraction
// ============================================================================

/**
 * Extract link annotations from a PDF page.
 *
 * @param {object} doc - PDFDocument instance
 * @param {number} pageNum - 1-based page number
 * @returns {Array} Array of link annotation objects with:
 *   { rect: [x1,y1,x2,y2], type: 'uri'|'goto'|'unknown', uri: string, dest: number|null }
 */
function getPageAnnotations(doc, pageNum) {
  var page;
  try {
    page = doc.getPage(pageNum);
  } catch (e) {
    return [];
  }

  var annots = page.Annots;
  if (!annots) return [];

  // Resolve annotations array
  annots = doc.resolveRef(annots);
  if (!Array.isArray(annots)) return [];

  var mediaBox = page.CropBox || page.MediaBox;
  if (!mediaBox || !Array.isArray(mediaBox)) return [];

  var results = [];

  for (var i = 0; i < annots.length; i++) {
    var annot = doc.resolveRef(annots[i]);
    if (!annot || typeof annot !== 'object') continue;

    // Apply security filter
    annot = _security.filterAnnotation(annot);
    if (!annot) continue;

    // Only process Link annotations
    var subtype = annot.Subtype || annot['/Subtype'];
    if (typeof subtype === 'string' && subtype.charAt(0) === '/') {
      subtype = subtype.substring(1);
    }
    if (subtype !== 'Link') continue;

    // Extract rectangle
    var rect = annot.Rect || annot['/Rect'];
    if (rect) {
      rect = doc.resolveRef(rect);
      if (Array.isArray(rect)) {
        var resolvedRect = [];
        for (var ri = 0; ri < rect.length; ri++) {
          var rv = rect[ri];
          if (rv && typeof rv === 'object' && rv.isRef) {
            rv = doc.resolveRef(rv);
          }
          resolvedRect.push(typeof rv === 'number' ? rv : 0);
        }
        rect = resolvedRect;
      }
    }
    if (!rect || !Array.isArray(rect) || rect.length < 4) continue;

    // Normalize rect: ensure x1 < x2 and y1 < y2
    var x1 = Math.min(rect[0], rect[2]);
    var y1 = Math.min(rect[1], rect[3]);
    var x2 = Math.max(rect[0], rect[2]);
    var y2 = Math.max(rect[1], rect[3]);

    // Skip zero-area annotations
    if (x2 - x1 < 1 || y2 - y1 < 1) continue;

    // Determine action type
    var action = annot.A || annot['/A'];
    var dest = annot.Dest || annot['/Dest'];

    var linkInfo = {
      rect: [x1, y1, x2, y2],
      type: 'unknown',
      uri: null,
      dest: null
    };

    if (action) {
      action = doc.resolveRef(action);
      if (action && typeof action === 'object') {
        var actionType = action.S || action['/S'];
        if (typeof actionType === 'string' && actionType.charAt(0) === '/') {
          actionType = actionType.substring(1);
        }

        if (actionType === 'URI') {
          var uri = action.URI || action['/URI'];
          if (uri) {
            if (uri instanceof Uint8Array) {
              uri = doc.stringToJS(uri);
            } else if (typeof uri !== 'string') {
              uri = String(uri);
            }
            var sanitized = _security.sanitizeAnnotationUri(uri);
            if (sanitized !== null) {
              linkInfo.type = 'uri';
              linkInfo.uri = sanitized;
            }
          }
        } else if (actionType === 'GoTo') {
          var gotoDest = action.D || action['/D'];
          if (gotoDest) {
            gotoDest = doc.resolveRef(gotoDest);
            var targetPage = resolveDestination(doc, gotoDest);
            if (targetPage !== null) {
              linkInfo.type = 'goto';
              linkInfo.dest = targetPage;
            }
          }
        }
        // All other action types are silently ignored (security)
      }
    } else if (dest) {
      // Direct destination (no action)
      dest = doc.resolveRef(dest);
      var targetPageDirect = resolveDestination(doc, dest);
      if (targetPageDirect !== null) {
        linkInfo.type = 'goto';
        linkInfo.dest = targetPageDirect;
      }
    }

    // Only include annotations with a known type
    if (linkInfo.type !== 'unknown') {
      results.push(linkInfo);
    }
  }

  return results;
}

/**
 * Resolve a PDF destination to a 1-based page number.
 *
 * Destinations can be:
 *   - An array: [pageRef, /Fit, ...] or [pageRef, /XYZ, left, top, zoom]
 *   - A named destination string (not currently resolved)
 *   - A page reference directly
 *
 * @param {object} doc - PDFDocument instance
 * @param {*} dest - PDF destination value
 * @returns {number|null} 1-based page number or null
 */
function resolveDestination(doc, dest) {
  if (dest === null || dest === undefined) return null;

  // Named destination (string) - try to look up in Names/Dests
  if (typeof dest === 'string') {
    // Named destinations are complex to resolve (catalog->Names->Dests->name tree)
    // For now, return null - most link annotations in the corpus use explicit page refs
    return null;
  }

  // Array destination: [pageRef, fitType, ...]
  if (Array.isArray(dest) && dest.length >= 1) {
    var pageRef = dest[0];
    return findPageNumber(doc, pageRef);
  }

  // Direct page reference
  if (dest && typeof dest === 'object') {
    return findPageNumber(doc, dest);
  }

  return null;
}

/**
 * Find the 1-based page number for a page reference.
 *
 * @param {object} doc - PDFDocument instance
 * @param {*} pageRef - Page reference (indirect ref or page dict)
 * @returns {number|null} 1-based page number or null
 */
function findPageNumber(doc, pageRef) {
  if (!pageRef) return null;

  // If it's an indirect reference, get the object number
  if (pageRef.isRef) {
    var objNum = pageRef.objNum;
    // Search through pages to find matching object number
    for (var i = 0; i < doc.pages.length; i++) {
      var page = doc.pages[i];
      if (page._objNum === objNum) {
        return i + 1; // 1-based
      }
    }
    // Try resolving and comparing
    var resolved = doc.resolveRef(pageRef);
    if (resolved && typeof resolved === 'object') {
      var pageType = resolved.Type;
      if (typeof pageType === 'string') {
        if (pageType.charAt(0) === '/') pageType = pageType.substring(1);
        if (pageType === 'Page') {
          // Search by object identity if we can match MediaBox etc.
          return null;
        }
      }
    }
    return null;
  }

  // If it's a number, treat as 0-based page index
  if (typeof pageRef === 'number') {
    var idx = Math.floor(pageRef);
    if (idx >= 0 && idx < doc.pages.length) {
      return idx + 1;
    }
    return null;
  }

  return null;
}

// ============================================================================
// Annotation Overlay Creation
// ============================================================================

/**
 * Create a DOM overlay container with positioned link elements for a rendered page.
 *
 * The overlay is an absolutely-positioned div that sits on top of the canvas.
 * Each link annotation gets an <a> element positioned at the annotation's rectangle.
 *
 * PDF coordinates: origin at bottom-left, y increases upward.
 * Screen coordinates: origin at top-left, y increases downward.
 * The conversion is: screenY = (pageHeight - pdfY) * scale
 *
 * @param {Array} annotations - Array from getPageAnnotations()
 * @param {number} pageWidth - Page width in PDF points (from MediaBox)
 * @param {number} pageHeight - Page height in PDF points (from MediaBox)
 * @param {number} scale - Current zoom scale
 * @param {function} onGoTo - Callback for GoTo links: function(pageNum)
 * @returns {HTMLDivElement} The overlay div element
 */
function createAnnotationOverlay(annotations, pageWidth, pageHeight, scale, onGoTo) {
  var overlay = document.createElement('div');
  overlay.className = 'pdf-annotation-overlay';
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = Math.ceil(pageWidth * scale) + 'px';
  overlay.style.height = Math.ceil(pageHeight * scale) + 'px';
  overlay.style.pointerEvents = 'none';

  for (var i = 0; i < annotations.length; i++) {
    var annot = annotations[i];
    var rect = annot.rect;

    // Convert PDF coordinates to screen coordinates
    var left = rect[0] * scale;
    var bottom = rect[1] * scale;
    var right = rect[2] * scale;
    var top = rect[3] * scale;

    // PDF y=0 is at bottom; screen y=0 is at top
    var screenTop = (pageHeight * scale) - top;
    var screenBottom = (pageHeight * scale) - bottom;

    var width = right - left;
    var height = screenBottom - screenTop;

    if (width <= 0 || height <= 0) continue;

    var link;

    if (annot.type === 'uri') {
      link = document.createElement('a');
      link.href = annot.uri;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = annot.uri;
    } else if (annot.type === 'goto') {
      link = document.createElement('a');
      link.href = '#page=' + annot.dest;
      link.title = 'Go to page ' + annot.dest;
      // Prevent default navigation and use callback
      (function(pageNum) {
        link.addEventListener('click', function(e) {
          e.preventDefault();
          if (typeof onGoTo === 'function') {
            onGoTo(pageNum);
          }
        });
      })(annot.dest);
    } else {
      continue;
    }

    link.style.position = 'absolute';
    link.style.left = Math.round(left) + 'px';
    link.style.top = Math.round(screenTop) + 'px';
    link.style.width = Math.round(width) + 'px';
    link.style.height = Math.round(height) + 'px';
    link.style.pointerEvents = 'auto';
    link.style.cursor = 'pointer';
    // Transparent overlay - no visible border by default but adds hover effect via CSS
    link.className = 'pdf-link-annotation';

    overlay.appendChild(link);
  }

  return overlay;
}

// ============================================================================
// Exports
// ============================================================================

var PDFAnnotations = {
  getPageAnnotations: getPageAnnotations,
  createAnnotationOverlay: createAnnotationOverlay,
  resolveDestination: resolveDestination,
  findPageNumber: findPageNumber
};

if (typeof window !== 'undefined') {
  window.PDFAnnotations = PDFAnnotations;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PDFAnnotations;
}
