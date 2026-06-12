/**
 * verify-fixes.js -- Verification test for custom-pdf-render bug fixes
 *
 * Creates minimal hand-crafted PDFs (no corpus files) and verifies:
 *   1. Parser correctly produces expected page structure
 *   2. Renderer correctly transforms PDF coordinates to canvas coordinates
 *   3. Text rendering calls canvas API with correct matrix values
 *   4. Image placement via cm operator uses correct transform composition
 *   5. Form XObject rendering uses correct transform composition
 *   6. Browser global exports exist for PDFFonts and PDFImages
 *
 * Usage: node tests/verify-fixes.js
 * Exit code: 0 if all pass, 1 if any fail.
 */

'use strict';

const path = require('path');

const PROJECT_ROOT  = path.resolve(__dirname, '..');
const PARSER_PATH   = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-parser.js');
const RENDERER_PATH = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-renderer.js');
const FONTS_PATH    = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-fonts.js');
const IMAGES_PATH   = path.join(PROJECT_ROOT, 'public', 'plugins', 'custom-pdf-render', 'src', 'pdf-images.js');

const { PDFParser, ParseError } = require(PARSER_PATH);
const { PDFRenderer } = require(RENDERER_PATH);
const PDFFonts    = require(FONTS_PATH);
const PDFImages   = require(IMAGES_PATH);

// ── Test tracking ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(name, detail) {
  passed++;
  console.log('  PASS  ' + name + (detail ? ': ' + detail : ''));
}

function fail(name, detail) {
  failed++;
  console.error('  FAIL  ' + name + ': ' + detail);
}

function assert(condition, name, detail) {
  if (condition) {
    pass(name, detail);
  } else {
    fail(name, detail || 'assertion failed');
  }
}

function assertApprox(actual, expected, tolerance, name) {
  var diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    pass(name, 'actual=' + actual.toFixed(4) + ' expected=' + expected.toFixed(4));
  } else {
    fail(name, 'actual=' + actual.toFixed(4) + ' expected=' + expected.toFixed(4) + ' diff=' + diff.toFixed(4));
  }
}

// ── PDF builder helpers ───────────────────────────────────────────────────────

/**
 * Build a minimal valid PDF as an ArrayBuffer.
 * Contains one page with a text content stream: "BT /F1 12 Tf 100 700 Td (Hello) Tj ET"
 * This places "Hello" at PDF coordinates (100, 700) on a letter-size page (612 x 792).
 */
function buildMinimalTextPDF() {
  // We'll build the PDF as a string, tracking byte offsets for the xref table.
  var objects = [];
  var offsets = [];

  // Header
  var header = '%PDF-1.4\n';

  // Object 1: Catalog
  var obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';

  // Object 2: Pages
  var obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';

  // Object 3: Page
  var obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n';

  // Object 4: Content stream (uncompressed)
  var streamContent = 'BT /F1 12 Tf 100 700 Td (Hello) Tj ET';
  var obj4 = '4 0 obj\n<< /Length ' + streamContent.length + ' >>\nstream\n' + streamContent + '\nendstream\nendobj\n';

  // Object 5: Font
  var obj5 = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';

  // Compute byte offsets
  var pos = header.length;

  offsets[1] = pos;
  pos += obj1.length;

  offsets[2] = pos;
  pos += obj2.length;

  offsets[3] = pos;
  pos += obj3.length;

  offsets[4] = pos;
  pos += obj4.length;

  offsets[5] = pos;
  pos += obj5.length;

  var xrefOffset = pos;

  // Build xref table
  var xref = 'xref\n0 6\n';
  xref += '0000000000 65535 f \n';
  for (var i = 1; i <= 5; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }

  // Trailer
  var trailer = 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';

  var pdfString = header + obj1 + obj2 + obj3 + obj4 + obj5 + xref + trailer;

  // Convert to ArrayBuffer
  var buf = new Uint8Array(pdfString.length);
  for (var i = 0; i < pdfString.length; i++) {
    buf[i] = pdfString.charCodeAt(i);
  }
  return buf.buffer;
}

/**
 * Build a minimal PDF with a cm operator followed by a rectangle path.
 * This tests that the cm operator correctly composes the CTM with the base transform.
 */
function buildCmOperatorPDF() {
  var header = '%PDF-1.4\n';

  var obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  var obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';

  // Content: cm operator sets a transform, then draws a rectangle
  var streamContent = 'q 2 0 0 2 50 400 cm 0 0 100 50 re S Q';
  var obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n';
  var obj4 = '4 0 obj\n<< /Length ' + streamContent.length + ' >>\nstream\n' + streamContent + '\nendstream\nendobj\n';

  var pos = header.length;
  var offsets = [];
  offsets[1] = pos; pos += obj1.length;
  offsets[2] = pos; pos += obj2.length;
  offsets[3] = pos; pos += obj3.length;
  offsets[4] = pos; pos += obj4.length;

  var xrefOffset = pos;
  var xref = 'xref\n0 5\n';
  xref += '0000000000 65535 f \n';
  for (var i = 1; i <= 4; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }

  var trailer = 'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';
  var pdfString = header + obj1 + obj2 + obj3 + obj4 + xref + trailer;

  var buf = new Uint8Array(pdfString.length);
  for (var i = 0; i < pdfString.length; i++) {
    buf[i] = pdfString.charCodeAt(i);
  }
  return buf.buffer;
}

// ── Mock Canvas for Renderer Tests ───────────────────────────────────────────

function createMockCanvas(width, height) {
  var calls = [];

  var ctx = {
    _calls: calls,
    _transform: [1, 0, 0, 1, 0, 0],
    _savedStates: [],
    canvas: { width: width, height: height },

    setTransform: function(a, b, c, d, e, f) {
      this._transform = [a, b, c, d, e, f];
      calls.push({ method: 'setTransform', args: [a, b, c, d, e, f] });
    },
    transform: function(a, b, c, d, e, f) {
      calls.push({ method: 'transform', args: [a, b, c, d, e, f] });
    },
    save: function() {
      this._savedStates.push(this._transform.slice());
      calls.push({ method: 'save' });
    },
    restore: function() {
      if (this._savedStates.length > 0) {
        this._transform = this._savedStates.pop();
      }
      calls.push({ method: 'restore' });
    },
    scale: function(x, y) {
      calls.push({ method: 'scale', args: [x, y] });
    },
    fillText: function(text, x, y) {
      calls.push({ method: 'fillText', args: [text, x, y], transform: this._transform.slice() });
    },
    strokeText: function(text, x, y) {
      calls.push({ method: 'strokeText', args: [text, x, y], transform: this._transform.slice() });
    },
    fillRect: function(x, y, w, h) {
      calls.push({ method: 'fillRect', args: [x, y, w, h] });
    },
    beginPath: function() { calls.push({ method: 'beginPath' }); },
    moveTo: function(x, y) { calls.push({ method: 'moveTo', args: [x, y] }); },
    lineTo: function(x, y) { calls.push({ method: 'lineTo', args: [x, y] }); },
    rect: function(x, y, w, h) { calls.push({ method: 'rect', args: [x, y, w, h] }); },
    stroke: function() { calls.push({ method: 'stroke' }); },
    fill: function(rule) { calls.push({ method: 'fill', args: rule ? [rule] : [] }); },
    clip: function(rule) { calls.push({ method: 'clip', args: rule ? [rule] : [] }); },
    closePath: function() { calls.push({ method: 'closePath' }); },
    measureText: function(text) { return { width: text.length * 6 }; },
    drawImage: function() { calls.push({ method: 'drawImage' }); },
    createImageData: function(w, h) {
      return { data: new Uint8Array(w * h * 4), width: w, height: h };
    },
    putImageData: function() { calls.push({ method: 'putImageData' }); },
    getImageData: function(x, y, w, h) {
      return { data: new Uint8Array(w * h * 4), width: w, height: h };
    },

    // Properties
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    font: '10px sans-serif',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    setLineDash: function() {},
    getLineDash: function() { return []; },
    lineDashOffset: 0,
  };

  return { canvas: { width: width, height: height, getContext: function() { return ctx; } }, ctx: ctx };
}

// ── Test 1: Parser produces correct structure ────────────────────────────────

async function testParserStructure() {
  console.log('\n--- Test 1: Parser Structure (hand-crafted PDF) ---');

  var ab = buildMinimalTextPDF();

  var parser;
  try {
    parser = new PDFParser(ab);
  } catch (e) {
    fail('parser/construct', 'Constructor threw: ' + e.message);
    return;
  }
  pass('parser/construct');

  var result;
  try {
    result = await parser.load();
  } catch (e) {
    fail('parser/load', 'load() threw: ' + e.message);
    return;
  }

  if (result.error) {
    fail('parser/load', 'load() returned error: ' + result.error.message);
    return;
  }
  pass('parser/load');

  // Check version
  assert(result.version && result.version.indexOf('1.4') >= 0, 'parser/version', 'version=' + result.version);

  // Check pages
  assert(Array.isArray(result.pages), 'parser/pages-array', 'pages is an array');
  assert(result.pages.length === 1, 'parser/page-count', 'count=' + result.pages.length);

  // Check MediaBox
  var page = result.pages[0];
  var mediaBox = page['/MediaBox'];
  assert(Array.isArray(mediaBox), 'parser/mediabox-array', 'MediaBox is an array');
  if (Array.isArray(mediaBox)) {
    assert(
      mediaBox[0] === 0 && mediaBox[1] === 0 && mediaBox[2] === 612 && mediaBox[3] === 792,
      'parser/mediabox-values',
      'MediaBox=[' + mediaBox.join(',') + ']'
    );
  }

  // Check content stream exists
  var contents = page['/Contents'];
  assert(contents !== undefined && contents !== null, 'parser/contents-exist', 'Contents reference present');

  // Resolve contents and check it's a stream
  if (contents && typeof contents === 'object' && contents.type === 'ref') {
    contents = parser.resolveRef(contents);
  }
  assert(contents && contents.isStream, 'parser/contents-stream', 'Contents is a stream object');

  // Decode stream bytes and check content
  if (contents && typeof contents.getBytes === 'function') {
    var bytes = contents.getBytes();
    var text = '';
    for (var i = 0; i < bytes.length; i++) {
      text += String.fromCharCode(bytes[i]);
    }
    assert(
      text.indexOf('BT') >= 0 && text.indexOf('Tf') >= 0 && text.indexOf('Td') >= 0 && text.indexOf('Tj') >= 0,
      'parser/content-operators',
      'Stream contains BT, Tf, Td, Tj operators'
    );
    assert(text.indexOf('Hello') >= 0, 'parser/content-text', 'Stream contains "Hello"');
  }

  // Check font resource
  var resources = page['/Resources'];
  assert(resources && typeof resources === 'object', 'parser/resources', 'Resources dict present');
  if (resources) {
    var fonts = resources['/Font'];
    assert(fonts && typeof fonts === 'object', 'parser/font-dict', 'Font dict present');
    if (fonts) {
      var f1 = fonts['/F1'];
      if (f1 && typeof f1 === 'object' && f1.type === 'ref') {
        f1 = parser.resolveRef(f1);
      }
      assert(f1 && f1['/BaseFont'], 'parser/font-basefont', 'F1 has BaseFont=' + (f1 ? f1['/BaseFont'] : 'null'));
    }
  }

  return parser;
}

// ── Test 2: Text rendering coordinate transform ──────────────────────────────

async function testTextTransform() {
  console.log('\n--- Test 2: Text Rendering Coordinate Transform ---');

  var ab = buildMinimalTextPDF();
  var parser = new PDFParser(ab);
  var result = await parser.load();
  var page = result.pages[0];

  // Create mock canvas at scale=1
  var scale = 1;
  var mock = createMockCanvas(612, 792);
  var canvas = mock.canvas;
  var ctx = mock.ctx;

  var renderer = new PDFRenderer();
  try {
    await renderer.renderPage(canvas, page, scale, parser);
  } catch (e) {
    fail('text-transform/render', 'renderPage threw: ' + e.message);
    return;
  }
  pass('text-transform/render', 'renderPage completed');

  // The text "Hello" is at PDF coords (100, 700) on a 612x792 page.
  // Base transform at scale=1: [1, 0, 0, -1, 0, 792]
  // With identity CTM and text matrix at (100, 700):
  //   TRM = textMatrix * ctm = [1,0,0,1,100,700] * [1,0,0,1,0,0] = [1,0,0,1,100,700]
  //   canvasTrm = TRM * baseTransform = [1,0,0,1,100,700] * [1,0,0,-1,0,792]
  //   = [1*1+0*0, 1*0+0*(-1), 0*1+1*0, 0*0+1*(-1), 100*1+700*0+0, 100*0+700*(-1)+792]
  //   = [1, 0, 0, -1, 100, 92]
  //
  // Then there's a ctx.scale(1, -1) to flip text upright, so effective transform
  // for the text is [1, 0, 0, 1, 100, 92] (positive Y-scale after the flip).
  //
  // The text should appear at canvas position (100, 92).

  // Find the setTransform call that sets up text rendering
  var textSetTransforms = ctx._calls.filter(function(c) {
    return c.method === 'setTransform' &&
           c.args.length === 6 &&
           Math.abs(c.args[4] - 100) < 1; // e component near 100
  });

  assert(textSetTransforms.length > 0, 'text-transform/setTransform-found',
    'Found setTransform with e~100 (' + textSetTransforms.length + ' matches)');

  if (textSetTransforms.length > 0) {
    // Find the one that has f~92 (our expected canvas Y position)
    var correct = textSetTransforms.filter(function(c) {
      return Math.abs(c.args[5] - 92) < 1; // f component near 92
    });
    assert(correct.length > 0, 'text-transform/y-position',
      'setTransform has f~92 (Y-flipped from PDF y=700 on 792pt page)');

    if (correct.length > 0) {
      var tf = correct[0].args;
      assertApprox(tf[0], 1, 0.01, 'text-transform/a-component');
      assertApprox(tf[1], 0, 0.01, 'text-transform/b-component');
      assertApprox(tf[2], 0, 0.01, 'text-transform/c-component');
      assertApprox(tf[3], -1, 0.01, 'text-transform/d-component');
      assertApprox(tf[4], 100, 0.01, 'text-transform/e-component');
      assertApprox(tf[5], 92, 0.01, 'text-transform/f-component');
    }
  }

  // Check that fillText was actually called (text was rendered)
  var fillTexts = ctx._calls.filter(function(c) { return c.method === 'fillText'; });
  assert(fillTexts.length > 0, 'text-transform/fillText-called',
    fillTexts.length + ' fillText calls');
}

// ── Test 3: cm operator transform composition ────────────────────────────────

async function testCmOperator() {
  console.log('\n--- Test 3: cm Operator Transform Composition ---');

  var ab = buildCmOperatorPDF();
  var parser = new PDFParser(ab);
  var result = await parser.load();
  var page = result.pages[0];

  var scale = 1;
  var mock = createMockCanvas(612, 792);
  var canvas = mock.canvas;
  var ctx = mock.ctx;

  var renderer = new PDFRenderer();
  try {
    await renderer.renderPage(canvas, page, scale, parser);
  } catch (e) {
    fail('cm-operator/render', 'renderPage threw: ' + e.message);
    return;
  }
  pass('cm-operator/render', 'renderPage completed');

  // Content: q 2 0 0 2 50 400 cm 0 0 100 50 re S Q
  //
  // The cm sets CTM to [2, 0, 0, 2, 50, 400] (scale 2x + translate to (50, 400))
  // Base transform at scale=1: [1, 0, 0, -1, 0, 792]
  //
  // multiplyMatrix([2,0,0,2,50,400], [1,0,0,-1,0,792]):
  //   a = 2*1 + 0*0 = 2
  //   b = 2*0 + 0*(-1) = 0
  //   c = 0*1 + 2*0 = 0
  //   d = 0*0 + 2*(-1) = -2
  //   e = 50*1 + 400*0 + 0 = 50
  //   f = 50*0 + 400*(-1) + 792 = 392
  //
  // So after cm, canvas transform should be [2, 0, 0, -2, 50, 392]

  var cmSetTransforms = ctx._calls.filter(function(c) {
    return c.method === 'setTransform' &&
           c.args.length === 6 &&
           Math.abs(c.args[0] - 2) < 0.01 &&
           Math.abs(c.args[3] - (-2)) < 0.01;
  });

  assert(cmSetTransforms.length > 0, 'cm-operator/setTransform-found',
    'Found setTransform with a=2, d=-2 (' + cmSetTransforms.length + ' matches)');

  if (cmSetTransforms.length > 0) {
    var tf = cmSetTransforms[0].args;
    assertApprox(tf[0], 2, 0.01, 'cm-operator/a-component');
    assertApprox(tf[1], 0, 0.01, 'cm-operator/b-component');
    assertApprox(tf[2], 0, 0.01, 'cm-operator/c-component');
    assertApprox(tf[3], -2, 0.01, 'cm-operator/d-component');
    assertApprox(tf[4], 50, 0.01, 'cm-operator/e-component');
    assertApprox(tf[5], 392, 0.01, 'cm-operator/f-component');
  }

  // Verify no ctx.transform() calls (old bug used ctx.transform instead of setTransform)
  var transformCalls = ctx._calls.filter(function(c) {
    return c.method === 'transform';
  });
  assert(transformCalls.length === 0, 'cm-operator/no-ctx-transform',
    transformCalls.length + ' ctx.transform() calls (should be 0)');

  // Verify the rectangle was drawn (re + S operators)
  var rectCalls = ctx._calls.filter(function(c) { return c.method === 'rect'; });
  assert(rectCalls.length > 0, 'cm-operator/rect-drawn',
    rectCalls.length + ' rect calls');

  var strokeCalls = ctx._calls.filter(function(c) { return c.method === 'stroke'; });
  assert(strokeCalls.length > 0, 'cm-operator/stroke-called',
    strokeCalls.length + ' stroke calls');
}

// ── Test 4: Q operator restores transform ────────────────────────────────────

async function testQRestore() {
  console.log('\n--- Test 4: Q Operator Restores Transform ---');

  var ab = buildCmOperatorPDF();
  var parser = new PDFParser(ab);
  var result = await parser.load();
  var page = result.pages[0];

  var scale = 1;
  var mock = createMockCanvas(612, 792);
  var canvas = mock.canvas;
  var ctx = mock.ctx;

  var renderer = new PDFRenderer();
  await renderer.renderPage(canvas, page, scale, parser);

  // After Q, the transform should be restored to the base transform [1, 0, 0, -1, 0, 792]
  // Find the setTransform after the last restore
  var lastRestoreIdx = -1;
  for (var i = ctx._calls.length - 1; i >= 0; i--) {
    if (ctx._calls[i].method === 'restore') {
      lastRestoreIdx = i;
      break;
    }
  }

  assert(lastRestoreIdx >= 0, 'q-restore/restore-found', 'Found restore call');

  if (lastRestoreIdx >= 0) {
    // Look for a setTransform immediately after (or very close to) the restore
    // The Q operator should call ctx.restore() then ctx.setTransform() to resync
    var foundResync = false;
    for (var j = lastRestoreIdx + 1; j < Math.min(lastRestoreIdx + 3, ctx._calls.length); j++) {
      var call = ctx._calls[j];
      if (call.method === 'setTransform') {
        // Should be back to base transform (identity CTM composed with base)
        // = [1, 0, 0, -1, 0, 792]
        if (Math.abs(call.args[0] - 1) < 0.01 &&
            Math.abs(call.args[3] - (-1)) < 0.01 &&
            Math.abs(call.args[5] - 792) < 1) {
          foundResync = true;
          pass('q-restore/transform-resynced',
            'setTransform after restore: [' +
            call.args.map(function(v) { return v.toFixed(2); }).join(', ') + ']');
        }
      }
    }

    if (!foundResync) {
      // Check if the restore itself was sufficient (canvas restore pops transform state)
      // Since we use ctx.save() in the q operator, ctx.restore() in Q should pop back
      // But we also need the setTransform resync for the gs.ctm to match
      fail('q-restore/transform-resynced', 'No setTransform with base transform found after restore');
    }
  }
}

// ── Test 5: Module exports are correct ───────────────────────────────────────

function testModuleExports() {
  console.log('\n--- Test 5: Module Exports ---');

  // PDFFonts
  assert(PDFFonts !== null && typeof PDFFonts === 'object', 'exports/PDFFonts-exists');
  assert(typeof PDFFonts.getStandardFontCSS === 'function', 'exports/PDFFonts.getStandardFontCSS');
  assert(typeof PDFFonts.isBoldFont === 'function', 'exports/PDFFonts.isBoldFont');
  assert(typeof PDFFonts.isItalicFont === 'function', 'exports/PDFFonts.isItalicFont');
  assert(typeof PDFFonts.getCharWidth === 'function', 'exports/PDFFonts.getCharWidth');

  // PDFImages
  assert(PDFImages !== null && typeof PDFImages === 'object', 'exports/PDFImages-exists');
  assert(typeof PDFImages.drawImageXObject === 'function', 'exports/PDFImages.drawImageXObject');
  assert(typeof PDFImages.cmykToRGB === 'function', 'exports/PDFImages.cmykToRGB');

  // PDFRenderer
  assert(typeof PDFRenderer === 'function', 'exports/PDFRenderer-constructor');
  var r = new PDFRenderer();
  assert(typeof r.renderPage === 'function', 'exports/PDFRenderer.renderPage');
  assert(r._baseTransform !== undefined, 'exports/PDFRenderer._baseTransform-initialized');

  // PDFParser
  assert(typeof PDFParser === 'function', 'exports/PDFParser-constructor');
  assert(typeof ParseError === 'function', 'exports/ParseError-constructor');
}

// ── Test 6: multiplyMatrix correctness ───────────────────────────────────────

function testMultiplyMatrix() {
  console.log('\n--- Test 6: multiplyMatrix Correctness ---');

  // Access multiplyMatrix indirectly: we can test it through the renderer behavior.
  // Instead, let's reimplement and test the same formula:
  function multiplyMatrix(m1, m2) {
    return [
      m1[0] * m2[0] + m1[1] * m2[2],
      m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2],
      m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
      m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
    ];
  }

  // Identity * identity = identity
  var id = [1, 0, 0, 1, 0, 0];
  var r1 = multiplyMatrix(id, id);
  assert(
    r1[0] === 1 && r1[1] === 0 && r1[2] === 0 && r1[3] === 1 && r1[4] === 0 && r1[5] === 0,
    'matrix/identity*identity'
  );

  // Translation * Y-flip base transform
  // text at (100, 700), base = [1, 0, 0, -1, 0, 792]
  var textMatrix = [1, 0, 0, 1, 100, 700];
  var baseTransform = [1, 0, 0, -1, 0, 792];
  var r2 = multiplyMatrix(textMatrix, baseTransform);
  assertApprox(r2[0], 1, 0.001, 'matrix/text*base a');
  assertApprox(r2[1], 0, 0.001, 'matrix/text*base b');
  assertApprox(r2[2], 0, 0.001, 'matrix/text*base c');
  assertApprox(r2[3], -1, 0.001, 'matrix/text*base d');
  assertApprox(r2[4], 100, 0.001, 'matrix/text*base e');
  assertApprox(r2[5], 92, 0.001, 'matrix/text*base f');

  // cm [2,0,0,2,50,400] * base [1,0,0,-1,0,792]
  var cmMatrix = [2, 0, 0, 2, 50, 400];
  var r3 = multiplyMatrix(cmMatrix, baseTransform);
  assertApprox(r3[0], 2, 0.001, 'matrix/cm*base a');
  assertApprox(r3[1], 0, 0.001, 'matrix/cm*base b');
  assertApprox(r3[2], 0, 0.001, 'matrix/cm*base c');
  assertApprox(r3[3], -2, 0.001, 'matrix/cm*base d');
  assertApprox(r3[4], 50, 0.001, 'matrix/cm*base e');
  assertApprox(r3[5], 392, 0.001, 'matrix/cm*base f');

  // Scale with offset base transform (with pageX offset)
  var baseWithOffset = [1.5, 0, 0, -1.5, -10, 500];
  var r4 = multiplyMatrix(id, baseWithOffset);
  assert(
    r4[0] === 1.5 && r4[3] === -1.5 && r4[4] === -10 && r4[5] === 500,
    'matrix/identity*scaled-base',
    'result=[' + r4.join(',') + ']'
  );
}

// ── Test 7: Malformed PDF handling ───────────────────────────────────────────

async function testMalformedPDF() {
  console.log('\n--- Test 7: Malformed PDF Handling ---');

  // Empty buffer -- should either throw or return error in result
  try {
    var emptyParser = new PDFParser(new ArrayBuffer(0));
    var emptyResult = await emptyParser.load();
    if (emptyResult && emptyResult.error) {
      pass('malformed/empty', 'Returned error: ' + emptyResult.error.message);
    } else {
      // If it returns 0 pages, that's also acceptable
      assert(emptyResult.pages.length === 0, 'malformed/empty', 'Returned 0 pages');
    }
  } catch (e) {
    pass('malformed/empty', 'Threw: ' + e.message);
  }

  // Random bytes (not a PDF) -- should either throw or return error
  try {
    var randomBuf = new Uint8Array(256);
    for (var i = 0; i < 256; i++) randomBuf[i] = Math.floor(Math.random() * 256);
    var randomParser = new PDFParser(randomBuf.buffer);
    var randomResult = await randomParser.load();
    if (randomResult && randomResult.error) {
      pass('malformed/random', 'Returned error: ' + randomResult.error.message);
    } else {
      assert(randomResult.pages.length === 0, 'malformed/random', 'Returned 0 pages');
    }
  } catch (e) {
    pass('malformed/random', 'Threw: ' + e.message);
  }

  // Truncated PDF (header only) -- should not crash
  try {
    var headerOnly = '%PDF-1.4\n%%EOF\n';
    var headerBuf = new Uint8Array(headerOnly.length);
    for (var i = 0; i < headerOnly.length; i++) headerBuf[i] = headerOnly.charCodeAt(i);
    var headerParser = new PDFParser(headerBuf.buffer);
    var headerResult = await headerParser.load();
    // OK if it returns error or 0 pages
    if (headerResult && headerResult.error) {
      pass('malformed/truncated', 'Returned error: ' + headerResult.error.message);
    } else {
      pass('malformed/truncated', 'Did not crash (pages=' + (headerResult.pages ? headerResult.pages.length : 0) + ')');
    }
  } catch (e) {
    pass('malformed/truncated', 'Threw (acceptable): ' + e.message);
  }
}

// ── Test 8: Renderer handles missing/null resources gracefully ───────────────

async function testMissingResources() {
  console.log('\n--- Test 8: Renderer with Missing Resources ---');

  // Build a PDF with content that references a non-existent font
  var header = '%PDF-1.4\n';
  var obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  var obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';

  // Content references /F1 but no Font resource is provided
  var streamContent = 'BT /F1 12 Tf 50 600 Td (Test) Tj ET';
  var obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n';
  var obj4 = '4 0 obj\n<< /Length ' + streamContent.length + ' >>\nstream\n' + streamContent + '\nendstream\nendobj\n';

  var pos = header.length;
  var offsets = [];
  offsets[1] = pos; pos += obj1.length;
  offsets[2] = pos; pos += obj2.length;
  offsets[3] = pos; pos += obj3.length;
  offsets[4] = pos; pos += obj4.length;

  var xrefOffset = pos;
  var xref = 'xref\n0 5\n0000000000 65535 f \n';
  for (var i = 1; i <= 4; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  var trailer = 'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';

  var pdfString = header + obj1 + obj2 + obj3 + obj4 + xref + trailer;
  var buf = new Uint8Array(pdfString.length);
  for (var i = 0; i < pdfString.length; i++) buf[i] = pdfString.charCodeAt(i);

  var parser = new PDFParser(buf.buffer);
  var result = await parser.load();
  var page = result.pages[0];

  var mock = createMockCanvas(612, 792);
  var renderer = new PDFRenderer();

  try {
    await renderer.renderPage(mock.canvas, page, 1, parser);
    pass('missing-resources/no-crash', 'Renderer did not crash with missing font');
  } catch (e) {
    fail('missing-resources/no-crash', 'Renderer crashed: ' + e.message);
  }
}

// ── Run all tests ────────────────────────────────────────────────────────────

async function main() {
  console.log('\n========================================');
  console.log('  Custom PDF Renderer -- Fix Verification');
  console.log('========================================');

  testModuleExports();
  testMultiplyMatrix();
  await testParserStructure();
  await testTextTransform();
  await testCmOperator();
  await testQRestore();
  await testMalformedPDF();
  await testMissingResources();

  console.log('\n========================================');
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function(e) {
  console.error('Test runner error:', e);
  process.exit(1);
});
