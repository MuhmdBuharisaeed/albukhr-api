/* ALBUKHR API — Contributor Pi Gateway v1.0.0 */
"use strict";

const express = require("express");

const { getPioneer } = require("./pi-client");
const { supabase } = require("./supabase-client");

const router = express.Router();

const MAINNET = "mainnet";
const MAX_INVITATION_TOKEN_LENGTH = 1024;
const MAX_POLICY_VERSION_LENGTH = 64;
const MAX_PRIVACY_VERSION_LENGTH = 64;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
}

function cleanRequired(value, field, maxLength) {
  const normalized = String(value ?? "").trim();

  if (!normalized || normalized.length > maxLength) {
    throw httpError(400, `${field} is invalid.`);
  }

  return normalized;
}

function requireBearer(req) {
  const authorization = String(req.headers.authorization || "").trim();

  if (!authorization.toLowerCase().startsWith("bearer ")) {
    throw httpError(401, "Pi authentication token is required.");
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    throw httpError(401, "Pi authentication token is required.");
  }

  return token;
}

async function verifyPiIdentity(req) {
  const token = requireBearer(req);
  let pioneer;

  try {
    pioneer = await getPioneer(token);
  } catch (error) {
    console.error("[ALBUKHR CONTRIBUTOR GATEWAY] Pi verification failed:", {
      status: error?.status,
      message: error?.message
    });

    throw httpError(401, "Pi identity verification failed.");
  }

  const piUid = String(pioneer?.uid || "").trim();

  if (!piUid) {
    throw httpError(401, "Pi identity verification failed.");
  }

  return Object.freeze({
    pi_uid: piUid,
    username: pioneer?.username
      ? String(pioneer.username).trim()
      : null
  });
}

async function callGatewayRpc(functionName, params) {
  const response = await supabase
    .schema("albukhr_security")
    .rpc(functionName, params);

  if (response?.error) {
    const error = new Error(
      response.error.message || `Gateway RPC ${functionName} failed.`
    );

    error.code = response.error.code;
    error.details = response.error.details;
    error.hint = response.error.hint;

    throw error;
  }

  return response?.data;
}

function sendGatewayError(res, error, fallbackMessage) {
  const requestedStatus = Number(error?.status);

  if (requestedStatus >= 400 && requestedStatus < 500) {
    return res.status(requestedStatus).json({
      success: false,
      network: MAINNET,
      error: error.message
    });
  }

  console.error("[ALBUKHR CONTRIBUTOR GATEWAY] Request failed:", {
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint
  });

  return res.status(502).json({
    success: false,
    network: MAINNET,
    error: fallbackMessage
  });
}

router.post("/api/contributor/bootstrap", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const invitationToken = cleanRequired(
      body(req).invitation_token ?? body(req).p_invitation_token,
      "invitation_token",
      MAX_INVITATION_TOKEN_LENGTH
    );

    const data = await callGatewayRpc("gateway_get_contributor_onboarding", {
      p_pi_uid: identity.pi_uid,
      p_invitation_token: invitationToken
    });

    return res.status(200).json({
      success: true,
      network: MAINNET,
      data
    });
  } catch (error) {
    const status = Number(error?.status);

    if (status >= 400 && status < 500) {
      return sendGatewayError(
        res,
        error,
        "Contributor onboarding could not be initialized."
      );
    }

    return sendGatewayError(
      res,
      error,
      "Contributor onboarding service is temporarily unavailable."
    );
  }
});

router.post("/api/contributor/consent", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const requestBody = body(req);

    const invitationToken = cleanRequired(
      requestBody.invitation_token ?? requestBody.p_invitation_token,
      "invitation_token",
      MAX_INVITATION_TOKEN_LENGTH
    );

    const policyVersion = cleanRequired(
      requestBody.policy_version ?? requestBody.p_policy_version,
      "policy_version",
      MAX_POLICY_VERSION_LENGTH
    );

    const privacyVersion = cleanRequired(
      requestBody.privacy_version ?? requestBody.p_privacy_version,
      "privacy_version",
      MAX_PRIVACY_VERSION_LENGTH
    );

    const data = await callGatewayRpc(
      "gateway_record_contributor_policy_consent",
      {
        p_pi_uid: identity.pi_uid,
        p_invitation_token: invitationToken,
        p_policy_version: policyVersion,
        p_privacy_version: privacyVersion
      }
    );

    return res.status(200).json({
      success: true,
      network: MAINNET,
      data
    });
  } catch (error) {
    const status = Number(error?.status);

    if (status >= 400 && status < 500) {
      return sendGatewayError(
        res,
        error,
        "Contributor policy consent could not be recorded."
      );
    }

    return sendGatewayError(
      res,
      error,
      "Contributor consent service is temporarily unavailable."
    );
  }
});

router.post("/api/contributor/accept", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const invitationToken = cleanRequired(
      body(req).invitation_token ?? body(req).p_invitation_token,
      "invitation_token",
      MAX_INVITATION_TOKEN_LENGTH
    );

    const data = await callGatewayRpc(
      "gateway_accept_contributor_invitation",
      {
        p_pi_uid: identity.pi_uid,
        p_invitation_token: invitationToken
      }
    );

    return res.status(201).json({
      success: true,
      network: MAINNET,
      data
    });
  } catch (error) {
    const status = Number(error?.status);

    if (status >= 400 && status < 500) {
      return sendGatewayError(
        res,
        error,
        "Contributor invitation could not be accepted."
      );
    }

    return sendGatewayError(
      res,
      error,
      "Contributor activation service is temporarily unavailable."
    );
  }
});

module.exports = {
  contributorGatewayRouter: router
};
