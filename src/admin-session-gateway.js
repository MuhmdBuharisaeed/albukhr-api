/*
 * ALBUKHR Admin Session Gateway — staging-only vertical slice.
 *
 * This module is deliberately inert until all three server environment values
 * are configured and the request arrives on the declared HTTPS *.albukhr.com
 * custom API host. It must not be enabled on the current *.onrender.com URL:
 * browsers may treat those cookies as third-party cookies.
 *
 * Uses a publishable/anon key for user Auth, never the service-role key.
 * The existing service-role client remains unchanged for existing gateways.
 */
"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const {
  normalizeAdminContext,
  requiresMfa,
  publicContext,
  exactHttpsOrigin,
  parseCookieHeader,
  encodeMfaChallenge,
  decodeMfaChallenge,
  validateTotpCode,
  isIsolatedStagingSupabaseUrl
} = require("./admin-session-policy");

const router = express.Router();
const COOKIE_ACCESS = "__Secure-albukhr_admin_access";
const COOKIE_REFRESH = "__Secure-albukhr_admin_refresh";
const COOKIE_CHALLENGE = "__Secure-albukhr_admin_mfa_challenge";
const COOKIE_PATH = "/api/admin/session";
const DEFAULT_REFRESH_COOKIE_AGE = 7 * 24 * 60 * 60;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function config() {
  const mode = String(process.env.ALBUKHR_ADMIN_SESSION_MODE || "").trim().toLowerCase();
  const stagingSupabaseUrl = String(process.env.ALBUKHR_ADMIN_SESSION_SUPABASE_URL || "").trim();
  const adminOrigin = String(process.env.ALBUKHR_ADMIN_SESSION_ORIGIN || "").trim();
  const apiHost = String(process.env.ALBUKHR_ADMIN_SESSION_API_HOST || "").trim().toLowerCase();
  const publishableKey = String(
    process.env.ALBUKHR_ADMIN_SESSION_PUBLISHABLE_KEY || ""
  ).trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (mode !== "staging" || !isIsolatedStagingSupabaseUrl(stagingSupabaseUrl) ||
      !adminOrigin || !apiHost || !publishableKey) return null;
  if (!exactHttpsOrigin(adminOrigin, adminOrigin)) return null;
  if (!apiHost.endsWith(".albukhr.com") || apiHost === "albukhr.com") return null;
  if (new URL(adminOrigin).hostname.toLowerCase() === apiHost) return null;
  if (publishableKey === serviceKey || /^sb_secret_/i.test(publishableKey)) return null;

  // Reject a legacy JWT-form service_role key if one is accidentally placed here.
  try {
    const p = publishableKey.split(".")[1];
    if (p) {
      const data = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
      if (String(data.role || "").toLowerCase() === "service_role") return null;
    }
  } catch (_) { /* sb_publishable_* keys are not JWTs; that is expected. */ }

  return Object.freeze({ adminOrigin, apiHost, publishableKey, supabaseUrl: stagingSupabaseUrl });
}

function requestHost(req) {
  return String(req.get("host") || "").trim().toLowerCase().split(":")[0];
}

function cookies(req) {
  return parseCookieHeader(req.headers.cookie || "");
}

function setCookie(res, name, value, maxAge) {
  const attributes = [
    `${name}=${encodeURIComponent(String(value || ""))}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(Number(maxAge) || 0))}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ];
  res.append("Set-Cookie", attributes.join("; "));
}

function clearCookies(res) {
  setCookie(res, COOKIE_ACCESS, "", 0);
  setCookie(res, COOKIE_REFRESH, "", 0);
  setCookie(res, COOKIE_CHALLENGE, "", 0);
}

function setSessionCookies(res, session) {
  if (!session?.access_token || !session?.refresh_token) {
    throw httpError(502, "Supabase did not return a complete session.");
  }
  // Keep the access-token cookie after JWT expiry so setSession() can use
  // the refresh token to obtain a replacement. Supabase, not cookie Max-Age,
  // remains authoritative for token validity; the cookie lifetime is a
  // sliding inactivity window shared with the refresh-token cookie.
  const configuredRefreshAge = Number(process.env.ALBUKHR_ADMIN_SESSION_MAX_AGE_SECONDS);
  const refreshAge = Number.isInteger(configuredRefreshAge) &&
    configuredRefreshAge >= 300 && configuredRefreshAge <= 2592000
    ? configuredRefreshAge
    : DEFAULT_REFRESH_COOKIE_AGE;
  setCookie(res, COOKIE_ACCESS, session.access_token, refreshAge);
  setCookie(res, COOKIE_REFRESH, session.refresh_token, refreshAge);
}

function setChallengeCookie(res, payload) {
  setCookie(res, COOKIE_CHALLENGE, encodeMfaChallenge(payload), 120);
}

function createUserClient() {
  const cfg = config();
  if (!cfg) throw httpError(503, "Admin Session Gateway is not configured for a trusted custom domain.");
  return createClient(cfg.supabaseUrl, cfg.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function firstRow(value) {
  return Array.isArray(value) ? (value[0] || null) : value;
}

async function fetchContext(client, session) {
  const result = await client.schema("albukhr_security").rpc("get_my_admin_context");
  if (result?.error) {
    const error = httpError(502, "Admin security context could not be verified.");
    error.code = result.error.code;
    throw error;
  }
  const ctx = normalizeAdminContext(result?.data, session?.user?.id);
  if (!ctx) throw httpError(403, "Active ALBUKHR administrator authorization is required.");
  return ctx;
}

async function sessionFromCookies(req, res) {
  const jar = cookies(req);
  const access = jar[COOKIE_ACCESS];
  const refresh = jar[COOKIE_REFRESH];
  if (!access || !refresh) {
    clearCookies(res);
    throw httpError(401, "Admin session is required.");
  }
  const client = createUserClient();
  const result = await client.auth.setSession({ access_token: access, refresh_token: refresh });
  if (result?.error || !result?.data?.session?.user?.id) {
    clearCookies(res);
    throw httpError(401, "Admin session has expired. Sign in again.");
  }
  const current = await client.auth.getSession();
  const session = current?.data?.session || result.data.session;
  return { client, session };
}

function noStore(req, res, next) {
  res.set("Cache-Control", "no-store, private, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Vary", "Origin, Cookie");
  next();
}

function guardRequest(req, res, next) {
  const cfg = config();
  if (!cfg) {
    return res.status(503).json({
      success: false,
      network: "mainnet",
      error: "Admin Session Gateway is disabled until isolated staging Supabase, custom API domain, staging origin and publishable key are configured."
    });
  }
  if (requestHost(req) !== cfg.apiHost) {
    return res.status(404).json({ success: false, network: "mainnet", error: "Admin Session Gateway host mismatch." });
  }
  if (!exactHttpsOrigin(req.get("origin"), cfg.adminOrigin)) {
    return res.status(403).json({ success: false, network: "mainnet", error: "Admin Session Gateway origin denied." });
  }
  if (req.method !== "GET" && !String(req.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return res.status(415).json({ success: false, network: "mainnet", error: "application/json is required." });
  }
  return next();
}

function wrap(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch((error) => {
      const status = Number(error?.status) || 500;
      if (status >= 500) {
        // Never log credentials, cookies, request bodies or MFA codes.
        console.error("[ALBUKHR ADMIN SESSION]", { status, code: error?.code, message: error?.message });
      }
      if (!res.headersSent) {
        res.status(status).json({
          success: false,
          network: "mainnet",
          error: status >= 500 ? "Admin Session Gateway is temporarily unavailable." : String(error.message || "Admin session request denied.")
        });
      } else next(error);
    });
  };
}

async function requireActiveAdmin(req, res) {
  const { client, session } = await sessionFromCookies(req, res);
  let context;
  try {
    context = await fetchContext(client, session);
  } catch (error) {
    // Do not refresh/re-issue cookies after role revocation, suspension or an invalid security context.
    if (Number(error?.status) === 403) clearCookies(res);
    throw error;
  }
  setSessionCookies(res, session);
  return { client, session, context };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, network: "mainnet", error: "Too many sign-in attempts. Try again later." }
});
const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, network: "mainnet", error: "Too many MFA requests. Try again later." }
});

router.use(noStore, guardRequest);

router.post("/login", loginLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, "Email or password is invalid.");
  }
  if (password.length < 12 || password.length > 1024) throw httpError(400, "Email or password is invalid.");

  const client = createUserClient();
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn?.error || !signedIn?.data?.session?.user?.id) {
    throw httpError(401, "Invalid credentials or administrator authorization.");
  }
  const session = signedIn.data.session;
  let context;
  try {
    context = await fetchContext(client, session);
  } catch (error) {
    await client.auth.signOut({ scope: "local" }).catch(() => null);
    throw error;
  }
  setSessionCookies(res, session);
  return res.status(200).json({
    success: true,
    network: "mainnet",
    context: publicContext(context),
    requires_mfa: requiresMfa(context)
  });
}));

router.get("/context", wrap(async (req, res) => {
  const { session, context } = await requireActiveAdmin(req, res);
  return res.status(200).json({ success: true, network: "mainnet", context: publicContext(context), requires_mfa: requiresMfa(context), expires_at: session.expires_at || null });
}));

router.post("/refresh", wrap(async (req, res) => {
  const { session, context } = await requireActiveAdmin(req, res);
  return res.status(200).json({ success: true, network: "mainnet", context: publicContext(context), requires_mfa: requiresMfa(context), expires_at: session.expires_at || null });
}));

router.post("/logout", wrap(async (req, res) => {
  try {
    const jar = cookies(req);
    if (jar[COOKIE_ACCESS] && jar[COOKIE_REFRESH]) {
      const client = createUserClient();
      const result = await client.auth.setSession({ access_token: jar[COOKIE_ACCESS], refresh_token: jar[COOKIE_REFRESH] });
      if (!result?.error) await client.auth.signOut({ scope: "local" });
    }
  } finally {
    clearCookies(res);
  }
  return res.status(200).json({ success: true, network: "mainnet", signed_out: true });
}));

router.get("/mfa/factors", mfaLimiter, wrap(async (req, res) => {
  const { client, context } = await requireActiveAdmin(req, res);
  const result = await client.auth.mfa.listFactors();
  if (result?.error) throw httpError(502, "MFA factors could not be loaded.");
  const factors = Array.isArray(result?.data?.totp) ? result.data.totp : [];
  return res.status(200).json({
    success: true,
    network: "mainnet",
    requires_mfa: requiresMfa(context),
    factors: factors.map((factor) => ({ id: String(factor.id), friendly_name: String(factor.friendly_name || "ALBUKHR Admin Authenticator"), status: String(factor.status || "unknown"), factor_type: "totp" }))
  });
}));

router.post("/mfa/enroll", mfaLimiter, wrap(async (req, res) => {
  const { client, context } = await requireActiveAdmin(req, res);
  const listed = await client.auth.mfa.listFactors();
  if (listed?.error) throw httpError(502, "MFA factors could not be checked.");
  const factors = Array.isArray(listed?.data?.totp) ? listed.data.totp : [];
  const verified = factors.some((factor) => factor?.status === "verified");
  if (verified && requiresMfa(context)) throw httpError(409, "An authenticator is already enrolled. Verify that factor instead of enrolling another one.");
  const result = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "ALBUKHR Admin Authenticator" });
  if (result?.error || !result?.data?.id) throw httpError(502, "MFA enrollment could not be started.");
  // The setup secret is returned only to this authenticated TLS response; it is never logged or stored by this API.
  return res.status(200).json({ success: true, network: "mainnet", factor: { id: result.data.id, qr_code: result.data.totp?.qr_code || null, secret: result.data.totp?.secret || null, uri: result.data.totp?.uri || null } });
}));

router.post("/mfa/challenge", mfaLimiter, wrap(async (req, res) => {
  const { client } = await requireActiveAdmin(req, res);
  const factorId = String(req.body?.factor_id || "").trim();
  const purpose = String(req.body?.purpose || "verify").trim().toLowerCase();
  if (!factorId || factorId.length > 200) throw httpError(400, "factor_id is invalid.");
  if (!["verify", "enroll"].includes(purpose)) throw httpError(400, "MFA challenge purpose is invalid.");
  const listed = await client.auth.mfa.listFactors();
  if (listed?.error) throw httpError(502, "MFA factors could not be checked.");
  const factors = Array.isArray(listed?.data?.totp) ? listed.data.totp : [];
  const expectedStatus = purpose === "enroll" ? "unverified" : "verified";
  if (!factors.some((factor) => factor?.id === factorId && factor?.status === expectedStatus)) {
    throw httpError(403, purpose === "enroll" ? "An unverified factor from this account is required to complete enrollment." : "A verified authenticator for this account is required.");
  }
  const result = await client.auth.mfa.challenge({ factorId });
  if (result?.error || !result?.data?.id) throw httpError(502, "MFA challenge could not be created.");
  setChallengeCookie(res, { id: result.data.id, factorId, purpose, issuedAt: Date.now() });
  return res.status(200).json({ success: true, network: "mainnet", challenge_required: true, purpose, expires_in: 120 });
}));

router.post("/mfa/verify", mfaLimiter, wrap(async (req, res) => {
  const { client, session: initialSession } = await requireActiveAdmin(req, res);
  const factorId = String(req.body?.factor_id || "").trim();
  const code = String(req.body?.code || "").trim();
  const challenge = decodeMfaChallenge(cookies(req)[COOKIE_CHALLENGE]);
  // Always clear the one-time challenge cookie, including on invalid-code paths.
  clearChallengeCookie(res);
  if (!challenge || challenge.factorId !== factorId) throw httpError(401, "MFA challenge expired. Request a new challenge.");
  if (!validateTotpCode(code)) throw httpError(400, "Enter the current 6-digit authenticator code.");
  const listed = await client.auth.mfa.listFactors();
  if (listed?.error) throw httpError(502, "MFA factors could not be checked.");
  const factors = Array.isArray(listed?.data?.totp) ? listed.data.totp : [];
  const expectedStatus = challenge.purpose === "enroll" ? "unverified" : "verified";
  if (!factors.some((factor) => factor?.id === factorId && factor?.status === expectedStatus)) {
    throw httpError(403, "The authenticator factor is no longer eligible for this challenge.");
  }
  const verified = await client.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
  if (verified?.error) throw httpError(401, "Authenticator code could not be verified.");
  const current = await client.auth.getSession();
  const session = current?.data?.session || initialSession;
  if (!session?.user?.id || session.user.id !== initialSession.user.id) throw httpError(401, "Admin session could not be verified after MFA.");
  const context = await fetchContext(client, session);
  if (requiresMfa(context)) throw httpError(403, "Supabase AAL2 assurance is not established after verification.");
  setSessionCookies(res, session);
  return res.status(200).json({ success: true, network: "mainnet", context: publicContext(context), requires_mfa: false });
}));

function clearChallengeCookie(res) {
  setCookie(res, COOKIE_CHALLENGE, "", 0);
}

module.exports = { adminSessionGatewayRouter: router };
