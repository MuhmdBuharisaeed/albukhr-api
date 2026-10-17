"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sql = fs.readFileSync(path.resolve(__dirname, "../../sql/NOT_READY_DO_NOT_APPLY_ALBUKHR_A2U_SQL_CANDIDATE_v6.sql"), "utf8");

function remainingBalance(baseAmount, requests) {
  const reserved = requests
    .filter((request) => ["pending", "approved", "paid"].includes(request.status))
    .reduce((total, request) => total + Number(request.requestedAmount || 0) + Number(request.feeAmount || 0), 0);
  return Math.max(Number(baseAmount || 0) - reserved, 0);
}

assert.ok(Math.abs(remainingBalance(10, [
  { status: "paid", requestedAmount: 3, feeAmount: 0.03 },
  { status: "approved", requestedAmount: 2, feeAmount: 0.02 },
  { status: "pending", requestedAmount: 1, feeAmount: 0.01 },
  { status: "rejected", requestedAmount: 8, feeAmount: 0.08 },
  { status: "cancelled", requestedAmount: 9, feeAmount: 0.09 }
]) - 3.94) < 1e-9);
assert.equal(remainingBalance(5, [{ status: "paid", requestedAmount: 6, feeAmount: 0.06 }]), 0);
assert.equal(remainingBalance(null, [{ status: "paid", requestedAmount: 1, feeAmount: 0 }]), 0);

assert.match(sql, /create or replace function public\.get_a2u_remaining_stake_balance_v1/);
assert.match(sql, /wr\.status in \('pending', 'approved', 'paid'\)/);
assert.match(sql, /public\.get_a2u_remaining_stake_balance_v1\(v_stake\.id, p_withdrawal_type\)/g);
const helperCalls = sql.match(/public\.get_a2u_remaining_stake_balance_v1\(v_stake\.id, p_withdrawal_type\)/g) || [];
assert.equal(helperCalls.length, 2, "both withdrawal function overloads must apply cumulative balance checking");
console.log("Withdrawal balance model/static checks passed. PostgreSQL integration testing is still required.");
