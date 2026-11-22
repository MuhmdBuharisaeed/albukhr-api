"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveSupabaseAdminPrincipal,
  listPublisherProjects
} = require("../src/project-updates-admin-access");

const ADMIN_ID = "46aaf51b-7dc0-431f-a93b-7f303470f6c8";
const OWNER_ID = "720c3e22-1adb-4f11-b89c-087e7ca580db";
const PROJECT_ID = "86737826-b6ab-48e0-a649-8e7cb75be14f";

function queryResult(result) {
  const query = {};
  for (const method of ["select", "eq", "is", "in", "order"]) {
    query[method] = () => query;
  }
  query.maybeSingle = async () => result;
  query.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return query;
}

function adminDb({ user = { id: ADMIN_ID }, userError = null, aal = "aal2", aalError = null, admin = { user_id: ADMIN_ID, status: "active" }, adminError = null } = {}) {
  let adminLookups = 0;
  const db = {
    auth: {
      getUser: async (token) => {
        assert.equal(token, "verified-token");
        return { data: { user }, error: userError };
      },
      mfa: {
        getAuthenticatorAssuranceLevel: async (token) => {
          assert.equal(token, "verified-token");
          return { data: { currentLevel: aal }, error: aalError };
        }
      }
    },
    schema: (schemaName) => {
      assert.equal(schemaName, "albukhr_security");
      return {
        from: (tableName) => {
          assert.equal(tableName, "admin_users");
          const query = {};
          query.select = () => query;
          query.eq = () => query;
          query.maybeSingle = async () => {
            adminLookups += 1;
            return { data: admin, error: adminError };
          };
          return query;
        }
      };
    }
  };
  return { db, adminLookups: () => adminLookups };
}

test("resolves an active Admin only after server-side AAL2 verification", async () => {
  const fixture = adminDb();
  const principal = await resolveSupabaseAdminPrincipal(fixture.db, "verified-token");
  assert.deepEqual(principal, {
    principal_type: "supabase_auth_user",
    principal_id: ADMIN_ID,
    network: "mainnet",
    assurance_level: "aal2"
  });
  assert.equal(fixture.adminLookups(), 1);
});

test("rejects missing token before querying Supabase", async () => {
  const fixture = adminDb();
  await assert.rejects(() => resolveSupabaseAdminPrincipal(fixture.db, ""), { status: 401, code: "AUTH_TOKEN_REQUIRED" });
  assert.equal(fixture.adminLookups(), 0);
});

test("rejects invalid Supabase JWT", async () => {
  const fixture = adminDb({ user: null, userError: new Error("bad token") });
  await assert.rejects(() => resolveSupabaseAdminPrincipal(fixture.db, "verified-token"), { status: 401, code: "AUTH_TOKEN_INVALID" });
  assert.equal(fixture.adminLookups(), 0);
});

test("blocks aal1 before admin grant lookup", async () => {
  const fixture = adminDb({ aal: "aal1" });
  await assert.rejects(() => resolveSupabaseAdminPrincipal(fixture.db, "verified-token"), { status: 403, code: "AAL2_REQUIRED" });
  assert.equal(fixture.adminLookups(), 0);
});

test("fails closed when MFA verification service is unavailable", async () => {
  const fixture = adminDb({ aalError: new Error("Auth unavailable") });
  await assert.rejects(() => resolveSupabaseAdminPrincipal(fixture.db, "verified-token"), { status: 503, code: "MFA_VERIFICATION_UNAVAILABLE" });
  assert.equal(fixture.adminLookups(), 0);
});

test("rejects a non-active ALBUKHR Admin", async () => {
  const fixture = adminDb({ admin: { user_id: ADMIN_ID, status: "suspended" } });
  await assert.rejects(() => resolveSupabaseAdminPrincipal(fixture.db, "verified-token"), { status: 403, code: "ADMIN_ACCESS_REQUIRED" });
});

test("returns only projects linked to active Mainnet publisher grants", async () => {
  const grantRows = [
    { project_id: PROJECT_ID, principal_type: "albukhr_user", principal_id: OWNER_ID, grant_source: "project_owner" },
    { project_id: "ignored", principal_type: "albukhr_user", principal_id: "different-user", grant_source: "project_owner" }
  ];
  const projectRows = [
    { id: PROJECT_ID, project_code: "DAN-COS-001", slug: "dankwalliya-cosmetics", name: "DANKWALLIYA COSMETICS", project_type: "external", status: "approved", network: "mainnet" },
    { id: "ignored", project_code: "TEST-001", name: "Wrong network", project_type: "internal", status: "approved", network: "testnet" }
  ];
  const db = {
    schema: () => ({ from: () => ({
      select: () => queryResult({ data: grantRows, error: null }),
      eq: () => queryResult({ data: grantRows, error: null }),
      is: () => queryResult({ data: grantRows, error: null })
    }) }),
    from: () => ({
      select: () => queryResult({ data: projectRows, error: null }),
      in: () => queryResult({ data: projectRows, error: null }),
      eq: () => queryResult({ data: projectRows, error: null })
    })
  };
  const projects = await listPublisherProjects(db, {
    principal_type: "albukhr_user",
    principal_id: OWNER_ID,
    network: "mainnet"
  });
  assert.deepEqual(projects, [{
    project_id: PROJECT_ID,
    project_code: "DAN-COS-001",
    slug: "dankwalliya-cosmetics",
    name: "DANKWALLIYA COSMETICS",
    project_type: "external",
    status: "approved",
    network: "mainnet",
    grant_source: "project_owner"
  }]);
});

test("returns an empty list when principal has no publisher grants", async () => {
  const db = { schema: () => ({ from: () => ({
    select: () => queryResult({ data: [], error: null }),
    eq: () => queryResult({ data: [], error: null }),
    is: () => queryResult({ data: [], error: null })
  }) }) };
  const projects = await listPublisherProjects(db, { principal_type: "supabase_auth_user", principal_id: ADMIN_ID, network: "mainnet" });
  assert.deepEqual(projects, []);
});
