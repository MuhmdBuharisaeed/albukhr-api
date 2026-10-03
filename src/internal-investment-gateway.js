/* ALBUKHR — Contributor Internal Investment Gateway v1
 * Mainnet-only. Separate from the existing Core Financial Gateway.
 */
"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const {
  getPayment,
  approvePayment,
  completePayment,
  getPioneer
} = require("./pi-client");

const router = express.Router();
const MAINNET = "mainnet";
const INTERNAL_ACTION = "investment";

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
}

function clean(value, field, max = 200) {
  const valueString = String(value || "").trim();
  if (!valueString || valueString.length > max) {
    throw httpError(400, `${field} is invalid.`);
  }
  return valueString;
}

function positiveAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw httpError(400, "amount is invalid.");
  }
  return amount;
}

function duration(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || ![30, 60, 90, 180, 365, 430].includes(days)) {
    throw httpError(400, "duration is invalid.");
  }
  return days;
}

function requireBearer(req) {
  const header = String(req.headers.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) {
    throw httpError(401, "Pi authentication token is required.");
  }
  const token = header.slice(7).trim();
  if (!token) throw httpError(401, "Pi authentication token is required.");
  return token;
}

async function verifiedPiIdentity(req) {
  const token = requireBearer(req);
  const pioneer = await getPioneer(token);
  const piUid = String(pioneer.uid || "").trim();
  if (!piUid) throw httpError(401, "Pi identity could not be verified.");
  return { pi_uid: piUid };
}

async function getInternalProject(projectCode, { requireActive = false } = {}) {
  const { data, error } = await supabase
    .from("projects")
    .select(
      "id,project_code,project_type,status,network,registration_source,owner_albukhr_user_id"
    )
    .eq("project_code", projectCode)
    .eq("network", MAINNET)
    .maybeSingle();

  if (error) throw httpError(502, "ALBUKHR project lookup failed.");
  if (!data) throw httpError(404, "Mainnet project was not found.");

  if (
    String(data.project_type || "").toLowerCase() !== "internal" ||
    String(data.registration_source || "").toLowerCase() !== "contributor_internal"
  ) {
    throw httpError(403, "This route is only for Contributor Internal Projects.");
  }

  if (String(data.network || "").toLowerCase() !== MAINNET) {
    throw httpError(403, "Only Mainnet Internal Projects are accepted.");
  }

  const status = String(data.status || "").toLowerCase();
  if (requireActive && status !== "active") {
    throw httpError(403, "Internal Project is not ACTIVE for investment.");
  }

  if (!requireActive && !["approved", "active"].includes(status)) {
    throw httpError(403, "Internal Project is not eligible for investment processing.");
  }

  return data;
}

async function getInternalTreasury(projectId) {
  const { data, error } = await supabase
    .from("internal_project_treasury")
    .select("treasury_wallet,required_liquidity,verified_liquidity,status,network")
    .eq("project_id", projectId)
    .eq("network", MAINNET)
    .maybeSingle();

  if (error) throw httpError(502, "ALBUKHR Internal treasury lookup failed.");
  if (!data) throw httpError(409, "Internal Project treasury is not configured.");
  if (!data.treasury_wallet) throw httpError(409, "Internal Project treasury wallet is missing.");
  if (data.network !== MAINNET) throw httpError(403, "Only Mainnet Internal treasury is accepted.");
  if (!["active", "locked"].includes(String(data.status || "").toLowerCase())) {
    throw httpError(409, "Internal Project treasury is not active.");
  }
  return data;
}

function paymentStatus(payment) {
  const status = payment?.status;

  if (status && typeof status === "object") {
    if (status.cancelled || status.user_cancelled) return "cancelled";
    if (status.developer_completed) return "completed";
    if (status.developer_approved) return "approved";
    return "pending";
  }

  return String(status || payment?.transaction?.status || "")
    .trim()
    .toLowerCase();
}

function paymentRecipient(payment) {
  return String(
    payment?.to_address ||
    payment?.recipient_address ||
    payment?.recipient?.address ||
    payment?.transaction?.to_address ||
    ""
  ).trim();
}

function paymentSenderUid(payment) {
  return String(
    payment?.user_uid ||
    payment?.from_uid ||
    payment?.sender_uid ||
    payment?.sender?.uid ||
    ""
  ).trim();
}

function assertSender(payment, piUid) {
  const sender = paymentSenderUid(payment);
  if (sender && sender !== piUid) {
    throw httpError(403, "Pi payment sender does not match the authenticated Pi account.");
  }
}

function verifyInternalPaymentMetadata(
  payment,
  { project, treasury, piUid, amount, durationDays }
) {
  const status = paymentStatus(payment);
  if (!["created", "pending", "approved", "completed"].includes(status)) {
    throw httpError(409, "Pi payment is not in a valid processing state.");
  }

  const paymentAmount = Number(payment?.amount);
  if (!Number.isFinite(paymentAmount) || paymentAmount !== amount) {
    throw httpError(400, "Pi payment amount does not match the requested amount.");
  }

  assertSender(payment, piUid);

  const metadata = payment?.metadata || {};
  if (String(metadata.network || "").toLowerCase() !== MAINNET) {
    throw httpError(403, "Only Mainnet payments are accepted.");
  }
  if (String(metadata.action || "").toLowerCase() !== INTERNAL_ACTION) {
    throw httpError(403, "Unsupported Internal investment payment action.");
  }
  if (String(metadata.project_code || "") !== String(project.project_code || "")) {
    throw httpError(403, "Pi payment project does not match the Internal Project.");
  }
  if (Number(metadata.duration) !== Number(durationDays)) {
    throw httpError(403, "Pi payment duration does not match the requested duration.");
  }

  const recipient = paymentRecipient(payment);
  if (recipient && recipient !== treasury.treasury_wallet) {
    throw httpError(403, "Pi payment recipient does not match the Internal Project treasury wallet.");
  }

  return { status, recipient };
}

router.post("/api/internal-payment-approve", async (req, res) => {
  try {
    const identity = await verifiedPiIdentity(req);
    const b = body(req);
    const projectCode = clean(b.project_code, "project_code", 100);
    const paymentId = clean(b.payment_id, "payment_id", 200);
    const amount = positiveAmount(b.amount);
    const durationDays = duration(b.duration);

    const project = await getInternalProject(projectCode, { requireActive: true });
    const treasury = await getInternalTreasury(project.id);
    const payment = await getPayment(paymentId);

    verifyInternalPaymentMetadata(payment, {
      project,
      treasury,
      piUid: identity.pi_uid,
      amount,
      durationDays
    });

    const approval = await approvePayment(paymentId);

    return res.status(200).json({
      success: true,
      data: {
        payment_id: paymentId,
        project_code: project.project_code,
        approval
      }
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[ALBUKHR API] Internal payment approval error", error);
    return res.status(status).json({
      success: false,
      error: status >= 500 ? "Internal investment payment approval failed." : error.message
    });
  }
});

router.post("/api/internal-payment-complete", async (req, res) => {
  try {
    const identity = await verifiedPiIdentity(req);
    const b = body(req);
    const projectCode = clean(b.project_code, "project_code", 100);
    const paymentId = clean(b.payment_id, "payment_id", 200);
    const txid = clean(b.txid, "txid", 300);
    const amount = positiveAmount(b.amount);
    const durationDays = duration(b.duration);

    const project = await getInternalProject(projectCode, { requireActive: true });
    const treasury = await getInternalTreasury(project.id);

    const before = await getPayment(paymentId);
    verifyInternalPaymentMetadata(before, {
      project,
      treasury,
      piUid: identity.pi_uid,
      amount,
      durationDays
    });

    await completePayment(paymentId, txid);

    const after = await getPayment(paymentId);
    const finalStatus = paymentStatus(after);
    if (finalStatus !== "completed") {
      throw httpError(409, "Pi payment was not confirmed as completed.");
    }

    verifyInternalPaymentMetadata(after, {
      project,
      treasury,
      piUid: identity.pi_uid,
      amount,
      durationDays
    });

    const recipient = paymentRecipient(after);
    if (!recipient || recipient !== treasury.treasury_wallet) {
      throw httpError(403, "Completed Pi payment recipient does not match the Internal Project treasury wallet.");
    }

    const transactionId = String(
      after?.transaction?.txid || after?.transaction?.id || txid
    ).trim();

    const { data, error } = await supabase.rpc("create_internal_stake_from_completed_payment", {
      p_project_id: project.id,
      p_payment_id: paymentId,
      p_payer_pi_uid: identity.pi_uid,
      p_amount: amount,
      p_recipient_wallet: recipient,
      p_pi_status: finalStatus,
      p_verification_reference: transactionId,
      p_request_id: null,
      p_duration_days: durationDays,
      p_metadata: {
        source: "albukhr-api",
        engine: "CONTRIBUTOR_INTERNAL_V1",
        project_code: projectCode,
        duration_days: durationDays,
        transaction_id: transactionId
      }
    });

    if (error) {
      console.error("[ALBUKHR API] Internal stake settlement RPC failed", {
        code: error.code,
        message: error.message
      });
      throw httpError(502, "ALBUKHR Internal investment settlement failed.");
    }

    return res.status(200).json({
      success: true,
      data: {
        completion: after,
        stake: data
      }
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[ALBUKHR API] Internal payment completion error", error);
    return res.status(status).json({
      success: false,
      error: status >= 500 ? "Internal investment payment completion failed." : error.message
    });
  }
});

const internalInvestmentGatewayRouter = router;
module.exports = { internalInvestmentGatewayRouter };
