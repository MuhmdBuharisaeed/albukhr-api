BEGIN;

CREATE OR REPLACE FUNCTION albukhr_security.get_financial_custody_project_directory()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_super_admin boolean := false;
  v_projects jsonb := '[]'::jsonb;
BEGIN
  IF v_actor IS NULL
     OR coalesce(auth.jwt()->>'aal','aal1') <> 'aal2'
     OR NOT EXISTS (
       SELECT 1
       FROM albukhr_security.admin_users au
       WHERE au.user_id = v_actor
         AND au.status::text = 'active'
         AND au.mfa_required = true
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'authorized',false,'network','mainnet',
      'message','Active Mainnet Admin with mandatory AAL2 assurance is required.'
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM albukhr_security.admin_role_assignments ara
    WHERE ara.user_id = v_actor
      AND ara.role = 'super_admin'::albukhr_security.admin_role
      AND ara.active = true
      AND ara.revoked_at IS NULL
  ) INTO v_is_super_admin;

  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'project_id',p.id,
      'project_name',p.name,
      'project_code',p.project_code,
      'project_type',p.project_type,
      'status',p.status,
      'network','mainnet',
      'roles',pg_catalog.jsonb_build_object(
        'finance_treasury',albukhr_security.has_financial_control_role('finance_treasury',v_actor,p.id),
        'risk_compliance',albukhr_security.has_financial_control_role('risk_compliance',v_actor,p.id),
        'governance',albukhr_security.has_financial_control_role('governance',v_actor,p.id),
        'custody_signer',albukhr_security.has_financial_control_role('custody_signer',v_actor,p.id)
      )
    ) ORDER BY p.project_type,p.name,p.id
  ),'[]'::jsonb)
  INTO v_projects
  FROM public.projects p
  WHERE lower(pg_catalog.btrim(p.network)) = 'mainnet'
    AND lower(pg_catalog.btrim(p.status)) IN ('approved','active')
    AND (
      v_is_super_admin
      OR albukhr_security.has_financial_control_role('finance_treasury',v_actor,p.id)
      OR albukhr_security.has_financial_control_role('risk_compliance',v_actor,p.id)
      OR albukhr_security.has_financial_control_role('governance',v_actor,p.id)
      OR albukhr_security.has_financial_control_role('custody_signer',v_actor,p.id)
    );

  RETURN pg_catalog.jsonb_build_object(
    'success',true,
    'authorized',true,
    'network','mainnet',
    'viewer_user_id',v_actor,
    'is_super_admin',v_is_super_admin,
    'projects',v_projects
  );
END;
$function$;

CREATE OR REPLACE FUNCTION albukhr_security.get_financial_custody_project_workspace(
  p_project_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_super_admin boolean := false;
  v_project public.projects%rowtype;
  v_roles jsonb;
  v_accounts jsonb := '[]'::jsonb;
  v_review_events jsonb := '[]'::jsonb;
  v_external_context jsonb := NULL;
  v_application_id uuid;
  v_application_code text;
  v_profile albukhr_security.external_project_custody_profiles%rowtype;
  v_linked_accounts jsonb := '[]'::jsonb;
  v_readiness jsonb := '{}'::jsonb;
BEGIN
  IF v_actor IS NULL
     OR coalesce(auth.jwt()->>'aal','aal1') <> 'aal2'
     OR NOT EXISTS (
       SELECT 1
       FROM albukhr_security.admin_users au
       WHERE au.user_id = v_actor
         AND au.status::text = 'active'
         AND au.mfa_required = true
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'authorized',false,'network','mainnet',
      'message','Active Mainnet Admin with mandatory AAL2 assurance is required.'
    );
  END IF;

  IF p_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'authorized',false,'message','A Mainnet project ID is required.'
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM albukhr_security.admin_role_assignments ara
    WHERE ara.user_id = v_actor
      AND ara.role = 'super_admin'::albukhr_security.admin_role
      AND ara.active = true
      AND ara.revoked_at IS NULL
  ) INTO v_is_super_admin;

  SELECT * INTO v_project
  FROM public.projects p
  WHERE p.id = p_project_id
    AND lower(pg_catalog.btrim(p.network)) = 'mainnet'
    AND lower(pg_catalog.btrim(p.status)) IN ('approved','active');

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'authorized',false,'network','mainnet',
      'message','Only approved or active Mainnet projects are available in Global Custody.'
    );
  END IF;

  v_roles := pg_catalog.jsonb_build_object(
    'finance_treasury',albukhr_security.has_financial_control_role('finance_treasury',v_actor,p_project_id),
    'risk_compliance',albukhr_security.has_financial_control_role('risk_compliance',v_actor,p_project_id),
    'governance',albukhr_security.has_financial_control_role('governance',v_actor,p_project_id),
    'custody_signer',albukhr_security.has_financial_control_role('custody_signer',v_actor,p_project_id)
  );

  IF NOT v_is_super_admin
     AND coalesce((v_roles->>'finance_treasury')::boolean,false) = false
     AND coalesce((v_roles->>'risk_compliance')::boolean,false) = false
     AND coalesce((v_roles->>'governance')::boolean,false) = false
     AND coalesce((v_roles->>'custody_signer')::boolean,false) = false
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'authorized',false,'network','mainnet',
      'message','A project-scoped financial-control role or Super Admin read authority is required.'
    );
  END IF;

  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'account_id',a.id,
      'project_id',a.project_id,
      'network',a.network,
      'asset_code',a.asset_code,
      'fund_class',a.fund_class,
      'account_type',a.account_type,
      'custody_model',a.custody_model,
      'custody_provider',a.custody_provider,
      'account_reference',a.account_reference,
      'public_account_address',a.public_account_address,
      'version_number',a.version_number,
      'supersedes_account_id',a.supersedes_account_id,
      'submitted_by_ref',a.submitted_by_ref,
      'submitted_at',a.submitted_at,
      'verified',albukhr_security.financial_custody_account_is_verified(a.id,a.project_id),
      'evidence',(
        SELECT coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'evidence_id',e.id,
            'evidence_category',e.evidence_category,
            'source_kind',e.source_kind,
            'source_authority',e.source_authority,
            'evidence_reference',e.evidence_reference,
            'source_record_reference',e.source_record_reference,
            'content_sha256',e.content_sha256,
            'issued_at',e.issued_at,
            'source_observed_at',e.source_observed_at,
            'captured_at',e.captured_at,
            'expires_at',e.expires_at,
            'submitted_by_ref',e.submitted_by_ref,
            'latest_review',(
              SELECT pg_catalog.jsonb_build_object(
                'event_type',r.event_type,
                'reviewer_role_code',r.reviewer_role_code,
                'reviewer_admin_user_id',r.reviewer_admin_user_id,
                'reason',r.reason,
                'authority_reference',r.authority_reference,
                'created_at',r.created_at
              )
              FROM albukhr_security.financial_custody_review_events r
              WHERE r.evidence_id = e.id
                AND r.event_payload->>'review_scope' = 'evidence'
              ORDER BY r.created_at DESC,r.id DESC
              LIMIT 1
            )
          ) ORDER BY e.evidence_category,e.source_observed_at DESC,e.captured_at DESC
        ),'[]'::jsonb)
        FROM albukhr_security.financial_custody_evidence e
        WHERE e.account_id = a.id
          AND e.project_id = p_project_id
          AND e.network = 'mainnet'
          AND e.asset_code = 'PI'
      ),
      'latest_snapshot',(
        SELECT pg_catalog.jsonb_build_object(
          'snapshot_id',s.id,
          'evidence_id',s.evidence_id,
          'total_balance',s.total_balance,
          'available_balance',s.available_balance,
          'frozen_balance',s.frozen_balance,
          'pledged_balance',s.pledged_balance,
          'encumbered_balance',s.encumbered_balance,
          'unclassified_balance',s.unclassified_balance,
          'source_observed_at',s.source_observed_at,
          'captured_at',s.captured_at,
          'source_snapshot_reference',s.source_snapshot_reference,
          'snapshot_digest',s.snapshot_digest,
          'digest_valid',(s.snapshot_digest = albukhr_security.financial_custody_snapshot_sha256(s)),
          'latest_review',(
            SELECT pg_catalog.jsonb_build_object(
              'event_type',r.event_type,
              'reviewer_role_code',r.reviewer_role_code,
              'reviewer_admin_user_id',r.reviewer_admin_user_id,
              'reason',r.reason,
              'authority_reference',r.authority_reference,
              'created_at',r.created_at
            )
            FROM albukhr_security.financial_custody_review_events r
            WHERE r.snapshot_id = s.id
              AND r.event_payload->>'review_scope' = 'snapshot'
            ORDER BY r.created_at DESC,r.id DESC
            LIMIT 1
          )
        )
        FROM albukhr_security.financial_custody_balance_snapshots s
        WHERE s.account_id = a.id
          AND s.project_id = p_project_id
          AND s.network = 'mainnet'
          AND s.asset_code = 'PI'
        ORDER BY s.source_observed_at DESC,s.captured_at DESC,s.id DESC
        LIMIT 1
      )
    ) ORDER BY a.fund_class,a.account_reference,a.version_number DESC
  ),'[]'::jsonb)
  INTO v_accounts
  FROM albukhr_security.financial_custody_accounts a
  WHERE a.project_id = p_project_id
    AND a.network = 'mainnet'
    AND a.asset_code = 'PI'
    AND a.version_number = (
      SELECT max(a2.version_number)
      FROM albukhr_security.financial_custody_accounts a2
      WHERE a2.project_id = a.project_id
        AND a2.network = a.network
        AND a2.asset_code = a.asset_code
        AND a2.fund_class = a.fund_class
        AND a2.account_reference = a.account_reference
    );

  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'event_id',r.id,
      'account_id',r.account_id,
      'evidence_id',r.evidence_id,
      'snapshot_id',r.snapshot_id,
      'event_type',r.event_type,
      'reviewer_role_code',r.reviewer_role_code,
      'reviewer_admin_user_id',r.reviewer_admin_user_id,
      'reason',r.reason,
      'authority_reference',r.authority_reference,
      'event_payload',r.event_payload,
      'created_at',r.created_at
    ) ORDER BY r.created_at DESC,r.id DESC
  ),'[]'::jsonb)
  INTO v_review_events
  FROM (
    SELECT r.*
    FROM albukhr_security.financial_custody_review_events r
    WHERE r.project_id = p_project_id
      AND r.network = 'mainnet'
      AND r.asset_code = 'PI'
    ORDER BY r.created_at DESC,r.id DESC
    LIMIT 200
  ) r;

  SELECT a.id,a.application_code
    INTO v_application_id,v_application_code
  FROM public.external_project_applications a
  WHERE a.converted_project_id = p_project_id
    AND a.network = 'mainnet'
  ORDER BY a.updated_at DESC,a.created_at DESC
  LIMIT 1;

  IF v_application_id IS NOT NULL THEN
    SELECT * INTO v_profile
    FROM albukhr_security.external_project_custody_profiles p
    WHERE p.application_id = v_application_id
      AND p.project_id = p_project_id
      AND p.network = 'mainnet'
    ORDER BY p.version_number DESC
    LIMIT 1;

    IF v_profile.id IS NOT NULL THEN
      v_readiness := albukhr_security.external_project_global_custody_readiness(v_profile.id);

      SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'link_id',l.id,
          'account_id',l.account_id,
          'fund_class',l.fund_class,
          'purpose_code',l.purpose_code,
          'is_required',l.is_required,
          'account_reference',l.account_reference,
          'linked_by',l.linked_by,
          'linked_at',l.linked_at,
          'reason',l.reason,
          'verified',albukhr_security.financial_custody_account_is_verified(a.id,a.project_id)
        ) ORDER BY l.purpose_code,l.linked_at
      ),'[]'::jsonb)
      INTO v_linked_accounts
      FROM albukhr_security.external_project_custody_account_links l
      JOIN albukhr_security.financial_custody_accounts a
        ON a.id = l.account_id
       AND a.project_id = l.project_id
       AND a.network = l.network
       AND a.asset_code = l.asset_code
       AND a.fund_class = l.fund_class
       AND a.account_reference = l.account_reference
      WHERE l.profile_id = v_profile.id;

      v_external_context := pg_catalog.jsonb_build_object(
        'application_id',v_application_id,
        'application_code',v_application_code,
        'project_id',p_project_id,
        'profile',pg_catalog.jsonb_build_object(
          'profile_id',v_profile.id,
          'version_number',v_profile.version_number,
          'status',v_profile.status,
          'custody_requirement',v_profile.custody_requirement,
          'custody_model',v_profile.custody_model,
          'readiness_status',v_profile.readiness_status
        ),
        'linked_accounts',v_linked_accounts,
        'readiness',v_readiness
      );
    ELSE
      v_external_context := pg_catalog.jsonb_build_object(
        'application_id',v_application_id,
        'application_code',v_application_code,
        'project_id',p_project_id,
        'profile',NULL,
        'linked_accounts','[]'::jsonb,
        'readiness',pg_catalog.jsonb_build_object(
          'ready',false,
          'status','profile_not_found',
          'blockers',pg_catalog.jsonb_build_array('external_custody_profile_not_found')
        )
      );
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success',true,
    'authorized',true,
    'network','mainnet',
    'viewer_user_id',v_actor,
    'is_super_admin',v_is_super_admin,
    'project',pg_catalog.jsonb_build_object(
      'id',v_project.id,
      'name',v_project.name,
      'project_code',v_project.project_code,
      'project_type',v_project.project_type,
      'status',v_project.status,
      'network','mainnet'
    ),
    'roles',v_roles,
    'capabilities',pg_catalog.jsonb_build_object(
      'can_submit_accounts',coalesce((v_roles->>'finance_treasury')::boolean,false),
      'can_submit_evidence',coalesce((v_roles->>'finance_treasury')::boolean,false),
      'can_record_snapshots',coalesce((v_roles->>'finance_treasury')::boolean,false),
      'can_review',coalesce((v_roles->>'risk_compliance')::boolean,false),
      'can_verify_accounts',coalesce((v_roles->>'governance')::boolean,false),
      'can_link_external_custody',coalesce((v_roles->>'finance_treasury')::boolean,false)
    ),
    'accounts',v_accounts,
    'review_events',v_review_events,
    'external_custody',v_external_context
  );
END;
$function$;

CREATE OR REPLACE FUNCTION albukhr_security.link_external_project_custody_account_by_finance(
  p_profile_id uuid,
  p_account_id uuid,
  p_purpose_code text,
  p_is_required boolean DEFAULT true,
  p_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_profile albukhr_security.external_project_custody_profiles%rowtype;
  v_account albukhr_security.financial_custody_accounts%rowtype;
  v_latest_profile_version integer;
  v_link_id uuid;
  v_readiness jsonb;
BEGIN
  IF v_actor IS NULL OR coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'authorized',false,
      'message','An authenticated AAL2 Mainnet Admin is required.'
    );
  END IF;

  SELECT * INTO v_profile
  FROM albukhr_security.external_project_custody_profiles p
  WHERE p.id = p_profile_id
    AND p.network = 'mainnet'
  FOR UPDATE;

  IF NOT FOUND OR v_profile.project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'message','A converted Mainnet External custody profile is required.'
    );
  END IF;

  IF NOT albukhr_security.external_project_custody_profile_project_binding(v_profile.id) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'message','Custody profile project binding does not match the exact converted External Mainnet project.'
    );
  END IF;

  v_actor := albukhr_security.require_financial_custody_role(
    'finance_treasury',v_profile.project_id
  );

  SELECT coalesce(max(p.version_number),0)
    INTO v_latest_profile_version
  FROM albukhr_security.external_project_custody_profiles p
  WHERE p.application_id = v_profile.application_id
    AND p.network = 'mainnet';

  IF v_profile.version_number <> v_latest_profile_version
     OR v_profile.status NOT IN ('in_progress','blocked')
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'message','Only the latest in-progress or blocked custody profile can receive account links.'
    );
  END IF;

  IF coalesce(p_metadata,'{}'::jsonb) = 'null'::jsonb
     OR pg_catalog.jsonb_typeof(coalesce(p_metadata,'{}'::jsonb)) <> 'object'
     OR coalesce(pg_catalog.length(pg_catalog.btrim(p_reason)),0) < 3
     OR pg_catalog.length(pg_catalog.btrim(p_reason)) > 2000
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'message','A valid reason and JSON object metadata are required.'
    );
  END IF;

  IF p_purpose_code NOT IN (
    'principal_custody','project_operating','investor_escrow',
    'reward_reserve','withdrawal_liquidity_reserve','general_treasury',
    'payout_clearing'
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'message','Invalid External custody account purpose.'
    );
  END IF;

  IF p_purpose_code = 'principal_custody'
     AND p_is_required IS DISTINCT FROM true
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'message','The principal custody account link must be required.'
    );
  END IF;

  IF p_purpose_code = 'investor_escrow'
     AND (
       p_is_required IS DISTINCT FROM true
       OR v_profile.custody_model NOT IN ('escrow','controlled_release')
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,
      'message','Investor escrow must be required and must match an escrow or controlled-release custody model.'
    );
  END IF;

  SELECT * INTO v_account
  FROM albukhr_security.financial_custody_accounts a
  WHERE a.id = p_account_id
    AND a.project_id = v_profile.project_id
    AND a.network = 'mainnet'
    AND a.asset_code = 'PI'
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'message','The selected Global Custody account is not registered for this exact Mainnet External project and PI asset.'
    );
  END IF;

  IF v_account.version_number <> (
    SELECT max(a2.version_number)
    FROM albukhr_security.financial_custody_accounts a2
    WHERE a2.project_id = v_account.project_id
      AND a2.network = v_account.network
      AND a2.asset_code = v_account.asset_code
      AND a2.fund_class = v_account.fund_class
      AND a2.account_reference = v_account.account_reference
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'message','Only the latest version of a Global Custody account may be linked.'
    );
  END IF;

  IF NOT albukhr_security.financial_custody_account_is_verified(
    v_account.id,v_profile.project_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,
      'message','The Global Custody account is not fully verified. Ownership, control, fund segregation, current balance evidence, independent review and Governance verification are required.'
    );
  END IF;

  IF p_purpose_code = 'investor_escrow' THEN
    IF v_account.fund_class <> 'escrow'
       OR v_account.custody_model NOT IN ('escrow','controlled_release')
       OR v_account.account_type <> 'escrow_account'
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success',false,'message','Investor escrow must link to a verified PI escrow account with a matching custody model.'
      );
    END IF;
  ELSIF p_purpose_code = 'principal_custody' THEN
    IF v_account.fund_class <> 'principal' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success',false,'message','Principal custody requires the principal fund class.'
      );
    END IF;

    IF v_profile.custody_model = 'third_party_custodian'
       AND (
         v_account.custody_model <> 'third_party_custodian'
         OR v_account.account_type NOT IN ('custodial_wallet','third_party_account')
       )
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success',false,'message','Third-party custody requires a verified third-party PI account.'
      );
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'external-custody-link:'||v_profile.id::text||':'||
      v_account.id::text||':'||p_purpose_code,
      0
    )
  );

  INSERT INTO albukhr_security.external_project_custody_account_links (
    profile_id,application_id,project_id,network,asset_code,
    account_id,fund_class,account_reference,purpose_code,
    is_required,linked_by,reason,metadata
  ) VALUES (
    v_profile.id,v_profile.application_id,v_profile.project_id,'mainnet','PI',
    v_account.id,v_account.fund_class,v_account.account_reference,p_purpose_code,
    p_is_required,v_actor,pg_catalog.btrim(p_reason),coalesce(p_metadata,'{}'::jsonb)
  )
  RETURNING id INTO v_link_id;

  PERFORM albukhr_security.external_application_log(
    v_profile.application_id,
    v_actor,
    'external_global_custody_account_linked',
    NULL,
    NULL,
    pg_catalog.jsonb_build_object(
      'profile_id',v_profile.id,
      'profile_version',v_profile.version_number,
      'project_id',v_profile.project_id,
      'account_link_id',v_link_id,
      'account_id',v_account.id,
      'account_version',v_account.version_number,
      'fund_class',v_account.fund_class,
      'purpose_code',p_purpose_code,
      'is_required',p_is_required,
      'network','mainnet',
      'asset_code','PI',
      'authorization_scope','project_finance_treasury'
    )
  );

  v_readiness := albukhr_security.external_project_global_custody_readiness(v_profile.id);

  RETURN pg_catalog.jsonb_build_object(
    'success',true,
    'account_link_id',v_link_id,
    'profile_id',v_profile.id,
    'account_id',v_account.id,
    'purpose_code',p_purpose_code,
    'global_custody_readiness',v_readiness
  );
END;
$function$;

REVOKE ALL ON FUNCTION albukhr_security.get_financial_custody_project_directory() FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION albukhr_security.get_financial_custody_project_workspace(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION albukhr_security.link_external_project_custody_account_by_finance(uuid,uuid,text,boolean,text,jsonb) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION albukhr_security.get_financial_custody_project_directory() TO authenticated;
GRANT EXECUTE ON FUNCTION albukhr_security.get_financial_custody_project_workspace(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION albukhr_security.link_external_project_custody_account_by_finance(uuid,uuid,text,boolean,text,jsonb) TO authenticated;

COMMIT;
