BEGIN;

CREATE INDEX IF NOT EXISTS financial_control_events_actor_fk_idx
  ON albukhr_security.financial_control_role_change_events(actor_user_id);

CREATE INDEX IF NOT EXISTS financial_control_requests_target_grant_fk_idx
  ON albukhr_security.financial_control_role_change_requests(target_grant_id);

CREATE INDEX IF NOT EXISTS financial_control_requests_approved_by_fk_idx
  ON albukhr_security.financial_control_role_change_requests(approved_by);

CREATE INDEX IF NOT EXISTS financial_control_requests_project_fk_idx
  ON albukhr_security.financial_control_role_change_requests(project_id);

CREATE INDEX IF NOT EXISTS financial_control_requests_rejected_by_fk_idx
  ON albukhr_security.financial_control_role_change_requests(rejected_by);

CREATE INDEX IF NOT EXISTS financial_control_requests_requested_by_fk_idx
  ON albukhr_security.financial_control_role_change_requests(requested_by);

CREATE INDEX IF NOT EXISTS financial_control_requests_role_code_fk_idx
  ON albukhr_security.financial_control_role_change_requests(role_code);

CREATE INDEX IF NOT EXISTS financial_control_grants_approved_by_fk_idx
  ON albukhr_security.financial_control_role_grants(approved_by);

CREATE INDEX IF NOT EXISTS financial_control_grants_project_fk_idx
  ON albukhr_security.financial_control_role_grants(project_id);

CREATE INDEX IF NOT EXISTS financial_control_grants_requested_by_fk_idx
  ON albukhr_security.financial_control_role_grants(requested_by);

CREATE INDEX IF NOT EXISTS financial_control_grants_role_code_fk_idx
  ON albukhr_security.financial_control_role_grants(role_code);

CREATE INDEX IF NOT EXISTS financial_control_revocations_approved_by_fk_idx
  ON albukhr_security.financial_control_role_revocations(approved_by);

CREATE INDEX IF NOT EXISTS financial_control_revocations_project_fk_idx
  ON albukhr_security.financial_control_role_revocations(project_id);

CREATE INDEX IF NOT EXISTS financial_control_revocations_requested_by_fk_idx
  ON albukhr_security.financial_control_role_revocations(requested_by);

CREATE INDEX IF NOT EXISTS financial_control_revocations_role_code_fk_idx
  ON albukhr_security.financial_control_role_revocations(role_code);

CREATE INDEX IF NOT EXISTS financial_control_revocations_target_fk_idx
  ON albukhr_security.financial_control_role_revocations(target_user_id);

COMMIT;
