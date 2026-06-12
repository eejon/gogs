---
name: phase-1
description: Implements the PDF binary parser and security filter for the custom PDF renderer in Gogs.
---
## Context
Read `.claude/agents-memory/analyzer/analysis.md` and `.claude/agents-memory/analyzer/MEMORY.md` before starting.

## Your Task
Implement phase 1 as specified in `analysis.md`, section "Phase 1: PDF Binary Parser and Security Filter".

## Definition of Done
- All checkboxes in the Phase 1 test section of `analysis.md` must pass.
- Run tests against the corpus at `tests/corpus/` to verify.

## Testing
Refer to `analysis.md` on testing scope and requirements.

## Generic Testing Rules
Use Node.js for parser-level tests and Playwright for browser-level tests. Save screenshots of each corpus PDF render to `tests/screenshots/`.
Write test scripts and run it with `node tests/test-runner.js` and check exit code.

Run Node.js tests first. Only proceed to Playwright tests if Node.js
tests pass — browser-level testing on a broken parser wastes time.

| Check | How |
| ------ | ----- |
| Parser Correctness | Node.js test script |
| PoC Safety | Node.js + grep |
| Malformed handling | Node.js test script |
| Something rendered | Playwright canvas pixel check |
| No JS execution | Playwright dialog intercept |

Expected test results for each pdf corpus type can be derived from properties of each pdf corpus type in `tests/corpus.json`.

Report tests status to `tests/run<run_number>/results.md`

## Constraints
- Should use the same `test-runner.js` for all tests in each run. Only refine where necessary for next run.
- No external imports
- Do not reference any implementation details from `public/plugins/pdfjs-1.4.20/`. All code should be written independent of pdfjs' original implementation.
- Do not reference any implementation details from pdfjs' official [github repository](https://github.com/mozilla/pdf.js/).
- All output goes under `public/plugins/custom-pdf-render/`
- Do not modify any existing Gogs source files
- If a test fails after two revision attempts, document the failure and stop — do not paper over it

## Handoff
When done, write `.claude/agents-memory/handoffs/phase1-parser.md` containing:
- What was built and where
- Public interface (classes, key functions, inputs, outputs)
- Assumptions made
- Any known gaps or deferred decisions

This applies to sub-phases as well. When a subphase is complete, append to the same `phase1-parser.md`.

## Checkpointing
After completing each individual component (each file or function group), immediately write a progress checkpoint to  `.claude/agents-memory/checkpoints/<phase-name>.md` containing:
- Components completed so far (with file paths)
- Current component in progress
- Components remaining
- Any decisions made that affect remaining work

Do not wait until phase completion to write progress.
Update the checkpoint after every completed file.
