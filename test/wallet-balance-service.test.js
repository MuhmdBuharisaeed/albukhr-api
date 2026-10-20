"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWalletSnapshot } = require("../src/wallet-balance-service");

const AS_OF = "2026-10-20T07:00:00.000Z";
function stake(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    network: "mainnet",
    project_code: "LABBAIKA",
    status: "active",
    amount: "100.0000000",
    reward_amount: "12.5000000",
    start_at: "2026-01-01T00:00:00.000Z",
    unlock_at: "2026-02-01T00:00:00.000Z",
    ...overrides
  };
}
function withdrawal(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    stake_id: "00000000-0000-4000-8000-000000000001",
    project_code: "LABBAIKA",
    network: "mainnet",
    withdrawal_type: "capital",
    requested_amount: "10.0000000",
    fee_amount: "0.1000000",
    net_amount: "10.0000000",
    status: "pending",
    txid: null,
    created_at: "2026-10-19T00:00:00.000Z",
    updated_at: "2026-10-19T00:00:00.000Z",
    ...overrides
  };
}
function snapshot(stakes = [stake()], withdrawals = [], registeredWalletAddress = "G-REGISTERED", asOf = AS_OF) {
  return buildWalletSnapshot({ stakes, withdrawals, registeredWalletAddress, asOf });
}

test("calculates principal and rewards without double-counting payments", () => {
  const result = snapshot([stake(), stake({ id: "00000000-0000-4000-8000-000000000002", amount: "50", reward_amount: "2", status: "cancelled" })]);
  assert.equal(result.summary.total_invested_principal_pi, 150);
  assert.equal(result.summary.active_principal_recorded_pi, 100);
  assert.equal(result.summary.recorded_reward_total_pi, 12.5);
});

test("reserves requested amount plus fee for pending and approved; paid remains deducted", () => {
  const rows = [
    withdrawal({ id: "w1", status: "pending", requested_amount: "10", fee_amount: "0.1" }),
    withdrawal({ id: "w2", status: "approved", requested_amount: "5", fee_amount: "0.05", net_amount: "5" }),
    withdrawal({ id: "w3", status: "paid", requested_amount: "20", fee_amount: "0.2", net_amount: "20" }),
    withdrawal({ id: "w4", status: "rejected", requested_amount: "30", fee_amount: "0.3" })
  ];
  const result = snapshot([stake()], rows);
  assert.equal(result.positions[0].capital_remaining_after_existing_requests_pi, 64.65);
  assert.equal(result.positions[0].capital_requestable_pi, 64.65);
  assert.equal(result.summary.pending_withdrawal_to_user_pi, 15);
  assert.equal(result.summary.pending_withdrawal_fee_pi, 0.15);
  assert.equal(result.summary.pending_total_deduction_pi, 15.15);
  assert.equal(result.summary.withdrawals_paid_to_user_pi, 20);
  assert.equal(result.summary.withdrawal_fees_paid_pi, 0.2);
  assert.equal(result.summary.open_withdrawal_requests_count, 2);
});

test("not-yet-matured positions have zero requestable amount", () => {
  const result = snapshot([stake({ unlock_at: "2026-12-01T00:00:00.000Z" })]);
  assert.equal(result.positions[0].is_matured, false);
  assert.equal(result.positions[0].capital_requestable_pi, 0);
  assert.ok(result.positions[0].eligibility_issue_codes.includes("position_not_matured"));
});

test("capital_withdrawn reward is withheld for review and never shown requestable", () => {
  const result = snapshot([stake({ status: "capital_withdrawn", amount: "100", reward_amount: "12.5" })]);
  assert.equal(result.summary.closed_position_rewards_held_for_review_pi, 12.5);
  assert.equal(result.positions[0].reward_requestable_pi, 0);
  assert.ok(result.positions[0].eligibility_issue_codes.includes("capital_withdrawn_reward_review_required"));
});

test("missing registered address blocks requestable totals but preserves recorded balances", () => {
  const result = snapshot([stake()], [], null);
  assert.equal(result.summary.total_invested_principal_pi, 100);
  assert.equal(result.summary.recorded_reward_total_pi, 12.5);
  assert.equal(result.summary.total_requestable_pi, 0);
  assert.equal(result.withdrawal_destination.status, "missing");
  assert.ok(result.positions[0].eligibility_issue_codes.includes("registered_wallet_address_missing"));
});

test("empty account returns a well-formed zero snapshot", () => {
  const result = snapshot([], [], null);
  assert.equal(result.summary.total_invested_principal_pi, 0);
  assert.equal(result.summary.total_requestable_pi, 0);
  assert.equal(result.positions.length, 0);
  assert.equal(result.recent_withdrawals.length, 0);
});

test("rejects Testnet or missing network rows in Mainnet source data", () => {
  assert.throws(() => snapshot([stake({ network: "testnet" })]), /non-Mainnet stake/);
  assert.throws(() => snapshot([stake({ network: undefined })]), /non-Mainnet stake/);
  assert.throws(() => snapshot([stake()], [withdrawal({ network: "testnet" })]), /non-Mainnet withdrawal/);
});

test("rejects unknown withdrawal and stake statuses rather than overstating balance", () => {
  assert.throws(() => snapshot([stake()], [withdrawal({ status: "processing_unknown" })]), /unsupported status/);
  assert.throws(() => snapshot([stake({ status: "unknown" })]), /unsupported status/);
});

test("does not leak raw DB-only fields into response positions", () => {
  const result = snapshot([stake({ pi_uid: "PRIVATE_UID", user_id: "PRIVATE_USER", wallet_address: "PRIVATE_DEST" })]);
  assert.equal("pi_uid" in result.positions[0], false);
  assert.equal("user_id" in result.positions[0], false);
  assert.equal("wallet_address" in result.positions[0], false);
});

test("reward requests reserve reward balance independently from principal", () => {
  const result = snapshot([stake()], [
    withdrawal({ withdrawal_type: "reward", requested_amount: "2.1234567", fee_amount: "0.0212346", net_amount: "2.1234567" })
  ]);
  assert.equal(result.positions[0].capital_requestable_pi, 100);
  assert.equal(result.positions[0].reward_remaining_after_existing_requests_pi, 10.3553087);
  assert.equal(result.positions[0].reward_requestable_pi, 10.3553087);
});

test("cancelled withdrawal does not reserve balance; fixed-point handles seven decimals", () => {
  const result = snapshot([stake({ amount: "0.1234567", reward_amount: "0.0000001" })], [
    withdrawal({ requested_amount: "0.1000000", fee_amount: "0.0100000", status: "cancelled" })
  ]);
  assert.equal(result.positions[0].capital_remaining_after_existing_requests_pi, 0.1234567);
  assert.equal(result.summary.total_requestable_pi, 0.1234568);
});
