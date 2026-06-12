## Integration Context

- Gogs embeds the PDF viewer via an `<iframe>` in `templates/repo/view_file.tmpl:84`
- The iframe is `width="100%" height="600px"` — the viewer must work within these constraints
- The `?file=` parameter receives a URL like `/<user>/<repo>/raw/<branch>/<path>.pdf`
- `AppSubURL` (from `conf.Server.Subpath`) prefixes the plugin path — may be empty string or a subpath like `/gogs`
- The raw PDF endpoint (`/raw/*` → `SingleDownload`) sets `Content-Disposition: attachment` for PDFs — the viewer must fetch via XHR/fetch (not rely on inline display)
- PDF detection uses Go's `http.DetectContentType()` which checks for `application/pdf` — this means the first bytes must be `%PDF-`
- The template path change is the ONLY Gogs modification needed: `pdfjs-1.4.20` → `custom-pdf-render`
- `EscapePound` replaces `#` with `%23` in URLs — the `?file=` parameter may contain `%23` instead of `#`

## Functional Boundaries

**What Gogs uses (MUST implement):**
- `?file=` query parameter → fetch and render PDF
- Multi-page navigation (prev/next, page number)
- Zoom (in/out, fit-to-width)
- Text rendering (standard fonts, common encodings)
- Image rendering (JPEG, PNG-like FlateDecode images)
- Link annotations (clickable but not auto-follow)
- Loading indicator
- Error handling for corrupt/malformed files

**What PDF.js has but Gogs does NOT need:**
- Sidebar (thumbnails, outline, attachments)
- Text search (find bar)
- Presentation mode
- Print support
- Open local file
- Download button (Gogs has its own "Raw" link)
- Bookmark/current view link
- Page rotation
- Hand tool
- Document properties dialog
- Password-protected PDF support
- Form filling
- Annotation editing
- Accessibility/text layer (text selection)

This scope reduction is significant — roughly 70% of PDF.js viewer features are unused.

## Security Considerations

- The viewer runs inside an iframe serving static files — it has the same origin as Gogs itself
- PDF content streams can contain arbitrary operator sequences — the interpreter must be a whitelist of known operators, not a blacklist
- JavaScript in PDFs (`/JS`, `/JavaScript`) is the primary attack vector — must be stripped during parsing, before any interpretation
- URI schemes from PDF annotations must be whitelisted (`http:`, `https:`, `mailto:` only)
- `/Launch` actions can execute system commands via the viewer — must be stripped
- FlateDecode decompression is a DoS vector — a small compressed payload can expand to gigabytes — enforce decompression size limits
- Circular object references can cause infinite loops — track visited objects during resolution
- Deeply nested dictionaries/arrays can cause stack overflow — enforce depth limits
- The canvas rendering approach is inherently safer than DOM-based rendering — pixel data can't execute code
- Never use `eval()`, `Function()`, `innerHTML` with PDF-sourced data, or `document.write`
- The `?file=` URL itself must be validated: only same-origin or relative URLs (block `javascript:`, `data:`, cross-origin)

## Open Questions

1. **FlateDecode implementation complexity**: Implementing RFC 1951 DEFLATE from scratch in JavaScript is non-trivial (~500-800 lines). This is the hardest single sub-component. Phase 1 agent should allocate significant effort here. Consider implementing both fixed and dynamic Huffman code support.

2. **Cross-reference stream prevalence**: Modern PDF generators (Chrome "Save as PDF", macOS Preview) often use xref streams (PDF 1.5+) instead of traditional xref tables. Phase 1 must support both formats or many real-world PDFs won't load.

3. **Font metrics accuracy**: The 14 standard fonts need character width tables for proper text spacing. Without accurate widths, text will appear incorrectly spaced. Phase 2 should embed at minimum the width tables for Helvetica, Times-Roman, and Courier families.

4. **Content-Disposition: attachment**: The raw endpoint sets this header. The `fetch()` API should still be able to read the response body as ArrayBuffer despite this header (it only affects browser navigation, not programmatic fetches). Phase 3 should verify this works.

5. **Object streams (ObjStm)**: PDF 1.5+ can pack multiple objects into a single compressed stream object. Many modern PDFs use this. Phase 1 should handle object streams (`/Type /ObjStm`) or many real-world PDFs will fail to parse.
