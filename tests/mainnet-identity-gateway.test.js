"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// The gateway's Express router is replaced with a tiny route registry so this
// security-contract suite can run without opening a network port. Production
// continues to use the installed Express package in server.js.
const originalModuleLoad = Module._load;
const expressTestDouble = {
  Router() {
    return {
      routes: new Map(),
      post(path, handler) {
        this.routes.set(path, handler);
        return this;
      }
    };
  }
};

Module._load = function (request, parent, isMain) {
  if (request === "express") return expressTestDouble;
  return originalModuleLoad.call(this, request, parent, isMain);
};

let createMainnetIdentityGatewayRouter;
try {
  ({ createMainnetIdentityGatewayRouter } = require("../src/mainnet-identity-gateway"));
} finally {
  Module._load = originalModuleLoad;
}

const ALBUKHR_USER_ID = "8dfbd7b2-43a1-4fd6-86e4-cd3b159cfcab";

async function invokeRoute(router, route, options = {}) {
  const handler = router.routes.get(route);
  assert.equal(typeof handler, "function", `Expected route handler for ${route}`);

  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };

  const request = {
    headers: options.headers || {},
    body: options.body || {}
  };

  await handler(request, response);
  return response;
}

function makeDatabase(result = { data: ALBUKHR_USER_ID, error: null }) {
  const calls = [];
  return {
    calls,
    supabase: {
      async rpc(name, params) {
        calls.push({ name, params });
        return result;
      }
    }
  };
}

function makePiError(status, code, retryAfter) {
  const error = new Error("private upstream message must not reach the client");
  error.status = status;
  error.code = code;
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

function bearer(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

test("missing bearer token is rejected and identity is not written", async () => {
  const database = makeDatabase();
  const router = createMainnetIdentityGatewayRouter({
    getPioneer: async () => {
      throw new Error("Pi lookup must not run without a bearer token");
    },
    supabase: database.supabase
  });

  const response = await invokeRoute(router, "/login");

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, "PI_TOKEN_REQUIRED");
  assert.match(response.body.error, /token is required/i);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(database.calls.length, 0);
});

test("invalid Pi token remains a 401 and does not create an ALBUKHR user", async () => {
  const database = makeDatabase();
  const router = createMainnetIdentityGatewayRouter({
    getPioneer: async () => {
      throw makePiError(401, "PI_TOKEN_INVALID");
    },
    supabase: database.supabase
  });

  const response = await invokeRoute(router, "/login", {
    headers: bearer("invalid")
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, "PI_TOKEN_INVALID");
  assert.match(response.body.error, /invalid or has expired/i);
  assert.equal(database.calls.length, 0);
});

test("Pi identity service outage is reported as 503, not invalid credentials", async () => {
  const database = makeDatabase();
  const router = createMainnetIdentityGatewayRouter({
    getPioneer: async () => {
      throw makePiError(503, "PI_API_UNAVAILABLE");
    },
    supabase: database.supabase
  });

  const response = await invokeRoute(router, "/login", {
    headers: bearer("valid-token")
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "PI_API_UNAVAILABLE");
  assert.match(response.body.error, /temporarily unavailable/i);
  assert.equal(database.calls.length, 0);
});

test("Pi timeout is reported as 504 and does not write an identity", async () => {
  const database = makeDatabase();
  const router = createMainnetIdentityGatewayRouter({
    getPioneer: async () => {
      throw makePiError(504, "PI_API_TIMEOUT");
    },
    supabase: database.supabase
  });

  const response = await invokeRoute(router, "/login", {
    headers: bearer("valid-token")
  });

  assert.equal(response.statusCode, 504);
  assert.equal(response.body.code, "PI_API_TIMEOUT");
  assert.match(response.body.error, /timed out/i);
  assert.equal(database.calls.length, 0);
});

test("Pi rate limiting stays retryable and exposes a safe Retry-After header", async () => {
  const database = makeDatabase();
  const router = createMainnetIdentityGatewayRouter({
    getPioneer: async () => {
      throw makePiError(503, "PI_API_RATE_LIMITED", "19");
    },
    supabase: database.supabase
  });

  const response = await invokeRoute(router, "/login", {
    headers: bearer("valid-token")
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "PI_API_RATE_LIMITED");
  assert.equal(response.headers["retry-after"], "19");
  assert.equal(database.calls.length, 0);
});

test("unexpected Pi verification failure is reported as 502, not 401", async () => {
  const database = makeDatabase();
  const router = createMainnetIdentityGatewayRouter({
    getPioneer: async () => {
      throw new Error("unexpected internal error");
    },
    supabase: database.supabase
  });

  const response = await invokeRoute(router, "/login", {
    headers: bearer("valid-token")
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, "PI_VERIFICATION_FAILED");
  assert.doesNotMatch(response.body.error, /unexpected internal error/i);
  assert.equal(database.calls.length, 0);
});

test("login uses only Pi-verified identity and hard-locks the record to Mainnet", async () => {
  const database = makeDatabase();
  const router = createMainnetIdentityGatewayRouter({
    getPioneer: async (token) => {
      assert.equal(token, "valid-pi-token");
      return {
        uid: "pi-server-verified-uid",
        username: "verified-pioneer"
      };
    },
    supabase: database.supabase
  });

  const response = await invokeRoute(router, "/login", {
    headers: bearer("valid-pi-token"),
    body: {
      p_pi_uid: "attacker-controlled-uid",
      p_username: "attacker-controlled-name",
      p_network: "testnet",
      p_status: "failed",
      wallet_address: "attacker-controlled-wallet"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.network, "mainnet");
  assert.equal(response.body.user_id, ALBUKHR_USER_ID);
  assert.equal(response.body.pi_uid, "pi-server-verified-uid");
  assert.equal(response.body.username, "verified-pioneer");
  assert.equal(response.headers["cache-control"], "no-store");

  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].name, "record_pi_login");
  assert.deepEqual(database.calls[0].params, {
    p_pi_uid: "pi-server-verified-uid",
    p_username: "verified-pioneer",
    p_wallet_address: null,
    p_network: "mainnet",
    p_status: "success"
  });
});

test("login-failure records only the Pi-verified UID with failed status", async () => {
  const database = makeDatabase({ data: null, error: null });
  const router = createMainnetIdentityGatewayRouter({
    getPioneer: async () => ({
      uid: "verified-pi-uid",
      username: "verified-pioneer"
    }),
    supabase: database.supabase
  });

  const response = await invokeRoute(router, "/login-failure", {
    headers: bearer("valid-pi-token"),
    body: { pi_uid: "forged-uid", network: "testnet" }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.network, "mainnet");
  assert.equal(response.body.recorded, true);
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].params.p_pi_uid, "verified-pi-uid");
  assert.equal(database.calls[0].params.p_network, "mainnet");
  assert.equal(database.calls[0].params.p_status, "failed");
});

test("Supabase identity write failure returns a safe 502 response", async () => {
  const database = makeDatabase({
    data: null,
    error: { code: "XX000", message: "private database detail" }
  });
  const router = createMainnetIdentityGatewayRouter({
    getPioneer: async () => ({
      uid: "verified-pi-uid",
      username: "verified-pioneer"
    }),
    supabase: database.supabase
  });

  const response = await invokeRoute(router, "/login", {
    headers: bearer("valid-pi-token")
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, "MAINNET_IDENTITY_WRITE_FAILED");
  assert.match(response.body.error, /could not be recorded/i);
  assert.doesNotMatch(response.body.error, /private database detail/i);
  assert.equal(database.calls.length, 1);
});

test("a Pi verification response without UID is rejected before any database write", async () => {
  const database = makeDatabase();
  const router = createMainnetIdentityGatewayRouter({
    getPioneer: async () => ({ username: "missing-uid" }),
    supabase: database.supabase
  });

  const response = await invokeRoute(router, "/login", {
    headers: bearer("valid-pi-token")
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, "PI_IDENTITY_UID_MISSING");
  assert.equal(database.calls.length, 0);
});
