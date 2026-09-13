"use strict";

const {
  executeWithdrawalPayout
} = require("./financial-gateway");
const { supabase } = require("./supabase-client");

const MAINNET = "mainnet";
const MAX_BATCH = Math.max(1, Math.min(Number(process.env.A2U_PAYOUT_BATCH_SIZE || 5), 20));

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function requireOpsKey(req, res, next) {
  const expected = String(process.env.OPERATIONS_API_KEY || "").trim();
  const supplied = String(req.headers["x-api-key"] || "").trim();

  if (!expected) {
    return res.status(503).json({
      success: false,
      code: "OPERATIONS_API_KEY_NOT_CONFIGURED",
      error: "Operations API key is not configured."
    });
  }

  if (!supplied || supplied !== expected) {
    return res.status(401).json({
      success: false,
      code: "OPERATIONS_AUTH_INVALID",
      error: "Operations authentication failed."
    });
  }

  return next();
}

async function processApprovedWithdrawals() {
  const { data, error } = await supabase
    .from("withdrawal_requests")
    .select("id,status,network,created_at")
    .eq("network", MAINNET)
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(MAX_BATCH);

  if (error) {
    throw httpError(502, "Approved withdrawal queue lookup failed.");
  }

  const rows = Array.isArray(data) ? data : [];
  const results = [];

  for (const row of rows) {
    try {
      results.push(await executeWithdrawalPayout(row.id));
    } catch (error) {
      results.push({
        withdrawal_request_id: row.id,
        status: "failed",
        code: error?.code || "A2U_PAYOUT_FAILED",
        error: error?.message || "Withdrawal payout failed."
      });
    }
  }

  return {
    network: MAINNET,
    selected: rows.length,
    processed: results.filter(x => x.status === "paid").length,
    failed: results.filter(x => x.status === "failed").length,
    results
  };
}

function createA2UWorkerRouter(express) {
  const router = express.Router();

  router.post("/internal/process-approved-withdrawals", requireOpsKey, async (_req, res) => {
    try {
      const result = await processApprovedWithdrawals();
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const status = Number(error?.status) || 500;
      console.error("[ALBUKHR API] A2U worker error", {
        status,
        code: error?.code,
        message: error?.message
      });
      return res.status(status).json({
        success: false,
        network: MAINNET,
        code: error?.code || "A2U_WORKER_FAILED",
        error: status >= 500 ? "A2U payout worker failed." : error.message
      });
    }
  });

  return router;
}

module.exports = {
  createA2UWorkerRouter,
  processApprovedWithdrawals
};
