"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { API_ROOT } = require("./helpers/workspace");

const a2uClient = fs.readFileSync(path.join(API_ROOT, "src/pi-a2u-client.js"), "utf8");
const legacyReviewEntry = fs.readFileSync(path.join(API_ROOT, "scripts/retire-legacy-a2u-route-review.js"), "utf8");

test("legacy A2U review entry remains disabled before the payout worker is called", () => {
  assert.match(a2uClient, /const MAINNET_A2U_OFFICIALLY_SUPPORTED = false;/);
  assert.match(a2uClient, /function a2uEnabled\(\)/);
  assert.match(legacyReviewEntry, /if \(!a2uEnabled\(\)\)/);
  assert.match(legacyReviewEntry, /no queue read or payout attempted/i);
  assert.ok(legacyReviewEntry.indexOf("if (!a2uEnabled())") < legacyReviewEntry.indexOf("await processApprovedWithdrawals"));
  assert.doesNotMatch(legacyReviewEntry, /\.createPayment\(|\.submitPayment\(|\.completePayment\(/);
});
