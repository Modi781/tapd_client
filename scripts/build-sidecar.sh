#!/usr/bin/env bash
# Builds the tapd-mcp sidecar into src-tauri/binaries using the naming
# convention Tauri expects: <binary>-<target-triple>[.exe].
#
# Usage:
#   scripts/build-sidecar.sh                          # host target
#   scripts/build-sidecar.sh aarch64-apple-darwin     # one target
#   scripts/build-sidecar.sh universal-apple-darwin   # lipo arm64 + x86_64
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"
mkdir -p "$OUT_DIR"

build_one() {
  local target="$1"
  echo "Building tapd-mcp for $target"
  cargo build --release -p tapd-mcp \
    --manifest-path "$ROOT/Cargo.toml" \
    --target "$target"
  local src="$ROOT/target/$target/release/tapd-mcp"
  local dest="$OUT_DIR/tapd-mcp-$target"
  cp "$src" "$dest"
  chmod +x "$dest"
  echo "  -> $dest"
}

if [[ $# -eq 0 ]]; then
  host="$(rustc -vV | awk '/^host:/ {print $2}')"
  build_one "$host"
else
  for target in "$@"; do
    case "$target" in
      universal-apple-darwin)
        build_one aarch64-apple-darwin
        build_one x86_64-apple-darwin
        lipo -create \
          "$OUT_DIR/tapd-mcp-aarch64-apple-darwin" \
          "$OUT_DIR/tapd-mcp-x86_64-apple-darwin" \
          -output "$OUT_DIR/tapd-mcp-universal-apple-darwin"
        chmod +x "$OUT_DIR/tapd-mcp-universal-apple-darwin"
        lipo -info "$OUT_DIR/tapd-mcp-universal-apple-darwin"
        ;;
      *)
        build_one "$target"
        ;;
    esac
  done
fi
