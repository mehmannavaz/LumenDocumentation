#!/usr/bin/env bash
# ============================================================
# LUMEN — build script
# Concatenates the src/ parts into a single self-contained
# HTML file: Lumen_documentation.html
#
#   src/01-head.html     doctype, <head>, meta, font links
#   src/02-styles.css    all CSS (wrapped in <style>)
#   src/03-body.html     </head>, <body>, app markup, modals
#   src/04-libs.js       offline-capable CDN library loader
#   src/05-engine.js     the Lumen engine (vanilla JS)
#   src/06-content.js    default documentation pages
#   src/07-tail.html     boot script, </body></html>
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

OUT="Lumen_documentation.html"

{
  cat src/01-head.html
  echo '<style>'
  cat src/02-styles.css
  echo '</style>'
  cat src/03-body.html
  echo '<script>'
  cat src/04-libs.js
  echo '</script>'
  echo ''
  echo '<!-- ENGINE + DOCUMENTATION CONTENT -->'
  echo '<script id="lumen-engine">'
  cat src/05-engine.js
  echo '</script>'
  echo ''
  echo '<!-- DEFAULT DOCUMENTATION CONTENT -->'
  echo '<script>'
  cat src/06-content.js
  echo '</script>'
  echo ''
  cat src/07-tail.html
} > "$OUT"

echo "Built $OUT ($(wc -c < "$OUT") bytes, $(wc -l < "$OUT") lines)"
