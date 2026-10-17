"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const appliedQueueMigration = fs.readFileSync(path.resolve(__dirname, "../../sql/APPLIED_20261017_add_withdrawal_a2u_queue_safety_flags_and_reconciliation.sql"), "utf8");
const appliedGuardMigration = fs.readFileSync(path.resolve(__dirname, "../../sql/APPLIED_20261017_fix_withdrawal_admin_authorization_and_manual_payout_guard.sql"), "utf8");
const adminJs = fs.readFileSync(path.resolve(__dirname, "../../admin/admin-withdrawals.js"), "utf8");

test("applied review queue migration exposes every flag the Admin candidate uses", () => {
  for (const name of ["manual_payment_blocked", "a2u_external_payment_present", "a2u_uncertain_outcome", "a2u_attempt_status"]) {
    assert.ok(appliedQueueMigration.includes(name), `missing queue flag ${name}`);
    assert.ok(adminJs.includes(name), `Admin UI does not use ${name}`);
  }
  assert.match(appliedQueueMigration, /get_a2u_reconciliation_queue/);
});

test("applied manual-paid guard is fail-closed when any payout attempt exists", () => {
  assert.match(appliedGuardMigration, /automated_payout_requires_reconciliation/);
  assert.match(appliedGuardMigration, /FROM public\.withdrawal_payout_attempts wpa/);
  assert.match(appliedGuardMigration, /wpa\.withdrawal_request_id = v_wr\.id/);
});
