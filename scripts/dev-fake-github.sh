#!/usr/bin/env bash
# `npm run dev`, but with boards stored in a local fake GitHub (scripts/fake-github.mjs).
# No real token or repository needed: in "Connect GitHub", any token works and
# becomes your fake username ("alex" is @alex; "bad" is rejected).
# Inspect what was written with e.g.
#   curl http://127.0.0.1:8788/_log/acme/diagrams/main
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/fake-github.mjs &
FAKE=$!
trap 'kill $FAKE 2>/dev/null' EXIT
npm run build
npx wrangler dev --port 8787 \
  --var GITHUB_API_URL:http://127.0.0.1:8788 \
  --var GITHUB_WEB_URL:http://127.0.0.1:8788/web \
  --var GITHUB_DEFAULT_REPO:acme/diagrams
