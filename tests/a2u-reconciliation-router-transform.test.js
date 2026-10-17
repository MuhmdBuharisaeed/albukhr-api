"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const gateway = fs.readFileSync(path.resolve(__dirname, "../src/financial-gateway.js"), "utf8");
const router = fs.readFileSync(path.resolve(__dirname, "../src/a2u-reconciliation-router.js"), "utf8");

test("full gateway candidate mounts the read-only reconciliation endpoint exactly once", () => {
  assert.equal((gateway.match(/router\.use\(a2uReconciliationRouter\)/g) || []).length, 1);
  assert.match(gateway, /require\("\.\/a2u-reconciliation-router"\)/);
  assert.match(router, /router\.post\("\/api\/a2u\/reconcile-inspect"/);
});

test("reconciliation route requires Bearer token, Supabase user validation, AAL2 and Finance/Super Admin", () => {
  assert.match(router, /db\.auth\.getUser\(token\)/);
  assert.match(router, /claims\.aal !== "aal2"/);
  assert.match(router, /FINANCE_OR_SUPER_ADMIN_REQUIRED/);
  assert.match(router, /withdrawal_a2u_reconciliation_inspected/);
});
