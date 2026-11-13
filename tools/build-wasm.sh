#!/usr/bin/env bash
# Build src/sluice.c into a freestanding wasm32 module.
#
# Needs only clang with the wasm32 target and rust-lld (shipped with the Rust
# toolchain, usable as a generic wasm linker). No emscripten, no wabt, no libc.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
mkdir -p "$BUILD"

find_rust_lld() {
  local cand
  if [ -n "${RUST_LLD:-}" ]; then printf '%s\n' "$RUST_LLD"; return; fi
  for cand in "$HOME"/.rustup/toolchains/*/lib/rustlib/*/bin/rust-lld; do
    [ -x "$cand" ] && { printf '%s\n' "$cand"; return; }
  done
  command -v wasm-ld || true
}

LLD="$(find_rust_lld)"
if [ -z "$LLD" ]; then
  echo "error: no wasm linker found (install lld or a Rust toolchain)" >&2
  exit 1
fi

clang --target=wasm32 -O2 -std=c99 -nostdlib -ffreestanding -fno-builtin \
  -Wall -Wextra -Werror \
  -c "$ROOT/src/sluice.c" -o "$BUILD/sluice.o"

"$LLD" -flavor wasm --no-entry --strip-all \
  --export-memory --initial-memory=16777216 --max-memory=134217728 \
  --export=ssort --export=arr_ptr --export=trace_ptr --export=trace_len \
  --export=cmp_total --export=swap_total --export=max_n \
  -o "$BUILD/sluice.wasm" "$BUILD/sluice.o"

printf 'built %s (%s bytes)\n' "$BUILD/sluice.wasm" "$(stat -c%s "$BUILD/sluice.wasm")"
