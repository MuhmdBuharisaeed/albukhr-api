"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const REQUIRED_DIRS = [
  "ALBUKHR_SQL_DIR",
  "ALBUKHR_ADMIN_DIR",
  "ALBUKHR_APP_REPO_DIR",
  "ALBUKHR_APP_DIR",
  "ALBUKHR_DATABASE_DIR"
];
const missing = REQUIRED_DIRS.filter((name) => {
  const value = String(process.env[name] || "").trim();
  return !value || !fs.existsSync(path.resolve(value)) || !fs.statSync(path.resolve(value)).isDirectory();
});

if (missing.length) {
  console.log("[cross-repo] NOT RUN — companion repositories are not fully configured.");
  console.log("[cross-repo] Set the following environment variables to their exact local directories:");
  for (const name of missing) console.log(`  - ${name}`);
  console.log("[cross-repo] No production, Supabase, Pi or Testnet requests were made.");
  process.exit(0);
}

const apiRoot = process.env.ALBKHR_API_DIR ? path.resolve(process.env.ALBKHR_API_DIR) : ROOT;
const fileChecks = [
  ["ALBUKHR_SQL_DIR", "NOT_READY_DO_NOT_APPLY_ALBUKHR_A2U_SQL_CANDIDATE_v6.sql"],
  ["ALBUKHR_SQL_DIR", "APPLIED_20261017_add_withdrawal_a2u_queue_safety_flags_and_reconciliation.sql"],
  ["ALBUKHR_SQL_DIR", "APPLIED_20261017_fix_withdrawal_admin_authorization_and_manual_payout_guard.sql"],
  ["ALBUKHR_ADMIN_DIR", "admin-withdrawals.js"],
  ["ALBUKHR_APP_REPO_DIR", "external-project-funding.html"],
  ["ALBUKHR_APP_DIR", "withdraw.html"],
  ["ALBUKHR_DATABASE_DIR", "EXTERNAL_PROJECT_OWNER_FUNDING_TRUSTED_RPC_DRAFT.sql"]
];
const missingFiles = fileChecks.filter(([envName, fileName]) => {
  const directory = path.resolve(process.env[envName]);
  const file = path.join(directory, fileName);
  return !fs.existsSync(file) || !fs.statSync(file).isFile();
});
if (missingFiles.length) {
  console.log("[cross-repo] NOT RUN — configured roots do not contain every required contract file:");
  for (const [envName, fileName] of missingFiles) console.log(`  - ${envName}/${fileName}`);
  process.exit(0);
}

const files = [
  "tests/a2u-source-gate.test.js",
  "tests/current-schema-admin-contract.test.js",
  "tests/verify_patch.test.js",
  "tests/withdrawal-balance-model.test.js",
  "tests/withdrawal-history-contract.test.js"
];
for (const file of files) {
  if (!fs.existsSync(path.join(ROOT, file))) {
    console.error(`[cross-repo] Required test file missing: ${file}`);
    process.exit(2);
  }
}

console.log("[cross-repo] Running companion-repository contracts with explicitly configured roots.");
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: ROOT,
  env: process.env,
  encoding: "utf8",
  maxBuffer: 12 * 1024 * 1024
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error("[cross-repo] Could not start Node test runner:", result.error.message);
  process.exit(2);
}
process.exit(result.status === null ? 2 : result.status);
