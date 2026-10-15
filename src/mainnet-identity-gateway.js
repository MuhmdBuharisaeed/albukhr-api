/*
 * ALBUKHR Mainnet Identity Gateway v1.1
 *
 * Mainnet-only trusted identity endpoints.
 * - Verify the Pi access token through Pi Platform /v2/me.
 * - Derive UID and username only from Pi's verified response.
 * - Never accept client-provided UID or network as identity proof.
 * - Use the server-side Supabase service role; never expose it to the browser.
 */
"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const { getPioneer } = require("./pi-client");

const router = express.Router();
const MAINNET = "mainnet";

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireBearer(req) {
  const authorization = clean(req.headers.authorization);
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    throw httpError(401, "Pi authentication token is required.");
  }
  const token = authorization.slice(7).trim();
  if (!token) throw httpError(401, "Pi authentication token is required.");
  return token;
}

async function getVerifiedPiIdentity(req) {
  const token = requireBearer(req);
  let pioneer;
  try {
    pioneer = await getPioneer(token);
  } catch (error) {
    // Never log the access token or the full upstream response.
    console.warn("[MAINNET IDENTITY] Pi token verification failed.", {
      status: error?.status || null,
      message: error?.message || null
    });
    throw httpError(401, "Pi identity verification failed.");
  }

  const piUid = clean(pioneer?.uid);
  if (!piUid) throw httpError(401, "Pi identity verification failed.");

  return {
    pi_uid: piUid,
    username: clean(pioneer?.username) || null
  };
}

async function recordLogin(identity, status) {
  const { data, error } = await supabase.rpc("record_pi_login", {
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
      message: error.message || null,
      status
    });
    throw httpError(502, "Mainnet login could not be recorded.");
  }
  return data;
}

function sendError(res, error, label) {
  const status = Number(error?.status);
  const safeStatus = status >= 400 && status < 500 ? status :
    (status === 502 ? 502 : 500);

  if (safeStatus >= 500) {
    console.error(`[MAINNET IDENTITY] ${label} failed.`, {
      status: safeStatus,
      message: error?.message || null
    });
  }

  return res.status(safeStatus).json({
    success: false,
    network: MAINNET,
    error: safeStatus === 401
      ? error.message
      : safeStatus === 502
        ? "Mainnet identity could not be recorded."
        : "Mainnet identity service is unavailable."
  });
}

function noStore(res) {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
}

router.post("/login", async (req, res) => {
  noStore(res);
  try {
    const identity = await getVerifiedPiIdentity(req);
    const userId = await recordLogin(identity, "success");
    const normalizedUserId = clean(userId);
    if (!normalizedUserId) throw httpError(502, "Mainnet login returned no ALBUKHR user ID.");

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
    // client-supplied UID. This route records a failure only when a valid Pi
    // token exists but the ALBUKHR login operation subsequently fails.
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

module.exports = {
  mainnetIdentityGatewayRouter: router
};
