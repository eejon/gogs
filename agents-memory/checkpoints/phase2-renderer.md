# Phase 2 Renderer — Checkpoint

**Date**: 2026-05-28
**Status**: COMPLETE WITH BUG FIXES — 79/79 tests passing (55 Node.js + 24 Playwright browser)
**Bugs resolved**: BUG 1 (garbled text) and BUG 2 (image not rendered) — both fixed 2026-05-28.

## All Components Completed

| File | Status |
|------|--------|
| `public/plugins/custom-pdf-render/src/pdf-fonts.js` | DONE (encoding tables + ToUnicode CMap parser added) |
| `public/plugins/custom-pdf-render/src/pdf-images.js` | DONE (function naming conflict fixed + ImageData→ImageBitmap conversion) |
| `public/plugins/custom-pdf-render/src/pdf-renderer.js` | DONE (async font resolution + ToUnicode decoding in _showText) |
| `tests/test-runner.js` | EXTENDED (Phase 2 checks added) |
| `tests/browser-test.html` | DONE |
| `tests/playwright-test.js` | DONE |
| `tests/run2/results.md` | DONE (Node.js + Playwright results) |
| `tests/run3/results.md` | DONE (Bug fix verification results) |
| `tests/screenshots/*.png` | DONE (6 screenshots — updated after bug fixes) |
| `agents-memory/handoffs/phase2-renderer.md` | DONE |

## Test Results Summary — Run 3 (After Bug Fixes)

### Node.js: 55/55 PASS
- Phase 1 Parser: 25/25
- Phase 2 Renderer: 30/30

### Playwright Browser: 24/24 PASS
| PDF | pixelCount | vs Run 2 | Result |
|-----|------------|----------|--------|
| text-only.pdf | 374 | was 548 | PASS — readable text: "Line 1", "Testing stuff" |
| images.pdf | 219024 | was 491 | PASS — starburst image correctly rendered |
| mixed.pdf | 158747 | was 849 | PASS — JPEG image + text both visible |
| links.pdf | 2457 | was 2836 | PASS |
| poc.pdf | 10000 | was 10000 | PASS (0 dialogs) |
| malformed.pdf | — | — | PASS (graceful failure) |

## Bug Findings — Manual Verification (2026-05-28) — RESOLVED

The following bugs were found by manually opening `tests/browser-test.html` in a real browser
and inspecting the rendered canvas. Screenshots in `tests/screenshots/` confirm both issues.
These must be fixed before Phase 3 proceeds.

### BUG 1 — Garbled text in `text-only.pdf` (font encoding not applied) — **FIXED**

**Symptom**: Text renders as wrong glyphs — e.g. `/ IQH□□□` and `7HVWlQJ□VMll`
instead of readable content. The text appears at correct positions and sizes but every
character is wrong.

**Root cause**: PDF character codes in content streams are passed directly through
`String.fromCharCode()` as raw Latin-1 bytes. The font's `/Encoding` dictionary
(and `/Differences` array) is not being used to remap character codes to the correct
glyph names / Unicode codepoints before rendering.

**Fix required**:
- When processing a `Tf` operator, load the font dict from `/Resources/Font/<name>`.
- Parse the font's `/Encoding` entry:
  - If it is a name like `/WinAnsiEncoding`, `/MacRomanEncoding`, `/StandardEncoding`:
    use the corresponding built-in encoding table to map char code → glyph name.
  - If it is a dict with `/Differences`: apply the differences array to patch the base
    encoding (format: `[firstCode /GlyphName /GlyphName ...]`).
- Map glyph names to Unicode codepoints using the Adobe Glyph List (a compact lookup
  table of the ~300 most common names is sufficient: `space`→32, `A`→65,
  `agrave`→224, etc.).
- Use the resolved Unicode string in `ctx.fillText()` instead of the raw char bytes.

**Affected file**: `src/pdf-renderer.js` (text rendering path, `Tj`/`TJ` operators).
`src/pdf-fonts.js` should expose the encoding tables and glyph-name→Unicode map.

---

### BUG 2 — Image not rendered in `images.pdf` (raw compressed bytes passed to pixel decoder) — **FIXED**

**Symptom**: `images.pdf` shows only a tiny gray placeholder box. The canvas is
otherwise blank. The Playwright test passed because `pixelCount=491` counted the
border pixels of the placeholder box — not actual image content.

**Root cause**: In `pdf-images.js` `decodeImage()`, line ~54:
```js
rawBytes = imageStream.rawBytes;   // ← these are still COMPRESSED
if (!rawBytes || rawBytes.length === 0) {
  rawBytes = await imageStream.getBytes();  // ← this path calls the decompressor
}
```
For a non-JPEG image with `FlateDecode`, `rawBytes` is non-empty (it is the compressed
stream body), so the `if` branch is never entered. The compressed bytes are then passed
to `_decodeRawPixels()`, which gets a pixel byte-count mismatch and returns null,
causing the placeholder.

**Fix required**:
- Remove the `rawBytes` shortcut for non-JPEG images entirely. Always call
  `await imageStream.getBytes()` to get the decompressed pixel bytes.
- Only use `imageStream.rawBytes` for the JPEG path (DCTDecode), where compressed
  bytes are exactly what we need to pass to `createImageBitmap`.
- Revised logic:
  ```js
  // JPEG: pass compressed bytes directly to the JPEG decoder
  if (isJPEG) {
    const jpegBytes = imageStream.rawBytes || await imageStream.getBytes();
    return _decodeJPEG(jpegBytes);
  }
  // All other filters: decompress first, then decode pixels
  const pixelBytes = await imageStream.getBytes();   // always decompressed
  return _decodeRawPixels(pixelBytes, width, height, colorSpace, bitsPerComponent);
  ```

**Affected file**: `src/pdf-images.js`, `decodeImage()` function (~line 50–78).

---

### Re-testing requirements after fixes

After fixing both bugs, re-run the full test suite and update results:

1. `node tests/test-runner.js` — all existing checks must still pass.
2. `node tests/playwright-test.js` — re-run browser tests.
   - `text-only.pdf`: screenshot must show readable Latin text (not garbled glyphs).
   - `images.pdf`: screenshot must show the actual image content (not a placeholder box).
   - `pixelCount` for `images.pdf` must be substantially higher than 491 (expect >5000).
   - All other PDFs must continue to pass.
3. Save new screenshots to `tests/screenshots/` (overwrite existing).
4. Write results to `tests/run3/results.md`.
5. Update `agents-memory/handoffs/phase2-renderer.md` to reflect the fixes.

## Key Decisions

1. **Y-axis flip**: `ctx.setTransform(scale, 0, 0, -scale, -x1*scale, y2*scale)`.
   Text rendering flips back with `ctx.transform(1,0,0,-1,0,0)`.

2. **Glyph advance**: Uses AFM width tables from `pdf-fonts.js` (not canvas measureText).
   Formula: `(w0 * fontSize / 1000 + Tc + (space ? Tw : 0)) * Th`.

3. **Security**: No eval/Function in any Phase 2 module. Verified by static analysis
   and Playwright poc.pdf test (0 dialog events fired).

4. **Image decode**: JPEG via Blob+createImageBitmap. Raw pixels via ImageData→ImageBitmap
   (browser) or ImageData-like object (Node.js). Unknown filter → null → gray placeholder.

7. **Browser global scope**: All private helpers in `pdf-images.js` use `_img` prefix
   (`_imgGetNum`, `_imgNormalizeFilters`, `_imgGetColorSpaceName`, `_imgNormalizeColorSpace`)
   to avoid collision with same-named functions in `pdf-renderer.js` when both files are
   loaded as `<script>` tags in the browser.

8. **ToUnicode CMap**: Type0/CIDFont text uses 2-byte CID char codes mapped to Unicode via
   `/ToUnicode` CMap stream. The `_resolveFontAsync` method resolves the ref, parses the CMap
   with `parseToUnicodeCMap()`, and stores it on the graphics state for use in `_showText()`.

5. **Unknown operators**: Silently skipped (return false).

6. **Per-operator try/catch**: Every operator execution wrapped to prevent crashes.
