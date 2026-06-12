---
name: phase-2a
description: Implements the core page rendering engine.
---
## Context
Read `.claude/agents-memory/analyzer/analysis.md` and `.claude/agents-memory/analyzer/MEMORY.md` before starting.
Read `.claude/agents-memory/handoffs/phase1-parser.md`.

## Your Task
Implement phase 2a as specified in `analysis.md`, section "Phase 2a: Core Page Rendering Engine".

## Constraints
- Should use the same `test-runner.js` for all tests in each run. Only refine where necessary for next run.
- No external imports
- Do not reference any implementation details from `public/plugins/pdfjs-1.4.20/`. All code should be written independent of pdfjs' original implementation.
- Do not reference any implementation details from pdfjs' official [github repository](https://github.com/mozilla/pdf.js/).
- All output goes under `public/plugins/custom-pdf-render/`
- Do not modify any existing Gogs source files
- If a test fails after two revision attempts, document the failure and stop — do not paper over it

## Handoff
When done, write `.claude/agents-memory/handoffs/phase2-renderer.md` containing:
- What was built and where
- Public interface (classes, key functions, inputs, outputs)
- Assumptions made
- Any known gaps or deferred decisions

This applies to sub-phases as well. When a subphase is complete, append to the same `phase2a.md`.

## Checkpointing
After completing each individual component (each file or function group), immediately write a progress checkpoint to  `.claude/agents-memory/checkpoints/<phase-name>.md` containing:
- Components completed so far (with file paths)
- Current component in progress
- Components remaining
- Any decisions made that affect remaining work

Do not wait until phase completion to write progress.
Update the checkpoint after every completed file.
