"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolvePublishedTerm } = require("../src/published-term-projection");

const NOW = Date.parse("2026-11-27T06:00:00.000Z");
const project = { id: "project-1", project_code: "CORE-ONE" };

function projection(overrides = {}) {
  return {
    success: true,
    network: "mainnet",
    project_id: "project-1",
    project_code: "CORE-ONE",
    project_type: "core",
    terms: [{
      term_version_id: "term-1",
      duration_days: 90,
      version_number: 4,
      effective_from: "2026-11-01T00:00:00.000Z",
      effective_until: null,
    }],
    ...overrides,
  };
}

test("resolves an exact currently effective Core term", () => {
  const term = resolvePublishedTerm(projection(), {
    project,
    durationDays: 90,
    termVersionId: "term-1",
    expectedProjectType: "core",
    now: NOW,
  });
  assert.equal(term.id, "term-1");
  assert.equal(term.network, "mainnet");
  assert.equal(term.term_status, "published");
});

test("rejects a wrong network, project, project code, or project type", () => {
  assert.equal(resolvePublishedTerm(projection({ network: "testnet" }), { project, durationDays: 90, termVersionId: "term-1", expectedProjectType: "core", now: NOW }), null);
  assert.equal(resolvePublishedTerm(projection({ project_id: "other" }), { project, durationDays: 90, termVersionId: "term-1", expectedProjectType: "core", now: NOW }), null);
  assert.equal(resolvePublishedTerm(projection({ project_code: "OTHER" }), { project, durationDays: 90, termVersionId: "term-1", expectedProjectType: "core", now: NOW }), null);
  assert.equal(resolvePublishedTerm(projection({ project_type: "internal" }), { project, durationDays: 90, termVersionId: "term-1", expectedProjectType: "core", now: NOW }), null);
});

test("rejects wrong term ID or duration", () => {
  assert.equal(resolvePublishedTerm(projection(), { project, durationDays: 180, termVersionId: "term-1", expectedProjectType: "core", now: NOW }), null);
  assert.equal(resolvePublishedTerm(projection(), { project, durationDays: 90, termVersionId: "term-other", expectedProjectType: "core", now: NOW }), null);
});

test("rejects terms that are not yet effective or have expired", () => {
  const future = projection({ terms: [{ ...projection().terms[0], effective_from: "2026-12-01T00:00:00.000Z" }] });
  const expired = projection({ terms: [{ ...projection().terms[0], effective_until: "2026-11-27T05:59:59.000Z" }] });
  assert.equal(resolvePublishedTerm(future, { project, durationDays: 90, termVersionId: "term-1", expectedProjectType: "core", now: NOW }), null);
  assert.equal(resolvePublishedTerm(expired, { project, durationDays: 90, termVersionId: "term-1", expectedProjectType: "core", now: NOW }), null);
});
