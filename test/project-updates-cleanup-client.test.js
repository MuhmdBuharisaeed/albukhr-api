"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EXPECTED_HOST,
  EXPECTED_PATH,
  buildCleanupConfig,
  runProjectUpdatesCleanup
} = require("../src/project-updates-cleanup-client");

const KEY = "a".repeat(48);
const ENDPOINT = `https://${EXPECTED_HOST}${EXPECTED_PATH}`;
const baseEnv = () => ({
  PROJECT_UPDATES_CLEANUP_URL: ENDPOINT,
  PROJECT_UPDATES_CLEANUP_KEY: KEY
});

function jsonResponse(payload, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    async json() { return payload; }
  };
}

test("accepts only the HTTPS Mainnet cleanup endpoint and a sufficiently long key", () => {
  const config = buildCleanupConfig(baseEnv());
  assert.equal(config.endpoint, ENDPOINT);
  assert.equal(config.limit, 25);
  assert.equal(config.timeoutMs, 90_000);
});

test("rejects missing or short cleanup secrets", () => {
  assert.throws(() => buildCleanupConfig({ PROJECT_UPDATES_CLEANUP_URL: ENDPOINT }), { code: "CLEANUP_KEY_MISSING" });
  assert.throws(() => buildCleanupConfig({ PROJECT_UPDATES_CLEANUP_URL: ENDPOINT, PROJECT_UPDATES_CLEANUP_KEY: "short" }), { code: "CLEANUP_KEY_MISSING" });
});

test("rejects non-Mainnet hosts, HTTP, URL credentials, query strings and path changes", () => {
  for (const url of [
    `http://${EXPECTED_HOST}${EXPECTED_PATH}`,
    `https://evil.example${EXPECTED_PATH}`,
    `https://user:pass@${EXPECTED_HOST}${EXPECTED_PATH}`,
    `${ENDPOINT}?other=1`,
    `${ENDPOINT}/extra`
  ]) {
    assert.throws(() => buildCleanupConfig({ ...baseEnv(), PROJECT_UPDATES_CLEANUP_URL: url }), { code: "CLEANUP_URL_NOT_ALLOWED" });
  }
});

test("validates bounded cleanup batch size and timeout", () => {
  assert.equal(buildCleanupConfig({ ...baseEnv(), CLEANUP_BATCH_LIMIT: "100" }).limit, 100);
  assert.throws(() => buildCleanupConfig({ ...baseEnv(), CLEANUP_BATCH_LIMIT: "101" }), { code: "CLEANUP_LIMIT_INVALID" });
  assert.throws(() => buildCleanupConfig({ ...baseEnv(), PROJECT_UPDATES_CLEANUP_TIMEOUT_MS: "999" }), { code: "CLEANUP_TIMEOUT_INVALID" });
});

test("sends an authenticated bounded Mainnet cleanup request and validates its result", async () => {
  let captured;
  const result = await runProjectUpdatesCleanup({
    env: { ...baseEnv(), CLEANUP_BATCH_LIMIT: "12" },
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        success: true,
        network: "mainnet",
        data: { claimed: 3, deleted_or_missing: 2, protected: 1, retry: 0 }
      });
    }
  });

  assert.equal(captured.url, ENDPOINT);
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["x-project-updates-cleanup-key"], KEY);
  assert.deepEqual(JSON.parse(captured.init.body), { limit: 12 });
  assert.deepEqual(result, {
    network: "mainnet",
    claimed: 3,
    deleted_or_missing: 2,
    protected: 1,
    retry: 0
  });
});

test("fails closed on non-2xx, wrong network, invalid and unreconciled responses", async () => {
  const env = baseEnv();
  await assert.rejects(
    runProjectUpdatesCleanup({ env, fetchImpl: async () => jsonResponse({}, { ok: false, status: 503 }) }),
    { code: "CLEANUP_HTTP_ERROR" }
  );
  await assert.rejects(
    runProjectUpdatesCleanup({ env, fetchImpl: async () => jsonResponse({ success: true, network: "testnet", data: { claimed: 0, deleted_or_missing: 0, protected: 0, retry: 0 } }) }),
    { code: "CLEANUP_RESPONSE_INVALID" }
  );
  await assert.rejects(
    runProjectUpdatesCleanup({ env, fetchImpl: async () => jsonResponse({ success: true, network: "mainnet", data: { claimed: 1, deleted_or_missing: 0, protected: 0, retry: 0 } }) }),
    { code: "CLEANUP_SUMMARY_INCONSISTENT" }
  );
});

test("does not expose secrets in request failures", async () => {
  await assert.rejects(
    runProjectUpdatesCleanup({
      env: baseEnv(),
      fetchImpl: async () => { throw new Error(`transport failed with ${KEY}`); }
    }),
    (error) => {
      assert.equal(error.code, "CLEANUP_REQUEST_FAILED");
      assert.equal(error.message.includes(KEY), false);
      return true;
    }
  );
});
