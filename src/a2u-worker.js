"use strict";

/*
 * Optional operations route for the shared A2U worker. This file is not
 * mounted by the current server.js. If later mounted, it must call the same
 * central payout service as the Cron worker and must not claim attempts twice.
 */
const { a2uEnabled } = require("./pi-a2u-client");
const { processApprovedWithdrawals } = require("./a2u-payout-service");

function requireA2UCronKey(req, res, next) {
  const expected = String(process.env.A2U_CRON_KEY || "").trim();
  const supplied = String(req.headers["x-a2u-cron-key"] || "").trim();
  if (!expected) {
    return res.status(503).json({ success: false, code: "A2U_CRON_KEY_NOT_CONFIGURED", error: "A2U cron key is not configured." });
  }
  if (!supplied || supplied !== expected) {
    return res.status(401).json({ success: false, code: "A2U_CRON_AUTH_INVALID", error: "A2U cron authentication failed." });
  }
  return next();
}

function createA2UWorkerRouter(express) {
  const router = express.Router();
  router.post("/internal/process-approved-withdrawals", requireA2UCronKey, async (_req, res) => {
    if (!a2uEnabled()) {
      return res.status(503).json({
        success: false,
        network: "mainnet",
        code: "A2U_MAINNET_DISABLED",
        error: "Pi A2U Mainnet payouts are disabled pending official support and approval."
      });
    }
    try {
      const result = await processApprovedWithdrawals();
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      console.error("[ALBUKHR API] A2U worker error", {
        code: error?.code,
        message: error?.message
      });
      return res.status(Number(error?.status) || 500).json({
        success: false,
        network: "mainnet",
        code: error?.code || "A2U_WORKER_FAILED",
        error: "A2U payout worker failed."
      });
    }
  });
  return router;
}

module.exports = { createA2UWorkerRouter };
