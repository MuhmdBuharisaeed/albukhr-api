/* ALBUKHR API — External Project Owner Operations Gateway v2
 * Mainnet-only trusted gateway. Separate from Internal, Core and funding-plan routes.
 * Browser Pi token -> Pi /v2/me -> canonical public.users identity -> service-role RPC.
 * Pi U2A DTO is fetched from the Pi Platform before approval and settlement.
 * No A2U payout or owner withdrawal execution is provided by this gateway.
 */
"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { supabase } = require("./supabase-client");
const {
  getPioneer,
  getPayment,
  approvePayment,
  completePayment
} = require("./pi-client");

const router = express.Router();
const MAINNET = "mainnet";
const PI_NETWORK = "pi network";
const PI_ACTION = "external_add_liquidity";
const DOCUMENT_BUCKET = "external-project-documents";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_EVIDENCE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp"
]);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clean(value) {
  return String(value ?? "").trim();
}

function configuredReceivingWallet() {
  return clean(process.env.PI_MAINNET_RECEIVING_WALLET);
}

function requireBearer(req) {
  const authorization = clean(req.headers.authorization);
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    throw httpError(401, "Pi authentication token is required.");
  }
  const token = authorization.slice(7).trim();
  if (!token) throw httpError(401, "Pi authentication token is required.");
  return token;
}

async function verifiedPiIdentity(req) {
  try {
    const pioneer = await getPioneer(requireBearer(req));
    const piUid = clean(pioneer?.uid);
    if (!piUid) throw new Error("Pi /v2/me did not return a UID.");
    return Object.freeze({ pi_uid: piUid, network: MAINNET });
  } catch (error) {
    console.warn("[EXTERNAL OWNER OPERATIONS] Pi identity verification failed.", {
      status: error?.status || null,
      message: error?.message || null
    });
    throw httpError(401, "Pi identity verification failed.");
  }
}

function requireUuid(value, field = "ID") {
  const normalized = clean(value);
  if (!UUID_PATTERN.test(normalized)) {
    throw httpError(400, `${field} is invalid.`);
  }
  return normalized;
}

function requestBody(req) {
  return req.body && typeof req.body === "object" &&
    !Buffer.isBuffer(req.body) && !Array.isArray(req.body)
    ? req.body
    : {};
}

function positiveAmount(value) {
  const amountText = clean(value);
  if (!/^\d{1,18}(?:\.\d{1,9})?$/.test(amountText)) {
    throw httpError(400, "Amount must be a positive Pi value with no more than 9 decimal places.");
  }
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw httpError(400, "A valid positive liquidity amount is required.");
  }
  return amountText;
}

function rpcStatus(error) {
  switch (String(error?.code || "")) {
    case "42501": return 403;
    case "22023": return 400;
    case "23505": return 409;
    case "55000": return 423;
    case "P0002": return 404;
    default: return 502;
  }
}

async function callTrustedRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const status = rpcStatus(error);
    console.error(`[EXTERNAL OWNER OPERATIONS] ${name} failed.`, {
      code: error.code || null,
      message: error.message || null,
      details: error.details || null
    });
    throw httpError(
      status,
      status >= 500
        ? "External Project Owner Operations database operation failed."
        : (error.message || "External Project Owner Operations request was rejected.")
    );
  }

  const result = Array.isArray(data) ? (data[0] || null) : data;
  if (!result || typeof result !== "object") {
    throw httpError(502, "External Project Owner Operations returned an invalid response.");
  }
  if (result.success === false) {
    throw httpError(409, result.message || "External Project Owner Operations request was rejected.");
  }
  return result;
}

function noStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function respond(handler) {
  return async (req, res) => {
    noStore(res);
    try {
      const identity = await verifiedPiIdentity(req);
      const data = await handler(req, identity);
      return res.status(200).json({
        success: true,
        network: MAINNET,
        data
      });
    } catch (error) {
      const status = Number(error?.status);
      if (status >= 400 && status < 500) {
        return res.status(status).json({
          success: false,
          network: MAINNET,
          error: error.message
        });
      }

      console.error("[EXTERNAL OWNER OPERATIONS] Request failed.", {
        status: status || null,
        code: error?.code || null,
        message: error?.message || null
      });
      return res.status(502).json({
        success: false,
        network: MAINNET,
        error: "External Project owner operation failed."
      });
    }
  };
}

function projectCodeFromIntent(intent) {
  return clean(intent?.metadata?.project_code || intent?.project_code);
}

function verifyExternalLiquidityPayment(payment, expected, piUid, options = {}) {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
    throw httpError(502, "Pi Platform returned an invalid payment response.");
  }

  const paymentId = clean(options.paymentId || expected.payment_id);
  if (!paymentId || clean(payment.identifier) !== paymentId) {
    throw httpError(403, "Pi PaymentDTO identifier does not match the Pi-generated payment ID.");
  }
  if (expected.payment_id && clean(expected.payment_id) !== paymentId) {
    throw httpError(403, "Pi payment ID does not match the payment bound to this liquidity intent.");
  }

  const actualAmount = Number(payment.amount);
  const expectedAmount = Number(expected.amount);
  if (!Number.isFinite(actualAmount) || actualAmount !== expectedAmount) {
    throw httpError(400, "Pi payment amount does not match the approved liquidity intent.");
  }
  if (clean(payment.network).toLowerCase() !== PI_NETWORK) {
    throw httpError(403, "Only Mainnet Pi Network payments are accepted.");
  }
  if (clean(payment.direction).toLowerCase() !== "user_to_app") {
    throw httpError(403, "Payment is not a User-to-App Pi payment.");
  }

  const senderUid = clean(payment.user_uid);
  if (!senderUid || senderUid !== clean(piUid) || clean(expected.payer_pi_uid) !== clean(piUid)) {
    throw httpError(403, "Pi payment sender does not match the authenticated owner.");
  }

  const recipientAddress = clean(payment.to_address);
  if (!recipientAddress || recipientAddress !== clean(expected.recipient_wallet)) {
    throw httpError(403, "Pi payment recipient does not match the approved External Treasury wallet.");
  }

  const metadata = payment.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw httpError(403, "Pi payment metadata is missing or invalid.");
  }

  const metadataMatches =
    clean(expected.network).toLowerCase() === MAINNET &&
    clean(expected.action) === PI_ACTION &&
    clean(metadata.network).toLowerCase() === MAINNET &&
    clean(metadata.action) === PI_ACTION &&
    clean(metadata.project_code) === projectCodeFromIntent(expected) &&
    clean(metadata.application_id) === clean(expected.application_id) &&
    clean(metadata.request_id) === clean(expected.request_id);
  if (!metadataMatches) {
    throw httpError(403, "Pi payment metadata does not match the External Project liquidity intent.");
  }

  const status = payment.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw httpError(502, "Pi payment status flags are missing or invalid.");
  }
  for (const key of [
    "developer_approved",
    "transaction_verified",
    "developer_completed",
    "cancelled",
    "user_cancelled"
  ]) {
    if (typeof status[key] !== "boolean") {
      throw httpError(502, `Pi payment status flag '${key}' is missing or invalid.`);
    }
  }

  const isCancelled = status.cancelled === true || status.user_cancelled === true;
  if (isCancelled && (
    status.developer_completed === true ||
    status.transaction_verified === true ||
    payment.transaction?.verified === true
  )) {
    throw httpError(502, "Pi PaymentDTO contains contradictory cancellation and completed-transaction states.");
  }
  if (isCancelled && options.allowCancelled !== true) {
    throw httpError(409, "Pi payment was cancelled.");
  }
  if (options.requireApproved === true && status.developer_approved !== true &&
      !(options.allowCancelled === true && isCancelled)) {
    throw httpError(409, "Pi payment has not been approved by ALBUKHR.");
  }

  let transactionId = clean(payment.transaction?.txid);
  if (options.requireVerifiedTransaction === true) {
    if (status.transaction_verified !== true || payment.transaction?.verified !== true || !transactionId) {
      throw httpError(409, "Pi has not yet verified the liquidity transaction on-chain.");
    }
    if (options.txid && transactionId !== clean(options.txid)) {
      throw httpError(403, "Submitted transaction ID does not match Pi's verified transaction.");
    }
  }
  if (options.requireCompleted === true && status.developer_completed !== true) {
    throw httpError(409, "Pi has not confirmed developer completion of the payment.");
  }

  return {
    transaction_id: transactionId,
    developer_approved: status.developer_approved === true,
    developer_completed: status.developer_completed === true,
    cancelled: isCancelled
  };
}

function normalizeEvidenceType(value) {
  const type = clean(value).split(";")[0].toLowerCase();
  if (!ALLOWED_EVIDENCE_TYPES.has(type)) {
    throw httpError(415, "Evidence must be PDF, PNG, JPG/JPEG or WEBP.");
  }
  return type;
}

function verifyEvidenceBytes(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw httpError(400, "Evidence file is empty.");
  }
  if (buffer.length > 10 * 1024 * 1024) {
    throw httpError(413, "Evidence file must not exceed 10 MB.");
  }

  let valid = false;
  if (mimeType === "application/pdf") {
    valid = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  } else if (mimeType === "image/png") {
    valid = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } else if (mimeType === "image/jpeg") {
    valid = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  } else if (mimeType === "image/webp") {
    valid = buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP";
  }

  if (!valid) {
    throw httpError(415, "Evidence file content does not match its declared file type.");
  }
}

function safeFileName(value) {
  const base = clean(value).split(/[\\/]/).pop() || "evidence";
  const normalized = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/\.{2,}/g, ".")
    .slice(0, 120);
  return normalized || "evidence";
}

/* --------------------------------------------------------------------------
 * Workspace
 * -------------------------------------------------------------------------- */

router.get(
  "/:applicationId/workspace",
  respond(async (req, identity) => {
    const applicationId = requireUuid(req.params.applicationId, "Application ID");
    const workspace = await callTrustedRpc("gateway_get_external_owner_workspace_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId
    });

    const custodyWallet = clean(
      workspace?.activation_gate?.recipient_wallet || workspace?.treasury?.treasury_wallet
    );
    const configuredWallet = configuredReceivingWallet();
    const walletMatches = Boolean(configuredWallet && custodyWallet && configuredWallet === custodyWallet);
    const activationReady = workspace?.activation_gate?.ready === true;
    const projectActive = clean(workspace?.project?.status).toLowerCase() === "active";

    workspace.payment_configuration = {
      ready: walletMatches,
      receiving_wallet_configured: Boolean(configuredWallet),
      matches_approved_custody_wallet: walletMatches
    };
    workspace.can_add_liquidity = activationReady && projectActive && walletMatches;
    workspace.can_withdraw = false;

    const blockers = Array.isArray(workspace?.activation_gate?.blocking_reasons)
      ? [...workspace.activation_gate.blocking_reasons]
      : [];
    if (!configuredWallet) {
      blockers.push({ code: "pi_mainnet_receiving_wallet_not_configured" });
    } else if (custodyWallet && !walletMatches) {
      blockers.push({ code: "pi_app_receiving_wallet_custody_mismatch" });
    }
    workspace.liquidity_blockers = blockers;
    return workspace;
  })
);

/* --------------------------------------------------------------------------
 * Pi U2A liquidity: create -> approve -> complete -> settle
 * -------------------------------------------------------------------------- */

router.post(
  "/:applicationId/liquidity/intents",
  respond(async (req, identity) => {
    const applicationId = requireUuid(req.params.applicationId, "Application ID");
    const input = requestBody(req);
    const amount = positiveAmount(input.amount);
    const requestId = input.request_id
      ? requireUuid(input.request_id, "Request ID")
      : crypto.randomUUID();

    // The database independently checks the activation/custody snapshot and
    // compares this configured app wallet to the approved custody wallet.
    const configuredWallet = configuredReceivingWallet();
    if (!configuredWallet) {
      throw httpError(503, "PI_MAINNET_RECEIVING_WALLET is not configured on the trusted API.");
    }

    const intent = await callTrustedRpc("gateway_create_external_liquidity_intent_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_amount: amount,
      p_request_id: requestId,
      p_recipient_wallet: configuredWallet
    });

    if (intent.already_exists === true) {
      throw httpError(409,
        "This liquidity request ID already exists. The existing intent must be reconciled before starting another Pi payment.");
    }

    return intent;
  })
);

router.post(
  "/:applicationId/liquidity/approve",
  respond(async (req, identity) => {
    const applicationId = requireUuid(req.params.applicationId, "Application ID");
    const input = requestBody(req);
    const requestId = requireUuid(input.request_id, "Request ID");
    const paymentId = clean(input.payment_id);
    if (!paymentId) throw httpError(400, "Pi-generated payment ID is required.");

    const expected = await callTrustedRpc("gateway_get_external_liquidity_intent_by_request_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_request_id: requestId
    });

    if (expected.verification_status === "verified") {
      if (clean(expected.payment_id) !== paymentId) {
        throw httpError(403, "Pi payment ID does not match the already-settled liquidity intent.");
      }
      return {
        already_settled: true,
        payment_id: paymentId,
        request_id: requestId
      };
    }
    if (!['pending', 'approved'].includes(clean(expected.verification_status))) {
      throw httpError(409, "This liquidity intent is no longer pending.");
    }

    const payment = await getPayment(paymentId);
    const checked = verifyExternalLiquidityPayment(payment, expected, identity.pi_uid, {
      paymentId,
      allowCancelled: true
    });

    await callTrustedRpc("gateway_bind_external_liquidity_payment_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_request_id: requestId,
      p_payment_id: paymentId
    });

    if (checked.cancelled) {
      return callTrustedRpc("gateway_reject_cancelled_external_liquidity_intent_trusted", {
        p_pi_uid: identity.pi_uid,
        p_application_id: applicationId,
        p_payment_id: paymentId,
        p_reason: "Pi PaymentDTO reports cancellation"
      });
    }

    if (!checked.developer_approved) {
      await approvePayment(paymentId);
    }

    const confirmed = await getPayment(paymentId);
    const finalCheck = verifyExternalLiquidityPayment(confirmed, expected, identity.pi_uid, {
      paymentId,
      requireApproved: true
    });
    if (!finalCheck.developer_approved) {
      throw httpError(502, "Pi did not confirm ALBUKHR payment approval.");
    }

    await callTrustedRpc("gateway_mark_external_liquidity_approved_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_payment_id: paymentId
    });

    return {
      approved: true,
      payment_id: paymentId,
      request_id: requestId,
      amount: expected.amount,
      recipient_wallet: expected.recipient_wallet
    };
  })
);

router.post(
  "/:applicationId/liquidity/complete",
  respond(async (req, identity) => {
    const applicationId = requireUuid(req.params.applicationId, "Application ID");
    const input = requestBody(req);
    const paymentId = clean(input.payment_id);
    const txid = clean(input.txid);
    if (!paymentId || !txid || txid.length > 200) {
      throw httpError(400, "Pi payment ID and transaction ID are required.");
    }

    const expected = await callTrustedRpc("gateway_get_external_liquidity_intent_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_payment_id: paymentId
    });

    if (expected.verification_status === "verified") {
      return callTrustedRpc("gateway_settle_external_liquidity_payment_trusted", {
        p_pi_uid: identity.pi_uid,
        p_application_id: applicationId,
        p_payment_id: paymentId,
        p_txid: txid
      });
    }

    const before = await getPayment(paymentId);
    const beforeStatus = before?.status;

    // Check cancellation before requiring an on-chain transaction. A genuinely
    // cancelled Pi payment normally has no verified transaction ID.
    const initialCheck = verifyExternalLiquidityPayment(before, expected, identity.pi_uid, {
      paymentId,
      allowCancelled: true
    });

    if (initialCheck.cancelled) {
      await callTrustedRpc("gateway_reject_cancelled_external_liquidity_intent_trusted", {
        p_pi_uid: identity.pi_uid,
        p_application_id: applicationId,
        p_payment_id: paymentId,
        p_reason: "Pi PaymentDTO reports cancellation"
      });
      throw httpError(409, "Pi payment was cancelled; its liquidity reservation has been released.");
    }

    // Repair the narrow case where Pi approved the payment but the API caller
    // lost the previous approval response before the DB approval marker arrived.
    if (expected.verification_status === "pending" && beforeStatus?.developer_approved === true) {
      await callTrustedRpc("gateway_mark_external_liquidity_approved_trusted", {
        p_pi_uid: identity.pi_uid,
        p_application_id: applicationId,
        p_payment_id: paymentId
      });
    }

    const beforeCheck = verifyExternalLiquidityPayment(before, expected, identity.pi_uid, {
      paymentId,
      requireApproved: true,
      requireVerifiedTransaction: true,
      txid
    });

    if (!beforeCheck.transaction_id) {
      throw httpError(409, "Pi has not returned a verified transaction ID.");
    }
    if (!beforeCheck.developer_completed) {
      await completePayment(paymentId, txid);
    }

    const after = await getPayment(paymentId);
    verifyExternalLiquidityPayment(after, expected, identity.pi_uid, {
      paymentId,
      requireApproved: true,
      requireVerifiedTransaction: true,
      requireCompleted: true,
      txid
    });

    return callTrustedRpc("gateway_settle_external_liquidity_payment_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_payment_id: paymentId,
      p_txid: txid
    });
  })
);

/*
 * Unbound intent abandonment is intentionally not exposed to the owner.
 * A trusted operations process may call the service-role-only recovery RPC
 * after it confirms through Pi Platform that no payment was created.
 */

router.post(
  "/:applicationId/liquidity/cancel",
  respond(async (req, identity) => {
    const applicationId = requireUuid(req.params.applicationId, "Application ID");
    const input = requestBody(req);
    const requestId = requireUuid(input.request_id, "Request ID");
    const paymentId = clean(input.payment_id);
    if (!paymentId) throw httpError(400, "Pi-generated payment ID is required for cancellation.");

    const expected = await callTrustedRpc("gateway_get_external_liquidity_intent_by_request_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_request_id: requestId
    });
    if (expected.verification_status === "rejected") {
      if (clean(expected.payment_id) !== paymentId) {
        throw httpError(403, "Pi payment ID does not match the rejected liquidity intent.");
      }
      return { cancelled: true, already_cancelled: true, request_id: requestId };
    }
    if (!['pending', 'approved'].includes(clean(expected.verification_status))) {
      throw httpError(409, "Only a pending or approved Pi payment can be cancelled.");
    }

    const payment = await getPayment(paymentId);
    const checked = verifyExternalLiquidityPayment(payment, expected, identity.pi_uid, {
      paymentId,
      allowCancelled: true
    });
    if (!checked.cancelled) {
      throw httpError(409, "Pi has not confirmed that this payment was cancelled.");
    }

    await callTrustedRpc("gateway_bind_external_liquidity_payment_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_request_id: requestId,
      p_payment_id: paymentId
    });
    return callTrustedRpc("gateway_reject_cancelled_external_liquidity_intent_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_payment_id: paymentId,
      p_reason: "Pi PaymentDTO reports cancellation"
    });
  })
);

/* --------------------------------------------------------------------------
 * Withdrawal requests remain hard-locked. No A2U is imported or invoked.
 * -------------------------------------------------------------------------- */

router.post(
  "/:applicationId/withdrawals",
  respond(async () => {
    throw httpError(423,
      "Owner withdrawals are locked until owner AAL2 step-up, eligible-liquidity reservation, separate admin approval and reconciliation controls are implemented. No withdrawal or payout has been created.");
  })
);

/* --------------------------------------------------------------------------
 * Owner-authored updates remain private until a separate admin publish action.
 * -------------------------------------------------------------------------- */

router.post(
  "/:applicationId/updates",
  respond(async (req, identity) => {
    const input = requestBody(req);
    const applicationId = requireUuid(req.params.applicationId, "Application ID");
    const updateId = input.update_id ? requireUuid(input.update_id, "Update ID") : null;
    return callTrustedRpc("gateway_save_external_owner_update_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_update_id: updateId,
      p_title: clean(input.title),
      p_summary: clean(input.summary),
      p_body: clean(input.body),
      p_update_type: clean(input.update_type) || "progress",
      p_submit: input.submit === true
    });
  })
);

router.post(
  "/:applicationId/updates/:updateId/evidence",
  respond(async (req, identity) => {
    const applicationId = requireUuid(req.params.applicationId, "Application ID");
    const updateId = requireUuid(req.params.updateId, "Update ID");
    if (!Buffer.isBuffer(req.body)) {
      throw httpError(400, "Evidence file bytes are required.");
    }

    const mimeType = normalizeEvidenceType(req.headers["content-type"]);
    verifyEvidenceBytes(req.body, mimeType);

    const context = await callTrustedRpc("gateway_get_external_owner_update_upload_context_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_update_id: updateId
    });
    const fileName = safeFileName(req.headers["x-file-name"] || "evidence");
    const projectFolder = clean(context.project_id) || "unconverted";
    const storagePath = [
      "mainnet/owner-updates",
      projectFolder,
      updateId,
      `${crypto.randomUUID()}-${fileName}`
    ].join("/");

    const { error: uploadError } = await supabase.storage
      .from(DOCUMENT_BUCKET)
      .upload(storagePath, req.body, {
        upsert: false,
        contentType: mimeType,
        cacheControl: "3600"
      });

    if (uploadError) {
      console.error("[EXTERNAL OWNER OPERATIONS] Private evidence upload failed.", {
        message: uploadError.message || null,
        details: uploadError.details || null
      });
      throw httpError(502, "Private project evidence upload failed.");
    }

    try {
      return await callTrustedRpc("gateway_register_external_owner_update_evidence_trusted", {
        p_pi_uid: identity.pi_uid,
        p_application_id: applicationId,
        p_update_id: updateId,
        p_storage_path: storagePath,
        p_file_name: fileName,
        p_mime_type: mimeType,
        p_file_size_bytes: req.body.length
      });
    } catch (error) {
      const { error: removeError } = await supabase.storage
        .from(DOCUMENT_BUCKET)
        .remove([storagePath]);
      if (removeError) {
        console.error("[EXTERNAL OWNER OPERATIONS] Evidence rollback failed.", {
          path: storagePath,
          message: removeError.message || null
        });
      }
      throw error;
    }
  })
);

router.get(
  "/:applicationId/updates/:updateId/evidence/:evidenceId",
  respond(async (req, identity) => {
    const applicationId = requireUuid(req.params.applicationId, "Application ID");
    const updateId = requireUuid(req.params.updateId, "Update ID");
    const evidenceId = requireUuid(req.params.evidenceId, "Evidence ID");
    const context = await callTrustedRpc("gateway_get_external_owner_update_evidence_download_context_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId,
      p_update_id: updateId,
      p_evidence_id: evidenceId
    });

    if (context.storage_bucket !== DOCUMENT_BUCKET || !context.storage_path) {
      throw httpError(502, "Private evidence storage reference is invalid.");
    }

    const { data, error } = await supabase.storage
      .from(DOCUMENT_BUCKET)
      .createSignedUrl(context.storage_path, 60, {
        download: context.file_name || true
      });

    if (error || !data?.signedUrl) {
      console.error("[EXTERNAL OWNER OPERATIONS] Private evidence signed URL failed.", {
        message: error?.message || null
      });
      throw httpError(502, "Private evidence download could not be prepared.");
    }

    return {
      signed_url: data.signedUrl,
      expires_in_seconds: 60,
      file_name: context.file_name,
      mime_type: context.mime_type,
      file_size_bytes: context.file_size_bytes
    };
  })
);

module.exports = {
  externalProjectOwnerOperationsGatewayRouter: router
};
