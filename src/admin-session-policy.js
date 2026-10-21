"use strict";

const ADMIN_ROLES = new Set([
  "super_admin",
  "registry_admin",
  "approval_admin",
  "finance_admin",
  "core_admin",
  "internal_admin",
  "external_admin",
  // Proposed only: this is not yet present in the live Mainnet enum.
  "contributor_admin"
]);

function firstRow(value) {
  return Array.isArray(value) ? (value[0] || null) : value;
}

function normalizeAdminContext(value, authenticatedUserId) {
  const raw = firstRow(value);
  if (!raw || raw.is_admin !== true) return null;
  if (String(raw.status || "").toLowerCase() !== "active") return null;

  const userId = String(raw.user_id || "");
  if (!userId || !authenticatedUserId || userId !== String(authenticatedUserId)) return null;

  const rawRoles = Array.isArray(raw.roles) ? raw.roles : [];
  const roles = rawRoles
    .map((role) => String(role || "").trim().toLowerCase())
    .filter((role) => ADMIN_ROLES.has(role));

  return Object.freeze({
    is_admin: true,
    user_id: userId,
    email_snapshot: typeof raw.email_snapshot === "string" ? raw.email_snapshot : null,
    status: "active",
    mfa_required: raw.mfa_required !== false,
    mfa_verified: raw.mfa_verified === true,
    aal: String(raw.aal || "aal1"),
    roles: Object.freeze([...new Set(roles)]),
    core_projects: Object.freeze(Array.isArray(raw.core_projects) ? raw.core_projects : []),
    scoped_projects: Object.freeze(Array.isArray(raw.scoped_projects) ? raw.scoped_projects : []),
    testnet_access: raw.testnet_access === true
  });
}

function requiresMfa(context) {
  return Boolean(context && context.mfa_required !== false && context.mfa_verified !== true);
}

function publicContext(context) {
  if (!context) return Object.freeze({ authenticated: false });
  if (requiresMfa(context)) {
    // Do not expose administrative roles/scopes before required AAL2 is established.
    return Object.freeze({
      authenticated: true,
      requires_mfa: true,
      status: "active",
      user_id: context.user_id,
      mfa_required: true,
      mfa_verified: false,
      roles: Object.freeze([]),
      core_projects: Object.freeze([]),
      scoped_projects: Object.freeze([]),
      testnet_access: false
    });
  }
  return Object.freeze({
    authenticated: true,
    requires_mfa: false,
    status: context.status,
    user_id: context.user_id,
    email_snapshot: context.email_snapshot,
    mfa_required: context.mfa_required,
    mfa_verified: context.mfa_verified,
    aal: context.aal,
    roles: context.roles,
    core_projects: context.core_projects,
    scoped_projects: context.scoped_projects,
    testnet_access: context.testnet_access
  });
}

function exactHttpsOrigin(candidate, expected) {
  try {
    const got = new URL(String(candidate || ""));
    const want = new URL(String(expected || ""));
    return got.protocol === "https:" && want.protocol === "https:" &&
      got.origin === String(candidate) && want.origin === String(expected) &&
      got.origin === want.origin && !got.username && !got.password;
  } catch (_) {
    return false;
  }
}

function parseCookieHeader(header) {
  const out = Object.create(null);
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const encoded = part.slice(index + 1).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    try { out[name] = decodeURIComponent(encoded); } catch (_) { out[name] = ""; }
  }
  return out;
}

function encodeMfaChallenge(payload) {
  if (!payload || !payload.id || !payload.factorId || !Number.isFinite(payload.issuedAt)) {
    throw new TypeError("Invalid MFA challenge payload.");
  }
  const purpose = payload.purpose === "enroll" ? "enroll" : "verify";
  return Buffer.from(JSON.stringify({
    id: String(payload.id), factorId: String(payload.factorId), issuedAt: payload.issuedAt, purpose
  }), "utf8").toString("base64url");
}

function decodeMfaChallenge(value, now = Date.now()) {
  try {
    const raw = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    if (!raw || typeof raw.id !== "string" || !raw.id ||
        typeof raw.factorId !== "string" || !raw.factorId ||
        !Number.isFinite(raw.issuedAt)) return null;
    const age = now - raw.issuedAt;
    if (age < -5000 || age > 120000) return null;
    const purpose = raw.purpose === "enroll" ? "enroll" : "verify";
    return Object.freeze({ id: raw.id, factorId: raw.factorId, issuedAt: raw.issuedAt, purpose });
  } catch (_) { return null; }
}

function validateTotpCode(value) {
  return /^\d{6}$/.test(String(value || "").trim());
}

function isIsolatedStagingSupabaseUrl(value) {
  try {
    const raw = String(value || "");
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.origin !== raw || url.username || url.password ||
        (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return false;
    const host = url.hostname.toLowerCase();
    if (!host.endsWith(".supabase.co")) return false;
    if (host === "ribpntyqdleytsyktdfb.supabase.co" || host === "vhvkwvngmrlgyzwemttt.supabase.co") return false;
    return /^[a-z0-9][a-z0-9-]*\.supabase\.co$/.test(host);
  } catch (_) { return false; }
}

module.exports = {
  ADMIN_ROLES,
  normalizeAdminContext,
  requiresMfa,
  publicContext,
  exactHttpsOrigin,
  parseCookieHeader,
  encodeMfaChallenge,
  decodeMfaChallenge,
  validateTotpCode,
  isIsolatedStagingSupabaseUrl
};
