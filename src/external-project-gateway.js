/* ALBUKHR API — External Project Trusted Gateway v1
 * Mainnet-only additive migration layer.
 *
 * Trust boundary:
 *   Browser -> Pi access token -> Pi /v2/me -> verified pi_uid
 *   -> existing applicant RPCs
 *
 * IMPORTANT:
 * - This gateway never accepts p_pi_uid from the browser.
 * - The existing applicant RPCs are intentionally reused during migration.
 * - Direct PUBLIC/anon EXECUTE on those RPCs must remain until all callers
 *   have migrated and cross-user validation is complete; revocation is a
 *   separate final step.
 */
"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const { getPioneer } = require("./pi-client");

const router = express.Router();
const MAINNET = "mainnet";

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

  if (!token) {
    throw httpError(401, "Pi authentication token is required.");
  }

  return token;
}

async function verifiedPiIdentity(req) {
  const token = requireBearer(req);

  let pioneer;

  try {
    pioneer = await getPioneer(token);
  } catch (error) {
    console.error("[ALBUKHR EXTERNAL PROJECT GATEWAY] Pi verification failed:", {
      status: error?.status || null,
      message: error?.message || null
    });

    throw httpError(401, "Pi identity verification failed.");
  }

  const piUid = clean(pioneer?.uid);

  if (!piUid) {
    throw httpError(401, "Pi identity verification failed.");
  }

  return Object.freeze({
    pi_uid: piUid,
    username: clean(pioneer?.username) || null,
    network: MAINNET
  });
}

function uuid(value, field = "application_id") {
  const normalized = clean(value);

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized
    )
  ) {
    throw httpError(400, `${field} is invalid.`);
  }

  return normalized;
}

function body(req) {
  return req.body &&
    typeof req.body === "object" &&
    !Array.isArray(req.body)
    ? req.body
    : {};
}

function pickBody(input, allowed) {
  const output = {};

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      output[key] = input[key];
    }
  }

  return output;
}

async function callRpc(functionName, args) {
  const { data, error } = await supabase.rpc(functionName, args);

  if (error) {
    console.error(
      `[ALBUKHR EXTERNAL PROJECT GATEWAY] RPC ${functionName} failed`,
      {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      }
    );

    throw httpError(502, "ALBUKHR external project database operation failed.");
  }

  return data;
}

function respond(handler) {
  return async (req, res) => {
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

      console.error(
        "[ALBUKHR EXTERNAL PROJECT GATEWAY] Request failed:",
        {
          code: error?.code || null,
          message: error?.message || null,
          details: error?.details || null
        }
      );

      return res.status(502).json({
        success: false,
        network: MAINNET,
        error: "External project operation failed."
      });
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Policy acknowledgment                                                      */
/* -------------------------------------------------------------------------- */

router.post(
  "/policy/acknowledgment",
  respond(async (_req, identity) =>
    callRpc("gateway_record_external_project_policy_acknowledgment", {
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

/* -------------------------------------------------------------------------- */
/* Application collection                                                     */
/* -------------------------------------------------------------------------- */

router.get(
  "/applications",
  respond(async (_req, identity) =>
    callRpc("get_my_external_project_applications", {
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

router.post(
  "/",
  respond(async (req, identity) => {
    const allowed = [
      "p_project_name",
      "p_business_name",
      "p_country",
      "p_contact_email",
      "p_project_code",
      "p_project_slug",
      "p_project_description",
      "p_business_registration_number",
      "p_industry",
      "p_category",
      "p_state",
      "p_city",
      "p_business_address",
      "p_website",
      "p_contact_phone",
      "p_pi_wallet",
      "p_funding_required",
      "p_funding_asset",
      "p_investment_model",
      "p_project_duration_days"
    ];

    const args = pickBody(body(req), allowed);
    args.p_pi_uid = identity.pi_uid;
    args.p_network = MAINNET;

    return callRpc(
      "create_my_external_project_application",
      args
    );
  })
);

/* -------------------------------------------------------------------------- */
/* Application item                                                           */
/* -------------------------------------------------------------------------- */

router.get(
  "/:applicationId",
  respond(async (req, identity) =>
    callRpc("get_my_external_project_detail", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

router.patch(
  "/:applicationId",
  respond(async (req, identity) => {
    const allowed = [
      "p_project_name",
      "p_business_name",
      "p_country",
      "p_contact_email",
      "p_project_code",
      "p_project_slug",
      "p_project_description",
      "p_business_registration_number",
      "p_industry",
      "p_category",
      "p_state",
      "p_city",
      "p_business_address",
      "p_website",
      "p_contact_phone",
      "p_pi_wallet",
      "p_funding_required",
      "p_funding_asset",
      "p_investment_model",
      "p_project_duration_days"
    ];

    const args = pickBody(body(req), allowed);
    args.p_application_id = uuid(req.params.applicationId);
    args.p_pi_uid = identity.pi_uid;
    args.p_network = MAINNET;

    return callRpc(
      "update_my_external_project_application",
      args
    );
  })
);

router.post(
  "/:applicationId/submit",
  respond(async (req, identity) =>
    callRpc("submit_my_external_project_application", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

/* -------------------------------------------------------------------------- */
/* Team                                                                        */
/* -------------------------------------------------------------------------- */

router.get(
  "/:applicationId/team",
  respond(async (req, identity) =>
    callRpc("get_my_external_project_team", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

router.put(
  "/:applicationId/team",
  respond(async (req, identity) =>
    callRpc("replace_my_external_project_team", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET,
      p_team: body(req).p_team
    })
  )
);

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

router.get(
  "/:applicationId/documents",
  respond(async (req, identity) =>
    callRpc("get_my_external_project_documents", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

router.post(
  "/:applicationId/documents/upload-target",
  respond(async (req, identity) => {
    const input = body(req);

    return callRpc("create_my_external_project_document_upload_target", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET,
      p_document_type: input.p_document_type,
      p_document_name: input.p_document_name
    });
  })
);

router.post(
  "/:applicationId/documents",
  respond(async (req, identity) => {
    const input = body(req);

    return callRpc("register_my_external_project_document", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET,
      p_document_type: input.p_document_type,
      p_document_name: input.p_document_name,
      p_storage_bucket: input.p_storage_bucket,
      p_storage_path: input.p_storage_path,
      p_document_url: input.p_document_url ?? null
    });
  })
);

router.delete(
  "/:applicationId/documents/:documentId",
  respond(async (req, identity) =>
    callRpc("delete_my_external_project_document", {
      p_document_id: uuid(req.params.documentId, "document_id"),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

/* -------------------------------------------------------------------------- */
/* Reviews / audit                                                             */
/* -------------------------------------------------------------------------- */

router.get(
  "/:applicationId/reviews",
  respond(async (req, identity) =>
    callRpc("get_my_external_project_reviews", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

router.get(
  "/:applicationId/review-history",
  respond(async (req, identity) =>
    callRpc("get_my_external_project_review_history", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

router.get(
  "/:applicationId/audit-log",
  respond(async (req, identity) =>
    callRpc("get_my_external_project_audit_log", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

module.exports = { externalProjectGatewayRouter: router };
