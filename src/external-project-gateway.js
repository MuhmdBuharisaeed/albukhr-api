const express = require("express");
const crypto = require("crypto");
const { supabase } = require("./supabase-client");
const { getPioneer } = require("./pi-client");

const router = express.Router();

const MAINNET = "mainnet";

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireBearer(req) {
  const value = String(req.headers.authorization || "").trim();
  if (!value.toLowerCase().startsWith("bearer ")) {
    throw httpError(401, "Pi authentication token is required.");
  }
  const token = value.slice(7).trim();
  if (!token) throw httpError(401, "Pi authentication token is required.");
  return token;
}

async function verifiedPiIdentity(req) {
  const token = requireBearer(req);
  const pioneer = await getPioneer(token);
  const piUid = String(pioneer.uid || "").trim();
  if (!piUid) throw httpError(401, "Pi identity could not be verified.");

  // Identity is derived ONLY from Pi /v2/me.
  // Never accept p_pi_uid from the browser.
  return Object.freeze({
    pi_uid: piUid,
    username: String(pioneer.username || "").trim() || null,
    wallet_address: String(
      pioneer.wallet_address || pioneer.wallet?.address || ""
    ).trim() || null,
    network: MAINNET
  });
}

async function callRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    console.error(`[ALBUKHR API] RPC ${name} failed`, {
      code: error.code,
      message: error.message
    });
    throw httpError(502, "ALBUKHR database operation failed.");
  }
  return data;
}

function uuid(value, field = "application_id") {
  const v = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) {
    throw httpError(400, `${field} is invalid.`);
  }
  return v;
}

function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
}

function route(handler) {
  return async (req, res) => {
    try {
      const identity = await verifiedPiIdentity(req);
      const result = await handler(req, identity);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error("[ALBUKHR API] External gateway error", error);
      res.status(status).json({
        success: false,
        error: status >= 500 ? "External project operation failed." : error.message
      });
    }
  };
}

/*
 * GET /api/external-project/applications
 */
router.get("/applications", route(async (_req, identity) =>
  callRpc("get_my_external_project_applications", {
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET
  })
));

/*
 * GET /api/external-project/:applicationId
 */
router.get("/:applicationId", route(async (req, identity) =>
  callRpc("get_my_external_project_detail", {
    p_application_id: uuid(req.params.applicationId),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET
  })
));

router.get("/:applicationId/team", route(async (req, identity) =>
  callRpc("get_my_external_project_team", {
    p_application_id: uuid(req.params.applicationId),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET
  })
));

router.get("/:applicationId/documents", route(async (req, identity) =>
  callRpc("get_my_external_project_documents", {
    p_application_id: uuid(req.params.applicationId),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET
  })
));

router.get("/:applicationId/reviews", route(async (req, identity) =>
  callRpc("get_my_external_project_reviews", {
    p_application_id: uuid(req.params.applicationId),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET
  })
));

router.get("/:applicationId/review-history", route(async (req, identity) =>
  callRpc("get_my_external_project_review_history", {
    p_application_id: uuid(req.params.applicationId),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET
  })
));

router.get("/:applicationId/audit-log", route(async (req, identity) =>
  callRpc("get_my_external_project_audit_log", {
    p_application_id: uuid(req.params.applicationId),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET
  })
));

router.post("/", route(async (req, identity) => {
  const b = body(req);
  const allowed = [
    "p_project_name","p_business_name","p_country","p_contact_email",
    "p_project_code","p_project_slug","p_project_description",
    "p_business_registration_number","p_industry","p_category","p_state",
    "p_city","p_business_address","p_website","p_contact_phone","p_pi_wallet",
    "p_funding_required","p_funding_asset","p_investment_model",
    "p_project_duration_days"
  ];
  const args = { p_pi_uid: identity.pi_uid, p_network: MAINNET };
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(b, key)) args[key] = b[key];
  return callRpc("create_my_external_project_application", args);
}));

router.patch("/:applicationId", route(async (req, identity) => {
  const b = body(req);
  const allowed = [
    "p_project_name","p_business_name","p_country","p_contact_email",
    "p_project_code","p_project_slug","p_project_description",
    "p_business_registration_number","p_industry","p_category","p_state",
    "p_city","p_business_address","p_website","p_contact_phone","p_pi_wallet",
    "p_funding_required","p_funding_asset","p_investment_model",
    "p_project_duration_days"
  ];
  const args = {
    p_application_id: uuid(req.params.applicationId),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET
  };
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(b, key)) args[key] = b[key];
  return callRpc("update_my_external_project_application", args);
}));

router.post("/:applicationId/submit", route(async (req, identity) =>
  callRpc("submit_my_external_project_application", {
    p_application_id: uuid(req.params.applicationId),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET
  })
));

router.post("/:applicationId/documents", route(async (req, identity) => {
  const b = body(req);
  return callRpc("register_my_external_project_document", {
    p_application_id: uuid(req.params.applicationId),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET,
    p_document_type: b.p_document_type,
    p_document_name: b.p_document_name,
    p_storage_bucket: b.p_storage_bucket,
    p_storage_path: b.p_storage_path,
    p_document_url: b.p_document_url
  });
}));

router.delete("/:applicationId/documents/:documentId", route(async (req, identity) =>
  callRpc("delete_my_external_project_document", {
    p_document_id: uuid(req.params.documentId, "document_id"),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET
  })
));

router.put("/:applicationId/team", route(async (req, identity) =>
  callRpc("replace_my_external_project_team", {
    p_application_id: uuid(req.params.applicationId),
    p_pi_uid: identity.pi_uid,
    p_network: MAINNET,
    p_team: body(req).p_team
  })
));

module.exports = { externalProjectGatewayRouter: router };
