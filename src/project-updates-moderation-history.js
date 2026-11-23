/* ALBUKHR Project Updates — Moderation History API
 * Stage 6G: read-only audit history.
 *
 * Security:
 * - Supabase bearer token is verified server-side.
 * - Active Admin and AAL2 are required by resolveSupabaseAdminPrincipal.
 * - The SECURITY DEFINER RPC independently verifies the Super Admin role.
 * - The browser never supplies a principal ID and never queries the event table.
 * - Mainnet only; private/no-store responses.
 */
"use strict";

const express = require("express");
const { resolveSupabaseAdminPrincipal } = require("./project-updates-admin-access");

const MAINNET = "mainnet";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/i;

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function makeError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requireBearer(req) {
  const header = clean(req && req.headers && req.headers.authorization);
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? clean(match[1]) : "";
  if (!token) {
    throw makeError(401, "A valid Admin Bearer token is required.", "AUTH_TOKEN_REQUIRED");
  }
  return token;
}

function validateUuid(value, label) {
  const candidate = clean(value);
  if (!UUID_PATTERN.test(candidate)) {
    throw makeError(400, label + " is invalid.", "INVALID_ID");
  }
  return candidate;
}

function validateCursor(req) {
  const rawTime = req.query.before_created_at;
  const rawId = req.query.before_id;
  const hasTime = rawTime != null && clean(rawTime) !== "";
  const hasId = rawId != null && clean(rawId) !== "";

  if (hasTime !== hasId) {
    throw makeError(400, "Both cursor fields must be supplied together.", "INVALID_CURSOR");
  }
  if (!hasTime) return { createdAt: null, id: null };

  const input = clean(rawTime);
  if (!ISO_PATTERN.test(input) || !Number.isFinite(Date.parse(input))) {
    throw makeError(400, "Moderation-history cursor timestamp is invalid.", "INVALID_CURSOR");
  }

  return {
    // Preserve the database timestamp precision (including microseconds).
    // Converting through Date.toISOString() would truncate PostgreSQL's
    // sub-millisecond precision and could duplicate or skip cursor rows.
    createdAt: input,
    id: validateUuid(rawId, "Cursor ID")
  };
}

function validateLimit(value) {
  if (value == null || value === "") return 30;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw makeError(400, "Limit must be between 1 and 100.", "INVALID_LIMIT");
  }
  return limit;
}

function rpcStatus(error) {
  const code = clean(error && error.code);
  if (code === "42501") return 403;
  if (code === "22023" || code === "22001" || code === "23514") return 400;
  if (code === "57014") return 503;
  return 502;
}

function safeCode(value) {
  const code = clean(value).toUpperCase();
  return /^[A-Z0-9_]{2,64}$/.test(code) ? code : "MODERATION_HISTORY_ERROR";
}

function createProjectUpdatesModerationHistoryRouter(dependencies = {}) {
  const router = express.Router();

  function getDatabase() {
    if (dependencies.supabase && typeof dependencies.supabase.rpc === "function") {
      return dependencies.supabase;
    }
    return require("./supabase-client").supabase;
  }

  router.get("/", async (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    try {
      const provider = clean(req.headers && req.headers["x-albukhr-auth-provider"]).toLowerCase();
      if (provider !== "supabase-auth" && provider !== "supabase") {
        throw makeError(400, "Moderation history requires the Admin Supabase Auth provider.", "AUTH_PROVIDER_UNSUPPORTED");
      }

      const db = getDatabase();
      const token = requireBearer(req);
      const principal = await resolveSupabaseAdminPrincipal(db, token);

      if (!principal || principal.principal_type !== "supabase_auth_user" ||
          clean(principal.network).toLowerCase() !== MAINNET || !principal.principal_id) {
        throw makeError(403, "A verified Mainnet Admin identity is required.", "ADMIN_ACCESS_REQUIRED");
      }

      const scope = clean(req.query.scope || "all").toLowerCase();
      if (!["all", "reports", "updates", "comments"].includes(scope)) {
        throw makeError(400, "History scope must be all, reports, updates or comments.", "INVALID_HISTORY_SCOPE");
      }

      const limit = validateLimit(req.query.limit);
      const updateId = req.query.update_id == null || clean(req.query.update_id) === ""
        ? null
        : validateUuid(req.query.update_id, "Project Update ID");
      const cursor = validateCursor(req);

      const result = await db.rpc("gateway_project_updates_get_moderation_history_trusted", {
        p_network: MAINNET,
        p_moderator_principal_type: principal.principal_type,
        p_moderator_principal_id: principal.principal_id,
        p_limit: limit,
        p_scope: scope,
        p_update_id: updateId,
        p_before_created_at: cursor.createdAt,
        p_before_id: cursor.id
      });

      if (result && result.error) {
        const status = rpcStatus(result.error);
        console.error("[PROJECT UPDATES MODERATION HISTORY] Trusted RPC failed.", {
          code: result.error.code || null,
          status
        });
        throw makeError(
          status,
          status === 403
            ? "Super Admin authorization is required to read moderation history."
            : status === 400
              ? "The moderation-history request was rejected."
              : "Moderation history is temporarily unavailable.",
          status === 403 ? "SUPER_ADMIN_REQUIRED" : "MODERATION_HISTORY_RPC_FAILED"
        );
      }

      const data = result && result.data;
      const payload = Array.isArray(data) ? data[0] : data;
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
        throw makeError(502, "The moderation-history service returned an invalid response.", "INVALID_HISTORY_RESPONSE");
      }

      return res.status(200).json({
        success: true,
        network: MAINNET,
        data: payload
      });
    } catch (error) {
      const status = Number(error && error.status);
      const safeStatus = status >= 400 && status < 600 ? status : 500;
      if (safeStatus >= 500) {
        console.error("[PROJECT UPDATES MODERATION HISTORY] Request failed.", {
          code: safeCode(error && error.code),
          status: safeStatus
        });
      }
      return res.status(safeStatus).json({
        success: false,
        network: MAINNET,
        code: safeCode(error && error.code),
        error: safeStatus >= 500
          ? "Moderation history is temporarily unavailable."
          : clean(error && error.message) || "The moderation-history request was rejected."
      });
    }
  });

  return router;
}

const projectUpdatesModerationHistoryRouter = createProjectUpdatesModerationHistoryRouter();

module.exports = {
  projectUpdatesModerationHistoryRouter,
  createProjectUpdatesModerationHistoryRouter,
  validateCursor,
  validateLimit,
  validateUuid
};
