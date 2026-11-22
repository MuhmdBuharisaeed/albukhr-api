"use strict";

const MAINNET = "mainnet";
const BUCKET = "project-updates";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const UPLOAD_INTENT_TTL_MS = 10 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_UPDATE_KINDS = new Set(["progress", "milestone"]);
const ALLOWED_REPORT_REASONS = new Set(["spam", "abuse", "misleading", "personal_data", "other"]);
const ALLOWED_REPORT_DECISIONS = new Set(["reviewing", "resolved", "dismissed"]);
const ALLOWED_CONTENT_ACTIONS = new Set(["hide", "restore", "remove"]);

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function httpError(status, message, code = "PROJECT_UPDATES_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requireUuid(value, label = "ID") {
  const normalized = clean(value);
  if (!UUID_PATTERN.test(normalized)) {
    throw httpError(400, `${label} is invalid.`, "INVALID_ID");
  }
  return normalized;
}

function rpcHttpStatus(error) {
  switch (String(error && error.code || "")) {
    case "42501": return 403;
    case "22023":
    case "22001":
    case "23514": return 400;
    case "23505": return 409;
    case "55000": return 423;
    case "P0002": return 404;
    case "57014": return 503;
    default: return 502;
  }
}

function validateImageMetadata(contentType, fileSizeBytes) {
  const type = clean(contentType).toLowerCase();
  const size = Number(fileSizeBytes);
  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    throw httpError(415, "Use a JPEG, PNG or WEBP image.", "IMAGE_TYPE_NOT_ALLOWED");
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_BYTES) {
    throw httpError(413, "The update image must be no larger than 10 MiB.", "IMAGE_SIZE_NOT_ALLOWED");
  }
  return { contentType: type, fileSizeBytes: size };
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function validateUpdatePayload(body) {
  const updateKind = clean(body.update_kind).toLowerCase();
  const title = clean(body.title);
  const text = clean(body.body);
  if (!ALLOWED_UPDATE_KINDS.has(updateKind)) {
    throw httpError(400, "Update kind must be progress or milestone.", "INVALID_UPDATE_KIND");
  }
  if (title.length < 1 || title.length > 160) {
    throw httpError(400, "Update title must contain 1–160 characters.", "INVALID_TITLE");
  }
  if (text.length < 1 || text.length > 10000) {
    throw httpError(400, "Update text must contain 1–10,000 characters.", "INVALID_BODY");
  }
  return { updateKind, title, body: text };
}

function boundedText(value, min, max, label) {
  const text = clean(value);
  if (text.length < min || text.length > max) {
    throw httpError(400, `${label} must contain ${min}–${max} characters.`, "INVALID_TEXT");
  }
  return text;
}

function boundedLimit(value, fallback = 20, maximum = 50) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw httpError(400, `Limit must be between 1 and ${maximum}.`, "INVALID_LIMIT");
  }
  return parsed;
}

module.exports = {
  MAINNET,
  BUCKET,
  MAX_IMAGE_BYTES,
  UPLOAD_INTENT_TTL_MS,
  UUID_PATTERN,
  ALLOWED_IMAGE_TYPES,
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
};
