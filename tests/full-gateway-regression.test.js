"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const gatewayPath = path.resolve(__dirname, "../src/financial-gateway.js");
const source = fs.readFileSync(gatewayPath, "utf8");

test("full patched gateway mounts trusted read-only inspector and shared payout service", () => {
  assert.match(source, /require\("\.\/a2u-reconciliation-router"\)/);
  assert.match(source, /router\.use\(a2uReconciliationRouter\)/);
  assert.match(source, /require\("\.\/a2u-payout-service"\)/);
  assert.match(source, /executeSharedA2UPayout\(withdrawalRequestId\)/);
});

test("U2A/Core and contributor withdrawal request routes are preserved", () => {
  for (const route of [
    'router.post("/api/pi-payment-approve",',
    'router.post("/api/pi-payment-complete",',
    'router.get("/api/my-stakes",',
    'router.post("/api/withdrawal-request",',
    'router.post("/api/pay-withdrawal",'
  ]) assert.ok(source.includes(route), `missing route: ${route}`);
});

test("legacy direct payout implementation and process-local payout lock are absent", () => {
  assert.doesNotMatch(source, /const activePayouts = new Set\(\)/);
  assert.doesNotMatch(source, /const \{\s*createA2UPayment,[\s\S]*?\} = require\("\.\/pi-a2u-client"\)/);
  assert.doesNotMatch(source, /\.from\("withdrawal_requests"\)\s*\.update\(\{\s*status:\s*"paid"/);
});

test("operations API-key boundary and compatibility export remain", () => {
  assert.match(source, /process\.env\.OPERATIONS_API_KEY/);
  assert.match(source, /req\.headers\["x-api-key"\]/);
  assert.match(source, /executeWithdrawalPayout:\s*executeSharedA2UPayout/);
});
