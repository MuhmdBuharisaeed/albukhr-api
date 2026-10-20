"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const { getPioneer } = require("./pi-client");
const { buildWalletSnapshot, MAINNET } = require("./wallet-balance-service");

const router = express.Router();

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function requireBearer(req) {
  const header = String(req.headers.authorization || "").trim();
  if (!/^bearer\s+/i.test(header)) throw httpError(401, "Pi authentication token is required.", "PI_AUTH_REQUIRED");
  const token = header.replace(/^bearer\s+/i, "").trim();
  if (!token) throw httpError(401, "Pi authentication token is required.", "PI_AUTH_REQUIRED");
  return token;
}

async function verifiedPiIdentity(req) {
  try {
    const pioneer = await getPioneer(requireBearer(req));
    const piUid = String(pioneer?.uid || "").trim();
    if (!piUid) throw new Error("Missing Pi UID.");
    return { pi_uid: piUid };
  } catch (error) {
    if (error?.status === 401) throw httpError(401, "Pi identity could not be verified.", "PI_AUTH_INVALID");
    if (error?.status === 403) throw httpError(401, "Pi identity could not be verified.", "PI_AUTH_INVALID");
    throw httpError(401, "Pi identity could not be verified.", "PI_AUTH_INVALID");
  }
}

/*
 * Additive, read-only Mainnet Wallet snapshot.
 * It deliberately reuses the existing service-role RPCs and does not create
 * payments, withdrawal requests, ledger rows, or schema changes.
 */
router.get("/api/my-wallet", async (req, res) => {
  res.set("Cache-Control", "no-store, private, max-age=0");
  res.set("Pragma", "no-cache");

  try {
    const identity = await verifiedPiIdentity(req);
    const requestedNetwork = String(req.query.network || MAINNET).trim().toLowerCase();
    if (requestedNetwork !== MAINNET) {
      throw httpError(403, "Only Mainnet Wallet data is available on this API.", "MAINNET_ONLY");
    }

    const [stakesResult, withdrawalsResult, userResult] = await Promise.all([
      supabase.rpc("get_my_stakes", {
        p_pi_uid: identity.pi_uid,
        p_network: MAINNET
      }),
      supabase.rpc("get_my_withdrawal_requests", {
        p_pi_uid: identity.pi_uid,
        p_network: MAINNET
      }),
      supabase.from("users")
        .select("wallet_address")
        .eq("pi_uid", identity.pi_uid)
        .eq("network", MAINNET)
        .maybeSingle()
    ]);

    if (stakesResult.error || withdrawalsResult.error || userResult.error) {
      console.error("[ALBUKHR API] Wallet source read failed", {
        stakes_code: stakesResult.error?.code,
        withdrawals_code: withdrawalsResult.error?.code,
        user_code: userResult.error?.code
      });
      throw httpError(502, "Wallet data could not be loaded safely.", "WALLET_SOURCE_READ_FAILED");
    }

    const stakeRows = Array.isArray(stakesResult.data) ? stakesResult.data : [];
    const withdrawalRows = Array.isArray(withdrawalsResult.data) ? withdrawalsResult.data : [];

    // Defence in depth: the current RPCs already filter by authenticated UID
    // and Mainnet. Fail closed if their returned rows ever violate that contract.
    if (stakeRows.some((row) => String(row?.pi_uid ?? "") !== identity.pi_uid) ||
        withdrawalRows.some((row) => String(row?.pi_uid ?? "") !== identity.pi_uid)) {
      throw httpError(502, "Wallet source ownership verification failed.", "WALLET_SOURCE_OWNERSHIP_FAILED");
    }

    const snapshot = buildWalletSnapshot({
      stakes: stakeRows,
      withdrawals: withdrawalRows,
      registeredWalletAddress: userResult.data?.wallet_address || null,
      asOf: new Date().toISOString()
    });

    return res.status(200).json({ success: true, data: snapshot });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) {
      console.error("[ALBUKHR API] Wallet snapshot failed", {
        code: error?.code,
        message: error?.message
      });
    }
    return res.status(status).json({
      success: false,
      code: error?.code || (status >= 500 ? "WALLET_READ_FAILED" : "WALLET_REQUEST_INVALID"),
      error: status >= 500 ? "Wallet data is temporarily unavailable." : error.message
    });
  }
});

module.exports = { walletGatewayRouter: router };
