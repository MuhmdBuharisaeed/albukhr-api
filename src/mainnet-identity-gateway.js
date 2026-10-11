/*
 * ALBUKHR Mainnet Identity Gateway v1
 *
 * Purpose:
 * - Verify the Pi access token server-side through Pi Platform /v2/me.
 * - Record successful login only in the Mainnet Supabase project.
 * - Hard-code the network to "mainnet"; never accept network from a client.
 *
 * Additive migration only. Existing frontend callers continue to use the
 * existing RPC until the frontend migration is completed separately.
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
  if (!token) {
    throw httpError(401, "Pi authentication token is required.");
  }
  return token;
}

router.post("/login", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");

  try {
    const token = requireBearer(req);
    let pioneer;

    try {
      pioneer = await getPioneer(token);
    } catch (error) {
      // Do not log access tokens or raw upstream responses.
      console.warn("[MAINNET IDENTITY] Pi token verification failed.", {
        status: error?.status || null,
        message: error?.message || null
      });
      throw httpError(401, "Pi identity verification failed.");
    }

    const piUid = clean(pioneer?.uid);
    const username = clean(pioneer?.username) || null;

    if (!piUid) {
      throw httpError(401, "Pi identity verification failed.");
    }

    // Network is intentionally fixed here; never trust req.body.network.
    const { data, error } = await supabase.rpc("record_pi_login", {
      p_pi_uid: piUid,
      p_username: username,
      p_wallet_address: null,
      p_network: MAINNET,
      p_status: "success"
    });

    if (error) {
      console.error("[MAINNET IDENTITY] record_pi_login failed.", {
        code: error.code || null,
        message: error.message || null
      });
      throw httpError(502, "Mainnet login could not be recorded.");
    }

    const userId = clean(data);
    if (!userId) {
      throw httpError(502, "Mainnet login returned no ALBUKHR user ID.");
    }

    return res.status(200).json({
      success: true,
      network: MAINNET,
      user_id: userId,
      pi_uid: piUid,
      username
    });
  } catch (error) {
    const status = Number(error?.status);
    const safeStatus = status >= 400 && status < 500 ? status :
      (status === 502 ? 502 : 500);

    if (safeStatus >= 500) {
      console.error("[MAINNET IDENTITY] Login request failed.", {
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
          ? "Mainnet login could not be completed."
          : "Mainnet identity service is unavailable."
    });
  }
});

module.exports = {
  mainnetIdentityGatewayRouter: router
};
