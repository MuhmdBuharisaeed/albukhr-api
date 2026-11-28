"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  configuredFile
} = require("./helpers/workspace");

function remainingBalance(baseAmount, requests) {
  const reserved = requests
    .filter((request) => ["pending", "approved", "paid"].includes(request.status))
    .reduce((total, request) => total + Number(request.requestedAmount || 0) + Number(request.feeAmount || 0), 0);
  return Math.max(Number(baseAmount || 0) - reserved, 0);
}

test("remaining balance reserves pending, approved and paid requests including fees", () => {
  assert.ok(Math.abs(remainingBalance(10, [
    { status: "paid", requestedAmount: 3, feeAmount: 0.03 },
    { status: "approved", requestedAmount: 2, feeAmount: 0.02 },
    { status: "pending", requestedAmount: 1, feeAmount: 0.01 },
    { status: "rejected", requestedAmount: 8, feeAmount: 0.08 },
    { status: "cancelled", requestedAmount: 9, feeAmount: 0.09 }
  ]) - 3.94) < 1e-9);
  assert.equal(remainingBalance(5, [{ status: "paid", requestedAmount: 6, feeAmount: 0.06 }]), 0);
  assert.equal(remainingBalance(null, [{ status: "paid", requestedAmount: 1, feeAmount: 0 }]), 0);
});

const sqlPath = configuredFile(
  "ALBUKHR_SQL_DIR",
  "sql",
  "NOT_READY_DO_NOT_APPLY_ALBUKHR_A2U_SQL_CANDIDATE_v6.sql"
);

test("withdrawal balance SQL contract is checked only when the external SQL directory is configured", {
  skip: sqlPath ? false : "Companion SQL repository not configured; set ALBUKHR_SQL_DIR."
}, () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  assert.match(sql, /create or replace function public\.get_a2u_remaining_stake_balance_v1/);
  assert.match(sql, /wr\.status in \('pending', 'approved', 'paid'\)/);
  const pattern = /public\.get_a2u_remaining_stake_balance_v1\(v_stake\.id, p_withdrawal_type\)/g;
  const helperCalls = sql.match(pattern) || [];
  assert.equal(helperCalls.length, 2, "both withdrawal function overloads must apply cumulative balance checking");
});
