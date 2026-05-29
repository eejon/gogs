# Phase 1 Parser Test Results

**Date**: 2026-05-28T02:41:12.333Z

## Summary

| Total | Pass | Fail |
|-------|------|------|
| 25 | 25 | 0 |

## Per-Test Results

| Test | Status | Notes |
|------|--------|-------|
| text-only.pdf/instantiate | PASS | PDFParser constructed |
| text-only.pdf/header | PASS | version=1.4 |
| text-only.pdf/load | PASS | loaded OK |
| text-only.pdf/page-count | PASS | pageCount=3 |
| images.pdf/instantiate | PASS | PDFParser constructed |
| images.pdf/header | PASS | version=1.4 |
| images.pdf/load | PASS | loaded OK |
| images.pdf/page-count | PASS | pageCount=1 |
| mixed.pdf/instantiate | PASS | PDFParser constructed |
| mixed.pdf/header | PASS | version=1.4 |
| mixed.pdf/load | PASS | loaded OK |
| mixed.pdf/page-count | PASS | pageCount=1 |
| links.pdf/instantiate | PASS | PDFParser constructed |
| links.pdf/header | PASS | version=1.4 |
| links.pdf/load | PASS | loaded OK |
| links.pdf/page-count | PASS | pageCount=1 |
| poc.pdf/instantiate | PASS | PDFParser constructed |
| poc.pdf/header | PASS | version=1.7 |
| poc.pdf/load | PASS | loaded OK |
| poc.pdf/page-count | PASS | pageCount=1 |
| poc.pdf/no-js-after-sanitize | PASS | no JavaScript actions in sanitized document |
| poc.pdf/page-count-security | PASS | page_count=1 (security gate PDF) |
| malformed.pdf/instantiate | PASS | PDFParser constructed |
| malformed.pdf/header | PASS | version=1.4 |
| malformed.pdf/error-return | PASS | returned error as expected: startxref not found |
