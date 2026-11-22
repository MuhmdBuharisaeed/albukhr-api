"use strict";

const MAINNET = "mainnet";
const ELIGIBLE_PROJECT_STATUSES = Object.freeze(["approved", "active"]);

function gatewayError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requireAdminToken(token) {
  const value = String(token || "").trim();
  if (!value) {
    throw gatewayError(401, "A valid Supabase Admin access token is required.", "AUTH_TOKEN_REQUIRED");
  }
  return value;
}

/**
 * Verify the Supabase JWT with Auth, require a server-verified AAL2 session,
 * then resolve an active ALBUKHR admin account. The browser cannot supply
 * the principal ID or MFA state.
 */
async function resolveSupabaseAdminPrincipal(db, accessToken) {
  if (!db || !db.auth || typeof db.auth.getUser !== "function") {
    throw gatewayError(503, "Admin identity verification is unavailable.", "AUTH_VERIFICATION_UNAVAILABLE");
  }

  const token = requireAdminToken(accessToken);
  let verified;

  try {
    verified = await db.auth.getUser(token);
  } catch (_) {
    throw gatewayError(503, "Admin identity verification is temporarily unavailable.", "AUTH_VERIFICATION_UNAVAILABLE");
  }

  const authUser = verified && verified.data && verified.data.user;
  if (verified?.error || !authUser?.id) {
    throw gatewayError(401, "The supplied Admin sign-in token is invalid or expired.", "AUTH_TOKEN_INVALID");
  }

  if (typeof db.auth.mfa?.getAuthenticatorAssuranceLevel !== "function") {
    throw gatewayError(503, "Admin MFA verification is unavailable.", "MFA_VERIFICATION_UNAVAILABLE");
  }

  let assurance;
  try {
    assurance = await db.auth.mfa.getAuthenticatorAssuranceLevel(token);
  } catch (_) {
    throw gatewayError(503, "Admin MFA verification is temporarily unavailable.", "MFA_VERIFICATION_UNAVAILABLE");
  }

  if (assurance?.error) {
    throw gatewayError(503, "Admin MFA verification is temporarily unavailable.", "MFA_VERIFICATION_UNAVAILABLE");
  }

  if (String(assurance?.data?.currentLevel || "").toLowerCase() !== "aal2") {
    throw gatewayError(403, "Complete multi-factor authentication before using Project Updates administration.", "AAL2_REQUIRED");
  }

  let adminQuery;
  try {
    adminQuery = await db.schema("albukhr_security")
      .from("admin_users")
      .select("user_id,status")
      .eq("user_id", authUser.id)
      .eq("status", "active")
      .maybeSingle();
  } catch (_) {
    throw gatewayError(503, "Publisher identity could not be verified.", "ADMIN_IDENTITY_LOOKUP_FAILED");
  }

  if (adminQuery?.error) {
    throw gatewayError(503, "Publisher identity could not be verified.", "ADMIN_IDENTITY_LOOKUP_FAILED");
  }

  if (!adminQuery?.data?.user_id || adminQuery.data.user_id !== authUser.id || adminQuery.data.status !== "active") {
    throw gatewayError(403, "This account is not an active ALBUKHR project administrator.", "ADMIN_ACCESS_REQUIRED");
  }

  return Object.freeze({
    principal_type: "supabase_auth_user",
    principal_id: authUser.id,
    network: MAINNET,
    assurance_level: "aal2"
  });
}

/**
 * Return only Mainnet projects for which the authenticated principal has an
 * active, non-revoked publisher grant. Project IDs are obtained server-side
 * from the grant ledger, never accepted from the browser as proof of access.
 */
async function listPublisherProjects(db, principal) {
  if (!db || !principal || !["albukhr_user", "supabase_auth_user"].includes(principal.principal_type) || !principal.principal_id) {
    throw gatewayError(401, "A verified Project Updates identity is required.", "PUBLISHER_IDENTITY_REQUIRED");
  }
  if (String(principal.network || "").toLowerCase() !== MAINNET) {
    throw gatewayError(403, "Project Updates publisher discovery is Mainnet only.", "NETWORK_MISMATCH");
  }

  let grantsResult;
  try {
    grantsResult = await db.schema("albukhr_security")
      .from("project_update_publisher_grants")
      .select("project_id,principal_type,principal_id,grant_source")
      .eq("network", MAINNET)
      .eq("principal_type", principal.principal_type)
      .eq("principal_id", principal.principal_id)
      .eq("active", true)
      .is("revoked_at", null);
  } catch (_) {
    throw gatewayError(503, "Project publishing permissions could not be loaded.", "PUBLISHER_GRANTS_LOOKUP_FAILED");
  }

  if (grantsResult?.error) {
    throw gatewayError(503, "Project publishing permissions could not be loaded.", "PUBLISHER_GRANTS_LOOKUP_FAILED");
  }

  const grants = Array.isArray(grantsResult?.data) ? grantsResult.data : [];
  const grantByProject = new Map();

  for (const grant of grants) {
    const projectId = String(grant?.project_id || "").trim();
    if (!projectId || grant.principal_type !== principal.principal_type || grant.principal_id !== principal.principal_id) continue;
    if (!grantByProject.has(projectId)) grantByProject.set(projectId, String(grant.grant_source || "publisher_grant"));
  }

  const projectIds = [...grantByProject.keys()];
  if (!projectIds.length) return [];

  let projectsResult;
  try {
    projectsResult = await db.from("projects")
      .select("id,project_code,slug,name,project_type,status,network")
      .in("id", projectIds)
      .eq("network", MAINNET)
      .in("status", ELIGIBLE_PROJECT_STATUSES);
  } catch (_) {
    throw gatewayError(503, "Authorized project details could not be loaded.", "PUBLISHER_PROJECTS_LOOKUP_FAILED");
  }

  if (projectsResult?.error) {
    throw gatewayError(503, "Authorized project details could not be loaded.", "PUBLISHER_PROJECTS_LOOKUP_FAILED");
  }

  const projects = Array.isArray(projectsResult?.data) ? projectsResult.data : [];
  return projects
    .filter((project) => project && projectIds.includes(String(project.id)) && String(project.network || "").toLowerCase() === MAINNET && ELIGIBLE_PROJECT_STATUSES.includes(String(project.status || "").toLowerCase()) && ["core", "internal", "external"].includes(String(project.project_type || "").toLowerCase()))
    .map((project) => ({
      project_id: String(project.id),
      project_code: String(project.project_code || ""),
      slug: String(project.slug || ""),
      name: String(project.name || ""),
      project_type: String(project.project_type || ""),
      status: String(project.status || ""),
      network: MAINNET,
      grant_source: grantByProject.get(String(project.id)) || "publisher_grant"
    }))
    .sort((a, b) => a.project_code.localeCompare(b.project_code));
}

module.exports = {
  MAINNET,
  ELIGIBLE_PROJECT_STATUSES,
  resolveSupabaseAdminPrincipal,
  listPublisherProjects
};
