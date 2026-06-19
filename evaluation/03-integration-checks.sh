#!/usr/bin/env bash
# Evaluation Script: Section 2 — Downstream Integration & UI (Structural Checks)
#
# Checks items that can be verified without a running browser:
#   2.2  Template path swap (only change required in Gogs)
#   2.3  Static file serving (no server-side deps)
#   2.10 Iframe-safe behavior (no breakout patterns in source)
#
# Items requiring a headless browser (2.1, 2.4-2.9, 2.11-2.12)
# are marked as [MANUAL] with guidance.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CUSTOM_DIR="$REPO_ROOT/public/plugins/custom-pdf-render"
TEMPLATE="$REPO_ROOT/templates/repo/view_file.tmpl"

total=0
pass=0
fail=0

check() {
  local id="$1"
  local name="$2"
  local result="$3"  # PASS or FAIL
  local detail="$4"
  total=$((total + 1))
  if [ "$result" = "PASS" ]; then
    pass=$((pass + 1))
    echo "  [PASS] $id — $name"
  else
    fail=$((fail + 1))
    echo "  [FAIL] $id — $name"
    echo "         $detail"
  fi
}

divider() { printf '\n%s\n' "────────────────────────────────────────────────────────"; }

echo "=== Integration & UI Structural Checks ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ═══════════════════════════════════════════════════════════════════════════
# 2.2  Template Path Swap
# ═══════════════════════════════════════════════════════════════════════════

divider
echo "2.2  Template Path Swap"

if [ ! -f "$TEMPLATE" ]; then
  check "2.2.1" "Template file exists" "FAIL" "Not found: $TEMPLATE"
else
  # Check that the template references custom-pdf-render
  if grep -q 'custom-pdf-render/web/viewer.html' "$TEMPLATE"; then
    check "2.2.1" "Template points to custom-pdf-render" "PASS" ""
  else
    check "2.2.1" "Template points to custom-pdf-render" "FAIL" \
      "Template does not reference custom-pdf-render/web/viewer.html"
  fi

  # Check that ?file= parameter is passed
  if grep -q '?file=' "$TEMPLATE"; then
    check "2.2.2" "Template passes ?file= parameter" "PASS" ""
  else
    check "2.2.2" "Template passes ?file= parameter" "FAIL" \
      "Template does not pass ?file= query parameter"
  fi

  # Check that it's inside an iframe
  if grep -q '<iframe' "$TEMPLATE"; then
    check "2.2.3" "Template uses iframe embedding" "PASS" ""
  else
    check "2.2.3" "Template uses iframe embedding" "FAIL" \
      "No <iframe> tag found in template"
  fi

  # Verify no other Gogs files were modified
  echo ""
  echo "  Checking for other Gogs modifications beyond template..."
  # Check that the view.go detection logic is untouched (IsPDFFile)
  if grep -q 'IsPDFFile' "$REPO_ROOT/internal/route/repo/view.go"; then
    check "2.2.4" "Server-side PDF detection unchanged (IsPDFFile)" "PASS" ""
  else
    check "2.2.4" "Server-side PDF detection unchanged (IsPDFFile)" "FAIL" \
      "IsPDFFile not found in view.go — detection logic may have been altered"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# 2.3  Static File Serving
# ═══════════════════════════════════════════════════════════════════════════

divider
echo "2.3  Static File Serving"

# Check entry point exists
if [ -f "$CUSTOM_DIR/web/viewer.html" ]; then
  check "2.3.1" "Entry point exists (web/viewer.html)" "PASS" ""
else
  check "2.3.1" "Entry point exists (web/viewer.html)" "FAIL" \
    "Missing: $CUSTOM_DIR/web/viewer.html"
fi

# Check all script dependencies referenced in viewer.html exist
echo ""
echo "  Verifying all <script> sources exist..."
missing_scripts=""
while IFS= read -r src; do
  # src is relative to web/ dir, e.g., "../lib/pdf-stream.js" or "viewer.js"
  resolved="$CUSTOM_DIR/web/$src"
  if [ ! -f "$resolved" ]; then
    missing_scripts="$missing_scripts $src"
  fi
done < <(grep -oP 'src="\K[^"]+' "$CUSTOM_DIR/web/viewer.html" 2>/dev/null || true)

if [ -z "$missing_scripts" ]; then
  check "2.3.2" "All script dependencies resolvable" "PASS" ""
else
  check "2.3.2" "All script dependencies resolvable" "FAIL" \
    "Missing scripts:$missing_scripts"
fi

# Check CSS reference exists
if [ -f "$CUSTOM_DIR/web/viewer.css" ]; then
  check "2.3.3" "Stylesheet exists (web/viewer.css)" "PASS" ""
else
  check "2.3.3" "Stylesheet exists (web/viewer.css)" "FAIL" \
    "Missing: $CUSTOM_DIR/web/viewer.css"
fi

# No server-side dependencies
echo ""
echo "  Checking for server-side dependencies..."
server_markers=0

for marker in "package.json" "node_modules" "requirements.txt" "Gemfile" "go.mod" "Cargo.toml" "composer.json"; do
  if [ -e "$CUSTOM_DIR/$marker" ]; then
    echo "    Found server-side marker: $marker"
    server_markers=$((server_markers + 1))
  fi
done

# Check for server-side code patterns in JS files
server_patterns=$(grep -rn 'require("http"\|require("express"\|require("koa"\|require("fs")' \
  "$CUSTOM_DIR/" 2>/dev/null || true)

if [ "$server_markers" -eq 0 ] && [ -z "$server_patterns" ]; then
  check "2.3.4" "No server-side runtime dependencies" "PASS" ""
else
  check "2.3.4" "No server-side runtime dependencies" "FAIL" \
    "Found $server_markers server-side markers"
fi

# Check file permissions are readable
non_readable=$(find "$CUSTOM_DIR" -type f ! -readable 2>/dev/null | head -5)
if [ -z "$non_readable" ]; then
  check "2.3.5" "All files are readable (servable)" "PASS" ""
else
  check "2.3.5" "All files are readable (servable)" "FAIL" \
    "Non-readable files found: $non_readable"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 2.10  Iframe-Safe Behavior
# ═══════════════════════════════════════════════════════════════════════════

divider
echo "2.10  Iframe-Safe Behavior"

VIEWER_JS="$CUSTOM_DIR/web/viewer.js"

if [ ! -f "$VIEWER_JS" ]; then
  check "2.10.1" "viewer.js exists" "FAIL" "Not found"
else
  # Check for iframe breakout patterns
  echo "  Scanning for iframe breakout patterns..."

  breakout_patterns=(
    'window\.top\b'
    'parent\.location'
    'top\.location'
    'window\.parent\b'
    'self\.location\s*='
    'document\.domain\s*='
    'window\.open\s*('
  )

  breakout_found=""
  for pattern in "${breakout_patterns[@]}"; do
    matches=$(grep -n "$pattern" "$VIEWER_JS" 2>/dev/null || true)
    if [ -n "$matches" ]; then
      breakout_found="$breakout_found\n    $pattern: $matches"
    fi
  done

  if [ -z "$breakout_found" ]; then
    check "2.10.1" "No iframe breakout patterns (window.top, parent.location, etc.)" "PASS" ""
  else
    check "2.10.1" "No iframe breakout patterns" "FAIL" \
      "Found breakout patterns:$breakout_found"
  fi

  # Check for history manipulation
  history_patterns=(
    'history\.pushState'
    'history\.replaceState'
    'history\.back'
    'history\.forward'
    'history\.go'
    'location\.hash\s*='
    'location\.href\s*='
    'location\.replace'
  )

  history_found=""
  for pattern in "${history_patterns[@]}"; do
    matches=$(grep -n "$pattern" "$VIEWER_JS" 2>/dev/null || true)
    if [ -n "$matches" ]; then
      history_found="$history_found\n    $pattern: $matches"
    fi
  done

  if [ -z "$history_found" ]; then
    check "2.10.2" "No history/location manipulation" "PASS" ""
  else
    check "2.10.2" "No history/location manipulation" "FAIL" \
      "Found history manipulation:$history_found"
  fi

  # Check for title manipulation
  title_manip=$(grep -n 'document\.title\s*=' "$VIEWER_JS" 2>/dev/null || true)
  if [ -z "$title_manip" ]; then
    check "2.10.3" "No document.title manipulation" "PASS" ""
  else
    check "2.10.3" "No document.title manipulation" "FAIL" \
      "Found: $title_manip"
  fi

  # Check for cookie access
  cookie_access=$(grep -n 'document\.cookie' "$VIEWER_JS" 2>/dev/null || true)
  if [ -z "$cookie_access" ]; then
    check "2.10.4" "No document.cookie access" "PASS" ""
  else
    check "2.10.4" "No document.cookie access" "FAIL" \
      "Found: $cookie_access"
  fi

  # Check for localStorage/sessionStorage
  storage_access=$(grep -n 'localStorage\|sessionStorage' "$VIEWER_JS" 2>/dev/null || true)
  if [ -z "$storage_access" ]; then
    check "2.10.5" "No localStorage/sessionStorage usage" "PASS" ""
  else
    check "2.10.5" "No localStorage/sessionStorage usage" "FAIL" \
      "Found: $storage_access"
  fi

  # Verify IIFE wrapping (doesn't leak globals)
  if head -40 "$VIEWER_JS" | grep -q '(function()'; then
    check "2.10.6" "Viewer code wrapped in IIFE (no global leaks)" "PASS" ""
  else
    check "2.10.6" "Viewer code wrapped in IIFE" "FAIL" \
      "viewer.js does not appear to use an IIFE wrapper"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Manual Items Reference
# ═══════════════════════════════════════════════════════════════════════════

divider
echo "Items Requiring Browser Testing (manual or Puppeteer)"
echo ""
echo "  [MANUAL] 2.1  — ?file= param loads PDF: open viewer.html?file=/path/to/test.pdf"
echo "  [MANUAL] 2.4  — Page navigation: click prev/next, type page number"
echo "  [MANUAL] 2.5  — Zoom controls: fit-width default, zoom in/out, presets"
echo "  [MANUAL] 2.6  — Loading indicator: visible during fetch, hidden after render"
echo "  [MANUAL] 2.7  — Error display: load invalid URL, verify error message shown"
echo "  [MANUAL] 2.8  — Multi-page scroll: load multi-page PDF, scroll through pages"
echo "  [MANUAL] 2.9  — Rotation handling: load PDF with /Rotate 90, verify orientation"
echo "  [MANUAL] 2.11 — Resize response: resize browser window, verify re-layout"
echo "  [MANUAL] 2.12 — Link annotations: load PDF with links, verify click behavior"

# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════

divider
echo "=== Summary ==="
echo ""
echo "  Automated checks:  $total"
echo "  Passed:            $pass"
echo "  Failed:            $fail"
echo "  Manual items:      9"
echo ""

if [ "$fail" -eq 0 ]; then
  echo "  All automated checks passed."
else
  echo "  $fail check(s) failed — review details above."
fi

echo ""
echo "  Suggested scores for automated items:"
echo "    2.2  Template path swap:      $( [ "$pass" -ge 4 ] && echo '5/5 — all checks pass' || echo 'Review failures' )"
echo "    2.3  Static file serving:     Review results above"
echo "    2.10 Iframe-safe behavior:    Review results above"
echo ""
