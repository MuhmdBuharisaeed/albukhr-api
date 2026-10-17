"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectA2UWithdrawal, assessPayment } = require("../src/a2u-reconciliation-service");

const ID = "4c7c2341-64a7-4d70-9e1d-423adab27b23";
const ATTEMPT_ID = "fe1e5dc8-145d-4a9a-aadb-9a4c8e1b30f2";

function makeDb({ request = {}, attempt = null, missingSafetyColumns = false } = {}) {
  const reads = [];
  return {
    reads,
    from(table) {
      let fields = "";
      const q = {
        select(value) { fields = String(value || ""); return q; },
        eq() { return q; },
        maybeSingle() {
          reads.push({ table, fields });
          if (table === "withdrawal_payout_attempts" && missingSafetyColumns && fields.includes("payment_creation_started_at")) {
            return Promise.resolve({ data: null, error: { code: "42703", message: "column payment_creation_started_at does not exist" } });
          }
          return Promise.resolve({ data: table === "withdrawal_requests" ? request : attempt, error: null });
        }
      };
      return q;
    }
  };
}

function fixtureRequest(overrides = {}) {
  return {
    id: ID,
    stake_id: "3b7c2341-64a7-4d70-9e1d-423adab27b23",
    user_id: "2a7c2341-64a7-4d70-9e1d-423adab27b23",
    pi_uid: "pi-user-001",
    project_code: "DEMO",
    network: "mainnet",
    withdrawal_type: "reward",
    requested_amount: 10,
    fee_amount: 0.1,
    net_amount: 10,
    wallet_address: "STORED_WALLET",
    status: "approved",
    txid: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function fixtureAttempt(overrides = {}) {
  return {
    id: ATTEMPT_ID,
    withdrawal_request_id: ID,
    network: "mainnet",
    status: "failed",
    attempt_count: 2,
    lease_until: null,
    payment_id: "payment-demo-01",
    txid: "tx-demo-01",
    last_error: null,
    started_at: null,
    completed_at: null,
    updated_at: null,
    lease_token: "secret-token-not-returned",
    payment_creation_started_at: null,
    submission_started_at: null,
    ...overrides
  };
}

function fixturePayment(request = fixtureRequest(), overrides = {}) {
  return {
    identifier: "payment-demo-01",
    user_uid: request.pi_uid,
    amount: Number(request.requested_amount),
    memo: `ALBUKHR-WD:${request.id}`,
    metadata: { source: "albukhr-api", network: "mainnet", withdrawal_request_id: request.id },
    direction: "app_to_user",
    network: "Pi Network",
    to_address: "PI_CURRENT_WALLET",
    status: {
      developer_approved: true,
      transaction_verified: true,
      developer_completed: true,
      cancelled: false,
      user_cancelled: false
    },
    transaction: { txid: "tx-demo-01", verified: true },
    ...overrides
  };
}

function fakeFetch({ payment = fixturePayment(), incomplete = [], failIncomplete = false, failPayment = false } = {}) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url: String(url), method: options?.method, headers: options?.headers });
    if (String(url).endsWith("/payments/incomplete_server_payments")) {
      return { ok: !failIncomplete, status: failIncomplete ? 503 : 200, json: async () => ({ incomplete_server_payments: incomplete }) };
    }
    if (String(url).endsWith("/payments/payment-demo-01")) {
      return { ok: !failPayment, status: failPayment ? 404 : 200, json: async () => payment };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

test("valid, identity-matched verified Pi payment is classified completed but never releases payout", async () => {
  const request = fixtureRequest();
  const db = makeDb({ request, attempt: fixtureAttempt() });
  const fetchImpl = fakeFetch({ payment: fixturePayment(request) });
  const result = await inspectA2UWithdrawal({ withdrawalRequestId: ID, database: db, fetchImpl, apiKey: "unit-test-key" });
  assert.equal(result.classification, "CONFIRMED_PI_PAYMENT_COMPLETED");
  assert.equal(result.safe_to_mark_paid_automatically, false);
  assert.equal(result.safe_to_release_manual_payout, false);
  assert.match(result.evidence_sha256, /^[a-f0-9]{64}$/);
  assert.equal(db.reads.length, 2);
  assert.ok(fetchImpl.calls.every(call => call.method === "GET"));
  assert.ok(fetchImpl.calls.every(call => call.headers.Authorization === "Key unit-test-key"));
});

test("no payment ID and no incomplete payment is unresolved, not proof of non-payment", async () => {
  const db = makeDb({ request: fixtureRequest(), attempt: fixtureAttempt({ payment_id: null, txid: null, status: "failed" }) });
  const fetchImpl = fakeFetch({ incomplete: [] });
  const result = await inspectA2UWithdrawal({ withdrawalRequestId: ID, database: db, fetchImpl, apiKey: "unit-test-key" });
  assert.equal(result.classification, "NO_PAYMENT_FOUND_BUT_OUTCOME_UNRESOLVED");
  assert.equal(result.safe_to_release_manual_payout, false);
  assert.match(result.note, /does not prove that no payment occurred/i);
});

test("wrong Pi UID is an identity mismatch and remains blocked", () => {
  const request = fixtureRequest();
  const assessed = assessPayment(request, fixturePayment(request, { user_uid: "another-pi-user" }), "payment-demo-01");
  assert.equal(assessed.classification, "PI_PAYMENT_IDENTITY_MISMATCH");
  assert.ok(assessed.evidence.contradictions.includes("pi_uid_mismatch"));
  assert.equal(assessed.safe_to_release_manual_payout, false);
});

test("verified blockchain transaction without developer completion stays unresolved for separate finalization review", () => {
  const request = fixtureRequest();
  const assessed = assessPayment(request, fixturePayment(request, {
    status: { developer_approved: true, transaction_verified: true, developer_completed: false, cancelled: false, user_cancelled: false }
  }), "payment-demo-01");
  assert.equal(assessed.classification, "CHAIN_TRANSACTION_VERIFIED_COMPLETION_PENDING");
  assert.equal(assessed.safe_to_mark_paid_automatically, false);
  assert.equal(assessed.safe_to_release_manual_payout, false);
});

test("cancelled Pi payment is never automatically treated as safe for a new manual payout", () => {
  const request = fixtureRequest();
  const assessed = assessPayment(request, fixturePayment(request, {
    status: { developer_approved: true, transaction_verified: false, developer_completed: false, cancelled: true, user_cancelled: false },
    transaction: null
  }), "payment-demo-01");
  assert.equal(assessed.classification, "CANCELLED_PAYMENT_REQUIRES_REVIEW");
  assert.equal(assessed.safe_to_release_manual_payout, false);
});

test("Pi lookup unavailable remains blocked", async () => {
  const db = makeDb({ request: fixtureRequest(), attempt: fixtureAttempt() });
  const fetchImpl = fakeFetch({ failIncomplete: true });
  const result = await inspectA2UWithdrawal({ withdrawalRequestId: ID, database: db, fetchImpl, apiKey: "unit-test-key" });
  assert.equal(result.classification, "PI_INCOMPLETE_LIST_UNAVAILABLE");
  assert.equal(result.safe_to_release_manual_payout, false);
});


test("inspector falls back to current schema but reports safety marker columns unavailable", async () => {
  const db = makeDb({ request: fixtureRequest(), attempt: fixtureAttempt({ payment_id: null, txid: null }), missingSafetyColumns: true });
  const fetchImpl = fakeFetch({ incomplete: [] });
  const result = await inspectA2UWithdrawal({ withdrawalRequestId: ID, database: db, fetchImpl, apiKey: "unit-test-key" });
  assert.equal(result.classification, "NO_PAYMENT_FOUND_BUT_OUTCOME_UNRESOLVED");
  assert.equal(result.database_state.safety_marker_schema_available, false);
  assert.equal(result.safe_to_release_manual_payout, false);
  assert.equal(db.reads.filter(row => row.table === "withdrawal_payout_attempts").length, 2);
});


test("orphan Pi-side incomplete payment is discovered, then verified through the payment GET endpoint", async () => {
  const request = fixtureRequest();
  const db = makeDb({ request, attempt: null });
  const orphan = {
    identifier: "payment-demo-01",
    metadata: { source: "albukhr-api", network: "mainnet", withdrawal_request_id: ID }
  };
  const fetchImpl = fakeFetch({ payment: fixturePayment(request), incomplete: [orphan] });
  const result = await inspectA2UWithdrawal({ withdrawalRequestId: ID, database: db, fetchImpl, apiKey: "unit-test-key" });
  assert.equal(result.classification, "CONFIRMED_PI_PAYMENT_COMPLETED");
  assert.equal(result.database_state.attempt_present, false);
  assert.equal(result.safe_to_release_manual_payout, false);
  assert.ok(fetchImpl.calls.some(call => call.url.endsWith("/payments/payment-demo-01")));
});

test("multiple Pi-side payments matching one withdrawal stay blocked", async () => {
  const db = makeDb({ request: fixtureRequest(), attempt: null });
  const incomplete = [
    { identifier: "payment-demo-01", metadata: { source: "albukhr-api", network: "mainnet", withdrawal_request_id: ID } },
    { identifier: "payment-demo-02", metadata: { source: "albukhr-api", network: "mainnet", withdrawal_request_id: ID } }
  ];
  const fetchImpl = fakeFetch({ incomplete });
  const result = await inspectA2UWithdrawal({ withdrawalRequestId: ID, database: db, fetchImpl, apiKey: "unit-test-key" });
  assert.equal(result.classification, "MULTIPLE_OR_ORPHAN_PI_PAYMENTS_MATCH_WITHDRAWAL");
  assert.equal(result.safe_to_release_manual_payout, false);
  assert.equal(fetchImpl.calls.length, 1, "must stop before choosing either payment");
});

test("rejected custom hosts are not contacted", async () => {
  const db = makeDb({ request: fixtureRequest(), attempt: fixtureAttempt() });
  const fetchImpl = fakeFetch();
  await assert.rejects(
    inspectA2UWithdrawal({ withdrawalRequestId: ID, database: db, fetchImpl, apiKey: "unit-test-key", baseUrl: "https://evil.example/v2" }),
    (error) => error.code === "PI_API_BASE_NOT_ALLOWED"
  );
  assert.equal(fetchImpl.calls.length, 0);
});
