"use strict";

const {
  executeWithdrawalPayout
} = require("./financial-gateway");
const { supabase } = require("./supabase-client");

const MAINNET = "mainnet";
const MAX_BATCH = Math.max(
  1,
  Math.min(Number(process.env.A2U_PAYOUT_BATCH_SIZE || 5), 20)
);

function httpError(status, message, code = null) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function requireA2UCronKey(req, res, next) {
  const expected = String(process.env.A2U_CRON_KEY || "").trim();
  const supplied = String(req.headers["x-a2u-cron-key"] || "").trim();

  if (!expected) {
    return res.status(503).json({
      success: false,
      code: "A2U_CRON_KEY_NOT_CONFIGURED",
      error: "A2U cron key is not configured."
    });
  }

  if (!supplied || supplied !== expected) {
    return res.status(401).json({
      success: false,
      code: "A2U_CRON_AUTH_INVALID",
      error: "A2U cron authentication failed."
    });
  }

  return next();
}

async function claimWithdrawalPayout(withdrawalRequestId) {
  const { data, error } = await supabase.rpc(
    "claim_a2u_withdrawal_payout",
    {
      p_withdrawal_request_id: withdrawalRequestId
    }
  );

  if (error) {
    console.error("[ALBUKHR API] A2U payout claim RPC failed", {
      withdrawal_request_id: withdrawalRequestId,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });

    throw httpError(502, "A2U payout claim failed.", "A2U_PAYOUT_CLAIM_FAILED");
  }

  const row = Array.isArray(data) ? data[0] : data;

  return {
    claimed: Boolean(row?.claimed),
    reason: String(row?.reason || ""),
    attempt_id: row?.attempt_id || null,
    payment_id: row?.payment_id || null,
    txid: row?.txid || null
  };
}

async function finishWithdrawalPayout(
  withdrawalRequestId,
  status,
  paymentId = null,
  txid = null,
  errorMessage = null
) {
  const { error } = await supabase.rpc(
    "finish_a2u_withdrawal_payout",
    {
      p_withdrawal_request_id: withdrawalRequestId,
      p_status: status,
      p_payment_id: paymentId,
      p_txid: txid,
      p_error: errorMessage
    }
  );

  if (error) {
    console.error("[ALBUKHR API] A2U payout attempt finalization failed", {
      withdrawal_request_id: withdrawalRequestId,
      status,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });
  }
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
    console.error("[ALBUKHR API] Approved withdrawal queue lookup failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });

    throw httpError(
      502,
      "Approved withdrawal queue lookup failed.",
      "A2U_QUEUE_LOOKUP_FAILED"
    );
  }

  const rows = Array.isArray(data) ? data : [];
  const results = [];

  for (const row of rows) {
    let claim;

    try {
      claim = await claimWithdrawalPayout(row.id);

      if (!claim.claimed) {
        results.push({
          withdrawal_request_id: row.id,
          status: "skipped",
          code: "A2U_PAYOUT_NOT_CLAIMED",
          reason: claim.reason
        });
        continue;
      }

      const payout = await executeWithdrawalPayout(row.id);

      await finishWithdrawalPayout(
        row.id,
        "completed",
        payout?.payment_id || claim.payment_id || null,
        payout?.txid || claim.txid || null,
        null
      );

      results.push(payout);
    } catch (error) {
      await finishWithdrawalPayout(
        row.id,
        "failed",
        claim?.payment_id || null,
        claim?.txid || null,
        error?.message || "Withdrawal payout failed."
      );

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
    processed: results.filter(
      x => x.status === "paid"
    ).length,
    failed: results.filter(
      x => x.status === "failed"
    ).length,
    skipped: results.filter(
      x => x.status === "skipped"
    ).length,
    results
  };
}

function createA2UWorkerRouter(express) {
  const router = express.Router();

  router.post(
    "/internal/process-approved-withdrawals",
    requireA2UCronKey,
    async (_req, res) => {
      try {
        const result = await processApprovedWithdrawals();

        return res.status(200).json({
          success: true,
          ...result
        });
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
          error:
            status >= 500
              ? "A2U payout worker failed."
              : error.message
        });
      }
    }
  );

  return router;
}

module.exports = {
  createA2UWorkerRouter,
  processApprovedWithdrawals
};
