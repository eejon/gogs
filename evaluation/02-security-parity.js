#!/usr/bin/env node
/**
 * Evaluation Script: Section 3 — Security (Functional Parity)
 *
 * Tests whether the custom renderer replicates the security behaviors
 * that PDF.js also exhibits. Does NOT evaluate defense-in-depth additions
 * unique to the custom implementation (those belong in a separate study).
 *
 * Checks:
 *   3.1  URL origin validation
 *   3.2  Embedded JavaScript never executes
 *   3.3  Dangerous actions not available
 *   3.4  External links open safely (static analysis)
 *   3.6  No unauthorized network requests (static analysis)
 */

'use strict';

var path = require('path');
var fs = require('fs');

var REPO_ROOT = path.resolve(__dirname, '..');
var LIB_DIR = path.join(REPO_ROOT, 'public/plugins/custom-pdf-render/lib');
var WEB_DIR = path.join(REPO_ROOT, 'public/plugins/custom-pdf-render/web');

// Load the security module
var PDFSecurity = require(path.join(LIB_DIR, 'pdf-security.js'));

var totalTests = 0;
var passed = 0;
var failed = 0;
var results = [];

function test(id, name, fn) {
  totalTests++;
  try {
    fn();
    passed++;
    results.push({ id: id, name: name, status: 'PASS', detail: null });
  } catch (e) {
    failed++;
    results.push({ id: id, name: name, status: 'FAIL', detail: e.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function section(title) {
  console.log('\n' + title);
  console.log('─'.repeat(60));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3.1  URL Origin Validation
// ═══════════════════════════════════════════════════════════════════════════

section('3.1  URL Origin Validation');

var VIEWER_ORIGIN = 'https://gogs.example.com';

test('3.1.1', 'Accept same-origin relative URL', function() {
  var r = PDFSecurity.validateFileUrl('/user/repo/raw/main/file.pdf', VIEWER_ORIGIN);
  assert(r.valid === true, 'Expected valid=true, got: ' + JSON.stringify(r));
});

test('3.1.2', 'Accept same-origin absolute URL', function() {
  var r = PDFSecurity.validateFileUrl('https://gogs.example.com/user/repo/raw/main/file.pdf', VIEWER_ORIGIN);
  assert(r.valid === true, 'Expected valid=true, got: ' + JSON.stringify(r));
});

test('3.1.3', 'Reject cross-origin URL', function() {
  var r = PDFSecurity.validateFileUrl('https://evil.com/malicious.pdf', VIEWER_ORIGIN);
  assert(r.valid === false, 'Expected valid=false for cross-origin');
});

test('3.1.4', 'Reject javascript: scheme', function() {
  var r = PDFSecurity.validateFileUrl('javascript:alert(1)', VIEWER_ORIGIN);
  assert(r.valid === false, 'Expected valid=false for javascript:');
});

test('3.1.5', 'Reject data: scheme', function() {
  var r = PDFSecurity.validateFileUrl('data:application/pdf;base64,abc', VIEWER_ORIGIN);
  assert(r.valid === false, 'Expected valid=false for data:');
});

test('3.1.6', 'Reject blob: scheme', function() {
  var r = PDFSecurity.validateFileUrl('blob:https://gogs.example.com/abc', VIEWER_ORIGIN);
  assert(r.valid === false, 'Expected valid=false for blob:');
});

test('3.1.7', 'Reject file: scheme', function() {
  var r = PDFSecurity.validateFileUrl('file:///etc/passwd', VIEWER_ORIGIN);
  assert(r.valid === false, 'Expected valid=false for file:');
});

test('3.1.8', 'Reject empty URL', function() {
  var r = PDFSecurity.validateFileUrl('', VIEWER_ORIGIN);
  assert(r.valid === false, 'Expected valid=false for empty');
});

test('3.1.9', 'Reject null URL', function() {
  var r = PDFSecurity.validateFileUrl(null, VIEWER_ORIGIN);
  assert(r.valid === false, 'Expected valid=false for null');
});

test('3.1.10', 'Reject javascript: with whitespace evasion', function() {
  var r = PDFSecurity.validateFileUrl('java\tscript:alert(1)', VIEWER_ORIGIN);
  assert(r.valid === false, 'Expected valid=false for whitespace-evaded javascript:');
});

test('3.1.11', 'Reject javascript: with case evasion', function() {
  var r = PDFSecurity.validateFileUrl('JaVaScRiPt:alert(1)', VIEWER_ORIGIN);
  assert(r.valid === false, 'Expected valid=false for case-evaded javascript:');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.2  Embedded JavaScript Never Executes
// ═══════════════════════════════════════════════════════════════════════════

section('3.2  Embedded JavaScript Never Executes');

test('3.2.1', 'containsJavaScript detects /JS key', function() {
  var dict = { '/S': '/JavaScript', '/JS': 'app.alert("xss")' };
  assert(PDFSecurity.containsJavaScript(dict) === true, 'Should detect /JS key');
});

test('3.2.2', 'containsJavaScript detects JavaScript action type', function() {
  var dict = { S: 'JavaScript', JS: 'app.alert("xss")' };
  assert(PDFSecurity.containsJavaScript(dict) === true, 'Should detect JavaScript action');
});

test('3.2.3', 'containsJavaScript detects nested JS', function() {
  var dict = { A: { S: 'JavaScript', JS: 'app.alert("xss")' } };
  assert(PDFSecurity.containsJavaScript(dict) === true, 'Should detect nested JS');
});

test('3.2.4', 'containsJavaScript returns false for safe dict', function() {
  var dict = { S: 'URI', URI: 'https://example.com' };
  assert(PDFSecurity.containsJavaScript(dict) === false, 'Should not flag URI action');
});

test('3.2.5', 'No eval/Function constructor in codebase', function() {
  var allFiles = [];
  function collectJS(dir) {
    fs.readdirSync(dir).forEach(function(f) {
      var full = path.join(dir, f);
      var stat = fs.statSync(full);
      if (stat.isDirectory()) collectJS(full);
      else if (f.endsWith('.js')) allFiles.push(full);
    });
  }
  collectJS(path.join(REPO_ROOT, 'public/plugins/custom-pdf-render'));

  var violations = [];
  allFiles.forEach(function(file) {
    var content = fs.readFileSync(file, 'utf8');
    var lines = content.split('\n');
    lines.forEach(function(line, idx) {
      var trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

      if (/\beval\s*\(/.test(line)) {
        violations.push(file + ':' + (idx + 1) + ' — eval()');
      }
      if (/\bnew\s+Function\s*\(/.test(line)) {
        violations.push(file + ':' + (idx + 1) + ' — new Function()');
      }
      if (/\bsetTimeout\s*\(\s*['"]/.test(line)) {
        violations.push(file + ':' + (idx + 1) + ' — setTimeout(string)');
      }
      if (/\bsetInterval\s*\(\s*['"]/.test(line)) {
        violations.push(file + ':' + (idx + 1) + ' — setInterval(string)');
      }
    });
  });

  assert(violations.length === 0,
    'Found code execution sinks:\n  ' + violations.join('\n  '));
});

test('3.2.6', 'No innerHTML usage in codebase', function() {
  var allFiles = [];
  function collectJS(dir) {
    fs.readdirSync(dir).forEach(function(f) {
      var full = path.join(dir, f);
      var stat = fs.statSync(full);
      if (stat.isDirectory()) collectJS(full);
      else if (f.endsWith('.js') || f.endsWith('.html')) allFiles.push(full);
    });
  }
  collectJS(path.join(REPO_ROOT, 'public/plugins/custom-pdf-render'));

  var violations = [];
  allFiles.forEach(function(file) {
    var content = fs.readFileSync(file, 'utf8');
    var lines = content.split('\n');
    lines.forEach(function(line, idx) {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
      if (/\.innerHTML\s*=/.test(line)) {
        violations.push(file + ':' + (idx + 1));
      }
      if (/\.outerHTML\s*=/.test(line)) {
        violations.push(file + ':' + (idx + 1));
      }
      if (/document\.write\s*\(/.test(line)) {
        violations.push(file + ':' + (idx + 1));
      }
    });
  });

  assert(violations.length === 0,
    'Found unsafe DOM sinks:\n  ' + violations.join('\n  '));
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.3  Dangerous Actions Not Available
// ═══════════════════════════════════════════════════════════════════════════

section('3.3  Dangerous Actions Not Available');

var DANGEROUS_ACTIONS = [
  'Launch', 'JavaScript', 'SubmitForm', 'ImportData',
  'Rendition', 'GoToR', 'GoToE', 'RichMedia', 'Sound', 'Movie'
];

DANGEROUS_ACTIONS.forEach(function(action) {
  test('3.3.' + action, 'Block action type: ' + action, function() {
    assert(PDFSecurity.isActionAllowed(action) === false,
      'Action "' + action + '" should be blocked');
  });
});

test('3.3.safe.URI', 'Allow action type: URI', function() {
  assert(PDFSecurity.isActionAllowed('URI') === true, 'URI should be allowed');
});

test('3.3.safe.GoTo', 'Allow action type: GoTo', function() {
  assert(PDFSecurity.isActionAllowed('GoTo') === true, 'GoTo should be allowed');
});

test('3.3.filter', 'filterAnnotation strips Launch action from link', function() {
  var annot = {
    Subtype: 'Link',
    Rect: [0, 0, 100, 20],
    A: { S: 'Launch', F: '/bin/sh' }
  };
  var filtered = PDFSecurity.filterAnnotation(annot);
  assert(filtered !== null, 'Annotation should not be null');
  assert(!filtered.A, 'Action should be stripped. Got: ' + JSON.stringify(filtered));
});

test('3.3.filter.js', 'filterAnnotation strips JavaScript action', function() {
  var annot = {
    Subtype: 'Link',
    Rect: [0, 0, 100, 20],
    A: { S: 'JavaScript', JS: 'app.alert("xss")' }
  };
  var filtered = PDFSecurity.filterAnnotation(annot);
  assert(filtered !== null, 'Annotation should not be null');
  assert(!filtered.A, 'JS action should be stripped');
});

test('3.3.filter.uri', 'filterAnnotation keeps safe URI action', function() {
  var annot = {
    Subtype: 'Link',
    Rect: [0, 0, 100, 20],
    A: { S: 'URI', URI: 'https://example.com' }
  };
  var filtered = PDFSecurity.filterAnnotation(annot);
  assert(filtered !== null, 'Annotation should not be null');
  assert(filtered.A, 'URI action should be kept');
  assert(filtered.A.URI === 'https://example.com', 'URI should be preserved');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.4  External Links Open Safely (static analysis)
// ═══════════════════════════════════════════════════════════════════════════

section('3.4  External Links Open Safely');

test('3.4.1', 'Annotation module sets target="_blank" on links', function() {
  var annotSrc = fs.readFileSync(path.join(LIB_DIR, 'pdf-annotations.js'), 'utf8');
  assert(annotSrc.indexOf('_blank') !== -1,
    'pdf-annotations.js should contain target="_blank"');
});

test('3.4.2', 'Annotation module sets rel="noopener noreferrer"', function() {
  var annotSrc = fs.readFileSync(path.join(LIB_DIR, 'pdf-annotations.js'), 'utf8');
  assert(annotSrc.indexOf('noopener') !== -1 && annotSrc.indexOf('noreferrer') !== -1,
    'pdf-annotations.js should set noopener noreferrer');
});

test('3.4.3', 'sanitizeAnnotationUri blocks javascript: in links', function() {
  var r = PDFSecurity.sanitizeAnnotationUri('javascript:alert(1)');
  assert(r === null, 'javascript: URI should be blocked');
});

test('3.4.4', 'sanitizeAnnotationUri blocks data: in links', function() {
  var r = PDFSecurity.sanitizeAnnotationUri('data:text/html,<script>alert(1)</script>');
  assert(r === null, 'data: URI should be blocked');
});

test('3.4.5', 'sanitizeAnnotationUri allows https:', function() {
  var r = PDFSecurity.sanitizeAnnotationUri('https://example.com');
  assert(r === 'https://example.com', 'https: should be allowed');
});

test('3.4.6', 'sanitizeAnnotationUri allows mailto:', function() {
  var r = PDFSecurity.sanitizeAnnotationUri('mailto:user@example.com');
  assert(r === 'mailto:user@example.com', 'mailto: should be allowed');
});

test('3.4.7', 'sanitizeAnnotationUri blocks protocol-relative URL', function() {
  var r = PDFSecurity.sanitizeAnnotationUri('//evil.com/payload');
  assert(r === null, 'protocol-relative URL should be blocked');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.6  No Unauthorized Network Requests (static analysis)
// ═══════════════════════════════════════════════════════════════════════════

section('3.6  No Unauthorized Network Requests');

test('3.6.1', 'Only viewer.js calls fetch()', function() {
  var allFiles = [];
  function collectJS(dir) {
    fs.readdirSync(dir).forEach(function(f) {
      var full = path.join(dir, f);
      var stat = fs.statSync(full);
      if (stat.isDirectory()) collectJS(full);
      else if (f.endsWith('.js')) allFiles.push(full);
    });
  }
  collectJS(path.join(REPO_ROOT, 'public/plugins/custom-pdf-render'));

  var fetchUsers = [];
  allFiles.forEach(function(file) {
    var content = fs.readFileSync(file, 'utf8');
    var lines = content.split('\n');
    lines.forEach(function(line, idx) {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
      if (/\bfetch\s*\(/.test(line)) {
        fetchUsers.push(path.basename(file) + ':' + (idx + 1));
      }
    });
  });

  var nonViewer = fetchUsers.filter(function(f) { return !f.startsWith('viewer.js:'); });
  assert(nonViewer.length === 0,
    'fetch() called outside viewer.js: ' + nonViewer.join(', '));
});

test('3.6.2', 'No XMLHttpRequest usage', function() {
  var allFiles = [];
  function collectJS(dir) {
    fs.readdirSync(dir).forEach(function(f) {
      var full = path.join(dir, f);
      var stat = fs.statSync(full);
      if (stat.isDirectory()) collectJS(full);
      else if (f.endsWith('.js')) allFiles.push(full);
    });
  }
  collectJS(path.join(REPO_ROOT, 'public/plugins/custom-pdf-render'));

  var violations = [];
  allFiles.forEach(function(file) {
    var content = fs.readFileSync(file, 'utf8');
    if (/XMLHttpRequest/.test(content)) {
      violations.push(path.basename(file));
    }
  });

  assert(violations.length === 0,
    'XMLHttpRequest found in: ' + violations.join(', '));
});

test('3.6.3', 'No WebSocket usage', function() {
  var allFiles = [];
  function collectJS(dir) {
    fs.readdirSync(dir).forEach(function(f) {
      var full = path.join(dir, f);
      var stat = fs.statSync(full);
      if (stat.isDirectory()) collectJS(full);
      else if (f.endsWith('.js')) allFiles.push(full);
    });
  }
  collectJS(path.join(REPO_ROOT, 'public/plugins/custom-pdf-render'));

  var violations = [];
  allFiles.forEach(function(file) {
    var content = fs.readFileSync(file, 'utf8');
    if (/\bWebSocket\b/.test(content) || /\bEventSource\b/.test(content)) {
      violations.push(path.basename(file));
    }
  });

  assert(violations.length === 0,
    'WebSocket/EventSource found in: ' + violations.join(', '));
});

test('3.6.4', 'No external script/link/image tags in viewer.html', function() {
  var html = fs.readFileSync(path.join(WEB_DIR, 'viewer.html'), 'utf8');
  var externalRefs = [];

  var srcMatches = html.match(/src=["'][^"']*["']/g) || [];
  srcMatches.forEach(function(m) {
    var url = m.replace(/^src=["']|["']$/g, '');
    if (/^https?:\/\//.test(url)) {
      externalRefs.push('src: ' + url);
    }
  });

  var hrefMatches = html.match(/href=["'][^"']*["']/g) || [];
  hrefMatches.forEach(function(m) {
    var url = m.replace(/^href=["']|["']$/g, '');
    if (/^https?:\/\//.test(url)) {
      externalRefs.push('href: ' + url);
    }
  });

  assert(externalRefs.length === 0,
    'External resources in viewer.html: ' + externalRefs.join(', '));
});

// ═══════════════════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════════════════

section('Results');

results.forEach(function(r) {
  var icon = r.status === 'PASS' ? '[PASS]' : '[FAIL]';
  var line = '  ' + icon + ' ' + r.id + ' — ' + r.name;
  console.log(line);
  if (r.detail) {
    console.log('         ' + r.detail);
  }
});

console.log('\n  Total: ' + totalTests + '  |  Passed: ' + passed + '  |  Failed: ' + failed);

if (failed > 0) {
  console.log('\n  Suggested scores based on results:');
  console.log('    3.1 URL validation:        ' + (results.filter(function(r) { return r.id.startsWith('3.1') && r.status === 'PASS'; }).length) + '/' + results.filter(function(r) { return r.id.startsWith('3.1'); }).length + ' tests pass');
  console.log('    3.2 JS never executes:     ' + (results.filter(function(r) { return r.id.startsWith('3.2') && r.status === 'PASS'; }).length) + '/' + results.filter(function(r) { return r.id.startsWith('3.2'); }).length + ' tests pass');
  console.log('    3.3 Dangerous actions:     ' + (results.filter(function(r) { return r.id.startsWith('3.3') && r.status === 'PASS'; }).length) + '/' + results.filter(function(r) { return r.id.startsWith('3.3'); }).length + ' tests pass');
  console.log('    3.4 Safe external links:   ' + (results.filter(function(r) { return r.id.startsWith('3.4') && r.status === 'PASS'; }).length) + '/' + results.filter(function(r) { return r.id.startsWith('3.4'); }).length + ' tests pass');
  console.log('    3.6 No unauth network:     ' + (results.filter(function(r) { return r.id.startsWith('3.6') && r.status === 'PASS'; }).length) + '/' + results.filter(function(r) { return r.id.startsWith('3.6'); }).length + ' tests pass');
}

console.log('\n  Score mapping guide:');
console.log('    100% pass = 5/5');
console.log('    80%+ pass = 4/5');
console.log('    60%+ pass = 3/5');
console.log('    40%+ pass = 2/5');
console.log('    <40% pass = 1/5');

process.exit(failed > 0 ? 1 : 0);
