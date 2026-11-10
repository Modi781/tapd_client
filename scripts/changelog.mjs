#!/usr/bin/env node
// Generates docs/releases/v<version>.md and prepends the same section to
// CHANGELOG.md from the commits since the previous v* tag.
//
// Usage: node scripts/changelog.mjs 1.0.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
  console.error("usage: changelog.mjs <version>");
  process.exit(2);
}

const tag = `v${version}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let previous = "";
try {
  previous = git(["describe", "--tags", "--abbrev=0", "--match", "v*"]);
} catch {
  previous = "";
}

const range = previous ? `${previous}..HEAD` : "HEAD";
const raw = git(["log", range, "--no-merges", "--pretty=format:%s%x09%h"]);
const entries = raw
  .split("\n")
  .map((line) => line.split("\t"))
  .filter(([subject]) => subject && !subject.startsWith("chore(release)"));

const groups = [
  { title: "新功能", match: /^feat(\(|:)/ },
  { title: "修复", match: /^fix(\(|:)/ },
  { title: "性能与重构", match: /^(perf|refactor)(\(|:)/ },
  { title: "文档与构建", match: /^(docs|build|ci|test|style|chore)(\(|:)/ },
  { title: "其他", match: /.*/ },
];

const buckets = new Map(groups.map((group) => [group.title, []]));
for (const [subject, hash] of entries) {
  const group = groups.find((candidate) => candidate.match.test(subject)) ?? groups.at(-1);
  const clean = subject
    .replace(/^(feat|fix|perf|refactor|docs|build|ci|test|style|chore)(\([^)]*\))?:\s*/, "")
    .trim();
  buckets.get(group.title).push(`- ${clean} (${hash})`);
}

const today = new Date().toLocaleDateString("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const lines = [
  `# TAPD Client ${tag}`,
  "",
  `发布日期：${today}`,
  "",
];

for (const group of groups) {
  const items = buckets.get(group.title);
  if (!items?.length) continue;
  lines.push(`## ${group.title}`, "", ...items, "");
}

if (entries.length === 0) {
  lines.push("本版本没有用户可见的代码变更。", "");
}

const body = lines.join("\n").trimEnd() + "\n";

const releaseDir = path.join(root, "docs", "releases");
fs.mkdirSync(releaseDir, { recursive: true });
const releaseFile = path.join(releaseDir, `${tag}.md`);
fs.writeFileSync(releaseFile, body);

const changelogFile = path.join(root, "CHANGELOG.md");
const header = "# 更新日志\n\n";
let rest = "";
if (fs.existsSync(changelogFile)) {
  rest = fs.readFileSync(changelogFile, "utf8").replace(/^# 更新日志\s*/, "");
}
fs.writeFileSync(changelogFile, `${header}${body}\n${rest}`.replace(/\n{3,}/g, "\n\n"));

console.log(`wrote ${path.relative(root, releaseFile)} and CHANGELOG.md`);
if (previous) {
  console.log(`commits: ${previous}..HEAD (${entries.length})`);
} else {
  console.log(`commits: ${entries.length} (no previous tag)`);
}
