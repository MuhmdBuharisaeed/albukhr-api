"use strict";

const express = require("express");
const { getPioneer } = require("./pi-client");
const { supabase } = require("./supabase-client");

const contributorGatewayRouter = express.Router();

function extractBearerToken(req) {
  const header = String(req.headers.authorization || "").trim();

  if (!header.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = header.slice(7).trim();

  return token || null;
}

async function requirePiIdentity(req, res, next) {
  const token = extractBearerToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Pi authentication is required."
    });
  }

  try {
    const pioneer = await getPioneer(token);

    const piUid = String(pioneer?.uid || "").trim();

    if (!piUid) {
      return res.status(401).json({
        success: false,
        error: "Pi identity verification failed."
      });
    }

    req.albukhrPi = Object.freeze({
      pi_uid: piUid,
      username: pioneer?.username
        ? String(pioneer.username).trim()
        : null
    });

    next();
  } catch (error) {
    console.error(
      "[ALBUKHR CONTRIBUTOR GATEWAY] Pi verification failed:",
      error
    );

    return res.status(401).json({
      success: false,
      error: "Pi identity verification failed."
    });
  }
}

async function callGatewayRpc(functionName, params) {
  const response = await supabase
    .schema("albukhr_security")
    .rpc(functionName, params);

  if (response?.error) {
    throw new Error(
      response.error.message ||
      `Gateway RPC ${functionName} failed.`
    );
  }

  return response?.data;
}

function requireInvitationToken(req, res) {
  const invitationToken = String(
    req.body?.invitation_token ??
    req.body?.p_invitation_token ??
    ""
  ).trim();

  if (!invitationToken) {
    res.status(400).json({
      success: false,
      error: "Contributor invitation token is required."
    });

    return null;
  }

  return invitationToken;
}


/* =========================================================
   BOOTSTRAP
========================================================= */

contributorGatewayRouter.post(
  "/contributor/bootstrap",
  requirePiIdentity,
  async (req, res) => {

    const invitationToken =
      requireInvitationToken(req, res);

    if (!invitationToken) return;

    try {

      const data =
        await callGatewayRpc(
          "gateway_get_contributor_onboarding",
          {
            p_pi_uid:
              req.albukhrPi.pi_uid,

            p_invitation_token:
              invitationToken
          }
        );

      return res
        .status(data?.success === true ? 200 : 400)
        .json({
          success: data?.success === true,
          data
        });

    } catch (error) {

      console.error(
        "[ALBUKHR CONTRIBUTOR GATEWAY] bootstrap failed:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Contributor onboarding bootstrap failed."
      });
    }
  }
);


/* =========================================================
   POLICY CONSENT
========================================================= */

contributorGatewayRouter.post(
  "/contributor/consent",
  requirePiIdentity,
  async (req, res) => {

    const invitationToken =
      requireInvitationToken(req, res);

    if (!invitationToken) return;

    const policyVersion =
      String(
        req.body?.policy_version ??
        req.body?.p_policy_version ??
        ""
      ).trim();

    const privacyVersion =
      String(
        req.body?.privacy_version ??
        req.body?.p_privacy_version ??
        ""
      ).trim();

    if (!policyVersion || !privacyVersion) {
      return res.status(400).json({
        success: false,
        error:
          "Current Contributor policy and privacy versions are required."
      });
    }

    try {

      const data =
        await callGatewayRpc(
          "gateway_record_contributor_policy_consent",
          {
            p_pi_uid:
              req.albukhrPi.pi_uid,

            p_invitation_token:
              invitationToken,

            p_policy_version:
              policyVersion,

            p_privacy_version:
              privacyVersion
          }
        );

      return res
        .status(data?.success === true ? 200 : 400)
        .json({
          success: data?.success === true,
          data
        });

    } catch (error) {

      console.error(
        "[ALBUKHR CONTRIBUTOR GATEWAY] consent failed:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Contributor policy acceptance failed."
      });
    }
  }
);


/* =========================================================
   CONTRIBUTOR ACTIVATION
========================================================= */

contributorGatewayRouter.post(
  "/contributor/accept",
  requirePiIdentity,
  async (req, res) => {

    const invitationToken =
      requireInvitationToken(req, res);

    if (!invitationToken) return;

    try {

      const data =
        await callGatewayRpc(
          "gateway_accept_contributor_invitation",
          {
            p_pi_uid:
              req.albukhrPi.pi_uid,

            p_invitation_token:
              invitationToken
          }
        );

      return res
        .status(data?.success === true ? 200 : 400)
        .json({
          success: data?.success === true,
          data
        });

    } catch (error) {

      console.error(
        "[ALBUKHR CONTRIBUTOR GATEWAY] acceptance failed:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Contributor activation failed."
      });
    }
  }
);


module.exports = {
  contributorGatewayRouter
};
