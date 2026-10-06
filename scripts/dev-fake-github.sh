#!/usr/bin/env bash
# `npm run dev`, but against a local fake GitHub (scripts/fake-github.mjs):
# no GitHub account, app or repository needed.
#
# The home page walks you through connecting to GitHub, exactly as in
# production: "Create GitHub App" (the fake's manifest page), then install it
# (on acme/diagrams and acme/platform). Sign in with any username ("viewer" =
# read-only, "outsider" = no access). See what mergit wrote with e.g.
#   curl http://127.0.0.1:8788/_log/acme/diagrams/main
#
# The fake keeps everything in memory: after restarting it, wipe mergit's
# local state too (rm -rf .wrangler/state) and set up again.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/fake-github.mjs &
FAKE=$!
trap 'kill $FAKE 2>/dev/null' EXIT
npm run build
npx wrangler dev --port 8787 \
  --var GITHUB_API_URL:http://127.0.0.1:8788 \
  --var GITHUB_WEB_URL:http://127.0.0.1:8788/web
