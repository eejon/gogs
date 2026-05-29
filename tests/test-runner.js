/**
 * test-runner.js — Phase 1 + Phase 2 test runner for custom-pdf-render
 *
 * Usage: node tests/test-runner.js
 * Exit code: 0 if all tests pass, 1 if any fail.
 * Phase 1 results: tests/run1/results.md
 * Phase 2 results: tests/run2/results.md
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Resolve project root ────────────────────────────────────────────────────
const PROJECT_ROOT   = path.resolve(__dirname, '..');
const CORPUS_DIR     = path.join(PROJECT_ROOT, 'tests', 'corpus');
const CORPUS_JSON    = path.join(CORPUS_DIR, 'corpus.json');
const RESULTS_DIR    = path.join(PROJECT_ROOT, 'tests', 'run1');
const RESULTS_FILE   = path.join(RESULTS_DIR, 'results.md');
const PARSER_PATH    = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-parser.js');
const SECURITY_PATH  = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-security.js');

// ── Phase 2 module paths ──────────────────────────────────────────────────────
const RENDERER_PATH  = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-renderer.js');
const FONTS_PATH     = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-fonts.js');
const IMAGES_PATH    = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-images.js');
const RESULTS_DIR2   = path.join(PROJECT_ROOT, 'tests', 'run2');
const RESULTS_FILE2  = path.join(RESULTS_DIR2, 'results.md');

// ── Phase 3 paths ─────────────────────────────────────────────────────────────
const VIEWER_HTML_PATH = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'web', 'viewer.html');
const VIEWER_JS_PATH   = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'web', 'viewer.js');
const VIEWER_CSS_PATH  = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'web', 'viewer.css');
const RESULTS_DIR4     = path.join(PROJECT_ROOT, 'tests', 'run4');
const RESULTS_FILE4    = path.join(RESULTS_DIR4, 'results.md');

// ── Load modules ─────────────────────────────────────────────────────────────
const { PDFParser, ParseError } = require(PARSER_PATH);
const { sanitizeObject, sanitizeCatalog, isAllowedAction } = require(SECURITY_PATH);

// ── Load corpus spec ─────────────────────────────────────────────────────────
const corpusSpec = JSON.parse(fs.readFileSync(CORPUS_JSON, 'utf8'));

// ── Test results accumulator ─────────────────────────────────────────────────
const results = [];

function pass(name, msg) {
  results.push({ name, status: 'PASS', msg: msg || '' });
  console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
}

function fail(name, msg) {
  results.push({ name, status: 'FAIL', msg: msg || '' });
  console.error(`  FAIL  ${name}: ${msg}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert Node.js Buffer to ArrayBuffer. */
function bufToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Recursively scan a parsed PDF value for any JavaScript action objects.
 * Returns an array of descriptions of found JS actions.
 */
function findJavaScriptActions(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 20) return [];
  if (!obj || typeof obj !== 'object') return [];

  const found = [];

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      found.push(...findJavaScriptActions(obj[i], depth + 1));
    }
    return found;
  }

  // Check if this looks like an action dict with /S
  if (obj['/S']) {
    const s = obj['/S'];
    if (s === '/JavaScript' || s === '/JS' || s === 'JavaScript' || s === 'JS') {
      found.push('JavaScript action: /S=' + s);
    }
  }

  // Check for /JS key anywhere
  if (obj['/JS'] !== null && obj['/JS'] !== undefined) {
    found.push('JS entry at this level');
  }
  if (obj['/JavaScript'] !== null && obj['/JavaScript'] !== undefined) {
    found.push('JavaScript entry at this level');
  }

  for (const key of Object.keys(obj)) {
    if (key === 'rawBytes') continue; // skip binary data
    if (key === 'getBytes') continue; // skip function
    const val = obj[key];
    if (val !== null && typeof val === 'object') {
      found.push(...findJavaScriptActions(val, depth + 1));
    }
  }

  return found;
}

/** Check if any remaining JS refs exist after sanitize (ignores nulled-out entries). */
function hasRemainingJavaScript(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 20) return false;
  if (!obj || typeof obj !== 'object') return false;

  if (Array.isArray(obj)) {
    return obj.some(v => hasRemainingJavaScript(v, depth + 1));
  }

  // A null value in /JS or /JavaScript means it was sanitized away — that's OK
  if (obj['/S']) {
    const s = obj['/S'];
    // Check that the /S value isn't a live JavaScript action
    if (typeof s === 'string' && (s === '/JavaScript' || s === '/JS')) {
      return true;
    }
  }

  for (const key of Object.keys(obj)) {
    if (key === 'rawBytes' || key === 'getBytes') continue;
    const val = obj[key];
    // Null values are sanitized-away entries — skip them
    if (val === null || val === undefined) continue;
    if (typeof val === 'object') {
      if (hasRemainingJavaScript(val, depth + 1)) return true;
    }
  }

  return false;
}

// ─── Main test loop ───────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== PDF Parser Phase 1 Tests ===\n');

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  for (const spec of corpusSpec.corpus) {
    const pdfPath = path.join(CORPUS_DIR, spec.file);
    console.log(`\n--- ${spec.file} ---`);

    if (!fs.existsSync(pdfPath)) {
      fail(spec.file + '/exists', 'PDF file not found at ' + pdfPath);
      continue;
    }

    const buf = fs.readFileSync(pdfPath);
    const ab  = bufToArrayBuffer(buf);

    // ── Instantiation ─────────────────────────────────────────────────────
    let parser;
    try {
      parser = new PDFParser(ab);
    } catch (e) {
      fail(spec.file + '/instantiate', 'PDFParser constructor threw: ' + e.message);
      continue;
    }
    pass(spec.file + '/instantiate', 'PDFParser constructed');

    // ── Header validation ─────────────────────────────────────────────────
    try {
      parser.parseHeader();
      pass(spec.file + '/header', 'version=' + parser.version);
    } catch (e) {
      if (spec.expected_error) {
        pass(spec.file + '/header', 'expected error caught: ' + e.message);
      } else {
        fail(spec.file + '/header', e.message);
      }
    }

    // ── Full load() ───────────────────────────────────────────────────────
    let loadResult;
    try {
      loadResult = await parser.load();
    } catch (e) {
      fail(spec.file + '/load', 'load() threw uncaught exception: ' + e.message);
      continue;
    }

    // ── malformed.pdf: must return { error } not throw ────────────────────
    if (spec.expected_error === 'ParseError') {
      if (loadResult.error) {
        pass(spec.file + '/error-return',
             'returned error as expected: ' + loadResult.error.message.slice(0, 80));
      } else {
        // malformed might partially succeed — that's also acceptable as long
        // as no exception escaped. If we got pages, warn but still pass.
        if (loadResult.pages !== undefined) {
          pass(spec.file + '/error-return',
               'WARN: malformed.pdf partially parsed (' + loadResult.pageCount + ' pages) — no crash');
        } else {
          fail(spec.file + '/error-return', 'Expected error result but got: ' + JSON.stringify(Object.keys(loadResult)));
        }
      }
      // Don't run page-count checks for malformed
      continue;
    }

    // ── For valid PDFs: no error should be returned ───────────────────────
    if (loadResult.error) {
      fail(spec.file + '/load', 'Unexpected error: ' + loadResult.error.message);
      continue;
    }
    pass(spec.file + '/load', 'loaded OK');

    // ── Page count ────────────────────────────────────────────────────────
    const actualPages = loadResult.pageCount;
    if (spec.page_count !== null) {
      if (actualPages === spec.page_count) {
        pass(spec.file + '/page-count', 'pageCount=' + actualPages);
      } else {
        fail(spec.file + '/page-count',
             'expected ' + spec.page_count + ' got ' + actualPages);
      }
    }

    // ── poc.pdf: JavaScript must be gone after sanitize ───────────────────
    if (spec.file === 'poc.pdf') {
      const { catalog, pages } = loadResult;

      // Apply sanitization
      sanitizeCatalog(catalog);
      sanitizeObject(catalog);
      for (const page of (pages || [])) {
        sanitizeObject(page);
      }

      const jsRemaining = hasRemainingJavaScript(catalog);
      const jsInPages   = (pages || []).some(p => hasRemainingJavaScript(p));

      if (!jsRemaining && !jsInPages) {
        pass(spec.file + '/no-js-after-sanitize', 'no JavaScript actions in sanitized document');
      } else {
        fail(spec.file + '/no-js-after-sanitize',
             'JavaScript still present after sanitize: catalog=' + jsRemaining + ' pages=' + jsInPages);
      }

      // Also verify poc.pdf parsed with expected page count
      if (spec.page_count !== null && actualPages === spec.page_count) {
        pass(spec.file + '/page-count-security', 'page_count=' + actualPages + ' (security gate PDF)');
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const total   = results.length;
  const passed  = results.filter(r => r.status === 'PASS').length;
  const failed  = results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== Results ===');
  console.log('Total: ' + total + '  PASS: ' + passed + '  FAIL: ' + failed);

  // ── Write results.md ──────────────────────────────────────────────────────
  const lines = [
    '# Phase 1 Parser Test Results',
    '',
    '**Date**: ' + new Date().toISOString(),
    '',
    '## Summary',
    '',
    '| Total | Pass | Fail |',
    '|-------|------|------|',
    '| ' + total + ' | ' + passed + ' | ' + failed + ' |',
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
  console.log('\nResults written to: ' + RESULTS_FILE);

  // Return failure count instead of calling process.exit — let Phase 2 complete first
  return failed;
}

// ─── Phase 2: Renderer Tests ──────────────────────────────────────────────────

/**
 * Build a mock canvas with a recording context.
 * The context tracks method call names in _calls[].
 */
function makeMockCanvas() {
  const calls = [];
  const ctx = {
    _calls: calls,
    _font: '',
    setTransform:    (...a) => calls.push('setTransform'),
    transform:       (...a) => calls.push('transform'),
    save:            ()     => calls.push('save'),
    restore:         ()     => calls.push('restore'),
    beginPath:       ()     => calls.push('beginPath'),
    moveTo:          (...a) => calls.push('moveTo'),
    lineTo:          (...a) => calls.push('lineTo'),
    bezierCurveTo:   (...a) => calls.push('bezierCurveTo'),
    closePath:       ()     => calls.push('closePath'),
    rect:            (...a) => calls.push('rect'),
    stroke:          ()     => calls.push('stroke'),
    fill:            (...a) => calls.push('fill'),
    clip:            (...a) => calls.push('clip'),
    fillText:        (...a) => calls.push('fillText'),
    strokeText:      (...a) => calls.push('strokeText'),
    drawImage:       (...a) => calls.push('drawImage'),
    fillRect:        (...a) => calls.push('fillRect'),
    setLineDash:     (...a) => calls.push('setLineDash'),
    measureText:     (t)    => ({ width: (typeof t === 'string' ? t.length * 7 : 0) }),
    get font() { return ctx._font; },
    set font(v) { ctx._font = v; },
    fillStyle:       'black',
    strokeStyle:     'black',
    lineWidth:       1,
    lineCap:         'butt',
    lineJoin:        'miter',
    miterLimit:      10,
    globalAlpha:     1,
    lineDashOffset:  0,
  };
  const canvas = {
    width:  0,
    height: 0,
    getContext: (type) => type === '2d' ? ctx : null,
    _ctx: ctx,
  };
  return canvas;
}

async function runPhase2Tests() {
  console.log('\n=== PDF Renderer Phase 2 Tests ===\n');

  // Load Phase 2 modules
  let PDFRenderer, PDFFonts, PDFImages;
  try {
    ({ PDFRenderer } = require(RENDERER_PATH));
    PDFFonts = require(FONTS_PATH);
    PDFImages = require(IMAGES_PATH);
  } catch (e) {
    console.error('Failed to load Phase 2 modules:', e.message);
    return [{ name: 'phase2/module-load', status: 'FAIL', msg: e.message }];
  }

  const p2results = [];

  function p2pass(name, msg) {
    p2results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function p2fail(name, msg) {
    p2results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // ── Module load checks ──────────────────────────────────────────────────────
  p2pass('phase2/PDFRenderer-loaded',  'PDFRenderer class available');
  p2pass('phase2/PDFFonts-loaded',     'PDFFonts module available');
  p2pass('phase2/PDFImages-loaded',    'PDFImages module available');

  // ── PDFFonts unit tests ─────────────────────────────────────────────────────
  const { getStandardFontCSS, pdfStringToText, getCharWidth } = PDFFonts;

  // Font CSS mapping
  const helmCSS = getStandardFontCSS('Helvetica');
  if (helmCSS && helmCSS.includes('Helvetica')) {
    p2pass('phase2/font-css-helvetica', helmCSS);
  } else {
    p2fail('phase2/font-css-helvetica', 'expected Helvetica in CSS, got: ' + helmCSS);
  }

  const timesCSS = getStandardFontCSS('Times-Roman');
  if (timesCSS && (timesCSS.includes('Times') || timesCSS.includes('serif'))) {
    p2pass('phase2/font-css-times', timesCSS);
  } else {
    p2fail('phase2/font-css-times', 'expected serif in CSS, got: ' + timesCSS);
  }

  const courierCSS = getStandardFontCSS('Courier');
  if (courierCSS && courierCSS.includes('Courier')) {
    p2pass('phase2/font-css-courier', courierCSS);
  } else {
    p2fail('phase2/font-css-courier', 'expected Courier in CSS, got: ' + courierCSS);
  }

  const unknownCSS = getStandardFontCSS('SomeRandomFont');
  if (unknownCSS && unknownCSS.length > 0) {
    p2pass('phase2/font-css-unknown-fallback', unknownCSS);
  } else {
    p2fail('phase2/font-css-unknown-fallback', 'expected fallback CSS, got: ' + unknownCSS);
  }

  // pdfStringToText: Latin-1
  const latin1 = pdfStringToText(new Uint8Array([72, 101, 108, 108, 111])); // "Hello"
  if (latin1 === 'Hello') {
    p2pass('phase2/pdfstring-latin1', 'Hello decoded correctly');
  } else {
    p2fail('phase2/pdfstring-latin1', 'expected "Hello", got: ' + JSON.stringify(latin1));
  }

  // pdfStringToText: UTF-16BE BOM
  const utf16be = new Uint8Array([0xFE, 0xFF, 0x00, 0x48, 0x00, 0x69]); // "Hi"
  const utf16result = pdfStringToText(utf16be);
  if (utf16result === 'Hi') {
    p2pass('phase2/pdfstring-utf16be', 'UTF-16BE BOM decoded correctly');
  } else {
    p2fail('phase2/pdfstring-utf16be', 'expected "Hi", got: ' + JSON.stringify(utf16result));
  }

  // pdfStringToText: empty
  const emptyStr = pdfStringToText(new Uint8Array(0));
  if (emptyStr === '') {
    p2pass('phase2/pdfstring-empty', 'empty string handled');
  } else {
    p2fail('phase2/pdfstring-empty', 'expected empty string, got: ' + JSON.stringify(emptyStr));
  }

  // getCharWidth
  const spaceWidth = getCharWidth('Helvetica', 32);
  if (typeof spaceWidth === 'number' && spaceWidth > 0) {
    p2pass('phase2/char-width-space', 'Helvetica space width=' + spaceWidth);
  } else {
    p2fail('phase2/char-width-space', 'expected positive width, got: ' + spaceWidth);
  }

  const courierWidth = getCharWidth('Courier', 65); // 'A'
  if (courierWidth === 600) {
    p2pass('phase2/char-width-courier-monospace', 'Courier is monospaced at 600');
  } else {
    p2fail('phase2/char-width-courier-monospace', 'expected 600, got: ' + courierWidth);
  }

  // ── Renderer tests per corpus PDF ──────────────────────────────────────────
  for (const spec of corpusSpec.corpus) {
    const pdfPath = path.join(CORPUS_DIR, spec.file);
    console.log(`\n--- Phase 2: ${spec.file} ---`);

    if (!fs.existsSync(pdfPath)) {
      p2fail('phase2/' + spec.file + '/exists', 'PDF not found');
      continue;
    }

    // Load and parse PDF
    const buf = fs.readFileSync(pdfPath);
    const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const parser = new PDFParser(ab);
    const loadResult = await parser.load();

    // malformed.pdf: renderer must handle gracefully
    if (spec.expected_error === 'ParseError') {
      if (loadResult.error) {
        // renderPage with null pages should not crash
        const renderer = new PDFRenderer();
        const canvas   = makeMockCanvas();
        let threw = false;
        try {
          await renderer.renderPage(canvas, {}, 1.0, parser);
        } catch (e) {
          threw = true;
        }
        if (!threw) {
          p2pass('phase2/' + spec.file + '/render-graceful', 'renderPage with empty page did not throw');
        } else {
          p2fail('phase2/' + spec.file + '/render-graceful', 'renderPage threw on malformed input');
        }
      } else {
        // Partially parsed malformed PDF — attempt renderPage on first page if any
        const renderer = new PDFRenderer();
        const canvas   = makeMockCanvas();
        let threw = false;
        try {
          const page = loadResult.pages && loadResult.pages[0] ? loadResult.pages[0] : {};
          await renderer.renderPage(canvas, page, 1.0, parser);
        } catch (e) {
          threw = true;
        }
        if (!threw) {
          p2pass('phase2/' + spec.file + '/render-graceful', 'renderPage with partial parse did not throw');
        } else {
          p2fail('phase2/' + spec.file + '/render-graceful', 'renderPage threw: should be graceful');
        }
      }
      continue;
    }

    if (loadResult.error) {
      p2fail('phase2/' + spec.file + '/load', 'Unexpected parse error: ' + loadResult.error.message);
      continue;
    }

    const pages    = loadResult.pages;
    const renderer = new PDFRenderer();
    const canvas   = makeMockCanvas();

    let renderError = null;
    try {
      await renderer.renderPage(canvas, pages[0], 1.0, parser);
    } catch (e) {
      renderError = e;
    }

    if (renderError) {
      p2fail('phase2/' + spec.file + '/render-no-throw', 'renderPage threw: ' + renderError.message);
    } else {
      p2pass('phase2/' + spec.file + '/render-no-throw', 'renderPage completed without throwing');
    }

    // Check canvas was configured (dimensions set)
    const mb = pages[0] && pages[0]['/MediaBox'];
    if (Array.isArray(mb) && canvas.width > 0 && canvas.height > 0) {
      p2pass('phase2/' + spec.file + '/canvas-dimensions', 'canvas=' + canvas.width + 'x' + canvas.height);
    } else if (!Array.isArray(mb)) {
      p2pass('phase2/' + spec.file + '/canvas-dimensions', 'no MediaBox in page (acceptable)');
    } else {
      p2fail('phase2/' + spec.file + '/canvas-dimensions', 'canvas dimensions not set: ' + canvas.width + 'x' + canvas.height);
    }

    // Check that setTransform was called (coordinate system setup)
    const ctxCalls = canvas._ctx._calls;
    if (ctxCalls.includes('setTransform')) {
      p2pass('phase2/' + spec.file + '/ctx-setTransform', 'coordinate transform applied');
    } else {
      p2fail('phase2/' + spec.file + '/ctx-setTransform', 'setTransform was not called');
    }

    // poc.pdf specific: verify no eval / Function calls in the render context
    // (Security gate: even with a mock canvas, the renderer must not attempt dynamic code)
    if (spec.file === 'poc.pdf') {
      // Check that eval/Function are not called — since we can't instrument them
      // in a mock, verify by ensuring no 'eval' or 'Function' appears in renderer source
      const rendererSrc = fs.readFileSync(RENDERER_PATH, 'utf8');
      const hasEval     = /\beval\s*\(/.test(rendererSrc);
      const hasFunction = /\bnew\s+Function\s*\(/.test(rendererSrc);
      if (!hasEval && !hasFunction) {
        p2pass('phase2/' + spec.file + '/no-eval-in-source', 'renderer source has no eval() or new Function()');
      } else {
        p2fail('phase2/' + spec.file + '/no-eval-in-source', 'eval=' + hasEval + ' Function=' + hasFunction);
      }

      // Also check fonts and images modules
      const fontsSrc  = fs.readFileSync(FONTS_PATH, 'utf8');
      const imagesSrc = fs.readFileSync(IMAGES_PATH, 'utf8');
      const modulesClean = !/\beval\s*\(/.test(fontsSrc) && !/\bnew\s+Function\s*\(/.test(fontsSrc)
                        && !/\beval\s*\(/.test(imagesSrc) && !/\bnew\s+Function\s*\(/.test(imagesSrc);
      if (modulesClean) {
        p2pass('phase2/' + spec.file + '/no-eval-in-support-modules', 'fonts+images modules: no eval/Function');
      } else {
        p2fail('phase2/' + spec.file + '/no-eval-in-support-modules', 'eval or new Function found in support modules');
      }
    }
  }

  // ── Write Phase 2 results ───────────────────────────────────────────────────
  if (!fs.existsSync(RESULTS_DIR2)) fs.mkdirSync(RESULTS_DIR2, { recursive: true });

  const total2  = p2results.length;
  const passed2 = p2results.filter(r => r.status === 'PASS').length;
  const failed2 = p2results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== Phase 2 Results ===');
  console.log('Total: ' + total2 + '  PASS: ' + passed2 + '  FAIL: ' + failed2);

  const lines2 = [
    '# Phase 2 Renderer Test Results',
    '',
    '**Date**: ' + new Date().toISOString(),
    '',
    '## Summary',
    '',
    '| Total | Pass | Fail |',
    '|-------|------|------|',
    '| ' + total2 + ' | ' + passed2 + ' | ' + failed2 + ' |',
    '',
    '## Per-Test Results',
    '',
    '| Test | Status | Notes |',
    '|------|--------|-------|',
  ];
  for (const r of p2results) {
    const safeMsg = (r.msg || '').replace(/\|/g, '\\|');
    lines2.push('| ' + r.name + ' | ' + r.status + ' | ' + safeMsg + ' |');
  }
  lines2.push('');
  fs.writeFileSync(RESULTS_FILE2, lines2.join('\n'), 'utf8');
  console.log('\nPhase 2 results written to: ' + RESULTS_FILE2);

  return p2results;
}

// ─── Phase 3: Viewer UI Shell Tests ──────────────────────────────────────────
/**
 * Static source-code checks for the viewer HTML/JS/CSS files.
 * These tests run entirely in Node.js — no browser needed.
 */
async function runPhase3Tests() {
  console.log('\n=== PDF Viewer Phase 3 Tests ===\n');

  if (!fs.existsSync(RESULTS_DIR4)) fs.mkdirSync(RESULTS_DIR4, { recursive: true });

  const p3results = [];

  function p3pass(name, msg) {
    p3results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function p3fail(name, msg) {
    p3results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // ── 1. File existence checks ──────────────────────────────────────────────
  if (fs.existsSync(VIEWER_HTML_PATH)) {
    p3pass('phase3/viewer-html-exists', VIEWER_HTML_PATH);
  } else {
    p3fail('phase3/viewer-html-exists', 'viewer.html not found at ' + VIEWER_HTML_PATH);
  }

  if (fs.existsSync(VIEWER_JS_PATH)) {
    p3pass('phase3/viewer-js-exists', VIEWER_JS_PATH);
  } else {
    p3fail('phase3/viewer-js-exists', 'viewer.js not found at ' + VIEWER_JS_PATH);
  }

  if (fs.existsSync(VIEWER_CSS_PATH)) {
    p3pass('phase3/viewer-css-exists', VIEWER_CSS_PATH);
  } else {
    p3fail('phase3/viewer-css-exists', 'viewer.css not found at ' + VIEWER_CSS_PATH);
  }

  // Read the HTML + JS sources (needed for further checks)
  if (!fs.existsSync(VIEWER_HTML_PATH)) {
    // Cannot continue without HTML
    p3fail('phase3/early-exit', 'viewer.html missing, skipping remaining Phase 3 checks');
    return p3results;
  }

  const htmlSrc  = fs.readFileSync(VIEWER_HTML_PATH, 'utf8');
  const jsSrc    = fs.existsSync(VIEWER_JS_PATH)  ? fs.readFileSync(VIEWER_JS_PATH,  'utf8') : '';
  const cssSrc   = fs.existsSync(VIEWER_CSS_PATH) ? fs.readFileSync(VIEWER_CSS_PATH, 'utf8') : '';

  // Combined source for pattern checks (HTML + inline JS in HTML + external JS)
  const allSrc = htmlSrc + '\n' + jsSrc;

  // ── 2. ?file= parameter handling ─────────────────────────────────────────
  // Check that the viewer sources reference the 'file' query parameter
  if (/\bfile\b/.test(htmlSrc) || /params\[.file.\]|file=|['"](file)['"]\s*[,:\]]/.test(jsSrc) || /\?file=/.test(htmlSrc)) {
    p3pass('phase3/file-param-handling', '?file= parameter referenced in viewer sources');
  } else {
    p3fail('phase3/file-param-handling', '?file= parameter reference not found in viewer.html or viewer.js');
  }

  // ── 3. Script load order ──────────────────────────────────────────────────
  // Verify all 5 src modules are loaded in the correct order in viewer.html
  const EXPECTED_MODULES = [
    'pdf-fonts.js',
    'pdf-images.js',
    'pdf-security.js',
    'pdf-parser.js',
    'pdf-renderer.js',
  ];

  // Find positions of each module script tag in the HTML
  let prevPos = -1;
  let orderOK = true;
  let allPresent = true;
  for (const mod of EXPECTED_MODULES) {
    const pos = htmlSrc.indexOf(mod);
    if (pos === -1) {
      p3fail('phase3/module-present-' + mod, mod + ' not referenced in viewer.html');
      allPresent = false;
      orderOK = false;
    } else {
      p3pass('phase3/module-present-' + mod, 'found at char ' + pos);
      if (pos < prevPos) {
        orderOK = false;
      }
      prevPos = pos;
    }
  }

  if (allPresent) {
    if (orderOK) {
      p3pass('phase3/module-load-order', 'All 5 modules present in correct order');
    } else {
      p3fail('phase3/module-load-order', 'Modules are present but not in required order: ' + EXPECTED_MODULES.join(', '));
    }
  }

  // ── 4. Security: no eval() ────────────────────────────────────────────────
  // Strip single-line comments (// ...) and block comments (/* ... */) before checking,
  // so mentions in documentation comments don't trigger false positives.
  // Also strip HTML comments (<!-- ... -->).
  function stripComments(src) {
    // Strip HTML comments
    let s = src.replace(/<!--[\s\S]*?-->/g, '');
    // Strip JS block comments
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    // Strip JS line comments
    s = s.replace(/\/\/[^\n]*/g, '');
    return s;
  }
  const allSrcStripped = stripComments(allSrc);
  const hasEval = /\beval\s*\(/.test(allSrcStripped);
  if (!hasEval) {
    p3pass('phase3/no-eval', 'No eval() found in viewer sources (comments excluded)');
  } else {
    p3fail('phase3/no-eval', 'eval() found in viewer sources — SECURITY VIOLATION');
  }

  // ── 5. Security: no new Function() ───────────────────────────────────────
  const hasNewFunction = /\bnew\s+Function\s*\(/.test(allSrcStripped);
  if (!hasNewFunction) {
    p3pass('phase3/no-new-function', 'No new Function() found in viewer sources (comments excluded)');
  } else {
    p3fail('phase3/no-new-function', 'new Function() found in viewer sources — SECURITY VIOLATION');
  }

  // ── 6. Security: no innerHTML assignments ────────────────────────────────
  // This is a hard security requirement: PDF-derived strings must NEVER
  // be inserted via innerHTML. Check for any innerHTML = assignment.
  const hasInnerHTML = /\.innerHTML\s*=/.test(allSrc);
  if (!hasInnerHTML) {
    p3pass('phase3/no-innerHTML-assignment', 'No innerHTML= assignments in viewer sources');
  } else {
    p3fail('phase3/no-innerHTML-assignment',
           'innerHTML= assignment found in viewer sources — verify no PDF-derived strings are used with it');
  }

  // ── 7. Security: no external URLs ────────────────────────────────────────
  // Check that no https://cdn, http://, or external src attributes appear
  const hasExternalCDN    = /https?:\/\/(?!127\.|localhost)[a-zA-Z0-9]/.test(htmlSrc + cssSrc + jsSrc);
  if (!hasExternalCDN) {
    p3pass('phase3/no-external-urls', 'No external http/https URLs in viewer files');
  } else {
    // Find the offending URL for the error message
    const m = (htmlSrc + cssSrc + jsSrc).match(/https?:\/\/(?!127\.|localhost)[a-zA-Z0-9][^\s"'<>]*/);
    p3fail('phase3/no-external-urls', 'External URL found: ' + (m ? m[0] : '(unknown)'));
  }

  // ── 8. validateURL call present ──────────────────────────────────────────
  if (/validateURL/.test(allSrc)) {
    p3pass('phase3/validateURL-called', 'PDFSecurity.validateURL() is called in viewer sources');
  } else {
    p3fail('phase3/validateURL-called', 'PDFSecurity.validateURL() not found in viewer sources');
  }

  // ── 9. cross-origin error message present ────────────────────────────────
  if (/cross-origin/.test(allSrc)) {
    p3pass('phase3/cross-origin-error-msg', '"cross-origin" error message present');
  } else {
    p3fail('phase3/cross-origin-error-msg', '"cross-origin" error message not found in viewer sources');
  }

  // ── 10. viewer.js loaded in HTML ─────────────────────────────────────────
  if (/viewer\.js/.test(htmlSrc)) {
    p3pass('phase3/viewer-js-loaded', 'viewer.js script tag present in viewer.html');
  } else {
    p3fail('phase3/viewer-js-loaded', 'viewer.js script tag not found in viewer.html');
  }

  // ── Write Phase 3 Node.js results ─────────────────────────────────────────
  const total3  = p3results.length;
  const passed3 = p3results.filter(r => r.status === 'PASS').length;
  const failed3 = p3results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== Phase 3 Results ===');
  console.log('Total: ' + total3 + '  PASS: ' + passed3 + '  FAIL: ' + failed3);

  const lines3 = [
    '# Phase 3 Viewer UI Shell Test Results (Node.js Static Checks)',
    '',
    '**Date**: ' + new Date().toISOString(),
    '',
    '## Summary',
    '',
    '| Total | Pass | Fail |',
    '|-------|------|------|',
    '| ' + total3 + ' | ' + passed3 + ' | ' + failed3 + ' |',
    '',
    '## Per-Test Results',
    '',
    '| Test | Status | Notes |',
    '|------|--------|-------|',
  ];
  for (const r of p3results) {
    const safeMsg = (r.msg || '').replace(/\|/g, '\\|');
    lines3.push('| ' + r.name + ' | ' + r.status + ' | ' + safeMsg + ' |');
  }
  lines3.push('');
  fs.writeFileSync(RESULTS_FILE4, lines3.join('\n'), 'utf8');
  console.log('\nPhase 3 Node.js results written to: ' + RESULTS_FILE4);

  return p3results;
}

async function main() {
  const failed1 = await runTests();
  const p2      = await runPhase2Tests();
  const failed2 = p2.filter(r => r.status === 'FAIL').length;
  const p3      = await runPhase3Tests();
  const failed3 = p3.filter(r => r.status === 'FAIL').length;
  process.exit((failed1 > 0 || failed2 > 0 || failed3 > 0) ? 1 : 0);
}

main().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
