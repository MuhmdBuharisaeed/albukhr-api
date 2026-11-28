"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  configuredFile
} = require("./helpers/workspace");

const queueMigration = configuredFile(
  "ALBUKHR_SQL_DIR",
  "sql",
  "APPLIED_20261017_add_withdrawal_a2u_queue_safety_flags_and_reconciliation.sql"
);
const guardMigration = configuredFile(
  "ALBUKHR_SQL_DIR",
  "sql",
  "APPLIED_20261017_fix_withdrawal_admin_authorization_and_manual_payout_guard.sql"
);
const adminFile = configuredFile("ALBUKHR_ADMIN_DIR", "admin", "admin-withdrawals.js");
const available = Boolean(queueMigration && guardMigration && adminFile);

 test("companion Admin and Mainnet SQL contract is checked when all source directories are configured", {
   skip: available ? false : "Admin/SQL companion files are not available. Configure ALBUKHR_SQL_DIR and ALBUKHR_ADMIN_DIR."
 }, () => {
   const appliedQueueMigration = fs.readFileSync(queueMigration, "utf8");
   const appliedGuardMigration = fs.readFileSync(guardMigration, "utf8");
   const adminJs = fs.readFileSync(adminFile, "utf8");

   for (const name of ["manual_payment_blocked", "a2u_external_payment_present", "a2u_uncertain_outcome", "a2u_attempt_status"]) {
     assert.ok(appliedQueueMigration.includes(name), `missing queue flag ${name}`);
     assert.ok(adminJs.includes(name), `Admin UI does not use ${name}`);
   }
   assert.match(appliedQueueMigration, /get_a2u_reconciliation_queue/);
   assert.match(appliedGuardMigration, /automated_payout_requires_reconciliation/);
   assert.match(appliedGuardMigration, /FROM public\.withdrawal_payout_attempts wpa/);
   assert.match(appliedGuardMigration, /wpa\.withdrawal_request_id = v_wr\.id/);
 });
