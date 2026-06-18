## Bug: PDFDocument is not a constructor -- viewer.js uses namespace object instead of constructor

- [x] Verified

### Description
When the custom PDF renderer is loaded in a browser via Gogs' iframe, the viewer crashes with the error "PDFDocument is not a constructor". The PDF viewer fails to parse and render any PDF file.

### Cause
In `public/plugins/custom-pdf-render/web/viewer.js` at line 142, the `parsePDF` function assigns the entire namespace object to a variable named `PDFDocument`:

```javascript
var PDFDocument = window.PDFParser;       // line 142 -- BUG
var doc = new PDFDocument(buffer);        // line 143 -- crashes here
```

`window.PDFParser` is set by `public/plugins/custom-pdf-render/lib/pdf-parser.js` at lines 1712-1718 as a namespace object:

```javascript
window.PDFParser = {
  PDFDocument: PDFDocument,
  PDFParseError: PDFParseError,
  PDFTokenizer: PDFTokenizer,
  parseValue: parseValue
};
```

So `window.PDFParser` is `{ PDFDocument: [Function], PDFParseError: ..., ... }`, a plain object -- not a constructor. The code then tries to call `new` on this plain object, which throws.

### Explanation
The variable `PDFDocument` in `parsePDF()` receives the namespace object `{ PDFDocument, PDFParseError, PDFTokenizer, parseValue }` rather than the actual `PDFDocument` constructor function. When JavaScript executes `new PDFDocument(buffer)`, it attempts to invoke the plain object as a constructor. Plain objects are not callable, so the JavaScript engine throws `TypeError: PDFDocument is not a constructor`.

This is a property access omission bug -- the code should dereference `.PDFDocument` from the namespace object but does not.

### Remediation/Rectify
Change line 142 in `public/plugins/custom-pdf-render/web/viewer.js` from:

```javascript
var PDFDocument = window.PDFParser;
```

to:

```javascript
var PDFDocument = window.PDFParser.PDFDocument;
```

This extracts the actual `PDFDocument` constructor from the namespace, making `new PDFDocument(buffer)` work correctly.

No other lib files have this issue. All other `window.*` references in `viewer.js` correctly use the namespace-level access pattern:
- `window.PDFSecurity.validateFileUrl(...)` (line 109) -- correct
- `window.PDFRenderer.renderPage(...)` (lines 286, 292) -- correct
- `window.PDFAnnotations.getPageAnnotations(...)` (line 454) -- correct
- `window.PDFAnnotations.createAnnotationOverlay(...)` (line 458) -- correct

The mismatch only occurs with `PDFParser` because `viewer.js` assigns it to a local variable and then tries to use `new` on it, rather than calling a method on the namespace.

### Additional Notes / Instructions
- This is iteration 1 of the debugging cycle. The next agent should look at `report1.md`.
- The fix is a single-character-class change (appending `.PDFDocument` to the property access on line 142).
- All other lib/*.js files export to `window` correctly and are consumed correctly by `viewer.js`.
- The internal browser-path code in `pdf-parser.js` itself (lines 586-588) correctly accesses `window.PDFStreamDecoders` and `window.PDFSecurity.ResourceTracker()` -- no issues there.
- Relevant files:
  - `/home/eejon/Desktop/phase4-review/gogs/public/plugins/custom-pdf-render/web/viewer.js` (line 142 -- the bug)
  - `/home/eejon/Desktop/phase4-review/gogs/public/plugins/custom-pdf-render/lib/pdf-parser.js` (lines 1712-1718 -- the export)
  - `/home/eejon/Desktop/phase4-review/gogs/public/plugins/custom-pdf-render/web/viewer.html` (lines 11-22 -- script load order, which is correct)
