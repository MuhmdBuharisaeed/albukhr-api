"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { transform, gitBlobSha, EXPECTED_GIT_BLOB_SHA, checkSyntax } = require("../scripts/retire-legacy-a2u-route-review");

const fixture = `/* ALBUKHR Mainnet Core Financial Gateway
 * Full replacement — strict U2A payment verification and immutable term binding.
 * Existing withdrawal and A2U payout routes are retained.
 */
"use strict";
const express = require("express");
const { supabase } = require("./supabase-client");
const {
  createA2UPayment,
  getA2UPayment,
  getIncompleteA2UPayments,
  submitA2UPayment,
  completeA2UPayment
} = require("./pi-a2u-client");
const router = express.Router();
const MAINNET = "mainnet";
const activePayouts = new Set();
function paymentStatus(payment) { return String(payment?.status || ""); }
/*
 * A2U payout execution. Input is only withdrawal_request_id; the request's
 * amount, Pi UID, wallet, and status are read from authoritative Mainnet rows.
 */
async function executeWithdrawalPayout(withdrawalRequestId) {
 const { data: paidRow, error: paidError } = await supabase.from("withdrawal_requests").update({ status: "paid", txid: "fake" }).eq("id", withdrawalRequestId);
}
router.post("/api/pi-payment-approve", async (req, res) => {});
router.post("/api/withdrawal-request", async (req, res) => {});
router.post("/api/pay-withdrawal", async (req, res) => {
 const expected = String(process.env.OPERATIONS_API_KEY || "").trim();
 const supplied = String(req.headers["x-api-key"] || "").trim();
 const withdrawalRequestId = String(req.body.withdrawal_request_id || req.body.id || "").trim();
 const result = await executeWithdrawalPayout(withdrawalRequestId);
});
module.exports = { financialGatewayRouter: router, executeWithdrawalPayout };
`;

test("patch delegates the legacy route to the shared service", () => {
 const result = transform(fixture);
 assert.match(result, /executeWithdrawalPayout: executeSharedA2UPayout \} = require\("\.\/a2u-payout-service"\)/);
 assert.match(result, /await executeSharedA2UPayout\(withdrawalRequestId\)/);
 assert.match(result, /executeWithdrawalPayout: executeSharedA2UPayout/);
 assert.doesNotMatch(result, /\.from\("withdrawal_requests"\)\.update\(\{ status: "paid"/);
 assert.doesNotMatch(result, /activePayouts|createA2UPayment|getIncompleteA2UPayments/);
});

test("existing route count and operation key boundary are preserved", () => {
 const result = transform(fixture);
 assert.equal([...result.matchAll(/router\.post\(/g)].length, [...fixture.matchAll(/router\.post\(/g)].length);
 assert.match(result, /router\.post\("\/api\/withdrawal-request"/);
 assert.match(result, /router\.post\("\/api\/pay-withdrawal"/);
 assert.match(result, /OPERATIONS_API_KEY/);
 assert.match(result, /req\.headers\["x-api-key"\]/);
});

test("patch is idempotency-protected and refuses an already patched source", () => {
 assert.throws(() => transform(transform(fixture)), /already exists/);
});

test("transformed fixture passes Node syntax check", () => {
 checkSyntax(transform(fixture));
});

test("target baseline hash remains explicit and uses full Git blob format", () => {
 assert.match(EXPECTED_GIT_BLOB_SHA, /^[a-f0-9]{40}$/);
 assert.equal(gitBlobSha("same bytes"), gitBlobSha("same bytes"));
});
