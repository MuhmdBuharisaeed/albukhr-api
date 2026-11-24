/*
 * ALBUKHR External Project Owner Contact & Team Amendments — Mainnet v1
 *
 * Adds an owner-request / admin-approval workflow for converted or approved
 * External Project applications. It does NOT transfer project ownership.
 *
 * Editable after approval, by approved amendment only:
 *   - application contact_email
 *   - application contact_phone
 *   - external_project_application_team members
 *
 * Immutable through this workflow:
 *   - applicant_user_id / canonical Pi identity
 *   - converted_project_id / project owner IDs
 *   - project identity, code, business identity, logo and documents
 *   - funding plans, liquidity, custody, withdrawals and investment state
 *
 * Apply once to the Mainnet Supabase project only after reviewing this file.
 */

CREATE TABLE IF NOT EXISTS public.external_project_amendment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL
    REFERENCES public.external_project_applications(id) ON DELETE RESTRICT,
  converted_project_id uuid NULL
    REFERENCES public.projects(id) ON DELETE SET NULL,
  applicant_user_id uuid NOT NULL
    REFERENCES public.users(id) ON DELETE RESTRICT,
  network text NOT NULL DEFAULT 'mainnet'
    CHECK (network = 'mainnet'),
  request_type text NOT NULL
    CHECK (request_type IN ('owner_contact', 'project_team')),
  reason text NOT NULL
    CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  current_values jsonb NOT NULL,
  requested_values jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  decision_reason text NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  reviewed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_project_amendment_queue_idx
  ON public.external_project_amendment_requests (network, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS external_project_amendment_owner_idx
  ON public.external_project_amendment_requests (application_id, applicant_user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS external_project_amendment_applicant_idx
  ON public.external_project_amendment_requests (applicant_user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS external_project_amendment_converted_project_idx
  ON public.external_project_amendment_requests (converted_project_id)
  WHERE converted_project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS external_project_amendment_one_pending_per_type_idx
  ON public.external_project_amendment_requests (application_id, request_type)
  WHERE network = 'mainnet' AND status = 'pending';

ALTER TABLE public.external_project_amendment_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.external_project_amendment_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.external_project_amendment_requests TO service_role;

/* --------------------------------------------------------------------------
 * Owner gateway: verified Pi identity is supplied only by the API server.
 * -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.gateway_create_my_external_project_amendment_trusted(
  p_pi_uid text,
  p_application_id uuid,
  p_request_type text,
  p_reason text,
  p_requested_values jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_user_id uuid;
  v_user_count integer;
  v_application public.external_project_applications%ROWTYPE;
  v_request_type text := lower(btrim(coalesce(p_request_type, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_current jsonb;
  v_requested jsonb;
  v_item jsonb;
  v_team jsonb := '[]'::jsonb;
  v_team_count integer := 0;
  v_primary_count integer := 0;
  v_full_name text;
  v_role text;
  v_title text;
  v_email text;
  v_phone text;
  v_bio text;
  v_primary boolean;
  v_request_id uuid;
BEGIN
  IF coalesce(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Trusted service gateway required.';
  END IF;

  IF NULLIF(btrim(coalesce(p_pi_uid, '')), '') IS NULL OR p_application_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Verified Pi identity and application ID are required.';
  END IF;
  IF v_request_type NOT IN ('owner_contact', 'project_team') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Unsupported amendment request type.';
  END IF;
  IF length(v_reason) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Explain the requested change in 10 to 2,000 characters.';
  END IF;
  IF p_requested_values IS NULL OR jsonb_typeof(p_requested_values) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Requested amendment values must be a JSON object.';
  END IF;

  SELECT count(*)::integer
    INTO v_user_count
  FROM public.users u
  WHERE u.pi_uid = btrim(p_pi_uid)
    AND lower(u.network) = 'mainnet';
  IF v_user_count <> 1 THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Mainnet ALBUKHR owner identity could not be resolved uniquely.';
  END IF;
  SELECT u.id INTO v_user_id FROM public.users u
  WHERE u.pi_uid = btrim(p_pi_uid) AND lower(u.network) = 'mainnet' LIMIT 1;

  SELECT * INTO v_application
  FROM public.external_project_applications a
  WHERE a.id = p_application_id
    AND a.applicant_user_id = v_user_id
    AND lower(a.network) = 'mainnet'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'External Project application not found or owner access denied.';
  END IF;
  IF lower(v_application.status) NOT IN ('approved', 'converted') THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Amendment requests are available only after approval or conversion.';
  END IF;

  IF lower(v_application.status) = 'converted' AND v_application.converted_project_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Converted External Project registry link is missing.';
  END IF;
  IF v_application.converted_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = v_application.converted_project_id
      AND lower(p.network) = 'mainnet'
      AND lower(p.project_type) = 'external'
      AND p.owner_albukhr_user_id = v_user_id
  ) THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Converted External Project owner linkage could not be verified.';
  END IF;

  IF v_request_type = 'owner_contact' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_requested_values) AS k(key)
      WHERE key NOT IN ('contact_email', 'contact_phone')
    ) THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'Only owner contact email and phone can be requested in an owner contact amendment.';
    END IF;

    v_email := btrim(coalesce(p_requested_values ->> 'contact_email', ''));
    v_email := lower(v_email);
    v_phone := NULL;
  END IF;

  IF v_request_type = 'owner_contact' THEN
    IF length(v_email) NOT BETWEEN 5 AND 254 OR v_email !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$' THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'Enter a valid owner contact email address.';
    END IF;
    v_phone := NULLIF(btrim(coalesce(p_requested_values ->> 'contact_phone', '')), '');
    IF v_phone IS NOT NULL AND length(v_phone) > 40 THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'Owner contact phone must be 40 characters or fewer.';
    END IF;

    v_current := jsonb_build_object(
      'contact_email', v_application.contact_email,
      'contact_phone', v_application.contact_phone
    );
    v_requested := jsonb_build_object(
      'contact_email', v_email,
      'contact_phone', v_phone
    );
  ELSE
    IF jsonb_typeof(p_requested_values -> 'team') IS DISTINCT FROM 'array' OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_requested_values) AS k(key)
      WHERE key <> 'team'
    ) THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'A project team amendment must contain only a team array.';
    END IF;

    v_team_count := jsonb_array_length(p_requested_values -> 'team');
    IF v_team_count < 1 OR v_team_count > 30 THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'A project team must contain between 1 and 30 members.';
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_requested_values -> 'team') AS x(value)
    LOOP
      IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'Each team member must be a JSON object.';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(v_item) AS k(key)
        WHERE key NOT IN ('full_name', 'email', 'role', 'title', 'bio', 'is_primary_contact')
      ) THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'A team member contains unsupported fields.';
      END IF;

      v_full_name := btrim(coalesce(v_item ->> 'full_name', ''));
      v_role := btrim(coalesce(v_item ->> 'role', ''));
      v_title := NULLIF(btrim(coalesce(v_item ->> 'title', '')), '');
      v_email := NULLIF(lower(btrim(coalesce(v_item ->> 'email', ''))), '');
      v_bio := NULLIF(btrim(coalesce(v_item ->> 'bio', '')), '');

      IF v_full_name = '' OR length(v_full_name) > 200 OR v_role = '' OR length(v_role) > 120 THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'Each team member requires a valid full name and role.';
      END IF;
      IF v_title IS NOT NULL AND length(v_title) > 120 THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'Team member title must be 120 characters or fewer.';
      END IF;
      IF v_bio IS NOT NULL AND length(v_bio) > 2000 THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'Team member biography must be 2,000 characters or fewer.';
      END IF;
      IF v_email IS NOT NULL AND (length(v_email) > 254 OR v_email !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$') THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'A team member email address is invalid.';
      END IF;
      IF coalesce(v_item ->> 'is_primary_contact', 'false') NOT IN ('true', 'false') THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'Primary contact must be true or false.';
      END IF;
      v_primary := coalesce((v_item ->> 'is_primary_contact')::boolean, false);
      IF v_primary THEN v_primary_count := v_primary_count + 1; END IF;

      v_team := v_team || jsonb_build_array(jsonb_build_object(
        'full_name', v_full_name,
        'email', v_email,
        'role', v_role,
        'title', v_title,
        'bio', v_bio,
        'is_primary_contact', v_primary
      ));
    END LOOP;

    IF v_primary_count > 1 THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'Only one team member may be marked as the primary contact.';
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'full_name', t.full_name,
      'email', t.email,
      'role', t.role,
      'title', t.title,
      'bio', t.bio,
      'is_primary_contact', t.is_primary_contact
    ) ORDER BY t.is_primary_contact DESC, t.created_at ASC, t.id ASC), '[]'::jsonb)
      INTO v_current
    FROM public.external_project_application_team t
    WHERE t.application_id = p_application_id;

    v_requested := jsonb_build_object('team', v_team);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.external_project_amendment_requests r
    WHERE r.application_id = p_application_id
      AND r.request_type = v_request_type
      AND r.network = 'mainnet'
      AND r.status = 'pending'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PENDING_AMENDMENT_EXISTS',
      'message', 'There is already a pending request of this type for this External Project.'
    );
  END IF;

  INSERT INTO public.external_project_amendment_requests (
    application_id, converted_project_id, applicant_user_id, network,
    request_type, reason, current_values, requested_values, status
  ) VALUES (
    p_application_id, v_application.converted_project_id, v_user_id, 'mainnet',
    v_request_type, v_reason, v_current, v_requested, 'pending'
  )
  RETURNING id INTO v_request_id;

  INSERT INTO public.external_project_audit_log (
    application_id, actor_user_id, actor_albukhr_user_id,
    action, old_status, new_status, details
  ) VALUES (
    p_application_id, NULL, v_user_id,
    'owner_amendment_requested', v_application.status, v_application.status,
    jsonb_build_object(
      'amendment_request_id', v_request_id,
      'request_type', v_request_type,
      'network', 'mainnet'
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'network', 'mainnet',
    'request_id', v_request_id,
    'request_type', v_request_type,
    'status', 'pending'
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PENDING_AMENDMENT_EXISTS',
      'message', 'There is already a pending request of this type for this External Project.'
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.gateway_get_my_external_project_amendments_trusted(
  p_pi_uid text,
  p_application_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_user_id uuid;
  v_user_count integer;
  v_requests jsonb;
BEGIN
  IF coalesce(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Trusted service gateway required.';
  END IF;
  IF NULLIF(btrim(coalesce(p_pi_uid, '')), '') IS NULL OR p_application_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Verified Pi identity and application ID are required.';
  END IF;

  SELECT count(*)::integer INTO v_user_count
  FROM public.users u
  WHERE u.pi_uid = btrim(p_pi_uid) AND lower(u.network) = 'mainnet';
  IF v_user_count <> 1 THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Mainnet ALBUKHR owner identity could not be resolved uniquely.';
  END IF;
  SELECT u.id INTO v_user_id FROM public.users u
  WHERE u.pi_uid = btrim(p_pi_uid) AND lower(u.network) = 'mainnet' LIMIT 1;
  IF NOT EXISTS (
    SELECT 1 FROM public.external_project_applications a
    WHERE a.id = p_application_id AND a.applicant_user_id = v_user_id
      AND lower(a.network) = 'mainnet' AND lower(a.status) IN ('approved', 'converted')
      AND (lower(a.status) <> 'converted' OR a.converted_project_id IS NOT NULL)
      AND (
        a.converted_project_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.projects p
          WHERE p.id = a.converted_project_id
            AND lower(p.network) = 'mainnet'
            AND lower(p.project_type) = 'external'
            AND p.owner_albukhr_user_id = v_user_id
        )
      )
  ) THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'External Project application not found or owner access denied.';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.requested_at DESC), '[]'::jsonb)
    INTO v_requests
  FROM public.external_project_amendment_requests r
  WHERE r.application_id = p_application_id
    AND r.applicant_user_id = v_user_id
    AND r.network = 'mainnet';

  RETURN jsonb_build_object('success', true, 'network', 'mainnet', 'requests', v_requests);
END;
$function$;

/* --------------------------------------------------------------------------
 * Admin review: authenticated External Admin / Super Admin + AAL2 only.
 * -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION albukhr_security.get_external_project_amendment_queue(
  p_status text DEFAULT 'pending'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, albukhr_security, auth, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_status text := lower(nullif(btrim(coalesce(p_status, '')), ''));
  v_records jsonb;
BEGIN
  IF NOT albukhr_security.can_review_external_applications(v_user_id)
     OR coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'External Project Admin AAL2 authorization is required.';
  END IF;
  IF v_status IS NOT NULL AND v_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Invalid amendment queue status.';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'application_id', r.application_id,
    'converted_project_id', r.converted_project_id,
    'request_type', r.request_type,
    'reason', r.reason,
    'current_values', r.current_values,
    'requested_values', r.requested_values,
    'status', r.status,
    'decision_reason', r.decision_reason,
    'requested_at', r.requested_at,
    'reviewed_at', r.reviewed_at,
    'reviewed_by', r.reviewed_by,
    'application_code', a.application_code,
    'project_code', a.project_code,
    'project_name', a.project_name,
    'business_name', a.business_name,
    'application_status', a.status,
    'owner_username', u.username
  ) ORDER BY r.requested_at DESC), '[]'::jsonb)
    INTO v_records
  FROM public.external_project_amendment_requests r
  JOIN public.external_project_applications a ON a.id = r.application_id
  JOIN public.users u ON u.id = r.applicant_user_id
  WHERE r.network = 'mainnet'
    AND a.network = 'mainnet'
    AND (v_status IS NULL OR r.status = v_status);

  RETURN jsonb_build_object(
    'success', true,
    'authorized', true,
    'network', 'mainnet',
    'records', v_records
  );
END;
$function$;

CREATE OR REPLACE FUNCTION albukhr_security.review_external_project_amendment(
  p_amendment_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, albukhr_security, auth, pg_temp
AS $function$
DECLARE
  v_admin_id uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_request public.external_project_amendment_requests%ROWTYPE;
  v_application public.external_project_applications%ROWTYPE;
  v_current jsonb;
  v_item jsonb;
  v_order integer := 0;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT albukhr_security.can_review_external_applications(v_admin_id)
     OR coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'External Project Admin AAL2 authorization is required.';
  END IF;
  IF p_amendment_id IS NULL OR v_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'A valid amendment ID and approve/reject decision are required.';
  END IF;
  IF v_decision = 'rejected' AND (v_reason IS NULL OR length(v_reason) < 5) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'A rejection reason of at least 5 characters is required.';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 1500 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Decision reason must be 1,500 characters or fewer.';
  END IF;

  SELECT * INTO v_request
  FROM public.external_project_amendment_requests r
  WHERE r.id = p_amendment_id AND r.network = 'mainnet'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'Owner amendment request was not found.';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'Only a pending owner amendment request can be reviewed.';
  END IF;

  SELECT * INTO v_application
  FROM public.external_project_applications a
  WHERE a.id = v_request.application_id
    AND a.applicant_user_id = v_request.applicant_user_id
    AND lower(a.network) = 'mainnet'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'The External Project application no longer exists.';
  END IF;
  IF v_decision = 'approved' AND lower(v_application.status) NOT IN ('approved', 'converted') THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'The External Project is no longer eligible for amendment approval. The request may still be rejected with a reason.';
  END IF;
  IF v_decision = 'approved' THEN
    -- An application may be converted while an owner request is pending.
    -- A null -> valid converted-project link is allowed only when the newly
    -- linked Mainnet External project still belongs to the same canonical owner.
    -- Any previously recorded converted link must remain unchanged.
    IF v_request.converted_project_id IS NOT NULL
       AND v_application.converted_project_id IS DISTINCT FROM v_request.converted_project_id THEN
      RAISE EXCEPTION USING errcode = '40001', message = 'The converted project linkage changed after the request was created. Refresh the request before review.';
    END IF;
    IF (lower(v_application.status) = 'converted' AND v_application.converted_project_id IS NULL)
       OR (v_application.converted_project_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.projects p
         WHERE p.id = v_application.converted_project_id
           AND lower(p.network) = 'mainnet'
           AND lower(p.project_type) = 'external'
           AND p.owner_albukhr_user_id = v_request.applicant_user_id
       )) THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'The converted External Project is not linked to the authenticated applicant owner.';
    END IF;
  END IF;

  IF v_decision = 'approved' THEN
    IF v_request.request_type = 'owner_contact' THEN
      v_current := jsonb_build_object(
        'contact_email', v_application.contact_email,
        'contact_phone', v_application.contact_phone
      );
      IF v_current IS DISTINCT FROM v_request.current_values THEN
        RAISE EXCEPTION USING errcode = '40001', message = 'Owner contact data changed after this request was created. The request is stale and must not be applied.';
      END IF;

      UPDATE public.external_project_applications
      SET contact_email = v_request.requested_values ->> 'contact_email',
          contact_phone = NULLIF(v_request.requested_values ->> 'contact_phone', ''),
          updated_at = now()
      WHERE id = v_application.id;

    ELSIF v_request.request_type = 'project_team' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'full_name', t.full_name,
        'email', t.email,
        'role', t.role,
        'title', t.title,
        'bio', t.bio,
        'is_primary_contact', t.is_primary_contact
      ) ORDER BY t.is_primary_contact DESC, t.created_at ASC, t.id ASC), '[]'::jsonb)
        INTO v_current
      FROM public.external_project_application_team t
      WHERE t.application_id = v_application.id;
      IF v_current IS DISTINCT FROM v_request.current_values THEN
        RAISE EXCEPTION USING errcode = '40001', message = 'Project team data changed after this request was created. The request is stale and must not be applied.';
      END IF;

      DELETE FROM public.external_project_application_team
      WHERE application_id = v_application.id;

      FOR v_item IN
        SELECT x.value
        FROM jsonb_array_elements(v_request.requested_values -> 'team') WITH ORDINALITY AS x(value, ordinality)
        ORDER BY coalesce((x.value ->> 'is_primary_contact')::boolean, false) DESC, x.ordinality ASC
      LOOP
        v_order := v_order + 1;
        INSERT INTO public.external_project_application_team (
          application_id, full_name, email, role, title, bio,
          is_primary_contact, created_at, updated_at
        ) VALUES (
          v_application.id,
          v_item ->> 'full_name',
          NULLIF(v_item ->> 'email', ''),
          v_item ->> 'role',
          NULLIF(v_item ->> 'title', ''),
          NULLIF(v_item ->> 'bio', ''),
          coalesce((v_item ->> 'is_primary_contact')::boolean, false),
          v_now + (v_order * interval '1 microsecond'),
          v_now + (v_order * interval '1 microsecond')
        );
      END LOOP;
    ELSE
      RAISE EXCEPTION USING errcode = '22023', message = 'Unsupported amendment request type.';
    END IF;
  END IF;

  UPDATE public.external_project_amendment_requests
  SET status = v_decision,
      decision_reason = v_reason,
      reviewed_at = now(),
      reviewed_by = v_admin_id,
      updated_at = now()
  WHERE id = v_request.id;

  INSERT INTO public.external_project_audit_log (
    application_id, actor_user_id, actor_albukhr_user_id,
    action, old_status, new_status, details
  ) VALUES (
    v_application.id, v_admin_id, NULL,
    CASE
      WHEN v_decision = 'approved' AND v_request.request_type = 'owner_contact' THEN 'owner_contact_amendment_approved'
      WHEN v_decision = 'approved' AND v_request.request_type = 'project_team' THEN 'project_team_amendment_approved'
      WHEN v_decision = 'rejected' THEN 'owner_amendment_rejected'
      ELSE 'owner_amendment_reviewed'
    END,
    v_application.status,
    v_application.status,
    jsonb_build_object(
      'amendment_request_id', v_request.id,
      'request_type', v_request.request_type,
      'decision', v_decision,
      'decision_reason', v_reason,
      'reviewer_auth_user_id', v_admin_id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'network', 'mainnet',
    'request_id', v_request.id,
    'request_type', v_request.request_type,
    'decision', v_decision,
    'reviewed_at', now()
  );
END;
$function$;

/* --------------------------------------------------------------------------
 * Privileges: owner operations only through the trusted API; admin RPCs only
 * through an authenticated AAL2 admin session. No direct table access.
 * -------------------------------------------------------------------------- */

REVOKE ALL ON FUNCTION public.gateway_create_my_external_project_amendment_trusted(text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_get_my_external_project_amendments_trusted(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gateway_create_my_external_project_amendment_trusted(text, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gateway_get_my_external_project_amendments_trusted(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION albukhr_security.get_external_project_amendment_queue(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION albukhr_security.review_external_project_amendment(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA albukhr_security TO authenticated;
GRANT EXECUTE ON FUNCTION albukhr_security.get_external_project_amendment_queue(text) TO authenticated;
GRANT EXECUTE ON FUNCTION albukhr_security.review_external_project_amendment(uuid, text, text) TO authenticated;

COMMENT ON TABLE public.external_project_amendment_requests IS
  'Mainnet-only, owner-requested contact/team amendments. Project ownership and Pi identity are never mutable through this workflow.';
