/**
 * PDF Viewer Entry Point
 *
 * Orchestrates the full PDF viewing experience:
 *   1. Parse ?file= query parameter and validate URL
 *   2. Fetch PDF bytes
 *   3. Parse and render using the lib/ modules
 *   4. Wire up navigation, zoom, and keyboard controls
 *   5. Handle link annotations
 *   6. Display loading/error states
 *
 * Designed to work inside a Gogs iframe (width="100%" height="600px").
 * Does not change parent page title, manipulate history, or break out of iframe.
 *
 * Dependencies (loaded via <script> tags in viewer.html before this file):
 *   - PDFStreamDecoders (lib/pdf-stream.js)
 *   - PDFSecurity (lib/pdf-security.js)
 *   - PDFParser (lib/pdf-parser.js) -> provides PDFDocument via window.PDFParser
 *   - PDFFonts (lib/pdf-fonts.js)
 *   - PDFRenderer (lib/pdf-renderer.js)
 *   - PDFImages (lib/pdf-images.js)
 *   - PDFShading (lib/pdf-shading.js)
 *   - PDFAnnotations (lib/pdf-annotations.js)
 */

'use strict';

(function() {

  // ============================================================================
  // Configuration
  // ============================================================================

  var ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0];
  var ZOOM_STEP = 0.25;
  var MIN_ZOOM = 0.25;
  var MAX_ZOOM = 5.0;
  var MAX_CANVAS_DIMENSION = 16384;
  var MAX_CANVAS_AREA = 268435456; // 256 megapixels
  var SCROLL_RENDER_DELAY = 150; // ms debounce for scroll-based rendering

  // ============================================================================
  // State
  // ============================================================================

  var state = {
    doc: null,           // PDFDocument instance
    pageCount: 0,
    currentPage: 1,
    scale: 1.0,
    zoomMode: 'fit-width', // 'fit-width', 'fit-page', or 'custom'
    pdfBytes: null,      // raw ArrayBuffer
    pageCanvases: {},    // pageNum -> canvas element
    pageAnnotations: {}, // pageNum -> annotation overlay element
    isLoading: true,
    error: null,
    containerWidth: 0
  };

  // ============================================================================
  // DOM References (populated in init)
  // ============================================================================

  var dom = {};

  // ============================================================================
  // URL Parsing and Validation
  // ============================================================================

  /**
   * Extract the ?file= parameter from the current URL.
   * Handles percent-encoded values from Gogs' EscapePound function.
   *
   * @returns {string|null} The file URL or null if not found
   */
  function getFileParam() {
    var search = window.location.search;
    if (!search || search.length < 2) return null;

    // Parse query string manually (avoid URLSearchParams for broader compat)
    var params = search.substring(1).split('&');
    for (var i = 0; i < params.length; i++) {
      var pair = params[i].split('=');
      if (pair[0] === 'file' && pair.length > 1) {
        // Rejoin in case the value contained '='
        var value = pair.slice(1).join('=');
        try {
          return decodeURIComponent(value);
        } catch (e) {
          return value; // Return raw if decode fails
        }
      }
    }
    return null;
  }

  /**
   * Validate that a file URL is safe to fetch.
   * Uses PDFSecurity.validateFileUrl for the heavy lifting.
   *
   * @param {string} fileUrl - URL to validate
   * @returns {{ valid: boolean, url: string, error: string|null }}
   */
  function validateUrl(fileUrl) {
    if (!fileUrl) {
      return { valid: false, url: '', error: 'No file URL specified. Use ?file= parameter.' };
    }

    return window.PDFSecurity.validateFileUrl(fileUrl, window.location.origin);
  }

  // ============================================================================
  // PDF Loading
  // ============================================================================

  /**
   * Fetch PDF bytes from the given URL.
   *
   * @param {string} url - URL to fetch
   * @returns {Promise<ArrayBuffer>}
   */
  function fetchPDF(url) {
    return fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'follow'
    }).then(function(response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + (response.statusText || 'Failed to load PDF'));
      }
      return response.arrayBuffer();
    });
  }

  /**
   * Parse PDF bytes into a PDFDocument.
   *
   * @param {ArrayBuffer} buffer - Raw PDF bytes
   * @returns {object} PDFDocument instance
   */
  function parsePDF(buffer) {
    var PDFDocument = window.PDFParser.PDFDocument;
    var doc = new PDFDocument(buffer);
    doc.parse();
    return doc;
  }

  // ============================================================================
  // Page Rendering
  // ============================================================================

  /**
   * Calculate the effective scale for fit-width mode.
   *
   * @param {object} doc - PDFDocument
   * @param {number} pageNum - 1-based page number
   * @param {number} containerWidth - Available width in pixels
   * @returns {number} Scale factor
   */
  function calculateFitWidthScale(doc, pageNum, containerWidth) {
    var page = doc.getPage(pageNum);
    var mediaBox = page.CropBox || page.MediaBox;
    if (!mediaBox || !Array.isArray(mediaBox) || mediaBox.length < 4) return 1.0;

    var rotate = page.Rotate || 0;
    if (typeof rotate !== 'number') rotate = 0;
    rotate = ((rotate % 360) + 360) % 360;

    var pageWidth;
    if (rotate === 90 || rotate === 270) {
      pageWidth = Math.abs(mediaBox[3] - mediaBox[1]);
    } else {
      pageWidth = Math.abs(mediaBox[2] - mediaBox[0]);
    }

    if (pageWidth <= 0) return 1.0;

    // Account for padding/margin (20px total: 10px each side)
    var availableWidth = containerWidth - 20;
    if (availableWidth <= 0) availableWidth = containerWidth;

    return availableWidth / pageWidth;
  }

  /**
   * Calculate the effective scale for fit-page mode.
   *
   * @param {object} doc - PDFDocument
   * @param {number} pageNum - 1-based page number
   * @param {number} containerWidth - Available width in pixels
   * @param {number} containerHeight - Available height in pixels
   * @returns {number} Scale factor
   */
  function calculateFitPageScale(doc, pageNum, containerWidth, containerHeight) {
    var page = doc.getPage(pageNum);
    var mediaBox = page.CropBox || page.MediaBox;
    if (!mediaBox || !Array.isArray(mediaBox) || mediaBox.length < 4) return 1.0;

    var rotate = page.Rotate || 0;
    if (typeof rotate !== 'number') rotate = 0;
    rotate = ((rotate % 360) + 360) % 360;

    var pageWidth, pageHeight;
    if (rotate === 90 || rotate === 270) {
      pageWidth = Math.abs(mediaBox[3] - mediaBox[1]);
      pageHeight = Math.abs(mediaBox[2] - mediaBox[0]);
    } else {
      pageWidth = Math.abs(mediaBox[2] - mediaBox[0]);
      pageHeight = Math.abs(mediaBox[3] - mediaBox[1]);
    }

    if (pageWidth <= 0 || pageHeight <= 0) return 1.0;

    var availableWidth = containerWidth - 20;
    var availableHeight = containerHeight - 30; // Extra margin for multi-page gap

    var scaleX = availableWidth / pageWidth;
    var scaleY = availableHeight / pageHeight;

    return Math.min(scaleX, scaleY);
  }

  /**
   * Get the effective scale based on current zoom mode.
   *
   * @returns {number}
   */
  function getEffectiveScale() {
    if (!state.doc) return 1.0;

    var containerWidth = dom.viewerContainer ? dom.viewerContainer.clientWidth : 600;
    var containerHeight = dom.viewerContainer ? dom.viewerContainer.clientHeight : 400;

    if (state.zoomMode === 'fit-width') {
      return calculateFitWidthScale(state.doc, state.currentPage, containerWidth);
    } else if (state.zoomMode === 'fit-page') {
      return calculateFitPageScale(state.doc, state.currentPage, containerWidth, containerHeight);
    } else {
      return state.scale;
    }
  }

  /**
   * Enforce canvas size limits.
   *
   * @param {number} width - Desired canvas width
   * @param {number} height - Desired canvas height
   * @param {number} scale - Current scale
   * @returns {{ width: number, height: number, scale: number }} Adjusted values
   */
  function enforceCanvasLimits(width, height, scale) {
    var w = Math.ceil(width);
    var h = Math.ceil(height);

    // Enforce dimension limits
    if (w > MAX_CANVAS_DIMENSION || h > MAX_CANVAS_DIMENSION) {
      var ratio = Math.min(MAX_CANVAS_DIMENSION / w, MAX_CANVAS_DIMENSION / h);
      scale = scale * ratio;
      w = Math.ceil(width * ratio / (width / w));
      h = Math.ceil(height * ratio / (height / h));
    }

    // Enforce area limit
    if (w * h > MAX_CANVAS_AREA) {
      var areaRatio = Math.sqrt(MAX_CANVAS_AREA / (w * h));
      scale = scale * areaRatio;
      w = Math.ceil(w * areaRatio);
      h = Math.ceil(h * areaRatio);
    }

    return { width: w, height: h, scale: scale };
  }

  /**
   * Render a single page to a canvas element.
   *
   * @param {number} pageNum - 1-based page number
   * @param {number} scale - Render scale
   * @returns {{ canvas: HTMLCanvasElement, width: number, height: number }}
   */
  function renderPageToCanvas(pageNum, scale) {
    var canvas = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';

    try {
      var result = window.PDFRenderer.renderPage(state.doc, pageNum, canvas, scale);

      // Enforce canvas limits
      var limits = enforceCanvasLimits(result.width, result.height, scale);
      if (limits.scale !== scale) {
        // Re-render at reduced scale
        result = window.PDFRenderer.renderPage(state.doc, pageNum, canvas, limits.scale);
      }

      return { canvas: canvas, width: result.width, height: result.height };
    } catch (e) {
      // On render error, show a placeholder
      var page = state.doc.getPage(pageNum);
      var mediaBox = page.CropBox || page.MediaBox || [0, 0, 612, 792];
      var w = Math.abs(mediaBox[2] - mediaBox[0]) * scale;
      var h = Math.abs(mediaBox[3] - mediaBox[1]) * scale;
      canvas.width = Math.ceil(w);
      canvas.height = Math.ceil(h);

      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#cc0000';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Error rendering page ' + pageNum, canvas.width / 2, canvas.height / 2 - 10);
      ctx.fillStyle = '#666';
      ctx.font = '11px sans-serif';
      ctx.fillText(e.message || 'Unknown error', canvas.width / 2, canvas.height / 2 + 10);

      return { canvas: canvas, width: canvas.width, height: canvas.height };
    }
  }

  /**
   * Get the page dimensions (accounting for rotation) in PDF points.
   *
   * @param {number} pageNum - 1-based page number
   * @returns {{ width: number, height: number }}
   */
  function getPageDimensions(pageNum) {
    var page = state.doc.getPage(pageNum);
    var mediaBox = page.CropBox || page.MediaBox || [0, 0, 612, 792];
    var rotate = page.Rotate || 0;
    if (typeof rotate !== 'number') rotate = 0;
    rotate = ((rotate % 360) + 360) % 360;

    var w = Math.abs(mediaBox[2] - mediaBox[0]);
    var h = Math.abs(mediaBox[3] - mediaBox[1]);

    if (rotate === 90 || rotate === 270) {
      return { width: h, height: w };
    }
    return { width: w, height: h };
  }

  // ============================================================================
  // Page Display (Scroll-based multi-page)
  // ============================================================================

  /**
   * Render all pages for scroll-based viewing.
   * Creates page wrappers with canvases for each page.
   */
  function renderAllPages() {
    if (!state.doc || state.pageCount === 0) return;

    var scale = getEffectiveScale();
    state.scale = scale;

    // Clear existing pages
    var pagesContainer = dom.pagesContainer;
    pagesContainer.textContent = '';
    state.pageCanvases = {};
    state.pageAnnotations = {};

    for (var p = 1; p <= state.pageCount; p++) {
      var wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.setAttribute('data-page', p);

      var dims = getPageDimensions(p);
      wrapper.style.width = Math.ceil(dims.width * scale) + 'px';
      wrapper.style.height = Math.ceil(dims.height * scale) + 'px';

      // Create placeholder
      var placeholder = document.createElement('div');
      placeholder.className = 'pdf-page-placeholder';
      placeholder.style.width = '100%';
      placeholder.style.height = '100%';
      placeholder.textContent = 'Page ' + p;

      wrapper.appendChild(placeholder);
      pagesContainer.appendChild(wrapper);
    }

    // Render visible pages
    renderVisiblePages();
  }

  /**
   * Render pages that are currently visible in the scroll viewport.
   * Uses IntersectionObserver-like logic based on scroll position.
   */
  function renderVisiblePages() {
    if (!state.doc || !dom.viewerContainer) return;

    var container = dom.viewerContainer;
    var scrollTop = container.scrollTop;
    var viewportHeight = container.clientHeight;
    var viewportTop = scrollTop - viewportHeight; // Render one viewport above
    var viewportBottom = scrollTop + viewportHeight * 2; // Render one viewport below

    var wrappers = dom.pagesContainer.children;
    for (var i = 0; i < wrappers.length; i++) {
      var wrapper = wrappers[i];
      var pageNum = parseInt(wrapper.getAttribute('data-page'), 10);
      if (isNaN(pageNum)) continue;

      var wrapperTop = wrapper.offsetTop;
      var wrapperBottom = wrapperTop + wrapper.offsetHeight;

      // Check if this page is in the render zone
      if (wrapperBottom >= viewportTop && wrapperTop <= viewportBottom) {
        renderPageIntoWrapper(wrapper, pageNum);
      }
    }

    // Update current page based on scroll position
    updateCurrentPageFromScroll();
  }

  /**
   * Render a page into its wrapper if not already rendered.
   *
   * @param {HTMLElement} wrapper - Page wrapper element
   * @param {number} pageNum - 1-based page number
   */
  function renderPageIntoWrapper(wrapper, pageNum) {
    // Skip if already rendered
    if (state.pageCanvases[pageNum]) return;

    var scale = state.scale;
    var result = renderPageToCanvas(pageNum, scale);

    // Clear placeholder
    wrapper.textContent = '';
    wrapper.style.width = result.width + 'px';
    wrapper.style.height = result.height + 'px';

    wrapper.appendChild(result.canvas);
    state.pageCanvases[pageNum] = result.canvas;

    // Add annotation overlay
    addAnnotationOverlay(wrapper, pageNum, scale);
  }

  /**
   * Add annotation overlay to a page wrapper.
   *
   * @param {HTMLElement} wrapper - Page wrapper element
   * @param {number} pageNum - 1-based page number
   * @param {number} scale - Current scale
   */
  function addAnnotationOverlay(wrapper, pageNum, scale) {
    if (!window.PDFAnnotations) return;

    try {
      var annotations = window.PDFAnnotations.getPageAnnotations(state.doc, pageNum);
      if (annotations.length === 0) return;

      var dims = getPageDimensions(pageNum);
      var overlay = window.PDFAnnotations.createAnnotationOverlay(
        annotations,
        dims.width,
        dims.height,
        scale,
        function(targetPage) {
          goToPage(targetPage);
        }
      );

      wrapper.appendChild(overlay);
      state.pageAnnotations[pageNum] = overlay;
    } catch (e) {
      // Non-fatal: annotations just won't be clickable
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('Failed to create annotation overlay for page ' + pageNum + ': ' + e.message);
      }
    }
  }

  /**
   * Update the current page number based on scroll position.
   */
  function updateCurrentPageFromScroll() {
    if (!dom.viewerContainer || !dom.pagesContainer) return;

    var container = dom.viewerContainer;
    var scrollTop = container.scrollTop;
    var viewportCenter = scrollTop + container.clientHeight / 2;

    var wrappers = dom.pagesContainer.children;
    var closestPage = 1;
    var closestDist = Infinity;

    for (var i = 0; i < wrappers.length; i++) {
      var wrapper = wrappers[i];
      var pageNum = parseInt(wrapper.getAttribute('data-page'), 10);
      if (isNaN(pageNum)) continue;

      var wrapperCenter = wrapper.offsetTop + wrapper.offsetHeight / 2;
      var dist = Math.abs(wrapperCenter - viewportCenter);

      if (dist < closestDist) {
        closestDist = dist;
        closestPage = pageNum;
      }
    }

    if (closestPage !== state.currentPage) {
      state.currentPage = closestPage;
      updatePageDisplay();
    }
  }

  // ============================================================================
  // Navigation
  // ============================================================================

  /**
   * Navigate to a specific page number.
   *
   * @param {number} pageNum - 1-based page number
   */
  function goToPage(pageNum) {
    if (!state.doc) return;

    pageNum = Math.max(1, Math.min(pageNum, state.pageCount));
    state.currentPage = pageNum;

    // Scroll to the page
    var wrappers = dom.pagesContainer.children;
    for (var i = 0; i < wrappers.length; i++) {
      var p = parseInt(wrappers[i].getAttribute('data-page'), 10);
      if (p === pageNum) {
        wrappers[i].scrollIntoView({ behavior: 'auto', block: 'start' });
        break;
      }
    }

    // Ensure the page is rendered
    renderVisiblePages();
    updatePageDisplay();
  }

  function goToPreviousPage() {
    if (state.currentPage > 1) {
      goToPage(state.currentPage - 1);
    }
  }

  function goToNextPage() {
    if (state.currentPage < state.pageCount) {
      goToPage(state.currentPage + 1);
    }
  }

  /**
   * Update the page number display and button states.
   */
  function updatePageDisplay() {
    if (dom.pageInput) {
      dom.pageInput.value = state.currentPage;
    }
    if (dom.pageTotal) {
      dom.pageTotal.textContent = 'of ' + state.pageCount;
    }
    if (dom.prevBtn) {
      dom.prevBtn.disabled = state.currentPage <= 1;
    }
    if (dom.nextBtn) {
      dom.nextBtn.disabled = state.currentPage >= state.pageCount;
    }
  }

  // ============================================================================
  // Zoom
  // ============================================================================

  /**
   * Set zoom to a specific scale value.
   *
   * @param {number} newScale - Scale factor
   */
  function setZoom(newScale) {
    newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newScale));
    state.scale = newScale;
    state.zoomMode = 'custom';
    updateZoomDisplay();
    reRenderAllPages();
  }

  /**
   * Set zoom mode (fit-width, fit-page).
   *
   * @param {string} mode - Zoom mode
   */
  function setZoomMode(mode) {
    state.zoomMode = mode;
    state.scale = getEffectiveScale();
    updateZoomDisplay();
    reRenderAllPages();
  }

  function zoomIn() {
    var currentScale = getEffectiveScale();
    // Find the next zoom level above current
    for (var i = 0; i < ZOOM_LEVELS.length; i++) {
      if (ZOOM_LEVELS[i] > currentScale + 0.01) {
        setZoom(ZOOM_LEVELS[i]);
        return;
      }
    }
    // If beyond all presets, step up
    setZoom(currentScale + ZOOM_STEP);
  }

  function zoomOut() {
    var currentScale = getEffectiveScale();
    // Find the next zoom level below current
    for (var i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
      if (ZOOM_LEVELS[i] < currentScale - 0.01) {
        setZoom(ZOOM_LEVELS[i]);
        return;
      }
    }
    // If below all presets, step down
    setZoom(currentScale - ZOOM_STEP);
  }

  /**
   * Update zoom select/display.
   */
  function updateZoomDisplay() {
    if (!dom.zoomSelect) return;

    var effectiveScale = getEffectiveScale();
    var percent = Math.round(effectiveScale * 100);

    // Check if a preset matches
    var matched = false;
    var options = dom.zoomSelect.options;
    for (var i = 0; i < options.length; i++) {
      if (options[i].value === state.zoomMode) {
        dom.zoomSelect.selectedIndex = i;
        matched = true;
        break;
      }
      if (state.zoomMode === 'custom') {
        var optVal = parseFloat(options[i].value);
        if (!isNaN(optVal) && Math.abs(optVal - effectiveScale) < 0.01) {
          dom.zoomSelect.selectedIndex = i;
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      // Set the custom option text
      var customOpt = dom.zoomSelect.querySelector('option[value="custom"]');
      if (customOpt) {
        customOpt.textContent = percent + '%';
        customOpt.selected = true;
      }
    }
  }

  /**
   * Re-render all pages after zoom change.
   */
  function reRenderAllPages() {
    // Clear cached canvases so they re-render
    state.pageCanvases = {};
    state.pageAnnotations = {};

    // Remember current scroll position relative to current page
    var scrollPage = state.currentPage;

    renderAllPages();

    // Scroll back to the page we were on
    goToPage(scrollPage);
  }

  // ============================================================================
  // UI State Management
  // ============================================================================

  /**
   * Show the loading indicator.
   *
   * @param {string} [text] - Loading text
   */
  function showLoading(text) {
    if (dom.loading) {
      dom.loading.classList.remove('hidden');
      if (dom.loadingText) {
        dom.loadingText.textContent = text || 'Loading PDF...';
      }
    }
    state.isLoading = true;
  }

  /**
   * Hide the loading indicator.
   */
  function hideLoading() {
    if (dom.loading) {
      dom.loading.classList.add('hidden');
    }
    state.isLoading = false;
  }

  /**
   * Show loading bar progress.
   *
   * @param {number} progress - 0 to 100
   */
  function showLoadingBar(progress) {
    if (dom.loadingBar) {
      dom.loadingBar.classList.remove('hidden');
      if (dom.loadingBarProgress) {
        dom.loadingBarProgress.style.width = Math.min(100, Math.max(0, progress)) + '%';
      }
    }
  }

  /**
   * Hide the loading bar.
   */
  function hideLoadingBar() {
    if (dom.loadingBar) {
      dom.loadingBar.classList.add('hidden');
    }
  }

  /**
   * Show an error message.
   *
   * @param {string} message - User-friendly error message
   * @param {string} [details] - Technical details (shown behind toggle)
   */
  function showError(message, details) {
    hideLoading();
    hideLoadingBar();

    if (dom.error) {
      dom.error.classList.remove('hidden');
    }
    if (dom.errorMessage) {
      dom.errorMessage.textContent = message;
    }
    if (dom.errorDetails && details) {
      dom.errorDetails.textContent = details;
    }

    state.error = message;
  }

  /**
   * Hide the error display.
   */
  function hideError() {
    if (dom.error) {
      dom.error.classList.add('hidden');
    }
    state.error = null;
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Handle page input change (user types a page number and presses Enter).
   */
  function handlePageInput(e) {
    if (e.type === 'keydown' && e.key !== 'Enter') return;

    var val = parseInt(dom.pageInput.value, 10);
    if (isNaN(val) || val < 1) {
      val = 1;
    } else if (val > state.pageCount) {
      val = state.pageCount;
    }

    goToPage(val);
    dom.pageInput.blur();
  }

  /**
   * Handle zoom select change.
   */
  function handleZoomChange() {
    var val = dom.zoomSelect.value;

    if (val === 'fit-width') {
      setZoomMode('fit-width');
    } else if (val === 'fit-page') {
      setZoomMode('fit-page');
    } else if (val === 'custom') {
      // Do nothing - custom is set by zoom in/out
    } else {
      var numVal = parseFloat(val);
      if (!isNaN(numVal) && isFinite(numVal)) {
        setZoom(numVal);
      }
    }
  }

  /**
   * Handle keyboard shortcuts.
   */
  function handleKeydown(e) {
    // Don't handle if focus is on an input element
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) {
      return;
    }

    switch (e.key) {
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        goToPreviousPage();
        break;
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        goToNextPage();
        break;
      case 'Home':
        e.preventDefault();
        goToPage(1);
        break;
      case 'End':
        e.preventDefault();
        goToPage(state.pageCount);
        break;
      case '+':
      case '=':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          zoomIn();
        }
        break;
      case '-':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          zoomOut();
        }
        break;
      case '0':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          setZoomMode('fit-width');
        }
        break;
    }
  }

  /**
   * Debounced scroll handler for lazy page rendering.
   */
  var scrollTimer = null;
  function handleScroll() {
    if (scrollTimer) {
      clearTimeout(scrollTimer);
    }
    scrollTimer = setTimeout(function() {
      renderVisiblePages();
    }, SCROLL_RENDER_DELAY);
  }

  /**
   * Handle window resize.
   */
  var resizeTimer = null;
  function handleResize() {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(function() {
      if (state.zoomMode === 'fit-width' || state.zoomMode === 'fit-page') {
        reRenderAllPages();
      }
    }, 200);
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Cache DOM element references.
   */
  function cacheDOMRefs() {
    dom.viewerWrapper = document.getElementById('pdf-viewer-wrapper');
    dom.viewerContainer = document.getElementById('pdf-viewer-container');
    dom.pagesContainer = document.getElementById('pdf-pages-container');
    dom.toolbar = document.getElementById('pdf-toolbar');

    dom.prevBtn = document.getElementById('pdf-prev');
    dom.nextBtn = document.getElementById('pdf-next');
    dom.pageInput = document.getElementById('pdf-page-input');
    dom.pageTotal = document.getElementById('pdf-page-total');

    dom.zoomOutBtn = document.getElementById('pdf-zoom-out');
    dom.zoomInBtn = document.getElementById('pdf-zoom-in');
    dom.zoomSelect = document.getElementById('pdf-zoom-select');

    dom.loading = document.getElementById('pdf-loading');
    dom.loadingText = document.getElementById('pdf-loading-text');
    dom.loadingBar = document.getElementById('pdf-loading-bar');
    dom.loadingBarProgress = document.getElementById('pdf-loading-bar-progress');

    dom.error = document.getElementById('pdf-error');
    dom.errorMessage = document.getElementById('pdf-error-message');
    dom.errorDetails = document.getElementById('pdf-error-details');
    dom.errorDetailsToggle = document.getElementById('pdf-error-details-toggle');
  }

  /**
   * Wire up event listeners.
   */
  function wireEvents() {
    // Navigation
    if (dom.prevBtn) {
      dom.prevBtn.addEventListener('click', goToPreviousPage);
    }
    if (dom.nextBtn) {
      dom.nextBtn.addEventListener('click', goToNextPage);
    }
    if (dom.pageInput) {
      dom.pageInput.addEventListener('keydown', handlePageInput);
      dom.pageInput.addEventListener('change', handlePageInput);
    }

    // Zoom
    if (dom.zoomOutBtn) {
      dom.zoomOutBtn.addEventListener('click', zoomOut);
    }
    if (dom.zoomInBtn) {
      dom.zoomInBtn.addEventListener('click', zoomIn);
    }
    if (dom.zoomSelect) {
      dom.zoomSelect.addEventListener('change', handleZoomChange);
    }

    // Keyboard
    document.addEventListener('keydown', handleKeydown);

    // Scroll-based rendering
    if (dom.viewerContainer) {
      dom.viewerContainer.addEventListener('scroll', handleScroll);
    }

    // Resize
    window.addEventListener('resize', handleResize);

    // Error details toggle
    if (dom.errorDetailsToggle && dom.errorDetails) {
      dom.errorDetailsToggle.addEventListener('click', function() {
        var isVisible = dom.errorDetails.classList.contains('visible');
        if (isVisible) {
          dom.errorDetails.classList.remove('visible');
          dom.errorDetailsToggle.textContent = 'Show Details';
        } else {
          dom.errorDetails.classList.add('visible');
          dom.errorDetailsToggle.textContent = 'Hide Details';
        }
      });
    }
  }

  /**
   * Main initialization function.
   * Called when the DOM is ready.
   */
  function init() {
    cacheDOMRefs();
    wireEvents();

    // Step 1: Get file URL
    var fileUrl = getFileParam();
    var validation = validateUrl(fileUrl);

    if (!validation.valid) {
      showError(validation.error || 'Invalid file URL.');
      return;
    }

    // Step 2: Fetch PDF
    showLoading('Loading PDF...');
    showLoadingBar(10);

    fetchPDF(validation.url)
      .then(function(buffer) {
        showLoadingBar(50);
        state.pdfBytes = buffer;

        // Step 3: Parse PDF
        showLoading('Parsing PDF...');

        try {
          state.doc = parsePDF(buffer);
          state.pageCount = state.doc.getPageCount();
        } catch (e) {
          var errMsg = 'Failed to parse PDF.';
          var errDetail = e.message || String(e);

          if (errDetail.indexOf('%PDF-') !== -1 || errDetail.indexOf('magic') !== -1 ||
              errDetail.indexOf('header') !== -1) {
            errMsg = 'This file does not appear to be a valid PDF.';
          } else if (errDetail.indexOf('startxref') !== -1 || errDetail.indexOf('xref') !== -1) {
            errMsg = 'The PDF file structure is corrupted.';
          } else if (errDetail.indexOf('timeout') !== -1 || errDetail.indexOf('Timeout') !== -1) {
            errMsg = 'PDF parsing timed out. The file may be too complex.';
          }

          showError(errMsg, errDetail);
          return;
        }

        if (state.pageCount === 0) {
          showError('The PDF contains no pages.');
          return;
        }

        showLoadingBar(75);

        // Step 4: Render
        showLoading('Rendering...');

        // Use setTimeout to let the UI update before heavy rendering
        setTimeout(function() {
          try {
            hideLoading();
            hideLoadingBar();
            hideError();

            // Set default page display
            state.currentPage = 1;
            updatePageDisplay();

            // Calculate initial zoom
            state.zoomMode = 'fit-width';
            state.scale = getEffectiveScale();
            updateZoomDisplay();

            // Render pages
            renderAllPages();

            showLoadingBar(100);
            setTimeout(hideLoadingBar, 300);
          } catch (e) {
            showError('Failed to render PDF.', e.message || String(e));
          }
        }, 10);
      })
      .catch(function(err) {
        var errMsg = 'Failed to load PDF file.';
        var errDetail = err.message || String(err);

        if (errDetail.indexOf('404') !== -1) {
          errMsg = 'PDF file not found.';
        } else if (errDetail.indexOf('403') !== -1) {
          errMsg = 'Access denied. You may not have permission to view this file.';
        } else if (errDetail.indexOf('NetworkError') !== -1 || errDetail.indexOf('network') !== -1 ||
                   errDetail.indexOf('Failed to fetch') !== -1) {
          errMsg = 'Network error. Please check your connection and try again.';
        }

        showError(errMsg, errDetail);
      });
  }

  // ============================================================================
  // Bootstrap
  // ============================================================================

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
