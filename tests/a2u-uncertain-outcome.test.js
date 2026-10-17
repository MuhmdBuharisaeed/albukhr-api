"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const servicePath = path.resolve(__dirname, "../src/a2u-payout-service.js");
const originalLoad = Module._load;
const withdrawalId = "wd-test-0001";
const attemptId = "attempt-test-0001";
const leaseToken = "lease-test-token";
const piUid = "pi-test-user";
const paymentId = "pi-payment-test-0001";

const requestRow = {
  id: withdrawalId,
  stake_id: "stake-test-0001",
  user_id: "user-test-0001",
  pi_uid: piUid,
  project_id: "project-test-0001",
  project_code: "TESTPROJECT",
  network: "mainnet",
  withdrawal_type: "capital",
  requested_amount: 10,
  fee_rate: 0.01,
  fee_amount: 0.1,
  net_amount: 10,
  wallet_address: "G" + "A".repeat(55),
  status: "approved",
  txid: null
};
const stakeRow = {
  id: requestRow.stake_id,
  project_id: requestRow.project_id,
  project_code: requestRow.project_code,
  user_id: requestRow.user_id,
  pi_uid: piUid,
  network: "mainnet",
  amount: 100,
  duration_days: 30,
  reward_amount: 10,
  status: "matured",
  unlock_at: "2020-01-01T00:00:00.000Z"
};
const noTxPayment = {
  identifier: paymentId,
  user_uid: piUid,
  amount: 10,
  memo: `ALBUKHR-WD:${withdrawalId}`,
  direction: "app_to_user",
  network: "Pi Network",
  metadata: { source: "albukhr-api", network: "mainnet", withdrawal_request_id: withdrawalId },
  to_address: requestRow.wallet_address,
  status: { cancelled: false, user_cancelled: false, transaction_verified: false, developer_completed: false },
  transaction: null
};

async function scenario(claimRow, shouldHavePaymentId) {
  let createCalls = 0;
  let submitCalls = 0;
  const calls = [];
  const supabase = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "claim_a2u_withdrawal_payout_v2") return { data: [claimRow], error: null };
      if (name === "record_a2u_withdrawal_payout_progress_v2") return { data: true, error: null };
      if (name === "fail_a2u_withdrawal_payout_v2") return { data: true, error: null };
      throw new Error(`Unexpected RPC in test: ${name}`);
    },
    from(table) {
      const query = {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          if (table === "withdrawal_requests") return { data: requestRow, error: null };
          if (table === "stakes") return { data: stakeRow, error: null };
          throw new Error(`Unexpected table in test: ${table}`);
        }
      };
      return query;
    }
  };
  const piClient = {
    a2uEnabled: () => true,
    async createA2UPayment() { createCalls += 1; return { payment_id: paymentId }; },
    async getA2UPayment() { return noTxPayment; },
    async getIncompleteA2UPayments() { return []; },
    async submitA2UPayment() { submitCalls += 1; return "txid-test"; },
    async completeA2UPayment() { throw new Error("must not complete in uncertain-outcome test"); }
  };
  const originalIsLoaded = require.cache[servicePath];
  delete require.cache[servicePath];
  Module._load = function(request, parent, isMain) {
    if (parent && parent.filename === servicePath && request === "./supabase-client") return { supabase };
    if (parent && parent.filename === servicePath && request === "./pi-a2u-client") return piClient;
    if (parent && parent.filename === servicePath && request === "stellar-sdk") {
      return { StrKey: { isValidEd25519PublicKey: () => true } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let executeWithdrawalPayout;
  try {
    ({ executeWithdrawalPayout } = require(servicePath));
  } finally {
    Module._load = originalLoad;
  }

  try {
    await assert.rejects(
      executeWithdrawalPayout(withdrawalId),
      (error) => error && [
        "A2U_PAYMENT_CREATION_OUTCOME_UNCERTAIN",
        "A2U_SUBMISSION_OUTCOME_UNCERTAIN"
      ].includes(error.code)
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[servicePath];
    if (originalIsLoaded) require.cache[servicePath] = originalIsLoaded;
  }

  assert.equal(createCalls, 0, "an uncertain creation result must not create a duplicate payment");
  assert.equal(submitCalls, 0, "an uncertain submission result must not submit another transaction");
  assert.ok(calls.some((call) => call.name === "fail_a2u_withdrawal_payout_v2"), "failed claims should be released while preserving uncertainty markers");
  if (shouldHavePaymentId) assert.ok(calls.some((call) => call.name === "claim_a2u_withdrawal_payout_v2"));
}

(async () => {
  await scenario({
    claimed: true,
    reason: "claimed",
    attempt_id: attemptId,
    lease_token: leaseToken,
    payment_id: paymentId,
    txid: null,
    payment_creation_started_at: null,
    submission_started_at: "2026-10-17T00:00:00Z"
  }, true);
  await scenario({
    claimed: true,
    reason: "claimed",
    attempt_id: attemptId,
    lease_token: leaseToken,
    payment_id: null,
    txid: null,
    payment_creation_started_at: "2026-10-17T00:00:00Z",
    submission_started_at: null
  }, false);
  console.log("A2U uncertainty tests passed. No Pi API or blockchain transaction was called.");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
