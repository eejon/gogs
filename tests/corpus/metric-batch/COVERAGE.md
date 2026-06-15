# Metric Batch Coverage Map

This batch provides tangible PDF fixtures for parser/render/security requirements in `.claude/agents-memory/checkpoints/pdf-functional-test-metric.md`.

## Covered by files
- `P03 P04 P05 P06 P08 P09 P10`
- `R01 R02 R03 R04 R05 R06 R07 R08 R09 R11 R12 R13`
- `S01 S02 S03 S04 S05`
- `V01` (page-count/navigation precondition) and part of `V04` (link payload)

## Not purely PDF-file driven
These require viewer/runtime/harness checks in addition to fixture files:
- `P01 P02`
- `V02 V03 V05`
- `S06`

## Pending isolated fixture
- `R10` (ImageMask + SMask) is not isolated in this first batch.
