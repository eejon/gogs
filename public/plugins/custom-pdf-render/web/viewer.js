/**
 * viewer.js — UI orchestration for the custom PDF viewer.
 *
 * Depends on (loaded before this script, in order):
 *   ../src/pdf-fonts.js      → window.PDFFonts
 *   ../src/pdf-images.js     → window.PDFImages
 *   ../src/pdf-security.js   → window.PDFSecurity
 *   ../src/pdf-parser.js     → window.PDFParser
 *   ../src/pdf-renderer.js   → window.PDFRenderer
 *
 * No external imports. No eval(). No new Function(). No innerHTML with
 * PDF-derived content.
 */

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────────────────────
  var ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
  var DEFAULT_ZOOM_INDEX = 2; // 1.0
  var ZOOM_INDEX_MIN = 0;
  var ZOOM_INDEX_MAX = ZOOM_LEVELS.length - 1;

  // ── State ───────────────────────────────────────────────────────────────────
  var state = {
    fileUrl:    null,   // validated ?file= URL
    parser:     null,   // PDFParser instance after load()
    pages:      [],     // array of page dicts (sanitized)
    rawAnnots:  [],     // array of raw (pre-sanitize) annotation arrays per page
    pageCount:  0,
    currentPage: 1,     // 1-based
    zoomIndex:  DEFAULT_ZOOM_INDEX,
    rendering:  false,
  };

  // ── DOM refs (populated in init) ────────────────────────────────────────────
  var els = {};

  // ── Helper: safely show an error message ───────────────────────────────────
  function showError(msg, sub) {
    // SECURITY: use textContent only — never innerHTML
    els.errorMessage.textContent = msg || 'An error occurred.';
    els.errorSub.textContent     = sub || '';
    els.errorDisplay.classList.remove('hidden');
    els.loadingOverlay.classList.add('hidden');
    els.toolbar.style.visibility = 'hidden';
  }

  function hideError() {
    els.errorDisplay.classList.add('hidden');
    els.toolbar.style.visibility = '';
  }

  // ── Helper: show/hide loading overlay ──────────────────────────────────────
  function showLoading(msg) {
    els.loadingText.textContent = msg || 'Loading…';
    els.loadingOverlay.classList.remove('hidden');
  }

  function hideLoading() {
    els.loadingOverlay.classList.add('hidden');
  }

  // ── Navigation state ────────────────────────────────────────────────────────
  function updateNavUI() {
    els.pageInput.value    = state.currentPage;
    els.pageTotal.textContent = '/ ' + state.pageCount;
    els.btnPrev.disabled = (state.currentPage <= 1);
    els.btnNext.disabled = (state.currentPage >= state.pageCount);
    var pct = Math.round(ZOOM_LEVELS[state.zoomIndex] * 100);
    els.zoomLevel.value = pct + '%';
  }

  // ── Render a page ────────────────────────────────────────────────────────────
  function goToPage(n) {
    if (!state.pages || state.pages.length === 0) return;
    if (n < 1) n = 1;
    if (n > state.pageCount) n = state.pageCount;
    state.currentPage = n;

    var scale = ZOOM_LEVELS[state.zoomIndex];
    var pageObj = state.pages[n - 1];

    state.rendering = true;
    showLoading('Rendering page ' + n + '…');

    var rawAnnots = state.rawAnnots[n - 1] || null;
    var renderer = new window.PDFRenderer();
    renderer.renderPage(els.canvas, pageObj, scale, state.parser)
      .then(function () {
        hideLoading();
        state.rendering = false;
        updateNavUI();
        renderLinkAnnotations(rawAnnots, pageObj, scale);
        // scroll canvas container back to top when switching pages
        els.canvasContainer.scrollTop = 0;
      })
      .catch(function (err) {
        hideLoading();
        state.rendering = false;
        // renderPage should not throw, but be defensive
        showError('Render error on page ' + n, err && err.message ? err.message : '');
      });
  }

  // ── Link annotation overlay ──────────────────────────────────────────────────
  // rawAnnots: pre-sanitization annotation array (may contain cross-origin URIs)
  // pageObj:   sanitized page dict (used for MediaBox)
  // scale:     current zoom level
  function renderLinkAnnotations(rawAnnots, pageObj, scale) {
    // Clear old links
    while (els.linkLayer.firstChild) {
      els.linkLayer.removeChild(els.linkLayer.firstChild);
    }

    if (!pageObj) return;

    // Use raw (pre-sanitize) annotations so that http/https URIs that are cross-origin
    // are still rendered as clickable links (they're safe via target=_blank + rel=noopener)
    var annots = rawAnnots;
    if (!Array.isArray(annots)) return;

    // The canvas dimensions now reflect the rendered page
    var canvasW = els.canvas.width;
    var canvasH = els.canvas.height;

    // MediaBox → [x1, y1, x2, y2]
    var mb = pageObj['/MediaBox'];
    if (!Array.isArray(mb) || mb.length < 4) mb = [0, 0, 612, 792];
    var x1 = mb[0], y1 = mb[1], x2 = mb[2], y2 = mb[3];
    var pageW = x2 - x1;
    var pageH = y2 - y1;

    // Match link-layer size to canvas
    els.linkLayer.style.width  = canvasW + 'px';
    els.linkLayer.style.height = canvasH + 'px';

    for (var i = 0; i < annots.length; i++) {
      var annot = annots[i];
      if (!annot || annot['/Subtype'] !== '/Link') continue;

      var rect = annot['/Rect'];
      if (!Array.isArray(rect) || rect.length < 4) continue;

      var action = annot['/A'];
      if (!action) continue;

      // Only handle URI actions
      if (action['/S'] !== '/URI') continue;

      var uriVal = action['/URI'];
      // /URI value may be a Uint8Array, a plain object with numeric indices (from
      // the parser's binary string representation), or already a JS string.
      var uriStr;
      if (uriVal instanceof Uint8Array) {
        uriStr = window.PDFFonts.pdfStringToText(uriVal);
      } else if (typeof uriVal === 'string') {
        uriStr = uriVal;
      } else if (uriVal && typeof uriVal === 'object' && !Array.isArray(uriVal)) {
        // Plain object with numeric keys — convert to Uint8Array
        var maxIdx = -1;
        var keys = Object.keys(uriVal);
        for (var ki = 0; ki < keys.length; ki++) {
          var idx = parseInt(keys[ki], 10);
          if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
        }
        if (maxIdx >= 0) {
          var arr = new Uint8Array(maxIdx + 1);
          for (var ki2 = 0; ki2 <= maxIdx; ki2++) {
            arr[ki2] = uriVal[ki2] || 0;
          }
          uriStr = window.PDFFonts.pdfStringToText(arr);
        } else {
          continue;
        }
      } else {
        continue;
      }

      // SECURITY: only allow http / https
      if (!(/^https?:\/\//i.test(uriStr))) continue;

      // Validate URL is safe
      try {
        var parsedUri = new URL(uriStr);
        if (parsedUri.protocol !== 'http:' && parsedUri.protocol !== 'https:') continue;
      } catch (_) {
        continue;
      }

      // Convert PDF rect (PDF coords: origin bottom-left, Y-up) → canvas coords (Y-down)
      // Canvas transform: x_canvas = (px - x1) * scale, y_canvas = (y2 - py) * scale
      var rx0 = rect[0], ry0 = rect[1], rx1 = rect[2], ry1 = rect[3];

      // Ensure rect is normalised
      var left   = Math.min(rx0, rx1);
      var right  = Math.max(rx0, rx1);
      var bottom = Math.min(ry0, ry1);
      var top    = Math.max(ry0, ry1);

      var cx0 = (left   - x1) * scale;
      var cy0 = (y2 - top)    * scale;
      var cw  = (right - left)  * scale;
      var ch  = (top - bottom)  * scale;

      // Clamp to canvas bounds
      if (cx0 < 0) cx0 = 0;
      if (cy0 < 0) cy0 = 0;
      if (cx0 + cw > canvasW) cw = canvasW - cx0;
      if (cy0 + ch > canvasH) ch = canvasH - cy0;
      if (cw <= 0 || ch <= 0) continue;

      var a = document.createElement('a');
      // SECURITY: use textContent for text, set href directly (already validated)
      a.href   = uriStr;
      a.target = '_blank';
      a.rel    = 'noopener noreferrer';
      a.style.left   = Math.round(cx0) + 'px';
      a.style.top    = Math.round(cy0) + 'px';
      a.style.width  = Math.round(cw)  + 'px';
      a.style.height = Math.round(ch)  + 'px';
      a.title = uriStr; // title uses textContent-equivalent attribute
      els.linkLayer.appendChild(a);
    }
  }

  // ── PDF load pipeline ────────────────────────────────────────────────────────
  function onPDFLoaded(arrayBuffer) {
    showLoading('Parsing PDF…');

    var parser = new window.PDFParser(arrayBuffer);
    parser.load().then(function (result) {
      if (result.error) {
        showError(
          'Failed to parse PDF.',
          result.error.message ? result.error.message.slice(0, 200) : ''
        );
        return;
      }

      // Extract raw link annotations BEFORE sanitization — link overlays
      // need the original URI values. The sanitizer would nullify cross-origin
      // URI actions (correct for auto-execute, but too strict for user-clicked links).
      // We store only /Annots arrays here; the full page dicts are sanitized below.
      var pages = result.pages || [];
      var rawAnnotsList = [];
      for (var ri = 0; ri < pages.length; ri++) {
        var pg = pages[ri];
        // Deep-copy the annotations array (shallow copy of each annot dict)
        // so that later sanitization of the page dict doesn't affect our stored copy.
        var rawA = null;
        if (pg && Array.isArray(pg['/Annots'])) {
          rawA = pg['/Annots'].map(function (ann) {
            // Copy top-level keys only (we only need /Subtype, /Rect, /A)
            if (!ann || typeof ann !== 'object') return ann;
            var copy = {};
            var ak = Object.keys(ann);
            for (var j = 0; j < ak.length; j++) {
              copy[ak[j]] = ann[ak[j]];
            }
            // Deep-copy the /A dict
            if (copy['/A'] && typeof copy['/A'] === 'object') {
              var origA = copy['/A'];
              var copyA = {};
              var akeys = Object.keys(origA);
              for (var aj = 0; aj < akeys.length; aj++) {
                copyA[akeys[aj]] = origA[akeys[aj]];
              }
              copy['/A'] = copyA;
            }
            return copy;
          });
        }
        rawAnnotsList.push(rawA);
      }

      // Belt-and-suspenders sanitization
      if (result.catalog) {
        window.PDFSecurity.sanitizeCatalog(result.catalog);
        window.PDFSecurity.sanitizeObject(result.catalog);
      }
      if (Array.isArray(pages)) {
        for (var i = 0; i < pages.length; i++) {
          window.PDFSecurity.sanitizeObject(pages[i]);
        }
      }

      state.parser    = parser;
      state.pages     = pages;
      state.rawAnnots = rawAnnotsList;
      state.pageCount = result.pageCount || state.pages.length;

      if (state.pageCount === 0) {
        showError('This PDF has no pages.');
        return;
      }

      hideError();
      updateNavUI();
      goToPage(1);

    }).catch(function (err) {
      showError(
        'PDF parsing failed.',
        err && err.message ? err.message.slice(0, 200) : ''
      );
    });
  }

  // ── URL validation + fetch ───────────────────────────────────────────────────
  function fetchPDF(fileUrl) {
    showLoading('Fetching PDF…');

    var xhr = new XMLHttpRequest();
    xhr.open('GET', fileUrl, true);
    xhr.responseType = 'arraybuffer';

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        onPDFLoaded(xhr.response);
      } else {
        showError(
          'Could not load PDF.',
          'HTTP ' + xhr.status + ': ' + xhr.statusText
        );
      }
    };

    xhr.onerror = function () {
      showError('Network error loading PDF.', 'Check that the file URL is accessible.');
    };

    xhr.onabort = function () {
      showError('PDF load was aborted.');
    };

    xhr.send();
  }

  // ── init() — entry point ─────────────────────────────────────────────────────
  function init() {
    // Populate DOM refs
    els.toolbar        = document.getElementById('toolbar');
    els.btnPrev        = document.getElementById('btn-prev');
    els.btnNext        = document.getElementById('btn-next');
    els.pageInput      = document.getElementById('page-input');
    els.pageTotal      = document.getElementById('page-total');
    els.btnZoomIn      = document.getElementById('btn-zoom-in');
    els.btnZoomOut     = document.getElementById('btn-zoom-out');
    els.zoomLevel      = document.getElementById('zoom-level');
    els.btnDownload    = document.getElementById('btn-download');
    els.canvasContainer = document.getElementById('canvas-container');
    els.canvas         = document.getElementById('pdf-canvas');
    els.linkLayer      = document.getElementById('link-layer');
    els.loadingOverlay = document.getElementById('loading-overlay');
    els.loadingText    = document.getElementById('loading-text');
    els.errorDisplay   = document.getElementById('error-display');
    els.errorMessage   = document.getElementById('error-message');
    els.errorSub       = document.getElementById('error-sub');

    // ── Parse ?file= query parameter ───────────────────────────────────────
    var params = {};
    var search = window.location.search;
    if (search && search.length > 1) {
      var pairs = search.slice(1).split('&');
      for (var i = 0; i < pairs.length; i++) {
        var eq = pairs[i].indexOf('=');
        if (eq >= 0) {
          var key = decodeURIComponent(pairs[i].slice(0, eq));
          var val = decodeURIComponent(pairs[i].slice(eq + 1));
          params[key] = val;
        }
      }
    }

    var fileParam = params['file'] || null;

    if (!fileParam) {
      showError('No PDF file specified.', 'Add ?file=<url> to the viewer URL.');
      return;
    }

    // ── Validate URL via PDFSecurity ─────────────────────────────────────────
    // validateURL returns boolean: true = safe, false = rejected
    var urlIsValid = window.PDFSecurity.validateURL(fileParam);
    if (!urlIsValid) {
      // SECURITY: use textContent for any user-derived strings
      // Detect specific rejection reasons for better UX
      var lowerParam = fileParam.trim().toLowerCase();
      var reason;
      if (lowerParam.startsWith('javascript:') ||
          lowerParam.startsWith('data:') ||
          lowerParam.startsWith('blob:') ||
          lowerParam.startsWith('file:')) {
        reason = 'Unsafe URL scheme is not permitted.';
      } else {
        reason = 'The file URL did not pass security validation.';
      }
      showError('cross-origin file not allowed', reason);
      return;
    }

    state.fileUrl = fileParam;

    // ── Wire up toolbar event handlers ────────────────────────────────────────

    els.btnPrev.addEventListener('click', function () {
      if (state.rendering) return;
      goToPage(state.currentPage - 1);
    });

    els.btnNext.addEventListener('click', function () {
      if (state.rendering) return;
      goToPage(state.currentPage + 1);
    });

    els.pageInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) {
        var n = parseInt(els.pageInput.value, 10);
        if (!isNaN(n)) goToPage(n);
      }
    });

    els.pageInput.addEventListener('blur', function () {
      var n = parseInt(els.pageInput.value, 10);
      if (!isNaN(n)) {
        goToPage(n);
      } else {
        els.pageInput.value = state.currentPage;
      }
    });

    els.btnZoomIn.addEventListener('click', function () {
      if (state.zoomIndex < ZOOM_INDEX_MAX) {
        state.zoomIndex++;
        goToPage(state.currentPage);
      }
    });

    els.btnZoomOut.addEventListener('click', function () {
      if (state.zoomIndex > ZOOM_INDEX_MIN) {
        state.zoomIndex--;
        goToPage(state.currentPage);
      }
    });

    els.btnDownload.addEventListener('click', function () {
      // Simply open the raw PDF URL — browser handles download
      if (state.fileUrl) {
        window.open(state.fileUrl);
      }
    });

    // ── Begin fetch ──────────────────────────────────────────────────────────
    fetchPDF(state.fileUrl);
  }

  // ── Bootstrap on DOM ready ───────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());
