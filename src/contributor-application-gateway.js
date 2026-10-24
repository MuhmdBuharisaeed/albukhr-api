/* ALBUKHR API — Contributor Form One gateway. Mainnet only. */
"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const { getPioneer } = require("./pi-client");
const { supabase } = require("./supabase-client");

const router = express.Router();
const MAINNET = "mainnet";
const PRIVACY_VERSION = "contributor_application_privacy_v1";
const ALLOWED_AREAS = new Set([
  "technology", "security", "business", "research", "design",
  "finance", "operations", "community", "agriculture", "legal"
]);

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, network: MAINNET, error: "Too many application attempts. Please try again later." }
});
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, network: MAINNET, error: "Too many status requests. Please try again shortly." }
});

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
function requestBody(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}
function requiredText(value, field, min, max) {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) throw httpError(400, `${field} must be ${min}–${max} characters.`);
  return text;
}
function normalizeAreas(value) {
  if (!Array.isArray(value)) throw httpError(400, "Select between 1 and 5 contribution areas.");
  const areas = [...new Set(value.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean))];
  if (areas.length < 1 || areas.length > 5 || areas.some((item) => !ALLOWED_AREAS.has(item))) {
    throw httpError(400, "Choose between 1 and 5 valid contribution areas.");
  }
  return areas;
}
function requireBearer(req) {
  const authorization = String(req.headers.authorization || "").trim();
  if (!authorization.toLowerCase().startsWith("bearer ")) throw httpError(401, "Pi authentication is required.");
  const token = authorization.slice(7).trim();
  if (!token || token.length > 4096) throw httpError(401, "Pi authentication token is invalid.");
  return token;
}
async function verifyPiIdentity(req) {
  let pioneer;
  try {
    pioneer = await getPioneer(requireBearer(req));
  } catch (error) {
    console.warn("[CONTRIBUTOR APPLICATION] Pi token verification failed.", { status: error?.status });
    throw httpError(401, "Pi Mainnet identity could not be verified.");
  }
  const piUid = String(pioneer?.uid || "").trim();
  if (!piUid || piUid.length > 200) throw httpError(401, "Verified Pi identity is unavailable.");
  return { pi_uid: piUid };
}
async function callRpc(name, params) {
  const result = await supabase.schema("albukhr_security").rpc(name, params);
  if (result?.error) {
    const error = new Error(result.error.message || `Database function ${name} failed.`);
    error.code = result.error.code;
    error.details = result.error.details;
    throw error;
  }
  return result?.data;
}
function sendError(res, error, genericMessage) {
  const status = Number(error?.status);
  if (status >= 400 && status < 500) return res.status(status).json({ success: false, network: MAINNET, error: error.message });
  if (error?.code === "23505") {
    return res.status(409).json({ success: false, network: MAINNET, error: "An active Contributor application already exists for this Pi identity." });
  }
  console.error("[CONTRIBUTOR APPLICATION] Gateway failed.", { code: error?.code, message: error?.message });
  return res.status(502).json({ success: false, network: MAINNET, error: genericMessage });
}

// Guard the existing onboarding endpoints before the legacy gateway handles them.
// This intentionally leaves their established handlers and response shapes untouched.
router.use(async (req, res, next) => {
  const protectedPaths = new Set([
    "/api/contributor/bootstrap",
    "/api/contributor/consent",
    "/api/contributor/accept"
  ]);
  if (req.method !== "POST" || !protectedPaths.has(req.path)) return next();
  try {
    const identity = await verifyPiIdentity(req);
    const input = requestBody(req);
    const token = String(input.invitation_token ?? input.p_invitation_token ?? "").trim();
    if (!token || token.length > 1024) throw httpError(400, "A valid Contributor invitation token is required.");
    const data = await callRpc("gateway_assert_contributor_invitation_identity", {
      p_pi_uid: identity.pi_uid,
      p_invitation_token: token
    });
    if (data?.success !== true) {
      return res.status(403).json({
        success: false,
        network: MAINNET,
        error: data?.message || "Contributor invitation identity binding failed."
      });
    }
    return next();
  } catch (error) {
    return sendError(res, error, "Contributor invitation identity could not be verified.");
  }
});

router.post("/api/contributor/applications", submitLimiter, async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const input = requestBody(req);
    const fullName = requiredText(input.full_name, "Full name", 2, 120);
    const email = requiredText(input.contact_email, "Contact email", 5, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "Enter a valid contact email address.");
    const country = requiredText(input.country, "Country", 2, 100);
    const occupation = requiredText(input.occupation, "Occupation", 2, 120);
    const primaryExpertise = requiredText(input.primary_expertise, "Primary expertise", 2, 120);
    const experience = requiredText(input.experience_summary, "Relevant experience", 50, 2000);
    const statement = requiredText(input.contribution_statement, "Contribution statement", 50, 2000);
    const areas = normalizeAreas(input.contribution_areas);
    const privacyVersion = String(input.privacy_version || "").trim();
    if (privacyVersion !== PRIVACY_VERSION || input.privacy_consent !== true) {
      throw httpError(400, "The current application privacy notice must be accepted.");
    }

    const data = await callRpc("gateway_submit_contributor_application", {
      p_pi_uid: identity.pi_uid,
      p_full_name: fullName,
      p_contact_email: email,
      p_country: country,
      p_occupation: occupation,
      p_primary_expertise: primaryExpertise,
      p_experience_summary: experience,
      p_contribution_areas: areas,
      p_contribution_statement: statement,
      p_privacy_version: privacyVersion,
      p_privacy_consent: true
    });
    if (data?.success !== true || !data?.application) {
      const message = String(data?.message || "Contributor application could not be submitted.");
      return res.status(data?.code === "duplicate_application" ? 409 : 400).json({ success: false, network: MAINNET, error: message });
    }
    return res.status(201).json({ success: true, network: MAINNET, data });
  } catch (error) {
    return sendError(res, error, "Contributor application service is temporarily unavailable.");
  }
});

router.get("/api/contributor/application/status", statusLimiter, async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const data = await callRpc("gateway_get_my_contributor_application", { p_pi_uid: identity.pi_uid });
    if (data?.success !== true) {
      return res.status(400).json({ success: false, network: MAINNET, error: data?.message || "Application status could not be loaded." });
    }
    return res.status(200).json({ success: true, network: MAINNET, data });
  } catch (error) {
    return sendError(res, error, "Contributor application status service is temporarily unavailable.");
  }
});

module.exports = { contributorApplicationGatewayRouter: router };
