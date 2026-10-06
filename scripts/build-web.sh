#!/usr/bin/env bash
# Bundles the browser code into web/build and vendors Mermaid into web/vendor.
set -euo pipefail
cd "$(dirname "$0")/.."

# Mermaid stays a separate, lazily-chunked ESM build rather than part of our bundle.
if [[ ! -f web/vendor/mermaid/mermaid.esm.min.mjs ]]; then
  mkdir -p web/vendor/mermaid/chunks
  cp node_modules/mermaid/dist/mermaid.esm.min.mjs web/vendor/mermaid/
  cp -R node_modules/mermaid/dist/chunks/mermaid.esm.min web/vendor/mermaid/chunks/
  find web/vendor/mermaid -name '*.map' -delete
fi

npx esbuild client/home.js client/board.js \
  --bundle --format=esm --target=es2022 --minify --sourcemap \
  --external:/vendor/* --outdir=web/build --log-level=warning
