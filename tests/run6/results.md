# Phase 3 Browser Test Results (Playwright)

**Date**: 2026-06-10T02:16:24.765Z

## Summary

| Total | Pass | Fail |
|-------|------|------|
| 23 | 23 | 0 |

## Per-Test Results

| Test | Status | Notes |
|------|--------|-------|
| browser/playwright-load | PASS | Playwright module loaded |
| browser/chromium-launched | PASS | Chromium launched in headless mode |
| browser/text-only.pdf/screenshot | PASS | Screenshot saved: /home/eejon/Desktop/phase4-review/gogs/tests/screenshots/text-only.png |
| browser/text-only.pdf/canvas-rendered | PASS | Canvas 780x1010 has 15 non-white pixels in sample region |
| browser/text-only.pdf/no-error | PASS | No error overlay shown |
| browser/images.pdf/screenshot | PASS | Screenshot saved: /home/eejon/Desktop/phase4-review/gogs/tests/screenshots/images.png |
| browser/images.pdf/canvas-rendered | PASS | Canvas 780x1010 has 21866 non-white pixels in sample region |
| browser/images.pdf/no-error | PASS | No error overlay shown |
| browser/mixed.pdf/screenshot | PASS | Screenshot saved: /home/eejon/Desktop/phase4-review/gogs/tests/screenshots/mixed.png |
| browser/mixed.pdf/canvas-rendered | PASS | Canvas 780x1010 has 41220 non-white pixels in sample region |
| browser/mixed.pdf/no-error | PASS | No error overlay shown |
| browser/links.pdf/screenshot | PASS | Screenshot saved: /home/eejon/Desktop/phase4-review/gogs/tests/screenshots/links.png |
| browser/links.pdf/canvas-rendered | PASS | Canvas 780x1010 has 26 non-white pixels in sample region |
| browser/links.pdf/no-error | PASS | No error overlay shown |
| browser/poc.pdf/screenshot | PASS | Screenshot saved: /home/eejon/Desktop/phase4-review/gogs/tests/screenshots/poc.png |
| browser/poc.pdf/canvas-rendered | PASS | WARN: Canvas has pixels but all sampled are white -- possibly blank area sampled |
| browser/poc.pdf/no-error | PASS | No error overlay shown |
| browser/poc.pdf/no-js-dialog | PASS | No alert/confirm/prompt dialog fired (JS execution blocked) |
| browser/malformed.pdf/screenshot | PASS | Screenshot saved: /home/eejon/Desktop/phase4-review/gogs/tests/screenshots/malformed.png |
| browser/malformed.pdf/error-or-graceful | PASS | Malformed PDF partially parsed and rendered without crash (graceful degradation) |
| browser/malformed.pdf/no-crash | PASS | Page still functional after malformed PDF |
| browser/no-file-param | PASS | Error shown when no ?file= parameter provided |
| browser/cross-origin-blocked | PASS | Cross-origin URL blocked: Invalid file URL |
