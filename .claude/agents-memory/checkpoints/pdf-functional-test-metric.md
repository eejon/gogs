# PDF Functional Test Metric (Gogs-Scoped)

## Purpose
Define a stable, reusable metric to evaluate how fully a bespoke PDF renderer covers the functional scope actually required by Gogs, and enable fair comparison against future re-implementations produced by different models.

## Scope Source
- `CLAUDE.md`
- `.claude/agents-memory/analyzer/analysis.md`
- `tests/corpus/corpus.json`

## In-Scope Functional Requirements (Gogs-Specific)
- Viewer accepts `?file=` and fetches same-origin/relative PDF bytes.
- Parser handles header, xref table/stream, trailer/root, objects, stream decode, page tree/resources.
- Rendering supports text, core graphics/path ops, colors, images used by corpus and required classes.
- Viewer UX supports page navigation, zoom (fit-width default), loading/error states, iframe embedding.
- Security: block embedded JS/actions, sanitize URIs, prevent auto-follow/navigation abuse, survive malformed inputs safely.

## Out-of-Scope (Do Not Penalize)
- Sidebar thumbnails/outline/attachments
- In-document find/search
- Presentation mode
- Print
- Open local file
- Download button
- Bookmark/current-view persistence
- Page rotation/hand tool/document properties panel
- Password-protected PDF support (error is acceptable)
- Form filling and non-link annotation editing

## Scoring Model
- Per-row rating scale:
  - `0`: missing/unsafe
  - `1`: severe deviation
  - `2`: partial with major gaps
  - `3`: acceptable with minor gaps
  - `4`: correct
  - `5`: correct and robust on edge handling
- Row score formula: `(rating / 5) * weight`
- Overall score: `sum(row scores)` out of `100`

## Hard Gates (Any Gate Fail => Overall Fail)
- Any PDF-embedded JavaScript execution occurs.
- Dangerous URI scheme is allowed (`javascript:`, `data:`, `file:`, etc.).
- Uncaught crash/hang/infinite loop on malformed/adversarial input.
- `?file=` URL policy bypass allows disallowed cross-origin fetch.
- Guardrail limits (depth/object/stream/time) are not enforced and resource exhaustion is reachable.

## Dimension Weights
- Parser/Data Pipeline: `20`
- Rendering Correctness: `35`
- Viewer/Integration UX: `15`
- Security/Resilience: `30`
- Total: `100`

## Test Matrix
| ID | Type of PDF property/functionality | Expected behavior | Pass criteria | Weight |
|---|---|---|---|---:|
| P01 | `?file=` URL parsing + policy | Accept only relative/same-origin allowed URLs | Disallowed origin/scheme blocked, allowed URLs load | 2 |
| P02 | Binary fetch pipeline | PDF fetched as bytes | Fetch handled as `ArrayBuffer` before parse | 1 |
| P03 | Header/version recognition | Valid `%PDF-` accepted, invalid magic rejected | Valid files parse; invalid files show controlled error | 1 |
| P04 | Traditional xref table support | Objects resolvable via classic xref | Page/object lookups succeed on xref-table docs | 2 |
| P05 | Xref stream support | Objects resolvable via xref streams | Page/object lookup succeeds on 1.5+ style docs | 2 |
| P06 | Trailer/root/catalog resolution | Parser finds catalog and pages root | Root/page tree reliably discovered | 2 |
| P07 | Indirect object/reference resolution | `N M obj` and `N M R` resolve safely | Missing/bad refs degrade safely, no crash | 2 |
| P08 | Stream decode (Flate) | Common compressed streams decode correctly | Content/image streams decode and render correctly | 4 |
| P09 | Stream decode (ASCIIHex/ASCII85) | Non-Flate encoded streams decode | Representative samples decode correctly | 2 |
| P10 | Page tree + inherited resources | Pages/resources inherited correctly | Correct page counts/resource availability | 2 |
| R01 | Text operator handling | Text operators produce expected text layout | Visual/text positioning within tolerance | 4 |
| R02 | Standard fonts + encodings | Standard 14 fonts and encodings are usable | No major glyph mapping corruption | 3 |
| R03 | Text matrix/spacing | Spacing, leading, transforms behave correctly | No obvious drift/overlap in reference cases | 3 |
| R04 | Graphics state stack (`q/Q/cm`) | Save/restore and CTM compose correctly | Nested transforms restore correctly | 3 |
| R05 | Path/paint/clip/color operators | Core vector graphics render correctly | Shapes/fills/strokes/clips match expectations | 3 |
| R06 | JPEG image XObjects | DCT images decode and place correctly | Drawn at expected size/position | 3 |
| R07 | Flate images + predictors | Predictor handling renders correctly | Predictor 10-15 cases render as expected | 4 |
| R08 | BitsPerComponent coverage | 1/2/4/8 bpc image decoding works | Tonal/palette integrity preserved | 2 |
| R09 | Color spaces | Gray/RGB/CMYK/Indexed/ICCBased fallback are correct enough | Colors within agreed tolerance | 3 |
| R10 | Image masks and soft masks | Transparency/mask behavior correct | Alpha/stencil behavior matches expectation | 2 |
| R11 | Inline images (`BI/ID/EI`) | Inline image streams render | Visible correct placement/dimensions | 1 |
| R12 | ExtGState alpha (`ca`/`CA`) | Fill/stroke alpha applied | Opacity layering visibly correct | 2 |
| R13 | Shading (`sh`) and fallback | Supported shading renders, unsupported degrades safely | No crash; expected gradient/fallback behavior | 2 |
| V01 | Page navigation | Prev/next/jump works with bounds checks | Correct page transitions and bounds behavior | 4 |
| V02 | Zoom and fit-width default | Fit-width default, zoom rerenders correctly | Zoom controls behave correctly and remain readable | 4 |
| V03 | Loading and error UI | Load progress and friendly error states shown | Indicators/errors shown/cleared correctly | 2 |
| V04 | Link annotations | Link overlays function safely | External `_blank` + `noopener noreferrer`; internal GoTo works | 3 |
| V05 | Iframe embedding behavior | Stable in Gogs iframe constraints | No iframe breakout; layout/scroll works | 2 |
| S01 | Embedded JS stripping | JS actions never execute | No dialogs/eval/script side effects | 8 |
| S02 | URI scheme sanitization | Only safe schemes allowed | `http/https/mailto` allowed, dangerous schemes blocked | 6 |
| S03 | Dangerous action blocking | Launch/form/import actions blocked | Actions removed/ignored without side effects | 4 |
| S04 | Malformed/corrupt resilience | No crash/hang on malformed inputs | Structured error or graceful partial parse only | 5 |
| S05 | Guardrails/limits | Bounds prevent runaway parse/render | Depth/object/stream/time limits enforced | 4 |
| S06 | DOM/network safety | No unsafe DOM sinks/extra network behavior | No unauthorized network calls or risky DOM execution paths | 3 |

## Corpus Mapping Strategy
- Baseline core corpus classes from `tests/corpus/corpus.json`:
  - `text-only.pdf`: text rendering and layout
  - `images.pdf`: raster rendering
  - `mixed.pdf`: text + image mixed layout
  - `links.pdf`: link annotations and no auto-follow
  - `poc.pdf`: security gate (JS/action sanitization)
  - `malformed.pdf`: graceful failure and resilience
- Add feature-isolated PDFs to close coverage for rows not fully represented in core corpus (e.g., xref streams, predictors, masks, shading, advanced color spaces, guardrail stress cases).
- Keep corpus versioned with checksums to ensure future model comparisons are against identical inputs.

## Comparison Output Schema (Per Future Run)
- `run_id`
- `commit_hash`
- `model_id`
- `corpus_version`
- `environment` (browser/runtime/os)
- `gate_status` (`pass`/`fail`, with reasons)
- `overall_score` (0-100)
- `dimension_scores` (`parser`, `rendering`, `viewer`, `security`)
- `row_scores` (ID -> rating, weighted score, notes/evidence)
- `regressions` (rows worse than baseline)
- `improvements` (rows better than baseline)

## Usage Notes
- Use this metric for both acceptance (minimum threshold + hard gates) and relative comparison across implementations.
- Recommended acceptance threshold for "functionally viable for Gogs": overall `>= 85` and all hard gates passing.
