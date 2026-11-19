/* ALBUKHR API — External Project Owner Funding Gateway
 * Mainnet-only trusted gateway.
 *
 * Browser -> Pi access token -> Pi /v2/me -> verified pi_uid
 * -> service-role-only RPCs -> canonical public.users identity
 * -> external_project_applications.applicant_user_id
 * -> projects.owner_albukhr_user_id (when converted)
 *
 * The browser never supplies the authoritative Pi UID, network, or owner ID.
 */
"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const { getPioneer } = require("./pi-client");

const router = express.Router();
const MAINNET = "mainnet";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clean(value) {
  return String(value ?? "").trim();
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

async function verifiedPiIdentity(req) {
  let pioneer;
  try {
    pioneer = await getPioneer(requireBearer(req));
  } catch (error) {
    console.warn("[EXTERNAL FUNDING GATEWAY] Pi token verification failed.", {
      status: error?.status || null,
      message: error?.message || null
    });
    throw httpError(401, "Pi identity verification failed.");
  }

  const piUid = clean(pioneer?.uid);
  if (!piUid) throw httpError(401, "Pi identity verification failed.");

  return Object.freeze({
    pi_uid: piUid,
    network: MAINNET
  });
}

function applicationId(value) {
  const normalized = clean(value);
  if (!UUID_PATTERN.test(normalized)) {
    throw httpError(400, "Application ID is invalid.");
  }
  return normalized;
}

function requestBody(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
}

function fundingInput(input) {
  const fieldMap = {
    business_stage: "p_business_stage",
    funding_model: "p_funding_model",
    funding_purpose: "p_funding_purpose",
    declared_existing_asset_base: "p_declared_existing_asset_base",
    declared_existing_liquidity: "p_declared_existing_liquidity",
    funding_window_start: "p_funding_window_start",
    funding_window_end: "p_funding_window_end",
    operating_cycle_days: "p_operating_cycle_days",
    expected_capital_cycle_days: "p_expected_capital_cycle_days",
    required_reserve: "p_required_reserve",
    contingency_reserve: "p_contingency_reserve",
    notes: "p_notes",
    items: "p_items"
  };
  const result = {};
  for (const [clientKey, rpcKey] of Object.entries(fieldMap)) {
    if (Object.prototype.hasOwnProperty.call(input, clientKey)) {
      result[rpcKey] = input[clientKey];
    }
  }
  return result;
}

function rpcFailureStatus(error) {
  switch (String(error?.code || "")) {
    case "42501": return 403;
    case "22023": return 400;
    case "55000": return 409;
    case "P0002": return 404;
    default: return 502;
  }
}

async function callTrustedRpc(functionName, args) {
  const { data, error } = await supabase.rpc(functionName, args);
  if (error) {
    const status = rpcFailureStatus(error);
    console.error(`[EXTERNAL FUNDING GATEWAY] ${functionName} failed.`, {
      code: error.code || null,
      message: error.message || null,
      details: error.details || null
    });
    throw httpError(
      status,
      status >= 500 ? "External Project funding database operation failed." :
        (error.message || "External Project funding request was rejected.")
    );
  }

  const result = Array.isArray(data) ? (data[0] || null) : data;
  if (!result || typeof result !== "object") {
    throw httpError(502, "External Project funding service returned an invalid response.");
  }
  if (result.success === false) {
    throw httpError(409, result.message || "External Project funding request was rejected.");
  }
  return result;
}

function noStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function respond(handler) {
  return async (req, res) => {
    noStore(res);
    try {
      const identity = await verifiedPiIdentity(req);
      const data = await handler(req, identity);
      return res.status(200).json({
        success: true,
        network: MAINNET,
        data
      });
    } catch (error) {
      const status = Number(error?.status);
      if (status >= 400 && status < 500) {
        return res.status(status).json({
          success: false,
          network: MAINNET,
          error: error.message
        });
      }

      console.error("[EXTERNAL FUNDING GATEWAY] Request failed.", {
        status: status || null,
        message: error?.message || null
      });
      return res.status(502).json({
        success: false,
        network: MAINNET,
        error: "External Project funding operation failed."
      });
    }
  };
}

router.get(
  "/:applicationId/funding-plan",
  respond(async (req, identity) => {
    return callTrustedRpc("gateway_get_my_external_funding_plan_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId(req.params.applicationId)
    });
  })
);

router.post(
  "/:applicationId/funding-plan",
  respond(async (req, identity) => {
    const payload = fundingInput(requestBody(req));
    return callTrustedRpc("gateway_save_my_external_funding_plan_trusted", {
      p_pi_uid: identity.pi_uid,
      p_application_id: applicationId(req.params.applicationId),
      ...payload
    });
  })
);

router.post(
  "/:applicationId/funding-plan/submit",
  respond(async () => {
    throw httpError(
      409,
      "Funding submission is temporarily locked until the Owner step-up verification required by the current AAL2 policy is integrated. Draft saving remains available."
    );
  })
);

module.exports = { externalProjectFundingGatewayRouter: router };
