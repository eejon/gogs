# Phase 3 Handoff: Viewer UI and Entry Point

## What Was Built

Four files implementing the complete PDF viewer entry point:

### Files

| File | Purpose | Lines (approx) |
|------|---------|-------|
| `public/plugins/custom-pdf-render/web/viewer.html` | HTML structure: toolbar, canvas container, loading/error overlays | ~90 |
| `public/plugins/custom-pdf-render/web/viewer.css` | Viewer styles for iframe embedding (width 100%, height 600px) | ~310 |
| `public/plugins/custom-pdf-render/web/viewer.js` | Entry point: URL parsing, fetch, render orchestration, navigation, zoom, keyboard | ~600 |
| `public/plugins/custom-pdf-render/lib/pdf-annotations.js` | Link annotation extraction and DOM overlay creation | ~280 |
| `tests/test-runner.js` | Updated: 207 tests total (165 Phase 1+2a+2b + 42 Phase 3) | ~2700 |

## Public Interface

### PDFAnnotations (lib/pdf-annotations.js)

```javascript
// Extract link annotations from a page
PDFAnnotations.getPageAnnotations(doc, pageNum);
// doc: PDFDocument instance
// pageNum: 1-based page number
// -> Array of { rect: [x1,y1,x2,y2], type: 'uri'|'goto', uri: string|null, dest: number|null }

// Create a positioned DOM overlay with clickable link elements
PDFAnnotations.createAnnotationOverlay(annotations, pageWidth, pageHeight, scale, onGoTo);
// annotations: Array from getPageAnnotations()
// pageWidth/pageHeight: in PDF points
// scale: current zoom scale
// onGoTo: function(pageNum) callback for internal GoTo links
// -> HTMLDivElement with positioned <a> elements

// Resolve a PDF destination to a page number
PDFAnnotations.resolveDestination(doc, dest);
// -> 1-based page number or null

// Find page number for a page reference
PDFAnnotations.findPageNumber(doc, pageRef);
// -> 1-based page number or null
```

### viewer.js (IIFE - no global exports)

The viewer.js file is an immediately-invoked function expression that:
1. Reads `?file=` from `window.location.search`
2. Validates the URL via `PDFSecurity.validateFileUrl()`
3. Fetches PDF bytes via `fetch()` with `credentials: 'same-origin'`
4. Parses via `new PDFParser.PDFDocument(buffer).parse()`
5. Renders via `PDFRenderer.renderPage(doc, pageNum, canvas, scale)`
6. Creates annotation overlays via `PDFAnnotations`
7. Wires up toolbar controls, keyboard shortcuts, and scroll-based lazy rendering

### viewer.html

Entry point loaded in iframe. Accepts `?file=` query parameter exactly as PDF.js viewer.html does. Loads all lib/ scripts in dependency order, then viewer.js.

The iframe in `templates/repo/view_file.tmpl` needs only a path change:
```
- src="{{AppSubURL}}/plugins/pdfjs-1.4.20/web/viewer.html?file=..."
+ src="{{AppSubURL}}/plugins/custom-pdf-render/web/viewer.html?file=..."
```

## Features Implemented

### Toolbar
- Previous/Next page buttons with disabled states at bounds
- Page number input with Enter-to-jump and change handler
- Total page count display ("of N")
- Zoom out/in buttons with stepped zoom levels
- Zoom select dropdown: Fit Width (default), Fit Page, 50%-400% presets, custom percentage

### Page Display
- Scroll-based multi-page viewing (all pages rendered in a vertical scroll container)
- Lazy rendering: only pages in or near the viewport are rendered
- Scroll-position tracking updates the current page number in the toolbar
- White page backgrounds with subtle drop shadows on gray background

### Zoom
- Fit Width (default): scales page to fill container width minus margins
- Fit Page: scales page to fit within container width and height
- Manual zoom levels: 50%, 75%, 100%, 125%, 150%, 200%, 300%, 400%
- Zoom in/out buttons step through predefined levels
- Canvas size limits enforced: 16384px max dimension, 256MP max area

### Navigation
- Previous/Next buttons with bounds enforcement
- Direct page number input (type number, press Enter)
- Keyboard shortcuts: Left/PageUp = prev, Right/PageDown = next, Home = first, End = last
- Ctrl+Plus = zoom in, Ctrl+Minus = zoom out, Ctrl+0 = fit-width
- GoTo annotations scroll to target page

### Link Annotations
- Extracts /Annots from page dictionaries
- Filters through PDFSecurity.filterAnnotation() for safety
- Creates positioned `<a>` elements over link rectangles
- URI links: href with `target="_blank" rel="noopener noreferrer"`
- GoTo links: navigate to target page via callback
- URI scheme sanitization: only http, https, mailto allowed
- Hover effect: subtle yellow highlight over link areas

### Loading States
- Spinner overlay with "Loading PDF..." text during fetch/parse
- Progress bar in toolbar area (10% on start, 50% on download, 75% on parse, 100% on render)
- Automatic hiding on completion or error

### Error Display
- User-friendly error messages for common failures
- Specific messages for: 404, 403, network error, invalid PDF, corrupted structure, timeout
- Collapsible "Show Details" section with technical error message
- Dark-themed error box matching toolbar style

### Security
- No eval(), Function(), document.write() anywhere
- No innerHTML, outerHTML, insertAdjacentHTML
- No access to window.parent, window.top, parent.document
- No history.pushState/replaceState, no location.hash manipulation
- No document.title modification
- Only one fetch() call for PDF loading, with same-origin credentials
- All link annotations sanitized through PDFSecurity
- Canvas-only rendering (pixel data is inert, cannot cause XSS)

### Iframe Compatibility
- Does not change parent page title
- Does not manipulate browser history
- Does not attempt to break out of iframe
- All external links open in new tab
- Responsive layout adapts to 100% width, 600px height iframe
- No inline event handlers in HTML

## Assumptions Made

1. **Scroll-based viewing over single-page**: Multi-page PDFs display as a scrollable list rather than single-page view. This provides a better reading experience in the 600px iframe and matches modern PDF viewer expectations.

2. **Lazy rendering buffer**: Pages within one viewport height above/below the visible area are pre-rendered. This balances memory usage with smooth scrolling.

3. **Fit-width as default**: Since the viewer is always in a fixed-height iframe, fitting to width provides the most useful default view.

4. **Named destinations not resolved**: String-based named destinations (e.g., from outline/bookmarks) are not resolved to page numbers. This would require traversing the catalog's Names/Dests name tree. Most link annotations in the corpus use explicit page reference arrays.

5. **No text selection layer**: Text is rendered directly to canvas pixels. A transparent text layer for selection/copy would require tracking all text positions during rendering. This is deferred as non-essential per the analysis.

6. **Canvas size safety**: Large zoom levels or very large pages could exceed browser canvas limits. The enforceCanvasLimits function caps dimensions at 16384px and area at 256MP, re-rendering at reduced scale if needed.

7. **Debounced scroll/resize**: Scroll-based rendering uses a 150ms debounce to avoid excessive re-renders during fast scrolling. Resize uses 200ms debounce.

8. **IIFE pattern for viewer.js**: The entire viewer.js is wrapped in an IIFE to avoid polluting the global scope. All state and functions are private to the closure.

## Known Gaps / Deferred Decisions

1. **Browser-level testing**: Phase 3 tests are all Node.js-level (file existence, source code analysis, module API). Playwright browser-level tests (canvas pixel checks, dialog intercept for XSS, actual rendering verification) should be added in Phase 4 integration testing.

2. **Print support**: Basic print CSS is included (hides toolbar, removes shadows, page-break-after: always), but actual print rendering may need page-by-page canvas-to-image conversion for reliable cross-browser printing.

3. **Async JPEG rendering in annotations**: When a page with annotations also has JPEG images, the annotation overlay is created after the canvas render call returns, but JPEG images load asynchronously. The overlay positioning is still correct since it's based on page dimensions, not canvas content.

4. **Resize handling for custom zoom**: When the window resizes and the user is at a custom zoom level (not fit-width/fit-page), the zoom level is preserved and pages are not re-rendered. Only fit-width/fit-page modes recalculate on resize.

5. **Named destination resolution**: GoTo actions with named string destinations return null, preventing page navigation. This affects documents that use named destinations in their internal links (uncommon in the test corpus).

6. **Page rotation in annotation overlay**: Annotation rectangles are positioned assuming no page rotation. For rotated pages (90/180/270), the annotation positions may be incorrect. This would need coordinate transform matching the canvas rotation.

## Test Results

All 207 tests pass:

### Phase 1 tests (81 tests, unchanged)
- P01-P10, S01-S06, Links, Predictor, String tests

### Phase 2a tests (44 tests, unchanged)
- R01-R08

### Phase 2b tests (40 tests, unchanged)
- R09-R15

### Phase 3 tests (42 tests, new)
- V01: Viewer URL parsing and file parameter (10)
- V02: Viewer page navigation (5)
- V03: Viewer zoom controls (5)
- V04: Annotation overlay (12)
- V05: Viewer security (10)

### Test output location
- `tests/run2/results.md`
