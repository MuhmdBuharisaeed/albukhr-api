"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const policy = require("../src/staking-policy-acceptance-core");

const UUID = "8dfbd7b2-43a1-4fd6-86e4-cd3b159cfcab";
const HASH = "a".repeat(64);

test("policy constants match the immutable governance contract identifiers", () => {
  assert.equal(policy.POLICY_DOCUMENT_ID, "ALB-FIN-GOV-SPEC-001");
  assert.equal(policy.POLICY_REVISION, "1.0");
  assert.match(policy.POLICY_HASH, /^[a-f0-9]{64}$/);
});

test("session fingerprint is deterministic SHA-256 and rejects an empty token", () => {
  const expected = crypto.createHash("sha256").update("pi-session-token", "utf8").digest("hex");
  assert.equal(policy.sessionFingerprint("pi-session-token"), expected);
  assert.throws(() => policy.sessionFingerprint("  "), /token is required/i);
});

test("SHA-256 and UUID validators enforce complete formats", () => {
  assert.equal(policy.isSha256(HASH), true);
  assert.equal(policy.isSha256(HASH.slice(1)), false);
  assert.equal(policy.isSha256("g".repeat(64)), false);
  assert.equal(policy.isUuid(UUID), true);
  assert.equal(policy.isUuid("not-a-uuid"), false);
});

test("idempotency keys must be between 8 and 128 characters", () => {
  assert.equal(policy.isValidIdempotencyKey("12345678"), true);
  assert.equal(policy.isValidIdempotencyKey("x".repeat(128)), true);
  assert.equal(policy.isValidIdempotencyKey("1234567"), false);
  assert.equal(policy.isValidIdempotencyKey("x".repeat(129)), false);
});

test("payment acceptance metadata must match the exact acceptance and policy snapshot", () => {
  const acceptance = {
    policy_revision: "1.0",
    policy_hash: HASH,
    term_hash: "b".repeat(64)
  };
  const payment = {
    metadata: {
      acceptance_id: UUID,
      policy_revision: "1.0",
      policy_hash: HASH,
      term_hash: "b".repeat(64)
    }
  };
  assert.equal(policy.paymentAcceptanceMatches(payment, UUID, acceptance), true);
  assert.equal(policy.paymentAcceptanceMatches(payment, "7dfbd7b2-43a1-4fd6-86e4-cd3b159cfcab", acceptance), false);
  assert.equal(policy.paymentAcceptanceMatches({ metadata: [] }, UUID, acceptance), false);
  assert.equal(policy.paymentAcceptanceMatches({}, UUID, acceptance), false);
});
