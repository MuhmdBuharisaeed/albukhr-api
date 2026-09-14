"use strict";

/*
 * ALBUKHR Mainnet A2U payout worker for Render Cron Jobs.
 *
 * This script runs directly inside the private Cron service. It does not
 * expose an HTTP payout endpoint and does not require OPERATIONS_API_KEY.
 *
 * Safety rules:
 * - Mainnet Supabase is enforced by src/supabase-client.js.
 * - PI_A2U_ENABLED must explicitly be true before any payout is attempted.
 * - Only approved Mainnet withdrawal requests are selected.
 * - Payouts are executed sequentially because Pi A2U currently uses the
 *   wallet account sequence and should not be run concurrently.
 * - Secrets are never printed.
 */

const { supabase } = require("../src/supabase-client");
const { executeWithdrawalPayout } = require("../src/financial-gateway");

const MAINNET = "mainnet";
const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 20;

function envBoolean(name, defaultValue = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw);
}

function batchSize() {
  const value = Number.parseInt(String(process.env.A2U_PAYOUT_BATCH_SIZE || DEFAULT_BATCH_SIZE), 10);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(value, MAX_BATCH_SIZE);
}

function safeId(value) {
  return String(value || "").trim().slice(0, 100);
}

async function loadApprovedWithdrawals(limit) {
  const { data, error } = await supabase
    .from("withdrawal_requests")
    .select("id,project_code,withdrawal_type,requested_amount,fee_amount,net_amount,created_at,status,network")
    .eq("network", MAINNET)
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Approved withdrawal queue lookup failed: ${error.message}`);
  }

  return Array.isArray(data) ? data : [];
}

async function main() {
  if (!envBoolean("PI_A2U_ENABLED", false)) {
    console.log("A2U payout worker disabled: PI_A2U_ENABLED is not true. No payout attempted.");
    return;
  }

  const limit = batchSize();
  const queue = await loadApprovedWithdrawals(limit);

  console.log(`A2U payout worker started. Approved Mainnet queue selected: ${queue.length}. Batch limit: ${limit}.`);

  if (queue.length === 0) {
    console.log("No approved Mainnet withdrawals require payout.");
    return;
  }

  let successCount = 0;
  let failureCount = 0;

  // Intentionally sequential. Do not Promise.all() A2U payouts.
  for (const request of queue) {
    const id = safeId(request.id);
    try {
      const result = await executeWithdrawalPayout(id);
      successCount += 1;
      console.log(
        `Payout processed: id=${id} status=${String(result.status || "unknown")} ` +
        `txid=${String(result.txid || "unknown")} amount=${String(result.wallet_receive ?? request.net_amount ?? request.requested_amount)}`
      );
    } catch (error) {
      failureCount += 1;
      console.error(`Payout failed: id=${id} error=${String(error?.message || error)}`);
    }
  }

  console.log(`A2U payout worker finished. success=${successCount} failed=${failureCount} selected=${queue.length}.`);

  // A non-zero exit lets Render surface a failed cron run while still allowing
  // the remaining selected requests to be attempted during this run.
  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`A2U payout worker fatal error: ${String(error?.message || error)}`);
  process.exitCode = 1;
});
