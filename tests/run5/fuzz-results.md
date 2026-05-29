# Phase 4 Security Fuzz Test Results

**Date**: 2026-05-28T02:41:08.072Z
**Agent**: phase4-integration

## Summary

| Total Variants | Pass | Fail | Time |
|----------------|------|------|------|
| 60 | 60 | 0 | 0.0s |

## Variant Types

| Type | Count per PDF | Description |
|------|---------------|-------------|
| truncate-10pct | 1 | File truncated to 10% of original size |
| truncate-25pct | 1 | File truncated to 25% of original size |
| truncate-50pct | 1 | File truncated to 50% of original size |
| truncate-75pct | 1 | File truncated to 75% of original size |
| header-flip-1  | 1 | 1-4 bytes XOR-flipped in first 1024 bytes |
| header-flip-2  | 1 | 1-4 bytes XOR-flipped in first 1024 bytes (different seed) |
| zero-region-1  | 1 | 64-byte block zeroed at random mid-file offset |
| zero-region-2  | 1 | 64-byte block zeroed at random mid-file offset (different seed) |
| js-inject-1    | 1 | "javascript:alert(1)" injected at random offset |
| js-inject-2    | 1 | "javascript:alert(1)" injected at random offset (different seed) |

## Assertions per Variant

1. `parser.load()` must not throw (must return `{error: ...}` on failure)
2. Result is an object with `pages` or `pageCount` if no error
3. After `sanitizeCatalog` + `sanitizeObject`, no JavaScript action survives

## Per-Test Results

| Test | Status | Notes |
|------|--------|-------|
| fuzz/text-only.pdf/truncate-10pct | PASS | error (expected): startxref not found |
| fuzz/text-only.pdf/truncate-25pct | PASS | error (expected): startxref not found |
| fuzz/text-only.pdf/truncate-50pct | PASS | error (expected): startxref not found |
| fuzz/text-only.pdf/truncate-75pct | PASS | error (expected): startxref not found |
| fuzz/text-only.pdf/header-flip-1 | PASS | parsed OK, no JS, pageCount=3 |
| fuzz/text-only.pdf/header-flip-2 | PASS | parsed OK, no JS, pageCount=3 |
| fuzz/text-only.pdf/zero-region-1 | PASS | parsed OK, no JS, pageCount=3 |
| fuzz/text-only.pdf/zero-region-2 | PASS | parsed OK, no JS, pageCount=3 |
| fuzz/text-only.pdf/js-inject-1 | PASS | error (expected): Expected name key in dictionary at offset 19258 |
| fuzz/text-only.pdf/js-inject-2 | PASS | error (expected): Expected name key in dictionary at offset 19258 |
| fuzz/images.pdf/truncate-10pct | PASS | error (expected): startxref not found |
| fuzz/images.pdf/truncate-25pct | PASS | error (expected): startxref not found |
| fuzz/images.pdf/truncate-50pct | PASS | error (expected): startxref not found |
| fuzz/images.pdf/truncate-75pct | PASS | error (expected): startxref not found |
| fuzz/images.pdf/header-flip-1 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/images.pdf/header-flip-2 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/images.pdf/zero-region-1 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/images.pdf/zero-region-2 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/images.pdf/js-inject-1 | PASS | error (expected): Expected name key in dictionary at offset 215183 |
| fuzz/images.pdf/js-inject-2 | PASS | error (expected): Expected name key in dictionary at offset 215183 |
| fuzz/mixed.pdf/truncate-10pct | PASS | error (expected): startxref not found |
| fuzz/mixed.pdf/truncate-25pct | PASS | error (expected): startxref not found |
| fuzz/mixed.pdf/truncate-50pct | PASS | error (expected): startxref not found |
| fuzz/mixed.pdf/truncate-75pct | PASS | error (expected): startxref not found |
| fuzz/mixed.pdf/header-flip-1 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/mixed.pdf/header-flip-2 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/mixed.pdf/zero-region-1 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/mixed.pdf/zero-region-2 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/mixed.pdf/js-inject-1 | PASS | error (expected): Expected name key in dictionary at offset 57589 |
| fuzz/mixed.pdf/js-inject-2 | PASS | error (expected): Expected name key in dictionary at offset 57589 |
| fuzz/links.pdf/truncate-10pct | PASS | error (expected): startxref not found |
| fuzz/links.pdf/truncate-25pct | PASS | error (expected): startxref not found |
| fuzz/links.pdf/truncate-50pct | PASS | error (expected): startxref not found |
| fuzz/links.pdf/truncate-75pct | PASS | error (expected): startxref not found |
| fuzz/links.pdf/header-flip-1 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/links.pdf/header-flip-2 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/links.pdf/zero-region-1 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/links.pdf/zero-region-2 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/links.pdf/js-inject-1 | PASS | error (expected): Expected name key in dictionary at offset 23128 |
| fuzz/links.pdf/js-inject-2 | PASS | error (expected): Expected name key in dictionary at offset 23128 |
| fuzz/poc.pdf/truncate-10pct | PASS | error (expected): startxref not found |
| fuzz/poc.pdf/truncate-25pct | PASS | error (expected): startxref not found |
| fuzz/poc.pdf/truncate-50pct | PASS | error (expected): startxref not found |
| fuzz/poc.pdf/truncate-75pct | PASS | error (expected): startxref not found |
| fuzz/poc.pdf/header-flip-1 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/poc.pdf/header-flip-2 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/poc.pdf/zero-region-1 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/poc.pdf/zero-region-2 | PASS | parsed OK, no JS, pageCount=1 |
| fuzz/poc.pdf/js-inject-1 | PASS | error (expected): Expected name key in dictionary at offset 20272 |
| fuzz/poc.pdf/js-inject-2 | PASS | error (expected): Expected name key in dictionary at offset 20272 |
| fuzz/malformed.pdf/truncate-10pct | PASS | error (expected): startxref not found |
| fuzz/malformed.pdf/truncate-25pct | PASS | error (expected): startxref not found |
| fuzz/malformed.pdf/truncate-50pct | PASS | error (expected): startxref not found |
| fuzz/malformed.pdf/truncate-75pct | PASS | error (expected): startxref not found |
| fuzz/malformed.pdf/header-flip-1 | PASS | error (expected): startxref not found |
| fuzz/malformed.pdf/header-flip-2 | PASS | error (expected): startxref not found |
| fuzz/malformed.pdf/zero-region-1 | PASS | error (expected): startxref not found |
| fuzz/malformed.pdf/zero-region-2 | PASS | error (expected): startxref not found |
| fuzz/malformed.pdf/js-inject-1 | PASS | error (expected): startxref not found |
| fuzz/malformed.pdf/js-inject-2 | PASS | error (expected): startxref not found |
