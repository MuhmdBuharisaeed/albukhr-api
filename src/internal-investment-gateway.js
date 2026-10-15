/* ALBUKHR — Contributor Internal Investment Gateway v1.1
 * Mainnet-only. Strict U2A validation; separate from Core Financial Gateway.
 */
"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const {
  getPayment,
  approvePayment,
  completePayment,
  getPioneer,
  verifyU2APaymentDTO
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
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

function clean(value, field, max = 200) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw httpError(400, `${field} is invalid.`);
  return text;
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
  let pioneer;
  try {
    pioneer = await getPioneer(requireBearer(req));
  } catch {
    throw httpError(401, "Pi identity could not be verified.");
  }
  const piUid = String(pioneer?.uid || "").trim();
  if (!piUid) throw httpError(401, "Pi identity could not be verified.");
  return { pi_uid: piUid };
}

async function getInternalProject(projectCode, { requireActive = false } = {}) {
  const { data, error } = await supabase
    .from("projects")
    .select("id,project_code,project_type,status,network,registration_source,owner_albukhr_user_id")
    .eq("project_code", projectCode)
    .eq("network", MAINNET)
    .maybeSingle();

  if (error) throw httpError(502, "ALBUKHR project lookup failed.");
  if (!data) throw httpError(404, "Mainnet project was not found.");
  if (String(data.project_type || "").toLowerCase() !== "internal" ||
      String(data.registration_source || "").toLowerCase() !== "contributor_internal") {
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
  if (String(data.network || "").toLowerCase() !== MAINNET) {
    throw httpError(403, "Only Mainnet Internal treasury is accepted.");
  }
  if (!["active", "locked"].includes(String(data.status || "").toLowerCase())) {
    throw httpError(409, "Internal Project treasury is not active.");
  }
  return data;
}

function verifyInternalPayment(payment, expected) {
  return verifyU2APaymentDTO(payment, {
    ...expected,
    network: MAINNET,
    action: INTERNAL_ACTION
  });
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

    const verified = verifyInternalPayment(payment, {
      paymentId,
      projectCode: project.project_code,
      treasuryWallet: treasury.treasury_wallet,
      piUid: identity.pi_uid,
      amount,
      durationDays,
      requireRecipient: false
    });

    if (verified.status === "completed") {
      return res.status(200).json({
        success: true,
        data: { payment_id: paymentId, project_code: project.project_code, already_completed: true }
      });
    }

    const approval = verified.status === "approved" ? payment : await approvePayment(paymentId);
    return res.status(200).json({
      success: true,
      data: { payment_id: paymentId, project_code: project.project_code, approval }
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
    const expected = {
      paymentId,
      projectCode: project.project_code,
      treasuryWallet: treasury.treasury_wallet,
      piUid: identity.pi_uid,
      amount,
      durationDays
    };

    const before = await getPayment(paymentId);
    const beforeVerified = verifyInternalPayment(before, {
      ...expected,
      requireRecipient: false
    });

    let completion = before;
    if (beforeVerified.status !== "completed") {
      if (beforeVerified.status !== "approved") {
        throw httpError(409, "Pi payment must be server-approved before completion.");
      }
      await completePayment(paymentId, txid);
      completion = await getPayment(paymentId);
    }

    const finalPayment = verifyInternalPayment(completion, {
      ...expected,
      requireRecipient: true,
      requireApproved: true,
      requireCompleted: true,
      txid
    });
    const recipient = finalPayment.recipient;
    const transactionId = finalPayment.transactionId;

    const { data, error } = await supabase.rpc("create_internal_stake_from_completed_payment", {
      p_project_id: project.id,
      p_payment_id: paymentId,
      p_payer_pi_uid: identity.pi_uid,
      p_amount: amount,
      p_recipient_wallet: recipient,
      p_pi_status: "completed",
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
      data: { completion, stake: data }
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

module.exports = { internalInvestmentGatewayRouter: router };
