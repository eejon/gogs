# PDF Producer Types
1. pdflatex - embedded Type1 subsets (CMBX, CMSS, CMR), custom encodings, /Differences arrays.
2. XeLaTeX/LuaLaTeX — embedded OpenType/TrueType via CIDFont Type2, Identity-H encoding, /W width arrays.
3. Microsoft Word / LibreOffice Writer — TrueType subsets (Calibri, Liberation), simple /Widths + /FirstChar, typically WinAnsiEncoding.
4. Google Docs "Download as PDF"
5. TikZ/pgf (via pdflatex) — heavy use of path operators (m/l/c), clipping (W), sometimes tiling patterns, nested Form XObjects for reusable diagram elements.
6. Inkscape / Adobe Illustrator export — complex vector paths, gradients (shading patterns), transparency groups, occasionally spot colors. \[Skipped\]
7. Matplotlib / R ggplot — chart-style output: many short path segments, text labels at arbitrary angles (rotated text matrices), sometimes Type3 fonts for math labels.
8. Scanner/OCR output — CCITT Group 4 for B&W scans, JBIG2 for higher-compression B&W, DCTDecode (JPEG) for color scans.
9. Browser "Print to PDF" (Chrome/Firefox) — full-page raster images or heavily fragmented text runs with absolute positioning, DCTDecode images.

## Test Matrix
| ID | Type of PDF property/functionality | Expected behavior | Pass criteria |
|---|---|---|---|
| P01 | `?file=` URL parsing + policy | Accept only relative/same-origin allowed URLs | Disallowed origin/scheme blocked, allowed URLs load |
| P02 | Binary fetch pipeline | PDF fetched as bytes | Fetch handled as `ArrayBuffer` before parse |
| P03 | Header/version recognition | Valid `%PDF-` accepted, invalid magic rejected | Valid files parse; invalid files show controlled error |
| P04 | Traditional xref table support | Objects resolvable via classic xref | Page/object lookups succeed on xref-table docs |
| P05 | Xref stream support | Objects resolvable via xref streams | Page/object lookup succeeds on 1.5+ style docs |
| P06 | Trailer/root/catalog resolution | Parser finds catalog and pages root | Root/page tree reliably discovered |
| P07 | Indirect object/reference resolution | `N M obj` and `N M R` resolve safely | Missing/bad refs degrade safely, no crash |
| P08 | Stream decode (Flate) | Common compressed streams decode correctly | Content/image streams decode and render correctly |
| P09 | Stream decode (ASCIIHex/ASCII85) | Non-Flate encoded streams decode | Representative samples decode correctly |
| P10 | Page tree + inherited resources | Pages/resources inherited correctly | Correct page counts/resource availability |
| R01 | Text operator handling | Text operators produce expected text layout | Visual/text positioning within tolerance |
| R02 | Standard fonts + encodings | Standard 14 fonts and encodings are usable | No major glyph mapping corruption |
| R03 | Text matrix/spacing | Spacing, leading, transforms behave correctly | No obvious drift/overlap in reference cases |
| R04 | Graphics state stack (`q/Q/cm`) | Save/restore and CTM compose correctly | Nested transforms restore correctly |
| R05 | Path/paint/clip/color operators | Core vector graphics render correctly | Shapes/fills/strokes/clips match expectations |
| R06 | JPEG image XObjects | DCT images decode and place correctly | Drawn at expected size/position |
| R07 | Flate images + predictors | Predictor handling renders correctly | Predictor 10-15 cases render as expected |
| R08 | BitsPerComponent coverage | 1/2/4/8 bpc image decoding works | Tonal/palette integrity preserved |
| R09 | Color spaces | Gray/RGB/CMYK/Indexed/ICCBased fallback are correct enough | Colors within agreed tolerance |
| R10 | Image masks and soft masks | Transparency/mask behavior correct | Alpha/stencil behavior matches expectation |
| R11 | Inline images (`BI/ID/EI`) | Inline image streams render | Visible correct placement/dimensions |
| R12 | ExtGState alpha (`ca`/`CA`) | Fill/stroke alpha applied | Opacity layering visibly correct |
| R13 | Shading (`sh`) and fallback | Supported shading renders, unsupported degrades safely | No crash; expected gradient/fallback behavior |
| V01 | Page navigation | Prev/next/jump works with bounds checks | Correct page transitions and bounds behavior |
| V02 | Zoom and fit-width default | Fit-width default, zoom rerenders correctly | Zoom controls behave correctly and remain readable |
| V03 | Loading and error UI | Load progress and friendly error states shown | Indicators/errors shown/cleared correctly |
| V04 | Link annotations | Link overlays function safely | External `_blank` + `noopener noreferrer`; internal GoTo works |
| V05 | Iframe embedding behavior | Stable in Gogs iframe constraints | No iframe breakout; layout/scroll works |
| S01 | Embedded JS stripping | JS actions never execute | No dialogs/eval/script side effects |
| S02 | URI scheme sanitization | Only safe schemes allowed | `http/https/mailto` allowed, dangerous schemes blocked |
| S03 | Dangerous action blocking | Launch/form/import actions blocked | Actions removed/ignored without side effects |
| S04 | Malformed/corrupt resilience | No crash/hang on malformed inputs | Structured error or graceful partial parse only |
| S05 | Guardrails/limits | Bounds prevent runaway parse/render | Depth/object/stream/time limits enforced |
| S06 | DOM/network safety | No unsafe DOM sinks/extra network behavior | No unauthorized network calls or risky DOM execution paths |