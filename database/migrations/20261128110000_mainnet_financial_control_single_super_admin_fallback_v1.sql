-- Mainnet-only financial-control authorization fallback.
-- With exactly one active Super Admin, the sole Super Admin may approve a
-- financial-control role change for a different active MFA-required Admin.
-- When more than one active Super Admin exists, distinct second approval remains mandatory.
-- This migration does not appoint a Super Admin and does not alter Admin invitation policy.
BEGIN;

ALTER TABLE albukhr_security.financial_control_role_change_requests
  ADD COLUMN authorization_mode text NOT NULL DEFAULT 'dual_super_admin',
  ADD CONSTRAINT financial_control_requests_authorization_mode_ck
    CHECK (authorization_mode IN ('single_super_admin','dual_super_admin'));

ALTER TABLE albukhr_security.financial_control_role_grants
  ADD COLUMN authorization_mode text NOT NULL DEFAULT 'dual_super_admin',
  ADD CONSTRAINT financial_control_grants_authorization_mode_ck
    CHECK (authorization_mode IN ('single_super_admin','dual_super_admin'));

ALTER TABLE albukhr_security.financial_control_role_revocations
  ADD COLUMN authorization_mode text NOT NULL DEFAULT 'dual_super_admin',
  ADD CONSTRAINT financial_control_revocations_authorization_mode_ck
    CHECK (authorization_mode IN ('single_super_admin','dual_super_admin'));

ALTER TABLE albukhr_security.financial_control_role_change_requests
  DROP CONSTRAINT financial_control_requests_approval_ck,
  ADD CONSTRAINT financial_control_requests_approval_ck CHECK (
    status <> 'approved'
    OR (
      approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by <> target_user_id
      AND (
        (authorization_mode = 'single_super_admin' AND approved_by = requested_by)
        OR (authorization_mode = 'dual_super_admin' AND approved_by <> requested_by)
      )
    )
  ),
  ADD CONSTRAINT financial_control_requests_pending_mode_ck
    CHECK (status <> 'pending_second_approval' OR authorization_mode = 'dual_super_admin');

ALTER TABLE albukhr_security.financial_control_role_grants
  DROP CONSTRAINT financial_control_grants_separation_ck,
  ADD CONSTRAINT financial_control_grants_separation_ck CHECK (
    target_user_id <> requested_by AND target_user_id <> approved_by
    AND (
      (authorization_mode = 'single_super_admin' AND requested_by = approved_by)
      OR (authorization_mode = 'dual_super_admin' AND requested_by <> approved_by)
    )
  );

ALTER TABLE albukhr_security.financial_control_role_revocations
  DROP CONSTRAINT financial_control_revocations_separation_ck,
  ADD CONSTRAINT financial_control_revocations_separation_ck CHECK (
    target_user_id <> requested_by AND target_user_id <> approved_by
    AND (
      (authorization_mode = 'single_super_admin' AND requested_by = approved_by)
      OR (authorization_mode = 'dual_super_admin' AND requested_by <> approved_by)
    )
  );

CREATE OR REPLACE FUNCTION albukhr_security.request_financial_control_role_change(
  p_request_type text,
  p_target_user_id uuid,
  p_role_code text,
  p_scope_type text,
  p_project_id uuid,
  p_target_grant_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid;
  v_role albukhr_security.financial_control_role_catalog%rowtype;
  v_grant albukhr_security.financial_control_role_grants%rowtype;
  v_request_id uuid;
  v_grant_id uuid;
  v_revocation_id uuid;
  v_active_super_admin_count bigint;
  v_authorization_mode text;
  v_initial_status text;
  v_now timestamptz := pg_catalog.now();
BEGIN
  v_actor := albukhr_security.assert_financial_control_super_admin();
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('albukhr:financial-control:super-admin-mode',0)
  );

  SELECT pg_catalog.count(DISTINCT ara.user_id)
    INTO v_active_super_admin_count
  FROM albukhr_security.admin_users au
  JOIN albukhr_security.admin_role_assignments ara ON ara.user_id = au.user_id
  WHERE au.status::text = 'active'
    AND ara.role = 'super_admin'::albukhr_security.admin_role
    AND ara.active = true AND ara.revoked_at IS NULL;

  IF v_active_super_admin_count < 1 THEN
    RAISE EXCEPTION 'An active Mainnet Super Admin is required.' USING errcode = '42501';
  ELSIF v_active_super_admin_count = 1 THEN
    v_authorization_mode := 'single_super_admin';
    v_initial_status := 'approved';
  ELSE
    v_authorization_mode := 'dual_super_admin';
    v_initial_status := 'pending_second_approval';
  END IF;

  IF coalesce(p_request_type,'') NOT IN ('grant','revoke') THEN
    RAISE EXCEPTION 'Request type must be grant or revoke.' USING errcode = '22023';
  END IF;
  IF p_target_user_id IS NULL OR p_target_user_id = v_actor THEN
    RAISE EXCEPTION 'The target admin must be a different user from the Super Admin.' USING errcode = '22023';
  END IF;
  IF length(btrim(coalesce(p_reason,''))) < 10 OR length(btrim(p_reason)) > 2000 THEN
    RAISE EXCEPTION 'A reason between 10 and 2,000 characters is required.' USING errcode = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('financial-control-role:' || p_target_user_id::text,0)
  );
  IF NOT EXISTS (
    SELECT 1 FROM albukhr_security.admin_users au
    WHERE au.user_id = p_target_user_id AND au.status::text = 'active'
      AND au.mfa_required = true
  ) THEN
    RAISE EXCEPTION 'Target must be an active ALBUKHR Admin with mandatory MFA.' USING errcode = '22023';
  END IF;

  SELECT * INTO v_role FROM albukhr_security.financial_control_role_catalog c
  WHERE c.role_code = p_role_code AND c.enabled = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial control role is unknown or disabled.' USING errcode = '22023';
  END IF;

  IF coalesce(p_scope_type,'') NOT IN ('global','project')
     OR (p_scope_type = 'global' AND p_project_id IS NOT NULL)
     OR (p_scope_type = 'project' AND p_project_id IS NULL) THEN
    RAISE EXCEPTION 'Role scope must be global with no project, or project-scoped with a project ID.' USING errcode = '22023';
  END IF;
  IF p_scope_type = 'project' AND NOT EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = p_project_id
      AND lower(btrim(p.network)) = 'mainnet'
      AND lower(btrim(p.status)) IN ('approved','active')
  ) THEN
    RAISE EXCEPTION 'Project scope must reference an approved or active Mainnet project.' USING errcode = '22023';
  END IF;

  IF p_request_type = 'grant' THEN
    IF p_target_grant_id IS NOT NULL THEN
      RAISE EXCEPTION 'Grant requests cannot include an existing grant ID.' USING errcode = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM albukhr_security.financial_control_role_grants g
      WHERE g.target_user_id = p_target_user_id
        AND (p_scope_type = 'global' OR g.scope_type = 'global'
          OR (g.scope_type = 'project' AND p_scope_type = 'project' AND g.project_id = p_project_id))
        AND NOT EXISTS (
          SELECT 1 FROM albukhr_security.financial_control_role_revocations r WHERE r.grant_id = g.id
        )
    ) THEN
      RAISE EXCEPTION 'Target already holds a conflicting financial control role in this scope.' USING errcode = '23505';
    END IF;
  ELSE
    IF p_target_grant_id IS NULL THEN
      RAISE EXCEPTION 'A revoke request must identify the exact active role grant.' USING errcode = '22023';
    END IF;
    SELECT * INTO v_grant FROM albukhr_security.financial_control_role_grants g
    WHERE g.id = p_target_grant_id AND g.target_user_id = p_target_user_id
      AND g.role_code = p_role_code AND g.scope_type = p_scope_type
      AND g.project_id IS NOT DISTINCT FROM p_project_id FOR UPDATE;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM albukhr_security.financial_control_role_revocations r WHERE r.grant_id = p_target_grant_id
    ) THEN
      RAISE EXCEPTION 'The referenced financial control grant is not active or does not match the target and scope.' USING errcode = '22023';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM albukhr_security.financial_control_role_change_requests q
    WHERE q.status = 'pending_second_approval' AND q.target_user_id = p_target_user_id
      AND q.role_code = p_role_code AND q.scope_type = p_scope_type
      AND q.project_id IS NOT DISTINCT FROM p_project_id
  ) THEN
    RAISE EXCEPTION 'A pending change request already exists for this target role and scope.' USING errcode = '23505';
  END IF;

  INSERT INTO albukhr_security.financial_control_role_change_requests (
    request_type,role_code,target_user_id,scope_type,project_id,target_grant_id,
    reason,requested_by,authorization_mode,status,approved_by,approved_at
  ) VALUES (
    p_request_type,p_role_code,p_target_user_id,p_scope_type,p_project_id,p_target_grant_id,
    btrim(p_reason),v_actor,v_authorization_mode,v_initial_status,
    CASE WHEN v_authorization_mode = 'single_super_admin' THEN v_actor ELSE NULL END,
    CASE WHEN v_authorization_mode = 'single_super_admin' THEN v_now ELSE NULL END
  ) RETURNING id INTO v_request_id;

  INSERT INTO albukhr_security.financial_control_role_change_events (
    request_id,event_type,actor_user_id,reason,event_payload
  ) VALUES (
    v_request_id,'request_created',v_actor,btrim(p_reason),
    pg_catalog.jsonb_build_object(
      'request_type',p_request_type,'role_code',p_role_code,'target_user_id',p_target_user_id,
      'scope_type',p_scope_type,'project_id',p_project_id,'target_grant_id',p_target_grant_id,
      'authorization_mode',v_authorization_mode,'network','mainnet'
    )
  );

  IF v_authorization_mode = 'single_super_admin' THEN
    IF p_request_type = 'grant' THEN
      INSERT INTO albukhr_security.financial_control_role_grants (
        request_id,network,role_code,target_user_id,scope_type,project_id,requested_by,approved_by,authorization_mode
      ) VALUES (
        v_request_id,'mainnet',p_role_code,p_target_user_id,p_scope_type,p_project_id,v_actor,v_actor,'single_super_admin'
      ) RETURNING id INTO v_grant_id;
    ELSE
      INSERT INTO albukhr_security.financial_control_role_revocations (
        request_id,grant_id,network,target_user_id,role_code,scope_type,project_id,requested_by,approved_by,authorization_mode
      ) VALUES (
        v_request_id,v_grant.id,'mainnet',p_target_user_id,p_role_code,p_scope_type,p_project_id,v_actor,v_actor,'single_super_admin'
      ) RETURNING id INTO v_revocation_id;
    END IF;

    INSERT INTO albukhr_security.financial_control_role_change_events (
      request_id,event_type,actor_user_id,reason,event_payload
    ) VALUES (
      v_request_id,'request_approved',v_actor,
      'Approved by the sole active Mainnet AAL2 Super Admin under the single-Super-Admin governance rule.',
      pg_catalog.jsonb_build_object(
        'request_type',p_request_type,'role_code',p_role_code,'target_user_id',p_target_user_id,
        'grant_id',v_grant_id,'revocation_id',v_revocation_id,
        'authorization_mode','single_super_admin','network','mainnet'
      )
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success',true,'request_id',v_request_id,'status',v_initial_status,
    'request_type',p_request_type,'role_code',p_role_code,'target_user_id',p_target_user_id,
    'scope_type',p_scope_type,'project_id',p_project_id,'grant_id',v_grant_id,
    'revocation_id',v_revocation_id,'authorization_mode',v_authorization_mode,
    'requires_distinct_super_admin_approval',(v_authorization_mode = 'dual_super_admin')
  );
END;
$function$;

CREATE OR REPLACE FUNCTION albukhr_security.approve_financial_control_role_change(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid;
  v_request albukhr_security.financial_control_role_change_requests%rowtype;
  v_grant albukhr_security.financial_control_role_grants%rowtype;
  v_grant_id uuid;
  v_revocation_id uuid;
BEGIN
  v_actor := albukhr_security.assert_financial_control_super_admin();
  SELECT * INTO v_request FROM albukhr_security.financial_control_role_change_requests q
  WHERE q.id = p_request_id AND q.network = 'mainnet' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Financial control role request was not found on Mainnet.' USING errcode = 'P0002'; END IF;
  IF v_request.status <> 'pending_second_approval' OR v_request.authorization_mode <> 'dual_super_admin' THEN
    RAISE EXCEPTION 'Only requests awaiting dual Super Admin approval can be approved.' USING errcode = '55000';
  END IF;
  IF v_actor = v_request.requested_by OR v_actor = v_request.target_user_id THEN
    RAISE EXCEPTION 'The requester and the target admin cannot approve this request.' USING errcode = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('financial-control-role:' || v_request.target_user_id::text,0));
  IF NOT EXISTS (
    SELECT 1 FROM albukhr_security.admin_users au
    WHERE au.user_id = v_request.target_user_id AND au.status::text = 'active' AND au.mfa_required = true
  ) THEN RAISE EXCEPTION 'Target admin is no longer active or mandatory MFA is disabled.' USING errcode = '55000'; END IF;
  IF v_request.scope_type = 'project' AND NOT EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = v_request.project_id
      AND lower(btrim(p.network)) = 'mainnet' AND lower(btrim(p.status)) IN ('approved','active')
  ) THEN RAISE EXCEPTION 'Project scope is no longer eligible on Mainnet.' USING errcode = '55000'; END IF;

  IF v_request.request_type = 'grant' THEN
    IF EXISTS (
      SELECT 1 FROM albukhr_security.financial_control_role_grants g
      WHERE g.target_user_id = v_request.target_user_id
        AND (v_request.scope_type = 'global' OR g.scope_type = 'global'
          OR (g.scope_type = 'project' AND v_request.scope_type = 'project' AND g.project_id = v_request.project_id))
        AND NOT EXISTS (SELECT 1 FROM albukhr_security.financial_control_role_revocations r WHERE r.grant_id = g.id)
    ) THEN RAISE EXCEPTION 'Target acquired a conflicting financial control role while this request was pending.' USING errcode = '23505'; END IF;
    INSERT INTO albukhr_security.financial_control_role_grants (
      request_id,network,role_code,target_user_id,scope_type,project_id,requested_by,approved_by,authorization_mode
    ) VALUES (
      v_request.id,'mainnet',v_request.role_code,v_request.target_user_id,v_request.scope_type,
      v_request.project_id,v_request.requested_by,v_actor,'dual_super_admin'
    ) RETURNING id INTO v_grant_id;
  ELSE
    SELECT * INTO v_grant FROM albukhr_security.financial_control_role_grants g
    WHERE g.id = v_request.target_grant_id AND g.target_user_id = v_request.target_user_id
      AND g.role_code = v_request.role_code AND g.scope_type = v_request.scope_type
      AND g.project_id IS NOT DISTINCT FROM v_request.project_id FOR UPDATE;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM albukhr_security.financial_control_role_revocations r WHERE r.grant_id = v_request.target_grant_id
    ) THEN RAISE EXCEPTION 'The role grant was already revoked or no longer matches the request.' USING errcode = '55000'; END IF;
    INSERT INTO albukhr_security.financial_control_role_revocations (
      request_id,grant_id,network,target_user_id,role_code,scope_type,project_id,requested_by,approved_by,authorization_mode
    ) VALUES (
      v_request.id,v_grant.id,'mainnet',v_request.target_user_id,v_request.role_code,v_request.scope_type,
      v_request.project_id,v_request.requested_by,v_actor,'dual_super_admin'
    ) RETURNING id INTO v_revocation_id;
  END IF;

  UPDATE albukhr_security.financial_control_role_change_requests
  SET status='approved',approved_by=v_actor,approved_at=pg_catalog.now() WHERE id=v_request.id;
  INSERT INTO albukhr_security.financial_control_role_change_events (
    request_id,event_type,actor_user_id,reason,event_payload
  ) VALUES (
    v_request.id,'request_approved',v_actor,'Approved by a second independent AAL2 Super Admin.',
    pg_catalog.jsonb_build_object(
      'request_type',v_request.request_type,'role_code',v_request.role_code,
      'target_user_id',v_request.target_user_id,'grant_id',v_grant_id,
      'revocation_id',v_revocation_id,'authorization_mode','dual_super_admin','network','mainnet'
    )
  );
  RETURN pg_catalog.jsonb_build_object(
    'success',true,'request_id',v_request.id,'status','approved','request_type',v_request.request_type,
    'grant_id',v_grant_id,'revocation_id',v_revocation_id,'requested_by',v_request.requested_by,
    'approved_by',v_actor,'authorization_mode','dual_super_admin'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION albukhr_security.reject_financial_control_role_change(p_request_id uuid,p_rejection_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_actor uuid; v_request albukhr_security.financial_control_role_change_requests%rowtype;
BEGIN
  v_actor := albukhr_security.assert_financial_control_super_admin();
  IF length(btrim(coalesce(p_rejection_reason,''))) < 10 OR length(btrim(p_rejection_reason)) > 2000 THEN
    RAISE EXCEPTION 'A rejection reason between 10 and 2,000 characters is required.' USING errcode = '22023';
  END IF;
  SELECT * INTO v_request FROM albukhr_security.financial_control_role_change_requests q
  WHERE q.id=p_request_id AND q.network='mainnet' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Financial control role request was not found on Mainnet.' USING errcode = 'P0002'; END IF;
  IF v_request.status <> 'pending_second_approval' OR v_request.authorization_mode <> 'dual_super_admin' THEN
    RAISE EXCEPTION 'Only requests awaiting dual Super Admin approval can be rejected.' USING errcode = '55000';
  END IF;
  IF v_actor=v_request.requested_by OR v_actor=v_request.target_user_id THEN
    RAISE EXCEPTION 'The requester and target admin cannot reject this request.' USING errcode = '42501';
  END IF;
  UPDATE albukhr_security.financial_control_role_change_requests
  SET status='rejected',rejected_by=v_actor,rejected_at=pg_catalog.now(),rejection_reason=btrim(p_rejection_reason)
  WHERE id=v_request.id;
  INSERT INTO albukhr_security.financial_control_role_change_events(request_id,event_type,actor_user_id,reason,event_payload)
  VALUES(v_request.id,'request_rejected',v_actor,btrim(p_rejection_reason),pg_catalog.jsonb_build_object(
    'request_type',v_request.request_type,'role_code',v_request.role_code,'target_user_id',v_request.target_user_id,
    'authorization_mode','dual_super_admin','network','mainnet'));
  RETURN pg_catalog.jsonb_build_object('success',true,'request_id',v_request.id,'status','rejected',
    'rejected_by',v_actor,'authorization_mode','dual_super_admin');
END;
$function$;

CREATE OR REPLACE FUNCTION albukhr_security.get_financial_control_role_workspace()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid;
  v_catalog jsonb;
  v_pending jsonb;
  v_active_grants jsonb;
  v_recent_events jsonb;
  v_active_super_admin_count bigint;
BEGIN
  v_actor := albukhr_security.assert_financial_control_super_admin();
  SELECT pg_catalog.count(DISTINCT ara.user_id) INTO v_active_super_admin_count
  FROM albukhr_security.admin_users au
  JOIN albukhr_security.admin_role_assignments ara ON ara.user_id=au.user_id
  WHERE au.status::text='active' AND ara.role='super_admin'::albukhr_security.admin_role
    AND ara.active=true AND ara.revoked_at IS NULL;

  SELECT coalesce(pg_catalog.jsonb_agg(to_jsonb(c) ORDER BY c.role_code),'[]'::jsonb)
    INTO v_catalog FROM albukhr_security.financial_control_role_catalog c WHERE c.enabled=true;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'request_id',q.id,'request_type',q.request_type,'role_code',q.role_code,'target_user_id',q.target_user_id,
    'scope_type',q.scope_type,'project_id',q.project_id,'reason',q.reason,'requested_by',q.requested_by,
    'requested_at',q.requested_at,'status',q.status,'target_grant_id',q.target_grant_id,
    'authorization_mode',q.authorization_mode) ORDER BY q.requested_at),'[]'::jsonb)
    INTO v_pending FROM albukhr_security.financial_control_role_change_requests q
    WHERE q.network='mainnet' AND q.status='pending_second_approval';
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'grant_id',g.id,'role_code',g.role_code,'target_user_id',g.target_user_id,'scope_type',g.scope_type,
    'project_id',g.project_id,'requested_by',g.requested_by,'approved_by',g.approved_by,
    'authorization_mode',g.authorization_mode,'granted_at',g.granted_at) ORDER BY g.granted_at DESC),'[]'::jsonb)
    INTO v_active_grants FROM albukhr_security.financial_control_role_grants g
    WHERE g.network='mainnet' AND NOT EXISTS (
      SELECT 1 FROM albukhr_security.financial_control_role_revocations r WHERE r.grant_id=g.id);
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'event_id',e.id,'request_id',e.request_id,'event_type',e.event_type,'actor_user_id',e.actor_user_id,
    'reason',e.reason,'event_payload',e.event_payload,'created_at',e.created_at) ORDER BY e.created_at DESC),'[]'::jsonb)
    INTO v_recent_events FROM (
      SELECT * FROM albukhr_security.financial_control_role_change_events ORDER BY created_at DESC LIMIT 100
    ) e;
  RETURN pg_catalog.jsonb_build_object(
    'success',true,'network','mainnet','viewer_user_id',v_actor,
    'active_super_admin_count',v_active_super_admin_count,
    'authorization_mode',CASE WHEN v_active_super_admin_count=1 THEN 'single_super_admin' ELSE 'dual_super_admin' END,
    'catalog',v_catalog,'pending_requests',v_pending,'active_assignments',v_active_grants,'recent_events',v_recent_events
  );
END;
$function$;

COMMIT;
