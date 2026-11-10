#!/usr/bin/env node
// Builds the Tauri v2 updater manifest published as latest.json on a release.
//
// Usage:
//   node scripts/make-latest-json.mjs \
//     --version 1.0.0 --tag v1.0.0 \
//     --asset TAPD.Client_1.0.0_aarch64.app.tar.gz \
//     --signature dist-release/TAPD.Client_1.0.0_aarch64.app.tar.gz.sig \
//     --notes docs/releases/v1.0.0.md \
//     --out dist-release/latest.json

import fs from "node:fs";
import path from "node:path";

const REPO = "wwog/tapd_client";

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      out[key.slice(2)] = "true";
      continue;
    }
    out[key.slice(2)] = value;
    index += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const version = args.version;
const tag = args.tag;
const asset = args.asset;
const signaturePath = args.signature;
const notesPath = args.notes;
const outPath = args.out ?? "latest.json";

if (!version || !tag || !asset || !signaturePath) {
  console.error(
    "usage: make-latest-json.mjs --version <v> --tag <vTag> --asset <file> --signature <file> [--notes <file>] [--out <file>]",
  );
  process.exit(2);
}

if (!fs.existsSync(signaturePath)) {
  console.error(`signature not found: ${signaturePath}`);
  process.exit(1);
}

const signature = fs.readFileSync(signaturePath, "utf8").trim();
if (!signature) {
  console.error(`signature is empty: ${signaturePath}`);
  process.exit(1);
}

const notes = notesPath && fs.existsSync(notesPath)
  ? fs.readFileSync(notesPath, "utf8").trim()
  : `TAPD Client ${tag}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature,
      url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(asset)}`,
    },
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath} (${version}, darwin-aarch64)`);
