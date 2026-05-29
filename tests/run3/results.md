# Phase 2 Renderer — Run 3 Results (Bug Fixes)

**Date**: 2026-05-28
**Purpose**: Fix BUG 1 (garbled text) and BUG 2 (images not rendered) documented in checkpoint.

---

## Node.js Tests

**Total: 55/55 PASS** (25 Phase 1 Parser + 30 Phase 2 Renderer)

All existing tests continue to pass after the fixes.

---

## Playwright Browser Tests

**Total: 24/24 PASS**

| PDF | pixelCount | vs Run 2 | Result |
|-----|------------|----------|--------|
| text-only.pdf | 374 | was 548 | PASS — readable text now |
| images.pdf | 219024 | was 491 | PASS — image renders correctly |
| mixed.pdf | 158747 | was 849 | PASS — image+text both visible |
| links.pdf | 2457 | was 2836 | PASS |
| poc.pdf | 10000 | was 10000 | PASS (0 dialogs) |
| malformed.pdf | — | — | PASS (graceful failure) |

---

## Bugs Fixed

### BUG 1 — Garbled text (FIXED)

**Root cause**: Two separate issues:

1. PDF character codes in the test corpus used Type0/CIDFont with Identity-H encoding and a
   `/ToUnicode` CMap. The renderer was not parsing the ToUnicode CMap at all, so raw CID codes
   (e.g. `0x002F`, `0x004C`) were rendered as Latin-1 bytes instead of Unicode characters.

2. The font's `/Encoding` dict for simple Type1 fonts was not being applied.

**Fix applied**:
- Added `parseToUnicodeCMap(text)` to `pdf-fonts.js`: parses `beginbfchar`/`endbfchar` and
  `beginbfrange`/`endbfrange` sections from a ToUnicode CMap stream.
- Added `decodeWithToUnicode(bytes, map, isComposite)` to decode char bytes using the CMap.
- Added `resolveEncoding(encodingEntry)` for `/WinAnsiEncoding`, `/MacRomanEncoding`, and
  `/Differences` arrays.
- Added `decodeWithEncoding(bytes, encodingTable)` for simple font encoding tables.
- Added `ADOBE_GLYPH_LIST` (300 most common glyph name → Unicode codepoint mappings).
- Added `_resolveFontAsync(fontName, resources)` to `pdf-renderer.js`: resolves the font
  dict, follows the `/ToUnicode` indirect ref, parses the CMap, and stores it on the
  graphics state.
- Updated `_showText()` to use ToUnicode map (if available), encoding table (if available),
  or fall back to Latin-1.

**Verification**: `text-only.pdf` now shows "Line 1" and "Testing stuff" (readable English).

---

### BUG 2 — Image not rendered (FIXED)

**Root cause**: Two separate issues found:

1. **Browser global scope collision**: `pdf-images.js` defined private helpers named
   `_getNum`, `_normalizeFilters`, `_getColorSpaceName`, `_normalizeColorSpace`. When
   loaded as `<script>` tags in the browser, `pdf-renderer.js` (loaded after) overwrote
   the `_getNum` function with its own version (different signature: `(stack, posFromEnd, defaultVal)`).
   As a result, `_getNum(2048)` in `pdf-images.js` called the renderer's version which
   expected a stack array as first argument and returned 0, causing `width=0, height=0`,
   which caused `decodeImage` to return null early.

   **Fix**: Renamed all private helpers in `pdf-images.js` to use `_img` prefix:
   `_imgGetNum`, `_imgNormalizeFilters`, `_imgGetColorSpaceName`, `_imgNormalizeColorSpace`.

2. **ImageData not drawable**: After fixing the naming issue, `_decodeRawPixels` returns an
   `ImageData` object in the browser, but `ctx.drawImage()` cannot accept `ImageData` directly
   — it requires `ImageBitmap`, `HTMLImageElement`, or `HTMLCanvasElement`.

   **Fix**: Added `createImageBitmap(imageData)` conversion after `_decodeRawPixels()` in the
   non-JPEG path. In Node.js/test environments where `createImageBitmap` is unavailable, the
   `ImageData`-like object is returned as-is (tests only check for non-null).

**Verification**: `images.pdf` now renders 219,024 non-white pixels (vs 491 previously).
The actual image content (asterisk/starburst graphic) is clearly visible in the screenshot.

---

## Screenshots

New screenshots saved to `tests/screenshots/` (overwriting previous):
- `text-only.png` — shows readable Latin text ("Line 1", "Testing stuff")
- `images.png` — shows starburst image on black background (219,024 pixels)
- `mixed.png` — shows JPEG image (Shrek) with "Images and Text" header (158,747 pixels)
- `links.png` — unchanged appearance
- `poc.png` — unchanged, still 0 dialogs (no malicious JS executed)
- `malformed.png` — graceful failure unchanged
