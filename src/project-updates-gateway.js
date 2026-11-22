/* =====================================================================
 * ALBUKHR — Project Updates & Evidence Trusted Gateway
 * Mainnet only. Additive API module; no payment/treasury dependencies.
 *
 * Mount in server.js:
 *   app.use("/api/project-updates", projectUpdatesGatewayRouter);
 *
 * IMPORTANT:
 *   The trusted RPCs documented with this module must be deployed before
 *   enabling the router in production. This file deliberately fails closed
 *   when a required RPC/schema object is missing.
 * ===================================================================== */
"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { getPioneer } = require("./pi-client");

const {
  MAINNET,
  BUCKET,
  MAX_IMAGE_BYTES,
  UPLOAD_INTENT_TTL_MS,
  ALLOWED_REPORT_REASONS,
  ALLOWED_REPORT_DECISIONS,
  ALLOWED_CONTENT_ACTIONS,
  clean,
  httpError,
  requireUuid,
  rpcHttpStatus,
  validateImageMetadata,
  detectImageType,
  validateUpdatePayload,
  boundedText,
  boundedLimit
} = require("./project-updates-validation");

function normalizeRpcResult(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data == null ? null : data;
}

function createProjectUpdatesGatewayRouter(dependencies = {}) {
  const router = express.Router();
  const pioneerLookup = typeof dependencies.getPioneer === "function" ? dependencies.getPioneer : getPioneer;
  const clock = typeof dependencies.now === "function" ? dependencies.now : Date.now;
  const idFactory = typeof dependencies.randomUUID === "function" ? dependencies.randomUUID : crypto.randomUUID;

  function getDatabase() {
    if (dependencies.supabase && typeof dependencies.supabase.rpc === "function") {
      return dependencies.supabase;
    }
    return require("./supabase-client").supabase;
  }

  async function resolvePrincipal(req) {
    const token = requireBearer(req);
    const providerHint = clean(req.headers["x-albukhr-auth-provider"]).toLowerCase();
    const provider = providerHint || "pi";
    const db = getDatabase();

    // The header chooses the verification mechanism only. It is never treated
    // as identity proof; the selected provider validates the bearer itself.
    if (provider === "supabase" || provider === "supabase-auth") {
      let verified;
      try {
        verified = await db.auth.getUser(token);
      } catch (_) {
        throw httpError(503, "Sign-in verification is temporarily unavailable.", "AUTH_VERIFICATION_UNAVAILABLE");
      }
      const authUser = verified && verified.data && verified.data.user;
      if (verified?.error || !authUser?.id) {
        throw httpError(401, "The supplied sign-in token is invalid or expired.", "AUTH_TOKEN_INVALID");
      }

      let adminQuery;
      try {
        adminQuery = await db.schema("albukhr_security")
          .from("admin_users")
          .select("user_id,status")
          .eq("user_id", authUser.id)
          .eq("status", "active")
          .maybeSingle();
      } catch (_) {
        throw httpError(503, "Publisher identity could not be verified.", "ADMIN_IDENTITY_LOOKUP_FAILED");
      }
      if (adminQuery?.error) {
        throw httpError(503, "Publisher identity could not be verified.", "ADMIN_IDENTITY_LOOKUP_FAILED");
      }
      if (!adminQuery?.data) {
        throw httpError(403, "This account is not an active ALBUKHR project administrator.", "ADMIN_ACCESS_REQUIRED");
      }
      return Object.freeze({
        principal_type: "supabase_auth_user",
        principal_id: authUser.id,
        network: MAINNET
      });
    }

    if (provider !== "pi") {
      throw httpError(400, "Unsupported authentication provider.", "AUTH_PROVIDER_UNSUPPORTED");
    }

    let pioneer;
    try {
      pioneer = await pioneerLookup(token);
    } catch (error) {
      const upstreamStatus = Number(error?.status);
      if (upstreamStatus === 401) {
        throw httpError(401, "Pi sign-in is invalid or expired. Please sign in again.", "PI_TOKEN_INVALID");
      }
      if (upstreamStatus === 504) {
        throw httpError(504, "Pi identity verification timed out. Please try again.", "PI_API_TIMEOUT");
      }
      throw httpError(503, "Pi identity service is temporarily unavailable.", "PI_API_UNAVAILABLE");
    }

    const piUid = clean(pioneer?.uid);
    if (!piUid) throw httpError(401, "Verified Pi identity is missing.", "PI_UID_MISSING");

    let userQuery;
    try {
      userQuery = await db.from("users")
        .select("id,username,network")
        .eq("pi_uid", piUid)
        .eq("network", MAINNET)
        .maybeSingle();
    } catch (_) {
      throw httpError(503, "ALBUKHR Mainnet identity could not be resolved.", "ALBUKHR_IDENTITY_LOOKUP_FAILED");
    }
    if (userQuery?.error) {
      throw httpError(503, "ALBUKHR Mainnet identity could not be resolved.", "ALBUKHR_IDENTITY_LOOKUP_FAILED");
    }
    if (!userQuery?.data?.id) {
      throw httpError(403, "This Pi account is not registered as an ALBUKHR Mainnet user.", "ALBUKHR_USER_NOT_REGISTERED");
    }

    return Object.freeze({
      principal_type: "albukhr_user",
      principal_id: userQuery.data.id,
      pi_uid: piUid,
      username: clean(userQuery.data.username) || clean(pioneer.username) || null,
      network: MAINNET
    });
  }

  async function callTrustedRpc(name, args) {
    const { data, error } = await getDatabase().rpc(name, args);
    if (error) {
      const status = rpcHttpStatus(error);
      console.error(`[PROJECT UPDATES] ${name} failed.`, {
        code: error.code || null,
        status
      });
      throw httpError(
        status,
        status >= 500
          ? "Project Updates database operation is not currently available."
          : status === 403
            ? "You are not authorized to perform this action."
            : status === 404
              ? "The requested Project Update record was not found."
              : status === 409
                ? "The request conflicts with the current Project Update state."
                : "The Project Updates request was rejected.",
        "PROJECT_UPDATES_RPC_REJECTED"
      );
    }
    const result = normalizeRpcResult(data);
    if (result == null) throw httpError(502, "Project Updates returned an invalid database response.", "INVALID_RPC_RESPONSE");
    if (result && result.success === false) {
      const code = clean(result.code).toUpperCase();
      const status = code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : code === "CONFLICT" ? 409 : 400;
      const message = status === 404
        ? "The requested Project Update record was not found."
        : status === 403
          ? "You are not authorized to perform this action."
          : status === 409
            ? "The request conflicts with the current Project Update state."
            : "The Project Updates request was rejected.";
      throw httpError(status, message, code || "PROJECT_UPDATES_REJECTED");
    }
    return result;
  }

  async function requirePublisherAccess(projectId, principal) {
    const access = await callTrustedRpc("gateway_project_updates_get_publisher_access_trusted", {
      p_project_id: projectId,
      p_network: MAINNET,
      p_principal_type: principal.principal_type,
      p_principal_id: principal.principal_id
    });
    if (access.allowed !== true) {
      throw httpError(403, "You do not have publishing permission for this project.", "PUBLISHER_ACCESS_DENIED");
    }
    return access;
  }

  async function loadAndVerifyUploadIntent(intentId, projectId, principal) {
    const db = getDatabase();
    const { data: intent, error } = await db.from("project_update_upload_intents")
      .select("id,project_id,network,actor_principal_type,actor_principal_id,storage_path,content_type,expected_size_bytes,intent_status,expires_at")
      .eq("id", intentId)
      .eq("project_id", projectId)
      .eq("network", MAINNET)
      .maybeSingle();

    if (error) throw httpError(503, "Image upload intent could not be checked.", "UPLOAD_INTENT_LOOKUP_FAILED");
    if (!intent) throw httpError(404, "Image upload intent was not found.", "UPLOAD_INTENT_NOT_FOUND");
    if (intent.actor_principal_type !== principal.principal_type || intent.actor_principal_id !== principal.principal_id) {
      throw httpError(403, "This image upload intent belongs to a different publisher.", "UPLOAD_INTENT_OWNER_MISMATCH");
    }
    if (intent.intent_status !== "issued") {
      throw httpError(409, "This image upload intent is no longer available.", "UPLOAD_INTENT_NOT_USABLE");
    }
    const expiry = Date.parse(intent.expires_at);
    if (!Number.isFinite(expiry) || expiry <= clock()) {
      throw httpError(410, "The image upload intent has expired. Create a new one.", "UPLOAD_INTENT_EXPIRED");
    }
    if (!clean(intent.storage_path).startsWith(`mainnet/${projectId}/${intentId}/`)) {
      throw httpError(409, "Image upload path does not match its project intent.", "UPLOAD_PATH_MISMATCH");
    }

    const { data: file, error: downloadError } = await db.storage.from(BUCKET).download(intent.storage_path);
    if (downloadError || !file) {
      throw httpError(409, "The image has not been uploaded successfully.", "IMAGE_NOT_UPLOADED");
    }

    let buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (_) {
      throw httpError(502, "The uploaded image could not be read.", "IMAGE_READ_FAILED");
    }
    const detectedType = detectImageType(buffer);
    const expectedSize = Number(intent.expected_size_bytes);
    if (!detectedType || detectedType !== intent.content_type || buffer.length !== expectedSize || buffer.length > MAX_IMAGE_BYTES) {
      throw httpError(415, "Uploaded image bytes do not match the declared image type or size.", "IMAGE_CONTENT_MISMATCH");
    }

    return {
      intent,
      image_path: intent.storage_path,
      image_content_type: detectedType,
      image_size_bytes: buffer.length
    };
  }

  function noStore(res) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }

  function sendError(res, error) {
    const status = Number(error?.status);
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    if (safeStatus >= 500) {
      console.error("[PROJECT UPDATES] Request failed.", {
        status: safeStatus,
        code: clean(error?.code) || "PROJECT_UPDATES_INTERNAL_ERROR"
      });
    }
    return res.status(safeStatus).json({
      success: false,
      network: MAINNET,
      code: /^[A-Z0-9_]{2,64}$/.test(clean(error?.code)) ? clean(error.code) : "PROJECT_UPDATES_ERROR",
      error: safeStatus >= 500 ? "Project Updates service is temporarily unavailable." : clean(error?.message) || "The request was rejected."
    });
  }

  function route(handler, options = {}) {
    const authentication = options.authentication !== false;
    return async (req, res) => {
      noStore(res);
      try {
        const principal = authentication ? await resolvePrincipal(req) : null;
        const data = await handler(req, principal);
        return res.status(options.status || 200).json({ success: true, network: MAINNET, data });
      } catch (error) {
        return sendError(res, error);
      }
    };
  }

  // Public, combined feed. No project_type filters or grouping are accepted.
  router.get("/feed", route(async (req) => {
    const sort = clean(req.query.sort || "latest").toLowerCase();
    if (sort !== "latest" && sort !== "oldest") throw httpError(400, "Sort must be latest or oldest.", "INVALID_SORT");
    const projectId = req.query.project_id ? requireUuid(req.query.project_id, "Project ID") : null;
    const cursor = req.query.cursor == null ? null : clean(req.query.cursor);
    if (cursor && cursor.length > 1000) throw httpError(400, "Feed cursor is invalid.", "INVALID_CURSOR");
    return callTrustedRpc("gateway_project_updates_get_feed_trusted", {
      p_network: MAINNET,
      p_project_id: projectId,
      p_cursor: cursor,
      p_limit: boundedLimit(req.query.limit),
      p_sort: sort
    });
  }, { authentication: false }));

  router.get("/projects/:projectId/publisher-access", route(async (req, principal) => {
    const projectId = requireUuid(req.params.projectId, "Project ID");
    return callTrustedRpc("gateway_project_updates_get_publisher_access_trusted", {
      p_project_id: projectId,
      p_network: MAINNET,
      p_principal_type: principal.principal_type,
      p_principal_id: principal.principal_id
    });
  }));

  router.get("/updates/:updateId", route(async (req) => {
    const updateId = requireUuid(req.params.updateId, "Update ID");
    return callTrustedRpc("gateway_project_updates_get_item_trusted", {
      p_update_id: updateId,
      p_network: MAINNET
    });
  }, { authentication: false }));

  router.post("/projects/:projectId/upload-intents", route(async (req, principal) => {
    const projectId = requireUuid(req.params.projectId, "Project ID");
    const body = requestBody(req);
    const image = validateImageMetadata(body.content_type, body.file_size_bytes);
    await requirePublisherAccess(projectId, principal);

    const intentId = idFactory();
    const extension = image.contentType === "image/jpeg" ? "jpg" : image.contentType === "image/png" ? "png" : "webp";
    const storagePath = `mainnet/${projectId}/${intentId}/${idFactory()}.${extension}`;
    const expiresAt = new Date(clock() + UPLOAD_INTENT_TTL_MS).toISOString();

    await callTrustedRpc("gateway_project_updates_create_upload_intent_trusted", {
      p_upload_intent_id: intentId,
      p_project_id: projectId,
      p_network: MAINNET,
      p_actor_principal_type: principal.principal_type,
      p_actor_principal_id: principal.principal_id,
      p_storage_path: storagePath,
      p_content_type: image.contentType,
      p_expected_size_bytes: image.fileSizeBytes,
      p_expires_at: expiresAt
    });

    const { data, error } = await getDatabase().storage.from(BUCKET)
      .createSignedUploadUrl(storagePath, { upsert: false });
    if (error || !data?.token || !data?.path) {
      console.error("[PROJECT UPDATES] Signed upload URL could not be created.", { code: error?.statusCode || null });
      throw httpError(503, "A secure image upload link could not be created.", "SIGNED_UPLOAD_FAILED");
    }
    if (data.path !== storagePath) {
      throw httpError(502, "Storage returned an unexpected upload path.", "SIGNED_UPLOAD_PATH_MISMATCH");
    }

    return {
      upload_intent_id: intentId,
      bucket: BUCKET,
      path: storagePath,
      token: data.token,
      signed_url: data.signedUrl || null,
      expires_at: expiresAt,
      content_type: image.contentType,
      file_size_bytes: image.fileSizeBytes
    };
  }, { status: 201 }));

  router.post("/projects/:projectId/updates", route(async (req, principal) => {
    const projectId = requireUuid(req.params.projectId, "Project ID");
    const body = requestBody(req);
    const payload = validateUpdatePayload(body);
    const intentId = requireUuid(body.upload_intent_id, "Upload intent ID");
    const image = await loadAndVerifyUploadIntent(intentId, projectId, principal);

    return callTrustedRpc("gateway_project_updates_publish_trusted", {
      p_project_id: projectId,
      p_network: MAINNET,
      p_principal_type: principal.principal_type,
      p_principal_id: principal.principal_id,
      p_upload_intent_id: intentId,
      p_update_kind: payload.updateKind,
      p_title: payload.title,
      p_body: payload.body,
      p_image_path: image.image_path,
      p_image_content_type: image.image_content_type,
      p_image_size_bytes: image.image_size_bytes
    });
  }, { status: 201 }));

  router.patch("/updates/:updateId", route(async (req, principal) => {
    const updateId = requireUuid(req.params.updateId, "Update ID");
    const body = requestBody(req);
    const payload = validateUpdatePayload(body);
    let image = null;
    let intentId = null;
    if (body.upload_intent_id) {
      intentId = requireUuid(body.upload_intent_id, "Upload intent ID");
      // The trusted RPC performs the final update/project/grant check. The
      // pre-read only proves the uploaded object belongs to this principal.
      const { data: update, error } = await getDatabase().from("project_updates")
        .select("id,project_id,network")
        .eq("id", updateId)
        .eq("network", MAINNET)
        .maybeSingle();
      if (error || !update) throw httpError(404, "Project Update was not found.", "UPDATE_NOT_FOUND");
      image = await loadAndVerifyUploadIntent(intentId, update.project_id, principal);
    }

    return callTrustedRpc("gateway_project_updates_edit_trusted", {
      p_update_id: updateId,
      p_network: MAINNET,
      p_principal_type: principal.principal_type,
      p_principal_id: principal.principal_id,
      p_update_kind: payload.updateKind,
      p_title: payload.title,
      p_body: payload.body,
      p_upload_intent_id: intentId,
      p_image_path: image?.image_path || null,
      p_image_content_type: image?.image_content_type || null,
      p_image_size_bytes: image?.image_size_bytes || null
    });
  }));

  router.post("/updates/:updateId/comments", route(async (req, principal) => {
    const updateId = requireUuid(req.params.updateId, "Update ID");
    const body = requestBody(req);
    const commentText = boundedText(body.comment_text, 1, 3000, "Comment");
    const parentCommentId = body.parent_comment_id == null || body.parent_comment_id === ""
      ? null
      : requireUuid(body.parent_comment_id, "Parent comment ID");
    return callTrustedRpc("gateway_project_updates_add_comment_trusted", {
      p_update_id: updateId,
      p_network: MAINNET,
      p_principal_type: principal.principal_type,
      p_principal_id: principal.principal_id,
      p_comment_text: commentText,
      p_parent_comment_id: parentCommentId
    });
  }, { status: 201 }));

  router.put("/updates/:updateId/reaction", route(async (req, principal) => {
    const updateId = requireUuid(req.params.updateId, "Update ID");
    const voteType = clean(requestBody(req).vote_type).toLowerCase();
    if (voteType !== "like" && voteType !== "dislike") {
      throw httpError(400, "Vote type must be like or dislike.", "INVALID_VOTE_TYPE");
    }
    return callTrustedRpc("gateway_project_updates_set_reaction_trusted", {
      p_update_id: updateId,
      p_network: MAINNET,
      p_principal_type: principal.principal_type,
      p_principal_id: principal.principal_id,
      p_vote_type: voteType
    });
  }));

  router.post("/updates/:updateId/reports", route(async (req, principal) => {
    const updateId = requireUuid(req.params.updateId, "Update ID");
    const body = requestBody(req);
    const reason = clean(body.reason).toLowerCase();
    if (!ALLOWED_REPORT_REASONS.has(reason)) {
      throw httpError(400, "Report reason is invalid.", "INVALID_REPORT_REASON");
    }
    const details = body.details == null || body.details === "" ? null : boundedText(body.details, 1, 1500, "Report details");
    return callTrustedRpc("gateway_project_updates_create_report_trusted", {
      p_update_id: updateId,
      p_network: MAINNET,
      p_principal_type: principal.principal_type,
      p_principal_id: principal.principal_id,
      p_reason: reason,
      p_report_details: details
    });
  }, { status: 201 }));

  router.get("/moderation/reports", route(async (req, principal) => {
    const status = clean(req.query.status || "open").toLowerCase();
    if (status !== "open" && status !== "reviewing") {
      throw httpError(400, "Moderation status must be open or reviewing.", "INVALID_MODERATION_STATUS");
    }
    return callTrustedRpc("gateway_project_updates_list_reports_trusted", {
      p_network: MAINNET,
      p_moderator_principal_type: principal.principal_type,
      p_moderator_principal_id: principal.principal_id,
      p_status: status,
      p_limit: boundedLimit(req.query.limit, 30, 100)
    });
  }));

  router.post("/moderation/reports/:reportId/decision", route(async (req, principal) => {
    const reportId = requireUuid(req.params.reportId, "Report ID");
    const body = requestBody(req);
    const decision = clean(body.decision).toLowerCase();
    if (!ALLOWED_REPORT_DECISIONS.has(decision)) {
      throw httpError(400, "Moderation decision is invalid.", "INVALID_MODERATION_DECISION");
    }
    const reason = body.reason == null || body.reason === "" ? null : boundedText(body.reason, 1, 2000, "Moderation reason");
    return callTrustedRpc("gateway_project_updates_moderate_report_trusted", {
      p_report_id: reportId,
      p_network: MAINNET,
      p_moderator_principal_type: principal.principal_type,
      p_moderator_principal_id: principal.principal_id,
      p_decision: decision,
      p_reason: reason
    });
  }));

  router.post("/moderation/updates/:updateId/action", route(async (req, principal) => {
    const updateId = requireUuid(req.params.updateId, "Update ID");
    const body = requestBody(req);
    const action = clean(body.action).toLowerCase();
    if (!ALLOWED_CONTENT_ACTIONS.has(action)) {
      throw httpError(400, "Content action must be hide, restore or remove.", "INVALID_CONTENT_ACTION");
    }
    const reason = boundedText(body.reason, 1, 2000, "Moderation reason");
    return callTrustedRpc("gateway_project_updates_moderate_content_trusted", {
      p_update_id: updateId,
      p_network: MAINNET,
      p_moderator_principal_type: principal.principal_type,
      p_moderator_principal_id: principal.principal_id,
      p_action: action,
      p_reason: reason
    });
  }));

  return router;
}

const projectUpdatesGatewayRouter = createProjectUpdatesGatewayRouter();

module.exports = {
  projectUpdatesGatewayRouter,
  createProjectUpdatesGatewayRouter
  // Pure validators are isolated in project-updates-validation.js so they
  // can be tested without loading Express or production service credentials.
};
