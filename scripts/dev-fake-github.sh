#!/usr/bin/env bash
# `npm run dev`, but against a local fake GitHub (scripts/fake-github.mjs):
# no GitHub App or real repository needed.
#
# Sign in with any username ("viewer" = read-only, "outsider" = no access).
# The fake app is installed on acme/diagrams and acme/platform. Inspect what
# mergit wrote with e.g.  curl http://127.0.0.1:8788/_log/acme/diagrams/main
set -euo pipefail
cd "$(dirname "$0")/.."

# A throwaway GitHub App key pair, so App JWTs are really signed and verified.
KEYS=.wrangler/fake-github
mkdir -p "$KEYS"
if [[ ! -f "$KEYS/private.pem" ]]; then
  node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const fs = require("node:fs");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" }, // like the keys GitHub issues
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    fs.writeFileSync(process.argv[1] + "/private.pem", privateKey);
    fs.writeFileSync(process.argv[1] + "/public.pem", publicKey);
  ' "$KEYS"
fi

FAKE_APP_ID=12345 FAKE_APP_PUBLIC_KEY="$KEYS/public.pem" node scripts/fake-github.mjs &
FAKE=$!
trap 'kill $FAKE 2>/dev/null' EXIT
npm run build
npx wrangler dev --port 8787 \
  --var GITHUB_API_URL:http://127.0.0.1:8788 \
  --var GITHUB_WEB_URL:http://127.0.0.1:8788/web \
  --var GITHUB_APP_ID:12345 \
  --var GITHUB_APP_SLUG:mergit-dev \
  --var GITHUB_CLIENT_ID:fake-client \
  --var GITHUB_CLIENT_SECRET:fake-secret \
  --var "GITHUB_APP_PRIVATE_KEY:$(base64 < "$KEYS/private.pem" | tr -d '\n')"
