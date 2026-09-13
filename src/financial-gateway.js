"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const {
  getPayment,
  approvePayment,
  completePayment,
  getPioneer,
  verifyPaymentMetadata
} = require("./pi-client");
const {
  createA2UPayment,
  getA2UPayment,
  getIncompleteA2UPayments,
  submitA2UPayment,
  completeA2UPayment
} = require("./pi-a2u-client");

const router = express.Router();
const MAINNET = "mainnet";
const WITHDRAWAL_FEE_RATE = 0.01;
const MIN_WITHDRAWAL_PI = 1;

// A single in-process payout lock prevents duplicate execution from concurrent
// requests hitting the same Render instance. Keep the payout executor at one
// instance until a persistent DB claim/lock RPC is introduced.
const activePayouts = new Set();

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function requireBearer(req) {
  const value = String(req.headers.authorization || "").trim();
  if (!value.toLowerCase().startsWith("bearer ")) {
    throw httpError(401, "Pi authentication token is required.");
  }
  const token = value.slice(7).trim();
  if (!token) throw httpError(401, "Pi authentication token is required.");
  return token;
}

function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
}

function clean(value, field, max = 200) {
  const v = String(value || "").trim();
  if (!v || v.length > max) throw httpError(400, `${field} is invalid.`);
  return v;
}

function positiveAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1000000000) {
    throw httpError(400, "amount is invalid.");
  }
  return n;
}

function duration(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || ![30, 60, 90, 180, 365, 430].includes(n)) {
    throw httpError(400, "duration is invalid.");
  }
  return n;
}

async function verifiedPiIdentity(req) {
  const token = requireBearer(req);
  const pioneer = await getPioneer(token);
  const piUid = String(pioneer.uid || "").trim();
  if (!piUid) throw httpError(401, "Pi identity could not be verified.");
  return { pi_uid: piUid, token };
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
  if (String(data.project_type).toLowerCase() !== "core") {
    throw httpError(403, "Only Mainnet Core Projects can receive core liquidity.");
  }
  if (!Number.isInteger(Number(data.core_slot)) || Number(data.core_slot) < 1 || Number(data.core_slot) > 7) {
    throw httpError(403, "Project Core Slot is invalid.");
  }

  const status = String(data.status || "").toLowerCase();
  if (requireActive && status !== "active") {
    throw httpError(403, "Project is not ACTIVE for investment.");
  }
  if (!requireActive && !["approved", "active"].includes(status)) {
    throw httpError(403, "Project is not eligible for liquidity settlement.");
  }
  return data;
}

async function getTreasury(projectId) {
  const { data, error } = await supabase
    .from("project_treasury")
    .select("treasury_wallet,required_liquidity,status,network")
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) throw httpError(502, "ALBUKHR treasury lookup failed.");
  if (!data) throw httpError(409, "Project treasury is not configured.");
  if (!data.treasury_wallet || data.required_liquidity == null) {
    throw httpError(409, "Project treasury is not fully configured.");
  }
  if (data.network !== MAINNET) {
    throw httpError(403, "Only Mainnet treasury is accepted.");
  }
  if (!["active", "locked"].includes(String(data.status || "").toLowerCase())) {
    throw httpError(409, "Project treasury is not active.");
  }
  return data;
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
    payment?.from_uid ||
    payment?.sender_uid ||
    payment?.sender?.uid ||
    ""
  ).trim();
}

function paymentStatus(payment) {
  return String(payment?.status || payment?.transaction?.status || "")
    .trim()
    .toLowerCase();
}

function assertSender(payment, piUid) {
  const sender = paymentSenderUid(payment);
  if (sender && sender !== piUid) {
    throw httpError(403, "Pi payment sender does not match the authenticated Pi account.");
  }
}

async function verifyPaymentForProject(
  payment,
  { project, treasury, piUid, amount, durationDays }
) {
  const status = paymentStatus(payment);
  if (!["created", "pending", "approved", "completed"].includes(status)) {
    throw httpError(409, "Pi payment is not in a valid processing state.");
  }
  assertSender(payment, piUid);
  verifyPaymentMetadata(payment, {
    amount,
    network: MAINNET,
    project_code: project.project_code,
    duration: durationDays
  });
  const recipient = paymentRecipient(payment);
  if (recipient && recipient !== treasury.treasury_wallet) {
    throw httpError(403, "Pi payment recipient does not match the project treasury wallet.");
  }
  return { status, recipient };
}

/*
 * A2U payout execution
 *
 * Input is ONLY withdrawal_request_id. Amount, Pi UID and wallet are read
 * from the authoritative Mainnet withdrawal_requests row.
 *
 * The fee is already represented in the withdrawal contract:
 *   requested_amount = wallet receive
 *   fee_amount       = requested_amount * 1%
 *   total_deduction  = requested_amount + fee_amount
 *
 * The blockchain payout itself is exactly requested_amount.
 */
async function executeWithdrawalPayout(withdrawalRequestId) {
  const id = clean(withdrawalRequestId, "withdrawal_request_id", 100);

  if (activePayouts.has(id)) {
    throw httpError(409, "This withdrawal payout is already being processed.");
  }

  activePayouts.add(id);

  try {
    const { data: request, error } = await supabase
      .from("withdrawal_requests")
      .select(
        "id,stake_id,user_id,pi_uid,project_id,project_code,network," +
        "withdrawal_type,requested_amount,fee_rate,fee_amount,net_amount," +
        "wallet_address,status,txid,reviewed_by,reviewed_at,rejection_reason," +
        "created_at,updated_at"
      )
      .eq("id", id)
      .maybeSingle();

    if (error) throw httpError(502, "Withdrawal request lookup failed.");
    if (!request) throw httpError(404, "Withdrawal request was not found.");

    const status = String(request.status || "").toLowerCase();
    if (status === "paid" && request.txid) {
      return {
        already_paid: true,
        withdrawal_request_id: id,
        status: "paid",
        txid: request.txid,
        wallet_receive: Number(request.net_amount ?? request.requested_amount)
      };
    }

    if (status !== "approved") {
      throw httpError(409, `Withdrawal request is not approved (status: ${status || "unknown"}).`);
    }
    if (String(request.network || "").toLowerCase() !== MAINNET) {
      throw httpError(403, "Only Mainnet withdrawal requests can be paid.");
    }

    const piUid = clean(request.pi_uid, "pi_uid", 200);
    const recipient = clean(request.wallet_address, "wallet_address", 200);
    const requestedAmount = positiveAmount(request.requested_amount);
    const walletReceive = Number(request.net_amount ?? request.requested_amount);
    const feeRate = Number(request.fee_rate ?? WITHDRAWAL_FEE_RATE);
    const feeAmount = Number(request.fee_amount ?? (requestedAmount * feeRate));
    const totalDeduction = Number((requestedAmount + feeAmount).toFixed(3));

    if (!Number.isFinite(walletReceive) || walletReceive <= 0 || walletReceive !== requestedAmount) {
      throw httpError(409, "Withdrawal amount contract is invalid.");
    }
    if (Math.abs(feeRate - WITHDRAWAL_FEE_RATE) > 1e-9) {
      throw httpError(409, "Withdrawal fee contract is invalid.");
    }
    if (!Number.isFinite(feeAmount) || feeAmount < 0) {
      throw httpError(409, "Withdrawal fee amount is invalid.");
    }
    if (Math.abs(totalDeduction - Number(requestedAmount + feeAmount)) > 1e-9) {
      throw httpError(409, "Withdrawal total deduction is invalid.");
    }

    // Validate the referenced stake/project context before signing.
    const { data: stake, error: stakeError } = await supabase
      .from("stakes")
      .select(
        "id,project_id,project_code,user_id,pi_uid,network,amount," +
        "duration_days,reward_rate,reward_amount,status,payment_record_id," +
        "payment_id,start_at,unlock_at"
      )
      .eq("id", request.stake_id)
      .maybeSingle();

    if (stakeError) throw httpError(502, "Stake lookup failed.");
    if (!stake) throw httpError(409, "Referenced stake was not found.");
    if (String(stake.network || "").toLowerCase() !== MAINNET) {
      throw httpError(403, "Referenced stake is not Mainnet.");
    }
    if (String(stake.pi_uid || "") !== piUid) {
      throw httpError(403, "Withdrawal Pi identity does not match the stake.");
    }
    if (String(stake.project_id || "") !== String(request.project_id || "")) {
      throw httpError(409, "Withdrawal project does not match the stake.");
    }

    // Do not accept a client-supplied recipient. Confirm this is a Pi-style
    // public key before the transaction is built.
    const StellarSdk = require("stellar-sdk");
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(recipient)) {
      throw httpError(400, "Withdrawal wallet address is not a valid Pi public key.");
    }

    const memo = `ALBUKHR-WD:${id}`;
    let a2uPayment = null;

    // Recover a previously-created A2U payment after a crash/retry.
    const incomplete = await getIncompleteA2UPayments();
    const recovered = incomplete.find((item) => {
      const metadata = item?.metadata || {};
      return String(metadata.withdrawal_request_id || "") === id;
    });

    if (recovered?.identifier) {
      a2uPayment = {
        payment: recovered,
        payment_id: String(recovered.identifier)
      };
    } else {
      const created = await createA2UPayment({
        uid: piUid,
        amount: requestedAmount,
        memo,
        metadata: {
          source: "albukhr-api",
          network: MAINNET,
          withdrawal_request_id: id,
          project_code: String(request.project_code || ""),
          withdrawal_type: String(request.withdrawal_type || ""),
          requested_amount: requestedAmount,
          fee_amount: feeAmount,
          total_deduction: totalDeduction,
          wallet_receive: walletReceive
        }
      });
      a2uPayment = created;
    }

    const paymentId = clean(a2uPayment.payment_id, "A2U payment_id", 200);
    let paymentState = await getA2UPayment(paymentId);

    // If Pi already considers the server payment completed and exposes a txid,
    // do not submit another blockchain transaction.
    const existingTxid = String(
      paymentState?.transaction?.txid ||
      paymentState?.transaction?.id ||
      paymentState?.txid ||
      ""
    ).trim();

    const existingStatus = paymentStatus(paymentState);
    let txid = existingTxid;

    if (!txid && existingStatus !== "completed") {
      const submitted = await submitA2UPayment(paymentId, recipient, requestedAmount);
      txid = clean(submitted.txid, "Pi transaction id", 300);
    }

    if (!txid) {
      throw httpError(502, "Pi payout transaction was not confirmed with a transaction id.");
    }

    if (existingStatus !== "completed") {
      await completeA2UPayment(paymentId, txid);
    }

    // Re-read Pi payment after completion and require a completed server payment.
    paymentState = await getA2UPayment(paymentId);
    const finalStatus = paymentStatus(paymentState);
    const confirmedTxid = String(
      paymentState?.transaction?.txid ||
      paymentState?.transaction?.id ||
      paymentState?.txid ||
      txid
    ).trim();

    if (finalStatus !== "completed") {
      throw httpError(502, "Pi A2U payment was not confirmed as completed.");
    }
    if (!confirmedTxid) {
      throw httpError(502, "Completed Pi A2U payment has no transaction id.");
    }

    // Final authoritative write. Never mark paid before Pi confirms completion.
    const { data: paidRows, error: paidError } = await supabase
      .from("withdrawal_requests")
      .update({
        status: "paid",
        txid: confirmedTxid,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("status", "approved")
      .select("id,status,txid,requested_amount,fee_amount,net_amount")
      .maybeSingle();

    if (paidError) throw httpError(502, "Withdrawal paid-state update failed.");
    if (!paidRows) {
      const { data: current } = await supabase
        .from("withdrawal_requests")
        .select("id,status,txid,requested_amount,fee_amount,net_amount")
        .eq("id", id)
        .maybeSingle();

      if (String(current?.status || "").toLowerCase() === "paid" && current?.txid) {
        return {
          already_paid: true,
          withdrawal_request_id: id,
          status: "paid",
          txid: current.txid,
          wallet_receive: Number(current.net_amount ?? current.requested_amount)
        };
      }

      throw httpError(409, "Withdrawal state changed before payout completion.");
    }

    return {
      already_paid: false,
      withdrawal_request_id: id,
      status: "paid",
      txid: confirmedTxid,
      payment_id: paymentId,
      wallet_receive: walletReceive,
      fee_amount: feeAmount,
      total_deduction: totalDeduction
    };
  } finally {
    activePayouts.delete(id);
  }
}

/*
 * Existing U2A investment routes
 */
router.post("/api/pi-payment-approve", async (req, res) => {
  try {
    const identity = await verifiedPiIdentity(req);
    const b = body(req);
    const projectCode = clean(b.project_code, "project_code", 100);
    const paymentId = clean(b.payment_id, "payment_id", 200);
    const amount = positiveAmount(b.amount);
    const durationDays = duration(b.duration);
    const project = await getProject(projectCode, { requireActive: true });
    const treasury = await getTreasury(project.id);
    const payment = await getPayment(paymentId);
    await verifyPaymentForProject(payment, {
      project, treasury, piUid: identity.pi_uid, amount, durationDays
    });
    const result = await approvePayment(paymentId);
    return res.status(200).json({
      success: true,
      data: { payment_id: paymentId, approval: result }
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[ALBUKHR API] Payment approval error", error);
    return res.status(status).json({
      success: false,
      error: status >= 500 ? "Payment approval failed." : error.message
    });
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
    const project = await getProject(projectCode, { requireActive: true });
    const treasury = await getTreasury(project.id);
    const before = await getPayment(paymentId);
    await verifyPaymentForProject(before, {
      project, treasury, piUid: identity.pi_uid, amount, durationDays
    });
    const completion = await completePayment(paymentId, txid);
    const after = await getPayment(paymentId);
    const finalStatus = paymentStatus(after);
    if (finalStatus !== "completed") {
      throw httpError(409, "Pi payment was not confirmed as completed.");
    }
    assertSender(after, identity.pi_uid);
    verifyPaymentMetadata(after, {
      amount, network: MAINNET, project_code: project.project_code, duration: durationDays
    });
    const recipient = paymentRecipient(after);
    if (!recipient || recipient !== treasury.treasury_wallet) {
      throw httpError(403, "Completed Pi payment recipient does not match the project treasury wallet.");
    }
    const transactionId = String(
      after?.transaction?.txid || after?.transaction?.id || txid
    ).trim();

    const { data, error } = await supabase.rpc("create_stake_from_completed_payment", {
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
        project_code: projectCode,
        duration_days: durationDays,
        transaction_id: transactionId
      }
    });

    if (error) {
      console.error("[ALBUKHR API] Stake settlement RPC failed", {
        code: error.code, message: error.message
      });
      throw httpError(502, "ALBUKHR stake settlement failed.");
    }

    return res.status(200).json({
      success: true,
      data: { completion, stake: data }
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[ALBUKHR API] Payment completion error", error);
    return res.status(status).json({
      success: false,
      error: status >= 500 ? "Payment completion failed." : error.message
    });
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
    const rows = projectCode
      ? (data || []).filter(x => String(x.project_code || "") === projectCode)
      : (data || []);

    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return res.status(status).json({
      success: false,
      error: status >= 500 ? "Unable to load stakes." : error.message
    });
  }
});

router.post("/api/withdrawal-request", async (req, res) => {
  try {
    const identity = await verifiedPiIdentity(req);
    const b = body(req);
    const stakeId = clean(b.stake_id, "stake_id", 100);
    const withdrawalType = clean(b.withdrawal_type, "withdrawal_type", 20).toLowerCase();

    if (!["reward", "capital"].includes(withdrawalType)) {
      throw httpError(400, "withdrawal_type is invalid.");
    }

    const requestedAmount = positiveAmount(b.requested_amount);
    if (requestedAmount < MIN_WITHDRAWAL_PI) {
      throw httpError(400, "Minimum withdrawal is 1 Pi.");
    }

    const feePreview = Number((requestedAmount * WITHDRAWAL_FEE_RATE).toFixed(3));

    const { data, error } = await supabase.rpc("create_my_withdrawal_request", {
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET,
      p_stake_id: stakeId,
      p_withdrawal_type: withdrawalType,
      p_requested_amount: requestedAmount
    });

    if (error) {
      console.error("[ALBUKHR API] Withdrawal request RPC failed", {
        code: error.code, message: error.message
      });
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
    return res.status(status).json({
      success: false,
      error: status >= 500 ? "Withdrawal request failed." : error.message
    });
  }
});

/*
 * A2U payout route.
 * This is deliberately operations-authenticated and accepts only the
 * withdrawal_request_id. The request's amount/wallet/UID come from Supabase.
 *
 * Mounting financialGatewayRouter from server.js means this route is part of
 * the existing API. The route itself validates OPERATIONS_API_KEY.
 */
router.post("/api/pay-withdrawal", async (req, res) => {
  const expected = String(process.env.OPERATIONS_API_KEY || "").trim();
  if (!expected) {
    return res.status(503).json({
      success: false,
      code: "OPERATIONS_API_KEY_NOT_CONFIGURED",
      error: "Operations API key is not configured."
    });
  }

  const supplied = String(req.headers["x-api-key"] || "").trim();
  if (!supplied || supplied !== expected) {
    return res.status(401).json({
      success: false,
      code: "OPERATIONS_AUTH_INVALID",
      error: "Operations authentication failed."
    });
  }

  try {
    const b = body(req);
    const withdrawalRequestId = clean(
      b.withdrawal_request_id || b.id,
      "withdrawal_request_id",
      100
    );

    const result = await executeWithdrawalPayout(withdrawalRequestId);

    return res.status(result.already_paid ? 200 : 201).json({
      success: true,
      network: MAINNET,
      data: result
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) {
      console.error("[ALBUKHR API] A2U payout execution error", {
        status,
        code: error?.code,
        message: error?.message
      });
    }

    return res.status(status).json({
      success: false,
      network: MAINNET,
      code: error?.code || "A2U_PAYOUT_FAILED",
      error: status >= 500 ? "Withdrawal payout failed." : error.message
    });
  }
});

module.exports = {
  financialGatewayRouter: router,
  executeWithdrawalPayout
};
