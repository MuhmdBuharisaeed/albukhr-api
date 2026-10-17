/* ALBUKHR Mainnet Core Financial Gateway
 * Full replacement — strict U2A payment verification and immutable term binding.
 * Existing withdrawal routes are retained; A2U payout execution delegates to the guarded shared service.
 * Review candidate: adds an authenticated, Mainnet-only withdrawal-history read route.
 */
"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const { a2uReconciliationRouter } = require("./a2u-reconciliation-router");
const {
  getPayment,
  approvePayment,
  completePayment,
  getPioneer,
  verifyU2APaymentDTO
} = require("./pi-client");
const { executeWithdrawalPayout: executeSharedA2UPayout } = require("./a2u-payout-service");

const router = express.Router();
router.use(a2uReconciliationRouter);
const MAINNET = "mainnet";
const CORE_ACTION = "core_investment";
const WITHDRAWAL_FEE_RATE = 0.01;
const MIN_WITHDRAWAL_PI = 1;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clean(value, field, max = 200) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw httpError(400, `${field} is invalid.`);
  return text;
}

function uuidValue(value, field) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw httpError(400, `${field} is invalid.`);
  }
  return text;
}

function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
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

async function getProject(projectCode, { requireActive = false } = {}) {
  const { data, error } = await supabase
    .from("projects")
    .select("id,project_code,project_type,status,core_slot,network")
    .eq("project_code", projectCode)
    .eq("network", MAINNET)
    .maybeSingle();

  if (error) throw httpError(502, "ALBUKHR project lookup failed.");
  if (!data) throw httpError(404, "Mainnet project was not found.");
  if (String(data.project_type || "").toLowerCase() !== "core") {
    throw httpError(403, "Only Mainnet Core Projects can receive Core investments.");
  }
  const slot = Number(data.core_slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > 7) {
    throw httpError(403, "Project Core Slot is invalid.");
  }

  const status = String(data.status || "").toLowerCase();
  if (requireActive && status !== "active") {
    throw httpError(403, "Project is not ACTIVE for investment.");
  }
  if (!requireActive && !["approved", "active"].includes(status)) {
    throw httpError(403, "Project is not eligible for Core investment processing.");
  }
  return data;
}

async function getTreasury(projectId) {
  const { data, error } = await supabase
    .from("project_treasury")
    .select("treasury_wallet,required_liquidity,status,network")
    .eq("project_id", projectId)
    .eq("network", MAINNET)
    .maybeSingle();

  if (error) throw httpError(502, "ALBUKHR treasury lookup failed.");
  if (!data) throw httpError(409, "Project treasury is not configured.");
  if (!data.treasury_wallet || data.required_liquidity == null) {
    throw httpError(409, "Project treasury is not fully configured.");
  }
  if (String(data.network || "").toLowerCase() !== MAINNET) {
    throw httpError(403, "Only Mainnet treasury is accepted.");
  }
  if (!["active", "locked"].includes(String(data.status || "").toLowerCase())) {
    throw httpError(409, "Project treasury is not active.");
  }
  return data;
}

async function requirePublishedCoreTerm({ project, durationDays, termVersionId }) {
  const { data, error } = await supabase
    .from("project_staking_term_versions")
    .select("id,project_id,project_code,network,duration_days,term_status,version_number,effective_from,effective_until")
    .eq("id", termVersionId)
    .eq("project_id", project.id)
    .eq("project_code", project.project_code)
    .eq("network", MAINNET)
    .eq("duration_days", durationDays)
    .eq("term_status", "published")
    .maybeSingle();

  if (error) throw httpError(502, "Published Core investment term lookup failed.");
  if (!data) throw httpError(403, "The accepted term version is not published for this Core Project and duration.");

  const now = Date.now();
  const effectiveFrom = Date.parse(data.effective_from || "");
  const effectiveUntil = data.effective_until ? Date.parse(data.effective_until) : null;
  if (!Number.isFinite(effectiveFrom) || effectiveFrom > now ||
      (effectiveUntil !== null && (!Number.isFinite(effectiveUntil) || effectiveUntil <= now))) {
    throw httpError(403, "The accepted Core investment term version is not currently effective.");
  }
  return data;
}

function verifyCorePayment(payment, expected) {
  return verifyU2APaymentDTO(payment, {
    ...expected,
    network: MAINNET,
    action: CORE_ACTION
  });
}

router.post("/api/pi-payment-approve", async (req, res) => {
  try {
    const identity = await verifiedPiIdentity(req);
    const b = body(req);
    const projectCode = clean(b.project_code, "project_code", 100);
    const paymentId = clean(b.payment_id, "payment_id", 200);
    const amount = positiveAmount(b.amount);
    const durationDays = duration(b.duration);
    const termVersionId = uuidValue(b.term_version_id, "term_version_id");

    const project = await getProject(projectCode, { requireActive: true });
    await requirePublishedCoreTerm({ project, durationDays, termVersionId });
    const treasury = await getTreasury(project.id);
    const payment = await getPayment(paymentId);
    const verified = verifyCorePayment(payment, {
      paymentId,
      projectCode: project.project_code,
      treasuryWallet: treasury.treasury_wallet,
      piUid: identity.pi_uid,
      amount,
      durationDays,
      termVersionId,
      requireRecipient: false
    });

    if (verified.status === "completed") {
      return res.status(200).json({ success: true, data: { payment_id: paymentId, project_code: project.project_code, already_completed: true } });
    }
    const approval = verified.status === "approved" ? payment : await approvePayment(paymentId);
    return res.status(200).json({ success: true, data: { payment_id: paymentId, approval } });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[ALBUKHR API] Core payment approval error", { code: error?.code, message: error?.message });
    return res.status(status).json({ success: false, error: status >= 500 ? "Core investment payment approval failed." : error.message });
  }
});

router.post("/api/pi-payment-complete", async (req, res) => {
  try {
    const identity = await verifiedPiIdentity(req);
    const b = body(req);
    const projectCode = clean(b.project_code, "project_code", 100);
    const paymentId = clean(b.payment_id, "payment_id", 200);
    const txid = clean(b.txid, "txid", 300);
    const amount = positiveAmount(b.amount);
    const durationDays = duration(b.duration);
    const termVersionId = uuidValue(b.term_version_id, "term_version_id");

    const project = await getProject(projectCode, { requireActive: true });
    await requirePublishedCoreTerm({ project, durationDays, termVersionId });
    const treasury = await getTreasury(project.id);
    const expected = {
      paymentId,
      projectCode: project.project_code,
      treasuryWallet: treasury.treasury_wallet,
      piUid: identity.pi_uid,
      amount,
      durationDays,
      termVersionId
    };

    const before = await getPayment(paymentId);
    const beforeVerified = verifyCorePayment(before, { ...expected, requireRecipient: false, requireApproved: true });
    let completion = before;
    if (beforeVerified.status !== "completed") {
      if (beforeVerified.status !== "approved") throw httpError(409, "Pi payment must be server-approved before completion.");
      await completePayment(paymentId, txid);
      completion = await getPayment(paymentId);
    }

    const finalPayment = verifyCorePayment(completion, {
      ...expected,
      requireRecipient: true,
      requireApproved: true,
      requireCompleted: true,
      txid
    });
    const transactionId = finalPayment.transactionId;

    const { data, error } = await supabase.rpc("create_stake_from_completed_payment", {
      p_project_id: project.id,
      p_payment_id: paymentId,
      p_payer_pi_uid: identity.pi_uid,
      p_amount: amount,
      p_recipient_wallet: finalPayment.recipient,
      p_pi_status: "completed",
      p_verification_reference: transactionId,
      p_request_id: null,
      p_duration_days: durationDays,
      p_metadata: {
        source: "albukhr-api",
        engine: "CORE_INVESTMENT_V1",
        project_code: projectCode,
        duration_days: durationDays,
        term_version_id: termVersionId,
        transaction_id: transactionId,
        accounting_effect: "core_investment_only"
      }
    });

    if (error) {
      console.error("[ALBUKHR API] Core stake settlement RPC failed", { code: error.code, message: error.message });
      throw httpError(502, "ALBUKHR Core investment settlement failed.");
    }
    return res.status(200).json({ success: true, data: { completion, stake: data } });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[ALBUKHR API] Core payment completion error", { code: error?.code, message: error?.message });
    return res.status(status).json({ success: false, error: status >= 500 ? "Core investment payment completion failed." : error.message });
  }
});

router.get("/api/my-stakes", async (req, res) => {
  try {
    const identity = await verifiedPiIdentity(req);
    const network = String(req.query.network || MAINNET).toLowerCase();
    if (network !== MAINNET) throw httpError(403, "Only Mainnet stakes are available.");

    const { data, error } = await supabase.rpc("get_my_stakes", {
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    });
    if (error) throw httpError(502, "Unable to load Mainnet stakes.");
    const projectCode = String(req.query.project_code || "").trim();
    const rows = projectCode ? (data || []).filter(row => String(row.project_code || "") === projectCode) : (data || []);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return res.status(status).json({ success: false, error: status >= 500 ? "Unable to load stakes." : error.message });
  }
});

/* Authenticated, Mainnet-only read of the signed-in pioneer's withdrawal history.
   Pi UID is derived from the verified Pi access token, never from request parameters.
   Return an allowlisted shape rather than the full withdrawal_requests row. */
router.get("/api/my-withdrawals", async (req, res) => {
  try {
    const identity = await verifiedPiIdentity(req);
    const network = String(req.query.network || MAINNET).toLowerCase();
    if (network !== MAINNET) throw httpError(403, "Only Mainnet withdrawal history is available.");

    const { data, error } = await supabase.rpc("get_my_withdrawal_requests", {
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    });
    if (error) {
      console.error("[ALBUKHR API] Withdrawal history RPC failed", { code: error.code, message: error.message });
      throw httpError(502, "Unable to load Mainnet withdrawal history.");
    }

    const rows = (Array.isArray(data) ? data : []).map((row) => ({
      id: row.id,
      stake_id: row.stake_id,
      project_code: row.project_code,
      network: row.network,
      withdrawal_type: row.withdrawal_type,
      requested_amount: row.requested_amount,
      fee_rate: row.fee_rate,
      fee_amount: row.fee_amount,
      net_amount: row.net_amount,
      status: row.status,
      txid: row.txid,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[ALBUKHR API] Withdrawal history error", { status, message: error?.message });
    return res.status(status).json({
      success: false,
      error: status >= 500 ? "Unable to load withdrawal history." : error.message
    });
  }
});

router.post("/api/withdrawal-request", async (req, res) => {
  try {
    const identity = await verifiedPiIdentity(req);
    const b = body(req);
    const stakeId = clean(b.stake_id, "stake_id", 100);
    const withdrawalType = clean(b.withdrawal_type, "withdrawal_type", 20).toLowerCase();
    if (!["reward", "capital"].includes(withdrawalType)) throw httpError(400, "withdrawal_type is invalid.");

    const requestedAmount = positiveAmount(b.requested_amount);
    if (requestedAmount < MIN_WITHDRAWAL_PI) throw httpError(400, "Minimum withdrawal is 1 Pi.");
    const feePreview = Number((requestedAmount * WITHDRAWAL_FEE_RATE).toFixed(3));
    const { data, error } = await supabase.rpc("create_my_withdrawal_request", {
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET,
      p_stake_id: stakeId,
      p_withdrawal_type: withdrawalType,
      p_requested_amount: requestedAmount
    });
    if (error) {
      console.error("[ALBUKHR API] Withdrawal request RPC failed", { code: error.code, message: error.message });
      throw httpError(400, error.message || "Withdrawal request could not be created.");
    }
    return res.status(201).json({
      success: true,
      data,
      fee_preview: {
        fee_rate: WITHDRAWAL_FEE_RATE,
        fee_amount: feePreview,
        total_deduction: Number((requestedAmount + feePreview).toFixed(3)),
        wallet_receive: requestedAmount
      }
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[ALBUKHR API] Withdrawal request error", error);
    return res.status(status).json({ success: false, error: status >= 500 ? "Withdrawal request failed." : error.message });
  }
});

router.post("/api/pay-withdrawal", async (req, res) => {
  const expected = String(process.env.OPERATIONS_API_KEY || "").trim();
  if (!expected) return res.status(503).json({ success: false, code: "OPERATIONS_API_KEY_NOT_CONFIGURED", error: "Operations API key is not configured." });
  const supplied = String(req.headers["x-api-key"] || "").trim();
  if (!supplied || supplied !== expected) return res.status(401).json({ success: false, code: "OPERATIONS_AUTH_INVALID", error: "Operations authentication failed." });

  try {
    const b = body(req);
    const withdrawalRequestId = clean(b.withdrawal_request_id || b.id, "withdrawal_request_id", 100);
    const result = await executeSharedA2UPayout(withdrawalRequestId);
    return res.status(result.already_paid ? 200 : 201).json({ success: true, network: MAINNET, data: result });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[ALBUKHR API] A2U payout execution error", { status, code: error?.code, message: error?.message });
    return res.status(status).json({
      success: false,
      network: MAINNET,
      code: error?.code || "A2U_PAYOUT_FAILED",
      error: status >= 500 ? "Withdrawal payout failed." : error.message
    });
  }
});

module.exports = { financialGatewayRouter: router, executeWithdrawalPayout: executeSharedA2UPayout };
