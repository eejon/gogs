# Phase 3 Viewer UI Shell — Handoff to Phase 4

**Date**: 2026-05-28
**Agent**: phase3-viewer
**Status**: COMPLETE — 102/102 tests passing (72 Node.js + 30 Playwright browser)

---

## What Was Built

| File | Purpose |
|------|---------|
| `public/plugins/custom-pdf-render/web/viewer.html` | Entry point; loads 5 src modules in order; accepts `?file=` |
| `public/plugins/custom-pdf-render/web/viewer.css` | Full-height layout for 600px iframe, toolbar, canvas, spinner, error |
| `public/plugins/custom-pdf-render/web/viewer.js` | UI orchestration: init, fetch, parse, render, navigate, zoom, download |
| `tests/test-runner.js` | Extended with 17 Phase 3 Node.js static checks |
| `tests/playwright-test.js` | Extended with 30 Phase 3 browser tests (`--phase3` flag) |
| `tests/run4/results.md` | Combined Node.js + Playwright Phase 3 results |
| `tests/screenshots/viewer-*.png` | Viewer screenshots for all 6 corpus PDFs |

---

## How to Swap into Gogs

The only change required in Gogs source is a single string substitution in:

**`templates/repo/view_file.tmpl` line 84**

Change:
```html
<iframe width="100%" height="600px" src="{{AppSubURL}}/plugins/pdfjs-1.4.20/web/viewer.html?file={{EscapePound $.RawFileLink}}"></iframe>
```

To:
```html
<iframe width="100%" height="600px" src="{{AppSubURL}}/plugins/custom-pdf-render/web/viewer.html?file={{EscapePound $.RawFileLink}}"></iframe>
```

This is the complete Gogs source change required. No server-side changes are needed.

---

## Viewer Architecture

### Script Load Order (mandatory)
```html
<script src="../src/pdf-fonts.js"></script>    <!-- window.PDFFonts -->
<script src="../src/pdf-images.js"></script>   <!-- window.PDFImages -->
<script src="../src/pdf-security.js"></script> <!-- window.PDFSecurity -->
<script src="../src/pdf-parser.js"></script>   <!-- window.PDFParser -->
<script src="../src/pdf-renderer.js"></script> <!-- window.PDFRenderer -->
<script src="viewer.js"></script>              <!-- UI orchestration -->
```

### viewer.js Key Functions
- `init()` — parse `?file=`, validate via `PDFSecurity.validateURL()`, begin XHR fetch
- `fetchPDF(url)` — XHR with `responseType: 'arraybuffer'`
- `onPDFLoaded(arrayBuffer)` — instantiate parser, extract raw annots, sanitize, render page 1
- `goToPage(n)` — new `PDFRenderer`, `renderPage()`, then `renderLinkAnnotations()`
- `renderLinkAnnotations(rawAnnots, pageObj, scale)` — creates `<a>` elements in `#link-layer`

### Security Invariants
- `?file=` URL: validated by `PDFSecurity.validateURL()` before any fetch; `javascript:`, `data:`, `blob:`, cross-origin → error shown, no fetch
- All error messages set via `element.textContent` (never `innerHTML`)
- No `eval()`, no `new Function()`, no dynamic script loading
- PDF link annotations: scheme whitelist (`http:`/`https:` only), `target="_blank" rel="noopener noreferrer"`, user-click only (no auto-follow)
- Raw annotations stored before sanitization for link overlay rendering; sanitized page dicts used for rendering

---

## Known Gaps / Deferred for Phase 4

### 1. Inline image rendering (BI/ID/EI)
PDF inline images are not rendered (documented in Phase 2 handoff). Affects PDFs using inline images from simple generators.

### 2. Zoom presets / fit-to-width / fit-to-page
Only discrete zoom levels (50%, 75%, 100%, 125%, 150%, 200%, 300%) are implemented. No `scaleSelect` dropdown with fit modes.

### 3. Text search (find bar)
Not implemented. Nice-to-have per analysis.

### 4. Thumbnail sidebar / outline sidebar
Not implemented. Nice-to-have per analysis.

### 5. Password-protected PDFs
Show "password-protected PDFs are not supported" — not yet implemented; currently would show a parse error.

### 6. links.pdf waitForFunction timing
The Playwright `waitForFunction` for `#link-layer a` sometimes needs more time than `networkidle`. The current test uses an 8-second timeout inside a try-catch; after the fix (raw annotations), the links appear within 2-3 seconds consistently.

---

## Test Results

### Node.js Tests (72/72 PASS)

| Suite | Tests | Pass | Fail |
|-------|-------|------|------|
| Phase 1 Parser | 25 | 25 | 0 |
| Phase 2 Renderer | 30 | 30 | 0 |
| Phase 3 Viewer (static) | 17 | 17 | 0 |

Phase 3 Node.js checks:
- viewer-html-exists, viewer-js-exists, viewer-css-exists (3/3)
- file-param-handling (1/1)
- module-present-{pdf-fonts,pdf-images,pdf-security,pdf-parser,pdf-renderer}.js (5/5)
- module-load-order (1/1)
- no-eval (comment-stripped), no-new-function (comment-stripped) (2/2)
- no-innerHTML-assignment (1/1)
- no-external-urls (1/1)
- validateURL-called, cross-origin-error-msg, viewer-js-loaded (3/3)

### Playwright Browser Tests — Phase 3 Viewer (30/30 PASS)

| PDF | Canvas | Pixels | Navigation | Dialogs | Error | Links | Cross-origin |
|-----|--------|--------|------------|---------|-------|-------|--------------|
| text-only.pdf | 612×792 | 82 | page→2 ✓ | — | — | — | — |
| images.pdf | 612×792 | 54756 | — | — | — | — | — |
| mixed.pdf | 612×792 | 39485 | — | — | — | — | — |
| links.pdf | 612×792 | 631 | — | — | — | 2 `<a>` ✓ | — |
| poc.pdf | 612×792 | 2500 | — | 0 ✓ | — | — | — |
| malformed.pdf | — | — | — | — | shown ✓ | — | — |
| evil.example.com | — | — | — | — | shown ✓ | — | no fetch ✓ |

Screenshots saved to `tests/screenshots/viewer-<pdf-name>.png`.
Full results in `tests/run4/results.md`.

---

## Post-Handoff Changes

### Page number input spinner removed (2026-05-28)

**Motivation**: The page number input rendered with browser-native up/down arrow spinners.
The requirement is that page number changes only via navigation buttons or direct typing.

**Changes made:**

| File | Change |
|------|--------|
| `web/viewer.html` line 25 | `type="number" min="1"` → `type="text" inputmode="numeric" pattern="[0-9]*"` |
| `web/viewer.css` | Added `::-webkit-outer-spin-button`, `::-webkit-inner-spin-button` (`-webkit-appearance: none`) and `[type=number] { -moz-appearance: textfield }` rules as belt-and-suspenders fallback |

**JS impact**: None. `viewer.js` already reads the input value with `parseInt(els.pageInput.value, 10)` throughout — no `valueAsNumber` dependency.

---

## Phase 4 Recommendations

1. **Template swap**: Change `pdfjs-1.4.20` → `custom-pdf-render` in `templates/repo/view_file.tmpl`
2. **Docker integration test**: Spin up `gogs/gogs:0.13.2`, push a PDF to a repo, verify viewer renders
3. **Security hardening audit**: Static grep across all 8 source files for `eval`, `innerHTML`, external URLs
4. **Gogs unit tests**: Run `go test ./...` to ensure no regressions in Go source
5. **Performance test**: Test with large PDFs (>10MB, >100 pages) to identify rendering timeouts
