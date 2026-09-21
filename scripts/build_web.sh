#!/bin/sh
# Assemble dist/ for Convex static hosting: the page as-is plus a generated config.js.
# The static-hosting CLI sets VITE_CONVEX_URL for the deployment it uploads to.
set -eu
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
cp -R static dist/static
mv dist/static/index.html dist/index.html
cat > dist/static/config.js <<JS
window.CONVEX_URL = "${VITE_CONVEX_URL:-${CONVEX_URL:-}}";
window.WORKER_URL = "${WORKER_URL:-}";
window.TELEGRAM_BOT_USERNAME = "${TELEGRAM_BOT_USERNAME:-}";
JS
echo "dist ready: $(find dist -type f | wc -l | tr -d ' ') files"
