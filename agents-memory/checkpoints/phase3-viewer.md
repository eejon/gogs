# Phase 3 Viewer UI Shell — Checkpoint

**Agent**: phase3-viewer
**Date**: 2026-05-28
**Status**: COMPLETE — all tests passing

## Components Completed

| File | Status |
|------|--------|
| `public/plugins/custom-pdf-render/web/viewer.css` | DONE |
| `public/plugins/custom-pdf-render/web/viewer.js` | DONE |
| `public/plugins/custom-pdf-render/web/viewer.html` | DONE |
| `tests/test-runner.js` (Phase 3 Node.js checks added) | DONE |
| `tests/playwright-test.js` (Phase 3 browser tests added) | DONE |
| `agents-memory/handoffs/phase3-viewer.md` | DONE |

## Current Component In Progress

None — all Phase 3 components complete.

## Components Remaining

None for Phase 3. Phase 4 (Integration Testing & Hardening) is next.

## Key Decisions Made

1. **Raw annotations before sanitization**: `sanitizeObject()` blocks cross-origin URI actions
   (correct for auto-execute actions). For link overlays where the user clicks, we extract
   raw annotations BEFORE sanitization and store them in `state.rawAnnots`. The link overlay
   renderer uses raw annotations with a scheme whitelist (`http://`/`https://` only), not
   the same-origin check.

2. **Plain object URI decoding**: The parser returns `/URI` values as plain objects with
   numeric indices (not `Uint8Array`). The `renderLinkAnnotations` function converts these
   to `Uint8Array` before calling `pdfStringToText()`.

3. **Error text via textContent**: All user-visible error messages use `element.textContent`
   assignment. No `innerHTML` is used anywhere in the viewer.

4. **Pixel sampling**: Phase 3 Playwright tests sample the full canvas (stepping every 4
   pixels for performance) rather than limiting to a 200×200 corner, because PDF content
   may not start at (0,0).

5. **Cross-origin request detection**: The Playwright test checks the actual request hostname
   (parsed via `new URL()`) rather than string-matching the URL, to avoid false positives
   from the viewer URL itself containing `evil.example.com` as an encoded query parameter.

6. **Comment stripping in security checks**: The Node.js static analysis tests strip HTML
   and JS comments before pattern-matching for `eval(` and `new Function(`, to avoid
   documentation comments causing false positives.
