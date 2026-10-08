/* ALBUKHR API — External Project Trusted Gateway v1
 * Mainnet-only additive migration layer.
 *
 * Trust boundary:
 *   Browser -> Pi access token -> Pi /v2/me -> verified pi_uid
 *   -> existing applicant RPCs
 *
 * Project logo path:
 *   Browser -> trusted gateway -> verified Pi UID
 *   -> ownership/status validation -> service-role storage upload
 *   -> service-role logo RPC attachment
 *
 * IMPORTANT:
 * - This gateway never accepts p_pi_uid from the browser.
 * - The existing applicant RPCs are intentionally reused during migration.
 * - Project logo bytes are never uploaded directly from the browser to Supabase.
 */
"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const { getPioneer } = require("./pi-client");

const router = express.Router();

const MAINNET = "mainnet";
const DOCUMENT_BUCKET = "external-project-documents";
const PROJECT_LOGO_BUCKET = "project-logos";
const PROJECT_LOGO_MAX = 1048576;
const PROJECT_LOGO_PREFIX = "external-applications/";

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

function firstRow(data) {
  return Array.isArray(data) ? data[0] || null : data || null;
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

function normalizeLogoContentType(value) {
  const type = clean(value).split(";")[0].toLowerCase();

  if (!["image/png", "image/jpeg"].includes(type)) {
    throw httpError(415, "Project logo must be PNG or JPG/JPEG.");
  }

  return type;
}

function inspectPng(buffer) {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    )
  ) {
    throw httpError(415, "The uploaded file is not a valid PNG image.");
  }

  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw httpError(415, "The uploaded PNG image is malformed.");
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  return { width, height, format: "png" };
}

function inspectJpeg(buffer) {
  if (
    buffer.length < 4 ||
    buffer[0] !== 0xff ||
    buffer[1] !== 0xd8
  ) {
    throw httpError(415, "The uploaded file is not a valid JPEG image.");
  }

  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf
  ]);

  let offset = 2;

  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= buffer.length) break;

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }

    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }

    if (offset + 2 > buffer.length) break;

    const segmentLength = buffer.readUInt16BE(offset);

    if (
      segmentLength < 2 ||
      offset + segmentLength > buffer.length
    ) {
      throw httpError(415, "The uploaded JPEG image is malformed.");
    }

    if (sofMarkers.has(marker)) {
      if (segmentLength < 7) {
        throw httpError(415, "The uploaded JPEG image is malformed.");
      }

      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);

      return { width, height, format: "jpg" };
    }

    offset += segmentLength;
  }

  throw httpError(415, "The uploaded JPEG image dimensions could not be verified.");
}

function inspectProjectLogo(buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) {
    throw httpError(400, "Project logo image data is missing.");
  }

  if (buffer.length <= 0) {
    throw httpError(400, "The selected project logo is empty.");
  }

  if (buffer.length > PROJECT_LOGO_MAX) {
    throw httpError(413, "Project logo must be no larger than 1 MB.");
  }

  const mime = normalizeLogoContentType(contentType);

  const metadata =
    mime === "image/png"
      ? inspectPng(buffer)
      : inspectJpeg(buffer);

  if (
    metadata.width < 400 ||
    metadata.height < 400
  ) {
    throw httpError(
      400,
      "Project logo must be at least 400 x 400 pixels."
    );
  }

  return {
    mime,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    size_bytes: buffer.length
  };
}

function logoPath(applicationId) {
  return PROJECT_LOGO_PREFIX + applicationId + "/logo";
}

async function backupExistingLogo(path) {
  try {
    const { data, error } = await supabase.storage
      .from(PROJECT_LOGO_BUCKET)
      .download(path);

    if (error || !data) {
      return null;
    }

    const buffer = Buffer.from(await data.arrayBuffer());

    return {
      buffer,
      contentType: clean(data.type) || "image/jpeg"
    };
  } catch (error) {
    console.warn(
      "[ALBUKHR EXTERNAL PROJECT GATEWAY] Existing logo backup failed; upload will continue without rollback buffer.",
      {
        path,
        message: error?.message || null
      }
    );

    return null;
  }
}

async function restoreExistingLogo(path, previous) {
  if (!previous) {
    const { error } = await supabase.storage
      .from(PROJECT_LOGO_BUCKET)
      .remove([path]);

    if (error) {
      console.error(
        "[ALBUKHR EXTERNAL PROJECT GATEWAY] Logo rollback removal failed",
        {
          path,
          message: error.message
        }
      );
    }

    return;
  }

  const { error } = await supabase.storage
    .from(PROJECT_LOGO_BUCKET)
    .upload(
      path,
      previous.buffer,
      {
        upsert: true,
        contentType: previous.contentType,
        cacheControl: "3600"
      }
    );

  if (error) {
    console.error(
      "[ALBUKHR EXTERNAL PROJECT GATEWAY] Existing logo restoration failed",
      {
        path,
        message: error.message,
        details: error.details
      }
    );
  }
}

async function removePrivateDocumentObject(storageBucket, storagePath) {
  const bucket = clean(storageBucket);
  const path = clean(storagePath);

  if (bucket !== DOCUMENT_BUCKET) {
    throw httpError(502, "The stored document bucket is invalid.");
  }

  if (!path || !path.startsWith(MAINNET + "/")) {
    throw httpError(502, "The stored document path is invalid.");
  }

  const { error } = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .remove([path]);

  if (error) {
    console.error(
      "[ALBUKHR EXTERNAL PROJECT GATEWAY] Private document storage removal failed",
      {
        bucket: DOCUMENT_BUCKET,
        path,
        message: error.message,
        details: error.details,
        hint: error.hint
      }
    );

    throw httpError(502, "The document record was changed but its private file could not be removed.");
  }
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
/* Project logo                                                               */
/* -------------------------------------------------------------------------- */

router.get(
  "/:applicationId/logo",
  respond(async (req, identity) =>
    callRpc("get_my_external_project_logo", {
      p_application_id: uuid(req.params.applicationId),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    })
  )
);

router.post(
  "/:applicationId/logo",
  respond(async (req, identity) => {
    const applicationId = uuid(req.params.applicationId);
    const path = logoPath(applicationId);
    const contentType = normalizeLogoContentType(req.headers["content-type"]);
    const image = inspectProjectLogo(req.body, contentType);

    // Authorize the application before touching public project-logo storage.
    const applicationData = await callRpc(
      "get_my_external_project_detail",
      {
        p_application_id: applicationId,
        p_pi_uid: identity.pi_uid,
        p_network: MAINNET
      }
    );

    const application = firstRow(applicationData);

    if (!application) {
      throw httpError(404, "Application not found or access denied.");
    }

    if (!["draft", "needs_revision"].includes(clean(application.status).toLowerCase())) {
      throw httpError(
        409,
        "Project logo can only be changed while the application is a draft or needs revision."
      );
    }

    const previous = await backupExistingLogo(path);

    const { error: uploadError } = await supabase.storage
      .from(PROJECT_LOGO_BUCKET)
      .upload(
        path,
        req.body,
        {
          upsert: true,
          contentType: image.mime,
          cacheControl: "3600"
        }
      );

    if (uploadError) {
      console.error(
        "[ALBUKHR EXTERNAL PROJECT GATEWAY] Project logo storage upload failed",
        {
          bucket: PROJECT_LOGO_BUCKET,
          path,
          message: uploadError.message,
          details: uploadError.details,
          hint: uploadError.hint
        }
      );

      throw httpError(502, "Project logo storage upload failed.");
    }

    const publicUrl =
      supabase.storage
        .from(PROJECT_LOGO_BUCKET)
        .getPublicUrl(path)
        .data
        .publicUrl;

    try {
      const attached = await callRpc(
        "gateway_attach_my_external_project_logo",
        {
          p_application_id: applicationId,
          p_pi_uid: identity.pi_uid,
          p_network: MAINNET,
          p_logo_url: publicUrl,
          p_logo_path: path,
          p_logo_width: image.width,
          p_logo_height: image.height,
          p_logo_format: image.format,
          p_logo_size_bytes: image.size_bytes
        }
      );

      const result = firstRow(attached);

      if (result && result.success === false) {
        throw httpError(
          409,
          result.message || "Project logo registration was not accepted."
        );
      }

      if (!result || result.success !== true) {
        throw httpError(
          502,
          "Project logo registration returned an invalid result."
        );
      }

      return result;
    } catch (error) {
      await restoreExistingLogo(path, previous);
      throw error;
    }
  })
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
  respond(async (req, identity) => {
    const deleted = await callRpc("delete_my_external_project_document", {
      p_document_id: uuid(req.params.documentId, "document_id"),
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    });

    const record = Array.isArray(deleted) ? deleted[0] : deleted;

    if (!record?.storage_bucket || !record?.storage_path) {
      throw httpError(502, "The document deletion record was incomplete.");
    }

    await removePrivateDocumentObject(
      record.storage_bucket,
      record.storage_path
    );

    return {
      deleted: true,
      document_id: uuid(req.params.documentId, "document_id"),
      storage_deleted: true
    };
  })
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
