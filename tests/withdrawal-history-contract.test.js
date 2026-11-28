"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { API_ROOT, configuredDirectory } = require("./helpers/workspace");

const apiRoot = process.env.ALBKHR_API_DIR ? path.resolve(process.env.ALBKHR_API_DIR) : API_ROOT;
const gatewayPath = path.join(apiRoot, "src/financial-gateway.js");
const gatewayAvailable = fs.existsSync(gatewayPath);
const appRoot = configuredDirectory("ALBUKHR_APP_DIR", "app");
const pagePath = appRoot && path.join(appRoot, "withdraw.html");
const pageScriptPath = appRoot && path.join(appRoot, "js/withdrawal-page.js");
const appAvailable = Boolean(pagePath && pageScriptPath && fs.existsSync(pagePath) && fs.existsSync(pageScriptPath));

test("withdrawal history endpoint binds identity and network server-side in the API gateway", {
  skip: gatewayAvailable ? false : "API source root not found; set ALBUKHR_API_DIR."
}, () => {
  const gateway = fs.readFileSync(gatewayPath, "utf8");
  assert.match(gateway, /router\.get\("\/api\/my-withdrawals"/);
  assert.match(gateway, /const identity = await verifiedPiIdentity\(req\)/);
  assert.match(gateway, /p_pi_uid: identity\.pi_uid/);
  assert.match(gateway, /p_network: MAINNET/);
  assert.match(gateway, /const rows = \(Array\.isArray\(data\) \? data : \[\]\)\.map/);
});

test("withdrawal UI uses only the trusted request/read endpoints and no browser payment execution", {
  skip: appAvailable ? false : "App companion repository not configured; set ALBUKHR_APP_DIR."
}, () => {
  const page = fs.readFileSync(pagePath, "utf8");
  const pageScript = fs.readFileSync(pageScriptPath, "utf8");
  assert.match(page, /js\/core\/pi-auth-core\.js/);
  assert.match(page, /js\/core\/albukhr-api-core\.js/);
  assert.match(pageScript, /\/api\/my-stakes\?network=mainnet/);
  assert.match(pageScript, /\/api\/my-withdrawals\?network=mainnet/);
  assert.match(pageScript, /\/api\/withdrawal-request/);
  assert.doesNotMatch(pageScript, /Pi\.createPayment|submitPayment|completePayment/);
  assert.doesNotMatch(pageScript, /localStorage|sessionStorage/);
  assert.match(pageScript, /env\.isMainnet\(\)/);
  assert.match(pageScript, /core\.network[^\n]*mainnet/);
  assert.doesNotMatch(pageScript, /name=["']pi_uid["']/i);
});
