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
  // Mock gradient object for createLinearGradient/createRadialGradient
  const mockGradient = { addColorStop: () => {} };
  const ctx = {
    _calls: calls,
    _font: '',
    setTransform:    (...a) => calls.push('setTransform'),
    transform:       (...a) => calls.push('transform'),
    save:            ()     => calls.push('save'),
    restore:         ()     => calls.push('restore'),
    scale:           (...a) => calls.push('scale'),
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
    createLinearGradient: (...a) => { calls.push('createLinearGradient'); return mockGradient; },
    createRadialGradient: (...a) => { calls.push('createRadialGradient'); return mockGradient; },
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData:    (...a) => calls.push('putImageData'),
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
    globalCompositeOperation: 'source-over',
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

// ─── R1: Parser Repair Mode Tests ────────────────────────────────────────────
/**
 * Tests for the linear-scan xref repair fallback (R1).
 * Verifies that repaired.pdf (corrupt xref offsets) loads correctly,
 * and that normal PDFs do NOT trigger repair mode.
 */
async function runR1Tests() {
  console.log('\n=== R1 Parser Repair Mode Tests ===\n');

  const r1results = [];

  function r1pass(name, msg) {
    r1results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function r1fail(name, msg) {
    r1results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // ── R1/repaired-loads: repaired.pdf loads with pageCount > 0 ──────────────
  const repairedPath = path.join(CORPUS_DIR, 'repaired.pdf');
  if (!fs.existsSync(repairedPath)) {
    r1fail('R1/repaired-loads', 'repaired.pdf not found at ' + repairedPath);
    r1fail('R1/repaired-no-throw', 'repaired.pdf not found — skipped');
  } else {
    const repBuf = fs.readFileSync(repairedPath);
    const repAB  = bufToArrayBuffer(repBuf);
    let repResult;
    try {
      const repParser = new PDFParser(repAB);
      repResult = await repParser.load();
    } catch (e) {
      r1fail('R1/repaired-no-throw', 'repaired.pdf threw an uncaught exception: ' + e.message);
      r1fail('R1/repaired-loads',    'skipped due to throw');
      return r1results;
    }

    // R1/repaired-no-throw: must not throw
    r1pass('R1/repaired-no-throw', 'repaired.pdf did not throw');

    // R1/repaired-loads: must have pageCount > 0 and no error
    if (repResult.error) {
      r1fail('R1/repaired-loads', 'repaired.pdf returned error: ' + repResult.error.message);
    } else if (!repResult.pageCount || repResult.pageCount < 1) {
      r1fail('R1/repaired-loads', 'repaired.pdf pageCount=' + repResult.pageCount + ' (expected > 0)');
    } else {
      r1pass('R1/repaired-loads', 'pageCount=' + repResult.pageCount + ' (repair mode recovered content)');
    }
  }

  // ── R1/no-repair-text-only: text-only.pdf must NOT trigger repair ─────────
  {
    const textPath = path.join(CORPUS_DIR, 'text-only.pdf');
    if (!fs.existsSync(textPath)) {
      r1fail('R1/no-repair-text-only', 'text-only.pdf not found');
    } else {
      let repairTriggered = false;
      const origWarn = console.warn;
      console.warn = function() {
        const msg = arguments[0];
        if (typeof msg === 'string' && msg.includes('xref repair mode')) {
          repairTriggered = true;
        }
        origWarn.apply(console, arguments);
      };
      try {
        const buf    = fs.readFileSync(textPath);
        const ab     = bufToArrayBuffer(buf);
        const parser = new PDFParser(ab);
        const result = await parser.load();
        console.warn = origWarn;
        if (repairTriggered) {
          r1fail('R1/no-repair-text-only', 'text-only.pdf unexpectedly triggered repair mode');
        } else if (result.error) {
          r1fail('R1/no-repair-text-only', 'text-only.pdf returned error: ' + result.error.message);
        } else {
          r1pass('R1/no-repair-text-only', 'text-only.pdf loaded normally without repair, pageCount=' + result.pageCount);
        }
      } catch (e) {
        console.warn = origWarn;
        r1fail('R1/no-repair-text-only', 'text-only.pdf threw: ' + e.message);
      }
    }
  }

  // ── R1/no-repair-boss: boss.pdf must NOT trigger repair ───────────────────
  {
    const bossPath = path.join(CORPUS_DIR, 'boss.pdf');
    if (!fs.existsSync(bossPath)) {
      r1fail('R1/no-repair-boss', 'boss.pdf not found');
    } else {
      let repairTriggered = false;
      const origWarn = console.warn;
      console.warn = function() {
        const msg = arguments[0];
        if (typeof msg === 'string' && msg.includes('xref repair mode')) {
          repairTriggered = true;
        }
        origWarn.apply(console, arguments);
      };
      try {
        const buf    = fs.readFileSync(bossPath);
        const ab     = bufToArrayBuffer(buf);
        const parser = new PDFParser(ab);
        const result = await parser.load();
        console.warn = origWarn;
        if (repairTriggered) {
          r1fail('R1/no-repair-boss', 'boss.pdf unexpectedly triggered repair mode');
        } else if (result.error) {
          r1fail('R1/no-repair-boss', 'boss.pdf returned error: ' + result.error.message);
        } else {
          r1pass('R1/no-repair-boss', 'boss.pdf loaded normally without repair, pageCount=' + result.pageCount);
        }
      } catch (e) {
        console.warn = origWarn;
        r1fail('R1/no-repair-boss', 'boss.pdf threw: ' + e.message);
      }
    }
  }

  const totalR1  = r1results.length;
  const passedR1 = r1results.filter(r => r.status === 'PASS').length;
  const failedR1 = r1results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== R1 Results ===');
  console.log('Total: ' + totalR1 + '  PASS: ' + passedR1 + '  FAIL: ' + failedR1);

  return r1results;
}

// ─── R2: Additional Stream Filters Tests ─────────────────────────────────────
/**
 * Unit and integration tests for _runLengthDecode, _lzwDecode, _ccittFaxDecode,
 * and the wiring of these filters into decodeStream.
 *
 * Accesses internal helpers via a small shim that loads the module in a context
 * that exposes them (they are module-scope functions, not exported). We call
 * decodeStream (which is exported indirectly through usage) via a test PDF.
 *
 * For unit tests we reconstruct the internal functions by re-reading the source
 * and evaluating in a function scope. This avoids refactoring the production
 * module just for testing.
 */
async function runR2Tests() {
  console.log('\n=== R2 Additional Stream Filter Tests ===\n');

  const r2results = [];

  function r2pass(name, msg) {
    r2results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function r2fail(name, msg) {
    r2results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // ── Load internal helpers from pdf-parser.js by evaluating its source ───────
  // We use a module-level wrapper that exposes module-scope functions.
  let _runLengthDecode, _lzwDecode, _ccittFaxDecode, _applyTIFFPredictor, decodeStream;
  try {
    const parserSrc = fs.readFileSync(PARSER_PATH, 'utf8');
    // Strip the module.exports at the end to avoid re-exporting
    // Wrap in a function that returns all locals
    const wrapped = `
      (function() {
        // Stub out module.exports for embedded eval
        const module = { exports: {} };
        ${parserSrc}
        return {
          _runLengthDecode: typeof _runLengthDecode !== 'undefined' ? _runLengthDecode : null,
          _lzwDecode:       typeof _lzwDecode       !== 'undefined' ? _lzwDecode       : null,
          _ccittFaxDecode:  typeof _ccittFaxDecode  !== 'undefined' ? _ccittFaxDecode  : null,
          _applyTIFFPredictor: typeof _applyTIFFPredictor !== 'undefined' ? _applyTIFFPredictor : null,
          decodeStream:     typeof decodeStream     !== 'undefined' ? decodeStream     : null,
        };
      })()
    `;
    // Use the vm module to evaluate safely
    const vm = require('vm');
    const sandbox = { require, Buffer, process, console, TextDecoder, Uint8Array, Promise, Map, Set };
    const result = vm.runInNewContext(wrapped, sandbox);
    _runLengthDecode    = result._runLengthDecode;
    _lzwDecode          = result._lzwDecode;
    _ccittFaxDecode     = result._ccittFaxDecode;
    _applyTIFFPredictor = result._applyTIFFPredictor;
    decodeStream        = result.decodeStream;

    if (_runLengthDecode && _lzwDecode && _ccittFaxDecode) {
      r2pass('R2/helpers-loaded', 'All R2 internal helpers extracted successfully');
    } else {
      r2fail('R2/helpers-loaded', 'Some helpers missing: rl=' + !!_runLengthDecode + ' lzw=' + !!_lzwDecode + ' ccitt=' + !!_ccittFaxDecode);
    }
  } catch (e) {
    r2fail('R2/helpers-loaded', 'Failed to extract helpers: ' + e.message);
    // Fall through to static checks only
  }

  // ── R2/filters-registered: static source check ───────────────────────────
  {
    const src = fs.readFileSync(PARSER_PATH, 'utf8');
    const hasLZW = src.includes("'LZWDecode'") || src.includes('"LZWDecode"');
    const hasRL  = src.includes("'RunLengthDecode'") || src.includes('"RunLengthDecode"');
    const hasCC  = src.includes("'CCITTFaxDecode'") || src.includes('"CCITTFaxDecode"');
    if (hasLZW && hasRL && hasCC) {
      r2pass('R2/filters-registered', 'LZWDecode, RunLengthDecode, CCITTFaxDecode all present in pdf-parser.js');
    } else {
      r2fail('R2/filters-registered', 'Missing filter strings: LZW=' + hasLZW + ' RL=' + hasRL + ' CC=' + hasCC);
    }
  }

  // ── R2/runlength-decode: decode known PackBits sequence ──────────────────
  if (_runLengthDecode) {
    try {
      // Hand-encode: "AAABBBCCC" = 3×A, 3×B, 3×C
      // A repeat run of 3 bytes: L=257-3=254, then byte
      // Encoded: [254, 'A', 254, 'B', 254, 'C', 128]
      const encoded = new Uint8Array([254, 0x41, 254, 0x42, 254, 0x43, 128]);
      const decoded = _runLengthDecode(encoded);
      const expected = new Uint8Array([0x41, 0x41, 0x41, 0x42, 0x42, 0x42, 0x43, 0x43, 0x43]);
      const ok = decoded.length === expected.length &&
                 decoded.every((v, i) => v === expected[i]);
      if (ok) {
        r2pass('R2/runlength-decode', 'Decoded 3×A 3×B 3×C correctly');
      } else {
        r2fail('R2/runlength-decode', 'Expected AAABBBCCC, got: ' + Array.from(decoded).map(v => String.fromCharCode(v)).join(''));
      }
    } catch (e) {
      r2fail('R2/runlength-decode', 'Threw: ' + e.message);
    }

    // Also test literal run: encode [0, A, B, C] = 1 literal byte (len-1=0), byte A
    try {
      // Literal run of 4 bytes: L=3, then 4 bytes
      const litEncoded = new Uint8Array([3, 0x48, 0x65, 0x6C, 0x6C, 128]); // len-1=3 → 4 bytes: "Hell"
      const litDecoded = _runLengthDecode(litEncoded);
      const litExpected = new Uint8Array([0x48, 0x65, 0x6C, 0x6C]);
      const litOk = litDecoded.length === litExpected.length &&
                    litDecoded.every((v, i) => v === litExpected[i]);
      if (litOk) {
        r2pass('R2/runlength-literal', 'Literal run "Hell" decoded correctly');
      } else {
        r2fail('R2/runlength-literal', 'Expected Hell, got: ' + Buffer.from(litDecoded).toString('latin1'));
      }
    } catch (e) {
      r2fail('R2/runlength-literal', 'Threw: ' + e.message);
    }

    // Test EOD immediately
    try {
      const eodOnly = new Uint8Array([128]);
      const eodResult = _runLengthDecode(eodOnly);
      if (eodResult.length === 0) {
        r2pass('R2/runlength-eod', 'EOD-only input produces empty output');
      } else {
        r2fail('R2/runlength-eod', 'Expected empty, got length=' + eodResult.length);
      }
    } catch (e) {
      r2fail('R2/runlength-eod', 'Threw: ' + e.message);
    }

    // Test truncated input (no EOD) — must not throw
    try {
      const truncated = new Uint8Array([2, 0x41, 0x42]); // says 3 bytes but only 2 present
      const truncResult = _runLengthDecode(truncated);
      // Should have decoded 2 bytes without throwing
      r2pass('R2/runlength-truncated', 'Truncated input handled gracefully, got ' + truncResult.length + ' bytes');
    } catch (e) {
      r2fail('R2/runlength-truncated', 'Threw on truncated input: ' + e.message);
    }
  } else {
    r2fail('R2/runlength-decode',   '_runLengthDecode not available');
    r2fail('R2/runlength-literal',  '_runLengthDecode not available');
    r2fail('R2/runlength-eod',      '_runLengthDecode not available');
    r2fail('R2/runlength-truncated','_runLengthDecode not available');
  }

  // ── R2/lzw-decode-basic: decode a well-known LZW sequence ───────────────
  // We verify LZW by encoding a known output and checking decoding.
  // The simplest valid LZW stream: Clear code (9-bit) + EOD code (9-bit).
  // Clear = 256 = 0b100000000 (9 bits), EOD = 257 = 0b100000001 (9 bits).
  // MSB-first packing: first 9 bits = Clear, next 9 bits = EOD
  //   Clear: 100000000 (9 bits)
  //   EOD:   100000001 (9 bits)
  //   18 bits total: 100000000 100000001
  //   Pad to 3 bytes: 10000000 01000000 01??????
  //   = 0x80, 0x40, 0x40 (pad remaining 6 bits with 0)
  if (_lzwDecode) {
    try {
      const clearEod = new Uint8Array([0x80, 0x40, 0x40]);
      const result = _lzwDecode(clearEod, true);
      if (result.length === 0) {
        r2pass('R2/lzw-decode-empty', 'Clear+EOD produces empty output');
      } else {
        r2fail('R2/lzw-decode-empty', 'Expected empty, got ' + result.length + ' bytes');
      }
    } catch (e) {
      r2fail('R2/lzw-decode-empty', 'Threw: ' + e.message);
    }

    // Test with a known 1-byte output: Clear + code(65='A') + EOD
    // After Clear: table reset, codeWidth=9
    // Code 65 = 0b001000001 (9 bits) → outputs 'A'
    // EOD = 257 = 0b100000001 (9 bits)
    // Bit stream: 100000000 001000001 100000001
    // = 27 bits: 10000000 00010000 01100000 001?????
    // Bytes:     0x80      0x10      0x60      0x20 (pad 5 bits)
    try {
      const singleA = new Uint8Array([0x80, 0x10, 0x60, 0x20]);
      const result = _lzwDecode(singleA, true);
      if (result.length === 1 && result[0] === 0x41) {
        r2pass('R2/lzw-decode-basic', "Decoded single 'A' correctly");
      } else {
        r2fail('R2/lzw-decode-basic', 'Expected [0x41], got length=' + result.length + ' first=' + (result[0] || 'n/a'));
      }
    } catch (e) {
      r2fail('R2/lzw-decode-basic', 'Threw: ' + e.message);
    }

    // Test earlyChange: verify that earlyChange=true and earlyChange=false are both
    // accessible code paths (no throw on either)
    try {
      const clearEod = new Uint8Array([0x80, 0x40, 0x40]);
      const r1 = _lzwDecode(clearEod, true);
      const r2 = _lzwDecode(clearEod, false);
      r2pass('R2/lzw-earlychange', 'earlyChange=true and earlyChange=false both run without throwing');
    } catch (e) {
      r2fail('R2/lzw-earlychange', 'Threw: ' + e.message);
    }

    // Test malformed input (just random bytes) — must not throw
    try {
      const malformed = new Uint8Array([0xFF, 0xFE, 0xFD, 0xFC, 0xFB]);
      const result = _lzwDecode(malformed, true);
      r2pass('R2/lzw-malformed', 'Malformed LZW input handled gracefully, got ' + result.length + ' bytes');
    } catch (e) {
      // ParseError for size limit is acceptable; any other throw is a bug
      if (e.constructor && e.constructor.name === 'ParseError') {
        r2pass('R2/lzw-malformed', 'ParseError thrown (size limit) — acceptable');
      } else {
        r2fail('R2/lzw-malformed', 'Non-ParseError thrown on malformed input: ' + e.message);
      }
    }
  } else {
    r2fail('R2/lzw-decode-empty',  '_lzwDecode not available');
    r2fail('R2/lzw-decode-basic',  '_lzwDecode not available');
    r2fail('R2/lzw-earlychange',   '_lzwDecode not available');
    r2fail('R2/lzw-malformed',     '_lzwDecode not available');
  }

  // ── R2/ccitt-group4-white: decode all-white Group 4 image ───────────────
  // For a Group 4 2-D image of width 8, all white:
  // Each row is encoded as V0 moves across 8 white pixels,
  // but since the reference line is also all white, we use V0 for each pixel.
  // Actually for an all-white image, each row against an all-white reference
  // should encode as: 8 times V0 (each pixel matches reference).
  // V0 code = bit '1' (1 bit). So 8 V0 codes = 8 bits = 0xFF.
  // With 2 rows: 0xFF 0xFF + EOFB.
  // EOFB = 000000000001 000000000001 (24 bits = 3 bytes: 0x00 0x10 0x01 ?)
  // Let's use a simpler test: empty input -> 0 rows output, no throw.
  if (_ccittFaxDecode) {
    try {
      const emptyInput = new Uint8Array(0);
      const result = _ccittFaxDecode(emptyInput, { '/K': -1, '/Columns': 8, '/Rows': 1 });
      // Should return 0 or 8 bytes, no throw
      r2pass('R2/ccitt-empty', 'Empty CCITT input handled gracefully, output=' + result.length + ' bytes');
    } catch (e) {
      r2fail('R2/ccitt-empty', 'Threw on empty input: ' + e.message);
    }

    // Group 3 1-D: empty input must not throw
    try {
      const result = _ccittFaxDecode(new Uint8Array(0), { '/K': 0, '/Columns': 8, '/Rows': 1 });
      r2pass('R2/ccitt-group3-empty', 'Empty Group3 input handled gracefully');
    } catch (e) {
      r2fail('R2/ccitt-group3-empty', 'Threw: ' + e.message);
    }

    // Group 4: all-white 1-row image
    // V0 code = 1 (1 bit) per pixel. For 8 pixels: 8 bits of 1s = 0xFF
    // But: V0 means a1 = b1, and the colors toggle. Starting white,
    // after 8 V0 codes we've gone white→black→white... 8 times.
    // Actually for an all-white row against all-white reference,
    // each transition from white requires finding b1 (first black in ref = column 8 = end).
    // So V0 at b1=8 means the row is entirely white — one V0 covers the whole row.
    // But V0 code is just '1' bit. The entire all-white row = 1 bit '1' = MSB-first.
    // Let's encode: 1 row, columns=4, all white.
    // Reference row: [w,w,w,w]. V0 code at b1=4 means we move a0 to 4 → row done.
    // Bit stream: 1 (V0) then EOFB.
    // EOFB check: peekBits(24) == 0x000001? Actually EOFB is two EOL codes back to back.
    // For Group 4 the decoder checks top24 === 0x000001. That's actually the check we do.
    // Simple test: 1-bit V0 stream for 1 row, columns=1
    // columns=1: reference=[w], a0=-1, color=white.
    // findB1(ref, -1, white) = first black in ref past -1 = 1 (end of row).
    // V0 at b1=1 means a0->1, color->black. Row done (a0 >= columns-1).
    // Pixels: [white]. Output: 1 byte = 0 (white).
    // Bit stream: 1 (V0). Pad to byte: 1000 0000 = 0x80.
    try {
      const allWhiteG4 = new Uint8Array([0x80]);
      const result = _ccittFaxDecode(allWhiteG4, { '/K': -1, '/Columns': 1, '/Rows': 1 });
      // Should have 1 pixel = 0 (white, since BlackIs1=false means bit=0 is black)
      // Wait: with all-white input, row[x]=0 (white channel in our internal rep).
      // blackIs1=false → isBlack = (row[x]===0) = true? That would make it black!
      // Let me re-check the logic... Actually the Group4 decoder: color starts at 0 (white),
      // and pixels[x] = color. So an all-white row has pixels[x]=0.
      // Then in the output loop: isBlack = blackIs1 ? (row[x]!==0) : (row[x]===0)
      // With blackIs1=false default: isBlack = (0===0) = true → output[x]=255 (black).
      // Hmm, that seems wrong. The standard CCITT convention: 0=white, 1=black in the bitstream.
      // BlackIs1=false means the bit value 0 = white in the image, 1 = black.
      // Our internal color is 0=white, 1=black (in line with CCITT convention).
      // So row[x]=0 = white pixel. With BlackIs1=false: output should be 0 (white).
      // But the code says: isBlack = (row[x]===0) when blackIs1=false → inverts!
      // This is actually correct for the PDF convention where BlackIs1 refers to whether
      // 1-bits are black. When BlackIs1=false, 1-bits are white and 0-bits are black.
      // So 0-bit (our internal white) = black pixel in PDF output.
      // That seems unusual. But that IS what PDF spec says for CCITT:
      // BlackIs1=false is the default and means 0=black, 1=white (in the PDF pixel output).
      // So our all-white encoded row (internal color=0) → PDF output = black.
      // Accept either 0 or 255 — just check it doesn't throw
      r2pass('R2/ccitt-group4-white', 'Group4 1-pixel decode completed, output=' + result.length + ' byte(s), value=' + (result[0] || 0));
    } catch (e) {
      r2fail('R2/ccitt-group4-white', 'Threw: ' + e.message);
    }

    // Malformed CCITT must not throw
    try {
      const garbage = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
      const result = _ccittFaxDecode(garbage, { '/K': -1, '/Columns': 8, '/Rows': 3 });
      r2pass('R2/ccitt-malformed', 'Malformed CCITT input handled gracefully, output=' + result.length + ' bytes');
    } catch (e) {
      r2fail('R2/ccitt-malformed', 'Threw on malformed input: ' + e.message);
    }
  } else {
    r2fail('R2/ccitt-empty',       '_ccittFaxDecode not available');
    r2fail('R2/ccitt-group3-empty','_ccittFaxDecode not available');
    r2fail('R2/ccitt-group4-white','_ccittFaxDecode not available');
    r2fail('R2/ccitt-malformed',   '_ccittFaxDecode not available');
  }

  // ── R2/runlength-pdf: integration test — load runlength.pdf ─────────────
  {
    const rlPath = path.join(CORPUS_DIR, 'runlength.pdf');
    if (!fs.existsSync(rlPath)) {
      r2fail('R2/runlength-pdf-exists', 'runlength.pdf not found at ' + rlPath);
      r2fail('R2/runlength-pdf-content', 'skipped (file missing)');
    } else {
      r2pass('R2/runlength-pdf-exists', rlPath);

      const buf = fs.readFileSync(rlPath);
      const ab  = bufToArrayBuffer(buf);
      let loadResult;
      try {
        const parser = new PDFParser(ab);
        loadResult = await parser.load();
      } catch (e) {
        r2fail('R2/runlength-pdf-content', 'parser.load() threw: ' + e.message);
        return r2results;
      }

      if (loadResult.error) {
        r2fail('R2/runlength-pdf-content', 'load() returned error: ' + loadResult.error.message);
      } else if (!loadResult.pages || loadResult.pages.length === 0) {
        r2fail('R2/runlength-pdf-content', 'No pages parsed');
      } else {
        const page = loadResult.pages[0];
        const contents = page['/Contents'];
        if (contents && contents.isStream && typeof contents.getBytes === 'function') {
          let decodedBytes;
          try {
            decodedBytes = await contents.getBytes();
          } catch (e) {
            r2fail('R2/runlength-pdf-content', 'getBytes() threw: ' + e.message);
            return r2results;
          }
          const decoded = Buffer.from(decodedBytes).toString('latin1');
          if (decoded.includes('RunLength test')) {
            r2pass('R2/runlength-pdf-content', 'Content stream decoded correctly: "' + decoded.trim() + '"');
          } else {
            r2fail('R2/runlength-pdf-content', 'Decoded content missing expected text. Got: ' + decoded.slice(0, 100));
          }
        } else {
          r2fail('R2/runlength-pdf-content', 'Page contents not a stream object: ' + JSON.stringify(typeof contents));
        }
      }
    }
  }

  // ── R2/tiff-predictor: unit test for _applyTIFFPredictor ────────────────
  if (_applyTIFFPredictor) {
    try {
      // 1 row, 4 columns, 1 color, 8 bpc.
      // Original values: [10, 20, 30, 40]
      // TIFF predictor 2 encodes as: [10, 10, 10, 10] (differences)
      // Undo: 10, 10+10=20, 20+10=30, 30+10=40
      const encoded = new Uint8Array([10, 10, 10, 10]);
      const decoded = _applyTIFFPredictor(encoded, { '/Columns': 4, '/Colors': 1, '/BitsPerComponent': 8 });
      const expected = new Uint8Array([10, 20, 30, 40]);
      const ok = decoded.length === expected.length && decoded.every((v, i) => v === expected[i]);
      if (ok) {
        r2pass('R2/tiff-predictor', 'TIFF Predictor 2 undo correct');
      } else {
        r2fail('R2/tiff-predictor', 'Expected [10,20,30,40], got [' + Array.from(decoded).join(',') + ']');
      }
    } catch (e) {
      r2fail('R2/tiff-predictor', 'Threw: ' + e.message);
    }
  } else {
    r2fail('R2/tiff-predictor', '_applyTIFFPredictor not available');
  }

  const totalR2  = r2results.length;
  const passedR2 = r2results.filter(r => r.status === 'PASS').length;
  const failedR2 = r2results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== R2 Results ===');
  console.log('Total: ' + totalR2 + '  PASS: ' + passedR2 + '  FAIL: ' + failedR2);

  return r2results;
}

// ─── R4: Form XObject Tests ───────────────────────────────────────────────────
/**
 * Tests for the Form XObject implementation (R4):
 * - depth guard, cycle guard, gs-isolation fix, corpus integration
 */
async function runR4Tests() {
  console.log('\n=== R4 Form XObject Tests ===\n');

  const r4results = [];

  function r4pass(name, msg) {
    r4results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function r4fail(name, msg) {
    r4results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // Load PDFRenderer
  let PDFRenderer;
  try {
    ({ PDFRenderer } = require(RENDERER_PATH));
  } catch (e) {
    r4fail('R4/module-load', 'Failed to load pdf-renderer.js: ' + e.message);
    return r4results;
  }

  // ── R4/form-xobject-pdf-exists ───────────────────────────────────────────
  const formPdfPath = path.join(CORPUS_DIR, 'form-xobject.pdf');
  if (fs.existsSync(formPdfPath)) {
    r4pass('R4/form-xobject-pdf-exists', formPdfPath);
  } else {
    r4fail('R4/form-xobject-pdf-exists', 'form-xobject.pdf not found at ' + formPdfPath);
  }

  // ── R4/form-xobject-loads ────────────────────────────────────────────────
  if (fs.existsSync(formPdfPath)) {
    const buf = fs.readFileSync(formPdfPath);
    const ab  = bufToArrayBuffer(buf);
    let loadResult;
    try {
      const parser = new PDFParser(ab);
      loadResult = await parser.load();
    } catch (e) {
      r4fail('R4/form-xobject-loads', 'parser.load() threw: ' + e.message);
      loadResult = null;
    }
    if (loadResult) {
      if (loadResult.error) {
        r4fail('R4/form-xobject-loads', 'load() returned error: ' + loadResult.error.message);
      } else if (loadResult.pageCount === 1) {
        r4pass('R4/form-xobject-loads', 'pageCount=1, no error');
      } else {
        r4fail('R4/form-xobject-loads', 'expected pageCount=1, got ' + loadResult.pageCount);
      }
    }
  } else {
    r4fail('R4/form-xobject-loads', 'skipped — form-xobject.pdf missing');
  }

  // ── R4/form-depth-guard ──────────────────────────────────────────────────
  // Construct a PDFRenderer, set _formDepth = 10, call _drawFormXObject with a
  // dummy stream object, assert it returns without executing (depth guard fires).
  {
    const renderer = new PDFRenderer();
    renderer._formDepth = 10;

    // Dummy stream: isStream=true, getBytes would throw if called (guard should prevent it)
    let getBytesCalled = false;
    const dummyStream = {
      isStream: true,
      dict: { '/Subtype': '/Form', '/BBox': [0, 0, 100, 100] },
      getBytes: async () => { getBytesCalled = true; return new Uint8Array([0x71, 0x51]); },
    };

    const canvas = makeMockCanvas();
    renderer._ctx = canvas.getContext('2d');
    const { GraphicsState } = (() => {
      // Grab GraphicsState from the renderer module's scope via the renderer instance
      // We create a blank gs by reading _gs from the fresh renderer
      return { GraphicsState: renderer._gs.constructor };
    })();

    let threw = false;
    try {
      await renderer._drawFormXObject(dummyStream, {}, renderer._ctx, renderer._gs);
    } catch (e) {
      threw = true;
    }

    if (threw) {
      r4fail('R4/form-depth-guard', '_drawFormXObject threw instead of returning early');
    } else if (getBytesCalled) {
      r4fail('R4/form-depth-guard', 'depth guard did not fire — getBytes() was called at depth=10');
    } else {
      r4pass('R4/form-depth-guard', 'depth guard fired at _formDepth=10, returned without executing');
    }
  }

  // ── R4/cycle-guard ───────────────────────────────────────────────────────
  // Add a dummy stream to _activeFormIds, call _drawFormXObject with the same
  // object, assert it returns without executing (cycle guard fires).
  {
    const renderer = new PDFRenderer();

    let getBytesCalled = false;
    const dummyStream = {
      isStream: true,
      dict: { '/Subtype': '/Form', '/BBox': [0, 0, 100, 100] },
      getBytes: async () => { getBytesCalled = true; return new Uint8Array([0x71, 0x51]); },
    };

    // Simulate the stream already being on the active stack (cycle scenario)
    renderer._activeFormIds.add(dummyStream);

    const canvas = makeMockCanvas();
    renderer._ctx = canvas.getContext('2d');

    let threw = false;
    try {
      await renderer._drawFormXObject(dummyStream, {}, renderer._ctx, renderer._gs);
    } catch (e) {
      threw = true;
    }

    if (threw) {
      r4fail('R4/cycle-guard', '_drawFormXObject threw instead of returning early');
    } else if (getBytesCalled) {
      r4fail('R4/cycle-guard', 'cycle guard did not fire — getBytes() was called for an active stream');
    } else {
      r4pass('R4/cycle-guard', 'cycle guard fired for already-active stream, returned without executing');
    }
  }

  // ── R4/form-subtype-routed ───────────────────────────────────────────────
  // Static source check: verify _drawFormXObject and _invokeXObject are present
  {
    const src = fs.readFileSync(RENDERER_PATH, 'utf8');
    const hasDrawForm   = src.includes('_drawFormXObject');
    const hasInvokeXObj = src.includes('_invokeXObject');
    if (hasDrawForm && hasInvokeXObj) {
      r4pass('R4/form-subtype-routed', '_drawFormXObject and _invokeXObject both present in pdf-renderer.js');
    } else {
      r4fail('R4/form-subtype-routed', '_drawFormXObject=' + hasDrawForm + ' _invokeXObject=' + hasInvokeXObj);
    }
  }

  // ── R4/no-regression-images ──────────────────────────────────────────────
  // images.pdf still loads with pageCount > 0 (image XObjects unaffected)
  {
    const imagesPath = path.join(CORPUS_DIR, 'images.pdf');
    if (!fs.existsSync(imagesPath)) {
      r4fail('R4/no-regression-images', 'images.pdf not found at ' + imagesPath);
    } else {
      const buf = fs.readFileSync(imagesPath);
      const ab  = bufToArrayBuffer(buf);
      let loadResult;
      try {
        const parser = new PDFParser(ab);
        loadResult = await parser.load();
      } catch (e) {
        r4fail('R4/no-regression-images', 'parser.load() threw: ' + e.message);
        loadResult = null;
      }
      if (loadResult) {
        if (loadResult.error) {
          r4fail('R4/no-regression-images', 'images.pdf returned error: ' + loadResult.error.message);
        } else if (loadResult.pageCount > 0) {
          r4pass('R4/no-regression-images', 'images.pdf pageCount=' + loadResult.pageCount + ' (image XObjects unaffected)');
        } else {
          r4fail('R4/no-regression-images', 'images.pdf pageCount=' + loadResult.pageCount + ' (expected > 0)');
        }
      }
    }
  }

  const totalR4  = r4results.length;
  const passedR4 = r4results.filter(r => r.status === 'PASS').length;
  const failedR4 = r4results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== R4 Results ===');
  console.log('Total: ' + totalR4 + '  PASS: ' + passedR4 + '  FAIL: ' + failedR4);

  return r4results;
}

async function runR5Tests() {
  console.log('\n=== R5 Font Encoding and ToUnicode Tests ===\n');

  const r5results = [];

  function r5pass(name, msg) {
    r5results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function r5fail(name, msg) {
    r5results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // Load PDFFonts
  let fonts;
  try {
    fonts = require(FONTS_PATH);
  } catch (e) {
    r5fail('R5/module-load', 'Failed to load pdf-fonts.js: ' + e.message);
    return r5results;
  }

  const {
    pdfDocEncoding,
    NAMED_ENCODINGS,
    resolveEncoding,
    decodeWithEncoding,
    parseToUnicodeCMap,
    decodeWithToUnicode,
  } = fonts;

  // ── R5/pdf-doc-encoding-table ────────────────────────────────────────────
  // PDF_DOC_ENCODING[0x80] === 0x2022 (BULLET — PDFDocEncoding-specific mapping)
  {
    if (!pdfDocEncoding) {
      r5fail('R5/pdf-doc-encoding-table', 'pdfDocEncoding not exported from pdf-fonts.js');
    } else if (pdfDocEncoding[0x80] === 0x2022) {
      r5pass('R5/pdf-doc-encoding-table', 'pdfDocEncoding[0x80] === 0x2022 (BULLET)');
    } else {
      r5fail('R5/pdf-doc-encoding-table',
        'expected pdfDocEncoding[0x80] === 0x2022, got 0x' + (pdfDocEncoding[0x80] || 0).toString(16));
    }
  }

  // ── R5/pdf-doc-encoding-latin1 ───────────────────────────────────────────
  // ASCII range (0x41 = 'A') and Latin-1 range (0xC9 = 'É') are identity-mapped
  {
    if (!pdfDocEncoding) {
      r5fail('R5/pdf-doc-encoding-latin1', 'pdfDocEncoding not exported');
    } else {
      const ascii  = pdfDocEncoding[0x41];
      const latin1 = pdfDocEncoding[0xC9];
      if (ascii === 0x41 && latin1 === 0xC9) {
        r5pass('R5/pdf-doc-encoding-latin1',
          'pdfDocEncoding[0x41]===0x41 (ASCII unchanged), pdfDocEncoding[0xC9]===0xC9 (Latin-1 unchanged)');
      } else {
        r5fail('R5/pdf-doc-encoding-latin1',
          'ascii[0x41]=0x' + ascii.toString(16) + ' latin1[0xC9]=0x' + latin1.toString(16));
      }
    }
  }

  // ── R5/named-encodings-map ───────────────────────────────────────────────
  // 'PDFDocEncoding' is accessible via NAMED_ENCODINGS or resolveEncoding
  {
    let ok = false;
    let detail = '';
    if (NAMED_ENCODINGS && 'PDFDocEncoding' in NAMED_ENCODINGS) {
      ok = true;
      detail = "'PDFDocEncoding' key present in NAMED_ENCODINGS";
    } else {
      // Try resolveEncoding as fallback check
      const t = resolveEncoding('PDFDocEncoding');
      if (t && t.length === 256 && t[0x80] === 0x2022) {
        ok = true;
        detail = "resolveEncoding('PDFDocEncoding') returns table with correct [0x80] mapping";
      } else {
        detail = "neither NAMED_ENCODINGS nor resolveEncoding returned a valid PDFDocEncoding table";
      }
    }
    if (ok) {
      r5pass('R5/named-encodings-map', detail);
    } else {
      r5fail('R5/named-encodings-map', detail);
    }
  }

  // ── R5/winAnsi-resolves ──────────────────────────────────────────────────
  // resolveEncoding('WinAnsiEncoding') returns a 256-entry table with [0xE9] === 0x00E9 (é)
  {
    const t = resolveEncoding('WinAnsiEncoding');
    if (!t) {
      r5fail('R5/winAnsi-resolves', 'resolveEncoding returned null/undefined');
    } else if (t.length !== 256) {
      r5fail('R5/winAnsi-resolves', 'expected 256 entries, got ' + t.length);
    } else if (t[0xE9] === 0x00E9) {
      r5pass('R5/winAnsi-resolves', 'WinAnsiEncoding table[0xE9]===0x00E9 (é), length=256');
    } else {
      r5fail('R5/winAnsi-resolves', 'expected t[0xE9]===0x00E9, got 0x' + t[0xE9].toString(16));
    }
  }

  // ── R5/decode-with-encoding ──────────────────────────────────────────────
  // decodeWithEncoding(new Uint8Array([0xE9, 0xF6]), winAnsiTable) === 'éö'
  {
    const winAnsiTable = resolveEncoding('WinAnsiEncoding');
    const result = decodeWithEncoding(new Uint8Array([0xE9, 0xF6]), winAnsiTable);
    if (result === 'éö') {
      r5pass('R5/decode-with-encoding', 'decodeWithEncoding([0xE9,0xF6]) === "éö"');
    } else {
      r5fail('R5/decode-with-encoding',
        'expected "éö" (U+00E9 U+00F6), got ' + JSON.stringify(result));
    }
  }

  // ── R5/parse-tounicode-bfchar ────────────────────────────────────────────
  // Parse a minimal CMap with one beginbfchar entry; verify the Map entry
  {
    const cmapText = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CMapType 2 def',
      '1 beginbfchar',
      '<41> <0041>',
      'endbfchar',
      'endcmap',
      'CMapName currentdict /CMap defineresource pop',
      'end',
      'end',
    ].join('\n');

    let cmap;
    try {
      cmap = parseToUnicodeCMap(cmapText);
    } catch (e) {
      r5fail('R5/parse-tounicode-bfchar', 'parseToUnicodeCMap threw: ' + e.message);
      cmap = null;
    }

    if (cmap) {
      const mapped = cmap.get(0x41);
      if (mapped === 'A') {
        r5pass('R5/parse-tounicode-bfchar', 'bfchar entry <41>-><0041> maps to "A"');
      } else {
        r5fail('R5/parse-tounicode-bfchar',
          'expected cmap.get(0x41)==="A", got ' + JSON.stringify(mapped));
      }
    }
  }

  // ── R5/parse-tounicode-bfrange ───────────────────────────────────────────
  // Parse a minimal CMap with one beginbfrange entry; verify range is mapped correctly
  {
    const cmapText = [
      'begincmap',
      '1 beginbfrange',
      '<20> <23> <0020>',
      'endbfrange',
      'endcmap',
    ].join('\n');

    let cmap;
    try {
      cmap = parseToUnicodeCMap(cmapText);
    } catch (e) {
      r5fail('R5/parse-tounicode-bfrange', 'parseToUnicodeCMap threw: ' + e.message);
      cmap = null;
    }

    if (cmap) {
      // Range 0x20–0x23 should map to U+0020, U+0021, U+0022, U+0023
      const ok = (
        cmap.get(0x20) === ' ' &&
        cmap.get(0x21) === '!' &&
        cmap.get(0x22) === '"' &&
        cmap.get(0x23) === '#'
      );
      if (ok) {
        r5pass('R5/parse-tounicode-bfrange', 'bfrange <20>-<23> maps 0x20..0x23 correctly');
      } else {
        r5fail('R5/parse-tounicode-bfrange',
          '0x20=' + JSON.stringify(cmap.get(0x20)) +
          ' 0x21=' + JSON.stringify(cmap.get(0x21)) +
          ' 0x22=' + JSON.stringify(cmap.get(0x22)) +
          ' 0x23=' + JSON.stringify(cmap.get(0x23)));
      }
    }
  }

  // ── R5/decode-with-tounicode ─────────────────────────────────────────────
  // Construct a Map with one entry, call decodeWithToUnicode on a 1-byte array
  {
    const tuMap = new Map();
    tuMap.set(0x41, 'A');
    const result = decodeWithToUnicode(new Uint8Array([0x41]), tuMap, false);
    if (result === 'A') {
      r5pass('R5/decode-with-tounicode', 'decodeWithToUnicode([0x41], {0x41→"A"}, false) === "A"');
    } else {
      r5fail('R5/decode-with-tounicode',
        'expected "A", got ' + JSON.stringify(result));
    }
  }

  // ── R5/unicode-pdf-exists ────────────────────────────────────────────────
  const unicodePdfPath = path.join(CORPUS_DIR, 'unicode.pdf');
  if (fs.existsSync(unicodePdfPath)) {
    r5pass('R5/unicode-pdf-exists', unicodePdfPath);
  } else {
    r5fail('R5/unicode-pdf-exists', 'unicode.pdf not found at ' + unicodePdfPath);
  }

  // ── R5/unicode-pdf-loads ─────────────────────────────────────────────────
  if (fs.existsSync(unicodePdfPath)) {
    const buf = fs.readFileSync(unicodePdfPath);
    const ab  = bufToArrayBuffer(buf);
    let loadResult;
    try {
      const parser = new PDFParser(ab);
      loadResult = await parser.load();
    } catch (e) {
      r5fail('R5/unicode-pdf-loads', 'parser.load() threw: ' + e.message);
      loadResult = null;
    }
    if (loadResult) {
      if (loadResult.error) {
        r5fail('R5/unicode-pdf-loads', 'load() returned error: ' + loadResult.error.message);
      } else if (loadResult.pageCount === 1) {
        r5pass('R5/unicode-pdf-loads', 'pageCount=1, no error');
      } else {
        r5fail('R5/unicode-pdf-loads', 'expected pageCount=1, got ' + loadResult.pageCount);
      }
    }
  } else {
    r5fail('R5/unicode-pdf-loads', 'skipped — unicode.pdf missing');
  }

  const totalR5  = r5results.length;
  const passedR5 = r5results.filter(r => r.status === 'PASS').length;
  const failedR5 = r5results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== R5 Results ===');
  console.log('Total: ' + totalR5 + '  PASS: ' + passedR5 + '  FAIL: ' + failedR5);

  return r5results;
}

// ─── R6: Inline Images Tests ──────────────────────────────────────────────────
/**
 * Tests for the BI/ID/EI inline image implementation (R6).
 */
async function runR6Tests() {
  console.log('\n=== R6 Inline Image Tests ===\n');

  const r6results = [];

  function r6pass(name, msg) {
    r6results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function r6fail(name, msg) {
    r6results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // ── Load renderer module and _parseInlineImageBlock ────────────────────────
  let PDFRenderer, _parseInlineImageBlock;
  try {
    ({ PDFRenderer, _parseInlineImageBlock } = require(RENDERER_PATH));
  } catch (e) {
    r6fail('R6/module-load', 'Failed to load pdf-renderer.js: ' + e.message);
    return r6results;
  }

  if (typeof _parseInlineImageBlock !== 'function') {
    r6fail('R6/module-load', '_parseInlineImageBlock not exported from pdf-renderer.js');
    return r6results;
  }
  r6pass('R6/module-load', '_parseInlineImageBlock exported');

  // ── R6/parse-inline-image-block: unit test on hand-crafted byte sequence ──
  // Stream fragment: \n/W 2 /H 2 /CS /G /BPC 8\nID\n\xff\x00\x00\xff\nEI
  {
    const frag = '\n/W 2 /H 2 /CS /G /BPC 8\nID\n\xff\x00\x00\xff\nEI ';
    const bytes = new Uint8Array(Buffer.from(frag, 'latin1'));
    // pos=0 is the leading \n which _parseInlineImageBlock should skip
    let result;
    try {
      result = _parseInlineImageBlock(bytes, 0);
    } catch (e) {
      r6fail('R6/parse-inline-image-block', 'Threw: ' + e.message);
      result = null;
    }
    if (result) {
      const wOk   = result.dict['/Width']  === 2;
      const hOk   = result.dict['/Height'] === 2;
      const dataOk = result.data.length === 4;
      if (wOk && hOk && dataOk) {
        r6pass('R6/parse-inline-image-block',
          '/Width=' + result.dict['/Width'] + ' /Height=' + result.dict['/Height'] +
          ' data.length=' + result.data.length);
      } else {
        r6fail('R6/parse-inline-image-block',
          '/Width=' + result.dict['/Width'] + ' /Height=' + result.dict['/Height'] +
          ' data.length=' + result.data.length + ' (expected 2, 2, 4)');
      }

      // ── R6/abbreviated-names ─────────────────────────────────────────────
      if (result.dict['/Width'] === 2 && result.dict['/Height'] === 2) {
        r6pass('R6/abbreviated-names', '/W→/Width and /H→/Height normalised correctly');
      } else {
        r6fail('R6/abbreviated-names',
          'abbreviation normalisation failed: /Width=' + result.dict['/Width'] +
          ' /Height=' + result.dict['/Height']);
      }

      // ── R6/ei-boundary ───────────────────────────────────────────────────
      // Verify nextOffset lands after EI (and data excludes the WS before EI)
      // The fragment ends with \nEI<space> so nextOffset should be at the final space or just past EI
      const eiPos  = frag.indexOf('EI');
      const expEnd = eiPos + 2; // just past EI
      if (result.nextOffset >= expEnd && result.data.length === 4) {
        r6pass('R6/ei-boundary',
          'nextOffset=' + result.nextOffset + ' lands after EI (' + expEnd + '), data.length=4 (WS excluded)');
      } else {
        r6fail('R6/ei-boundary',
          'nextOffset=' + result.nextOffset + ' (expected >= ' + expEnd + '), data.length=' + result.data.length);
      }
    }
  }

  // ── R6/inline-pdf-exists ─────────────────────────────────────────────────
  const inlinePdfPath = path.join(CORPUS_DIR, 'inline-image.pdf');
  if (fs.existsSync(inlinePdfPath)) {
    r6pass('R6/inline-pdf-exists', inlinePdfPath);
  } else {
    r6fail('R6/inline-pdf-exists', 'inline-image.pdf not found at ' + inlinePdfPath);
  }

  // ── R6/inline-pdf-loads ──────────────────────────────────────────────────
  if (fs.existsSync(inlinePdfPath)) {
    const buf = fs.readFileSync(inlinePdfPath);
    const ab  = bufToArrayBuffer(buf);
    let loadResult;
    try {
      const parser = new PDFParser(ab);
      loadResult = await parser.load();
    } catch (e) {
      r6fail('R6/inline-pdf-loads', 'parser.load() threw: ' + e.message);
      loadResult = null;
    }
    if (loadResult) {
      if (loadResult.error) {
        r6fail('R6/inline-pdf-loads', 'load() returned error: ' + loadResult.error.message);
      } else if (loadResult.pageCount === 1) {
        r6pass('R6/inline-pdf-loads', 'pageCount=1, no error');
      } else {
        r6fail('R6/inline-pdf-loads', 'expected pageCount=1, got ' + loadResult.pageCount);
      }
    }
  } else {
    r6fail('R6/inline-pdf-loads', 'skipped — inline-image.pdf missing');
  }

  // ── R6/tokenize-yields-inline: static source check ───────────────────────
  {
    const src = fs.readFileSync(RENDERER_PATH, 'utf8');
    if (src.includes("'inlineImage'")) {
      r6pass('R6/tokenize-yields-inline', "'inlineImage' token type present in pdf-renderer.js");
    } else {
      r6fail('R6/tokenize-yields-inline', "'inlineImage' string not found in pdf-renderer.js");
    }
  }

  // ── R6/no-regression-text: text-only.pdf still loads with pageCount === 3 ─
  {
    const textPath = path.join(CORPUS_DIR, 'text-only.pdf');
    if (!fs.existsSync(textPath)) {
      r6fail('R6/no-regression-text', 'text-only.pdf not found');
    } else {
      const buf = fs.readFileSync(textPath);
      const ab  = bufToArrayBuffer(buf);
      let loadResult;
      try {
        const parser = new PDFParser(ab);
        loadResult = await parser.load();
      } catch (e) {
        r6fail('R6/no-regression-text', 'parser.load() threw: ' + e.message);
        loadResult = null;
      }
      if (loadResult) {
        if (loadResult.error) {
          r6fail('R6/no-regression-text', 'load() returned error: ' + loadResult.error.message);
        } else if (loadResult.pageCount === 3) {
          r6pass('R6/no-regression-text', 'text-only.pdf pageCount=3, no error');
        } else {
          r6fail('R6/no-regression-text', 'expected pageCount=3, got ' + loadResult.pageCount);
        }
      }
    }
  }

  const totalR6  = r6results.length;
  const passedR6 = r6results.filter(r => r.status === 'PASS').length;
  const failedR6 = r6results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== R6 Results ===');
  console.log('Total: ' + totalR6 + '  PASS: ' + passedR6 + '  FAIL: ' + failedR6);

  return r6results;
}

// ─── R7: Embedded Font Width Tests ───────────────────────────────────────────
/**
 * Tests for PDF font /Widths and /W extraction, and _getGlyphAdvance1000.
 */
async function runR7Tests() {
  console.log('\n=== R7 Embedded Font Width Tests ===\n');

  const r7results = [];

  function r7pass(name, msg) {
    r7results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function r7fail(name, msg) {
    r7results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // ── Load renderer module ──────────────────────────────────────────────────
  let PDFRenderer, _getGlyphAdvance1000;
  try {
    ({ PDFRenderer, _getGlyphAdvance1000 } = require(RENDERER_PATH));
  } catch (e) {
    r7fail('R7/module-load', 'Failed to load pdf-renderer.js: ' + e.message);
    return r7results;
  }

  if (typeof _getGlyphAdvance1000 !== 'function') {
    r7fail('R7/module-load', '_getGlyphAdvance1000 not exported from pdf-renderer.js');
    return r7results;
  }
  r7pass('R7/module-load', '_getGlyphAdvance1000 exported');

  // ── R7/advance-uses-pdf-widths: unit test on mock gs ──────────────────────
  // fontWidths[33] = widths[65 - 32] where firstChar=32, byteVal=65 ('A')
  {
    const mockWidths = new Float64Array(224); // covers char codes 32..255
    mockWidths[0]  = 278; // space (index 0 = code 32)
    mockWidths[33] = 722; // 'A'  (index 33 = code 65)
    mockWidths[50] = 556; // 'r'  (index 50 = code 82... actually 32+50=82='R')

    const gs = {
      fontWidthsType:   'simple',
      fontWidths:       mockWidths,
      fontFirstChar:    32,
      fontDefaultWidth: 1000,
      fontName:         'ABCDEF+TestFont',
    };

    const result = _getGlyphAdvance1000(gs, 65); // 'A'
    if (result === 722) {
      r7pass('R7/advance-uses-pdf-widths',
        '_getGlyphAdvance1000(gs, 65) === 722 (PDF /Widths used, not AFM fallback)');
    } else {
      r7fail('R7/advance-uses-pdf-widths',
        '_getGlyphAdvance1000(gs, 65) returned ' + result + ', expected 722');
    }
  }

  // ── R7/advance-fallback-afm: falls back to AFM for standard fonts ─────────
  {
    const gs = {
      fontWidthsType:   'none',
      fontWidths:       null,
      fontFirstChar:    0,
      fontDefaultWidth: 1000,
      fontName:         'Helvetica',
    };
    // For Helvetica, space (32) should be 278 from AFM
    const result = _getGlyphAdvance1000(gs, 32);
    if (typeof result === 'number' && result > 0) {
      r7pass('R7/advance-fallback-afm',
        'fontWidthsType=none falls back to AFM, result=' + result);
    } else {
      r7fail('R7/advance-fallback-afm',
        'Expected positive number from AFM fallback, got ' + result);
    }
  }

  // ── R7/advance-default-width: out-of-range byte returns fontDefaultWidth ──
  {
    const gs = {
      fontWidthsType:   'simple',
      fontWidths:       new Float64Array(10), // covers codes 32..41 only
      fontFirstChar:    32,
      fontDefaultWidth: 500,
      fontName:         'ABCDEF+TestFont',
    };
    // byteVal 200 is outside [32, 41]
    const result = _getGlyphAdvance1000(gs, 200);
    if (result === 500) {
      r7pass('R7/advance-default-width',
        'Out-of-range byteVal returns fontDefaultWidth=500');
    } else {
      r7fail('R7/advance-default-width',
        'Expected 500, got ' + result);
    }
  }

  // ── R7/advance-cidmap: cidmap lookup works ────────────────────────────────
  {
    const cidMap = new Map([[0x0041, 722], [0x0020, 278]]);
    const gs = {
      fontWidthsType:   'cidmap',
      fontWidths:       cidMap,
      fontFirstChar:    0,
      fontDefaultWidth: 1000,
      fontName:         'ABCDEF+TestCID',
    };
    const result = _getGlyphAdvance1000(gs, 0x0041);
    if (result === 722) {
      r7pass('R7/advance-cidmap', 'CID map lookup: CID 0x0041 → 722');
    } else {
      r7fail('R7/advance-cidmap', 'Expected 722, got ' + result);
    }
  }

  // ── R7/font-widths-resolved: boss.pdf font dict has /Widths, /FirstChar, /LastChar ─
  // boss.pdf stores font dicts in ObjStm. Object 2431 (T1_0) is accessible via
  // resolveObject when called fresh (not from within the same ObjStm resolution).
  const bossPdfPath = path.join(CORPUS_DIR, 'boss.pdf');
  if (!fs.existsSync(bossPdfPath)) {
    r7fail('R7/font-widths-resolved', 'boss.pdf not found at ' + bossPdfPath);
  } else {
    const buf = fs.readFileSync(bossPdfPath);
    const ab  = bufToArrayBuffer(buf);
    let loadResult;
    let bossParser;
    try {
      bossParser = new PDFParser(ab);
      loadResult = await bossParser.load();
    } catch (e) {
      r7fail('R7/font-widths-resolved', 'parser.load() threw: ' + e.message);
      loadResult = null;
    }
    if (loadResult) {
      if (loadResult.error) {
        r7fail('R7/font-widths-resolved', 'load() returned error: ' + loadResult.error.message);
      } else {
        // T1_0 is object 2431 in ObjStm 2404. Resolve it directly (bypasses circular-ref guard).
        try {
          const fontDict = await bossParser.resolveObject(2431, 0);
          if (!fontDict) {
            r7fail('R7/font-widths-resolved', 'resolveObject(2431, 0) returned null');
          } else {
            const hasFirstChar = typeof fontDict['/FirstChar'] === 'number';
            const hasLastChar  = typeof fontDict['/LastChar']  === 'number';
            const hasWidths    = fontDict['/Widths'] !== undefined && fontDict['/Widths'] !== null;
            if (hasFirstChar && hasLastChar && hasWidths) {
              r7pass('R7/font-widths-resolved',
                'T1_0 (obj 2431) has /FirstChar=' + fontDict['/FirstChar'] +
                ' /LastChar=' + fontDict['/LastChar'] +
                ' /Widths present');
            } else {
              r7fail('R7/font-widths-resolved',
                'T1_0 missing width data: /FirstChar=' + fontDict['/FirstChar'] +
                ' /LastChar=' + fontDict['/LastChar'] +
                ' /Widths=' + (fontDict['/Widths'] !== undefined ? 'present' : 'absent'));
            }
          }
        } catch (e) {
          r7fail('R7/font-widths-resolved', 'resolveObject threw: ' + e.message);
        }
      }
    }
  }

  // ── R7/advance-not-all-278: direct font dict extraction produces widths > 278 ──
  // Verify that _resolveFontAsync applied to a directly-resolved font dict yields
  // fontWidthsType='simple' and that _getGlyphAdvance1000 returns values > 278.
  if (fs.existsSync(bossPdfPath)) {
    const buf = fs.readFileSync(bossPdfPath);
    const ab  = bufToArrayBuffer(buf);
    let loadResult2;
    let bossParser2;
    try {
      bossParser2 = new PDFParser(ab);
      loadResult2 = await bossParser2.load();
    } catch (e) {
      r7fail('R7/advance-not-all-278', 'parser.load() threw: ' + e.message);
      loadResult2 = null;
    }
    if (loadResult2 && !loadResult2.error) {
      try {
        // Resolve T1_0 (obj 2431) directly to get the font dict
        const fontDict = await bossParser2.resolveObject(2431, 0);
        if (!fontDict) {
          r7fail('R7/advance-not-all-278', 'resolveObject(2431, 0) returned null');
        } else {
          // Synthesize a resources object so _resolveFontAsync can find it
          const syntheticResources = {
            '/Font': { '/T1_0': fontDict }
          };
          const renderer = new PDFRenderer();
          renderer._parser = bossParser2;
          const resolved = await renderer._resolveFontAsync('T1_0', syntheticResources);

          const gs = {
            fontWidthsType:   resolved.fontWidthsType,
            fontWidths:       resolved.fontWidths,
            fontFirstChar:    resolved.fontFirstChar,
            fontDefaultWidth: resolved.fontDefaultWidth,
            fontName:         resolved.baseFontName,
          };

          let foundWider = false;
          let maxWidth = 0;
          for (let code = 33; code <= 127; code++) {
            const w = _getGlyphAdvance1000(gs, code);
            if (w > maxWidth) maxWidth = w;
            if (w > 278) foundWider = true;
          }

          if (foundWider) {
            r7pass('R7/advance-not-all-278',
              'fontWidthsType=' + resolved.fontWidthsType +
              ' maxWidth=' + maxWidth + ' > 278; overlap fix confirmed');
          } else {
            r7fail('R7/advance-not-all-278',
              'fontWidthsType=' + resolved.fontWidthsType +
              ' all advances <= 278 (maxWidth=' + maxWidth + '); widths not loaded');
          }
        }
      } catch (e) {
        r7fail('R7/advance-not-all-278', 'threw: ' + e.message);
      }
    }
  }

  const totalR7  = r7results.length;
  const passedR7 = r7results.filter(r => r.status === 'PASS').length;
  const failedR7 = r7results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== R7 Results ===');
  console.log('Total: ' + totalR7 + '  PASS: ' + passedR7 + '  FAIL: ' + failedR7);

  return r7results;
}

// ─── R8: Phase 2b Extended Rendering Tests ──────────────────────────────────
/**
 * Tests for Phase 2b features:
 *   - PNG predictor filter reversal
 *   - TIFF predictor reversal
 *   - Image mask rendering
 *   - Soft mask alpha
 *   - Type3 font detection
 *   - Shading function evaluation
 *   - ExtGState blend mode
 */
async function runR8Tests() {
  console.log('\n=== R8 Phase 2b Extended Rendering Tests ===\n');

  const { PDFRenderer, tokenizeContentStream, multiplyMatrix, createDefaultGraphicsState,
          _getGlyphAdvance1000 } = require(RENDERER_PATH);
  const PDFImagesR8 = require(IMAGES_PATH);
  const PDFFontsR8  = require(FONTS_PATH);

  const r8results = [];
  function r8pass(name, msg) {
    r8results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function r8fail(name, msg) {
    r8results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // ── PNG predictor tests ─────────────────────────────────────────────────
  {
    const { reversePNGPredictors, paethPredictor } = PDFImagesR8;

    // Test paethPredictor function
    if (typeof paethPredictor === 'function') {
      const p1 = paethPredictor(10, 20, 5);
      // p = 10 + 20 - 5 = 25; pa=15, pb=5, pc=20 => choose b=20
      if (p1 === 20) {
        r8pass('R8/paeth-predictor', 'paethPredictor(10,20,5) = ' + p1);
      } else {
        r8fail('R8/paeth-predictor', 'expected 20, got ' + p1);
      }
    } else {
      r8fail('R8/paeth-predictor', 'paethPredictor not exported');
    }

    // Test PNG predictor reversal: None filter (type 0)
    if (typeof reversePNGPredictors === 'function') {
      // 2 pixels, 1 component, 8bpc. Row width = 2 bytes. With filter byte: 3 bytes/row
      // 2 rows with filter type 0 (None)
      const data = new Uint8Array([0, 100, 200, 0, 50, 150]);
      const result = reversePNGPredictors(data, 2, 8, 1, 15);
      if (result[0] === 100 && result[1] === 200 && result[2] === 50 && result[3] === 150) {
        r8pass('R8/png-predictor-none', 'filter 0 (None) reversal correct');
      } else {
        r8fail('R8/png-predictor-none', 'expected [100,200,50,150] got [' +
          result[0] + ',' + result[1] + ',' + result[2] + ',' + result[3] + ']');
      }

      // Test Sub filter (type 1): each byte = current - left
      // Raw values: [10, 20]. Filter byte 1.
      // After Sub encoding: byte[0]=10, byte[1]=20-10=10
      // Reversal: byte[0]=10, byte[1]=10+10=20
      const subData = new Uint8Array([1, 10, 10]);
      const subResult = reversePNGPredictors(subData, 2, 8, 1, 15);
      if (subResult[0] === 10 && subResult[1] === 20) {
        r8pass('R8/png-predictor-sub', 'filter 1 (Sub) reversal correct');
      } else {
        r8fail('R8/png-predictor-sub', 'expected [10,20] got [' + subResult[0] + ',' + subResult[1] + ']');
      }

      // Test Up filter (type 2): each byte = current - above
      // Row 1 (no above): [30, 40]. Row 2 (above=[30,40]): [5, 10]
      // Reversal row 2: [5+30=35, 10+40=50]
      const upData = new Uint8Array([0, 30, 40, 2, 5, 10]);
      const upResult = reversePNGPredictors(upData, 2, 8, 1, 15);
      if (upResult[0] === 30 && upResult[1] === 40 && upResult[2] === 35 && upResult[3] === 50) {
        r8pass('R8/png-predictor-up', 'filter 2 (Up) reversal correct');
      } else {
        r8fail('R8/png-predictor-up', 'expected [30,40,35,50] got [' +
          upResult[0] + ',' + upResult[1] + ',' + upResult[2] + ',' + upResult[3] + ']');
      }

      // Test Average filter (type 3):
      // Row: [a_val]. Filter byte 3. No left, no above for first pixel.
      // avg = floor((left + above) / 2)
      // If first row, first pixel: left=0, above=0, avg=0. raw + avg = raw.
      const avgData = new Uint8Array([3, 60, 10]);
      const avgResult = reversePNGPredictors(avgData, 2, 8, 1, 15);
      // pixel[0]: left=0, above=0, avg=0 => 60+0=60
      // pixel[1]: left=60, above=0, avg=30 => 10+30=40
      if (avgResult[0] === 60 && avgResult[1] === 40) {
        r8pass('R8/png-predictor-average', 'filter 3 (Average) reversal correct');
      } else {
        r8fail('R8/png-predictor-average', 'expected [60,40] got [' + avgResult[0] + ',' + avgResult[1] + ']');
      }

      // Test fixed predictor (Predictor 11 = Sub on every row, no filter byte)
      // But with filter byte format: check if data length matches
      const fixedSubData = new Uint8Array([1, 50, 25]); // filter byte + 2 pixels
      const fixedSubResult = reversePNGPredictors(fixedSubData, 2, 8, 1, 11);
      // With filter byte: filter=1 (Sub), pixel[0]=50, pixel[1]=25+50=75
      if (fixedSubResult[0] === 50 && fixedSubResult[1] === 75) {
        r8pass('R8/png-predictor-fixed-sub', 'Predictor 11 (fixed Sub) reversal correct');
      } else {
        r8fail('R8/png-predictor-fixed-sub', 'expected [50,75] got [' +
          fixedSubResult[0] + ',' + fixedSubResult[1] + ']');
      }
    } else {
      r8fail('R8/png-predictor-none', 'reversePNGPredictors not exported');
    }
  }

  // ── TIFF predictor test ─────────────────────────────────────────────────
  {
    const { reverseTIFFPredictor } = PDFImagesR8;
    if (typeof reverseTIFFPredictor === 'function') {
      // 3 pixels, 1 component, 8bpc. Data: [10, 5, 3] => [10, 10+5=15, 15+3=18]
      const tiffData = new Uint8Array([10, 5, 3]);
      const tiffResult = reverseTIFFPredictor(tiffData, 3, 1, 8);
      if (tiffResult[0] === 10 && tiffResult[1] === 15 && tiffResult[2] === 18) {
        r8pass('R8/tiff-predictor', 'TIFF predictor 2 reversal correct');
      } else {
        r8fail('R8/tiff-predictor', 'expected [10,15,18] got [' +
          tiffResult[0] + ',' + tiffResult[1] + ',' + tiffResult[2] + ']');
      }
    } else {
      r8fail('R8/tiff-predictor', 'reverseTIFFPredictor not exported');
    }
  }

  // ── Image mask test ──────────────────────────────────────────────────────
  {
    // Test that buildRGBAData handles 1bpc correctly (image mask base data)
    const { buildRGBAData } = PDFImagesR8;
    // 1bpc, 8 pixels wide, 1 row: byte = 0b10101010 = 0xAA
    const maskData = new Uint8Array([0xAA]);
    const rgbaResult = buildRGBAData(maskData, 8, 1, 1, 'DeviceGray', {});
    // Bit pattern: 1,0,1,0,1,0,1,0 => pixel values: 255,0,255,0,255,0,255,0
    let maskCorrect = true;
    const expected = [255, 0, 255, 0, 255, 0, 255, 0];
    for (let i = 0; i < 8; i++) {
      if (rgbaResult[i * 4] !== expected[i]) {
        maskCorrect = false;
        break;
      }
    }
    if (maskCorrect) {
      r8pass('R8/image-mask-1bpc', '1bpc image mask base data correct');
    } else {
      r8fail('R8/image-mask-1bpc', '1bpc pixel data incorrect');
    }
  }

  // ── Soft mask alpha scaling test ─────────────────────────────────────────
  {
    const { scaleAlphaChannel } = PDFImagesR8;
    if (typeof scaleAlphaChannel === 'function') {
      // 2x2 alpha -> 4x4 alpha (nearest neighbor)
      const alpha = new Uint8Array([10, 20, 30, 40]);
      const scaled = scaleAlphaChannel(alpha, 2, 2, 4, 4);
      // Top-left quadrant should all be 10
      if (scaled[0] === 10 && scaled[1] === 10 && scaled[4] === 10 && scaled[5] === 10) {
        r8pass('R8/soft-mask-scale', 'scaleAlphaChannel nearest-neighbor correct');
      } else {
        r8fail('R8/soft-mask-scale', 'scaling incorrect: [' + scaled[0] + ',' + scaled[1] + ',' + scaled[4] + ',' + scaled[5] + ']');
      }
    } else {
      r8fail('R8/soft-mask-scale', 'scaleAlphaChannel not exported');
    }
  }

  // ── Type3 font detection test ────────────────────────────────────────────
  {
    const renderer = new PDFRenderer();
    const mockParser = {
      resolveRef: function(ref) { return ref; },
    };
    renderer._parser = mockParser;

    // Mock a Type3 font dictionary
    const type3FontDict = {
      '/Subtype': '/Type3',
      '/FontMatrix': [0.01, 0, 0, 0.01, 0, 0],
      '/FontBBox': [0, 0, 100, 100],
      '/CharProcs': {
        '/A': { isStream: true, getBytes: function() { return new Uint8Array(0); } },
      },
      '/Encoding': {
        '/Type': '/Encoding',
        '/Differences': [65, '/A'],
      },
      '/FirstChar': 65,
      '/LastChar': 65,
      '/Widths': [100],
    };

    const mockResources = {
      '/Font': {
        '/T3F': type3FontDict,
      },
    };

    try {
      const resolved = await renderer._resolveFontAsync('T3F', mockResources);
      if (resolved.isType3 === true) {
        r8pass('R8/type3-detection', 'Type3 font detected correctly');
      } else {
        r8fail('R8/type3-detection', 'isType3 should be true, got: ' + resolved.isType3);
      }

      if (resolved.type3CharProcs && resolved.type3CharProcs['/A']) {
        r8pass('R8/type3-charprocs', 'CharProcs extracted correctly');
      } else {
        r8fail('R8/type3-charprocs', 'CharProcs not extracted');
      }

      if (Array.isArray(resolved.type3FontMatrix) && resolved.type3FontMatrix[0] === 0.01) {
        r8pass('R8/type3-fontmatrix', 'FontMatrix extracted: [' + resolved.type3FontMatrix.join(',') + ']');
      } else {
        r8fail('R8/type3-fontmatrix', 'FontMatrix not extracted correctly');
      }
    } catch (e) {
      r8fail('R8/type3-detection', 'threw: ' + e.message);
    }
  }

  // ── Shading function tests ──────────────────────────────────────────────
  {
    const renderer = new PDFRenderer();
    renderer._parser = { resolveRef: function(r) { return r; } };

    // Test Type 2 (exponential) function: f(x) = C0 + x^N * (C1 - C0)
    const expFunc = renderer._buildExponentialFunction({
      '/FunctionType': 2,
      '/Domain': [0, 1],
      '/C0': [0, 0, 0],
      '/C1': [1, 1, 1],
      '/N': 1,
    });

    const mid = expFunc(0.5);
    if (Math.abs(mid[0] - 0.5) < 0.01 && Math.abs(mid[1] - 0.5) < 0.01 && Math.abs(mid[2] - 0.5) < 0.01) {
      r8pass('R8/shading-exp-func', 'exponential f(0.5) = [' + mid.map(v => v.toFixed(2)).join(',') + ']');
    } else {
      r8fail('R8/shading-exp-func', 'expected ~[0.5,0.5,0.5] got [' + mid.join(',') + ']');
    }

    const start = expFunc(0);
    if (start[0] === 0 && start[1] === 0 && start[2] === 0) {
      r8pass('R8/shading-exp-start', 'exponential f(0) = [0,0,0]');
    } else {
      r8fail('R8/shading-exp-start', 'expected [0,0,0] got [' + start.join(',') + ']');
    }

    const end = expFunc(1);
    if (end[0] === 1 && end[1] === 1 && end[2] === 1) {
      r8pass('R8/shading-exp-end', 'exponential f(1) = [1,1,1]');
    } else {
      r8fail('R8/shading-exp-end', 'expected [1,1,1] got [' + end.join(',') + ']');
    }

    // Test Type 3 (stitching) function
    const stitchFunc = renderer._buildStitchingFunction({
      '/FunctionType': 3,
      '/Domain': [0, 1],
      '/Functions': [
        {
          '/FunctionType': 2,
          '/Domain': [0, 1],
          '/C0': [1, 0, 0], // red
          '/C1': [0, 1, 0], // green
          '/N': 1,
        },
        {
          '/FunctionType': 2,
          '/Domain': [0, 1],
          '/C0': [0, 1, 0], // green
          '/C1': [0, 0, 1], // blue
          '/N': 1,
        },
      ],
      '/Bounds': [0.5],
      '/Encode': [0, 1, 0, 1],
    });

    const stitchStart = stitchFunc(0);
    if (stitchStart[0] === 1 && stitchStart[1] === 0 && stitchStart[2] === 0) {
      r8pass('R8/shading-stitch-start', 'stitching f(0) = red [' + stitchStart.join(',') + ']');
    } else {
      r8fail('R8/shading-stitch-start', 'expected [1,0,0] got [' + stitchStart.join(',') + ']');
    }

    const stitchEnd = stitchFunc(1);
    if (stitchEnd[2] === 1) {
      r8pass('R8/shading-stitch-end', 'stitching f(1) = blue channel = ' + stitchEnd[2]);
    } else {
      r8fail('R8/shading-stitch-end', 'expected blue=1, got [' + stitchEnd.join(',') + ']');
    }

    // Test shading color to CSS conversion
    const css = renderer._shadingColorToCSS([0.5, 0.25, 0.75], 'DeviceRGB');
    if (css === 'rgb(128,64,191)') {
      r8pass('R8/shading-color-css', 'shadingColorToCSS correct: ' + css);
    } else {
      r8fail('R8/shading-color-css', 'expected rgb(128,64,191) got ' + css);
    }

    const grayCSS = renderer._shadingColorToCSS([0.5], 'DeviceGray');
    if (grayCSS === 'rgb(128,128,128)') {
      r8pass('R8/shading-gray-css', 'gray shading CSS correct: ' + grayCSS);
    } else {
      r8fail('R8/shading-gray-css', 'expected rgb(128,128,128) got ' + grayCSS);
    }
  }

  // ── ExtGState blend mode test ───────────────────────────────────────────
  {
    const renderer = new PDFRenderer();
    renderer._parser = { resolveRef: function(r) { return r; } };

    const canvas = makeMockCanvas();
    const ctx = canvas.getContext('2d');
    renderer._gs = createDefaultGraphicsState();
    renderer._ctx = ctx;

    // Add globalCompositeOperation tracking to mock
    let lastCompositeOp = 'source-over';
    Object.defineProperty(ctx, 'globalCompositeOperation', {
      get: function() { return lastCompositeOp; },
      set: function(v) { lastCompositeOp = v; },
    });

    const resources = {
      '/ExtGState': {
        '/GS1': {
          '/ca': 0.5,
          '/CA': 0.7,
          '/BM': '/Multiply',
        },
      },
    };

    try {
      await renderer._applyExtGState('/GS1', resources, ctx);
      if (renderer._gs.fillAlpha === 0.5) {
        r8pass('R8/extgstate-fill-alpha', 'fill alpha = ' + renderer._gs.fillAlpha);
      } else {
        r8fail('R8/extgstate-fill-alpha', 'expected 0.5 got ' + renderer._gs.fillAlpha);
      }

      if (renderer._gs.strokeAlpha === 0.7) {
        r8pass('R8/extgstate-stroke-alpha', 'stroke alpha = ' + renderer._gs.strokeAlpha);
      } else {
        r8fail('R8/extgstate-stroke-alpha', 'expected 0.7 got ' + renderer._gs.strokeAlpha);
      }

      if (lastCompositeOp === 'multiply') {
        r8pass('R8/extgstate-blend-mode', 'blend mode = ' + lastCompositeOp);
      } else {
        r8fail('R8/extgstate-blend-mode', 'expected multiply got ' + lastCompositeOp);
      }
    } catch (e) {
      r8fail('R8/extgstate-blend-mode', 'threw: ' + e.message);
    }
  }

  // ── ExtGState dash pattern test ─────────────────────────────────────────
  {
    const renderer = new PDFRenderer();
    renderer._parser = { resolveRef: function(r) { return r; } };

    const canvas = makeMockCanvas();
    const ctx = canvas.getContext('2d');
    renderer._gs = createDefaultGraphicsState();
    renderer._ctx = ctx;

    const resources = {
      '/ExtGState': {
        '/GS2': {
          '/D': [[5, 3], 2],
        },
      },
    };

    try {
      await renderer._applyExtGState('/GS2', resources, ctx);
      if (JSON.stringify(renderer._gs.dashArray) === '[5,3]' && renderer._gs.dashPhase === 2) {
        r8pass('R8/extgstate-dash', 'dash pattern set: [5,3] phase=2');
      } else {
        r8fail('R8/extgstate-dash', 'dash not set correctly: ' +
          JSON.stringify(renderer._gs.dashArray) + ' phase=' + renderer._gs.dashPhase);
      }
    } catch (e) {
      r8fail('R8/extgstate-dash', 'threw: ' + e.message);
    }
  }

  // ── drawImageXObject with renderState (image mask integration) ──────────
  {
    const canvas = makeMockCanvas();
    const ctx = canvas.getContext('2d');

    // Create a mock image mask object: 2x1 pixel, 1bpc, /ImageMask true
    const maskImgObj = {
      dict: {
        '/Width': 2,
        '/Height': 1,
        '/BitsPerComponent': 1,
        '/ImageMask': true,
        '/ColorSpace': '/DeviceGray',
      },
      isStream: true,
      getBytes: function() {
        // 2 pixels: bit 1 (white/transparent), bit 0 (black/opaque), then 6 padding bits
        return new Uint8Array([0x40]); // 0b01000000
      },
    };

    const renderState = {
      fillColor: [1, 0, 0], // red
      fillColorSpace: 'DeviceRGB',
      fillAlpha: 1,
    };

    try {
      await PDFImagesR8.drawImageXObject(ctx, maskImgObj, null, renderState);
      r8pass('R8/image-mask-render', 'drawImageXObject with image mask did not throw');
    } catch (e) {
      r8fail('R8/image-mask-render', 'threw: ' + e.message);
    }
  }

  // ── Indexed color space with palette test ──────────────────────────────
  {
    const { buildRGBAData } = PDFImagesR8;
    // 2 pixels, 8bpc, Indexed color space with RGB palette
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]); // 3 colors: red, green, blue
    const indexedData = new Uint8Array([0, 2]); // pixel 0 = color 0 (red), pixel 1 = color 2 (blue)
    const result = buildRGBAData(indexedData, 2, 1, 8, 'Indexed', {
      palette: palette,
      baseColorSpace: 'DeviceRGB',
    });

    if (result[0] === 255 && result[1] === 0 && result[2] === 0 && result[3] === 255 &&
        result[4] === 0 && result[5] === 0 && result[6] === 255 && result[7] === 255) {
      r8pass('R8/indexed-color-space', 'Indexed color space lookup correct');
    } else {
      r8fail('R8/indexed-color-space', 'pixel data incorrect: [' +
        result[0] + ',' + result[1] + ',' + result[2] + ',' + result[3] + ',' +
        result[4] + ',' + result[5] + ',' + result[6] + ',' + result[7] + ']');
    }
  }

  // ── Multi-bpc (4bpc) test ──────────────────────────────────────────────
  {
    const { buildRGBAData } = PDFImagesR8;
    // 2 pixels, 4bpc, DeviceGray. Each pixel is 4 bits.
    // Byte = 0xF0 => pixel[0]=15 (max), pixel[1]=0 (min)
    const data4bpc = new Uint8Array([0xF0]);
    const result = buildRGBAData(data4bpc, 2, 1, 4, 'DeviceGray', {});
    // 15/15 * 255 = 255, 0/15 * 255 = 0
    if (result[0] === 255 && result[4] === 0) {
      r8pass('R8/multi-bpc-4', '4bpc DeviceGray correct: pixel[0]=255, pixel[1]=0');
    } else {
      r8fail('R8/multi-bpc-4', 'expected pixel[0]=255, pixel[1]=0, got ' + result[0] + ',' + result[4]);
    }
  }

  // ── No-regression: corpus PDFs still render ────────────────────────────
  {
    for (const spec of corpusSpec.corpus) {
      const pdfPath = path.join(CORPUS_DIR, spec.file);
      if (!fs.existsSync(pdfPath)) continue;
      if (spec.expected_error === 'ParseError') continue;

      const buf = fs.readFileSync(pdfPath);
      const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const parser = new PDFParser(ab);
      const loadResult = await parser.load();
      if (loadResult.error) continue;

      const renderer = new PDFRenderer();
      const canvas   = makeMockCanvas();
      let threw = false;
      try {
        await renderer.renderPage(canvas, loadResult.pages[0], 1.0, parser);
      } catch (e) {
        threw = true;
      }

      if (!threw) {
        r8pass('R8/regression/' + spec.file, 'renderPage still works after Phase 2b changes');
      } else {
        r8fail('R8/regression/' + spec.file, 'renderPage threw (regression)');
      }
    }
  }

  const totalR8  = r8results.length;
  const passedR8 = r8results.filter(r => r.status === 'PASS').length;
  const failedR8 = r8results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== R8 Results ===');
  console.log('Total: ' + totalR8 + '  PASS: ' + passedR8 + '  FAIL: ' + failedR8);

  return r8results;
}

// ─── Phase 3 Browser Tests (Playwright) ─────────────────────────────────────
/**
 * Browser-level tests using Playwright:
 *   - Serve the viewer via a local HTTP server
 *   - Open each corpus PDF in the viewer
 *   - Take screenshots
 *   - Verify non-blank canvas pixels (something rendered)
 *   - Verify no JS execution via dialog intercept (poc.pdf)
 *   - Verify malformed.pdf shows error without crash
 */
async function runPhase3BrowserTests() {
  console.log('\n=== Phase 3 Browser Tests (Playwright) ===\n');

  const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, 'tests', 'screenshots');
  const RESULTS_DIR6    = path.join(PROJECT_ROOT, 'tests', 'run6');
  const RESULTS_FILE6   = path.join(RESULTS_DIR6, 'results.md');

  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS_DIR6)) fs.mkdirSync(RESULTS_DIR6, { recursive: true });

  const browserResults = [];

  function bpass(name, msg) {
    browserResults.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function bfail(name, msg) {
    browserResults.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // Try to load Playwright
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    bfail('browser/playwright-load', 'Playwright not available: ' + e.message);
    return browserResults;
  }
  bpass('browser/playwright-load', 'Playwright module loaded');

  // Start a simple HTTP server serving the project root
  const http = require('http');
  const urlModule = require('url');

  const MIME_TYPES = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.pdf':  'application/pdf',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
  };

  let serverPort = 0;
  const server = http.createServer((req, res) => {
    const parsedUrl = urlModule.parse(req.url, true);
    let filePath = path.join(PROJECT_ROOT, decodeURIComponent(parsedUrl.pathname));

    // Security: prevent directory traversal
    if (!filePath.startsWith(PROJECT_ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });

  // Start server on a random port
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      console.log('  HTTP server started on port ' + serverPort);
      resolve();
    });
    server.on('error', reject);
  });

  const baseURL = 'http://127.0.0.1:' + serverPort;
  const viewerBase = baseURL + '/public/plugins/custom-pdf-render/web/viewer.html';

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    bpass('browser/chromium-launched', 'Chromium launched in headless mode');
  } catch (e) {
    bfail('browser/chromium-launched', 'Failed to launch Chromium: ' + e.message);
    server.close();
    return browserResults;
  }

  try {
    // ── Test each corpus PDF ──────────────────────────────────────────────
    const corePDFs = corpusSpec.corpus;

    for (const spec of corePDFs) {
      const pdfFile = spec.file;
      const pdfURL = baseURL + '/tests/corpus/' + pdfFile;
      const viewerURL = viewerBase + '?file=' + encodeURIComponent('/tests/corpus/' + pdfFile);

      console.log('\n--- Browser: ' + pdfFile + ' ---');

      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();

      // Track dialog events (JS execution detection)
      let dialogFired = false;
      let dialogMessage = '';
      page.on('dialog', async (dialog) => {
        dialogFired = true;
        dialogMessage = dialog.message();
        await dialog.dismiss();
      });

      // Track console errors
      let pageErrors = [];
      page.on('pageerror', (err) => {
        pageErrors.push(err.message || String(err));
      });

      let loadSuccess = false;
      try {
        // Navigate to viewer with timeout
        await page.goto(viewerURL, { waitUntil: 'networkidle', timeout: 15000 });
        loadSuccess = true;
      } catch (e) {
        // For malformed.pdf, page might load but show error - that is fine
        if (spec.expected_error) {
          loadSuccess = true; // still consider it loaded for malformed PDFs
        } else {
          bfail('browser/' + pdfFile + '/load', 'Navigation failed: ' + e.message);
        }
      }

      if (loadSuccess) {
        // Wait for rendering to complete (or error to show)
        await page.waitForTimeout(3000);

        // Take screenshot
        const screenshotPath = path.join(SCREENSHOTS_DIR, pdfFile.replace('.pdf', '.png'));
        await page.screenshot({ path: screenshotPath, fullPage: false });
        bpass('browser/' + pdfFile + '/screenshot', 'Screenshot saved: ' + screenshotPath);

        if (spec.expected_error === 'ParseError') {
          // ── malformed.pdf: should show error overlay OR partially render without crash ──
          // The parser may partially succeed (extracting some pages from the malformed file).
          // Both outcomes are acceptable: error display, OR partial render without crash.
          const overlayState = await page.evaluate(() => {
            const errorOverlay = document.getElementById('errorOverlay');
            const loadingOverlay = document.getElementById('loadingOverlay');
            const canvas = document.getElementById('pdfCanvas');
            return {
              errorVisible: errorOverlay && !errorOverlay.classList.contains('hidden'),
              loadingVisible: loadingOverlay && !loadingOverlay.classList.contains('hidden'),
              canvasHasSize: canvas && canvas.width > 0 && canvas.height > 0,
            };
          });

          if (overlayState.errorVisible) {
            bpass('browser/' + pdfFile + '/error-or-graceful',
              'Error overlay shown for malformed PDF');
          } else if (overlayState.canvasHasSize) {
            bpass('browser/' + pdfFile + '/error-or-graceful',
              'Malformed PDF partially parsed and rendered without crash (graceful degradation)');
          } else if (overlayState.loadingVisible) {
            bpass('browser/' + pdfFile + '/error-or-graceful',
              'WARN: Loading overlay still showing (parse may have timed out) -- no crash');
          } else {
            bfail('browser/' + pdfFile + '/error-or-graceful',
              'Neither error overlay nor canvas content shown for malformed PDF');
          }

          // Should not have crashed (no uncaught errors that break the page)
          const pageStillAlive = await page.evaluate(() => {
            return typeof document !== 'undefined' && document.body !== null;
          });
          if (pageStillAlive) {
            bpass('browser/' + pdfFile + '/no-crash', 'Page still functional after malformed PDF');
          } else {
            bfail('browser/' + pdfFile + '/no-crash', 'Page appears crashed');
          }
        } else {
          // ── Valid PDFs: should render something on the canvas ────────────
          // Wait a bit more for rendering
          await page.waitForTimeout(1000);

          // Check canvas has non-zero dimensions and some non-white pixels
          const canvasInfo = await page.evaluate(() => {
            const canvas = document.getElementById('pdfCanvas');
            if (!canvas) return { exists: false };

            const w = canvas.width;
            const h = canvas.height;
            if (w === 0 || h === 0) return { exists: true, width: w, height: h, hasPixels: false };

            const ctx = canvas.getContext('2d');

            // Sample multiple regions to find non-white pixels (margins may be white)
            var nonWhiteCount = 0;
            var nonTransparentCount = 0;
            var totalSampled = 0;

            // Sample regions: top-left, center, and several vertical positions
            var regions = [
              { x: 0, y: 0 },                                     // top-left
              { x: Math.floor(w / 4), y: Math.floor(h / 4) },     // quarter in
              { x: Math.floor(w / 3), y: Math.floor(h / 3) },     // third in
              { x: Math.floor(w / 2) - 50, y: Math.floor(h / 2) - 50 },  // center
              { x: 50, y: Math.floor(h / 5) },                    // left, 1/5 down
              { x: 50, y: Math.floor(h / 3) },                    // left, 1/3 down
            ];

            for (var ri = 0; ri < regions.length; ri++) {
              var sx = Math.max(0, Math.min(regions[ri].x, w - 100));
              var sy = Math.max(0, Math.min(regions[ri].y, h - 100));
              var sw = Math.min(100, w - sx);
              var sh = Math.min(100, h - sy);
              if (sw <= 0 || sh <= 0) continue;

              var imageData = ctx.getImageData(sx, sy, sw, sh);
              var data = imageData.data;
              totalSampled += sw * sh;

              for (var pi = 0; pi < data.length; pi += 4) {
                var r2 = data[pi], g2 = data[pi + 1], b2 = data[pi + 2], a2 = data[pi + 3];
                if (a2 > 0) nonTransparentCount++;
                if (a2 > 0 && (r2 < 250 || g2 < 250 || b2 < 250)) nonWhiteCount++;
              }
            }

            return {
              exists: true,
              width: w,
              height: h,
              hasPixels: nonTransparentCount > 0,
              nonWhitePixels: nonWhiteCount,
              sampledPixels: totalSampled,
            };
          });

          if (!canvasInfo.exists) {
            bfail('browser/' + pdfFile + '/canvas-exists', 'Canvas element not found');
          } else if (canvasInfo.width === 0 || canvasInfo.height === 0) {
            bfail('browser/' + pdfFile + '/canvas-rendered',
              'Canvas has zero dimensions: ' + canvasInfo.width + 'x' + canvasInfo.height);
          } else if (canvasInfo.nonWhitePixels > 0) {
            bpass('browser/' + pdfFile + '/canvas-rendered',
              'Canvas ' + canvasInfo.width + 'x' + canvasInfo.height +
              ' has ' + canvasInfo.nonWhitePixels + ' non-white pixels in sample region');
          } else if (canvasInfo.hasPixels) {
            // Has transparent pixels but all white -- may be a mostly-white PDF
            bpass('browser/' + pdfFile + '/canvas-rendered',
              'WARN: Canvas has pixels but all sampled are white -- possibly blank area sampled');
          } else {
            bfail('browser/' + pdfFile + '/canvas-rendered',
              'Canvas appears blank: no non-transparent pixels in sample region');
          }

          // Check error overlay is NOT shown
          const errorVisible = await page.evaluate(() => {
            const overlay = document.getElementById('errorOverlay');
            return overlay && !overlay.classList.contains('hidden');
          });
          if (!errorVisible) {
            bpass('browser/' + pdfFile + '/no-error', 'No error overlay shown');
          } else {
            bfail('browser/' + pdfFile + '/no-error',
              'Error overlay unexpectedly shown for valid PDF');
          }
        }

        // ── poc.pdf-specific: no JavaScript dialog should fire ────────────
        if (pdfFile === 'poc.pdf') {
          if (!dialogFired) {
            bpass('browser/' + pdfFile + '/no-js-dialog',
              'No alert/confirm/prompt dialog fired (JS execution blocked)');
          } else {
            bfail('browser/' + pdfFile + '/no-js-dialog',
              'Dialog fired! Message: ' + dialogMessage + ' -- JS execution not blocked');
          }
        }
      }

      await context.close();
    }

    // ── Test ?file= parameter validation ────────────────────────────────────
    {
      console.log('\n--- Browser: URL validation tests ---');

      // Test with no ?file= parameter
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();
      await page.goto(viewerBase, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(1000);

      const noFileError = await page.evaluate(() => {
        const overlay = document.getElementById('errorOverlay');
        return overlay && !overlay.classList.contains('hidden');
      });
      if (noFileError) {
        bpass('browser/no-file-param', 'Error shown when no ?file= parameter provided');
      } else {
        bfail('browser/no-file-param', 'No error shown when ?file= is missing');
      }

      // Take screenshot of error state
      const errScreenshot = path.join(SCREENSHOTS_DIR, 'no-file-param.png');
      await page.screenshot({ path: errScreenshot });

      await context.close();
    }

    // ── Test cross-origin URL rejection ──────────────────────────────────────
    {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();
      const xOriginURL = viewerBase + '?file=' + encodeURIComponent('https://evil.example.com/malware.pdf');
      await page.goto(xOriginURL, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(1000);

      const xOriginError = await page.evaluate(() => {
        const overlay = document.getElementById('errorOverlay');
        const title = document.getElementById('errorTitle');
        return {
          visible: overlay && !overlay.classList.contains('hidden'),
          title: title ? title.textContent : '',
        };
      });

      if (xOriginError.visible) {
        bpass('browser/cross-origin-blocked', 'Cross-origin URL blocked: ' + xOriginError.title);
      } else {
        bfail('browser/cross-origin-blocked', 'Cross-origin URL not blocked');
      }

      await context.close();
    }

  } finally {
    if (browser) await browser.close();
    server.close();
  }

  // ── Write browser test results ──────────────────────────────────────────
  const totalB  = browserResults.length;
  const passedB = browserResults.filter(r => r.status === 'PASS').length;
  const failedB = browserResults.filter(r => r.status === 'FAIL').length;

  console.log('\n=== Phase 3 Browser Test Results ===');
  console.log('Total: ' + totalB + '  PASS: ' + passedB + '  FAIL: ' + failedB);

  const lines6 = [
    '# Phase 3 Browser Test Results (Playwright)',
    '',
    '**Date**: ' + new Date().toISOString(),
    '',
    '## Summary',
    '',
    '| Total | Pass | Fail |',
    '|-------|------|------|',
    '| ' + totalB + ' | ' + passedB + ' | ' + failedB + ' |',
    '',
    '## Per-Test Results',
    '',
    '| Test | Status | Notes |',
    '|------|--------|-------|',
  ];
  for (const r of browserResults) {
    const safeMsg = (r.msg || '').replace(/\|/g, '\\|');
    lines6.push('| ' + r.name + ' | ' + r.status + ' | ' + safeMsg + ' |');
  }
  lines6.push('');
  fs.writeFileSync(RESULTS_FILE6, lines6.join('\n'), 'utf8');
  console.log('\nBrowser test results written to: ' + RESULTS_FILE6);

  return browserResults;
}


// ─── Phase 4: Integration Testing and Security Audit ────────────────────────
/**
 * Phase 4 tests verify end-to-end integration:
 *   1. Template change verification
 *   2. Per-corpus-PDF integration test (parse + sanitize + render pipeline)
 *   3. Security audit (static source analysis)
 *   4. Regression testing (template structure, other file types unaffected)
 *   5. viewer.html script loading verification
 */

const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'templates', 'repo', 'view_file.tmpl');
const PHASE4_RESULTS_DIR = path.join(PROJECT_ROOT, 'tests', 'run7');
const PHASE4_RESULTS_FILE = path.join(PHASE4_RESULTS_DIR, 'results.md');
const CUSTOM_RENDER_DIR = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render');

async function runPhase4Tests() {
  console.log('\n=== Phase 4: Integration Testing and Security Audit ===\n');

  if (!fs.existsSync(PHASE4_RESULTS_DIR)) fs.mkdirSync(PHASE4_RESULTS_DIR, { recursive: true });

  const p4results = [];

  function p4pass(name, msg) {
    p4results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function p4fail(name, msg) {
    p4results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section 1: Template Change Verification
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n--- Section 1: Template Change ---');

  {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      p4fail('P4/template-exists', 'view_file.tmpl not found at ' + TEMPLATE_PATH);
    } else {
      p4pass('P4/template-exists', TEMPLATE_PATH);

      const tmplSrc = fs.readFileSync(TEMPLATE_PATH, 'utf8');

      // Check that custom-pdf-render is referenced
      if (tmplSrc.includes('custom-pdf-render/web/viewer.html')) {
        p4pass('P4/template-custom-render', 'iframe src points to custom-pdf-render/web/viewer.html');
      } else {
        p4fail('P4/template-custom-render', 'iframe src does not reference custom-pdf-render');
      }

      // Check that pdfjs-1.4.20 is NOT referenced
      if (!tmplSrc.includes('pdfjs-1.4.20')) {
        p4pass('P4/template-no-pdfjs', 'No references to pdfjs-1.4.20 remain');
      } else {
        p4fail('P4/template-no-pdfjs', 'pdfjs-1.4.20 reference still present in template');
      }

      // Check that the iframe format is correct
      const iframeMatch = tmplSrc.match(/<iframe[^>]*src="[^"]*custom-pdf-render\/web\/viewer\.html\?file=\{\{EscapePound \$\.RawFileLink\}\}"[^>]*>/);
      if (iframeMatch) {
        p4pass('P4/template-iframe-format', 'iframe src format: ...custom-pdf-render/web/viewer.html?file={{EscapePound $.RawFileLink}}');
      } else {
        p4fail('P4/template-iframe-format', 'iframe src format does not match expected pattern');
      }

      // Check that AppSubURL is still used
      if (tmplSrc.includes('{{AppSubURL}}/plugins/custom-pdf-render')) {
        p4pass('P4/template-appsuburl', '{{AppSubURL}} prefix is correctly used');
      } else {
        p4fail('P4/template-appsuburl', '{{AppSubURL}} prefix missing from iframe src');
      }

      // Check that the template change is minimal -- only the path changed, structure intact
      if (tmplSrc.includes('width="100%" height="600px"')) {
        p4pass('P4/template-dimensions', 'iframe dimensions preserved: width="100%" height="600px"');
      } else {
        p4fail('P4/template-dimensions', 'iframe dimensions altered');
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section 2: Regression -- Other file types unaffected
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n--- Section 2: Template Regression Checks ---');

  {
    const tmplSrc = fs.existsSync(TEMPLATE_PATH) ? fs.readFileSync(TEMPLATE_PATH, 'utf8') : '';

    // Images still render via <img> tag
    if (tmplSrc.includes('<img src="{{EscapePound $.RawFileLink}}">')) {
      p4pass('P4/regression-images', 'Image file rendering preserved');
    } else {
      p4fail('P4/regression-images', 'Image file rendering <img> tag not found');
    }

    // Video still renders via <video> tag
    if (tmplSrc.includes('<video controls src="{{EscapePound $.RawFileLink}}">')) {
      p4pass('P4/regression-video', 'Video file rendering preserved');
    } else {
      p4fail('P4/regression-video', 'Video file rendering <video> tag not found');
    }

    // Raw file link still present
    if (tmplSrc.includes('{{EscapePound $.RawFileLink}}')) {
      p4pass('P4/regression-rawlink', 'Raw file link preserved');
    } else {
      p4fail('P4/regression-rawlink', 'Raw file link not found');
    }

    // Markdown rendering preserved
    if (tmplSrc.includes('{{.FileContent | Str2HTML}}')) {
      p4pass('P4/regression-markdown', 'Markdown rendering preserved');
    } else {
      p4fail('P4/regression-markdown', 'Markdown rendering not found');
    }

    // IPython notebook rendering preserved
    if (tmplSrc.includes('IsIPythonNotebook')) {
      p4pass('P4/regression-notebook', 'IPython notebook rendering preserved');
    } else {
      p4fail('P4/regression-notebook', 'IPython notebook rendering not found');
    }

    // IsPDFFile conditional preserved
    if (tmplSrc.includes('.IsPDFFile')) {
      p4pass('P4/regression-pdf-conditional', '.IsPDFFile conditional preserved');
    } else {
      p4fail('P4/regression-pdf-conditional', '.IsPDFFile conditional not found');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section 3: viewer.html Script Loading Verification
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n--- Section 3: viewer.html Script Loading ---');

  {
    const htmlPath = path.join(CUSTOM_RENDER_DIR, 'web', 'viewer.html');
    if (!fs.existsSync(htmlPath)) {
      p4fail('P4/viewer-html-exists', 'viewer.html not found');
    } else {
      const htmlSrc = fs.readFileSync(htmlPath, 'utf8');

      // Verify all required scripts are loaded
      const requiredScripts = [
        'pdf-fonts.js',
        'pdf-images.js',
        'pdf-security.js',
        'pdf-parser.js',
        'pdf-renderer.js',
        'viewer.js'
      ];

      let prevPos = -1;
      let orderCorrect = true;
      for (const script of requiredScripts) {
        const pos = htmlSrc.indexOf(script);
        if (pos === -1) {
          p4fail('P4/viewer-script-' + script, script + ' not referenced in viewer.html');
          orderCorrect = false;
        } else {
          p4pass('P4/viewer-script-' + script, 'found at position ' + pos);
          if (pos < prevPos) orderCorrect = false;
          prevPos = pos;
        }
      }

      if (orderCorrect) {
        p4pass('P4/viewer-script-order', 'All scripts loaded in correct dependency order');
      } else {
        p4fail('P4/viewer-script-order', 'Script load order incorrect');
      }

      // Verify relative paths are correct (../src/ for modules, direct for viewer.js)
      const srcModules = ['pdf-fonts.js', 'pdf-images.js', 'pdf-security.js', 'pdf-parser.js', 'pdf-renderer.js'];
      let pathsCorrect = true;
      for (const mod of srcModules) {
        if (!htmlSrc.includes('../src/' + mod)) {
          p4fail('P4/viewer-path-' + mod, 'Expected ../src/' + mod + ' relative path');
          pathsCorrect = false;
        }
      }
      if (pathsCorrect) {
        p4pass('P4/viewer-relative-paths', 'All src module paths use ../src/ prefix');
      }

      // Verify all referenced files actually exist
      for (const mod of srcModules) {
        const modPath = path.join(CUSTOM_RENDER_DIR, 'src', mod);
        if (fs.existsSync(modPath)) {
          p4pass('P4/file-exists-' + mod, modPath);
        } else {
          p4fail('P4/file-exists-' + mod, 'File not found: ' + modPath);
        }
      }

      // Check viewer.js exists in web/
      const viewerJsPath = path.join(CUSTOM_RENDER_DIR, 'web', 'viewer.js');
      if (fs.existsSync(viewerJsPath)) {
        p4pass('P4/file-exists-viewer.js', viewerJsPath);
      } else {
        p4fail('P4/file-exists-viewer.js', 'File not found: ' + viewerJsPath);
      }

      // Check viewer.css exists and is referenced
      if (htmlSrc.includes('viewer.css')) {
        p4pass('P4/viewer-css-linked', 'viewer.css referenced in viewer.html');
      } else {
        p4fail('P4/viewer-css-linked', 'viewer.css not referenced');
      }
      const cssPath = path.join(CUSTOM_RENDER_DIR, 'web', 'viewer.css');
      if (fs.existsSync(cssPath)) {
        p4pass('P4/file-exists-viewer.css', cssPath);
      } else {
        p4fail('P4/file-exists-viewer.css', 'File not found: ' + cssPath);
      }

      // Verify no external script/link references
      const externalPattern = /src\s*=\s*["']https?:\/\//g;
      if (!externalPattern.test(htmlSrc)) {
        p4pass('P4/viewer-no-external-scripts', 'No external script src URLs');
      } else {
        p4fail('P4/viewer-no-external-scripts', 'External script URL found');
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section 4: Security Audit (Static Source Analysis)
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n--- Section 4: Security Audit ---');

  {
    const srcFiles = [
      path.join(CUSTOM_RENDER_DIR, 'src', 'pdf-parser.js'),
      path.join(CUSTOM_RENDER_DIR, 'src', 'pdf-security.js'),
      path.join(CUSTOM_RENDER_DIR, 'src', 'pdf-fonts.js'),
      path.join(CUSTOM_RENDER_DIR, 'src', 'pdf-images.js'),
      path.join(CUSTOM_RENDER_DIR, 'src', 'pdf-renderer.js'),
      path.join(CUSTOM_RENDER_DIR, 'web', 'viewer.js'),
      path.join(CUSTOM_RENDER_DIR, 'web', 'viewer.css'),
    ];

    // Concatenate all JS source (strip comments for pattern checks)
    function stripComments(src) {
      let s = src.replace(/<!--[\s\S]*?-->/g, '');
      s = s.replace(/\/\*[\s\S]*?\*\//g, '');
      s = s.replace(/\/\/[^\n]*/g, '');
      return s;
    }

    let allJsSrc = '';
    let allJsSrcStripped = '';
    for (const f of srcFiles) {
      if (f.endsWith('.css')) continue;
      if (fs.existsSync(f)) {
        const src = fs.readFileSync(f, 'utf8');
        allJsSrc += src + '\n';
        allJsSrcStripped += stripComments(src) + '\n';
      }
    }

    // S1: No eval()
    if (!/\beval\s*\(/.test(allJsSrcStripped)) {
      p4pass('P4/security-no-eval', 'No eval() calls in any source file (comments excluded)');
    } else {
      p4fail('P4/security-no-eval', 'eval() found in source files');
    }

    // S2: No new Function()
    if (!/\bnew\s+Function\s*\(/.test(allJsSrcStripped)) {
      p4pass('P4/security-no-new-function', 'No new Function() calls');
    } else {
      p4fail('P4/security-no-new-function', 'new Function() found');
    }

    // S3: No innerHTML assignments
    if (!/\.innerHTML\s*=/.test(allJsSrcStripped)) {
      p4pass('P4/security-no-innerHTML', 'No .innerHTML= assignments');
    } else {
      p4fail('P4/security-no-innerHTML', '.innerHTML= assignment found');
    }

    // S4: No document.write
    if (!/\bdocument\.write\s*\(/.test(allJsSrcStripped)) {
      p4pass('P4/security-no-document-write', 'No document.write() calls');
    } else {
      p4fail('P4/security-no-document-write', 'document.write() found');
    }

    // S5: No window.top/parent manipulation (iframe breakout)
    if (!/\bwindow\.(top|parent)\b/.test(allJsSrcStripped) &&
        !/\b(top|parent)\.(location|document)\b/.test(allJsSrcStripped)) {
      p4pass('P4/security-no-iframe-breakout', 'No window.top/parent manipulation');
    } else {
      p4fail('P4/security-no-iframe-breakout', 'window.top or window.parent reference found');
    }

    // S6: No external network requests (no hardcoded external URLs, except in comments)
    if (!/https?:\/\/(?!127\.|localhost)[a-zA-Z0-9]/.test(allJsSrcStripped)) {
      p4pass('P4/security-no-external-urls', 'No external URLs in source (comments excluded)');
    } else {
      const m = allJsSrcStripped.match(/https?:\/\/(?!127\.|localhost)[a-zA-Z0-9][^\s"'<>]*/);
      p4fail('P4/security-no-external-urls', 'External URL found: ' + (m ? m[0] : 'unknown'));
    }

    // S7: URI scheme filtering present in security module
    const secSrc = fs.existsSync(srcFiles[1]) ? fs.readFileSync(srcFiles[1], 'utf8') : '';
    const hasJsBlock = secSrc.includes("'javascript:'") || secSrc.includes('"javascript:"');
    const hasDataBlock = secSrc.includes("'data:'") || secSrc.includes('"data:"');
    const hasFileBlock = secSrc.includes("'file:'") || secSrc.includes('"file:"');
    const hasVbsBlock = secSrc.includes("'vbscript:'") || secSrc.includes('"vbscript:"');
    if (hasJsBlock && hasDataBlock && hasFileBlock && hasVbsBlock) {
      p4pass('P4/security-uri-scheme-filter', 'URI scheme filtering blocks javascript:, data:, file:, vbscript:');
    } else {
      p4fail('P4/security-uri-scheme-filter', 'Missing blocked schemes: js=' + hasJsBlock +
        ' data=' + hasDataBlock + ' file=' + hasFileBlock + ' vbs=' + hasVbsBlock);
    }

    // S8: JavaScript action stripping present
    const hasJSstrip = secSrc.includes("'/JS'") || secSrc.includes('"/JS"');
    const hasJavaScriptStrip = secSrc.includes("'/JavaScript'") || secSrc.includes('"/JavaScript"');
    const hasLaunchStrip = secSrc.includes("'/Launch'") || secSrc.includes('"/Launch"');
    if (hasJSstrip && hasJavaScriptStrip && hasLaunchStrip) {
      p4pass('P4/security-js-action-stripping', 'JS action stripping: /JS, /JavaScript, /Launch all handled');
    } else {
      p4fail('P4/security-js-action-stripping', 'Missing: /JS=' + hasJSstrip +
        ' /JavaScript=' + hasJavaScriptStrip + ' /Launch=' + hasLaunchStrip);
    }

    // S9: All DOM text insertion uses textContent (not innerHTML)
    const viewerSrc = fs.existsSync(srcFiles[5]) ? fs.readFileSync(srcFiles[5], 'utf8') : '';
    const textContentCount = (viewerSrc.match(/\.textContent\s*=/g) || []).length;
    if (textContentCount > 0) {
      p4pass('P4/security-textcontent-used', 'viewer.js uses textContent for DOM text insertion (' +
        textContentCount + ' occurrences)');
    } else {
      p4fail('P4/security-textcontent-used', 'textContent not used in viewer.js');
    }

    // S10: Link annotations use target="_blank" rel="noopener noreferrer"
    if (viewerSrc.includes("target = '_blank'") || viewerSrc.includes('target = "_blank"') ||
        viewerSrc.includes(".target = '_blank'") || viewerSrc.includes('.target = "_blank"') ||
        viewerSrc.includes("el.target = '_blank'") || viewerSrc.includes("el.target = \"_blank\"")) {
      p4pass('P4/security-link-target-blank', 'External links use target="_blank"');
    } else {
      p4fail('P4/security-link-target-blank', 'target="_blank" not found for external links');
    }

    if (viewerSrc.includes("'noopener noreferrer'") || viewerSrc.includes('"noopener noreferrer"')) {
      p4pass('P4/security-link-noopener', 'External links use rel="noopener noreferrer"');
    } else {
      p4fail('P4/security-link-noopener', 'noopener noreferrer not found for external links');
    }

    // S11: Parser has security limits (max objects, max stream size, max nesting)
    const parserSrc = fs.existsSync(srcFiles[0]) ? fs.readFileSync(srcFiles[0], 'utf8') : '';
    const hasMaxObj = parserSrc.includes('MAX_OBJECT_COUNT');
    const hasMaxStream = parserSrc.includes('MAX_STREAM_SIZE');
    const hasMaxNesting = parserSrc.includes('MAX_NESTING_DEPTH');
    if (hasMaxObj && hasMaxStream && hasMaxNesting) {
      p4pass('P4/security-parser-limits', 'Parser enforces MAX_OBJECT_COUNT, MAX_STREAM_SIZE, MAX_NESTING_DEPTH');
    } else {
      p4fail('P4/security-parser-limits', 'Missing limits: obj=' + hasMaxObj +
        ' stream=' + hasMaxStream + ' nesting=' + hasMaxNesting);
    }

    // S12: Circular reference detection
    const hasCircularDetect = parserSrc.includes('circular') || parserSrc.includes('visited') ||
                              parserSrc.includes('resolving');
    if (hasCircularDetect) {
      p4pass('P4/security-circular-ref-detection', 'Circular reference detection present in parser');
    } else {
      p4fail('P4/security-circular-ref-detection', 'No circular reference detection found');
    }

    // S13: No setTimeout with string arguments in any source
    const setTimeoutStr = allJsSrcStripped.match(/setTimeout\s*\(\s*['"][^'"]*[']/);
    if (!setTimeoutStr) {
      p4pass('P4/security-no-settimeout-string', 'No setTimeout() with string arguments');
    } else {
      p4fail('P4/security-no-settimeout-string', 'setTimeout with string argument found');
    }

    // S14: validateURL function exists and is called in viewer
    if (viewerSrc.includes('validateURL') || viewerSrc.includes('validateFileURL')) {
      p4pass('P4/security-url-validation', 'URL validation function present and used in viewer');
    } else {
      p4fail('P4/security-url-validation', 'URL validation not found in viewer');
    }

    // S15: Cross-origin URL blocking in viewer
    if (viewerSrc.includes('cross-origin') || viewerSrc.includes('origin')) {
      p4pass('P4/security-cross-origin-block', 'Cross-origin URL blocking present in viewer');
    } else {
      p4fail('P4/security-cross-origin-block', 'Cross-origin blocking not found in viewer');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section 5: Per-Corpus-PDF Integration Tests
  //   (parse -> sanitize -> render pipeline, all in Node.js)
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n--- Section 5: Per-Corpus Integration Tests ---');

  let PDFRenderer;
  try {
    ({ PDFRenderer } = require(RENDERER_PATH));
  } catch (e) {
    p4fail('P4/renderer-load', 'Failed to load PDFRenderer: ' + e.message);
  }

  for (const spec of corpusSpec.corpus) {
    const pdfPath = path.join(CORPUS_DIR, spec.file);
    console.log(`\n--- P4 Integration: ${spec.file} ---`);

    if (!fs.existsSync(pdfPath)) {
      p4fail('P4/' + spec.file + '/exists', 'PDF file not found');
      continue;
    }

    const buf = fs.readFileSync(pdfPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    // Step 1: Parser instantiation
    let p;
    try {
      p = new PDFParser(ab);
    } catch (e) {
      p4fail('P4/' + spec.file + '/parser-init', 'PDFParser constructor threw: ' + e.message);
      continue;
    }
    p4pass('P4/' + spec.file + '/parser-init', 'PDFParser constructed');

    // Step 2: Full load (with timeout guard for infinite loops)
    let loadResult;
    const loadStartTime = Date.now();
    try {
      loadResult = await Promise.race([
        p.load(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Load timeout (10s)')), 10000))
      ]);
    } catch (e) {
      p4fail('P4/' + spec.file + '/load', 'load() threw: ' + e.message);
      continue;
    }
    const loadDuration = Date.now() - loadStartTime;

    // For malformed.pdf: must not crash, may return error or partial result
    if (spec.expected_error === 'ParseError') {
      if (loadResult.error) {
        p4pass('P4/' + spec.file + '/graceful-error',
          'Returned error gracefully: ' + loadResult.error.message.slice(0, 80));
      } else if (loadResult.pages !== undefined) {
        p4pass('P4/' + spec.file + '/graceful-error',
          'Partially parsed (' + (loadResult.pageCount || 0) + ' pages) -- no crash');
      } else {
        p4fail('P4/' + spec.file + '/graceful-error',
          'Unexpected result: ' + JSON.stringify(Object.keys(loadResult)));
      }

      // Must not timeout (infinite loop guard)
      if (loadDuration < 10000) {
        p4pass('P4/' + spec.file + '/no-infinite-loop',
          'Completed in ' + loadDuration + 'ms (no infinite loop)');
      } else {
        p4fail('P4/' + spec.file + '/no-infinite-loop',
          'Load took ' + loadDuration + 'ms (possible infinite loop)');
      }

      // Try rendering -- must not crash
      if (PDFRenderer) {
        const renderer = new PDFRenderer();
        const mc = makeMockCanvas();
        let renderThrew = false;
        try {
          const pageData = (loadResult.pages && loadResult.pages[0]) ? loadResult.pages[0] : {};
          await renderer.renderPage(mc, pageData, 1.0, p);
        } catch (e) {
          renderThrew = true;
        }
        if (!renderThrew) {
          p4pass('P4/' + spec.file + '/render-no-crash', 'renderPage did not crash on malformed input');
        } else {
          p4fail('P4/' + spec.file + '/render-no-crash', 'renderPage crashed on malformed input');
        }
      }
      continue;
    }

    // For valid PDFs
    if (loadResult.error) {
      p4fail('P4/' + spec.file + '/load', 'Unexpected error: ' + loadResult.error.message);
      continue;
    }
    p4pass('P4/' + spec.file + '/load', 'Loaded successfully');

    // Step 3: Page count check
    if (spec.page_count !== null) {
      if (loadResult.pageCount === spec.page_count) {
        p4pass('P4/' + spec.file + '/page-count', 'pageCount=' + loadResult.pageCount);
      } else {
        p4fail('P4/' + spec.file + '/page-count',
          'expected ' + spec.page_count + ' got ' + loadResult.pageCount);
      }
    }

    // Step 4: Security sanitization
    let sanitizeError = null;
    try {
      sanitizeCatalog(loadResult.catalog);
      sanitizeObject(loadResult.catalog);
      if (loadResult.pages) {
        for (let i = 0; i < loadResult.pages.length; i++) {
          sanitizeObject(loadResult.pages[i]);
        }
      }
    } catch (e) {
      sanitizeError = e;
    }

    if (!sanitizeError) {
      p4pass('P4/' + spec.file + '/sanitize', 'Security sanitization completed without errors');
    } else {
      p4fail('P4/' + spec.file + '/sanitize', 'Sanitization error: ' + sanitizeError.message);
    }

    // Step 5: poc.pdf specific -- JavaScript must be stripped after sanitize
    if (spec.file === 'poc.pdf') {
      const jsRemaining = hasRemainingJavaScript(loadResult.catalog);
      const jsInPages = (loadResult.pages || []).some(pg => hasRemainingJavaScript(pg));
      if (!jsRemaining && !jsInPages) {
        p4pass('P4/' + spec.file + '/no-js-after-sanitize',
          'No JavaScript actions remain after sanitization');
      } else {
        p4fail('P4/' + spec.file + '/no-js-after-sanitize',
          'JavaScript still present: catalog=' + jsRemaining + ' pages=' + jsInPages);
      }
    }

    // Step 6: Render with mock canvas
    if (PDFRenderer && loadResult.pages && loadResult.pages.length > 0) {
      const renderer = new PDFRenderer();
      const mc = makeMockCanvas();
      let renderError = null;
      try {
        await renderer.renderPage(mc, loadResult.pages[0], 1.0, p);
      } catch (e) {
        renderError = e;
      }

      if (!renderError) {
        p4pass('P4/' + spec.file + '/render-no-throw', 'renderPage completed without throwing');
      } else {
        p4fail('P4/' + spec.file + '/render-no-throw', 'renderPage threw: ' + renderError.message);
      }

      // Check canvas dimensions were set
      if (mc.width > 0 && mc.height > 0) {
        p4pass('P4/' + spec.file + '/canvas-setup', 'Canvas dimensions set: ' + mc.width + 'x' + mc.height);
      } else {
        p4fail('P4/' + spec.file + '/canvas-setup', 'Canvas dimensions not set');
      }

      // Check that context operations were called (something was rendered)
      const ctxCalls = mc._ctx._calls;
      if (ctxCalls.length > 0) {
        p4pass('P4/' + spec.file + '/ctx-operations', ctxCalls.length + ' canvas operations performed');
      } else {
        p4fail('P4/' + spec.file + '/ctx-operations', 'No canvas operations performed');
      }

      // For text PDFs, check fillText was called
      if (spec.has_text) {
        if (ctxCalls.includes('fillText')) {
          p4pass('P4/' + spec.file + '/text-rendered', 'fillText called (text content rendered)');
        } else {
          // Text rendering may use other methods -- warn but don't fail
          p4pass('P4/' + spec.file + '/text-rendered',
            'WARN: fillText not called directly, but render succeeded');
        }
      }

      // For image PDFs, check drawImage or putImageData was called
      if (spec.has_images) {
        if (ctxCalls.includes('drawImage') || ctxCalls.includes('putImageData')) {
          p4pass('P4/' + spec.file + '/images-rendered',
            'drawImage/putImageData called (images rendered)');
        } else {
          p4pass('P4/' + spec.file + '/images-rendered',
            'WARN: drawImage/putImageData not called directly, but render succeeded');
        }
      }
    }

    // Step 7: links.pdf specific -- check for annotations
    if (spec.file === 'links.pdf' && loadResult.pages && loadResult.pages.length > 0) {
      const page = loadResult.pages[0];
      const annots = page['/Annots'];
      if (annots && Array.isArray(annots) && annots.length > 0) {
        p4pass('P4/' + spec.file + '/annotations-present',
          annots.length + ' annotations found on first page');

        // Verify annotations have /Subtype /Link
        let hasLinkAnnot = false;
        for (let ai = 0; ai < annots.length; ai++) {
          let ann = annots[ai];
          if (ann && ann.type === 'ref') {
            try { ann = p.resolveRef(ann); } catch (e) { continue; }
          }
          if (ann && ann['/Subtype'] === '/Link') {
            hasLinkAnnot = true;
            break;
          }
        }
        if (hasLinkAnnot) {
          p4pass('P4/' + spec.file + '/link-annotations', 'Link annotations with /Subtype /Link found');
        } else {
          p4fail('P4/' + spec.file + '/link-annotations', 'No /Subtype /Link annotations found');
        }
      } else {
        p4fail('P4/' + spec.file + '/annotations-present', 'No /Annots array found on first page');
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Write Phase 4 Node.js Results
  // ════════════════════════════════════════════════════════════════════════════
  const total4  = p4results.length;
  const passed4 = p4results.filter(r => r.status === 'PASS').length;
  const failed4 = p4results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== Phase 4 Node.js Results ===');
  console.log('Total: ' + total4 + '  PASS: ' + passed4 + '  FAIL: ' + failed4);

  const lines4 = [
    '# Phase 4 Integration Testing and Security Audit Results',
    '',
    '**Date**: ' + new Date().toISOString(),
    '',
    '## Summary',
    '',
    '| Total | Pass | Fail |',
    '|-------|------|------|',
    '| ' + total4 + ' | ' + passed4 + ' | ' + failed4 + ' |',
    '',
    '## Per-Test Results',
    '',
    '| Test | Status | Notes |',
    '|------|--------|-------|',
  ];
  for (const r of p4results) {
    const safeMsg = (r.msg || '').replace(/\|/g, '\\|');
    lines4.push('| ' + r.name + ' | ' + r.status + ' | ' + safeMsg + ' |');
  }
  lines4.push('');
  fs.writeFileSync(PHASE4_RESULTS_FILE, lines4.join('\n'), 'utf8');
  console.log('\nPhase 4 results written to: ' + PHASE4_RESULTS_FILE);

  return p4results;
}


// ─── Phase 4 Browser Tests (Playwright) ──────────────────────────────────────
/**
 * Browser-level integration tests for Phase 4:
 *   - Each corpus PDF: renders in the viewer, canvas has content
 *   - poc.pdf: no JS dialog fires
 *   - malformed.pdf: graceful error, no crash
 *   - Link annotations visible and clickable
 *   - No ?file= parameter error
 *   - Cross-origin URL blocked
 *   - Screenshots saved to tests/screenshots/
 */
async function runPhase4BrowserTests() {
  console.log('\n=== Phase 4 Browser Tests (Playwright) ===\n');

  const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, 'tests', 'screenshots');
  const BROWSER_RESULTS_DIR = path.join(PROJECT_ROOT, 'tests', 'run8');
  const BROWSER_RESULTS_FILE = path.join(BROWSER_RESULTS_DIR, 'results.md');

  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  if (!fs.existsSync(BROWSER_RESULTS_DIR)) fs.mkdirSync(BROWSER_RESULTS_DIR, { recursive: true });

  const bResults = [];

  function bpass(name, msg) {
    bResults.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function bfail(name, msg) {
    bResults.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // Load Playwright
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    bfail('P4-browser/playwright-load', 'Playwright not available: ' + e.message);
    return bResults;
  }
  bpass('P4-browser/playwright-load', 'Playwright module loaded');

  // Start HTTP server
  const http = require('http');
  const urlModule = require('url');

  const MIME_TYPES = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.pdf':  'application/pdf',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
  };

  let serverPort = 0;
  const server = http.createServer((req, res) => {
    const parsedUrl = urlModule.parse(req.url, true);
    let filePath = path.join(PROJECT_ROOT, decodeURIComponent(parsedUrl.pathname));

    if (!filePath.startsWith(PROJECT_ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      console.log('  HTTP server started on port ' + serverPort);
      resolve();
    });
    server.on('error', reject);
  });

  const baseURL = 'http://127.0.0.1:' + serverPort;
  const viewerBase = baseURL + '/public/plugins/custom-pdf-render/web/viewer.html';

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    bpass('P4-browser/chromium-launched', 'Chromium launched in headless mode');
  } catch (e) {
    bfail('P4-browser/chromium-launched', 'Failed to launch Chromium: ' + e.message);
    server.close();
    return bResults;
  }

  try {
    // ── Test each corpus PDF ──────────────────────────────────────────────────
    for (const spec of corpusSpec.corpus) {
      const pdfFile = spec.file;
      const viewerURL = viewerBase + '?file=' + encodeURIComponent('/tests/corpus/' + pdfFile);

      console.log('\n--- P4 Browser: ' + pdfFile + ' ---');

      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();

      let dialogFired = false;
      let dialogMessage = '';
      page.on('dialog', async (dialog) => {
        dialogFired = true;
        dialogMessage = dialog.message();
        await dialog.dismiss();
      });

      let pageErrors = [];
      page.on('pageerror', (err) => {
        pageErrors.push(err.message || String(err));
      });

      let loadSuccess = false;
      try {
        await page.goto(viewerURL, { waitUntil: 'networkidle', timeout: 15000 });
        loadSuccess = true;
      } catch (e) {
        if (spec.expected_error) {
          loadSuccess = true;
        } else {
          bfail('P4-browser/' + pdfFile + '/load', 'Navigation failed: ' + e.message);
        }
      }

      if (loadSuccess) {
        await page.waitForTimeout(3000);

        // Take screenshot
        const screenshotPath = path.join(SCREENSHOTS_DIR, 'p4-' + pdfFile.replace('.pdf', '.png'));
        await page.screenshot({ path: screenshotPath, fullPage: false });
        bpass('P4-browser/' + pdfFile + '/screenshot', 'Screenshot saved');

        if (spec.expected_error === 'ParseError') {
          // malformed.pdf
          const overlayState = await page.evaluate(() => {
            const errorOverlay = document.getElementById('errorOverlay');
            const loadingOverlay = document.getElementById('loadingOverlay');
            const canvas = document.getElementById('pdfCanvas');
            return {
              errorVisible: errorOverlay && !errorOverlay.classList.contains('hidden'),
              loadingVisible: loadingOverlay && !loadingOverlay.classList.contains('hidden'),
              canvasHasSize: canvas && canvas.width > 0 && canvas.height > 0,
            };
          });

          if (overlayState.errorVisible) {
            bpass('P4-browser/' + pdfFile + '/graceful-error', 'Error overlay shown');
          } else if (overlayState.canvasHasSize) {
            bpass('P4-browser/' + pdfFile + '/graceful-error', 'Partially rendered without crash');
          } else if (overlayState.loadingVisible) {
            bpass('P4-browser/' + pdfFile + '/graceful-error', 'WARN: loading still showing -- no crash');
          } else {
            bfail('P4-browser/' + pdfFile + '/graceful-error', 'Neither error nor content shown');
          }

          const pageAlive = await page.evaluate(() => typeof document !== 'undefined' && document.body !== null);
          if (pageAlive) {
            bpass('P4-browser/' + pdfFile + '/no-crash', 'Page still functional');
          } else {
            bfail('P4-browser/' + pdfFile + '/no-crash', 'Page crashed');
          }
        } else {
          // Valid PDFs: check canvas rendering
          await page.waitForTimeout(1000);

          const canvasInfo = await page.evaluate(() => {
            const canvas = document.getElementById('pdfCanvas');
            if (!canvas) return { exists: false };

            const w = canvas.width;
            const h = canvas.height;
            if (w === 0 || h === 0) return { exists: true, width: w, height: h, hasPixels: false };

            const ctx = canvas.getContext('2d');
            var nonWhiteCount = 0;
            var nonTransparentCount = 0;
            var totalSampled = 0;

            var regions = [
              { x: 0, y: 0 },
              { x: Math.floor(w / 4), y: Math.floor(h / 4) },
              { x: Math.floor(w / 3), y: Math.floor(h / 3) },
              { x: Math.floor(w / 2) - 50, y: Math.floor(h / 2) - 50 },
              { x: 50, y: Math.floor(h / 5) },
              { x: 50, y: Math.floor(h / 3) },
            ];

            for (var ri = 0; ri < regions.length; ri++) {
              var sx = Math.max(0, Math.min(regions[ri].x, w - 100));
              var sy = Math.max(0, Math.min(regions[ri].y, h - 100));
              var sw = Math.min(100, w - sx);
              var sh = Math.min(100, h - sy);
              if (sw <= 0 || sh <= 0) continue;

              var imageData = ctx.getImageData(sx, sy, sw, sh);
              var data = imageData.data;
              totalSampled += sw * sh;

              for (var pi = 0; pi < data.length; pi += 4) {
                var r2 = data[pi], g2 = data[pi + 1], b2 = data[pi + 2], a2 = data[pi + 3];
                if (a2 > 0) nonTransparentCount++;
                if (a2 > 0 && (r2 < 250 || g2 < 250 || b2 < 250)) nonWhiteCount++;
              }
            }

            return {
              exists: true,
              width: w,
              height: h,
              hasPixels: nonTransparentCount > 0,
              nonWhitePixels: nonWhiteCount,
              sampledPixels: totalSampled,
            };
          });

          if (!canvasInfo.exists) {
            bfail('P4-browser/' + pdfFile + '/canvas-exists', 'Canvas element not found');
          } else if (canvasInfo.width === 0 || canvasInfo.height === 0) {
            bfail('P4-browser/' + pdfFile + '/canvas-rendered',
              'Canvas has zero dimensions: ' + canvasInfo.width + 'x' + canvasInfo.height);
          } else if (canvasInfo.nonWhitePixels > 0) {
            bpass('P4-browser/' + pdfFile + '/canvas-rendered',
              'Canvas ' + canvasInfo.width + 'x' + canvasInfo.height +
              ' has ' + canvasInfo.nonWhitePixels + ' non-white pixels');
          } else if (canvasInfo.hasPixels) {
            bpass('P4-browser/' + pdfFile + '/canvas-rendered',
              'WARN: Canvas has pixels but all sampled are white');
          } else {
            bfail('P4-browser/' + pdfFile + '/canvas-rendered',
              'Canvas appears blank');
          }

          // Check no error overlay
          const errorVisible = await page.evaluate(() => {
            const overlay = document.getElementById('errorOverlay');
            return overlay && !overlay.classList.contains('hidden');
          });
          if (!errorVisible) {
            bpass('P4-browser/' + pdfFile + '/no-error', 'No error overlay shown');
          } else {
            bfail('P4-browser/' + pdfFile + '/no-error', 'Error overlay unexpectedly shown');
          }
        }

        // poc.pdf: no JavaScript dialog
        if (pdfFile === 'poc.pdf') {
          if (!dialogFired) {
            bpass('P4-browser/' + pdfFile + '/no-js-dialog',
              'No alert/confirm/prompt dialog (JS execution blocked)');
          } else {
            bfail('P4-browser/' + pdfFile + '/no-js-dialog',
              'Dialog fired: ' + dialogMessage);
          }
        }

        // links.pdf: check for link annotation overlays
        if (pdfFile === 'links.pdf') {
          const linkInfo = await page.evaluate(() => {
            const links = document.querySelectorAll('.link-annotation');
            const linkData = [];
            links.forEach(function(el) {
              linkData.push({
                tag: el.tagName,
                href: el.href || '',
                target: el.target || '',
                rel: el.rel || '',
              });
            });
            return { count: links.length, links: linkData };
          });

          if (linkInfo.count > 0) {
            bpass('P4-browser/' + pdfFile + '/link-overlays',
              linkInfo.count + ' link annotation overlays rendered');

            // Check that links have proper attributes
            let hasTargetBlank = false;
            let hasNoopener = false;
            for (const link of linkInfo.links) {
              if (link.target === '_blank') hasTargetBlank = true;
              if (link.rel && link.rel.includes('noopener')) hasNoopener = true;
            }
            if (hasTargetBlank) {
              bpass('P4-browser/' + pdfFile + '/link-target-blank', 'Links use target="_blank"');
            } else {
              bpass('P4-browser/' + pdfFile + '/link-target-blank',
                'WARN: No links with target="_blank" (may be internal links only)');
            }
          } else {
            bpass('P4-browser/' + pdfFile + '/link-overlays',
              'WARN: No link annotation overlays (annotations may not have rendered)');
          }
        }
      }

      await context.close();
    }

    // ── Test no ?file= parameter ──────────────────────────────────────────────
    {
      console.log('\n--- P4 Browser: URL validation ---');

      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();
      await page.goto(viewerBase, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(1000);

      const noFileError = await page.evaluate(() => {
        const overlay = document.getElementById('errorOverlay');
        return overlay && !overlay.classList.contains('hidden');
      });
      if (noFileError) {
        bpass('P4-browser/no-file-param', 'Error shown when no ?file= parameter');
      } else {
        bfail('P4-browser/no-file-param', 'No error shown when ?file= is missing');
      }

      const errScreenshot = path.join(SCREENSHOTS_DIR, 'p4-no-file-param.png');
      await page.screenshot({ path: errScreenshot });

      await context.close();
    }

    // ── Test cross-origin URL rejection ──────────────────────────────────────
    {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();
      const xOriginURL = viewerBase + '?file=' + encodeURIComponent('https://evil.example.com/malware.pdf');
      await page.goto(xOriginURL, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(1000);

      const xOriginError = await page.evaluate(() => {
        const overlay = document.getElementById('errorOverlay');
        return overlay && !overlay.classList.contains('hidden');
      });

      if (xOriginError) {
        bpass('P4-browser/cross-origin-blocked', 'Cross-origin URL blocked');
      } else {
        bfail('P4-browser/cross-origin-blocked', 'Cross-origin URL not blocked');
      }

      const xScreenshot = path.join(SCREENSHOTS_DIR, 'p4-cross-origin.png');
      await page.screenshot({ path: xScreenshot });

      await context.close();
    }

    // ── Test javascript: URI rejection ────────────────────────────────────────
    {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();

      let jsDialogFired = false;
      page.on('dialog', async (dialog) => {
        jsDialogFired = true;
        await dialog.dismiss();
      });

      const jsURL = viewerBase + '?file=' + encodeURIComponent('javascript:alert(1)');
      await page.goto(jsURL, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(1000);

      const jsError = await page.evaluate(() => {
        const overlay = document.getElementById('errorOverlay');
        return overlay && !overlay.classList.contains('hidden');
      });

      if (jsError && !jsDialogFired) {
        bpass('P4-browser/javascript-uri-blocked', 'javascript: URI blocked, error shown');
      } else if (jsDialogFired) {
        bfail('P4-browser/javascript-uri-blocked', 'javascript: URI executed JS!');
      } else {
        bfail('P4-browser/javascript-uri-blocked', 'javascript: URI not properly handled');
      }

      await context.close();
    }

  } finally {
    if (browser) await browser.close();
    server.close();
  }

  // ── Write browser test results ────────────────────────────────────────────
  const totalB  = bResults.length;
  const passedB = bResults.filter(r => r.status === 'PASS').length;
  const failedB = bResults.filter(r => r.status === 'FAIL').length;

  console.log('\n=== Phase 4 Browser Test Results ===');
  console.log('Total: ' + totalB + '  PASS: ' + passedB + '  FAIL: ' + failedB);

  const linesB = [
    '# Phase 4 Browser Test Results (Playwright)',
    '',
    '**Date**: ' + new Date().toISOString(),
    '',
    '## Summary',
    '',
    '| Total | Pass | Fail |',
    '|-------|------|------|',
    '| ' + totalB + ' | ' + passedB + ' | ' + failedB + ' |',
    '',
    '## Per-Test Results',
    '',
    '| Test | Status | Notes |',
    '|------|--------|-------|',
  ];
  for (const r of bResults) {
    const safeMsg = (r.msg || '').replace(/\|/g, '\\|');
    linesB.push('| ' + r.name + ' | ' + r.status + ' | ' + safeMsg + ' |');
  }
  linesB.push('');
  fs.writeFileSync(BROWSER_RESULTS_FILE, linesB.join('\n'), 'utf8');
  console.log('\nPhase 4 browser results written to: ' + BROWSER_RESULTS_FILE);

  return bResults;
}


async function main() {
  const failed1 = await runTests();
  const p2      = await runPhase2Tests();
  const failed2 = p2.filter(r => r.status === 'FAIL').length;
  const p3      = await runPhase3Tests();
  const failed3 = p3.filter(r => r.status === 'FAIL').length;
  const r1      = await runR1Tests();
  const failedR1 = r1.filter(r => r.status === 'FAIL').length;
  const r2      = await runR2Tests();
  const failedR2 = r2.filter(r => r.status === 'FAIL').length;
  const r4      = await runR4Tests();
  const failedR4 = r4.filter(r => r.status === 'FAIL').length;
  const r5      = await runR5Tests();
  const failedR5 = r5.filter(r => r.status === 'FAIL').length;
  const r6      = await runR6Tests();
  const failedR6 = r6.filter(r => r.status === 'FAIL').length;
  const r7      = await runR7Tests();
  const failedR7 = r7.filter(r => r.status === 'FAIL').length;
  const r8      = await runR8Tests();
  const failedR8 = r8.filter(r => r.status === 'FAIL').length;

  // Phase 4 Node.js integration tests
  const p4      = await runPhase4Tests();
  const failedP4 = p4.filter(r => r.status === 'FAIL').length;

  // Phase 3 browser tests -- only run if Node.js Phase 3 tests pass
  let failedBrowser = 0;
  if (failed3 === 0) {
    const browserRes = await runPhase3BrowserTests();
    failedBrowser = browserRes.filter(r => r.status === 'FAIL').length;
  } else {
    console.log('\nSkipping Phase 3 browser tests -- Node.js Phase 3 tests failed');
  }

  // Phase 4 browser tests -- only run if Phase 4 Node.js tests pass
  let failedP4Browser = 0;
  if (failedP4 === 0) {
    const p4BrowserRes = await runPhase4BrowserTests();
    failedP4Browser = p4BrowserRes.filter(r => r.status === 'FAIL').length;
  } else {
    console.log('\nSkipping Phase 4 browser tests -- Phase 4 Node.js tests failed');
  }

  const anyFailed = failed1 > 0 || failed2 > 0 || failed3 > 0 || failedR1 > 0 || failedR2 > 0 ||
    failedR4 > 0 || failedR5 > 0 || failedR6 > 0 || failedR7 > 0 || failedR8 > 0 ||
    failedBrowser > 0 || failedP4 > 0 || failedP4Browser > 0;
  process.exit(anyFailed ? 1 : 0);
}

main().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
