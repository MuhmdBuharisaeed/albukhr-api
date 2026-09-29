/* ALBUKHR API — Contributor Pi Gateway v2.0.0 */
"use strict";

const express = require("express");

const { getPioneer } = require("./pi-client");
const { supabase } = require("./supabase-client");

const router = express.Router();

const MAINNET = "mainnet";
const PROJECT_LOGO_BUCKET = "project-logos";
const MAX_INVITATION_TOKEN_LENGTH = 1024;
const MAX_POLICY_VERSION_LENGTH = 64;
const MAX_PRIVACY_VERSION_LENGTH = 64;
const MAX_PROJECT_ID_LENGTH = 64;
const MAX_PROJECT_CODE_LENGTH = 80;
const MAX_PROJECT_SLUG_LENGTH = 160;
const MAX_PROJECT_NAME_LENGTH = 160;
const MAX_PROJECT_DESCRIPTION_LENGTH = 5000;
const MAX_PROFILE_TEXT_LENGTH = 1000;
const MAX_PROFILE_SHORT_LENGTH = 120;
const MAX_PHONE_LENGTH = 32;
const MAX_PROFILE_AREAS = 5;
const MAX_LOGO_BYTES = 1048576;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function body(req) {
  return req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)
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

function optionalText(value, maxLength) {
  const normalized = String(value ?? "").trim();
  if (normalized.length > maxLength) {
    throw httpError(400, "Request field is too long.");
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
    username: pioneer?.username ? String(pioneer.username).trim() : null
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

function sendBusinessError(res, data, fallbackMessage, status = 400) {
  if (data?.success === false) {
    return res.status(status).json({
      success: false,
      network: MAINNET,
      error: data?.message || fallbackMessage,
      data
    });
  }

  return res.status(502).json({
    success: false,
    network: MAINNET,
    error: fallbackMessage
  });
}

function queryRequired(req, name, maxLength) {
  return cleanRequired(req.query?.[name], name, maxLength);
}

function queryOptional(req, name, maxLength) {
  const value = req.query?.[name];
  if (value == null || String(value).trim() === "") return null;
  return optionalText(value, maxLength);
}

function readJpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw httpError(400, "The selected JPEG image is invalid.");
  }

  let offset = 2;

  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf
  ]);

  while (offset + 3 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;

    if (offset + 1 >= buffer.length) break;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;

    if (sofMarkers.has(marker)) {
      if (segmentLength < 7 || offset + 7 >= buffer.length) break;

      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);

      if (width > 0 && height > 0) {
        return { width, height };
      }

      break;
    }

    offset += segmentLength;
  }

  throw httpError(400, "The selected JPEG image dimensions could not be verified.");
}

function readPngDimensions(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw httpError(400, "The selected PNG image is invalid.");
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  if (!width || !height) {
    throw httpError(400, "The selected PNG image dimensions are invalid.");
  }

  return { width, height };
}

function readImageDimensions(buffer, contentType) {
  if (contentType === "image/png") return readPngDimensions(buffer);
  if (contentType === "image/jpeg") return readJpegDimensions(buffer);
  throw httpError(400, "Project logo must be PNG or JPG/JPEG.");
}

function logoContentType(value) {
  const normalized = String(value || "").split(";", 1)[0].trim().toLowerCase();
  if (normalized !== "image/png" && normalized !== "image/jpeg") {
    throw httpError(400, "Project logo must be PNG or JPG/JPEG.");
  }
  return normalized;
}

function projectLogoFormat(contentType) {
  return contentType === "image/png" ? "png" : "jpeg";
}

/* -------------------------------------------------------------------------- */
/* Contributor workspace                                                      */
/* -------------------------------------------------------------------------- */

router.get("/api/contributor/workspace", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);

    const data = await callGatewayRpc("gateway_get_contributor_workspace", {
      p_pi_uid: identity.pi_uid
    });

    if (data?.success === false) {
      return res.status(403).json({
        success: false,
        network: MAINNET,
        error: data?.message || "Contributor access denied.",
        data
      });
    }

    return res.status(200).json({
      success: true,
      network: MAINNET,
      data
    });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) {
      return sendGatewayError(res, error, "Contributor workspace could not be loaded.");
    }

    return sendGatewayError(
      res,
      error,
      "Contributor workspace service is temporarily unavailable."
    );
  }
});

router.get("/api/contributor/profile", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);

    const data = await callGatewayRpc("gateway_get_contributor_profile", {
      p_pi_uid: identity.pi_uid
    });

    if (data?.success === false) {
      return res.status(403).json({
        success: false,
        network: MAINNET,
        error: data?.message || "Contributor access denied.",
        data
      });
    }

    return res.status(200).json({
      success: true,
      network: MAINNET,
      data
    });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) {
      return sendGatewayError(res, error, "Contributor profile could not be loaded.");
    }

    return sendGatewayError(
      res,
      error,
      "Contributor profile service is temporarily unavailable."
    );
  }
});

router.post("/api/contributor/profile", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const requestBody = body(req);

    const fullName = cleanRequired(requestBody.full_name, "full_name", MAX_PROFILE_SHORT_LENGTH);
    const countryCode = cleanRequired(requestBody.country_code, "country_code", 2).toUpperCase();
    const phone = optionalText(requestBody.phone, MAX_PHONE_LENGTH);
    const occupation = cleanRequired(requestBody.occupation, "occupation", MAX_PROFILE_SHORT_LENGTH);
    const primaryExpertise = cleanRequired(requestBody.primary_expertise, "primary_expertise", MAX_PROFILE_SHORT_LENGTH);
    const experienceSummary = cleanRequired(requestBody.experience_summary, "experience_summary", MAX_PROFILE_TEXT_LENGTH);
    const contributionStatement = cleanRequired(requestBody.contribution_statement, "contribution_statement", MAX_PROFILE_TEXT_LENGTH);
    const contributionAreas = Array.isArray(requestBody.contribution_areas)
      ? requestBody.contribution_areas.map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean).filter((value, index, array) => array.indexOf(value) === index)
      : [];
    const confirmInformation = requestBody.confirm_information === true;

    if (countryCode.length !== 2) throw httpError(400, "country_code is invalid.");
    if (contributionAreas.length < 1 || contributionAreas.length > MAX_PROFILE_AREAS) {
      throw httpError(400, "Select between 1 and 5 contribution areas.");
    }

    const data = await callGatewayRpc("gateway_save_my_contributor_profile", {
      p_pi_uid: identity.pi_uid,
      p_full_name: fullName,
      p_country_code: countryCode,
      p_phone: phone,
      p_occupation: occupation,
      p_primary_expertise: primaryExpertise,
      p_experience_summary: experienceSummary,
      p_contribution_areas: contributionAreas,
      p_contribution_statement: contributionStatement,
      p_confirm_information: confirmInformation
    });

    if (data?.success === false) {
      return sendBusinessError(res, data, "Contributor profile could not be saved.", 400);
    }

    return res.status(200).json({ success: true, network: MAINNET, data });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) {
      return sendGatewayError(res, error, "Contributor profile could not be saved.");
    }

    return sendGatewayError(
      res,
      error,
      "Contributor profile service is temporarily unavailable."
    );
  }
});

router.get("/api/contributor/community", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const network = String(req.query?.network || MAINNET).trim().toLowerCase();

    if (network !== MAINNET) {
      throw httpError(400, "Contributor community gateway is Mainnet only.");
    }

    const data = await callGatewayRpc("gateway_get_contributor_community_resources", {
      p_pi_uid: identity.pi_uid,
      p_network: MAINNET
    });

    if (data?.success === false) {
      return res.status(403).json({
        success: false,
        network: MAINNET,
        error: data?.message || "Contributor access denied.",
        data
      });
    }

    return res.status(200).json({ success: true, network: MAINNET, data });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) {
      return sendGatewayError(res, error, "Contributor community access could not be loaded.");
    }

    return sendGatewayError(
      res,
      error,
      "Contributor community service is temporarily unavailable."
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Contributor internal project                                               */
/* -------------------------------------------------------------------------- */

router.post("/api/contributor/project", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const requestBody = body(req);

    const projectCode = cleanRequired(requestBody.project_code, "project_code", MAX_PROJECT_CODE_LENGTH);
    const slug = cleanRequired(requestBody.slug, "slug", MAX_PROJECT_SLUG_LENGTH);
    const name = cleanRequired(requestBody.name, "name", MAX_PROJECT_NAME_LENGTH);
    const description = optionalText(requestBody.description, MAX_PROJECT_DESCRIPTION_LENGTH);

    const data = await callGatewayRpc("gateway_create_my_internal_project", {
      p_pi_uid: identity.pi_uid,
      p_project_code: projectCode,
      p_slug: slug,
      p_name: name,
      p_description: description
    });

    if (data?.success === false) return sendBusinessError(res, data, "Project creation failed.", 400);

    return res.status(201).json({ success: true, network: MAINNET, data });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) return sendGatewayError(res, error, "Project creation failed.");
    return sendGatewayError(res, error, "Contributor project service is temporarily unavailable.");
  }
});

router.post("/api/contributor/project/update", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const requestBody = body(req);

    const projectId = cleanRequired(requestBody.project_id, "project_id", MAX_PROJECT_ID_LENGTH);
    const slug = cleanRequired(requestBody.slug, "slug", MAX_PROJECT_SLUG_LENGTH);
    const name = cleanRequired(requestBody.name, "name", MAX_PROJECT_NAME_LENGTH);
    const description = optionalText(requestBody.description, MAX_PROJECT_DESCRIPTION_LENGTH);

    const data = await callGatewayRpc("gateway_update_my_internal_project", {
      p_pi_uid: identity.pi_uid,
      p_project_id: projectId,
      p_slug: slug,
      p_name: name,
      p_description: description
    });

    if (data?.success === false) return sendBusinessError(res, data, "Project update failed.", 400);

    return res.status(200).json({ success: true, network: MAINNET, data });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) return sendGatewayError(res, error, "Project update failed.");
    return sendGatewayError(res, error, "Contributor project service is temporarily unavailable.");
  }
});

/*
 * Project logo upload is intentionally terminated at this server boundary.
 * The browser sends the image bytes to ALBUKHR API; the API uploads to
 * Supabase Storage with the service role, derives the actual image dimensions,
 * then records authoritative metadata through a service-role-only DB RPC.
 */
router.post(
  "/api/contributor/project/logo",
  express.raw({
    type: ["image/png", "image/jpeg"],
    limit: "1mb"
  }),
  async (req, res) => {
    let uploadedPath = null;

    try {
      const identity = await verifyPiIdentity(req);
      const projectId = queryRequired(req, "project_id", MAX_PROJECT_ID_LENGTH);
      const contentType = logoContentType(req.headers["content-type"]);
      const file = req.body;

      if (!Buffer.isBuffer(file) || file.length <= 0) {
        throw httpError(400, "Project logo file is required.");
      }

      if (file.length > MAX_LOGO_BYTES) {
        throw httpError(400, "Project logo must be no larger than 1 MB.");
      }

      const dimensions = readImageDimensions(file, contentType);

      if (dimensions.width < 400 || dimensions.height < 400) {
        throw httpError(400, "Project logo must be at least 400 x 400 pixels.");
      }

      const workspace = await callGatewayRpc("gateway_get_contributor_workspace", {
        p_pi_uid: identity.pi_uid
      });

      if (!workspace?.success || workspace?.project?.id !== projectId) {
        return res.status(403).json({
          success: false,
          network: MAINNET,
          error: "Project ownership authorization denied."
        });
      }

      if (String(workspace.project.status || "").toLowerCase() !== "draft") {
        return res.status(409).json({
          success: false,
          network: MAINNET,
          error: "Project logo can only be changed while the project is a draft."
        });
      }

      const path = `projects/${projectId}/logo`;
      uploadedPath = path;

      const upload = await supabase.storage
        .from(PROJECT_LOGO_BUCKET)
        .upload(path, file, {
          cacheControl: "3600",
          contentType,
          upsert: true
        });

      if (upload?.error) {
        const storageError = new Error(upload.error.message || "Project logo upload failed.");
        storageError.code = upload.error.name || upload.error.statusCode;
        throw storageError;
      }

      const publicUrlResult = supabase.storage
        .from(PROJECT_LOGO_BUCKET)
        .getPublicUrl(path);

      const publicUrl = publicUrlResult?.data?.publicUrl || null;
      const format = projectLogoFormat(contentType);

      const data = await callGatewayRpc("gateway_attach_my_internal_project_logo", {
        p_pi_uid: identity.pi_uid,
        p_project_id: projectId,
        p_logo_url: publicUrl,
        p_logo_path: path,
        p_logo_width: dimensions.width,
        p_logo_height: dimensions.height,
        p_logo_format: format,
        p_logo_size_bytes: file.length
      });

      if (data?.success === false) {
        await supabase.storage.from(PROJECT_LOGO_BUCKET).remove([path]).catch(() => null);
        uploadedPath = null;
        return sendBusinessError(res, data, "Project logo metadata could not be recorded.", 400);
      }

      return res.status(200).json({ success: true, network: MAINNET, data });
    } catch (error) {
      if (uploadedPath) {
        await supabase.storage.from(PROJECT_LOGO_BUCKET).remove([uploadedPath]).catch(() => null);
      }

      const status = Number(error?.status);
      if (status >= 400 && status < 500) {
        return sendGatewayError(res, error, "Project logo upload failed.");
      }

      return sendGatewayError(
        res,
        error,
        "Contributor project logo service is temporarily unavailable."
      );
    }
  }
);

router.post("/api/contributor/project/submit", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const projectId = cleanRequired(body(req).project_id, "project_id", MAX_PROJECT_ID_LENGTH);

    const data = await callGatewayRpc("gateway_submit_my_internal_project", {
      p_pi_uid: identity.pi_uid,
      p_project_id: projectId
    });

    if (data?.success === false) return sendBusinessError(res, data, "Project submission failed.", 400);

    return res.status(200).json({ success: true, network: MAINNET, data });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) return sendGatewayError(res, error, "Project submission failed.");
    return sendGatewayError(res, error, "Contributor project service is temporarily unavailable.");
  }
});

router.get("/api/contributor/project/reviews", async (req, res) => {
  try {
    const identity = await verifyPiIdentity(req);
    const projectId = queryRequired(req, "project_id", MAX_PROJECT_ID_LENGTH);

    const data = await callGatewayRpc("gateway_get_my_contributor_project_reviews", {
      p_pi_uid: identity.pi_uid,
      p_project_id: projectId
    });

    if (data?.success === false) {
      return res.status(403).json({
        success: false,
        network: MAINNET,
        error: data?.message || "Contributor access denied.",
        data
      });
    }

    return res.status(200).json({ success: true, network: MAINNET, data });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) return sendGatewayError(res, error, "Project review history could not be loaded.");
    return sendGatewayError(res, error, "Contributor review service is temporarily unavailable.");
  }
});

/* -------------------------------------------------------------------------- */
/* Existing invitation onboarding routes                                      */
/* -------------------------------------------------------------------------- */

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

    return res.status(200).json({ success: true, network: MAINNET, data });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) {
      return sendGatewayError(res, error, "Contributor onboarding could not be initialized.");
    }
    return sendGatewayError(res, error, "Contributor onboarding service is temporarily unavailable.");
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

    const data = await callGatewayRpc("gateway_record_contributor_policy_consent", {
      p_pi_uid: identity.pi_uid,
      p_invitation_token: invitationToken,
      p_policy_version: policyVersion,
      p_privacy_version: privacyVersion
    });

    return res.status(200).json({ success: true, network: MAINNET, data });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) {
      return sendGatewayError(res, error, "Contributor policy consent could not be recorded.");
    }
    return sendGatewayError(res, error, "Contributor consent service is temporarily unavailable.");
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

    const data = await callGatewayRpc("gateway_accept_contributor_invitation", {
      p_pi_uid: identity.pi_uid,
      p_invitation_token: invitationToken
    });

    return res.status(201).json({ success: true, network: MAINNET, data });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) {
      return sendGatewayError(res, error, "Contributor invitation could not be accepted.");
    }
    return sendGatewayError(res, error, "Contributor activation service is temporarily unavailable.");
  }
});

module.exports = {
  contributorGatewayRouter: router
};
