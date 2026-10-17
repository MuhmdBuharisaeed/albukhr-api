"use strict";

/*
 * ALBUKHR Mainnet A2U Cron entry point — disabled by code-level gate.
 * It delegates all payout and idempotency work to the single service module.
 * This file is not wired into a Render Cron service by this review patch.
 */
const { a2uEnabled } = require("../src/pi-a2u-client");
const { processApprovedWithdrawals } = require("../src/a2u-payout-service");

async function main() {
  if (!a2uEnabled()) {
    console.log("A2U payout worker disabled by the source-level Mainnet gate; no queue read or payout attempted.");
    return;
  }

  const result = await processApprovedWithdrawals(process.env.A2U_PAYOUT_BATCH_SIZE || 5);
  console.log(`A2U worker completed. selected=${result.selected} processed=${result.processed} failed=${result.failed} skipped=${result.skipped}.`);
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("A2U Cron fatal error", {
    code: error?.code,
    message: error?.message
  });
  process.exitCode = 1;
});
