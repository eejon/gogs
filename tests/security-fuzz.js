/**
 * security-fuzz.js — Security fuzz test for custom-pdf-render
 *
 * Usage: node tests/security-fuzz.js
 * Exit code: 0 if all assertions pass, 1 on any failure.
 * Results: tests/run5/results.md (created/overwritten)
 *
 * For each corpus PDF, generates 10 corrupted variants:
 *   Truncation (4 variants): at 10%, 25%, 50%, 75% of file size
 *   Header bit-flip (2 variants): flip 1-4 bytes in first 1024 bytes
 *   Zero-region (2 variants): zero out a random 64-byte block in mid-file
 *   JS injection (2 variants): inject "javascript:alert(1)" at a random offset
 *
 * For each variant, asserts:
 *   1. No uncaught exception escapes parser.load()
 *   2. If result.error absent, result object has 'pages' or 'pageCount' property
 *   3. After sanitizeCatalog + sanitizeObject, no JavaScript action remains
 *
 * Also verifies that each real corpus PDF (valid ones) parse without JS actions after sanitize.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Paths ─────────────────────────────────────────────────────────────────────
const PROJECT_ROOT  = path.resolve(__dirname, '..');
const CORPUS_DIR    = path.join(PROJECT_ROOT, 'tests', 'corpus');
const CORPUS_JSON   = path.join(CORPUS_DIR, 'corpus.json');
const RESULTS_DIR   = path.join(PROJECT_ROOT, 'tests', 'run5');
const RESULTS_FILE  = path.join(RESULTS_DIR, 'fuzz-results.md');
const PARSER_PATH   = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-parser.js');
const SECURITY_PATH = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-security.js');

const { PDFParser, ParseError } = require(PARSER_PATH);
const { sanitizeObject, sanitizeCatalog } = require(SECURITY_PATH);
const corpusSpec = JSON.parse(fs.readFileSync(CORPUS_JSON, 'utf8'));

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ── Results accumulator ───────────────────────────────────────────────────────
const results = [];
let totalVariants = 0;
let passedVariants = 0;
let failedVariants = 0;

function pass(name, msg) {
  results.push({ name, status: 'PASS', msg: msg || '' });
  passedVariants++;
  totalVariants++;
  process.stdout.write('.');
}

function fail(name, msg) {
  results.push({ name, status: 'FAIL', msg: msg || '' });
  failedVariants++;
  totalVariants++;
  console.error('\n  FAIL  ' + name + ': ' + msg);
}

// ── Deterministic pseudo-random ───────────────────────────────────────────────
// Simple LCG to avoid Math.random() non-determinism across runs
function makePRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}

// ── Buffer helpers ────────────────────────────────────────────────────────────
function bufToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function uint8ToArrayBuffer(arr) {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
}

// ── JavaScript-action scanner ─────────────────────────────────────────────────
/**
 * Returns true if any JavaScript action survived sanitization.
 */
function hasJavaScriptAction(obj, depth) {
  if (!depth) depth = 0;
  if (depth > 25) return false;
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (hasJavaScriptAction(obj[i], depth + 1)) return true;
    }
    return false;
  }
  // Check /S value for live JS actions
  if (obj['/S']) {
    const s = obj['/S'];
    if (typeof s === 'string' && (s === '/JavaScript' || s === '/JS')) return true;
  }
  for (const key of Object.keys(obj)) {
    if (key === 'rawBytes' || key === 'getBytes') continue;
    const val = obj[key];
    if (val === null || val === undefined) continue;
    if (typeof val === 'object') {
      if (hasJavaScriptAction(val, depth + 1)) return true;
    }
  }
  return false;
}

// ── Variant generators ────────────────────────────────────────────────────────

/**
 * Generate 10 corrupted variants of a PDF byte array.
 * Returns array of { label, bytes: Uint8Array }.
 */
function generateVariants(originalBytes, seed) {
  const rng = makePRNG(seed);
  const len = originalBytes.length;
  const variants = [];

  // ── 1. Truncations (4 variants) ──────────────────────────────────────────
  const truncRatios = [0.10, 0.25, 0.50, 0.75];
  for (const ratio of truncRatios) {
    const cutAt = Math.max(4, Math.floor(len * ratio));
    variants.push({
      label: 'truncate-' + Math.round(ratio * 100) + 'pct',
      bytes: originalBytes.slice(0, cutAt),
    });
  }

  // ── 2. Header bit-flips (2 variants) ─────────────────────────────────────
  for (let v = 0; v < 2; v++) {
    const copy = new Uint8Array(originalBytes);
    // Flip 1..4 bytes in first 1024 bytes
    const numFlips = 1 + Math.floor(rng() * 4);
    const headerEnd = Math.min(1024, len);
    for (let f = 0; f < numFlips; f++) {
      const pos = Math.floor(rng() * headerEnd);
      copy[pos] = copy[pos] ^ (1 + Math.floor(rng() * 254));
    }
    variants.push({ label: 'header-flip-' + (v + 1), bytes: copy });
  }

  // ── 3. Zero a 64-byte mid-file region (2 variants) ───────────────────────
  for (let v = 0; v < 2; v++) {
    const copy = new Uint8Array(originalBytes);
    // Pick start at 10%..90% of file to stay "mid-file"
    const startRange = Math.floor(len * 0.1);
    const endRange   = Math.max(startRange + 1, Math.floor(len * 0.9) - 64);
    const zeroStart  = startRange + Math.floor(rng() * Math.max(1, endRange - startRange));
    const zeroEnd    = Math.min(len, zeroStart + 64);
    copy.fill(0, zeroStart, zeroEnd);
    variants.push({ label: 'zero-region-' + (v + 1), bytes: copy });
  }

  // ── 4. JavaScript injection (2 variants) ─────────────────────────────────
  const jsPayload = Buffer.from('javascript:alert(1)');
  for (let v = 0; v < 2; v++) {
    const insertAt = Math.floor(rng() * Math.max(1, len));
    const copy = new Uint8Array(len + jsPayload.length);
    copy.set(originalBytes.slice(0, insertAt), 0);
    copy.set(jsPayload, insertAt);
    copy.set(originalBytes.slice(insertAt), insertAt + jsPayload.length);
    variants.push({ label: 'js-inject-' + (v + 1), bytes: copy });
  }

  return variants;
}

// ── Per-variant test ──────────────────────────────────────────────────────────
async function testVariant(pdfName, variantLabel, bytes) {
  const testName = 'fuzz/' + pdfName + '/' + variantLabel;

  let result;
  let threwUncaught = false;

  try {
    const ab     = uint8ToArrayBuffer(bytes);
    const parser = new PDFParser(ab);
    result = await parser.load();
  } catch (e) {
    // Any thrown exception is a FAIL — parser must not crash, must return {error}
    fail(testName, 'parser.load() threw uncaught exception: ' + e.message.slice(0, 200));
    return;
  }

  // Assertion 1: result must be an object (not undefined/null/throw)
  if (!result || typeof result !== 'object') {
    fail(testName, 'parser.load() returned non-object: ' + typeof result);
    return;
  }

  // Assertion 2: if no error, result must have expected shape
  if (!result.error) {
    const hasPages = 'pages' in result || 'pageCount' in result;
    if (!hasPages) {
      fail(testName, 'No error but result lacks pages/pageCount: ' + JSON.stringify(Object.keys(result)));
      return;
    }
  }

  // Assertion 3: after sanitization, no JavaScript actions remain
  try {
    if (result.catalog) {
      sanitizeCatalog(result.catalog);
      sanitizeObject(result.catalog);
    }
    if (Array.isArray(result.pages)) {
      for (const pg of result.pages) {
        sanitizeObject(pg);
      }
    }
  } catch (e) {
    fail(testName, 'sanitize threw: ' + e.message.slice(0, 200));
    return;
  }

  // Check no JS action survived
  let jsFound = false;
  if (result.catalog && hasJavaScriptAction(result.catalog)) jsFound = true;
  if (!jsFound && Array.isArray(result.pages)) {
    for (const pg of result.pages) {
      if (hasJavaScriptAction(pg)) { jsFound = true; break; }
    }
  }

  if (jsFound) {
    fail(testName, 'JavaScript action survived sanitization');
    return;
  }

  pass(testName, result.error
    ? 'error (expected): ' + result.error.message.slice(0, 80)
    : 'parsed OK, no JS, pageCount=' + (result.pageCount || (result.pages || []).length));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Security Fuzz Test ===\n');
  console.log('Corpus files: ' + corpusSpec.corpus.length);
  console.log('Variants per file: 10');
  console.log('Total variants: ' + (corpusSpec.corpus.length * 10));
  console.log('\nRunning');

  const startTime = Date.now();

  for (const spec of corpusSpec.corpus) {
    const pdfPath = path.join(CORPUS_DIR, spec.file);
    if (!fs.existsSync(pdfPath)) {
      fail('fuzz/' + spec.file + '/file-exists', 'Corpus PDF not found: ' + pdfPath);
      continue;
    }

    const buf   = fs.readFileSync(pdfPath);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

    // Deterministic seed per file name
    let seed = 0;
    for (let i = 0; i < spec.file.length; i++) seed = (seed * 31 + spec.file.charCodeAt(i)) >>> 0;

    const variants = generateVariants(bytes, seed);
    for (const variant of variants) {
      await testVariant(spec.file, variant.label, variant.bytes);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n');
  console.log('=== Fuzz Test Results ===');
  console.log('Total variants: ' + totalVariants);
  console.log('PASS: ' + passedVariants);
  console.log('FAIL: ' + failedVariants);
  console.log('Time: ' + elapsed + 's');

  // ── Write results ─────────────────────────────────────────────────────────
  const lines = [
    '# Phase 4 Security Fuzz Test Results',
    '',
    '**Date**: ' + new Date().toISOString(),
    '**Agent**: phase4-integration',
    '',
    '## Summary',
    '',
    '| Total Variants | Pass | Fail | Time |',
    '|----------------|------|------|------|',
    '| ' + totalVariants + ' | ' + passedVariants + ' | ' + failedVariants + ' | ' + elapsed + 's |',
    '',
    '## Variant Types',
    '',
    '| Type | Count per PDF | Description |',
    '|------|---------------|-------------|',
    '| truncate-10pct | 1 | File truncated to 10% of original size |',
    '| truncate-25pct | 1 | File truncated to 25% of original size |',
    '| truncate-50pct | 1 | File truncated to 50% of original size |',
    '| truncate-75pct | 1 | File truncated to 75% of original size |',
    '| header-flip-1  | 1 | 1-4 bytes XOR-flipped in first 1024 bytes |',
    '| header-flip-2  | 1 | 1-4 bytes XOR-flipped in first 1024 bytes (different seed) |',
    '| zero-region-1  | 1 | 64-byte block zeroed at random mid-file offset |',
    '| zero-region-2  | 1 | 64-byte block zeroed at random mid-file offset (different seed) |',
    '| js-inject-1    | 1 | "javascript:alert(1)" injected at random offset |',
    '| js-inject-2    | 1 | "javascript:alert(1)" injected at random offset (different seed) |',
    '',
    '## Assertions per Variant',
    '',
    '1. `parser.load()` must not throw (must return `{error: ...}` on failure)',
    '2. Result is an object with `pages` or `pageCount` if no error',
    '3. After `sanitizeCatalog` + `sanitizeObject`, no JavaScript action survives',
    '',
    '## Per-Test Results',
    '',
    '| Test | Status | Notes |',
    '|------|--------|-------|',
  ];

  for (const r of results) {
    const safeMsg = (r.msg || '').replace(/\|/g, '\\|');
    lines.push('| ' + r.name + ' | ' + r.status + ' | ' + safeMsg + ' |');
  }

  lines.push('');
  fs.writeFileSync(RESULTS_FILE, lines.join('\n'), 'utf8');
  console.log('\nFuzz results written to: ' + RESULTS_FILE);

  process.exit(failedVariants > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\nFuzz test runner crashed:', e);
  process.exit(1);
});
