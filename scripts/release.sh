#!/usr/bin/env bash
# Cuts a release: bumps every version field, writes the changelog, commits on
# `main`, fast-forwards `release` from `main`, tags and pushes both branches
# plus the tag. Pushing the tag makes GitHub Actions publish the dmg, the
# signed updater bundle and latest.json.
#
# Usage:
#   scripts/release.sh 1.0.0
#   scripts/release.sh 1.0.0 --no-push     # prepare the commit locally only
#
# The tree must be clean and the current branch must be `main`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
PUSH=1
if [[ "${2:-}" == "--no-push" ]]; then
  PUSH=0
fi

if [[ -z "$VERSION" ]]; then
  echo "usage: scripts/release.sh <version> [--no-push]" >&2
  exit 2
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must look like 1.0.0 (got '$VERSION')" >&2
  exit 2
fi

TAG="v$VERSION"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean; commit or stash first" >&2
  git status --short >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "error: releases are cut from main (current: $BRANCH)" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "error: tag $TAG already exists" >&2
  exit 1
fi

echo "==> Bumping versions to $VERSION"
node - "$VERSION" <<'NODE'
const fs = require("node:fs");
const version = process.argv[2];
for (const file of ["package.json", "apps/desktop/package.json"]) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = version;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
const tauriConf = "apps/desktop/src-tauri/tauri.conf.json";
const conf = JSON.parse(fs.readFileSync(tauriConf, "utf8"));
conf.version = version;
fs.writeFileSync(tauriConf, `${JSON.stringify(conf, null, 2)}\n`);
NODE

perl -0pi -e 's/(\[workspace\.package\][\s\S]*?^version = )"[^"]+"/$1"'"$VERSION"'"/m' Cargo.toml

echo "==> Refreshing Cargo.lock"
if ! cargo update -w --offline >/dev/null 2>&1; then
  cargo update -w >/dev/null
fi

echo "==> Writing changelog"
node scripts/changelog.mjs "$VERSION"

git add -A
git commit -m "chore(release): $TAG"

if [[ "$PUSH" -eq 0 ]]; then
  echo "==> Prepared $TAG locally (--no-push)."
  echo "    commit: $(git rev-parse --short HEAD)"
  exit 0
fi

echo "==> Pushing main"
git push origin main

echo "==> Merging main into release"
git checkout release
if ! git merge --ff-only main; then
  echo "    release diverged from main; merging instead"
  git merge --no-edit main
fi
git push origin release
git checkout main

echo "==> Tagging $TAG"
git tag -a "$TAG" -m "TAPD Client $TAG"
git push origin "$TAG"

echo "==> Done. GitHub Actions will publish the release for $TAG."
echo "    Watch: https://github.com/wwog/tapd_client/actions"
