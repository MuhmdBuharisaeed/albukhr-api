"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  API_ROOT,
  configuredDirectory
} = require("./helpers/workspace");

const appRoot = configuredDirectory("ALBUKHR_APP_REPO_DIR", "albukhr-app");
const databaseRoot = configuredDirectory("ALBUKHR_DATABASE_DIR", "database");
const apiRoot = process.env.ALBKHR_API_DIR ? path.resolve(process.env.ALBKHR_API_DIR) : API_ROOT;
const required = [
  appRoot && path.join(appRoot, "external-project-funding.html"),
  appRoot && path.join(appRoot, "js/external-project-funding.js"),
  appRoot && path.join(appRoot, "js/core/external-project-api.js"),
  path.join(apiRoot, "src/external-project-funding-gateway.js"),
  path.join(apiRoot, "server.js"),
  databaseRoot && path.join(databaseRoot, "EXTERNAL_PROJECT_OWNER_FUNDING_TRUSTED_RPC_DRAFT.sql"),
  path.join(apiRoot, "package.json")
];
const available = required.every((file) => file && fs.existsSync(file) && fs.statSync(file).isFile());

test("External Project funding cross-repository contract is checked when companion repositories are configured", {
  skip: available ? false : "App/Database companion files are unavailable. Configure ALBUKHR_APP_REPO_DIR and ALBUKHR_DATABASE_DIR."
}, () => {
  const read = (file) => fs.readFileSync(file, "utf8");
  const fundingHtml = read(required[0]);
  const fundingJs = read(required[1]);
  const externalApi = read(required[2]);
  const gateway = read(required[3]);
  const server = read(required[4]);
  const sql = read(required[5]);
  const apiPackage = JSON.parse(read(required[6]));

  const has = (value, pattern, message) => assert.match(value, pattern, message);
  const lacks = (value, pattern, message) => assert.doesNotMatch(value, pattern, message);

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

  has(fundingJs, /AlbukhrPageAuthGuard\.waitForAuth\(\)/, "Page Auth Guard must remain in the flow");
  has(fundingJs, /getFundingPlan\(/, "Funding read must use the API adapter");
  has(fundingJs, /saveFundingPlan\(/, "Funding save must use the API adapter");
  has(fundingJs, /submitButton\.disabled = true/, "Submit control must remain fail-closed");
  lacks(fundingJs, /\.rpc\s*\(/, "Funding UI must not call Supabase RPC directly");
  lacks(fundingJs, /ALBUKHR_SUPABASE/, "Funding UI must not access the browser Supabase client");

  for (const method of ["getFundingPlan", "saveFundingPlan", "submitFundingPlan"]) {
    has(externalApi, new RegExp(`async ${method}\\(`), `${method} API method is required`);
  }
  has(externalApi, /delete output\.p_pi_uid/, "Pi UID must be stripped from browser payloads");
  has(externalApi, /delete output\.owner_albukhr_user_id/, "Canonical Owner ID must be stripped");
  has(externalApi, /network !== "mainnet"/, "Adapter must reject Testnet use");

  has(gateway, /getPioneer\(requireBearer\(req\)\)/, "Gateway must verify Pi bearer token server-side");
  has(gateway, /gateway_get_my_external_funding_plan_trusted/, "Trusted read RPC must be called");
  has(gateway, /gateway_save_my_external_funding_plan_trusted/, "Trusted save RPC must be called");
  has(gateway, /Funding submission is temporarily locked/, "Submission must fail closed pending step-up");
  lacks(gateway, /gateway_submit_my_external_funding_plan_trusted/, "Gateway must not call a service-role submission bypass");
  has(gateway, /p_pi_uid: identity\.pi_uid/, "UID must derive from verified Pi identity");
  lacks(gateway, /requestBody\(req\)\.p_pi_uid|requestBody\(req\)\.p_network/, "Gateway must not trust browser identity/network fields");

  has(server, /require\("\.\/src\/external-project-funding-gateway"\)/, "Funding gateway must be imported");
  has(server, /app\.use\(\s*"\/api\/external-project",\s*externalProjectGatewayRouter\s*\)/, "Existing External Project mount must remain");
  has(server, /app\.use\(\s*"\/api\/external-project",\s*externalProjectFundingGatewayRouter\s*\)/, "Funding router must mount additively");
  has(server, /app\.use\(internalFundingGatewayRouter\)/, "Internal Funding mount must remain");
  has(server, /app\.use\(financialGatewayRouter\)/, "Financial Gateway mount must remain");
  has(server, /DAPP_SERVICE_V2_ENABLED/, "Existing DApp feature flag must remain");

  has(sql, /gateway_get_my_external_funding_plan_trusted/, "Trusted read RPC must exist");
  has(sql, /gateway_save_my_external_funding_plan_trusted/, "Trusted save RPC must exist");
  has(sql, /auth\.jwt\(\)->>'role'.*service_role/s, "Trusted functions must require service-role JWT context");
  has(sql, /p\.owner_albukhr_user_id = v_user_id/, "Ownership must use canonical owner ID");
  has(sql, /FROM PUBLIC/, "PUBLIC execution must be revoked");
  has(sql, /FROM anon, authenticated/, "Browser roles must be denied trusted RPC execution");
  has(sql, /TO service_role/, "Service role must receive trusted RPC grants");
  has(sql, /'NaN', 'Infinity', '-Infinity'/, "Funding numbers must reject non-finite values");
  has(sql, /Submission is intentionally not exposed/, "Submission must remain unexposed pending Owner step-up");
  lacks(sql, /gateway_submit_my_external_funding_plan_trusted/, "No trusted funding submission bypass may be present");

  has(apiPackage.scripts.check, /node scripts\/check-syntax\.js/, "API check must use the complete syntax scanner");
});
