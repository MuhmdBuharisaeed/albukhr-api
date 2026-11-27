"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeReadinessProjection,
  readMainnetFinancialReadiness,
} = require("../src/mainnet-financial-readiness");

function readyProjection(overrides = {}) {
  return {
    contract_version: "mainnet_financial_readiness_v1",
    network: "mainnet",
    ready: true,
    functions: { liquidity_settlement_present: true },
    ...overrides,
  };
}

test("accepts a ready Mainnet financial readiness projection", () => {
  const result = normalizeReadinessProjection(readyProjection());
  assert.equal(result.present, true);
  assert.equal(result.ready, true);
  assert.equal(result.settlementRpcPresent, true);
  assert.equal(result.code, "OK");
});

test("fails closed when the readiness projection reports not ready", () => {
  const result = normalizeReadinessProjection(readyProjection({ ready: false }));
  assert.equal(result.present, true);
  assert.equal(result.ready, false);
  assert.equal(result.code, "FINANCIAL_READINESS_NOT_READY");
});

test("rejects Testnet or an unexpected contract version", () => {
  const networkResult = normalizeReadinessProjection(readyProjection({ network: "testnet" }));
  const versionResult = normalizeReadinessProjection(readyProjection({ contract_version: "other" }));
  assert.equal(networkResult.present, false);
  assert.equal(versionResult.present, false);
});

test("reports malformed readiness payload as unavailable", () => {
  const result = normalizeReadinessProjection(null);
  assert.equal(result.present, false);
  assert.equal(result.ready, false);
});

test("calls only the albukhr_security readiness RPC", async () => {
  const calls = [];
  const client = {
    schema(name) {
      calls.push({ schema: name });
      return {
        async rpc(name) {
          calls.push({ rpc: name });
          return { data: readyProjection(), error: null };
        },
      };
    },
  };

  const result = await readMainnetFinancialReadiness(client);
  assert.equal(result.ready, true);
  assert.deepEqual(calls, [
    { schema: "albukhr_security" },
    { rpc: "get_mainnet_financial_readiness_v1" },
  ]);
});

test("fails closed when the readiness RPC errors", async () => {
  const client = {
    schema() {
      return { async rpc() { return { data: null, error: { code: "42501" } }; } };
    },
  };
  const result = await readMainnetFinancialReadiness(client);
  assert.equal(result.ready, false);
  assert.equal(result.present, false);
  assert.equal(result.code, "42501");
});
