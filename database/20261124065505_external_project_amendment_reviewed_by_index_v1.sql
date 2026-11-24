/*
 * ALBUKHR External Project Owner Amendments — supporting FK index
 * Applied to Mainnet as migration version 20261124065505.
 * Source-only archive: do not re-run against Mainnet.
 */
CREATE INDEX IF NOT EXISTS external_project_amendment_reviewed_by_idx
  ON public.external_project_amendment_requests (reviewed_by)
  WHERE reviewed_by IS NOT NULL;
