Research objective: Investigate whether an AI-generated bespoke implementation can replace an upstream dependency (PDF.js) in downstream software (Gogs) to reduce inherited vulnerability exposure, while maintaining sufficient functional viability.

What we're NOT proving: That AI-generated code is bug-free or secure. We accept that undiscovered vulnerabilities may exist. The focus is on reducing inherited risk (transitive dependencies, supply-chain, CVE exposure, maintenance burden) — not proving absolute security.

The artifact being evaluated is the final output of: initial LLM generation + human review + additional LLM fixes + testing. It's evaluating the viability of the replacement artifact, not the raw capability of the initial model output.

Two-stage evaluation — completeness THEN correctness:

1. Functional Completeness (pass/fail gate): Does the implementation attempt to handle every class of input that Gogs + PDF.js supports? This is checked against producer-diverse PDF corpus and the requirement inventory (P01–P10 parser, R01–R13 rendering, V01–V05 viewer, S01–S06 security — 32 rows total in pdf-functional-test-metric.md). Completeness must pass before correctness is measured. Missing feature categories (e.g., embedded Type1 fonts, CCITT scanscorrectness defects.
2. Functional Fidelity (scored, the primary correctness metric): How well do implemented features match PDF.js as a behavioral reference? PDF.js is the reference implementation, not absolute
ground truth. Composite score (FFS):
  - 35% Structural Fidelity (placement, baseline, spacing)
  - 35% Glyph Fidelity (correct characters, font weight/style)
  - 20% Semantic Layout Fidelity (math structure, fractions, sub/superscripts)
  - 10% Visual Similarity (SSIM, pixel diff — supporting only)
3. Robustness (success rate across held-out corpus): successful renders / total PDFs, stratified by complexity (simple text → math-heavy → adversarial/malformed).
4. Security Benefit (comparative): Dependency count reduction, CVE exposure redutatic analysis findings (Semgrep/CodeQL/ESLint). This is the payoff side of theresearch question.

Hard gates (any fail = overall fail): JS execution occurs; dangerous URI scheme allowed; crash/hang on malformed input; origin-policy bypass; guardrail limits not enforced.

Critical lesson from first iteration: The original analysis derived requirements from PDF.js's UI surface and operator list, missing entire producer ecosystems. LaTeX fonts (CMBX/CMSS — no
"bold" in name), CCITT scanned docs, and tiling patterns were all absent from thhe implementation. The fix is to source corpus by PDF producer (pdflatex, XeLaTeX, Word/LibreOffice, TikZ, matplotlib, scanner/OCR, browser print-to-PDF), not just by PDF feature. The analyzer must cross-check its feature map against both the requirement inventory AND the
producer-diverse corpus.

Corpus separation: Development corpus (used during implementation/bug-fixing) muuation corpus (held-out, never seen during development). Final metrics use onlythe held-out corpus. Both are versioned with SHA256 checksums.

Architectural ceiling identified: Font substitution (CSS fallback instead of embedded glyph outline rendering) causes visual width mismatches — the PDF's advance widths are from the embedded font metrics, but the browser renders with a substitute font of different proporented limitation, not an open defect. Attempting to scale glyphs to compensatebreaks diagrams. This should be scored honestly under Glyph Fidelity, not worked around.

Viability threshold: Overall FFS >= 85, all hard gates passing, robustness success rate reportable per complexity tier.
