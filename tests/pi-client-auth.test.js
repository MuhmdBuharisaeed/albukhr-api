"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPioneer } = require("../src/pi-client");

function makeResponse(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      }
    },
    async text() {
      if (typeof payload === "string") return payload;
      return payload == null ? "" : JSON.stringify(payload);
    }
  };
}

test("getPioneer verifies the bearer token using Pi /v2/me", async () => {
  let requestedUrl = null;
  let requestOptions = null;

  const pioneer = await getPioneer("pi-user-token", {
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestOptions = options;
      return makeResponse(200, {
        uid: "verified-pi-uid",
        username: "verified-pioneer"
      });
    }
  });

  assert.equal(requestedUrl, "https://api.minepi.com/v2/me");
  assert.equal(requestOptions.method, "GET");
  assert.equal(requestOptions.headers.Authorization, "Bearer pi-user-token");
  assert.equal(requestOptions.headers.Accept, "application/json");
  assert.equal(pioneer.uid, "verified-pi-uid");
  assert.equal(pioneer.username, "verified-pioneer");
});

test("getPioneer rejects a missing token without making a network request", async () => {
  let calls = 0;

  await assert.rejects(
    getPioneer("  ", {
      fetchImpl: async () => {
        calls += 1;
        return makeResponse(200, { uid: "should-not-be-read" });
      }
    }),
    (error) => error.status === 401 && error.code === "PI_TOKEN_REQUIRED"
  );

  assert.equal(calls, 0);
});

test("Pi HTTP 401 is reported as an invalid/expired Pioneer token", async () => {
  await assert.rejects(
    getPioneer("bad-token", {
      fetchImpl: async () => makeResponse(401, { error: "unauthorized" })
    }),
    (error) => error.status === 401 && error.code === "PI_TOKEN_INVALID"
  );
});

test("Pi HTTP 429 is reported as a temporary service limit with Retry-After", async () => {
  await assert.rejects(
    getPioneer("valid-token", {
      fetchImpl: async () => makeResponse(
        429,
        { error: "rate limited" },
        { "retry-after": "23" }
      )
    }),
    (error) => error.status === 503 &&
      error.code === "PI_API_RATE_LIMITED" &&
      error.retryAfter === "23"
  );
});

test("Pi HTTP 5xx is not misreported as an invalid Pioneer token", async () => {
  await assert.rejects(
    getPioneer("valid-token", {
      fetchImpl: async () => makeResponse(503, { error: "temporarily unavailable" })
    }),
    (error) => error.status === 503 && error.code === "PI_API_UNAVAILABLE"
  );
});

test("unexpected Pi 4xx responses are treated as upstream service errors", async () => {
  await assert.rejects(
    getPioneer("valid-token", {
      fetchImpl: async () => makeResponse(403, { error: "forbidden" })
    }),
    (error) => error.status === 502 && error.code === "PI_API_REJECTED_REQUEST"
  );
});

test("a successful but malformed Pi response is rejected as an upstream error", async () => {
  await assert.rejects(
    getPioneer("valid-token", {
      fetchImpl: async () => makeResponse(200, { username: "no-uid" })
    }),
    (error) => error.status === 502 && error.code === "PI_API_INVALID_RESPONSE"
  );
});

test("invalid JSON from a successful Pi response is rejected", async () => {
  await assert.rejects(
    getPioneer("valid-token", {
      fetchImpl: async () => makeResponse(200, "not-json")
    }),
    (error) => error.status === 502 && error.code === "PI_API_INVALID_RESPONSE"
  );
});

test("network errors are reported as temporary Pi service failures", async () => {
  await assert.rejects(
    getPioneer("valid-token", {
      fetchImpl: async () => {
        throw new TypeError("simulated network failure");
      }
    }),
    (error) => error.status === 503 && error.code === "PI_API_UNAVAILABLE"
  );
});

test("Pi /v2/me timeout aborts the request and returns HTTP 504 classification", async () => {
  let abortObserved = false;

  await assert.rejects(
    getPioneer("valid-token", {
      timeoutMs: 10,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          abortObserved = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })
    }),
    (error) => error.status === 504 && error.code === "PI_API_TIMEOUT"
  );

  assert.equal(abortObserved, true);
});

test("the timeout also covers a slow Pi response body", async () => {
  let abortObserved = false;

  await assert.rejects(
    getPioneer("valid-token", {
      timeoutMs: 10,
      fetchImpl: async (_url, options) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            abortObserved = true;
            const error = new Error("body read aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        })
      })
    }),
    (error) => error.status === 504 && error.code === "PI_API_TIMEOUT"
  );

  assert.equal(abortObserved, true);
});
