## Integration Context

### How Gogs invokes the PDF viewer

The iframe is emitted by `templates/repo/view_file.tmpl:84`:
```
<iframe width="100%" height="600px" src="{{AppSubURL}}/plugins/pdfjs-1.4.20/web/viewer.html?file={{EscapePound $.RawFileLink}}"></iframe>
```

- `AppSubURL` = `conf.Server.Subpath` (default empty string; non-empty when Gogs is deployed at a subpath like `/gogs`). Defined at `internal/template/template.go:55`.
- `EscapePound` (`internal/template/template.go:262-264`) replaces `%` -> `%25`, `#` -> `%23`, ` ` -> `%20`, `?` -> `%3F` in the raw file link. The custom viewer must handle these percent-encoded characters when parsing the `?file=` parameter (standard `decodeURIComponent` or `URL` API handles this).
- `RawFileLink` is set at `internal/route/repo/view.go:135` as `rawLink + "/" + c.Repo.TreePath`. The `rawLink` is the repo's raw download prefix, producing paths like `/<user>/<repo>/raw/<branch>/<path>.pdf`.

### How the raw PDF bytes are served

Route: `m.Get("/raw/*", repo.SingleDownload)` at `internal/cmd/web.go:611`.

`SingleDownload` (`internal/route/repo/download.go:51`) -> `ServeBlob` -> `serveData`. For PDFs:
- Sets `Content-Disposition: attachment; filename="<name>"` (because PDF is neither text nor image)
- Sets `Content-Transfer-Encoding: binary`
- Does NOT set an explicit `Content-Type` for non-text non-image files (Go's default `http.ResponseWriter` may set `application/octet-stream` or sniff it)
- Writes raw blob bytes directly to the response

Key implication: The `Content-Disposition: attachment` header is irrelevant for programmatic fetch (XHR/fetch API ignores it). The custom viewer just needs to fetch as `ArrayBuffer`.

### Static file serving

Static files under `public/` are served by macaron middleware at `internal/cmd/web.go:89-95`. The path `public/plugins/custom-pdf-render/web/viewer.html` will be accessible at `<AppSubURL>/plugins/custom-pdf-render/web/viewer.html`. No special route registration is needed.

Files can be served either from disk or from an embedded filesystem (`public.Files` via `go:embed`), controlled by `conf.Server.LoadAssetsFromDisk`. For development/testing, disk serving works. For production builds, the files need to be included in the `public` package's embedded FS -- but for this research project, disk serving is sufficient.

### Template change required

Only one line changes in `templates/repo/view_file.tmpl:84`:
```
- <iframe width="100%" height="600px" src="{{AppSubURL}}/plugins/pdfjs-1.4.20/web/viewer.html?file={{EscapePound $.RawFileLink}}"></iframe>
+ <iframe width="100%" height="600px" src="{{AppSubURL}}/plugins/custom-pdf-render/web/viewer.html?file={{EscapePound $.RawFileLink}}"></iframe>
```

## Functional Boundaries

### What Gogs actually uses vs what PDF.js supports

PDF.js ships a full-featured viewer with ~70 UI elements. Gogs uses it purely as an embedded read-only viewer. The following PDF.js features are **not exercised** by Gogs and should be excluded from the custom implementation to reduce attack surface:

| Feature | Why excluded |
|---|---|
| Sidebar (thumbnails/outline/attachments) | 600px iframe too small; Gogs never triggers it |
| Find/Search text | Not wired to any Gogs UI |
| Presentation mode | Iframe context prevents fullscreen |
| Open File button | File is specified by Gogs, not user |
| Print button | Not useful in embedded iframe |
| Download button | Gogs provides its own "Raw" link in `view_file.tmpl:21` |
| Page rotation | Niche; adds complexity without clear need |
| Hand tool / cursor modes | Default scroll is sufficient |
| Document properties dialog | Metadata display not needed |
| Password-protected PDF support | Edge case for code hosting; adds crypto complexity |
| Text selection/copy layer | Nice-to-have but requires complex text-layer positioning |
| Bookmarks / view history | Embedded viewer should not manipulate browser history |
| Localization | Not needed for an embedded viewer |
| Web Worker (pdf.worker.js) | The custom implementation will parse in the main thread; for corpus-typical file sizes (<50MB) this is acceptable |

### What IS needed (minimal feature set)

1. `?file=` URL parsing with same-origin validation
2. PDF fetch as ArrayBuffer
3. Full PDF binary parser (header, xref traditional + stream, trailer, catalog, page tree, object resolution, stream decoding)
4. Content stream rendering to canvas (text + vector + images)
5. Font handling (standard 14 metrics + embedded font ToUnicode/widths + web-safe fallbacks)
6. Image rendering (JPEG passthrough, Flate+predictor decode, various BPC, masks)
7. Color spaces (Gray, RGB, CMYK->RGB, Indexed, ICCBased->fallback)
8. ExtGState alpha (ca/CA) and blend modes
9. Shading (Type 2 linear, Type 3 radial -- graceful fallback for others)
10. Page navigation (prev/next/jump, page count display)
11. Zoom (fit-width default, manual zoom levels)
12. Loading indicator and error display
13. Link annotation overlay with URI scheme sanitization
14. Security: JS stripping, action allowlist, resource limits

## Security Considerations

### Input surfaces the implementer must guard

1. **`?file=` parameter** -- The primary injection vector. Must reject:
   - Cross-origin URLs (check `new URL(file, location.href).origin === location.origin`)
   - Dangerous schemes: `javascript:`, `data:`, `blob:`, `vbscript:`, `file:` (in web context)
   - Path traversal is not a concern here (the server resolves the path), but protocol-relative URLs (`//evil.com/...`) must be caught by the origin check.

2. **PDF binary content** -- Untrusted user-uploaded data. Specific risks:
   - **Zip bombs via FlateDecode**: A small compressed stream that expands to gigabytes. Must enforce max decompressed stream size (suggest 100MB cap) and total decompressed budget.
   - **Circular references**: Object A references Object B which references Object A. Must track resolution depth (max 50) and detect cycles via a visited-set.
   - **Deeply nested page trees**: Page tree with depth 1000. Must cap tree traversal depth.
   - **Huge object counts**: Xref with millions of entries. Must cap at ~100,000 objects.
   - **Malformed stream lengths**: `/Length` says 100 but actual stream data is 10,000 bytes (or 5 bytes). Must validate stream boundaries against actual `endstream` marker.
   - **JavaScript actions in annotations**: `/S /JavaScript /JS (alert('xss'))`. Must never eval; must strip on parse.
   - **URI actions with dangerous schemes**: `/S /URI /URI (javascript:void(0))`. Must allowlist schemes.
   - **Launch/SubmitForm/ImportData actions**: Must silently drop.
   - **Recursive content streams**: Unlikely but a Form XObject's content stream could reference itself. Must track rendering depth.

3. **Rendering to DOM/Canvas** -- The output surface. Risks:
   - **No `innerHTML` with PDF-derived strings**. All text content must go through `canvas.fillText()` (safe) or `textContent` (safe), never `innerHTML`.
   - **No `eval()` or `Function()` constructor** anywhere in the codebase.
   - **No `document.write()`**.
   - **Link annotation `<a>` elements**: The `href` must be sanitized (scheme allowlist). The `textContent` must be set via DOM property, not innerHTML.
   - **No `window.open()` with PDF-derived URLs** -- links use `<a target="_blank">` which is safe.
   - **Canvas cannot cause XSS** -- pixel data on canvas is inert. This is a safety advantage over HTML-based rendering.

### Constraints on implementation patterns

- All string output from PDF parsing that appears in the DOM must go through safe APIs (`textContent`, `setAttribute` with validated values, `canvas` drawing).
- The parser must use `Uint8Array` views on the original `ArrayBuffer` -- never convert large binary segments to strings (performance and security).
- Integer parsing from PDF content must use `parseInt` with radix 10 and validate results with `isFinite()`.
- No dynamic `import()` or `<script>` injection from PDF data.

## Open Questions

1. **DecompressionStream availability**: The browser `DecompressionStream('deflate')` API handles FlateDecode elegantly but may not be available in older browsers. The implementer should check if all target browsers support it, or include a pure-JS fallback inflate implementation (this is non-trivial but must be in-house per hard constraints). Note: `DecompressionStream('raw')` or `DecompressionStream('deflate')` -- need to verify which mode matches PDF's FlateDecode (which is raw deflate wrapped in zlib, so `'deflate'` is correct).

2. **PDF FlateDecode wrapping**: PDF's FlateDecode uses zlib format (RFC 1950: 2-byte header + deflate data + 4-byte checksum). `DecompressionStream('deflate')` handles zlib format. Some PDFs may omit the zlib header (raw deflate). The implementer should try `'deflate'` first and fall back to `'raw'` on failure, or strip the zlib header manually.

3. **Canvas size limits**: Browsers limit canvas dimensions (typically 16384x16384 pixels or 268 megapixels total). At 200% zoom on a letter-size page (612x792 points), the canvas would be ~1632x2112 pixels -- well within limits. But extreme zoom levels on large pages could exceed limits. The implementer should cap canvas dimensions.

4. **Content-Type of raw PDF response**: Gogs' `serveData` does not set an explicit Content-Type for PDFs. Go's `http.ResponseWriter` defaults to sniffing or `application/octet-stream`. The `fetch()` call should not rely on Content-Type to determine if the response is PDF -- it should validate the `%PDF-` magic header in the downloaded bytes instead.

5. **`EscapePound` double-encoding**: The `?file=` value is percent-encoded by `EscapePound`. When the browser passes this through `location.search`, the percent-encoding is preserved in the raw query string. `decodeURIComponent` on the extracted value will decode it back. But if the path itself contains `%25` (literal percent sign), there could be double-encoding issues. The implementer should use a single `decodeURIComponent` pass and be aware of this edge case.

6. **LZWDecode**: Some older PDFs use LZWDecode compression (pre-PDF 1.4 era). The test corpus does not appear to include LZW-compressed PDFs, but the implementer should handle this gracefully (show error rather than crash). Implementing LZW is optional given it is rare in modern PDFs.

7. **CCITTFaxDecode and JBIG2Decode**: Used for scanned B&W documents (test corpus type 8). CCITTFaxDecode (Group 3/4 fax encoding) and JBIG2Decode are complex to implement from scratch. For the scanned PDF test case (`8-scanned.pdf`), the implementer should check what compression the images actually use. If they use DCTDecode (JPEG), which is common for color scans, the existing JPEG passthrough handles it. If CCITT/JBIG2 is used, the implementer may need to implement basic CCITT Group 4 decoding or accept this as a known limitation.

8. **Form XObjects (Type /XForm)**: These are reusable drawing snippets referenced by the `Do` operator. They are common in TikZ output and complex diagrams. The implementer must handle them by recursively interpreting the XObject's content stream with its own resource dictionary and matrix. This is part of Phase 2a but is easy to overlook.
