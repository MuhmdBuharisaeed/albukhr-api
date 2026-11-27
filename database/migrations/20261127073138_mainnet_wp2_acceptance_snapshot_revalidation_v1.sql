-- ALBUKHR Mainnet WP2 — validate the current live term snapshot against the accepted immutable hash.
-- Also add covering indexes for the two acceptance-table FKs identified by the performance advisor.
-- Applied migration version: 20261127073138

DO $preflight$
BEGIN
  IF to_regclass('albukhr_security.project_staking_policy_acceptances') IS NULL
     OR to_regclass('albukhr_security.staking_policy_revisions') IS NULL THEN
    RAISE EXCEPTION 'WP2 acceptance hardening blocked: required tables are missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid='albukhr_security.validate_staking_policy_acceptance_v2(uuid,uuid,uuid,text,text,text,text)'::regprocedure
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']
      AND has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'WP2 acceptance hardening blocked: validator security contract differs from reviewed baseline.';
  END IF;

  IF to_regclass('albukhr_security.project_staking_policy_acceptances_term_version_id_idx') IS NOT NULL
     OR to_regclass('albukhr_security.project_staking_policy_acceptances_policy_revision_id_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'WP2 acceptance hardening blocked: target FK indexes already exist; review drift.';
  END IF;
END;
$preflight$;

CREATE INDEX project_staking_policy_acceptances_term_version_id_idx
  ON albukhr_security.project_staking_policy_acceptances (term_version_id);

CREATE INDEX project_staking_policy_acceptances_policy_revision_id_idx
  ON albukhr_security.project_staking_policy_acceptances (policy_revision_id);

CREATE OR REPLACE FUNCTION albukhr_security.validate_staking_policy_acceptance_v2(
  p_acceptance_id uuid,
  p_project_id uuid,
  p_term_version_id uuid,
  p_verified_pi_uid text,
  p_session_fingerprint text,
  p_policy_revision text,
  p_policy_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_term public.project_staking_term_versions%ROWTYPE;
  v_policy albukhr_security.staking_policy_revisions%ROWTYPE;
  v_acceptance albukhr_security.project_staking_policy_acceptances%ROWTYPE;
  v_current_term_snapshot jsonb;
  v_current_term_hash text;
BEGIN
  IF coalesce(auth.jwt()->>'role','') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='SERVICE_ROLE_REQUIRED';
  END IF;

  IF p_acceptance_id IS NULL OR p_project_id IS NULL OR p_term_version_id IS NULL
     OR nullif(btrim(coalesce(p_verified_pi_uid,'')),'') IS NULL
     OR nullif(btrim(coalesce(p_session_fingerprint,'')),'') IS NULL
     OR nullif(btrim(coalesce(p_policy_revision,'')),'') IS NULL
     OR nullif(btrim(coalesce(p_policy_hash,'')),'') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='ACCEPTANCE_VALIDATION_INPUT_REQUIRED';
  END IF;

  IF p_session_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_policy_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='ACCEPTANCE_VALIDATION_INPUT_INVALID';
  END IF;

  SELECT * INTO v_user
  FROM public.users
  WHERE pi_uid=btrim(p_verified_pi_uid)
    AND network='mainnet';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid',false,'reason_code','MAINNET_PI_IDENTITY_NOT_FOUND');
  END IF;

  SELECT * INTO v_acceptance
  FROM albukhr_security.project_staking_policy_acceptances
  WHERE id=p_acceptance_id
    AND project_id=p_project_id
    AND term_version_id=p_term_version_id
    AND user_id=v_user.id
    AND pi_uid=v_user.pi_uid
    AND network='mainnet'
    AND policy_revision=p_policy_revision
    AND policy_hash=p_policy_hash
    AND session_fingerprint=p_session_fingerprint;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid',false,'reason_code','STAKING_POLICY_ACCEPTANCE_MISMATCH');
  END IF;

  SELECT * INTO v_project
  FROM public.projects
  WHERE id=v_acceptance.project_id
    AND network='mainnet'
    AND project_code=v_acceptance.project_code
    AND lower(project_type)=v_acceptance.project_type
    AND status='active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid',false,'reason_code','ACCEPTED_PROJECT_NOT_ACTIVE_OR_CHANGED');
  END IF;

  SELECT * INTO v_term
  FROM public.project_staking_term_versions
  WHERE id=v_acceptance.term_version_id
    AND project_id=v_project.id
    AND project_code=v_project.project_code
    AND network='mainnet'
    AND term_status='published'
    AND effective_from <= clock_timestamp()
    AND (effective_until IS NULL OR effective_until > clock_timestamp());

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid',false,'reason_code','ACCEPTED_TERM_NOT_CURRENTLY_PUBLISHED');
  END IF;

  IF v_term.disclosure_version IS DISTINCT FROM v_acceptance.disclosure_version
     OR v_term.consent_version IS DISTINCT FROM v_acceptance.consent_version THEN
    RETURN jsonb_build_object('valid',false,'reason_code','ACCEPTED_TERM_DISCLOSURE_CHANGED');
  END IF;

  SELECT * INTO v_policy
  FROM albukhr_security.staking_policy_revisions
  WHERE id=v_acceptance.policy_revision_id
    AND policy_document_id=v_acceptance.policy_document_id
    AND policy_revision=p_policy_revision
    AND policy_hash=p_policy_hash
    AND approval_status='approved';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid',false,'reason_code','ACCEPTED_POLICY_NOT_CURRENTLY_APPROVED');
  END IF;

  v_current_term_snapshot := jsonb_build_object(
    'project_id',v_project.id,
    'project_code',v_project.project_code,
    'project_type',lower(v_project.project_type),
    'network','mainnet',
    'term_version_id',v_term.id,
    'term_key',v_term.term_key,
    'version_number',v_term.version_number,
    'duration_days',v_term.duration_days,
    'min_stake',v_term.min_stake,
    'max_stake',v_term.max_stake,
    'reward_model',v_term.reward_model,
    'reward_rate',v_term.reward_rate,
    'reward_definition',v_term.reward_definition,
    'early_withdrawal_policy',v_term.early_withdrawal_policy,
    'capital_withdrawal_policy',v_term.capital_withdrawal_policy,
    'reward_withdrawal_policy',v_term.reward_withdrawal_policy,
    'funding_start_at',v_term.funding_start_at,
    'funding_end_at',v_term.funding_end_at,
    'disclosure_version',v_term.disclosure_version,
    'consent_version',v_term.consent_version,
    'effective_from',v_term.effective_from,
    'effective_until',v_term.effective_until
  );

  v_current_term_hash := encode(
    extensions.digest(convert_to(v_current_term_snapshot::text,'UTF8'),'sha256'),
    'hex'
  );

  IF v_current_term_hash <> v_acceptance.term_hash
     OR v_current_term_snapshot <> v_acceptance.term_snapshot THEN
    RETURN jsonb_build_object('valid',false,'reason_code','ACCEPTED_TERM_SNAPSHOT_CHANGED');
  END IF;

  RETURN jsonb_build_object(
    'valid',true,
    'acceptance_id',v_acceptance.id,
    'project_id',v_acceptance.project_id,
    'term_version_id',v_acceptance.term_version_id,
    'network','mainnet',
    'policy_revision',v_acceptance.policy_revision,
    'policy_hash',v_acceptance.policy_hash,
    'term_hash',v_acceptance.term_hash,
    'accepted_at_utc',v_acceptance.accepted_at_utc,
    'contract_version','staking_policy_acceptance_v2'
  );
END;
$function$;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='albukhr_security'
      AND indexname='project_staking_policy_acceptances_term_version_id_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='albukhr_security'
      AND indexname='project_staking_policy_acceptances_policy_revision_id_idx'
  ) THEN
    RAISE EXCEPTION 'WP2 acceptance hardening postflight failed: FK covering indexes are missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid='albukhr_security.validate_staking_policy_acceptance_v2(uuid,uuid,uuid,text,text,text,text)'::regprocedure
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']
      AND has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'WP2 acceptance hardening postflight failed: validator ACL/security changed.';
  END IF;
END;
$postflight$;
