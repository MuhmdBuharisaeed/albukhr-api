"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TEST_FILES = [
  "test/mainnet-financial-readiness.test.js",
  "test/published-term-projection.test.js",
  "test/project-updates-admin-access.test.js",
  "test/project-updates-cleanup-client.test.js",
  "test/project-updates-validation.test.js",
  "test/wallet-balance-service.test.js",
  "test/staking-policy-acceptance-core.test.js",
  "test/staking-duration-catalogue.test.js",
  "tests/a2u-reconciliation-inspector.test.js",
  "tests/a2u-reconciliation-router-transform.test.js",
  "tests/a2u-runtime-gate.test.js",
  "tests/a2u-source-gate.test.js",
  "tests/a2u-uncertain-outcome.test.js",
  "tests/admin-session-policy.test.js",
  "tests/current-schema-admin-contract.test.js",
  "tests/full-gateway-regression.test.js",
  "tests/legacy-route-patch.test.js",
  "tests/mainnet-identity-gateway.test.js",
  "tests/pi-client-auth.test.js",
  "tests/verify_patch.test.js",
  "tests/withdrawal-balance-model.test.js",
  "tests/withdrawal-history-contract.test.js"
];

const missing = TEST_FILES.filter((file) => !fs.existsSync(path.join(ROOT, file)));
if (missing.length) {
  console.error("[tests] Required API test files are missing:");
  for (const file of missing) console.error(`  - ${file}`);
  process.exit(2);
}

console.log(`[tests] Running ${TEST_FILES.length} API-local/offline test files.`);
console.log("[tests] Cross-repository assertions will be marked SKIP unless their exact companion roots are configured.");

const result = spawnSync(process.execPath, ["--test", ...TEST_FILES], {
  cwd: ROOT,
  env: process.env,
  encoding: "utf8",
  maxBuffer: 12 * 1024 * 1024
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error("[tests] Could not start the Node test runner:", result.error.message);
  process.exit(2);
}
process.exit(result.status === null ? 2 : result.status);
