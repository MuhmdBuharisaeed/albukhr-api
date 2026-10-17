"use strict";

/*
 * ALBUKHR A2U read-only Pi reconciliation inspector.
 * This module NEVER creates, approves, submits, completes, cancels or marks a
 * payment paid. An absent payment lookup is NOT proof that no payment occurred.
 */
const crypto = require("node:crypto");

const MAINNET = "mainnet";
const PI_NETWORK_LABEL = "Pi Network";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PI_BASE_DEFAULT = "https://api.minepi.com/v2";

function fail(code, status = 500, message = "A2U reconciliation inspection failed.") {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function sameAmount(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9;
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateBaseUrl(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl || PI_BASE_DEFAULT); }
  catch { throw fail("PI_API_BASE_INVALID", 503, "Pi Platform API base URL is invalid."); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.minepi.com" || parsed.username || parsed.password ||
      parsed.pathname.replace(/\/+$/, "") !== "/v2" || parsed.search || parsed.hash) {
    throw fail("PI_API_BASE_NOT_ALLOWED", 503, "Read-only reconciliation is restricted to the official Pi Platform API host over HTTPS.");
  }
  return parsed.toString().replace(/\/+$/, "");
}

async function getPiJson(path, { fetchImpl = globalThis.fetch, apiKey = process.env.PI_API_KEY, baseUrl = process.env.PI_PLATFORM_API_BASE } = {}) {
  if (typeof fetchImpl !== "function") throw fail("FETCH_NOT_AVAILABLE", 503, "This Node.js runtime does not provide fetch().");
  const key = String(apiKey || "").trim();
  if (!key) throw fail("PI_API_KEY_MISSING", 503, "Pi Server API key is not configured; no payment action was taken.");
  const base = validateBaseUrl(baseUrl);
  let response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      method: "GET",
      headers: { Authorization: `Key ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
      redirect: "error"
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { ok: false, status: 0, data: null, code: timedOut ? "PI_API_TIMEOUT" : "PI_API_NETWORK_ERROR" };
  }
  let data = null;
  try { data = await response.json(); } catch { /* body intentionally ignored if invalid */ }
  return {
    ok: response.ok === true,
    status: Number(response.status) || 0,
    data,
    code: response.ok ? null : `PI_API_HTTP_${Number(response.status) || 0}`
  };
}

function getIncompleteArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.incomplete_server_payments)) return payload.incomplete_server_payments;
  return null;
}

function assessPayment(request, payment, chosenPaymentId) {
  const status = payment?.status && typeof payment.status === "object" ? payment.status : {};
  const tx = payment?.transaction && typeof payment.transaction === "object" ? payment.transaction : null;
  const metadata = payment?.metadata && typeof payment.metadata === "object" && !Array.isArray(payment.metadata) ? payment.metadata : {};
  const txid = String(tx?.txid || "").trim() || null;
  const paymentId = String(payment?.identifier || "").trim() || null;
  const contradictions = [];

  if (!paymentId || (chosenPaymentId && paymentId !== chosenPaymentId)) contradictions.push("payment_id_mismatch");
  if (String(payment?.user_uid || "") !== String(request.pi_uid || "")) contradictions.push("pi_uid_mismatch");
  if (!sameAmount(payment?.amount, request.requested_amount)) contradictions.push("amount_mismatch");
  if (String(payment?.memo || "") !== `ALBUKHR-WD:${request.id}`) contradictions.push("memo_mismatch");
  if (String(payment?.direction || "") !== "app_to_user") contradictions.push("direction_mismatch");
  if (String(payment?.network || "") !== PI_NETWORK_LABEL) contradictions.push("network_mismatch");
  if (String(metadata.withdrawal_request_id || "") !== String(request.id)) contradictions.push("metadata_request_id_mismatch");
  if (String(metadata.source || "") !== "albukhr-api") contradictions.push("metadata_source_mismatch");
  if (String(metadata.network || "").toLowerCase() !== MAINNET) contradictions.push("metadata_network_mismatch");

  let classification = "PAYMENT_STATE_UNRESOLVED";
  if (contradictions.length) {
    classification = "PI_PAYMENT_IDENTITY_MISMATCH";
  } else if (status.cancelled === true || status.user_cancelled === true) {
    classification = "CANCELLED_PAYMENT_REQUIRES_REVIEW";
  } else if (status.developer_approved === true && status.transaction_verified === true && tx?.verified === true && txid && status.developer_completed === true) {
    classification = "CONFIRMED_PI_PAYMENT_COMPLETED";
  } else if (status.transaction_verified === true && tx?.verified === true && txid && status.developer_completed !== true) {
    classification = "CHAIN_TRANSACTION_VERIFIED_COMPLETION_PENDING";
  } else if (txid || status.transaction_verified === true || status.developer_completed === true) {
    classification = "PARTIAL_OR_CONTRADICTORY_PI_EVIDENCE";
  }

  const evidence = {
    payment_id: paymentId,
    pi_uid_matches: String(payment?.user_uid || "") === String(request.pi_uid || ""),
    amount_matches: sameAmount(payment?.amount, request.requested_amount),
    memo_matches: String(payment?.memo || "") === `ALBUKHR-WD:${request.id}`,
    direction: String(payment?.direction || ""),
    network: String(payment?.network || ""),
    metadata_request_id_matches: String(metadata.withdrawal_request_id || "") === String(request.id),
    metadata_source_matches: String(metadata.source || "") === "albukhr-api",
    metadata_network_matches: String(metadata.network || "").toLowerCase() === MAINNET,
    developer_approved: status.developer_approved === true,
    transaction_verified: status.transaction_verified === true,
    transaction_verified_field: tx?.verified === true,
    developer_completed: status.developer_completed === true,
    cancelled: status.cancelled === true,
    user_cancelled: status.user_cancelled === true,
    transaction_id: txid,
    recipient_wallet_present: Boolean(String(payment?.to_address || "").trim()),
    recipient_wallet_matches_stored: String(payment?.to_address || "").trim() === String(request.wallet_address || "").trim(),
    contradictions
  };

  return {
    classification,
    is_external_payment_possible: true,
    safe_to_mark_paid_automatically: false,
    safe_to_release_manual_payout: false,
    evidence,
    evidence_sha256: canonicalHash({ withdrawal_request_id: request.id, evidence })
  };
}

async function inspectA2UWithdrawal({
  withdrawalRequestId,
  database,
  fetchImpl = globalThis.fetch,
  apiKey = process.env.PI_API_KEY,
  baseUrl = process.env.PI_PLATFORM_API_BASE
} = {}) {
  const id = String(withdrawalRequestId || "").trim();
  if (!UUID_RE.test(id)) throw fail("WITHDRAWAL_ID_INVALID", 400, "withdrawal_request_id must be a valid UUID.");
  const db = database || require("./supabase-client").supabase;

  const requestResult = await db.from("withdrawal_requests")
    .select("id,stake_id,user_id,pi_uid,project_code,network,withdrawal_type,requested_amount,fee_amount,net_amount,wallet_address,status,txid,created_at,updated_at")
    .eq("id", id).eq("network", MAINNET).maybeSingle();
  if (requestResult.error) throw fail("WITHDRAWAL_LOOKUP_FAILED", 502, "Unable to load the Mainnet withdrawal request.");
  if (!requestResult.data) throw fail("WITHDRAWAL_NOT_FOUND", 404, "Mainnet withdrawal request was not found.");
  const request = requestResult.data;

  let attemptSafetySchemaAvailable = true;
  let attemptResult = await db.from("withdrawal_payout_attempts")
    .select("id,withdrawal_request_id,network,status,attempt_count,lease_until,payment_id,txid,last_error,started_at,completed_at,updated_at,lease_token,payment_creation_started_at,submission_started_at")
    .eq("withdrawal_request_id", id).eq("network", MAINNET).maybeSingle();
  if (attemptResult.error) {
    const missingColumn = String(attemptResult.error.code || "") === "42703" ||
      /column .* does not exist|could not find the .* column|schema cache/i.test(String(attemptResult.error.message || ""));
    if (!missingColumn) throw fail("PAYOUT_ATTEMPT_LOOKUP_FAILED", 502, "Unable to load the payout attempt record.");
    // Keep the inspector useful against the audited pre-migration schema while
    // making it explicit that new safety markers are not yet queryable.
    attemptSafetySchemaAvailable = false;
    attemptResult = await db.from("withdrawal_payout_attempts")
      .select("id,withdrawal_request_id,network,status,attempt_count,lease_until,payment_id,txid,last_error,started_at,completed_at,updated_at")
      .eq("withdrawal_request_id", id).eq("network", MAINNET).maybeSingle();
    if (attemptResult.error) throw fail("PAYOUT_ATTEMPT_LOOKUP_FAILED", 502, "Unable to load the payout attempt record using the current schema.");
  }
  const attempt = attemptResult.data || null;

  const listResult = await getPiJson("/payments/incomplete_server_payments", { fetchImpl, apiKey, baseUrl });
  if (!listResult.ok) {
    return {
      withdrawal_request_id: id,
      database_state: { withdrawal_status: request.status, attempt_status: attempt?.status || null, attempt_present: Boolean(attempt), safety_marker_schema_available: attemptSafetySchemaAvailable },
      classification: "PI_INCOMPLETE_LIST_UNAVAILABLE",
      safe_to_mark_paid_automatically: false,
      safe_to_release_manual_payout: false,
      evidence_sha256: null,
      note: "The Pi incomplete-payment list could not be retrieved. This is not evidence that no payment occurred.",
      pi_lookup_code: listResult.code
    };
  }
  const incomplete = getIncompleteArray(listResult.data);
  if (incomplete === null) {
    return {
      withdrawal_request_id: id,
      database_state: { withdrawal_status: request.status, attempt_status: attempt?.status || null, attempt_present: Boolean(attempt), safety_marker_schema_available: attemptSafetySchemaAvailable },
      classification: "PI_INCOMPLETE_LIST_FORMAT_UNRECOGNIZED",
      safe_to_mark_paid_automatically: false,
      safe_to_release_manual_payout: false,
      evidence_sha256: null,
      note: "Pi returned an unexpected incomplete-payment response. No payout action was taken."
    };
  }

  const matchingIncomplete = incomplete.filter((item) => {
    const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
    return String(metadata.withdrawal_request_id || "") === id &&
      String(metadata.source || "") === "albukhr-api" &&
      String(metadata.network || "").toLowerCase() === MAINNET;
  });
  const storedId = String(attempt?.payment_id || "").trim();
  const matchedIds = [...new Set(matchingIncomplete.map((item) => String(item?.identifier || "").trim()).filter(Boolean))];
  if (storedId && matchedIds.some((candidate) => candidate !== storedId)) {
    return {
      withdrawal_request_id: id,
      database_state: { withdrawal_status: request.status, attempt_status: attempt?.status || null, attempt_present: Boolean(attempt), safety_marker_schema_available: attemptSafetySchemaAvailable, payment_id_recorded: true, txid_recorded: Boolean(attempt?.txid || request.txid) },
      classification: "MULTIPLE_OR_ORPHAN_PI_PAYMENTS_MATCH_WITHDRAWAL",
      candidate_payment_ids: [storedId, ...matchedIds].slice(0, 10),
      safe_to_mark_paid_automatically: false,
      safe_to_release_manual_payout: false,
      evidence_sha256: canonicalHash({ withdrawal_request_id: id, storedId, matchedIds }),
      note: "More than one Pi-side payment may match this withdrawal. Stop and review; no external action was taken."
    };
  }
  if (!storedId && matchedIds.length > 1) {
    return {
      withdrawal_request_id: id,
      database_state: { withdrawal_status: request.status, attempt_status: attempt?.status || null, attempt_present: Boolean(attempt), safety_marker_schema_available: attemptSafetySchemaAvailable, payment_id_recorded: false, txid_recorded: Boolean(attempt?.txid || request.txid) },
      classification: "MULTIPLE_OR_ORPHAN_PI_PAYMENTS_MATCH_WITHDRAWAL",
      candidate_payment_ids: matchedIds.slice(0, 10),
      safe_to_mark_paid_automatically: false,
      safe_to_release_manual_payout: false,
      evidence_sha256: canonicalHash({ withdrawal_request_id: id, matchedIds }),
      note: "Multiple Pi-side payments match the withdrawal metadata. No payout action was taken."
    };
  }

  const paymentId = storedId || matchedIds[0] || "";
  if (!paymentId) {
    // Absence from the incomplete list cannot prove no payment happened because
    // a completed Pi payment does not appear in this endpoint's result.
    return {
      withdrawal_request_id: id,
      database_state: { withdrawal_status: request.status, attempt_status: attempt?.status || null, attempt_present: Boolean(attempt), safety_marker_schema_available: attemptSafetySchemaAvailable, payment_id_recorded: false, txid_recorded: Boolean(attempt?.txid || request.txid), creation_intent_recorded: attemptSafetySchemaAvailable ? Boolean(attempt?.payment_creation_started_at) : null, submission_intent_recorded: attemptSafetySchemaAvailable ? Boolean(attempt?.submission_started_at) : null },
      classification: "NO_PAYMENT_FOUND_BUT_OUTCOME_UNRESOLVED",
      safe_to_mark_paid_automatically: false,
      safe_to_release_manual_payout: false,
      evidence_sha256: canonicalHash({ withdrawal_request_id: id, attempt_status: attempt?.status || null, list_size: incomplete.length }),
      note: "No matching payment appeared in Pi's incomplete-payment list. Completed payments are not listed here, so this does not prove that no payment occurred."
    };
  }

  const paymentResult = await getPiJson(`/payments/${encodeURIComponent(paymentId)}`, { fetchImpl, apiKey, baseUrl });
  if (!paymentResult.ok || !paymentResult.data || typeof paymentResult.data !== "object") {
    return {
      withdrawal_request_id: id,
      database_state: { withdrawal_status: request.status, attempt_status: attempt?.status || null, attempt_present: Boolean(attempt), safety_marker_schema_available: attemptSafetySchemaAvailable, payment_id_recorded: Boolean(storedId), txid_recorded: Boolean(attempt?.txid || request.txid) },
      classification: "PI_PAYMENT_LOOKUP_UNAVAILABLE",
      payment_id: paymentId,
      safe_to_mark_paid_automatically: false,
      safe_to_release_manual_payout: false,
      evidence_sha256: canonicalHash({ withdrawal_request_id: id, payment_id: paymentId, pi_status: paymentResult.status, pi_error: paymentResult.code }),
      note: "Pi could not return the authoritative payment record. A missing/error response must not be treated as proof that no payment occurred.",
      pi_lookup_code: paymentResult.code
    };
  }

  const assessed = assessPayment(request, paymentResult.data, paymentId);
  return {
    withdrawal_request_id: id,
    database_state: {
      withdrawal_status: request.status,
      withdrawal_txid_present: Boolean(request.txid),
      attempt_present: Boolean(attempt),
      safety_marker_schema_available: attemptSafetySchemaAvailable,
      attempt_id: attempt?.id || null,
      attempt_status: attempt?.status || null,
      attempt_count: attempt?.attempt_count || null,
      attempt_txid_present: Boolean(attempt?.txid),
      creation_intent_recorded: attemptSafetySchemaAvailable ? Boolean(attempt?.payment_creation_started_at) : null,
      submission_intent_recorded: attemptSafetySchemaAvailable ? Boolean(attempt?.submission_started_at) : null
    },
    payment_id: assessed.evidence.payment_id,
    transaction_id: assessed.evidence.transaction_id,
    classification: assessed.classification,
    safe_to_mark_paid_automatically: false,
    safe_to_release_manual_payout: false,
    evidence: assessed.evidence,
    evidence_sha256: assessed.evidence_sha256,
    note: "Inspection only. This endpoint does not update withdrawal rows, complete Pi payments, or release manual/automatic payout.",
    observed_at: new Date().toISOString()
  };
}

module.exports = { inspectA2UWithdrawal, assessPayment, getPiJson, UUID_RE };
