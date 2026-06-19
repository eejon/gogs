# Functional Coherence Evaluation

## Overview

**Subject**: Custom PDF renderer (AI-generated bespoke implementation)
**Baseline**: PDF.js 1.4.20 (bundled in Gogs 0.13.2)
**Downstream application**: Gogs (self-hosted Git service)
**Evaluator**: ___
**Date**: ___

### Purpose

Evaluate the extent to which the custom PDF renderer meets the functional requirements
of PDF.js, scoped to Gogs' embedded PDF viewing use case.

This evaluation does **not** assess:
- Implementation approach or internal code design
- Security features unique to the custom implementation (covered in a separate security posture study)
- Features PDF.js provides that Gogs does not use (sidebar, search, print, download, text selection, etc.)

### Scoring Guide

| Score | Meaning |
|-------|---------|
| 5 | Fully functional, indistinguishable from PDF.js for this category |
| 4 | Correct with minor cosmetic differences |
| 3 | Core content readable/functional, but noticeable differences |
| 2 | Partially functional, significant gaps |
| 1 | Present but largely unusable |
| 0 | Fails entirely |

### Evaluation Matrix Reference

Full matrix with weights: `tests/evaluation-matrix-v2.md`
Scoring rubric (capability details): `tests/evaluation-matrix-v2.md`, Appendix A

---

## Section 1: PDF Support Coverage

**Method**: Render representative PDFs from `tests/corpus/` in both PDF.js and the custom renderer.
Score based on visual and functional fidelity.

| # | Producer Type | Weight | Score | Weighted | Corpus Files Used | Observations |
|---|--------------|--------|-------|----------|-------------------|--------------|
| 1.1 | pdflatex | 5 | 2/5 | 10 | 1.pdf | Math symbols (Type1/CMR font subsets) not rendering — likely missing glyph mappings |
| 1.2 | XeLaTeX / LuaLaTeX | 4 | 2/5 | 8 | 2.pdf | Font shapes wrong, missing icons|
| 1.3 | Microsoft Word / LibreOffice Writer | 5 | 4/5 | 20 | 3.pdf | Font and spacing slightly off |
| 1.4 | Google Docs export | 4 | 2/5 | 8 | 4.pdf | Embedded Google fonts fall back to generic families — text readable but visually wrong |
| 1.5 | TikZ / pgf (via pdflatex) | 4 | 5/5 | 20 | 5.pdf | Diagrams are all gnerated perfectly|
| 1.6 | Matplotlib / R ggplot | 3 | 5/5 | 15 | 7.pdf | Exact match |
| 1.7 | Scanner / OCR output | 4 | 2/5 | 8 | 8.pdf | More or less there, just that one of the scanned images was color inverted |
| 1.8 | Browser "Print to PDF" | 4 | 4/5 | 16 | 9.pdf | Fonts are slightly off (spacing, size, style), lack of italics. |
| | **Section total** | **33** | | **105/165** |  | 63.6% (1.d.p.) |

### Section 1 Observations

<!-- Free-form notes on rendering quality, specific issues noticed, etc. -->

#### Noticeable gaps:
1. Math symbols not rendering correctly (pdflatex)
2. Font spacing overflow (pdflatex)
3. Font shapes are wrong (XeLatex)
4. Missing icons for XeLatex
5. Embedded Google fonts fall back to generic families
6. Color inversion in scannd / OCR output for 1 of the images
8. Lack of italics.

Seems like fonts in general are the most buggy. This is likely due to complex glyph rendering mechanics. Custom implementation approach does not evaluate glyph fonts on the fly like in pdf.js, likely the reason the approach is harder.

---

## Section 2: Downstream Integration & UI

**Method**: Combination of automated structural checks (`evaluation/03-integration-checks.sh`)
and manual browser testing.

### Automated Results

Script: `evaluation/03-integration-checks.sh`
Run date: <u>19/06/2026</u>

| Check | Result |
|-------|--------|
| 2.2 Template path swap (4 checks) | 4 / 4 |
| 2.3 Static file serving (5 checks) | 5 / 5 |
| 2.10 Iframe-safe behavior (6 checks) | 6 / 6 |

### Scored Items

| # | Feature | Weight | Score | Weighted | Observations |
|---|---------|--------|-------|----------|--------------|
| 2.1 | ?file= param loads PDF | 5 | 5/5 | 25 | |
| 2.2 | Template path swap | 5 | 4/4 | 20 | Automated: 4 / 4 checks pass |
| 2.3 | Static file serving | 5 | 5/5 | 25 | Automated: 5 / 5 checks pass |
| 2.4 | Page navigation | 5 | 5/5 | 25 | Small nit in navigation buttons - there are 2 separate buttons to control page number |
| 2.5 | Zoom controls | 4 | 2/5 | 8 | Zoom is not behaving correctly, crops content |
| 2.6 | Loading indicator | 3 | 5/5 | 15 | |
| 2.7 | Error display | 4 | 4/5 | 16 | Does not show error for `viewer.html?file=...` |
| 2.8 | Multi-page scroll | 4 | 4/5 | 16 | Not supported for `viewer.html?file=...` |
| 2.9 | Page rotation handling | 4 | 5/5 | 20 | Landscape pages rendered in correct orientation |
| 2.10 | Iframe-safe behavior | 5 | 5/5 | 25 | Automated: 6 / 6 checks pass |
| 2.11 | Responsive to resize | 3 | 5/5 | 15 | |
| 2.12 | Link annotations | 4 | 4/5 | 16 | Lacks support for in-document links/references, undecided if necessary |
| | **Section total** | **51** | | **226/255** |  88.6% (1 d.p.) |

### Section 2 Observations

<!-- Free-form notes on integration behavior, UI issues, etc. -->

#### Noticeable gaps
1. Navigation button has additional vertical toggle
2. Zoom crops content
3. viewer.html does not show error for malformed pdf files (but does show in iframe)
4. No page scroll in viewer.html
5. Lacks support for in-document link/references

---

## Section 3: Security (Functional Parity)

**Scope**: Only security behaviors that PDF.js also exhibits.
**Method**: Automated tests (`evaluation/02-security-parity.js`) covering functional checks.

### Automated Results

Script: `evaluation/02-security-parity.js`
Run date: ___

| Check | Tests | Passed |
|-------|-------|--------|
| 3.1 URL origin validation | 11 | 11 |
| 3.2 JS never executes | 6 | 6 |
| 3.3 Dangerous actions blocked | 15 | 15 |
| 3.4 External links safe | 7 | 7 |
| 3.6 No unauthorized network | 4 | 4 |
| **Total** | **43** | 43 |

### Scored Items

| # | Behavior | Weight | Score | Weighted | Observations |
|---|----------|--------|-------|----------|--------------|
| 3.1 | URL origin validation | 5 | /5 | | Automated: ___ / 11 pass |
| 3.2 | Embedded JS never executes | 5 | /5 | | Automated: ___ / 6 pass |
| 3.3 | Dangerous actions not available | 5 | /5 | | Automated: ___ / 15 pass |
| 3.4 | External links open safely | 4 | /5 | | Automated: ___ / 7 pass |
| 3.5 | Malformed PDF resilience | 5 | /5 | | Manual: test with corpus |
| 3.6 | No unauthorized network requests | 4 | /5 | | Automated: ___ / 4 pass |
| | **Section total** | **28** | | **/140** | |

### Section 3 Observations

<!-- Free-form notes on security behavior, edge cases, etc. -->

### Note on Defense-in-Depth Features

The custom implementation introduces security mechanisms not present in PDF.js.
These are **not scored here** but should be documented in a separate security posture study:

- `ResourceTracker` with explicit limits (max objects: 100K, recursion depth: 50, decompression: 100MB, timeout: 30s)
- Action type allowlist (explicit enumeration vs implicit omission)
- `sanitizeStringForDOM()` validation checkpoint
- Circular reference detection in parser and renderer
- Max page dimension enforcement (14,400pt)
- `containsJavaScript()` detection function

---

## Overall Summary

| Section | Weight | Max Weighted | Weighted Score | % |
|---------|--------|--------------|----------------|---|
| 1. PDF Support Coverage | 33 | 165 | | |
| 2. Integration & UI | 51 | 255 | | |
| 3. Security (Parity) | 28 | 140 | | |
| **Total** | **112** | **560** | | |

---

## Section 4: Viability Metrics

Computed by `evaluation/01-viability-metrics.sh`. Not scored — provides quantitative
context for the supply-chain viability argument.

Run date: ___

| Metric | PDF.js | Custom | Delta | Keep |
|--------|--------|--------|-------| -----|
| Lines of code | 64116 | 10605 | -53511 (83.4%) | Y |
| File count | 92 | 11 | -81 (88.0%) | Y |
| External runtime deps | 0 | 0 | 0 | N |
| Externally maintained projects | 1 | 0 | -1 | Y |
| Dependency chain depth | 1 | 0 (in-house implementation) | -1 | Y |
| Known CVEs (bundled version) | 1 ([CVE-2024-4367](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq)) | 0 | -1 | Y |
| Build step required | No | No | Parity | N |
| Polyfill layer | Yes | No | Eliminated | N |

---

## Evaluation Scripts

| Script | Section | What it checks | How to run |
|--------|---------|---------------|------------|
| `evaluation/01-viability-metrics.sh` | 4 | LOC, files, deps, supply chain | `bash evaluation/01-viability-metrics.sh` |
| `evaluation/02-security-parity.js` | 3 | URL validation, JS blocking, action filtering, network safety | `node evaluation/02-security-parity.js` |
| `evaluation/03-integration-checks.sh` | 2 (partial) | Template, static serving, iframe safety | `bash evaluation/03-integration-checks.sh` |

---

## Conclusions

<!-- 
Summarize:
1. Overall functional coherence — does the custom renderer adequately replace PDF.js for Gogs?
2. Key gaps — which producer types or features scored low? Are they acceptable for the use case?
3. Viability argument — does the supply-chain reduction justify the feature coverage level?
4. Recommendations — ship as-is, remediate specific gaps, or not viable?
-->

---

## Appendix: Test Corpus

List the PDF files used for Section 1 evaluation and their producer types.

| File | Producer Type | Pages | Notable Features |
|------|-------------|-------|-----------------|
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |
