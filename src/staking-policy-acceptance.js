"use strict";

const express = require("express");
const { resolvePublishedTerm } = require("./published-term-projection");
const {
  POLICY_DOCUMENT_ID, POLICY_REVISION, POLICY_HASH, sessionFingerprint,
  isSha256, isUuid, isValidIdempotencyKey, paymentAcceptanceMatches,
} = require("./staking-policy-acceptance-core");

const MAINNET = "mainnet";

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function clean(value, field, max = 200) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw httpError(400, `${field} is invalid.`, "INVALID_INPUT");
  return text;
}

function uuidValue(value, field) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw httpError(400, `${field} is invalid.`, "INVALID_UUID");
  }
  return text;
}

function requireBearer(req) {
  const header = String(req.headers.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) {
    throw httpError(401, "Pi authentication token is required.", "PI_TOKEN_REQUIRED");
  }
  const token = header.slice(7).trim();
  if (!token) throw httpError(401, "Pi authentication token is required.", "PI_TOKEN_REQUIRED");
  return token;
}

async function verifiedIdentity(req, getPioneer) {
  const token = requireBearer(req);
  let pioneer;
  try {
    pioneer = await getPioneer(token);
  } catch {
    throw httpError(401, "Pi identity could not be verified.", "PI_IDENTITY_UNVERIFIED");
  }
  const piUid = String(pioneer?.uid || "").trim();
  if (!piUid) throw httpError(401, "Pi identity could not be verified.", "PI_IDENTITY_UNVERIFIED");
  return { pi_uid: piUid, session_fingerprint: sessionFingerprint(token) };
}

async function getExactPublishedTerm(supabase, project, termVersionId) {
  const type = String(project.project_type || "").toLowerCase();
  let rpcName;
  if (type === "core") rpcName = "get_public_core_staking_terms_v2";
  else if (type === "internal") rpcName = "get_public_internal_staking_terms_v2";
  else throw httpError(409, "Staking policy acceptance is not enabled for this project type yet.", "PROJECT_TYPE_NOT_ENABLED");

  const { data, error } = await supabase.rpc(rpcName, {
    p_project_id: project.id,
    p_network: MAINNET,
  });
  if (error) throw httpError(502, "Published staking offer could not be verified.", "PUBLISHED_TERM_LOOKUP_FAILED");

  if (!data || data.success !== true || String(data.network || "").toLowerCase() !== MAINNET ||
      String(data.project_id || "") !== String(project.id) ||
      String(data.project_code || "").toLowerCase() !== String(project.project_code || "").toLowerCase() ||
      String(data.project_type || "").toLowerCase() !== type) {
    throw httpError(403, "Published staking offer identity does not match this Mainnet project.", "PROJECT_TERM_SCOPE_MISMATCH");
  }

  const candidate = (Array.isArray(data.terms) ? data.terms : []).find((row) =>
    row && String(row.term_version_id || "").toLowerCase() === String(termVersionId).toLowerCase()
  );
  if (!candidate) {
    throw httpError(409, "The exact staking term is not published and effective.", "TERM_NOT_PUBLISHED");
  }

  const resolved = resolvePublishedTerm(data, {
    project,
    durationDays: Number(candidate.duration_days),
    termVersionId,
    expectedProjectType: type,
  });
  if (!resolved) throw httpError(409, "The exact staking term is not currently effective.", "TERM_NOT_EFFECTIVE");

  const disclosureVersion = String(candidate.disclosure_version || "").trim();
  const consentVersion = String(candidate.consent_version || "").trim();
  if (!disclosureVersion || !consentVersion) {
    throw httpError(409, "This offer is not ready for investor acceptance because its disclosure or consent version is missing.", "TERM_DISCLOSURE_NOT_READY");
  }

  return { ...candidate, term_version_id: resolved.id, disclosure_version: disclosureVersion, consent_version: consentVersion };
}

function createStakingPolicyAcceptanceRouter({ supabase, getPioneer }) {
  const router = express.Router();

  router.post("/api/staking-policy-acceptance", async (req, res) => {
    try {
      const identity = await verifiedIdentity(req, getPioneer);
      const input = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      if (input.accepted !== true) {
        throw httpError(400, "Explicit acceptance is required before continuing.", "EXPLICIT_ACCEPTANCE_REQUIRED");
      }
      const projectCode = clean(input.project_code, "project_code", 100);
      const termVersionId = uuidValue(input.term_version_id, "term_version_id");
      const idempotencyKey = clean(input.idempotency_key, "idempotency_key", 128);
      if (!isValidIdempotencyKey(idempotencyKey)) throw httpError(400, "idempotency_key is invalid.", "INVALID_IDEMPOTENCY_KEY");

      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id,project_code,project_type,status,network,registration_source")
        .eq("project_code", projectCode)
        .eq("network", MAINNET)
        .maybeSingle();
      if (projectError) throw httpError(502, "Mainnet project lookup failed.", "PROJECT_LOOKUP_FAILED");
      if (!project) throw httpError(404, "Mainnet project was not found.", "PROJECT_NOT_FOUND");
      if (String(project.status || "").toLowerCase() !== "active") {
        throw httpError(409, "Only ACTIVE projects can accept a new investment contract acceptance.", "PROJECT_NOT_ACTIVE");
      }
      if (String(project.project_type || "").toLowerCase() === "internal" &&
          String(project.registration_source || "").toLowerCase() !== "contributor_internal") {
        throw httpError(403, "Internal project provenance does not match the authorized investment pathway.", "PROJECT_PROVENANCE_MISMATCH");
      }

      const term = await getExactPublishedTerm(supabase, project, termVersionId);
      const { data, error } = await supabase
        .schema("albukhr_security")
        .rpc("record_staking_policy_acceptance_v2", {
          p_project_id: project.id,
          p_term_version_id: termVersionId,
          p_verified_pi_uid: identity.pi_uid,
          p_session_fingerprint: identity.session_fingerprint,
          p_policy_revision: POLICY_REVISION,
          p_policy_hash: POLICY_HASH,
          p_disclosure_version: term.disclosure_version,
          p_consent_version: term.consent_version,
          p_idempotency_key: idempotencyKey,
        });
      if (error) {
        const code = String(error.code || "");
        if (code === "23505") throw httpError(409, "This acceptance request conflicts with an earlier attempt. Refresh the offer and try again.", "ACCEPTANCE_IDEMPOTENCY_CONFLICT");
        if (code === "42501" || code === "55000") throw httpError(409, "The exact policy or staking offer is not eligible for acceptance.", "ACCEPTANCE_NOT_ELIGIBLE");
        console.error("[ALBUKHR API] Staking policy acceptance failed", { code, message: error.message });
        throw httpError(502, "Staking policy acceptance could not be recorded.", "ACCEPTANCE_WRITE_FAILED");
      }

      return res.status(data?.replayed ? 200 : 201).json({
        success: true,
        data: {
          ...data,
          project_id: project.id,
          project_code: project.project_code,
          project_type: String(project.project_type || "").toLowerCase(),
          network: MAINNET,
          term_version_id: termVersionId,
          duration_days: Number(term.duration_days),
          disclosure_version: term.disclosure_version,
          consent_version: term.consent_version,
        },
      });
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error("[ALBUKHR API] Staking policy acceptance error", { code: error?.code, message: error?.message });
      return res.status(status).json({
        success: false,
        code: error?.code || "STAKING_POLICY_ACCEPTANCE_FAILED",
        error: status >= 500 ? "Staking policy acceptance failed." : error.message,
      });
    }
  });

  return router;
}

async function validateStakingPolicyAcceptance({
  supabase,
  acceptanceId,
  projectId,
  termVersionId,
  piUid,
  sessionFingerprint: fingerprint,
}) {
  const id = uuidValue(acceptanceId, "acceptance_id");
  const { data, error } = await supabase
    .schema("albukhr_security")
    .rpc("validate_staking_policy_acceptance_v2", {
      p_acceptance_id: id,
      p_project_id: projectId,
      p_term_version_id: termVersionId,
      p_verified_pi_uid: piUid,
      p_session_fingerprint: fingerprint,
      p_policy_revision: POLICY_REVISION,
      p_policy_hash: POLICY_HASH,
    });
  if (error) throw httpError(502, "Policy acceptance verification is unavailable.", "ACCEPTANCE_VALIDATION_FAILED");
  if (!data || data.valid !== true) {
    throw httpError(403, "A matching, current-session acceptance of this exact staking offer is required.", data?.reason_code || "ACCEPTANCE_REQUIRED");
  }
  return data;
}

function assertPaymentAcceptanceMetadata(payment, acceptanceId, acceptance) {
  if (!payment?.metadata || typeof payment.metadata !== "object" || Array.isArray(payment.metadata)) {
    throw httpError(403, "Pi payment is missing its staking policy acceptance binding.", "PAYMENT_ACCEPTANCE_METADATA_MISSING");
  }
  if (!paymentAcceptanceMatches(payment, acceptanceId, acceptance)) {
    throw httpError(403, "Pi payment does not match the exact accepted policy and staking term.", "PAYMENT_ACCEPTANCE_MISMATCH");
  }
}

module.exports = {
  POLICY_DOCUMENT_ID,
  POLICY_REVISION,
  POLICY_HASH,
  sessionFingerprint,
  createStakingPolicyAcceptanceRouter,
  validateStakingPolicyAcceptance,
  assertPaymentAcceptanceMetadata,
};
