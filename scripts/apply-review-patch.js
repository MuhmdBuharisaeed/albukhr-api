"use strict";

/*
 * Safe, explicit patch applicator.
 * Default is DRY RUN. No files are changed unless --apply is supplied.
 * Baseline SHA-1 checks use Git blob hashing and refuse to overwrite drifted files.
 * This script does NOT execute the SQL migration, call Pi APIs, commit, or deploy.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const bundleRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(process.argv[2] || process.cwd());
const apply = process.argv.includes("--apply");

const expectedBlobSha = {
  "src/financial-gateway.js": "0fba8784a1bb76eb2c58e8ebeb9ac3b71bcbb377",
  "src/pi-a2u-client.js": "7dc4626e872ee0e4db67cf7d034e99e9b933a07e",
  "src/a2u-worker.js": "e4fb872318bc5dbfee27e6db56c122e49508d2c6",
  "scripts/a2u-payout-cron.js": "3faff6734254da6f822507e0dee9e38d56f2a0e8",
  "package.json": "8fdae094ae29b6645f640136beba30f2a470fc28"
};

function gitBlobSha(text) {
  const bytes = Buffer.from(text, "utf8");
  return crypto.createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function readRepo(relativePath) {
  const absolute = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`Required baseline file is missing: ${relativePath}`);
  }
  return fs.readFileSync(absolute, "utf8");
}

function readBundle(relativePath) {
  const absolute = path.join(bundleRoot, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`Patch payload is missing: ${relativePath}`);
  }
  return fs.readFileSync(absolute, "utf8");
}

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Expected exactly one matching anchor for ${label}; no changes were written.`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

function prepareFinancialGateway(source) {
  if (source.includes('require("./a2u-payout-service")')) {
    throw new Error("financial-gateway.js appears already patched; refusing to apply twice.");
  }
  const oldImport = [
    'const {',
    '  createA2UPayment,',
    '  getA2UPayment,',
    '  getIncompleteA2UPayments,',
    '  submitA2UPayment,',
    '  completeA2UPayment',
    '} = require("./pi-a2u-client");'
  ].join("\n");
  const newImport = 'const { executeWithdrawalPayout: executeSafeA2UWithdrawalPayout } = require("./a2u-payout-service");';
  let result = replaceOnce(source, oldImport, newImport, "A2U client import block");

  const startMarker = "async function executeWithdrawalPayout(withdrawalRequestId) {";
  const endMarker = '\nrouter.post("/api/pi-payment-approve"';
  const startIndex = result.indexOf(startMarker);
  const endIndex = result.indexOf(endMarker, startIndex + startMarker.length);
  if (startIndex < 0 || endIndex < 0 || result.indexOf(startMarker, startIndex + startMarker.length) >= 0) {
    throw new Error("Could not identify the unique payout function boundaries; no changes were written.");
  }
  const replacement = [
    'async function executeWithdrawalPayout(withdrawalRequestId) {',
    '  return executeSafeA2UWithdrawalPayout(withdrawalRequestId);',
    '}',
    ''
  ].join("\n");
  result = result.slice(0, startIndex) + replacement + result.slice(endIndex + 1);
  return result;
}

function preparePackageJson(source) {
  const pkg = JSON.parse(source);
  if (!pkg.dependencies || typeof pkg.dependencies !== "object") {
    throw new Error("package.json dependencies object is missing.");
  }
  pkg.dependencies["pi-backend"] = "0.1.3";
  const checks = String(pkg.scripts?.check || "").split(" && ").filter(Boolean);
  for (const command of [
    "node --check src/pi-a2u-client.js",
    "node --check src/a2u-payout-service.js",
    "node --check src/a2u-worker.js",
    "node --check scripts/a2u-payout-cron.js"
  ]) {
    if (!checks.includes(command)) checks.push(command);
  }
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.check = checks.join(" && ");
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function main() {
  const baseline = {};
  for (const [relativePath, expectedSha] of Object.entries(expectedBlobSha)) {
    const source = readRepo(relativePath);
    const actualSha = gitBlobSha(source);
    if (actualSha !== expectedSha) {
      throw new Error(
        `Baseline changed for ${relativePath}. Expected Git blob ${expectedSha}, got ${actualSha}. ` +
        "Stop and re-review the current file before applying this patch."
      );
    }
    baseline[relativePath] = source;
  }

  const outputs = new Map();
  outputs.set("src/financial-gateway.js", prepareFinancialGateway(baseline["src/financial-gateway.js"]));
  outputs.set("package.json", preparePackageJson(baseline["package.json"]));
  for (const relativePath of [
    "src/pi-a2u-client.js",
    "src/a2u-payout-service.js",
    "src/a2u-worker.js",
    "scripts/a2u-payout-cron.js"
  ]) {
    outputs.set(relativePath, readBundle(relativePath));
  }

  console.log(`Target repository: ${repoRoot}`);
  console.log("Verified exact expected Git blob hashes for five original files.");
  console.log("Prepared changes:");
  for (const relativePath of outputs.keys()) console.log(`  - ${relativePath}`);
  console.log("Not changed: server.js, render.yaml, Supabase data/schema, Render env, live deployment.");
  console.log("SQL migration stays review-only in sql/20261017_prepare_a2u_payout_safety_v3.sql.");

  if (!apply) {
    console.log("DRY RUN ONLY: no files were written. Add --apply only after reviewing the bundle.");
    return;
  }

  // Validate and transform every target before the first write.
  for (const [relativePath, content] of outputs) {
    const absolute = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  }
  console.log("Local source files updated. No SQL, Pi payment, Git commit, or deployment was performed.");
}

try {
  main();
} catch (error) {
  console.error(`[A2U review patch] ${error.message}`);
  process.exitCode = 1;
}
