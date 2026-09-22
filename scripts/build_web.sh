#!/bin/sh
# Assemble dist/ for Convex static hosting: the page as-is plus a generated config.js.
# The static-hosting CLI sets VITE_CONVEX_URL for the deployment it uploads to.
set -eu
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
cp -R static dist/static
mv dist/static/index.html dist/index.html
# Static hosting serves /static/* with max-age=14400: without a new URL per deploy a
# browser keeps the old app.js for four hours after the page changed.
v=$(printf %s "${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || date +%s)}" | cut -c1-8)
sed -E "s#(/static/[A-Za-z0-9./_-]+\.(js|css))\"#\1?v=$v\"#g" dist/index.html > dist/index.html.tmp
mv dist/index.html.tmp dist/index.html
cat > dist/static/config.js <<JS
window.CONVEX_URL = "${VITE_CONVEX_URL:-${CONVEX_URL:-}}";
window.WORKER_URL = "${WORKER_URL:-}";
window.TELEGRAM_BOT_USERNAME = "${TELEGRAM_BOT_USERNAME:-}";
JS
echo "dist ready: $(find dist -type f | wc -l | tr -d ' ') files"
