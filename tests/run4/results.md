# Phase 3 Viewer UI Shell Test Results (Node.js Static Checks)

**Date**: 2026-05-28T02:41:12.418Z

## Summary

| Total | Pass | Fail |
|-------|------|------|
| 17 | 17 | 0 |

## Per-Test Results

| Test | Status | Notes |
|------|--------|-------|
| phase3/viewer-html-exists | PASS | /home/eejon/Desktop/phase3-replication/gogs/public/plugins/custom-pdf-render/web/viewer.html |
| phase3/viewer-js-exists | PASS | /home/eejon/Desktop/phase3-replication/gogs/public/plugins/custom-pdf-render/web/viewer.js |
| phase3/viewer-css-exists | PASS | /home/eejon/Desktop/phase3-replication/gogs/public/plugins/custom-pdf-render/web/viewer.css |
| phase3/file-param-handling | PASS | ?file= parameter referenced in viewer sources |
| phase3/module-present-pdf-fonts.js | PASS | found at char 3309 |
| phase3/module-present-pdf-images.js | PASS | found at char 3353 |
| phase3/module-present-pdf-security.js | PASS | found at char 3398 |
| phase3/module-present-pdf-parser.js | PASS | found at char 3445 |
| phase3/module-present-pdf-renderer.js | PASS | found at char 3490 |
| phase3/module-load-order | PASS | All 5 modules present in correct order |
| phase3/no-eval | PASS | No eval() found in viewer sources (comments excluded) |
| phase3/no-new-function | PASS | No new Function() found in viewer sources (comments excluded) |
| phase3/no-innerHTML-assignment | PASS | No innerHTML= assignments in viewer sources |
| phase3/no-external-urls | PASS | No external http/https URLs in viewer files |
| phase3/validateURL-called | PASS | PDFSecurity.validateURL() is called in viewer sources |
| phase3/cross-origin-error-msg | PASS | "cross-origin" error message present |
| phase3/viewer-js-loaded | PASS | viewer.js script tag present in viewer.html |

---

# Phase 3 Viewer Browser Test Results (Playwright)

**Date**: 2026-05-28T02:41:21.460Z

## Summary

| Total | Pass | Fail |
|-------|------|------|
| 30 | 30 | 0 |

## Per-Test Results

| Test | Status | Notes |
|------|--------|-------|
| viewer3/text-only.pdf/canvas-visible | PASS | canvas=612x792 |
| viewer3/text-only.pdf/has-pixels | PASS | pixelCount=82 |
| viewer3/text-only.pdf/no-uncaught | PASS | No uncaught exceptions |
| viewer3/text-only.pdf/navigation-next | PASS | Page counter incremented to 2 after next click |
| viewer3/text-only.pdf/screenshot | PASS | viewer-text-only.png |
| viewer3/images.pdf/canvas-visible | PASS | canvas=612x792 |
| viewer3/images.pdf/has-pixels | PASS | pixelCount=54756 |
| viewer3/images.pdf/no-uncaught | PASS | No uncaught exceptions |
| viewer3/images.pdf/screenshot | PASS | viewer-images.png |
| viewer3/mixed.pdf/canvas-visible | PASS | canvas=612x792 |
| viewer3/mixed.pdf/has-pixels | PASS | pixelCount=39485 |
| viewer3/mixed.pdf/no-uncaught | PASS | No uncaught exceptions |
| viewer3/mixed.pdf/screenshot | PASS | viewer-mixed.png |
| viewer3/links.pdf/canvas-visible | PASS | canvas=612x792 |
| viewer3/links.pdf/has-pixels | PASS | pixelCount=631 |
| viewer3/links.pdf/no-uncaught | PASS | No uncaught exceptions |
| viewer3/links.pdf/link-annotations | PASS | 2 <a> elements in link-layer |
| viewer3/links.pdf/link-security-attrs | PASS | All links have target=_blank rel=noopener |
| viewer3/links.pdf/screenshot | PASS | viewer-links.png |
| viewer3/poc.pdf/canvas-visible | PASS | canvas=612x792 |
| viewer3/poc.pdf/has-pixels | PASS | pixelCount=2500 |
| viewer3/poc.pdf/no-uncaught | PASS | No uncaught exceptions |
| viewer3/poc.pdf/no-dialogs | PASS | No alert/confirm/prompt fired |
| viewer3/poc.pdf/screenshot | PASS | viewer-poc.png |
| viewer3/malformed.pdf/error-shown | PASS | Error message displayed for malformed PDF |
| viewer3/malformed.pdf/no-uncaught | PASS | No uncaught exceptions for malformed PDF |
| viewer3/malformed.pdf/screenshot | PASS | /home/eejon/Desktop/phase3-replication/gogs/tests/screenshots/viewer-malformed.png |
| viewer3/cross-origin-rejection/error-shown | PASS | Error shown: "cross-origin file not allowed The file URL did not pass security validation." |
| viewer3/cross-origin-rejection/no-fetch | PASS | No request sent to evil.example.com |
| viewer3/cross-origin-rejection/no-uncaught | PASS | No uncaught exceptions |
