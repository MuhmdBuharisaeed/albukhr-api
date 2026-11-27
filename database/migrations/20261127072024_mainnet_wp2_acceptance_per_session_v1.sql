-- WP2 follow-up: preserve one immutable acceptance per authenticated Pi session.
-- This allows a later Pi access-token session to re-accept the same immutable offer
-- without overwriting the earlier acceptance record.

DO $preflight$
BEGIN
  IF to_regclass('albukhr_security.project_staking_policy_acceptances') IS NULL THEN
    RAISE EXCEPTION 'WP2 session migration blocked: acceptance table is missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='albukhr_security.project_staking_policy_acceptances'::regclass
      AND conname='project_staking_policy_acceptance_subject_uq'
      AND contype='u'
  ) THEN
    RAISE EXCEPTION 'WP2 session migration blocked: expected subject unique constraint is missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='albukhr_security.project_staking_policy_acceptances'::regclass
      AND conname='project_staking_policy_acceptance_idempotency_uq'
      AND contype='u'
  ) THEN
    RAISE EXCEPTION 'WP2 session migration blocked: idempotency unique constraint is missing.';
  END IF;
END;
$preflight$;

ALTER TABLE albukhr_security.project_staking_policy_acceptances
  DROP CONSTRAINT project_staking_policy_acceptance_subject_uq;

ALTER TABLE albukhr_security.project_staking_policy_acceptances
  ADD CONSTRAINT project_staking_policy_acceptance_subject_session_uq
  UNIQUE (project_id, network, pi_uid, term_version_id, policy_revision_id, session_fingerprint);

CREATE OR REPLACE FUNCTION albukhr_security.record_staking_policy_acceptance_v2(
  p_project_id uuid,
  p_term_version_id uuid,
  p_verified_pi_uid text,
  p_session_fingerprint text,
  p_policy_revision text,
  p_policy_hash text,
  p_disclosure_version text,
  p_consent_version text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_term public.project_staking_term_versions%ROWTYPE;
  v_policy albukhr_security.staking_policy_revisions%ROWTYPE;
  v_term_snapshot jsonb;
  v_term_hash text;
  v_existing albukhr_security.project_staking_policy_acceptances%ROWTYPE;
  v_acceptance_id uuid;
  v_accepted_at timestamptz;
BEGIN
  IF coalesce(auth.jwt()->>'role','') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='SERVICE_ROLE_REQUIRED';
  END IF;

  IF p_project_id IS NULL OR p_term_version_id IS NULL
     OR nullif(btrim(coalesce(p_verified_pi_uid,'')),'') IS NULL
     OR nullif(btrim(coalesce(p_session_fingerprint,'')),'') IS NULL
     OR nullif(btrim(coalesce(p_policy_revision,'')),'') IS NULL
     OR nullif(btrim(coalesce(p_policy_hash,'')),'') IS NULL
     OR nullif(btrim(coalesce(p_disclosure_version,'')),'') IS NULL
     OR nullif(btrim(coalesce(p_consent_version,'')),'') IS NULL
     OR nullif(btrim(coalesce(p_idempotency_key,'')),'') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='ACCEPTANCE_INPUT_REQUIRED';
  END IF;

  IF p_session_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_policy_hash !~ '^[0-9a-f]{64}$'
     OR length(p_idempotency_key) < 8
     OR length(p_idempotency_key) > 128 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='ACCEPTANCE_INPUT_INVALID';
  END IF;

  SELECT * INTO v_user
  FROM public.users
  WHERE pi_uid=btrim(p_verified_pi_uid);

  IF NOT FOUND OR v_user.network <> 'mainnet' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='MAINNET_PI_IDENTITY_NOT_FOUND';
  END IF;

  SELECT * INTO v_project
  FROM public.projects
  WHERE id=p_project_id
    AND network='mainnet'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='PROJECT_NOT_FOUND';
  END IF;

  IF lower(coalesce(v_project.project_type,'')) NOT IN ('core','internal','external') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='PROJECT_TYPE_MISMATCH';
  END IF;

  IF lower(coalesce(v_project.status,'')) <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='PROJECT_NOT_ACTIVE';
  END IF;

  SELECT * INTO v_term
  FROM public.project_staking_term_versions
  WHERE id=p_term_version_id
    AND project_id=v_project.id
    AND project_code=v_project.project_code
    AND network='mainnet'
    AND term_status='published'
    AND effective_from <= clock_timestamp()
    AND (effective_until IS NULL OR effective_until > clock_timestamp())
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='TERM_NOT_PUBLISHED_OR_NOT_EFFECTIVE';
  END IF;

  IF nullif(btrim(coalesce(v_term.disclosure_version,'')),'') IS NULL
     OR nullif(btrim(coalesce(v_term.consent_version,'')),'') IS NULL
     OR v_term.disclosure_version <> p_disclosure_version
     OR v_term.consent_version <> p_consent_version THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='TERM_DISCLOSURE_OR_CONSENT_VERSION_MISMATCH';
  END IF;

  SELECT * INTO v_policy
  FROM albukhr_security.staking_policy_revisions
  WHERE policy_document_id='ALB-FIN-GOV-SPEC-001'
    AND policy_revision=p_policy_revision
    AND policy_hash=p_policy_hash
    AND approval_status='approved'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='POLICY_REVISION_OR_HASH_NOT_APPROVED';
  END IF;

  v_term_snapshot := jsonb_build_object(
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

  v_term_hash := encode(
    extensions.digest(convert_to(v_term_snapshot::text,'UTF8'),'sha256'),
    'hex'
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      v_project.id::text || '|' || v_user.pi_uid || '|' ||
      v_term.id::text || '|' || v_policy.id::text || '|' || p_session_fingerprint,
      0
    )
  );

  SELECT * INTO v_existing
  FROM albukhr_security.project_staking_policy_acceptances
  WHERE network='mainnet'
    AND idempotency_key=p_idempotency_key;

  IF FOUND THEN
    IF v_existing.project_id <> v_project.id
       OR v_existing.term_version_id <> v_term.id
       OR v_existing.user_id <> v_user.id
       OR v_existing.pi_uid <> v_user.pi_uid
       OR v_existing.policy_revision_id <> v_policy.id
       OR v_existing.policy_hash <> v_policy.policy_hash
       OR v_existing.term_hash <> v_term_hash
       OR v_existing.session_fingerprint <> p_session_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='IDEMPOTENCY_CONFLICT';
    END IF;

    RETURN jsonb_build_object(
      'contract_version','staking_policy_acceptance_v2',
      'acceptance_id',v_existing.id,
      'accepted_at_utc',v_existing.accepted_at_utc,
      'term_hash',v_existing.term_hash,
      'policy_hash',v_existing.policy_hash,
      'policy_revision',v_existing.policy_revision,
      'replayed',true
    );
  END IF;

  SELECT * INTO v_existing
  FROM albukhr_security.project_staking_policy_acceptances
  WHERE project_id=v_project.id
    AND network='mainnet'
    AND pi_uid=v_user.pi_uid
    AND term_version_id=v_term.id
    AND policy_revision_id=v_policy.id
    AND session_fingerprint=p_session_fingerprint;

  IF FOUND THEN
    IF v_existing.term_hash <> v_term_hash
       OR v_existing.policy_hash <> v_policy.policy_hash
       OR v_existing.disclosure_version <> v_term.disclosure_version
       OR v_existing.consent_version <> v_term.consent_version THEN
      RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='EXISTING_ACCEPTANCE_CONFLICT';
    END IF;

    RETURN jsonb_build_object(
      'contract_version','staking_policy_acceptance_v2',
      'acceptance_id',v_existing.id,
      'accepted_at_utc',v_existing.accepted_at_utc,
      'term_hash',v_existing.term_hash,
      'policy_hash',v_existing.policy_hash,
      'policy_revision',v_existing.policy_revision,
      'replayed',true
    );
  END IF;

  INSERT INTO albukhr_security.project_staking_policy_acceptances (
    project_id,project_code,project_type,user_id,pi_uid,network,
    term_version_id,policy_revision_id,policy_document_id,policy_revision,
    policy_hash,term_hash,disclosure_version,consent_version,term_snapshot,
    session_fingerprint,idempotency_key
  )
  VALUES (
    v_project.id,v_project.project_code,lower(v_project.project_type),
    v_user.id,v_user.pi_uid,'mainnet',
    v_term.id,v_policy.id,v_policy.policy_document_id,v_policy.policy_revision,
    v_policy.policy_hash,v_term_hash,v_term.disclosure_version,v_term.consent_version,
    v_term_snapshot,p_session_fingerprint,p_idempotency_key
  )
  RETURNING id,accepted_at_utc INTO v_acceptance_id,v_accepted_at;

  RETURN jsonb_build_object(
    'contract_version','staking_policy_acceptance_v2',
    'acceptance_id',v_acceptance_id,
    'accepted_at_utc',v_accepted_at,
    'term_hash',v_term_hash,
    'policy_hash',v_policy.policy_hash,
    'policy_revision',v_policy.policy_revision,
    'replayed',false
  );
END;
$function$;

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid='albukhr_security.project_staking_policy_acceptances'::regclass
      AND conname='project_staking_policy_acceptance_subject_uq'
  ) THEN
    RAISE EXCEPTION 'WP2 session migration postflight failed: old subject constraint remains.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='albukhr_security.project_staking_policy_acceptances'::regclass
      AND conname='project_staking_policy_acceptance_subject_session_uq'
      AND contype='u'
  ) THEN
    RAISE EXCEPTION 'WP2 session migration postflight failed: per-session unique constraint is absent.';
  END IF;
END;
$postflight$;
