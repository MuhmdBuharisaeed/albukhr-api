"use strict";

const EXPECTED_HOST = "albukhr-api.onrender.com";
const EXPECTED_PATH = "/api/project-updates/internal/cleanup-expired-uploads";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 90_000;

function cleanupError(code, message, status = null) {
  const error = new Error(message);
  error.code = code;
  if (status != null) error.status = status;
  return error;
}

function parseLimit(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_LIMIT;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_LIMIT) {
    throw cleanupError("CLEANUP_LIMIT_INVALID", `CLEANUP_BATCH_LIMIT must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return number;
}

function buildCleanupConfig(env = process.env) {
  const endpoint = String(env.PROJECT_UPDATES_CLEANUP_URL || "").trim();
  const key = String(env.PROJECT_UPDATES_CLEANUP_KEY || "").trim();

  if (!endpoint) {
    throw cleanupError("CLEANUP_URL_MISSING", "PROJECT_UPDATES_CLEANUP_URL is required.");
  }
  if (!key || Buffer.byteLength(key, "utf8") < 32) {
    throw cleanupError("CLEANUP_KEY_MISSING", "PROJECT_UPDATES_CLEANUP_KEY must contain at least 32 UTF-8 bytes.");
  }

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (_) {
    throw cleanupError("CLEANUP_URL_INVALID", "PROJECT_UPDATES_CLEANUP_URL is not a valid URL.");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== EXPECTED_HOST ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== EXPECTED_PATH ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw cleanupError(
      "CLEANUP_URL_NOT_ALLOWED",
      `Cleanup URL must be the HTTPS Mainnet endpoint on ${EXPECTED_HOST}${EXPECTED_PATH}.`
    );
  }

  const timeoutMs = env.PROJECT_UPDATES_CLEANUP_TIMEOUT_MS == null
    ? DEFAULT_TIMEOUT_MS
    : Number(env.PROJECT_UPDATES_CLEANUP_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw cleanupError("CLEANUP_TIMEOUT_INVALID", "PROJECT_UPDATES_CLEANUP_TIMEOUT_MS must be from 1000 to 120000.");
  }

  return Object.freeze({
    endpoint: parsed.toString(),
    key,
    limit: parseLimit(env.CLEANUP_BATCH_LIMIT),
    timeoutMs
  });
}

async function runProjectUpdatesCleanup(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const config = buildCleanupConfig(env);

  if (typeof fetchImpl !== "function") {
    throw cleanupError("CLEANUP_FETCH_UNAVAILABLE", "This Node.js runtime does not provide fetch().");
  }

  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-updates-cleanup-key": config.key
      },
      body: JSON.stringify({ limit: config.limit }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    throw cleanupError(
      "CLEANUP_REQUEST_FAILED",
      error && error.name === "TimeoutError"
        ? "Project Updates cleanup request timed out."
        : "Project Updates cleanup request could not reach the Mainnet API."
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    throw cleanupError("CLEANUP_RESPONSE_INVALID", "Project Updates cleanup API returned invalid JSON.", response.status);
  }

  if (!response.ok) {
    throw cleanupError(
      "CLEANUP_HTTP_ERROR",
      `Project Updates cleanup API returned HTTP ${response.status}.`,
      response.status
    );
  }

  if (!payload || payload.success !== true || payload.network !== "mainnet" || !payload.data || typeof payload.data !== "object") {
    throw cleanupError("CLEANUP_RESPONSE_INVALID", "Project Updates cleanup API did not confirm a successful Mainnet cleanup.", response.status);
  }

  const summary = payload.data;
  for (const field of ["claimed", "deleted_or_missing", "protected", "retry"]) {
    if (!Number.isInteger(summary[field]) || summary[field] < 0) {
      throw cleanupError("CLEANUP_SUMMARY_INVALID", `Cleanup summary field ${field} is invalid.`, response.status);
    }
  }
  if (summary.deleted_or_missing + summary.protected + summary.retry !== summary.claimed) {
    throw cleanupError("CLEANUP_SUMMARY_INCONSISTENT", "Cleanup summary counts do not reconcile.", response.status);
  }

  return Object.freeze({
    network: "mainnet",
    claimed: summary.claimed,
    deleted_or_missing: summary.deleted_or_missing,
    protected: summary.protected,
    retry: summary.retry
  });
}

module.exports = {
  EXPECTED_HOST,
  EXPECTED_PATH,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildCleanupConfig,
  runProjectUpdatesCleanup
};
