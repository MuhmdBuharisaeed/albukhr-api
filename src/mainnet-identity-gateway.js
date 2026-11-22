/*
 * ALBUKHR Mainnet Identity Gateway v1.2
 *
 * Mainnet-only trusted identity endpoints.
 * - Verify the Pi access token through Pi Platform /v2/me.
 * - Derive UID and username only from Pi's verified response.
 * - Never accept client-provided UID or network as identity proof.
 * - Use the server-side Supabase service role; never expose it to the browser.
 * - Preserve Pi API outage and timeout states instead of misreporting them as
 *   invalid user credentials.
 * - Return non-cacheable identity responses.
 */
"use strict";

const express = require("express");
const { getPioneer } = require("./pi-client");

const MAINNET = "mainnet";

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(status, message, code, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code || "MAINNET_IDENTITY_ERROR";

  if (extra.retryAfter) {
    error.retryAfter = extra.retryAfter;
  }

  return error;
}

function requireBearer(req) {
  const authorization = clean(req.headers.authorization);
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    throw httpError(
      401,
      "Pi authentication token is required.",
      "PI_TOKEN_REQUIRED"
    );
  }

  const token = authorization.slice(7).trim();
  if (!token) {
    throw httpError(
      401,
      "Pi authentication token is required.",
      "PI_TOKEN_REQUIRED"
    );
  }

  return token;
}

function mapPiVerificationError(error) {
  const upstreamStatus = Number(error?.status);

  if (upstreamStatus === 401) {
    return httpError(
      401,
      "Pi access token is invalid or has expired. Please sign in again.",
      "PI_TOKEN_INVALID"
    );
  }

  if (upstreamStatus === 504) {
    return httpError(
      504,
      "Pi identity verification timed out. Please try again.",
      "PI_API_TIMEOUT"
    );
  }

  if (upstreamStatus === 503) {
    return httpError(
      503,
      "Pi identity service is temporarily unavailable. Please try again.",
      clean(error?.code) || "PI_API_UNAVAILABLE",
      { retryAfter: error?.retryAfter }
    );
  }

  return httpError(
    502,
    "Pi identity verification could not be completed. Please try again.",
    "PI_VERIFICATION_FAILED"
  );
}

function getSupabase(dependencies) {
  if (dependencies.supabase && typeof dependencies.supabase.rpc === "function") {
    return dependencies.supabase;
  }

  // Resolve the production service-role client only when a request needs it.
  // This also keeps the router factory straightforward to test with an
  // explicitly injected database double.
  return require("./supabase-client").supabase;
}

function createMainnetIdentityGatewayRouter(dependencies = {}) {
  const router = express.Router();
  const pioneerLookup = typeof dependencies.getPioneer === "function"
    ? dependencies.getPioneer
    : getPioneer;

  async function getVerifiedPiIdentity(req) {
    const token = requireBearer(req);
    let pioneer;

    try {
      pioneer = await pioneerLookup(token);
    } catch (error) {
      // Never log the access token, raw response body, or Pioneer profile.
      console.warn("[MAINNET IDENTITY] Pi token verification did not complete.", {
        status: Number(error?.status) || null,
        code: clean(error?.code) || null
      });
      throw mapPiVerificationError(error);
    }

    const piUid = clean(pioneer?.uid);
    if (!piUid) {
      throw httpError(
        502,
        "Pi identity verification returned no valid Pioneer UID.",
        "PI_IDENTITY_UID_MISSING"
      );
    }

    return {
      pi_uid: piUid,
      username: clean(pioneer?.username) || null
    };
  }

  async function recordLogin(identity, status) {
    const database = getSupabase(dependencies);
    const { data, error } = await database.rpc("record_pi_login", {
      p_pi_uid: identity.pi_uid,
      p_username: identity.username,
      // Do not trust a browser-supplied wallet address. A NULL value preserves
      // any existing wallet_address because the SQL upsert uses COALESCE.
      p_wallet_address: null,
      p_network: MAINNET,
      p_status: status
    });

    if (error) {
      console.error("[MAINNET IDENTITY] record_pi_login failed.", {
        code: error.code || null,
        status
      });
      throw httpError(
        502,
        "Mainnet identity could not be recorded.",
        "MAINNET_IDENTITY_WRITE_FAILED"
      );
    }

    return data;
  }

  function publicErrorMessage(error, status) {
    if (status === 401) {
      return clean(error?.message) || "Pi authentication is required.";
    }

    if (status === 502 && error?.code === "MAINNET_IDENTITY_WRITE_FAILED") {
      return "Mainnet identity could not be recorded. Please try again.";
    }

    if (status === 502) {
      return "Pi identity verification could not be completed. Please try again.";
    }

    if (status === 503) {
      return "Pi identity service is temporarily unavailable. Please try again.";
    }

    if (status === 504) {
      return "Pi identity verification timed out. Please try again.";
    }

    return "Mainnet identity service is unavailable.";
  }

  function sendError(res, error, label) {
    const requestedStatus = Number(error?.status);
    const safeStatus = [401, 502, 503, 504].includes(requestedStatus)
      ? requestedStatus
      : 500;
    const code = /^[A-Z0-9_]{2,64}$/.test(clean(error?.code))
      ? clean(error.code)
      : "MAINNET_IDENTITY_SERVICE_ERROR";

    if (safeStatus >= 500) {
      console.error(`[MAINNET IDENTITY] ${label} failed.`, {
        status: safeStatus,
        code
      });
    }

    const retryAfter = normalizeRetryAfter(error?.retryAfter);
    if (safeStatus === 503 && retryAfter) {
      res.set("Retry-After", retryAfter);
    }

    return res.status(safeStatus).json({
      success: false,
      network: MAINNET,
      code,
      error: publicErrorMessage(error, safeStatus)
    });
  }

  function noStore(res) {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
  }

  function normalizeRetryAfter(value) {
    const raw = clean(value);
    if (!/^\d+$/.test(raw)) return null;
    return String(Math.min(3600, Math.max(1, Number(raw))));
  }

  router.post("/login", async (req, res) => {
    noStore(res);

    try {
      // The browser's UID, username, network, and wallet fields are ignored.
      // Pi's verified /me response is the only identity authority here.
      const identity = await getVerifiedPiIdentity(req);
      const userId = await recordLogin(identity, "success");
      const normalizedUserId = clean(userId);

      if (!normalizedUserId) {
        throw httpError(
          502,
          "Mainnet login returned no ALBUKHR user ID.",
          "MAINNET_USER_ID_MISSING"
        );
      }

      return res.status(200).json({
        success: true,
        network: MAINNET,
        user_id: normalizedUserId,
        pi_uid: identity.pi_uid,
        username: identity.username
      });
    } catch (error) {
      return sendError(res, error, "Login request");
    }
  });

  router.post("/login-failure", async (req, res) => {
    noStore(res);

    try {
      // Even failure events are keyed to a server-verified Pi UID, never a
      // client-supplied UID. A failed or expired Pi token is not written as a
      // verified identity event.
      const identity = await getVerifiedPiIdentity(req);
      await recordLogin(identity, "failed");

      return res.status(200).json({
        success: true,
        network: MAINNET,
        recorded: true
      });
    } catch (error) {
      return sendError(res, error, "Failed-login event recording");
    }
  });

  return router;
}

const mainnetIdentityGatewayRouter = createMainnetIdentityGatewayRouter();

module.exports = {
  mainnetIdentityGatewayRouter,
  createMainnetIdentityGatewayRouter
};
