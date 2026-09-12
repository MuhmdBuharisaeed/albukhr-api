"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const { getPayment, getPioneer, verifyPaymentMetadata } = require("./pi-client");

const router = express.Router();
const MAINNET = "mainnet";

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
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
    ? req.body : {};
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

async function verifiedPiIdentity(req) {
  const token = requireBearer(req);
  const pioneer = await getPioneer(token);
  const piUid = String(pioneer.uid || "").trim();
  if (!piUid) throw httpError(401, "Pi identity could not be verified.");
  return { pi_uid: piUid };
}

async function getProject(projectCode) {
  const { data, error } = await supabase
    .from("projects")
    .select("id,project_code,project_type,status,core_slot,network")
    .eq("project_code", projectCode)
    .eq("network", MAINNET)
    .maybeSingle();

  if (error) {
    console.error("[ALBUKHR API] Project lookup failed", {
      code: error.code, message: error.message
    });
    throw httpError(502, "ALBUKHR project lookup failed.");
  }
  if (!data) throw httpError(404, "Mainnet project was not found.");
  if (String(data.project_type).toLowerCase() !== "core") {
    throw httpError(403, "Only Mainnet Core Projects can receive core liquidity.");
  }
  if (!Number.isInteger(Number(data.core_slot)) ||
      Number(data.core_slot) < 1 || Number(data.core_slot) > 7) {
    throw httpError(403, "Project Core Slot is invalid.");
  }
  if (!["approved", "active"].includes(String(data.status).toLowerCase())) {
    throw httpError(403, "Project is not eligible for liquidity settlement.");
  }
  return data;
}

function paymentRecipient(payment) {
  return String(
    payment?.to_address ||
    payment?.recipient_address ||
    payment?.recipient?.address ||
    payment?.transaction?.to_address || ""
  ).trim();
}

function paymentSenderUid(payment) {
  return String(
    payment?.from_uid ||
    payment?.sender_uid ||
    payment?.sender?.uid || ""
  ).trim();
}

function paymentStatus(payment) {
  return String(
    payment?.status || payment?.transaction?.status || ""
  ).trim().toLowerCase();
}

async function settle(req, identity) {
  const b = body(req);
  const projectCode = clean(b.project_code, "project_code", 100);
  const paymentId = clean(b.payment_id, "payment_id", 200);
  const amount = positiveAmount(b.amount);

  const project = await getProject(projectCode);

  const { data: treasury, error: treasuryError } = await supabase
    .from("project_treasury")
    .select("treasury_wallet,required_liquidity,status,network")
    .eq("project_id", project.id)
    .maybeSingle();

  if (treasuryError) {
    console.error("[ALBUKHR API] Treasury lookup failed", {
      code: treasuryError.code, message: treasuryError.message
    });
    throw httpError(502, "ALBUKHR treasury lookup failed.");
  }
  if (!treasury) throw httpError(409, "Project treasury is not configured.");
  if (!treasury.treasury_wallet || treasury.required_liquidity == null) {
    throw httpError(409, "Project treasury is not fully configured.");
  }
  if (treasury.network !== MAINNET) {
    throw httpError(403, "Only Mainnet treasury is accepted.");
  }

  const payment = await getPayment(paymentId);
  const status = paymentStatus(payment);

  if (status !== "completed") {
    throw httpError(409, "Pi payment is not completed.");
  }

  const senderUid = paymentSenderUid(payment);
  if (senderUid && senderUid !== identity.pi_uid) {
    throw httpError(403, "Pi payment sender does not match the authenticated Pi account.");
  }

  const recipient = paymentRecipient(payment);
  if (!recipient) throw httpError(502, "Pi payment recipient could not be verified.");
  if (recipient !== treasury.treasury_wallet) {
    throw httpError(403, "Pi payment recipient does not match the project treasury wallet.");
  }

  verifyPaymentMetadata(payment, {
    amount,
    network: MAINNET,
    project_code: projectCode
  });

  const transactionId = String(
    payment?.transaction?.txid ||
    payment?.transaction?.id || ""
  ).trim() || null;

  const { data, error } = await supabase.rpc(
    "settle_project_liquidity_payment",
    {
      p_project_id: project.id,
      p_payment_id: paymentId,
      p_payer_pi_uid: identity.pi_uid,
      p_amount: amount,
      p_recipient_wallet: recipient,
      p_pi_status: status,
      p_verification_reference: transactionId,
      p_request_id: null,
      p_metadata: {
        source: "albukhr-api",
        project_code: projectCode,
        pi_payment_status: status,
        transaction_id: transactionId
      }
    }
  );

  if (error) {
    console.error("[ALBUKHR API] Liquidity settlement RPC failed", {
      code: error.code, message: error.message
    });
    throw httpError(502, "ALBUKHR liquidity settlement failed.");
  }

  return data;
}

router.post("/api/pi-project-treasury-payment", async (req, res) => {
  try {
    const identity = await verifiedPiIdentity(req);
    const result = await settle(req, identity);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[ALBUKHR API] Financial gateway error", error);
    return res.status(status).json({
      success: false,
      error: status >= 500 ? "Financial settlement failed." : error.message
    });
  }
});

module.exports = { financialGatewayRouter: router };
