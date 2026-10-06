#!/usr/bin/env bash
# Runs cargo from a rustup-managed toolchain when one exists (Homebrew's
# keg-only rustup included); plain Homebrew `rust` has no wasm32 target.
for p in /opt/homebrew/opt/rustup/bin /usr/local/opt/rustup/bin "$HOME/.cargo/bin"; do
  [[ -x "$p/rustup" ]] && export PATH="$p:$PATH" && break
done
exec cargo "$@"
