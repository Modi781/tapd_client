#!/usr/bin/env bash
# Builds the tapd-mcp sidecar into src-tauri/binaries using the naming
# convention Tauri expects: <binary>-<target-triple>[.exe].
#
# Tauri's build script requires the external binary to exist even for
# `cargo check` / `cargo test`, so dev/check/test scripts call this first.
#
# Usage:
#   scripts/build-sidecar.sh                          # host, release
#   scripts/build-sidecar.sh --debug                  # host, debug
#   scripts/build-sidecar.sh aarch64-apple-darwin     # one target, release
#   scripts/build-sidecar.sh universal-apple-darwin   # lipo arm64 + x86_64
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"
HOST="$(rustc -vV | awk '/^host:/ {print $2}')"
PROFILE=release
# Cargo's "dev" profile lands in target/debug.
PROFILE_DIR=release
TARGETS=()

for arg in "$@"; do
  case "$arg" in
    --debug) PROFILE=dev; PROFILE_DIR=debug ;;
    *) TARGETS+=("$arg") ;;
  esac
done

mkdir -p "$OUT_DIR"

# build_one <target-or-empty>; empty means "host, no --target" so that
# `tauri dev` finds target/debug/tapd-mcp next to the app binary.
build_one() {
  local target="$1"
  local suffix="${target:-$HOST}"
  local base="$ROOT/target"

  echo "Building tapd-mcp for $suffix ($PROFILE)"
  if [[ -n "$target" ]]; then
    base="$base/$target"
    cargo build --profile "$PROFILE" -p tapd-mcp \
      --manifest-path "$ROOT/Cargo.toml" \
      --target "$target"
  else
    cargo build --profile "$PROFILE" -p tapd-mcp \
      --manifest-path "$ROOT/Cargo.toml"
  fi

  local src="$base/$PROFILE_DIR/tapd-mcp"
  local dest="$OUT_DIR/tapd-mcp-$suffix"
  cp "$src" "$dest"
  chmod +x "$dest"
  echo "  -> $dest"
}

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  build_one ""
else
  for target in "${TARGETS[@]}"; do
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
