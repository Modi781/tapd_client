#!/usr/bin/env bash
# Builds the tapd-mcp sidecar into src-tauri/binaries using the naming
# convention Tauri expects: <binary>-<target-triple> (macOS only; Windows
# would append .exe).
#
# Tauri's build script requires the external binary to exist even for
# `cargo check` / `cargo test`, so dev/check/test scripts call this first.
#
# The destination name does not encode the profile: a --debug build overwrites
# the same file as a release build. Always go through `pnpm build` before
# `tauri build`, or the last dev-built sidecar may end up in the bundle.
#
# Usage:
#   scripts/build-sidecar.sh                          # host, release
#   scripts/build-sidecar.sh --debug                  # host, debug
#   scripts/build-sidecar.sh aarch64-apple-darwin     # one target, release
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"
HOST="$(rustc -vV | awk '/^host:/ {print $2}')"
# Respect CARGO_TARGET_DIR; like cargo, resolve a relative path against the
# directory this script was invoked from.
TARGET_ROOT="${CARGO_TARGET_DIR:-$ROOT/target}"
[[ "$TARGET_ROOT" = /* ]] || TARGET_ROOT="$PWD/$TARGET_ROOT"
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
  # CARGO_BUILD_TARGET moves host artifacts into target/<triple>/<profile> and
  # changes the sidecar suffix Tauri looks for, so treat it as an explicit target.
  if [[ -z "$target" && -n "${CARGO_BUILD_TARGET:-}" ]]; then
    target="$CARGO_BUILD_TARGET"
  fi
  local suffix="${target:-$HOST}"
  local base="$TARGET_ROOT"

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
  if [[ ! -f "$src" ]]; then
    echo "error: sidecar not found at $src" >&2
    echo "hint: check CARGO_TARGET_DIR / CARGO_BUILD_TARGET and the target list" >&2
    exit 1
  fi
  cp "$src" "$dest"
  chmod +x "$dest"
  echo "  -> $dest"
  if [[ "$PROFILE" == dev ]]; then
    echo "  note: dev-profile binary; run 'pnpm build' before 'tauri build'"
  fi
}

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  build_one ""
else
  for target in "${TARGETS[@]}"; do
    build_one "$target"
  done
fi
