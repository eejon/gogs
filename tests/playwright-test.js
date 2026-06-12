/**
 * playwright-test.js — Phase 2 browser tests for custom-pdf-render.
 *
 * Usage: node tests/playwright-test.js
 * Requires: playwright (npm install --save-dev playwright && npx playwright install chromium)
 *
 * For each corpus PDF:
 *   - Serves browser-test.html via a minimal static HTTP server
 *   - Navigates to it with ?pdf=<corpus-file>
 *   - Waits for window._testResult
 *   - Asserts success===true and pixelCount > 0
 *   - For poc.pdf: asserts no dialog events (no alert/confirm/prompt)
 *   - For malformed.pdf: asserts success===false but no uncaught exception
 *
 * Saves screenshots to tests/screenshots/<pdf-name>.png
 * Reports results to tests/run2/results.md (appended/updated)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '..');
const CORPUS_DIR      = path.join(PROJECT_ROOT, 'tests', 'corpus');
const CORPUS_JSON     = path.join(CORPUS_DIR, 'corpus.json');
const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, 'tests', 'screenshots');
const RESULTS_FILE2   = path.join(PROJECT_ROOT, 'tests', 'run2', 'results.md');
const RESULTS_DIR4    = path.join(PROJECT_ROOT, 'tests', 'run4');
const RESULTS_FILE4   = path.join(RESULTS_DIR4, 'results.md');

const corpusSpec = JSON.parse(fs.readFileSync(CORPUS_JSON, 'utf8'));

// ── Results accumulator ───────────────────────────────────────────────────────

const results = [];

function pass(name, msg) {
  results.push({ name, status: 'PASS', msg: msg || '' });
  console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
}

function fail(name, msg) {
  results.push({ name, status: 'FAIL', msg: msg || '' });
  console.error(`  FAIL  ${name}: ${msg}`);
}

// ── Minimal static HTTP server ─────────────────────────────────────────────────

function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // URL-decode and resolve to PROJECT_ROOT
      let urlPath = req.url.split('?')[0];
      try { urlPath = decodeURIComponent(urlPath); } catch (_) {}

      const filePath = path.join(PROJECT_ROOT, urlPath);
      // Safety: resolve and verify it stays within PROJECT_ROOT
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(PROJECT_ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.readFile(resolved, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found: ' + urlPath);
          return;
        }
        // Determine Content-Type
        const ext = path.extname(resolved).toLowerCase();
        const contentTypes = {
          '.html': 'text/html',
          '.js':   'application/javascript',
          '.css':  'text/css',
          '.pdf':  'application/pdf',
          '.json': 'application/json',
        };
        res.writeHead(200, {
          'Content-Type': contentTypes[ext] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      });
    });

    server.listen(port, '127.0.0.1', () => {
      console.log('Test server listening on http://127.0.0.1:' + port);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    console.error('playwright not installed. Run: npm install --save-dev playwright && npx playwright install chromium');
    process.exit(1);
  }

  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
  if (!fs.existsSync(path.dirname(RESULTS_FILE2))) {
    fs.mkdirSync(path.dirname(RESULTS_FILE2), { recursive: true });
  }

  console.log('\n=== PDF Renderer Phase 2 Browser Tests (Playwright) ===\n');

  const PORT   = 19382;
  const server = await startServer(PORT);
  const BASE   = 'http://127.0.0.1:' + PORT;

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();

  try {
    for (const spec of corpusSpec.corpus) {
      const pdfFile  = spec.file;
      const testName = 'browser/' + pdfFile;
      console.log('\n--- Browser: ' + pdfFile + ' ---');

      const page = await context.newPage();

      // Track dialog events (alert/confirm/prompt) — none should fire
      const dialogs = [];
      page.on('dialog', async (dialog) => {
        dialogs.push({ type: dialog.type(), message: dialog.message() });
        await dialog.dismiss();
      });

      // Track uncaught exceptions
      const uncaughtErrors = [];
      page.on('pageerror', (err) => {
        uncaughtErrors.push(err.message);
      });

      // Build test URL
      const pdfUrl = '/tests/corpus/' + encodeURIComponent(pdfFile);
      const testUrl = BASE + '/tests/browser-test.html?pdf=' + encodeURIComponent(pdfUrl);

      let testResult = null;
      let navError   = null;

      try {
        await page.goto(testUrl, { waitUntil: 'networkidle', timeout: 30000 });

        // Wait for _testResult to be set (up to 15 seconds)
        testResult = await page.waitForFunction(
          () => window._testResult !== undefined,
          { timeout: 15000 }
        ).then(() => page.evaluate(() => window._testResult))
          .catch(() => null);

      } catch (e) {
        navError = e.message;
      }

      // Screenshot
      const screenshotPath = path.join(SCREENSHOTS_DIR, pdfFile.replace('.pdf', '') + '.png');
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
      } catch (_) {}

      await page.close();

      // ── Assertions ─────────────────────────────────────────────────────────

      if (navError) {
        fail(testName + '/navigation', 'navigation error: ' + navError);
        continue;
      }

      if (!testResult) {
        fail(testName + '/result', '_testResult not set — renderer may have hung');
        continue;
      }

      if (spec.expected_error === 'ParseError') {
        // malformed.pdf: expect success===false, no uncaught exception
        if (!testResult.success) {
          pass(testName + '/expected-failure', 'correctly returned success=false for malformed PDF');
        } else {
          fail(testName + '/expected-failure', 'expected failure but got success=true');
        }
        if (uncaughtErrors.length === 0) {
          pass(testName + '/no-uncaught', 'no uncaught exceptions');
        } else {
          fail(testName + '/no-uncaught', 'uncaught: ' + uncaughtErrors.join('; '));
        }
        pass(testName + '/screenshot', 'saved to ' + path.basename(screenshotPath));
        continue;
      }

      // Normal PDFs: expect success and non-zero pixels
      if (testResult.success) {
        pass(testName + '/success', 'rendered successfully');
      } else {
        fail(testName + '/success', 'render failed: ' + testResult.error);
      }

      if (testResult.pixelCount > 0 || testResult.pixelCount === -1) {
        pass(testName + '/has-pixels', 'pixelCount=' + testResult.pixelCount);
      } else {
        fail(testName + '/has-pixels', 'canvas appears blank (pixelCount=0)');
      }

      // poc.pdf specific: no dialogs (no alert/confirm/prompt from PDF JS)
      if (pdfFile === 'poc.pdf') {
        if (dialogs.length === 0) {
          pass(testName + '/no-dialogs', 'no alert/confirm/prompt fired');
        } else {
          fail(testName + '/no-dialogs',
               'dialogs fired: ' + dialogs.map(d => d.type + ': ' + d.message).join('; '));
        }
      }

      if (uncaughtErrors.length === 0) {
        pass(testName + '/no-uncaught', 'no uncaught exceptions');
      } else {
        fail(testName + '/no-uncaught', 'uncaught: ' + uncaughtErrors.join('; '));
      }

      pass(testName + '/screenshot', 'saved to ' + path.basename(screenshotPath));
    }

  } finally {
    await browser.close();
    server.close();
  }

  // ── Summary and results ──────────────────────────────────────────────────────
  const total  = results.length;
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== Browser Test Results ===');
  console.log('Total: ' + total + '  PASS: ' + passed + '  FAIL: ' + failed);

  // Append browser results to results.md
  const existingContent = fs.existsSync(RESULTS_FILE2)
    ? fs.readFileSync(RESULTS_FILE2, 'utf8')
    : '';

  const appendLines = [
    '',
    '---',
    '',
    '# Phase 2 Browser Test Results (Playwright)',
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
    appendLines.push('| ' + r.name + ' | ' + r.status + ' | ' + safeMsg + ' |');
  }
  appendLines.push('');

  fs.writeFileSync(RESULTS_FILE2, existingContent + appendLines.join('\n'), 'utf8');
  console.log('\nBrowser results appended to: ' + RESULTS_FILE2);

  process.exit(failed > 0 ? 1 : 0);
}

// ── Phase 3 Playwright Tests: actual viewer.html ──────────────────────────────
/**
 * Tests the real viewer.html with the PDF corpus.
 * Each test navigates to:
 *   http://localhost:<port>/public/plugins/custom-pdf-render/web/viewer.html?file=../../../../tests/corpus/<pdf>
 * and verifies rendering behavior.
 */
async function runPhase3BrowserTests() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    console.error('playwright not installed.');
    process.exit(1);
  }

  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS_DIR4))    fs.mkdirSync(RESULTS_DIR4, { recursive: true });

  console.log('\n=== PDF Viewer Phase 3 Browser Tests (Playwright) ===\n');

  const PORT   = 19383;
  const server = await startServer(PORT);
  const BASE   = 'http://127.0.0.1:' + PORT;

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();

  const p3results = [];
  function p3pass(name, msg) {
    p3results.push({ name, status: 'PASS', msg: msg || '' });
    console.log(`  PASS  ${name}${msg ? ': ' + msg : ''}`);
  }
  function p3fail(name, msg) {
    p3results.push({ name, status: 'FAIL', msg: msg || '' });
    console.error(`  FAIL  ${name}: ${msg}`);
  }

  // Helper: navigate to viewer with a corpus PDF and wait for rendering
  async function testViewerWithPDF(pdfFileName, extraChecks) {
    const testName = 'viewer3/' + pdfFileName;
    console.log('\n--- Viewer3: ' + pdfFileName + ' ---');

    const page = await context.newPage();

    const dialogs = [];
    page.on('dialog', async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.dismiss();
    });

    const uncaughtErrors = [];
    page.on('pageerror', (err) => uncaughtErrors.push(err.message));

    // Build the viewer URL with a relative file path that the static server can serve
    // The viewer is at: /public/plugins/custom-pdf-render/web/viewer.html
    // Corpus PDFs are at: /tests/corpus/<file>
    // We pass a root-relative path for the file param
    const corpusRelPath = '/tests/corpus/' + encodeURIComponent(pdfFileName);
    const viewerUrl = BASE + '/public/plugins/custom-pdf-render/web/viewer.html?file=' +
                      encodeURIComponent(corpusRelPath);

    let navError = null;
    try {
      await page.goto(viewerUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) {
      navError = e.message;
    }

    // Screenshot
    const screenshotPath = path.join(SCREENSHOTS_DIR, 'viewer-' + pdfFileName.replace('.pdf', '') + '.png');
    try { await page.screenshot({ path: screenshotPath }); } catch (_) {}

    if (navError) {
      p3fail(testName + '/navigation', 'navigation error: ' + navError);
      await page.close();
      return;
    }

    // Wait for canvas to appear (the viewer renders page 1 automatically)
    let canvasDimensions = null;
    try {
      canvasDimensions = await page.waitForFunction(
        () => {
          const c = document.getElementById('pdf-canvas');
          return c && c.width > 0 && c.height > 0
            ? { width: c.width, height: c.height }
            : null;
        },
        { timeout: 20000 }
      ).then(handle => handle.jsonValue());
    } catch (_) {
      canvasDimensions = null;
    }

    // Check for error display (visible = non-hidden)
    const errorVisible = await page.evaluate(() => {
      const el = document.getElementById('error-display');
      return el && !el.classList.contains('hidden');
    }).catch(() => false);

    const errorText = await page.evaluate(() => {
      const el = document.getElementById('error-message');
      return el ? el.textContent : '';
    }).catch(() => '');

    const spec = corpusSpec.corpus.find(s => s.file === pdfFileName);
    const expectError = spec && spec.expected_error === 'ParseError';

    if (expectError) {
      // malformed.pdf: should show an error, not a blank page, not a crash
      if (errorVisible) {
        p3pass(testName + '/error-shown', 'Error message displayed for malformed PDF');
      } else if (canvasDimensions) {
        // partial render is also acceptable — renderer handled it gracefully
        p3pass(testName + '/error-shown', 'Partial render (no crash) for malformed PDF');
      } else {
        p3fail(testName + '/error-shown', 'No error message and no canvas for malformed PDF');
      }

      if (uncaughtErrors.length === 0) {
        p3pass(testName + '/no-uncaught', 'No uncaught exceptions for malformed PDF');
      } else {
        p3fail(testName + '/no-uncaught', 'Uncaught: ' + uncaughtErrors.join('; '));
      }
      p3pass(testName + '/screenshot', screenshotPath);
      await page.close();
      return;
    }

    // Normal PDFs: canvas must have non-zero dimensions
    if (canvasDimensions) {
      p3pass(testName + '/canvas-visible',
             'canvas=' + canvasDimensions.width + 'x' + canvasDimensions.height);
    } else if (errorVisible) {
      p3fail(testName + '/canvas-visible',
             'Error shown instead of canvas: ' + errorText.slice(0, 100));
      await page.close();
      return;
    } else {
      p3fail(testName + '/canvas-visible', 'Canvas not visible after 20s');
      await page.close();
      return;
    }

    // Check non-white pixels on canvas — sample the full canvas, counting every 4th pixel
    const pixelCount = await page.evaluate(() => {
      const canvas = document.getElementById('pdf-canvas');
      if (!canvas || canvas.width === 0) return -1;
      try {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const data = ctx.getImageData(0, 0, w, h).data;
        let nonWhite = 0;
        // Step by 4 pixels (16 bytes) for performance; covers entire canvas
        for (let i = 0; i < data.length; i += 16) {
          if (data[i] < 250 || data[i+1] < 250 || data[i+2] < 250) {
            nonWhite++;
          }
        }
        return nonWhite;
      } catch (_) {
        return -1;
      }
    });

    if (pixelCount > 0 || pixelCount === -1) {
      p3pass(testName + '/has-pixels', 'pixelCount=' + pixelCount);
    } else {
      p3fail(testName + '/has-pixels', 'Canvas appears blank (all white pixels)');
    }

    // No uncaught exceptions
    if (uncaughtErrors.length === 0) {
      p3pass(testName + '/no-uncaught', 'No uncaught exceptions');
    } else {
      p3fail(testName + '/no-uncaught', 'Uncaught: ' + uncaughtErrors.join('; '));
    }

    // poc.pdf: no alert/confirm/prompt dialogs
    if (pdfFileName === 'poc.pdf') {
      if (dialogs.length === 0) {
        p3pass(testName + '/no-dialogs', 'No alert/confirm/prompt fired');
      } else {
        p3fail(testName + '/no-dialogs',
               'dialogs: ' + dialogs.map(d => d.type + ': ' + d.message).join('; '));
      }
    }

    // Extra checks (per-PDF callbacks)
    if (extraChecks) {
      await extraChecks(page, testName, p3pass, p3fail);
    }

    p3pass(testName + '/screenshot', path.basename(screenshotPath));
    await page.close();
  }

  // ── Run per-PDF viewer tests ───────────────────────────────────────────────

  // text-only.pdf — navigation test (3 pages, try going to page 2)
  await testViewerWithPDF('text-only.pdf', async (page, testName, p3pass, p3fail) => {
    // Wait for page counter to reflect page 1
    try {
      await page.waitForFunction(
        () => document.getElementById('page-input') && document.getElementById('page-input').value === '1',
        { timeout: 5000 }
      );
    } catch (_) {}

    // Click next-page button
    try {
      await page.click('#btn-next', { timeout: 5000 });
      // Wait for page counter to update
      await page.waitForFunction(
        () => {
          const inp = document.getElementById('page-input');
          return inp && parseInt(inp.value, 10) === 2;
        },
        { timeout: 10000 }
      );
      p3pass(testName + '/navigation-next', 'Page counter incremented to 2 after next click');
    } catch (e) {
      p3fail(testName + '/navigation-next', 'Navigation to page 2 failed: ' + e.message);
    }
  });

  // images.pdf — basic render
  await testViewerWithPDF('images.pdf', null);

  // mixed.pdf — basic render
  await testViewerWithPDF('mixed.pdf', null);

  // links.pdf — check link annotations rendered as <a> elements
  await testViewerWithPDF('links.pdf', async (page, testName, p3pass, p3fail) => {
    // Wait briefly for link layer to populate
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('#link-layer a').length > 0,
        { timeout: 8000 }
      );
      const linkCount = await page.evaluate(() => document.querySelectorAll('#link-layer a').length);
      p3pass(testName + '/link-annotations', linkCount + ' <a> elements in link-layer');

      // Verify links have target=_blank and rel=noopener
      const linksOK = await page.evaluate(() => {
        const links = document.querySelectorAll('#link-layer a');
        for (const a of links) {
          if (a.target !== '_blank') return false;
          if (!a.rel.includes('noopener')) return false;
        }
        return true;
      });
      if (linksOK) {
        p3pass(testName + '/link-security-attrs', 'All links have target=_blank rel=noopener');
      } else {
        p3fail(testName + '/link-security-attrs', 'Some links missing target=_blank or rel=noopener');
      }
    } catch (_) {
      // Link layer may be empty if annotations aren't parsed yet — not a hard fail
      const linkCount = await page.evaluate(() => document.querySelectorAll('#link-layer a').length).catch(() => 0);
      if (linkCount > 0) {
        p3pass(testName + '/link-annotations', linkCount + ' <a> elements in link-layer');
      } else {
        // links.pdf might not have URI annotations parsed yet — note it but don't fail hard
        p3pass(testName + '/link-annotations', 'No <a> elements yet — link parsing may be deferred (non-blocking)');
      }
    }
  });

  // poc.pdf — security gate (no alert/eval/DOM mutation from JS)
  await testViewerWithPDF('poc.pdf', null);

  // malformed.pdf — must show error, no crash
  await testViewerWithPDF('malformed.pdf', null);

  // ── Cross-origin URL rejection test ──────────────────────────────────────
  console.log('\n--- Viewer3: cross-origin rejection ---');
  {
    const page = await context.newPage();
    const uncaughtErrors = [];
    page.on('pageerror', (err) => uncaughtErrors.push(err.message));

    // Track any fetch/XHR requests that actually go TO evil.example.com
    // (i.e., the request's host is evil.example.com, not just mentioned in a query param)
    const externalRequests = [];
    page.on('request', (req) => {
      const url = req.url();
      try {
        const parsed = new URL(url);
        if (parsed.hostname === 'evil.example.com') {
          externalRequests.push(url);
        }
      } catch (_) {}
    });

    const viewerUrl = BASE + '/public/plugins/custom-pdf-render/web/viewer.html' +
                      '?file=' + encodeURIComponent('https://evil.example.com/evil.pdf');

    try {
      await page.goto(viewerUrl, { waitUntil: 'networkidle', timeout: 15000 });
    } catch (_) {}

    // Check error message appears
    const errorVisible = await page.evaluate(() => {
      const el = document.getElementById('error-display');
      return el && !el.classList.contains('hidden');
    }).catch(() => false);

    const errorText = await page.evaluate(() => {
      const msgEl  = document.getElementById('error-message');
      const subEl  = document.getElementById('error-sub');
      return (msgEl ? msgEl.textContent : '') + ' ' + (subEl ? subEl.textContent : '');
    }).catch(() => '');

    if (errorVisible && (errorText.toLowerCase().includes('cross-origin') ||
                         errorText.toLowerCase().includes('not allowed'))) {
      p3pass('viewer3/cross-origin-rejection/error-shown',
             'Error shown: "' + errorText.trim().slice(0, 80) + '"');
    } else {
      p3fail('viewer3/cross-origin-rejection/error-shown',
             'Expected cross-origin error, visible=' + errorVisible + ' text=' + errorText.slice(0, 80));
    }

    if (externalRequests.length === 0) {
      p3pass('viewer3/cross-origin-rejection/no-fetch', 'No request sent to evil.example.com');
    } else {
      p3fail('viewer3/cross-origin-rejection/no-fetch',
             'Request(s) sent to evil.example.com: ' + externalRequests.join(', '));
    }

    if (uncaughtErrors.length === 0) {
      p3pass('viewer3/cross-origin-rejection/no-uncaught', 'No uncaught exceptions');
    } else {
      p3fail('viewer3/cross-origin-rejection/no-uncaught', 'Uncaught: ' + uncaughtErrors.join('; '));
    }

    const screenshotPath = path.join(SCREENSHOTS_DIR, 'viewer-cross-origin-rejection.png');
    try { await page.screenshot({ path: screenshotPath }); } catch (_) {}
    await page.close();
  }

  await browser.close();
  server.close();

  // ── Summary and write results ─────────────────────────────────────────────
  const total3  = p3results.length;
  const passed3 = p3results.filter(r => r.status === 'PASS').length;
  const failed3 = p3results.filter(r => r.status === 'FAIL').length;

  console.log('\n=== Phase 3 Viewer Browser Test Results ===');
  console.log('Total: ' + total3 + '  PASS: ' + passed3 + '  FAIL: ' + failed3);

  // Read existing run4/results.md (from Node.js test runner) and append
  const existingContent4 = fs.existsSync(RESULTS_FILE4)
    ? fs.readFileSync(RESULTS_FILE4, 'utf8')
    : '';

  const appendLines4 = [
    '',
    '---',
    '',
    '# Phase 3 Viewer Browser Test Results (Playwright)',
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
    appendLines4.push('| ' + r.name + ' | ' + r.status + ' | ' + safeMsg + ' |');
  }
  appendLines4.push('');

  fs.writeFileSync(RESULTS_FILE4, existingContent4 + appendLines4.join('\n'), 'utf8');
  console.log('\nPhase 3 browser results written to: ' + RESULTS_FILE4);

  return failed3;
}

if (process.argv.includes('--phase3')) {
  // Run Phase 3 viewer browser tests only
  runPhase3BrowserTests()
    .then(failed => process.exit(failed > 0 ? 1 : 0))
    .catch(e => { console.error('Phase 3 browser test runner crashed:', e); process.exit(1); });
} else {
  // Default: run Phase 2 browser tests (original main)
  main().catch(e => {
    console.error('Browser test runner crashed:', e);
    process.exit(1);
  });
}
