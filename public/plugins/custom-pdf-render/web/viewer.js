/**
 * pdf-viewer.js -- Viewer application logic for custom-pdf-render
 *
 * Reads ?file= query parameter, fetches PDF bytes, parses, sanitizes,
 * and renders pages using PDFParser, SecurityFilter, and PDFRenderer.
 *
 * Dependencies (loaded before this script via <script> tags):
 *   - PDFParser, ParseError   (from pdf-parser.js)
 *   - sanitizeObject, sanitizeCatalog, validateURL  (from pdf-security.js)
 *   - PDFFonts               (from pdf-fonts.js)
 *   - PDFImages              (from pdf-images.js)
 *   - PDFRenderer            (from pdf-renderer.js)
 *
 * No external imports. No eval(). No new Function(). No innerHTML with
 * PDF-sourced strings. No document.write.
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  var parser = null;
  var parsedResult = null;
  var renderer = null;
  var currentPage = 0;       // zero-indexed
  var totalPages = 0;
  var currentScale = 1.0;
  var fitToWidthScale = 1.0;
  var pageWidth = 612;       // default US Letter
  var pageHeight = 792;

  // ── DOM references ─────────────────────────────────────────────────────────
  var toolbar;
  var canvas;
  var canvasWrapper;
  var viewerContainer;
  var pageNumberInput;
  var pageCountSpan;
  var zoomLevelSpan;
  var btnPrev;
  var btnNext;
  var btnZoomIn;
  var btnZoomOut;
  var btnFitWidth;
  var loadingOverlay;
  var loadingMessage;
  var errorOverlay;
  var errorTitle;
  var errorDetail;

  // ── Constants ──────────────────────────────────────────────────────────────
  var MIN_SCALE = 0.25;
  var MAX_SCALE = 5.0;
  var ZOOM_STEP = 0.25;

  // ── URL Validation ─────────────────────────────────────────────────────────
  // Validates the ?file= parameter. Only same-origin or relative URLs are
  // allowed. Blocks javascript:, data:, file:, vbscript: and cross-origin URLs.
  function validateFileURL(url) {
    if (!url || typeof url !== 'string') return false;

    var trimmed = url.trim();
    if (trimmed.length === 0) return false;

    // Block dangerous URI schemes
    var lower = trimmed.toLowerCase();
    if (lower.indexOf('javascript:') === 0) return false;
    if (lower.indexOf('data:') === 0) return false;
    if (lower.indexOf('file:') === 0) return false;
    if (lower.indexOf('vbscript:') === 0) return false;

    // If it starts with //, http://, or https://, verify same-origin
    if (lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0) {
      try {
        var parsed = new URL(trimmed);
        if (parsed.origin !== window.location.origin) {
          return false; // cross-origin blocked
        }
      } catch (e) {
        return false;
      }
    } else if (lower.indexOf('//') === 0) {
      // Protocol-relative URL -- check origin
      try {
        var parsed2 = new URL(window.location.protocol + trimmed);
        if (parsed2.origin !== window.location.origin) {
          return false;
        }
      } catch (e) {
        return false;
      }
    }

    // Relative URLs (starting with / or no scheme) are allowed
    // Also use the security module's validateURL if available
    if (typeof validateURL === 'function') {
      return validateURL(trimmed);
    }

    return true;
  }

  // ── Initialization ─────────────────────────────────────────────────────────

  function init() {
    // Grab DOM elements
    toolbar = document.getElementById('toolbar');
    canvas = document.getElementById('pdfCanvas');
    canvasWrapper = document.getElementById('canvasWrapper');
    viewerContainer = document.getElementById('viewerContainer');
    pageNumberInput = document.getElementById('pageNumber');
    pageCountSpan = document.getElementById('pageCount');
    zoomLevelSpan = document.getElementById('zoomLevel');
    btnPrev = document.getElementById('btnPrev');
    btnNext = document.getElementById('btnNext');
    btnZoomIn = document.getElementById('btnZoomIn');
    btnZoomOut = document.getElementById('btnZoomOut');
    btnFitWidth = document.getElementById('btnFitWidth');
    loadingOverlay = document.getElementById('loadingOverlay');
    loadingMessage = document.getElementById('loadingMessage');
    errorOverlay = document.getElementById('errorOverlay');
    errorTitle = document.getElementById('errorTitle');
    errorDetail = document.getElementById('errorDetail');

    // Bind events
    btnPrev.addEventListener('click', prevPage);
    btnNext.addEventListener('click', nextPage);
    btnZoomIn.addEventListener('click', zoomIn);
    btnZoomOut.addEventListener('click', zoomOut);
    btnFitWidth.addEventListener('click', fitToWidth);

    pageNumberInput.addEventListener('change', onPageNumberChange);
    pageNumberInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        onPageNumberChange();
      }
    });

    // Keyboard navigation
    document.addEventListener('keydown', onKeyDown);

    // Responsive resize
    window.addEventListener('resize', onResize);

    // Read ?file= parameter
    var params = new URLSearchParams(window.location.search);
    var fileURL = params.get('file');

    if (!fileURL) {
      showError('No PDF file specified', 'The viewer requires a ?file= parameter with a URL to a PDF file.');
      return;
    }

    // Validate URL
    if (!validateFileURL(fileURL)) {
      showError('Invalid file URL', 'The specified URL is not allowed. Only same-origin or relative URLs are permitted. Cross-origin, javascript:, and data: URLs are blocked for security.');
      return;
    }

    // Start loading
    showLoading('Loading PDF...');
    loadPDF(fileURL);
  }

  // ── Loading and Error UI ───────────────────────────────────────────────────

  function showLoading(msg) {
    if (loadingOverlay) {
      loadingOverlay.classList.remove('hidden');
      if (loadingMessage) {
        loadingMessage.textContent = msg || 'Loading...';
      }
    }
  }

  function hideLoading() {
    if (loadingOverlay) {
      loadingOverlay.classList.add('hidden');
    }
  }

  function showError(title, detail) {
    hideLoading();
    if (errorOverlay) {
      errorOverlay.classList.remove('hidden');
      if (errorTitle) errorTitle.textContent = title || 'Error';
      if (errorDetail) errorDetail.textContent = detail || '';
    }
    // Disable navigation
    disableControls();
  }

  function disableControls() {
    if (btnPrev) btnPrev.disabled = true;
    if (btnNext) btnNext.disabled = true;
    if (btnZoomIn) btnZoomIn.disabled = true;
    if (btnZoomOut) btnZoomOut.disabled = true;
    if (btnFitWidth) btnFitWidth.disabled = true;
    if (pageNumberInput) pageNumberInput.disabled = true;
  }

  // ── PDF Loading Pipeline ───────────────────────────────────────────────────

  function loadPDF(url) {
    showLoading('Fetching PDF...');

    fetch(url)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ': ' + response.statusText);
        }
        showLoading('Reading PDF data...');
        return response.arrayBuffer();
      })
      .then(function (arrayBuffer) {
        showLoading('Parsing PDF...');
        return parsePDF(arrayBuffer);
      })
      .then(function () {
        hideLoading();
        updateControls();
        renderCurrentPage();
      })
      .catch(function (err) {
        var message = err && err.message ? err.message : String(err);
        showError('Failed to load PDF', message);
      });
  }

  function parsePDF(arrayBuffer) {
    try {
      parser = new PDFParser(arrayBuffer);
    } catch (e) {
      throw new Error('Failed to initialize PDF parser: ' + e.message);
    }

    return parser.load().then(function (result) {
      if (result.error) {
        throw new Error('PDF parse error: ' + result.error.message);
      }

      parsedResult = result;

      // Sanitize the document
      try {
        sanitizeCatalog(result.catalog);
        sanitizeObject(result.catalog);
        if (result.pages) {
          for (var i = 0; i < result.pages.length; i++) {
            sanitizeObject(result.pages[i]);
          }
        }
      } catch (e) {
        // Sanitization errors are non-fatal -- log and continue
        if (typeof console !== 'undefined') {
          console.warn('Security sanitization warning:', e.message);
        }
      }

      totalPages = result.pageCount || 0;

      if (totalPages === 0) {
        throw new Error('PDF contains no pages.');
      }

      currentPage = 0;
      renderer = new PDFRenderer();

      // Calculate page dimensions from first page
      var page = result.pages[0];
      var mediaBox = getPageMediaBox(page);
      pageWidth = mediaBox[2] - mediaBox[0];
      pageHeight = mediaBox[3] - mediaBox[1];

      // Calculate fit-to-width scale
      calculateFitToWidthScale();
      currentScale = fitToWidthScale;
    });
  }

  // ── Page Rendering ─────────────────────────────────────────────────────────

  function renderCurrentPage() {
    if (!parsedResult || !parsedResult.pages || currentPage < 0 || currentPage >= totalPages) {
      return;
    }

    var page = parsedResult.pages[currentPage];
    var mediaBox = getPageMediaBox(page);
    pageWidth = mediaBox[2] - mediaBox[0];
    pageHeight = mediaBox[3] - mediaBox[1];

    // Clear any existing link annotations
    clearLinkAnnotations();

    // Render the page
    renderer.renderPage(canvas, page, currentScale, parser)
      .then(function () {
        // Update canvas wrapper size to match canvas
        if (canvasWrapper) {
          canvasWrapper.style.width = canvas.width + 'px';
          canvasWrapper.style.height = canvas.height + 'px';
        }

        // Render link annotations on top of the canvas
        renderLinkAnnotations(page, currentScale);
      })
      .catch(function (err) {
        if (typeof console !== 'undefined') {
          console.error('Page render error:', err);
        }
      });
  }

  // ── Link Annotations ──────────────────────────────────────────────────────

  function clearLinkAnnotations() {
    if (!canvasWrapper) return;
    var existing = canvasWrapper.querySelectorAll('.link-annotation');
    for (var i = 0; i < existing.length; i++) {
      canvasWrapper.removeChild(existing[i]);
    }
  }

  function renderLinkAnnotations(page, scale) {
    if (!canvasWrapper || !page) return;

    var annots = page['/Annots'];
    if (!annots || !Array.isArray(annots)) return;

    var mediaBox = getPageMediaBox(page);
    var pagePDFHeight = mediaBox[3] - mediaBox[1];
    var pageOriginX = mediaBox[0];
    var pageOriginY = mediaBox[1];

    for (var i = 0; i < annots.length; i++) {
      var annot = annots[i];

      // Resolve indirect references
      if (annot && annot.type === 'ref' && parser) {
        annot = parser.resolveRef(annot);
      }

      if (!annot || typeof annot !== 'object') continue;

      // Only process Link annotations
      var subtype = annot['/Subtype'];
      if (subtype !== '/Link') continue;

      var rect = annot['/Rect'];
      if (!rect || !Array.isArray(rect) || rect.length < 4) continue;

      // Resolve rect values (might be indirect refs)
      var r = [];
      for (var ri = 0; ri < 4; ri++) {
        var rv = rect[ri];
        if (rv && rv.type === 'ref' && parser) rv = parser.resolveRef(rv);
        r.push(typeof rv === 'number' ? rv : 0);
      }

      // Normalize rect: [x1, y1, x2, y2] where x1<x2, y1<y2
      var x1 = Math.min(r[0], r[2]);
      var y1 = Math.min(r[1], r[3]);
      var x2 = Math.max(r[0], r[2]);
      var y2 = Math.max(r[1], r[3]);

      // Convert PDF coordinates (origin bottom-left) to CSS coordinates (origin top-left)
      var cssLeft = (x1 - pageOriginX) * scale;
      var cssTop = (pagePDFHeight - (y2 - pageOriginY)) * scale;
      var cssWidth = (x2 - x1) * scale;
      var cssHeight = (y2 - y1) * scale;

      // Determine the link target
      var action = annot['/A'];
      if (action && action.type === 'ref' && parser) action = parser.resolveRef(action);

      var dest = annot['/Dest'];
      if (dest && dest.type === 'ref' && parser) dest = parser.resolveRef(dest);

      var linkInfo = resolveLinkTarget(action, dest);

      if (!linkInfo) continue;

      // Create the overlay element
      var el;
      if (linkInfo.type === 'external') {
        el = document.createElement('a');
        el.href = linkInfo.url;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
      } else if (linkInfo.type === 'internal') {
        el = document.createElement('a');
        el.href = '#';
        (function (pageIndex) {
          el.addEventListener('click', function (e) {
            e.preventDefault();
            goToPage(pageIndex);
          });
        })(linkInfo.pageIndex);
      } else {
        continue;
      }

      el.className = 'link-annotation';
      el.style.position = 'absolute';
      el.style.left = cssLeft + 'px';
      el.style.top = cssTop + 'px';
      el.style.width = cssWidth + 'px';
      el.style.height = cssHeight + 'px';

      canvasWrapper.appendChild(el);
    }
  }

  function resolveLinkTarget(action, dest) {
    // Handle /A (action) dictionary
    if (action && typeof action === 'object') {
      var actionType = action['/S'];

      // URI action -- external link
      if (actionType === '/URI') {
        var uri = action['/URI'];
        if (uri && uri.type === 'ref' && parser) uri = parser.resolveRef(uri);

        // Convert Uint8Array to string if needed
        if (uri instanceof Uint8Array) {
          var uriStr = '';
          for (var j = 0; j < uri.length; j++) {
            uriStr += String.fromCharCode(uri[j]);
          }
          uri = uriStr;
        }

        if (typeof uri === 'string' && uri.length > 0) {
          // Validate URL scheme -- only allow safe schemes
          var uriLower = uri.toLowerCase().trim();
          if (uriLower.indexOf('javascript:') === 0 ||
              uriLower.indexOf('data:') === 0 ||
              uriLower.indexOf('file:') === 0 ||
              uriLower.indexOf('vbscript:') === 0) {
            return null; // blocked
          }
          // Only allow http, https, mailto
          if (uriLower.indexOf('http:') === 0 ||
              uriLower.indexOf('https:') === 0 ||
              uriLower.indexOf('mailto:') === 0) {
            return { type: 'external', url: uri };
          }
          // Relative URLs also allowed
          if (uriLower.indexOf(':') === -1 || uriLower.indexOf(':') > 10) {
            return { type: 'external', url: uri };
          }
          return null; // unknown scheme
        }
        return null;
      }

      // GoTo action -- internal navigation
      if (actionType === '/GoTo') {
        var goToDest = action['/D'];
        if (goToDest && goToDest.type === 'ref' && parser) {
          goToDest = parser.resolveRef(goToDest);
        }
        return resolveDestination(goToDest);
      }

      // GoToR, Launch, JavaScript, SubmitForm, ImportData -- all blocked
      // (sanitizeObject should have stripped these, but defend in depth)
      return null;
    }

    // Handle /Dest (destination) directly
    if (dest) {
      return resolveDestination(dest);
    }

    return null;
  }

  function resolveDestination(dest) {
    if (!dest) return null;

    // Named destination (string or Uint8Array)
    if (typeof dest === 'string') {
      return resolveNamedDestination(dest);
    }
    if (dest instanceof Uint8Array) {
      var nameStr = '';
      for (var k = 0; k < dest.length; k++) {
        nameStr += String.fromCharCode(dest[k]);
      }
      return resolveNamedDestination(nameStr);
    }

    // Explicit destination array: [pageRef, /type, ...]
    if (Array.isArray(dest) && dest.length >= 2) {
      var pageRef = dest[0];
      if (pageRef && pageRef.type === 'ref' && parser) {
        pageRef = parser.resolveRef(pageRef);
      }

      // Find the page index
      var pageIndex = findPageIndex(pageRef);
      if (pageIndex >= 0) {
        return { type: 'internal', pageIndex: pageIndex };
      }
      // If pageRef is a number, treat as page index directly
      if (typeof pageRef === 'number') {
        return { type: 'internal', pageIndex: Math.max(0, Math.min(pageRef, totalPages - 1)) };
      }
    }

    return null;
  }

  function resolveNamedDestination(name) {
    if (!parsedResult || !name) return null;

    var namedDests = parsedResult.namedDests;
    if (!namedDests) return null;

    var dest = namedDests[name] || namedDests['/' + name];
    if (dest && dest.type === 'ref' && parser) {
      dest = parser.resolveRef(dest);
    }

    if (dest) {
      return resolveDestination(dest);
    }
    return null;
  }

  function findPageIndex(pageObj) {
    if (!parsedResult || !parsedResult.pages || !pageObj) return -1;

    for (var i = 0; i < parsedResult.pages.length; i++) {
      var page = parsedResult.pages[i];
      // Compare by object identity or by matching key properties
      if (page === pageObj) return i;
      // If page has index property set by parser
      if (typeof page.index === 'number' && page === pageObj) return page.index;
    }

    // Try matching by reference number if available
    if (pageObj._objNum !== undefined) {
      for (var j = 0; j < parsedResult.pages.length; j++) {
        if (parsedResult.pages[j]._objNum === pageObj._objNum) return j;
      }
    }

    return -1;
  }

  // ── Page Navigation ────────────────────────────────────────────────────────

  function goToPage(pageIndex) {
    if (pageIndex < 0 || pageIndex >= totalPages) return;
    currentPage = pageIndex;
    updateControls();
    renderCurrentPage();
    // Scroll to top of viewer
    if (viewerContainer) viewerContainer.scrollTop = 0;
  }

  function prevPage() {
    if (currentPage > 0) {
      goToPage(currentPage - 1);
    }
  }

  function nextPage() {
    if (currentPage < totalPages - 1) {
      goToPage(currentPage + 1);
    }
  }

  function onPageNumberChange() {
    var val = parseInt(pageNumberInput.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > totalPages) val = totalPages;
    goToPage(val - 1);
  }

  // ── Zoom Controls ─────────────────────────────────────────────────────────

  function zoomIn() {
    setScale(currentScale + ZOOM_STEP);
  }

  function zoomOut() {
    setScale(currentScale - ZOOM_STEP);
  }

  function fitToWidth() {
    calculateFitToWidthScale();
    setScale(fitToWidthScale);
  }

  function setScale(newScale) {
    newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    if (newScale === currentScale) return;
    currentScale = newScale;
    updateControls();
    renderCurrentPage();
  }

  function calculateFitToWidthScale() {
    if (!viewerContainer) {
      fitToWidthScale = 1.0;
      return;
    }
    // Account for padding and scrollbar
    var containerWidth = viewerContainer.clientWidth - 20;
    if (containerWidth <= 0) containerWidth = 600;
    fitToWidthScale = containerWidth / pageWidth;
    // Clamp
    fitToWidthScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitToWidthScale));
  }

  // ── Controls Update ────────────────────────────────────────────────────────

  function updateControls() {
    // Page navigation
    if (pageNumberInput) pageNumberInput.value = currentPage + 1;
    if (pageCountSpan) pageCountSpan.textContent = 'of ' + totalPages;
    if (btnPrev) btnPrev.disabled = currentPage <= 0;
    if (btnNext) btnNext.disabled = currentPage >= totalPages - 1;

    // Zoom
    if (zoomLevelSpan) {
      zoomLevelSpan.textContent = Math.round(currentScale * 100) + '%';
    }
    if (btnZoomIn) btnZoomIn.disabled = currentScale >= MAX_SCALE;
    if (btnZoomOut) btnZoomOut.disabled = currentScale <= MIN_SCALE;
  }

  // ── Keyboard Navigation ────────────────────────────────────────────────────

  function onKeyDown(e) {
    // Don't handle if focus is in an input
    if (e.target && e.target.tagName === 'INPUT') return;

    switch (e.key) {
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        prevPage();
        break;
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        nextPage();
        break;
      case 'Home':
        e.preventDefault();
        goToPage(0);
        break;
      case 'End':
        e.preventDefault();
        goToPage(totalPages - 1);
        break;
    }
  }

  // ── Responsive Resize ──────────────────────────────────────────────────────

  var resizeTimer = null;

  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      // If currently at fit-to-width, recalculate
      var oldFit = fitToWidthScale;
      calculateFitToWidthScale();
      if (Math.abs(currentScale - oldFit) < 0.01) {
        // Was at fit-to-width, stay at fit-to-width
        currentScale = fitToWidthScale;
        updateControls();
        renderCurrentPage();
      }
    }, 200);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getPageMediaBox(page) {
    if (!page) return [0, 0, 612, 792];

    // CropBox takes priority over MediaBox per PDF spec
    var cropBox = page['/CropBox'];
    if (Array.isArray(cropBox) && cropBox.length >= 4) {
      return resolveBoxValues(cropBox);
    }

    var mediaBox = page['/MediaBox'];
    if (Array.isArray(mediaBox) && mediaBox.length >= 4) {
      return resolveBoxValues(mediaBox);
    }

    // Default US Letter
    return [0, 0, 612, 792];
  }

  function resolveBoxValues(box) {
    var resolved = [];
    for (var i = 0; i < 4; i++) {
      var v = box[i];
      if (v && v.type === 'ref' && parser) v = parser.resolveRef(v);
      resolved.push(typeof v === 'number' ? v : 0);
    }
    return resolved;
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
