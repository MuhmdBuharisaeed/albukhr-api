"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SEARCH_DIRS = ["src", "scripts", "test", "tests"];
const ROOT_FILES = ["server.js"];
const EXCLUDED_DIRS = new Set([".git", "node_modules", "coverage", "dist", "build"]);

function collectJavaScriptFiles(directory, result = []) {
  if (!fs.existsSync(directory)) return result;
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        collectJavaScriptFiles(path.join(directory, entry.name), result);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      result.push(path.join(directory, entry.name));
    }
  }
  return result;
}

const files = [];
for (const relative of ROOT_FILES) {
  const file = path.join(ROOT, relative);
  if (fs.existsSync(file)) files.push(file);
}
for (const relative of SEARCH_DIRS) {
  collectJavaScriptFiles(path.join(ROOT, relative), files);
}

if (files.length === 0) {
  console.error("[syntax] No JavaScript files found. Check that this script is run from the API repository root.");
  process.exit(2);
}

files.sort();
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`\n[syntax] FAIL ${path.relative(ROOT, file)}`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

if (failed) {
  console.error(`\n[syntax] ${failed}/${files.length} JavaScript files failed syntax validation.`);
  process.exit(1);
}

console.log(`[syntax] PASS — ${files.length} JavaScript files parsed successfully.`);
