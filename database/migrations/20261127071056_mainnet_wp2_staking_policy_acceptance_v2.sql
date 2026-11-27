-- ALBUKHR Mainnet WP2 / DB-02
-- Global policy revision registry + append-only project staking acceptance.
-- Mainnet-only. Does not publish or rewrite existing staking terms.

DO $preflight$
BEGIN
  IF to_regclass('public.projects') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.project_staking_term_versions') IS NULL THEN
    RAISE EXCEPTION 'WP2 preflight failed: required Mainnet identity/project/term tables are missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ANY(i.indkey)
    WHERE n.nspname='public'
      AND t.relname='users'
      AND i.indisunique
      AND i.indisvalid
      AND i.indpred IS NULL
      AND a.attname='pi_uid'
  ) THEN
    RAISE EXCEPTION 'WP2 preflight failed: users.pi_uid is not protected by a valid unique index.';
  END IF;

  IF EXISTS (
    SELECT pi_uid
    FROM public.users
    WHERE network='mainnet'
    GROUP BY pi_uid
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'WP2 preflight failed: duplicate Mainnet Pi UID mappings exist.';
  END IF;

  IF to_regclass('albukhr_security.staking_policy_revisions') IS NOT NULL
     OR to_regclass('albukhr_security.project_staking_policy_acceptances') IS NOT NULL
     OR to_regprocedure('albukhr_security.record_staking_policy_acceptance_v2(uuid,uuid,text,text,text,text,text,text,text)') IS NOT NULL
     OR to_regprocedure('albukhr_security.validate_staking_policy_acceptance_v2(uuid,uuid,uuid,text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'WP2 preflight failed: one or more target names already exist; manual drift review required.';
  END IF;
END;
$preflight$;

CREATE TABLE albukhr_security.staking_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_document_id text NOT NULL,
  policy_revision text NOT NULL,
  policy_hash text NOT NULL,
  source_artifact_sha256 text NOT NULL,
  source_artifact_label text NOT NULL,
  approval_status text NOT NULL CHECK (approval_status IN ('approved','candidate','retired')),
  approved_on date,
  created_at_utc timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT staking_policy_revisions_hash_ck
    CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT staking_policy_revisions_artifact_hash_ck
    CHECK (source_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT staking_policy_revisions_document_revision_uq
    UNIQUE (policy_document_id, policy_revision)
);

ALTER TABLE albukhr_security.staking_policy_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE albukhr_security.staking_policy_revisions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE albukhr_security.staking_policy_revisions
FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE albukhr_security.project_staking_policy_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL,
  project_type text NOT NULL CHECK (project_type IN ('core','internal','external')),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  pi_uid text NOT NULL,
  network text NOT NULL DEFAULT 'mainnet' CHECK (network='mainnet'),
  term_version_id uuid NOT NULL REFERENCES public.project_staking_term_versions(id) ON DELETE RESTRICT,
  policy_revision_id uuid NOT NULL REFERENCES albukhr_security.staking_policy_revisions(id) ON DELETE RESTRICT,
  policy_document_id text NOT NULL,
  policy_revision text NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  term_hash text NOT NULL CHECK (term_hash ~ '^[0-9a-f]{64}$'),
  disclosure_version text NOT NULL,
  consent_version text NOT NULL,
  term_snapshot jsonb NOT NULL,
  session_fingerprint text NOT NULL CHECK (session_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL,
  accepted_at_utc timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT project_staking_policy_acceptance_idempotency_uq
    UNIQUE (network, idempotency_key),
  CONSTRAINT project_staking_policy_acceptance_subject_uq
    UNIQUE (project_id, network, pi_uid, term_version_id, policy_revision_id)
);

CREATE INDEX project_staking_policy_acceptances_user_idx
  ON albukhr_security.project_staking_policy_acceptances
  (user_id, network, accepted_at_utc DESC);

CREATE INDEX project_staking_policy_acceptances_project_idx
  ON albukhr_security.project_staking_policy_acceptances
  (project_id, network, term_version_id);

ALTER TABLE albukhr_security.project_staking_policy_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE albukhr_security.project_staking_policy_acceptances FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE albukhr_security.project_staking_policy_acceptances
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION albukhr_security.prevent_staking_policy_record_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE='55000',
    MESSAGE='POLICY_ACCEPTANCE_RECORDS_ARE_APPEND_ONLY';
END;
$function$;

REVOKE ALL ON FUNCTION albukhr_security.prevent_staking_policy_record_mutation_v1()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER staking_policy_revisions_append_only
BEFORE UPDATE OR DELETE ON albukhr_security.staking_policy_revisions
FOR EACH ROW EXECUTE FUNCTION albukhr_security.prevent_staking_policy_record_mutation_v1();

CREATE TRIGGER staking_policy_acceptances_append_only
BEFORE UPDATE OR DELETE ON albukhr_security.project_staking_policy_acceptances
FOR EACH ROW EXECUTE FUNCTION albukhr_security.prevent_staking_policy_record_mutation_v1();

INSERT INTO albukhr_security.staking_policy_revisions (
  policy_document_id,
  policy_revision,
  policy_hash,
  source_artifact_sha256,
  source_artifact_label,
  approval_status,
  approved_on
)
VALUES (
  'ALB-FIN-GOV-SPEC-001',
  '1.0',
  '10628e807af23ebe6a08ed56608ed32865c03f037c6ab3244fb033fbc4b51d7a',
  '10628e807af23ebe6a08ed56608ed32865c03f037c6ab3244fb033fbc4b51d7a',
  'Approved Global Financial Governance Standard v1.0 — 25 November 2026',
  'approved',
  DATE '2026-11-25'
)
ON CONFLICT (policy_document_id, policy_revision) DO NOTHING;

DO $policy_seed_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM albukhr_security.staking_policy_revisions
    WHERE policy_document_id='ALB-FIN-GOV-SPEC-001'
      AND policy_revision='1.0'
      AND policy_hash='10628e807af23ebe6a08ed56608ed32865c03f037c6ab3244fb033fbc4b51d7a'
      AND source_artifact_sha256='10628e807af23ebe6a08ed56608ed32865c03f037c6ab3244fb033fbc4b51d7a'
      AND approval_status='approved'
  ) THEN
    RAISE EXCEPTION 'WP2 policy seed verification failed: the approved v1.0 policy hash does not match.';
  END IF;
END;
$policy_seed_check$;

CREATE FUNCTION albukhr_security.record_staking_policy_acceptance_v2(
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
      v_term.id::text || '|' || v_policy.id::text,
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
    AND policy_revision_id=v_policy.id;

  IF FOUND THEN
    IF v_existing.term_hash <> v_term_hash
       OR v_existing.policy_hash <> v_policy.policy_hash
       OR v_existing.disclosure_version <> v_term.disclosure_version
       OR v_existing.consent_version <> v_term.consent_version
       OR v_existing.session_fingerprint <> p_session_fingerprint THEN
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

CREATE FUNCTION albukhr_security.validate_staking_policy_acceptance_v2(
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
  v_acceptance albukhr_security.project_staking_policy_acceptances%ROWTYPE;
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

REVOKE ALL ON FUNCTION albukhr_security.record_staking_policy_acceptance_v2(
  uuid,uuid,text,text,text,text,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION albukhr_security.record_staking_policy_acceptance_v2(
  uuid,uuid,text,text,text,text,text,text,text
) TO service_role;

REVOKE ALL ON FUNCTION albukhr_security.validate_staking_policy_acceptance_v2(
  uuid,uuid,uuid,text,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION albukhr_security.validate_staking_policy_acceptance_v2(
  uuid,uuid,uuid,text,text,text,text
) TO service_role;

COMMENT ON TABLE albukhr_security.staking_policy_revisions
IS 'Immutable approved global financial policy revisions used for project staking disclosures and investor acceptance.';
COMMENT ON TABLE albukhr_security.project_staking_policy_acceptances
IS 'Append-only Mainnet investor acceptance records bound to exact project, user, session, staking term and approved policy hashes.';
COMMENT ON FUNCTION albukhr_security.record_staking_policy_acceptance_v2(
  uuid,uuid,text,text,text,text,text,text,text
)
IS 'Service-only Mainnet acceptance recorder. Identity is server-verified from Pi access token; session fingerprint is SHA-256 of that token.';
COMMENT ON FUNCTION albukhr_security.validate_staking_policy_acceptance_v2(
  uuid,uuid,uuid,text,text,text,text
)
IS 'Service-only Mainnet acceptance verifier used by investment gateways before U2A payment approval/completion.';
