"use strict";

const crypto = require("crypto");

const POLICY_DOCUMENT_ID = "ALB-FIN-GOV-SPEC-001";
const POLICY_REVISION = "1.0";
const POLICY_HASH = "10628e807af23ebe6a08ed56608ed32865c03f037c6ab3244fb033fbc4b51d7a";

function sessionFingerprint(token) {
  const value = String(token || "").trim();
  if (!value) throw new Error("Pi authentication token is required.");
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/i.test(String(value || ""));
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function isValidIdempotencyKey(value) {
  const text = String(value || "");
  return text.length >= 8 && text.length <= 128;
}

function paymentAcceptanceMatches(payment, acceptanceId, acceptance) {
  const metadata = payment?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return (
    String(metadata.acceptance_id || "").toLowerCase() === String(acceptanceId || "").toLowerCase() &&
    String(metadata.policy_revision || "") === String(acceptance?.policy_revision || "") &&
    String(metadata.policy_hash || "") === String(acceptance?.policy_hash || "") &&
    String(metadata.term_hash || "") === String(acceptance?.term_hash || "")
  );
}

module.exports = {
  POLICY_DOCUMENT_ID,
  POLICY_REVISION,
  POLICY_HASH,
  sessionFingerprint,
  isSha256,
  isUuid,
  isValidIdempotencyKey,
  paymentAcceptanceMatches,
};
