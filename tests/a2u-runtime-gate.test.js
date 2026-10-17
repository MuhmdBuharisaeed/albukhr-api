"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const clientPath = path.resolve(__dirname, "../src/pi-a2u-client.js");
const childScript = `
  const assert = require('node:assert/strict');
  const client = require(${JSON.stringify(clientPath)});
  assert.equal(client.a2uEnabled(), false);
  assert.equal(client.walletStatus().mainnet_a2u_officially_supported_in_this_release, false);
  (async () => {
    await assert.rejects(
      client.createA2UPayment({ uid: 'example-user', amount: 1, memo: 'no-op', metadata: {} }),
      error => error && error.code === 'A2U_MAINNET_DISABLED' && error.status === 503
    );
    console.log('A2U runtime gate test passed; no Pi API request was made.');
  })().catch(error => { console.error(error); process.exit(1); });
`;

const env = {
  ...process.env,
  PI_A2U_ENABLED: "true",
  PI_A2U_MAINNET_APPROVED: "true",
  PI_A2U_NETWORK: "mainnet",
  PI_API_KEY: "",
  WALLET_PRIVATE_SEED: ""
};
const result = spawnSync(process.execPath, ["-e", childScript], {
  env,
  encoding: "utf8"
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || "Runtime gate test failed.\n");
  process.stdout.write(result.stdout || "");
  process.exit(result.status || 1);
}
process.stdout.write(result.stdout);
