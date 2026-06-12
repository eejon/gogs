# Functional Gap Analysis -- Plan Review

## Evaluation Framework

The project goal is to build a bespoke PDF renderer that can conclusively replace PDF.js in Gogs. For the experiment to be conclusive, the custom implementation must match at least the functional support level that Gogs gets from PDF.js. Any PDF feature that PDF.js would render when Gogs serves a PDF must also be handled by the replacement -- either rendered correctly or degraded gracefully with diagnostics. Additional feature coverage increases attack surface, which is itself a valid research outcome.

Each gap is evaluated against the existing analysis.md plan and MEMORY.md context notes. The question for each gap is: does the plan already cover this, or does it need amendment before implementation begins?

---

## Gap Assessments

### Gap 1: Internal link navigation (/GoTo, /Dest)

**Covered in plan:** Partially. The plan mentions internal links in two places:
- analysis.md, Feature "Link Handling" (line 75): "Internal links (page destinations): navigate within the viewer"
- analysis.md, Phase 3 (line 299): "Internal page links navigate within the viewer"

However, neither location specifies the PDF-level mechanisms involved. Internal links use `/S /GoTo` actions with `/D` destination arrays (or named destinations via `/Dests` or `/Names` dictionaries in the catalog). The plan never mentions `/GoTo`, `/Dest`, named destinations, or how to resolve destination arrays of the form `[pageRef /Fit]`, `[pageRef /XYZ left top zoom]`, etc.

**Relevant to project goals:** Yes. Internal links (table of contents, cross-references) are a common PDF feature. PDF.js supports them fully. If a user uploads a PDF with a TOC that has clickable entries, PDF.js renders those as working internal links. The custom renderer should do the same for a conclusive comparison.

**Security surface consideration:** Low additional risk. Internal links navigate within the viewer itself (changing the displayed page). The destination is a page object reference, not a URL, so the URI sanitization attack surface is not affected. The only concern is ensuring `/GoTo` actions that reference non-existent pages do not crash.

**Recommendation:** Amend the plan. Add explicit coverage of `/GoTo` action resolution and destination arrays to Phase 3 (viewer logic), with a dependency on Phase 1 (parser must extract `/Dest` arrays and named destinations from the catalog).

**Which phase affected:** Phase 1 (parser must extract named destinations from catalog `/Dests` or `/Names` -> `/Dests` name tree), Phase 3 (viewer must resolve `/GoTo` destinations and navigate to the target page).

**Specific plan amendments:**
- Phase 1, Security Filter: The filter currently strips `/Launch`, `/SubmitForm`, `/ImportData` actions. It should explicitly *preserve* `/GoTo` and `/GoToR` (though `/GoToR` can be blocked since it references external files). The filter's action handling should be: allow `/GoTo`, strip everything else that is dangerous.
- Phase 1, Parser: Add extraction of named destinations from the document catalog (`/Dests` dictionary or `/Names` -> `/Dests` name tree).
- Phase 3, Link annotation rendering: When an annotation has `/S /GoTo` with `/D [pageRef /Fit]` or a named destination string, the viewer should navigate to that page instead of opening a URL.

---

### Gap 2: URL validation canonicalization (//host/path scheme-relative URLs)

**Covered in plan:** No. The plan specifies URI scheme whitelisting in multiple places:
- analysis.md, Security Requirements (line 408): "URIs: Whitelist `http:`, `https:`, `mailto:` schemes only"
- analysis.md, Phase 1 (line 160): "Sanitize URI annotations: allow only `http:`, `https:`, `mailto:`"
- analysis.md, Phase 3 (line 325): "Only allow relative URLs or same-origin absolute URLs. Block `javascript:`, `data:`, and cross-origin URLs."
- MEMORY.md, Security Considerations (line 48): "URI schemes from PDF annotations must be whitelisted"

None of these sections address scheme-relative URLs (`//evil.com/payload`). A scheme-relative URL has no scheme prefix, so a naive check like `url.startsWith('http:') || url.startsWith('https:')` would not match it -- but the check might also not block it if the implementation only blocks known-bad schemes. In a browser context, `//evil.com/payload` resolves to `https://evil.com/payload` (inheriting the page's scheme), which means it would bypass a blocklist-only approach.

The `?file=` parameter validation (Phase 3, line 325) says "Only allow relative URLs or same-origin absolute URLs" -- a scheme-relative URL is technically a relative URL (network-path reference per RFC 3986), and it resolves to a different origin.

**Relevant to project goals:** Yes. This is a security concern, not a functional one. URL validation is a critical security boundary in the viewer. If the plan's URL validation can be bypassed, the custom renderer has a vulnerability.

**Security surface consideration:** High. A bypassed URL validator could allow:
1. For `?file=` parameter: fetching PDFs from attacker-controlled servers (SSRF-like from the browser)
2. For PDF link annotations: navigating users to attacker-controlled URLs that appear to be internal links

**Recommendation:** Amend the plan. Add explicit handling of scheme-relative URLs to both the `?file=` URL validation (Phase 3) and the URI annotation sanitization (Phase 1 security filter). The validation should:
1. For `?file=`: Parse the URL with `new URL(value, location.origin)` and verify the resulting origin matches `location.origin`. This handles scheme-relative URLs, protocol-relative URLs, and other edge cases by relying on the browser's URL parser rather than string prefix matching.
2. For PDF link annotations: After scheme whitelisting, additionally reject any URI that starts with `//` (scheme-relative) to prevent browsers from resolving it to the page's scheme with an external host.

**Which phase affected:** Phase 1 (security filter URI sanitization), Phase 3 (`?file=` parameter validation).

**Specific plan amendments:**
- Phase 1, `pdf-security.js`: URI sanitization should normalize URLs before scheme checking. At minimum: trim whitespace, reject URLs starting with `//` that are not same-origin after resolution.
- Phase 3, `pdf-viewer.js`: `?file=` validation should use `new URL(param, location.origin)` and compare origins, rather than string prefix matching. Explicitly document that scheme-relative URLs must be caught.
- Security Requirements section: Add a bullet under "Network Safety" about scheme-relative URL handling.

---

### Gap 3: Query parsing robustness

**Covered in plan:** Partially. The plan mentions `?file=` parameter parsing in Phase 3 (line 283): "Read URL query parameter, validate it's a relative/same-origin URL." The MEMORY.md notes (line 10) mention that `EscapePound` replaces `#` with `%23`. But neither document discusses what happens when:
- The query string is malformed (e.g., `?file=` with no value, `?file`, `?`, or empty string)
- The value contains double-encoded characters
- Multiple `?file=` parameters are present
- The value after `decodeURIComponent` throws (malformed percent-encoding like `%ZZ`)

The plan's error handling feature (line 77-85) covers PDF parsing errors but does not mention pre-parse failures like inability to extract a valid URL from the query string.

**Relevant to project goals:** Yes. The viewer is loaded in an iframe controlled by Gogs. Normally, Gogs constructs the URL correctly. But if the viewer is accessed directly (bookmarked, shared, or if a future Gogs bug produces a malformed URL), the viewer should not crash. More importantly, `decodeURIComponent` can throw a `URIError` on malformed percent-encoding, and this would be an uncaught exception if not handled.

**Security surface consideration:** Low-to-medium. A crash in the viewer initialization is a denial-of-service at most (the user sees a blank iframe). However, error messages that expose internal state or stack traces could leak implementation details.

**Recommendation:** Amend the plan. Add explicit query string parsing robustness requirements to Phase 3. This is a small addition.

**Which phase affected:** Phase 3.

**Specific plan amendments:**
- Phase 3, `pdf-viewer.js`: Add requirement: "Wrap `decodeURIComponent` in try/catch. If the `?file=` parameter is missing, empty, or contains malformed percent-encoding, display a user-friendly error message ('No PDF file specified' or 'Invalid file URL') instead of crashing."
- Phase 3, Definition of done: Add: "Viewer handles missing, empty, or malformed `?file=` parameter gracefully with an error message."

---

### Gap 4: Image decoding coverage beyond 8bpc/basic filters

**Covered in plan:** Partially. The plan specifies image handling in two places:
- analysis.md, Feature "Image Rendering" (line 39-48): Mentions "width/height/bitsPerComponent/colorSpace" but does not specify which bpc values must be supported. Mentions DCTDecode and FlateDecode but not other filters.
- analysis.md, Phase 2 (line 235-236): "JPEG passthrough (DCTDecode)" and "FlateDecode images: reconstruct pixel data from raw components."

The plan does not mention:
- Specific bits-per-component coverage: 1bpc (common in scanned documents, masks), 2bpc, 4bpc (indexed color), 8bpc (standard), 16bpc (high-quality images)
- Predictor filters in FlateDecode streams (PNG predictors: None, Sub, Up, Average, Paeth)
- Indexed color spaces (`/Indexed`) with palette lookup
- ICCBased color spaces (common in modern PDFs)
- Image masks (`/ImageMask true`) and soft masks (`/SMask`)
- ASCIIHexDecode and ASCII85Decode filters (mentioned in Phase 1 feature description at line 16 but not in the parser's components list at line 152)

**Relevant to project goals:** Yes. PDF.js supports all of these image formats. Real-world PDFs commonly use:
- 1bpc images (scanned documents, fax images)
- 4bpc indexed color images
- PNG predictors in FlateDecode image streams (very common in PDF generators like LaTeX, LibreOffice)
- ICCBased color space (Chrome "Save as PDF" uses it universally)
- Image masks (transparency)

If the custom renderer only supports 8bpc DeviceRGB/DeviceGray with raw FlateDecode, many real PDFs with images will fail.

**Security surface consideration:** Medium. Each additional image format adds parsing complexity and potential for malformed input exploitation. Predictor filters in particular involve per-scanline byte manipulation that could be exploited with crafted width/height/bpc combinations to cause buffer overflows (in concept; JavaScript arrays don't have traditional overflows, but could cause excessive memory allocation).

**Recommendation:** Amend the plan. Add explicit bpc coverage (at minimum 1, 4, 8 bpc), predictor filter support, and indexed color space support to Phase 2. ICCBased color spaces can be approximated (fall back to DeviceRGB/DeviceGray/DeviceCMYK based on the number of components). Image masks should be supported for transparency.

**Which phase affected:** Phase 2.

**Specific plan amendments:**
- Phase 2, Image rendering section: Expand to cover:
  - BitsPerComponent: 1, 2, 4, 8 (16bpc can be downsampled to 8)
  - PNG predictor filters (DecodeParms -> Predictor 10-15: None, Sub, Up, Average, Paeth per scanline)
  - Indexed color space (`/Indexed [base hival lookup]`) with palette lookup
  - ICCBased color space: fall back to device color space based on `/N` (number of components: 1->Gray, 3->RGB, 4->CMYK)
  - Image masks (`/ImageMask true`): render as stencil mask using current fill color
  - Soft masks (`/SMask`): apply as alpha channel
- Phase 1, Parser: Ensure FlateDecode with DecodeParms (Predictor, Columns, Colors, BitsPerComponent) is parsed and the parameters are passed through to Phase 2.
- Phase 1, Stream decompression: Add ASCIIHexDecode and ASCII85Decode filters (mentioned in the analysis feature list but missing from the implementation components). These are simple decode-only transforms.

---

### Gap 5: Unsupported-feature diagnostics

**Covered in plan:** Minimally. The plan mentions graceful degradation in Phase 2 (line 257): "Graceful degradation for unsupported features (log warning, skip element, don't crash)." But there is no specification of:
- What logging mechanism to use (console.warn? a visible status bar? a counter?)
- Whether the user should be informed that parts of the PDF did not render
- How to differentiate between "unsupported feature" and "parse error"
- Whether to log the specific operator or feature name for debugging

**Relevant to project goals:** Yes. For a research project, diagnostic output is particularly valuable. When evaluating the bespoke renderer against PDF.js, researchers need to know *why* a PDF looks different -- is it a bug, or a deliberately unimplemented feature? Without diagnostics, debugging rendering differences requires manual investigation.

**Security surface consideration:** Low, but diagnostics must not expose PDF-internal data to the DOM in unsafe ways. Log to `console.warn` only, not to `innerHTML` or `textContent` of a visible element with unsanitized PDF content.

**Recommendation:** Amend the plan. Add a lightweight diagnostics strategy. This does not need to be elaborate -- `console.warn` with the operator name and a counter of skipped operators shown in the toolbar is sufficient.

**Which phase affected:** Phase 2 (renderer logging), Phase 3 (optional UI indicator).

**Specific plan amendments:**
- Phase 2, Renderer: Add requirement: "When encountering an unknown content stream operator, log `console.warn('Unsupported PDF operator: <op>')` and skip it. Maintain a count of skipped operators per page."
- Phase 3, Viewer UI (optional but recommended): Add a small indicator (e.g., a warning icon in the toolbar) if the page had unsupported operators. Clicking it could show the count. This helps researchers evaluate rendering completeness.
- Phase 2, Definition of done: Add: "Unknown operators are logged to console and skipped without crashing."

---

### Gap 6: Shading (sh operator) and Type3 font support

**Covered in plan:** No. Neither shading nor Type3 fonts are mentioned anywhere in analysis.md or MEMORY.md.

The plan's scope reduction section (analysis.md lines 115-132) does not list shading or Type3 fonts as excluded features. The plan's text rendering section (Phase 2, lines 237-241) covers only the 14 standard fonts and standard encodings. The graphics operators list (Phase 2, lines 218-232) does not include `sh` (shading), `gs` (graphics state from ExtGState), or `d0`/`d1` (Type3 font glyph operators).

**Relevant to project goals:** Yes, per the research framing. The consideration framework states: "If Gogs can process certain PDF features through PDF.js (e.g., Type3 fonts, internal links, mailto URIs), then the custom renderer should support them too for a conclusive experiment." PDF.js supports both Type3 fonts and shading operators. Real-world PDFs containing Type3 fonts include mathematical documents (LaTeX with custom symbol fonts) and some legacy documents. Shading is used for gradient fills.

**Security surface consideration:** Medium-to-high.
- Type3 fonts embed arbitrary content streams as glyph definitions. Each glyph is a mini PDF content stream that gets interpreted by the renderer. This is a significant attack surface because it means untrusted PDF data drives the content stream interpreter recursively. Malformed Type3 glyph streams could be used for DoS (deeply nested rendering) or to trigger parser bugs.
- Shading operators (`sh`) reference shading dictionaries that define gradient functions. Function evaluation (Type 2: exponential, Type 3: stitching, Type 4: PostScript calculator) adds complexity. Type 4 functions in particular contain PostScript-like programs that must be interpreted -- a potential code execution vector if not carefully sandboxed.

The additional attack surface from these features is "itself worth studying from a security research perspective" per the project framing.

**Recommendation:** Add to plan, but as a sub-phase or extension phase to manage complexity. Type3 fonts and shading add substantial implementation effort and security surface. Adding them to Phase 2 directly would make that phase too large. Instead:

- Add a Phase 2b (or extend Phase 2 with clearly scoped sub-phases) for:
  1. Type3 font rendering: parse `/Type /Type3` font dictionaries, interpret `CharProcs` content streams using the existing content stream interpreter, render glyphs. Apply the same security limits (nesting depth, operator count) to glyph streams.
  2. Shading operator (`sh`): implement axial (Type 2) and radial (Type 3) shading patterns. Skip Type 4 PostScript calculator functions (too complex and dangerous) -- render as flat color fallback.
  3. `gs` operator (ExtGState): needed for transparency (alpha), blend modes, and soft masks. At minimum implement `/ca` and `/CA` (fill/stroke alpha).

**Which phase affected:** Phase 2 (or new Phase 2b).

**Specific plan amendments:**
- Add `gs` operator to Phase 2's graphics operators list (it is needed even without shading, for basic transparency).
- Add Type3 font handling as a sub-phase of Phase 2: parse Type3 font dicts, interpret CharProcs as sub-content-streams with the same interpreter. Enforce max recursion depth.
- Add `sh` operator and basic shading (axial/radial gradients) as a sub-phase of Phase 2. Skip Type 4 (PostScript calculator) functions -- fall back to endpoint colors.
- Security filter (Phase 1): add Type3 CharProcs streams to the set of streams that must be security-filtered (they can contain the same dangerous patterns as page content streams).

---

### Gap 7: mailto URI scheme in link policy

**Covered in plan:** Yes, consistently. The mailto scheme is mentioned in:
- analysis.md, Feature "Link Handling" (line 74): "Sanitize URI schemes -- allow only `http:`, `https:`, `mailto:`"
- analysis.md, Phase 1 Security Filter (line 160): "Sanitize URI annotations: allow only `http:`, `https:`, `mailto:`"
- analysis.md, Security Requirements (line 408): "URIs: Whitelist `http:`, `https:`, `mailto:` schemes only"
- MEMORY.md, Security Considerations (line 48): mentions URI scheme whitelisting (does not enumerate but references the plan)

The scheme is consistently specified across all relevant sections.

**Relevant to project goals:** Yes. mailto links are a legitimate feature in PDFs (e.g., author contact information).

**Security surface consideration:** Low. `mailto:` links open the user's email client. They cannot execute JavaScript or navigate to web content. The main concern is spam/phishing (pre-filling a mailto with a deceptive subject/body), but this is a low-severity issue since the user must actively click the link and their email client provides another layer of review.

**Recommendation:** Already covered. No plan amendments needed.

**Which phase affected:** N/A.

---

## Summary: Recommended Plan Amendments

The following amendments should be made to analysis.md before implementation begins, ordered by priority:

### Must-add (High Impact)

1. **Gap 1 -- Internal link navigation**: Add `/GoTo` action and destination array resolution. Phase 1 parser should extract named destinations from the catalog. Phase 3 viewer should handle `/GoTo` annotations by navigating to the target page. Phase 1 security filter should explicitly preserve `/GoTo` while stripping other action types.

2. **Gap 2 -- URL canonicalization for scheme-relative URLs**: Add explicit handling of `//host/path` URLs to both the `?file=` parameter validation (Phase 3) and URI annotation sanitization (Phase 1). Specify using `new URL()` constructor for origin comparison rather than string prefix matching.

### Should-add (Compatibility)

3. **Gap 4 -- Image format coverage**: Expand Phase 2 image requirements to cover 1/2/4/8 bpc, PNG predictor filters, indexed color spaces, ICCBased color space fallback, and image masks. Add ASCIIHexDecode and ASCII85Decode filters to Phase 1 parser.

4. **Gap 6 -- Type3 fonts, shading, and ExtGState**: Add as Phase 2b sub-phases. Type3 fonts enable LaTeX/math PDFs. Shading enables gradient fills. `gs` operator enables transparency. All are supported by PDF.js and thus needed for conclusive experimentation. The added security surface (especially Type3 CharProcs and shading functions) is itself a research-relevant outcome.

### Good-to-add (Robustness)

5. **Gap 3 -- Query parsing robustness**: Add try/catch around `decodeURIComponent` and graceful handling of missing/empty/malformed `?file=` parameter to Phase 3.

6. **Gap 5 -- Unsupported-feature diagnostics**: Add `console.warn` logging for unknown operators with a skip counter. Optionally add a toolbar indicator for pages with skipped operators.

### Already covered (No action needed)

7. **Gap 7 -- mailto URI scheme**: Consistently specified across all relevant plan sections.
