"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const fundingHtml = read("albukhr-app/external-project-funding.html");
const fundingJs = read("albukhr-app/js/external-project-funding.js");
const externalApi = read("albukhr-app/js/core/external-project-api.js");
const gateway = read("albukhr-api/src/external-project-funding-gateway.js");
const server = read("albukhr-api/server.js");
const sql = read("database/EXTERNAL_PROJECT_OWNER_FUNDING_TRUSTED_RPC_DRAFT.sql");
const apiPackage = JSON.parse(read("albukhr-api/package.json"));

function has(text, pattern, message) {
  assert.match(text, pattern, message);
}

function lacks(text, pattern, message) {
  assert.doesNotMatch(text, pattern, message);
}

test("Funding page retains Pi auth guard and loads the trusted API stack in order", () => {
  const piSdk = fundingHtml.indexOf("https://sdk.minepi.com/pi-sdk.js");
  const supabaseSdk = fundingHtml.indexOf("@supabase/supabase-js@2");
  const environmentCore = fundingHtml.indexOf("js/core/environment-core.js");
  const supabaseCore = fundingHtml.indexOf("js/core/supabase-core.js");
  const piAuth = fundingHtml.indexOf("js/core/pi-auth-core.js");
  const guard = fundingHtml.indexOf("js/core/page-auth-guard.js");
  const apiCore = fundingHtml.indexOf("js/core/albukhr-api-core.js");
  const externalAdapter = fundingHtml.indexOf("js/core/external-project-api.js");
  assert.ok(piSdk >= 0 && piSdk < piAuth, "Pi SDK must load before Pi Auth Core");
  assert.ok(supabaseSdk >= 0 && environmentCore < supabaseCore && supabaseCore < piAuth,
    "Supabase SDK/Core must load before Pi Auth Core for network validation");
  assert.ok(piAuth < guard && guard < apiCore && apiCore < externalAdapter,
    "Auth Guard and API dependencies must preserve document script order");
  has(fundingHtml, /id="submit"[^>]*disabled/, "Owner submission must remain locked");
  has(fundingHtml, /Submission security/i, "Page must explain why submission is locked");
  has(fundingHtml, /js\/core\/supabase-core\.js/, "Pi Auth Core Supabase network validation dependency must remain");
});

test("Funding UI calls the external API adapter and preserves locked submission", () => {
  has(fundingJs, /AlbukhrPageAuthGuard\.waitForAuth\(\)/,
    "Page Auth Guard must remain in the flow");
  has(fundingJs, /getFundingPlan\(/, "Funding read must use the API adapter");
  has(fundingJs, /saveFundingPlan\(/, "Funding save must use the API adapter");
  has(fundingJs, /submitButton\.disabled = true/, "Submit control must remain fail-closed");
  lacks(fundingJs, /\.rpc\s*\(/, "Funding UI must not call Supabase RPC directly");
  lacks(fundingJs, /ALBUKHR_SUPABASE/, "Funding UI must not access the browser Supabase client");
});

test("External Project API adapter strips authority fields and exposes funding routes", () => {
  for (const method of ["getFundingPlan", "saveFundingPlan", "submitFundingPlan"]) {
    has(externalApi, new RegExp(`async ${method}\\(`), `${method} API method is required`);
  }
  has(externalApi, /delete output\.p_pi_uid/, "Pi UID must be stripped from browser payloads");
  has(externalApi, /delete output\.owner_albukhr_user_id/, "Canonical Owner ID must be stripped");
  has(externalApi, /network !== "mainnet"/, "Adapter must reject Testnet use");
});

test("Funding gateway verifies the Pi token and calls only the trusted draft RPCs", () => {
  has(gateway, /getPioneer\(requireBearer\(req\)\)/,
    "Gateway must verify the Pi bearer token server-side");
  has(gateway, /gateway_get_my_external_funding_plan_trusted/, "Trusted read RPC must be called");
  has(gateway, /gateway_save_my_external_funding_plan_trusted/, "Trusted save RPC must be called");
  has(gateway, /Funding submission is temporarily locked/, "Submission must fail closed pending step-up");
  lacks(gateway, /gateway_submit_my_external_funding_plan_trusted/,
    "Gateway must not call a service-role submission bypass");
  has(gateway, /p_pi_uid: identity\.pi_uid/, "UID must derive from verified Pi identity");
  lacks(gateway, /requestBody\(req\)\.p_pi_uid|requestBody\(req\)\.p_network/,
    "Gateway must not trust browser identity/network authority fields");
});

test("Server keeps existing gateways and mounts funding router additively", () => {
  has(server, /require\("\.\/src\/external-project-funding-gateway"\)/,
    "New gateway module must be imported");
  has(server, /app\.use\(\s*"\/api\/external-project",\s*externalProjectGatewayRouter\s*\)/,
    "Existing External Project gateway mount must remain");
  has(server, /app\.use\(\s*"\/api\/external-project",\s*externalProjectFundingGatewayRouter\s*\)/,
    "New funding router must be mounted additively");
  has(server, /app\.use\(internalFundingGatewayRouter\)/,
    "Internal Funding Gateway mount must remain");
  has(server, /app\.use\(financialGatewayRouter\)/,
    "Financial Gateway mount must remain");
  has(server, /DAPP_SERVICE_V2_ENABLED/, "Existing DApp feature flag must remain");
});

test("SQL draft restricts trusted RPCs and uses canonical ownership", () => {
  has(sql, /gateway_get_my_external_funding_plan_trusted/, "Trusted read RPC must exist");
  has(sql, /gateway_save_my_external_funding_plan_trusted/, "Trusted save RPC must exist");
  has(sql, /auth\.jwt\(\)->>'role'.*service_role/s,
    "Trusted functions must require service-role JWT context");
  has(sql, /p\.owner_albukhr_user_id = v_user_id/,
    "Converted External project ownership must use canonical owner ID");
  has(sql, /FROM PUBLIC/, "PUBLIC function execution must be revoked");
  has(sql, /FROM anon, authenticated/, "Browser roles must be denied trusted RPC execution");
  has(sql, /TO service_role/, "Service role must receive the trusted RPC grants");
  has(sql, /'NaN', 'Infinity', '-Infinity'/,
    "Funding numbers must reject non-finite values");
  has(sql, /Submission is intentionally not exposed/, "Submission must remain unexposed pending Owner step-up");
  lacks(sql, /gateway_submit_my_external_funding_plan_trusted/,
    "No trusted funding submission bypass may be present");
});


test("API package check script includes the new funding gateway", () => {
  has(apiPackage.scripts.check, /src\/external-project-funding-gateway\.js/,
    "npm run check must syntax-check the new gateway module");
});
