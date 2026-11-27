"use strict";

/*
 * Resolves an exact term from the existing published-only Mainnet projection.
 * This helper deliberately accepts no browser-provided identity or network.
 */
function resolvePublishedTerm(
  projection,
  {
    project,
    durationDays,
    termVersionId,
    expectedProjectType,
    now = Date.now(),
  } = {}
) {
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return null;
  if (projection.success !== true) return null;
  if (String(projection.network || "").toLowerCase() !== "mainnet") return null;
  if (!project || String(projection.project_id || "") !== String(project.id || "")) return null;
  if (
    String(projection.project_code || "").trim().toLowerCase() !==
    String(project.project_code || "").trim().toLowerCase()
  ) return null;
  if (String(projection.project_type || "").trim().toLowerCase() !== expectedProjectType) return null;

  const rows = Array.isArray(projection.terms) ? projection.terms : [];
  const term = rows.find((row) =>
    row &&
    String(row.term_version_id || "") === String(termVersionId || "") &&
    Number(row.duration_days) === Number(durationDays)
  );
  if (!term) return null;

  const effectiveFrom = Date.parse(term.effective_from || "");
  const effectiveUntil = term.effective_until == null ? null : Date.parse(term.effective_until);

  if (!Number.isFinite(effectiveFrom) || effectiveFrom > now) return null;
  if (effectiveUntil !== null && (!Number.isFinite(effectiveUntil) || effectiveUntil <= now)) return null;

  return {
    id: term.term_version_id,
    project_id: projection.project_id,
    project_code: projection.project_code,
    network: "mainnet",
    duration_days: Number(term.duration_days),
    term_status: "published",
    version_number: Number(term.version_number) || 0,
    effective_from: term.effective_from,
    effective_until: term.effective_until ?? null,
  };
}

module.exports = { resolvePublishedTerm };
