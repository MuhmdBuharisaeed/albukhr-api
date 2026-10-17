"use strict";

const PI_API_BASE = "https://api.minepi.com/v2";

function apiError(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requirePiKey() {
  const key = String(process.env.PI_API_KEY || "").trim();
  if (!key) throw new Error("PI_API_KEY is not configured.");
  return key;
}

async function piRequest(path, options = {}) {
  const key = requirePiKey();
  const response = await fetch(`${PI_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text || null;
  }

  if (!response.ok) {
    const error = new Error(
      data?.message || data?.error || `Pi API request failed with HTTP ${response.status}.`
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function getPayment(id) {
  return piRequest(`/payments/${encodeURIComponent(id)}`);
}

async function approvePayment(id) {
  return piRequest(`/payments/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: "{}"
  });
}

async function completePayment(id, txid) {
  const paymentId = String(id || "").trim();
  const transactionId = String(txid || "").trim();
  if (!paymentId) throw new Error("Pi payment ID is required for completion.");
  if (!transactionId) throw new Error("Pi transaction ID is required for completion.");

  // Enforce the U2A server-approval step even if a caller skips the expected
  // gateway route. An already-completed payment is accepted only as an exact,
  // verified idempotent retry for the same transaction.
  const current = await getPayment(paymentId);
  const status = current?.status;
  if (!status || typeof status !== "object") {
    paymentValidationError(502, "Pi payment status flags are missing or invalid.");
  }
  if (status.cancelled === true || status.user_cancelled === true) {
    paymentValidationError(409, "Pi payment was cancelled.");
  }

  if (status.developer_completed === true) {
    const currentTxid = normalize(current?.transaction?.txid);
    if (status.transaction_verified !== true || current?.transaction?.verified !== true || !currentTxid) {
      paymentValidationError(409, "Completed Pi payment has not been verified on-chain.");
    }
    if (currentTxid !== transactionId) {
      paymentValidationError(403, "Submitted transaction ID does not match the completed Pi payment.");
    }
    return current;
  }

  if (status.developer_approved !== true) {
    paymentValidationError(409, "Pi payment must be server-approved before completion.");
  }

  return piRequest(`/payments/${encodeURIComponent(paymentId)}/complete`, {
    method: "POST",
    body: JSON.stringify({ txid: transactionId })
  });
}

async function getPioneer(token) {
  const accessToken = String(token || "").trim();
  if (!accessToken) throw new Error("Pi access token is required.");

  const response = await fetch(`${PI_API_BASE}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.uid) {
    const error = new Error("Pi authentication could not be verified.");
    error.status = response.status || 401;
    throw error;
  }

  return data;
}

function normalize(value) {
  return String(value ?? "").trim();
}

function paymentValidationError(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

/*
 * Strict U2A PaymentDTO verification shared by Core and Contributor Internal.
 * Pi Platform's PaymentDTO exposes identifier, user_uid, direction, network,
 * to_address, status flags, and transaction verification details. Missing
 * critical fields fail closed rather than being treated as optional.
 */
function verifyU2APaymentDTO(payment, expected = {}) {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
    paymentValidationError(502, "Pi Platform returned an invalid payment response.");
  }

  const expectedId = normalize(expected.paymentId);
  const actualId = normalize(payment.identifier);
  if (!actualId || (expectedId && actualId !== expectedId)) {
    paymentValidationError(403, "Pi payment identifier does not match the requested payment.");
  }

  const actualAmount = Number(payment.amount);
  const expectedAmount = Number(expected.amount);
  if (!Number.isFinite(actualAmount) || !Number.isFinite(expectedAmount) || actualAmount !== expectedAmount) {
    paymentValidationError(400, "Pi payment amount does not match the requested amount.");
  }

  if (normalize(payment.network).toLowerCase() !== "pi network") {
    paymentValidationError(403, "Only Mainnet Pi Network payments are accepted.");
  }
  if (normalize(payment.direction).toLowerCase() !== "user_to_app") {
    paymentValidationError(403, "Payment is not a User-to-App Pi payment.");
  }

  const senderUid = normalize(payment.user_uid);
  if (!senderUid) paymentValidationError(403, "Pi payment has no verified sender UID.");
  if (expected.piUid && senderUid !== normalize(expected.piUid)) {
    paymentValidationError(403, "Pi payment sender does not match the authenticated Pi account.");
  }

  const metadata = payment.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    paymentValidationError(403, "Pi payment metadata is missing or invalid.");
  }
  if (normalize(metadata.network).toLowerCase() !== "mainnet" || expected.network !== "mainnet") {
    paymentValidationError(403, "Only Mainnet payment metadata is accepted.");
  }
  if (normalize(metadata.action).toLowerCase() !== normalize(expected.action).toLowerCase()) {
    paymentValidationError(403, "Unsupported Pi payment action.");
  }
  if (normalize(metadata.project_code) !== normalize(expected.projectCode)) {
    paymentValidationError(403, "Pi payment project does not match the requested project.");
  }
  if (Number(metadata.duration) !== Number(expected.durationDays)) {
    paymentValidationError(403, "Pi payment duration does not match the requested duration.");
  }

  // Bind the accepted, published contract version to the immutable Pi payment.
  // Investment routes must provide an authoritative version ID; missing or
  // mismatched metadata is rejected rather than settling at the latest term.
  const paymentTermVersionId = normalize(metadata.term_version_id).toLowerCase();
  const expectedTermVersionId = normalize(expected.termVersionId).toLowerCase();
  if (!paymentTermVersionId || !expectedTermVersionId || paymentTermVersionId !== expectedTermVersionId) {
    paymentValidationError(403, "Pi payment staking term version does not match the accepted contract.");
  }

  const status = payment.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    paymentValidationError(502, "Pi payment status flags are missing or invalid.");
  }

  for (const key of ["developer_approved", "transaction_verified", "developer_completed", "cancelled", "user_cancelled"]) {
    if (typeof status[key] !== "boolean") {
      paymentValidationError(502, `Pi payment status flag '${key}' is missing or invalid.`);
    }
  }

  if (status.cancelled === true || status.user_cancelled === true) {
    paymentValidationError(409, "Pi payment was cancelled.");
  }

  const recipient = normalize(payment.to_address);
  const treasuryWallet = normalize(expected.treasuryWallet);
  if (recipient && treasuryWallet && recipient !== treasuryWallet) {
    paymentValidationError(403, "Pi payment recipient does not match the project treasury wallet.");
  }
  const recipientRequired = expected.requireRecipient === true || status.developer_completed === true;
  if (recipientRequired && !recipient) {
    paymentValidationError(403, "Pi payment recipient is missing.");
  }
  if (expected.requireRecipient === true && (!treasuryWallet || recipient !== treasuryWallet)) {
    paymentValidationError(403, "Pi payment recipient does not match the project treasury wallet.");
  }

  const state = status.developer_completed === true
    ? "completed"
    : status.developer_approved === true
      ? "approved"
      : "pending";

  let transactionId = "";
  // A DTO claiming server completion must always prove blockchain verification,
  // even if the caller did not explicitly set requireCompleted.
  const requireCompletionVerification = expected.requireCompleted === true || status.developer_completed === true;
  if (requireCompletionVerification) {
    const transaction = payment.transaction;
    transactionId = normalize(transaction?.txid);

    if (status.developer_completed !== true) {
      paymentValidationError(409, "Pi payment is not marked completed by Pi Platform.");
    }
    if (status.transaction_verified !== true || !transaction || transaction.verified !== true) {
      paymentValidationError(409, "Pi blockchain transaction has not been verified.");
    }
    if (!transactionId) paymentValidationError(409, "Verified Pi payment has no transaction ID.");
    if (expected.txid && transactionId !== normalize(expected.txid)) {
      paymentValidationError(403, "Pi transaction ID does not match the submitted transaction.");
    }
  }

  if (expected.requireApproved === true && status.developer_approved !== true) {
    paymentValidationError(409, "Pi payment has not been approved by the server.");
  }

  return { status: state, recipient, senderUid, transactionId };
}

/* Backward-compatible export retained for any existing imports. */
function verifyPaymentMetadata(payment, metadata = {}) {
  return verifyU2APaymentDTO(payment, {
    paymentId: metadata.payment_id || payment?.identifier,
    piUid: metadata.pi_uid,
    amount: metadata.amount,
    network: metadata.network,
    projectCode: metadata.project_code,
    durationDays: metadata.duration,
    termVersionId: metadata.term_version_id,
    action: metadata.action || "add_liquidity",
    treasuryWallet: metadata.treasury_wallet,
    requireRecipient: metadata.require_recipient === true,
    requireCompleted: metadata.require_completed === true,
    requireApproved: metadata.require_approved === true,
    txid: metadata.txid
  });
}

module.exports = {
  getPayment,
  approvePayment,
  completePayment,
  getPioneer,
  verifyPaymentMetadata,
  verifyU2APaymentDTO
};
