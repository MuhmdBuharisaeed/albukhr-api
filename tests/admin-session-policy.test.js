"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeAdminContext, requiresMfa, publicContext, exactHttpsOrigin,
  parseCookieHeader, encodeMfaChallenge, decodeMfaChallenge, validateTotpCode,
  isIsolatedStagingSupabaseUrl
} = require("../src/admin-session-policy");

const base = Object.freeze({
  is_admin: true, user_id: "auth-user-1", status: "active", mfa_required: true,
  mfa_verified: true, aal: "aal2", roles: ["finance_admin", "super_admin"],
  core_projects: [], scoped_projects: [], testnet_access: false
});

test("normalizes a server context and preserves established admin roles", () => {
  const value = normalizeAdminContext([base], "auth-user-1");
  assert.equal(value.is_admin, true);
  assert.deepEqual(value.roles, ["finance_admin", "super_admin"]);
});

test("rejects non-admin contexts", () => assert.equal(normalizeAdminContext({ ...base, is_admin: false }, "auth-user-1"), null));
test("rejects inactive admin accounts", () => assert.equal(normalizeAdminContext({ ...base, status: "suspended" }, "auth-user-1"), null));
test("rejects a context tied to a different Supabase Auth UID", () => assert.equal(normalizeAdminContext({ ...base, user_id: "another-user" }, "auth-user-1"), null));
test("does not expose roles/scopes before required MFA", () => {
  const ctx = normalizeAdminContext({ ...base, mfa_verified: false, aal: "aal1" }, "auth-user-1");
  const safe = publicContext(ctx);
  assert.equal(safe.requires_mfa, true);
  assert.deepEqual(safe.roles, []);
  assert.equal(safe.testnet_access, false);
});
test("exposes authorized context after AAL2", () => {
  const safe = publicContext(normalizeAdminContext(base, "auth-user-1"));
  assert.equal(safe.requires_mfa, false);
  assert.deepEqual(safe.roles, ["finance_admin", "super_admin"]);
});
test("respects an explicit policy that MFA is not required", () => {
  const ctx = normalizeAdminContext({ ...base, mfa_required: false, mfa_verified: false }, "auth-user-1");
  assert.equal(requiresMfa(ctx), false);
});
test("requires exact HTTPS origin match", () => {
  assert.equal(exactHttpsOrigin("https://admin-staging.albukhr.com", "https://admin-staging.albukhr.com"), true);
  assert.equal(exactHttpsOrigin("http://admin-staging.albukhr.com", "http://admin-staging.albukhr.com"), false);
});
test("rejects origin mismatch and URL path in configured origin", () => {
  assert.equal(exactHttpsOrigin("https://evil.albukhr.com", "https://admin-staging.albukhr.com"), false);
  assert.equal(exactHttpsOrigin("https://admin-staging.albukhr.com/path", "https://admin-staging.albukhr.com/path"), false);
});
test("parses cookies without overwriting duplicate names", () => {
  const parsed = parseCookieHeader("a=first; token=abc%2F123; token=second");
  assert.equal(parsed.a, "first");
  assert.equal(parsed.token, "abc/123");
});
test("MFA challenge is short-lived and bound to one factor", () => {
  const now = 1_800_000_000_000;
  const encoded = encodeMfaChallenge({ id: "challenge-1", factorId: "factor-1", purpose: "enroll", issuedAt: now });
  assert.equal(decodeMfaChallenge(encoded, now + 60_000).factorId, "factor-1");
  assert.equal(decodeMfaChallenge(encoded, now + 60_000).purpose, "enroll");
  assert.equal(decodeMfaChallenge(encoded, now + 121_000), null);
  assert.equal(decodeMfaChallenge(encoded, now - 10_000), null);
});
test("accepts only exactly six numeric TOTP digits", () => {
  assert.equal(validateTotpCode("012345"), true);
  assert.equal(validateTotpCode("12345"), false);
  assert.equal(validateTotpCode("12a456"), false);
});

test("allows a dedicated third Supabase staging project", () => {
  assert.equal(isIsolatedStagingSupabaseUrl("https://albukhr-stage-auth-001.supabase.co"), true);
});
test("rejects ALBUKHR Mainnet and Testnet Supabase projects for the staging gateway", () => {
  assert.equal(isIsolatedStagingSupabaseUrl("https://ribpntyqdleytsyktdfb.supabase.co"), false);
  assert.equal(isIsolatedStagingSupabaseUrl("https://vhvkwvngmrlgyzwemttt.supabase.co"), false);
});
