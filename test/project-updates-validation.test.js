"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const validation = require("../src/project-updates-validation");

test("accepts UUIDs and rejects malformed identifiers", () => {
  assert.equal(
    validation.requireUuid("86737826-b6ab-48e0-a649-8e7cb75be14f", "Project ID"),
    "86737826-b6ab-48e0-a649-8e7cb75be14f"
  );
  assert.throws(() => validation.requireUuid("not-a-uuid"), { status: 400 });
});

test("allows only JPEG, PNG and WEBP up to 10 MiB", () => {
  assert.deepEqual(validation.validateImageMetadata("image/jpeg", 512), {
    contentType: "image/jpeg",
    fileSizeBytes: 512
  });
  assert.throws(() => validation.validateImageMetadata("image/gif", 512), { status: 415 });
  assert.throws(() => validation.validateImageMetadata("image/png", 10 * 1024 * 1024 + 1), { status: 413 });
  assert.throws(() => validation.validateImageMetadata("image/png", 0), { status: 413 });
});

test("detects image formats from file signatures, not filename", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]);
  const webp = Buffer.from("RIFF0000WEBP", "ascii");
  const fake = Buffer.from("not-an-image", "ascii");
  assert.equal(validation.detectImageType(png), "image/png");
  assert.equal(validation.detectImageType(jpeg), "image/jpeg");
  assert.equal(validation.detectImageType(webp), "image/webp");
  assert.equal(validation.detectImageType(fake), null);
});

test("validates progress and milestone content limits", () => {
  assert.deepEqual(validation.validateUpdatePayload({
    update_kind: "milestone",
    title: "First milestone",
    body: "Completed phase one."
  }), {
    updateKind: "milestone",
    title: "First milestone",
    body: "Completed phase one."
  });
  assert.throws(() => validation.validateUpdatePayload({ update_kind: "video", title: "x", body: "y" }), { status: 400 });
  assert.throws(() => validation.validateUpdatePayload({ update_kind: "progress", title: "", body: "y" }), { status: 400 });
  assert.throws(() => validation.validateUpdatePayload({ update_kind: "progress", title: "x", body: "" }), { status: 400 });
});

test("validates comments, reports and stable feed limits", () => {
  assert.equal(validation.boundedText("Good progress", 1, 3000, "Comment"), "Good progress");
  assert.equal(validation.boundedLimit(undefined), 20);
  assert.equal(validation.boundedLimit("50"), 50);
  assert.throws(() => validation.boundedLimit("51"), { status: 400 });
  assert.throws(() => validation.boundedLimit("1.5"), { status: 400 });
});

test("maps trusted database errors to safe HTTP statuses", () => {
  assert.equal(validation.rpcHttpStatus({ code: "42501" }), 403);
  assert.equal(validation.rpcHttpStatus({ code: "23505" }), 409);
  assert.equal(validation.rpcHttpStatus({ code: "P0002" }), 404);
  assert.equal(validation.rpcHttpStatus({ code: "unknown" }), 502);
});
