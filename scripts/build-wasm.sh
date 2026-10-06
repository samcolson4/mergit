#!/usr/bin/env bash
# Builds mergit-core to WebAssembly and copies it into web/pkg.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v rustup >/dev/null || [[ -x /opt/homebrew/opt/rustup/bin/rustup ]]; then
  PATH="/opt/homebrew/opt/rustup/bin:$PATH" rustup target list --installed | grep -q wasm32-unknown-unknown \
    || PATH="/opt/homebrew/opt/rustup/bin:$PATH" rustup target add wasm32-unknown-unknown
fi

scripts/cargo.sh build --manifest-path core/Cargo.toml --release --target wasm32-unknown-unknown
mkdir -p web/pkg
cp core/target/wasm32-unknown-unknown/release/mergit_core.wasm web/pkg/
echo "web/pkg/mergit_core.wasm  $(wc -c < web/pkg/mergit_core.wasm | tr -d ' ') bytes"
