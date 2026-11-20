/*
 * ALBUKHR External Project Owner Funding — Mainnet trusted Pi gateway
 * Migration version: 20261120190954
 * Applied migration name: external_project_owner_funding_pi_gateway_v1
 *
 * IMPORTANT:
 * This reference migration has ALREADY been applied to Mainnet Supabase.
 * Do not execute it a second time on the Mainnet project. It is included
 * so the repository can retain the exact SQL source for the applied change.
 *
 * Trust boundary:
 * Browser -> Pi access token -> API verifies Pi /v2/me -> verified pi_uid
 * -> API service-role client -> these RPCs -> canonical public.users identity
 * -> application owner -> (if converted) matching Mainnet External project owner.
 *
 * The browser must never supply pi_uid/network/owner ids as authority.
 * Funding submission remains locked until a separately reviewed Owner
 * step-up / AAL2 mechanism is implemented. No submit RPC is created here.
 */

/* Align funding-plan ownership with ALBUKHR's canonical user identity.
 * external_project_applications.applicant_user_id references public.users(id),
 * not auth.users(id). Existing funding-plan rows were zero before this change.
 */
ALTER TABLE public.external_project_funding_plans
  DROP CONSTRAINT external_project_funding_plans_applicant_user_id_fkey;

ALTER TABLE public.external_project_funding_plans
  ADD CONSTRAINT external_project_funding_plans_applicant_user_id_fkey
  FOREIGN KEY (applicant_user_id)
  REFERENCES public.users(id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.gateway_get_my_external_funding_plan_trusted(
  p_pi_uid text,
  p_application_id uuid
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
  v_project public.projects%ROWTYPE;
  v_plan public.external_project_funding_plans%ROWTYPE;
  v_items jsonb := '[]'::jsonb;
  v_assessment public.external_project_funding_assessments%ROWTYPE;
BEGIN
  IF COALESCE(auth.jwt()->>'role', '') <> 'service_role' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Trusted service gateway required.';
  END IF;

  IF NULLIF(btrim(COALESCE(p_pi_uid, '')), '') IS NULL OR p_application_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Verified Pi UID and application ID are required.';
  END IF;

  SELECT count(*)::integer
    INTO v_user_count
  FROM public.users u
  WHERE u.pi_uid = btrim(p_pi_uid)
    AND u.network = 'mainnet';

  IF v_user_count <> 1 THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Mainnet ALBUKHR identity could not be resolved uniquely.';
  END IF;

  SELECT u.id
    INTO v_user_id
  FROM public.users u
  WHERE u.pi_uid = btrim(p_pi_uid)
    AND u.network = 'mainnet';

  SELECT *
    INTO v_application
  FROM public.external_project_applications a
  WHERE a.id = p_application_id
    AND a.network = 'mainnet'
    AND a.applicant_user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'External Project application not found or access denied.';
  END IF;

  IF v_application.status NOT IN ('approved', 'converted') THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Funding workspace is available only after External application approval.';
  END IF;

  IF v_application.status = 'converted' AND v_application.converted_project_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Converted External Project registry link is missing.';
  END IF;

  IF v_application.converted_project_id IS NOT NULL THEN
    SELECT *
      INTO v_project
    FROM public.projects p
    WHERE p.id = v_application.converted_project_id
      AND p.network = 'mainnet'
      AND p.project_type = 'external'
      AND p.owner_albukhr_user_id = v_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'Converted External project does not match the canonical application owner.';
    END IF;
  END IF;

  SELECT *
    INTO v_plan
  FROM public.external_project_funding_plans p
  WHERE p.application_id = p_application_id
    AND p.network = 'mainnet'
    AND p.applicant_user_id = v_user_id
  ORDER BY p.version_number DESC
  LIMIT 1;

  IF v_plan.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'network', 'mainnet',
      'application', to_jsonb(v_application),
      'funding_plan', NULL,
      'items', '[]'::jsonb,
      'assessment', NULL
    );
  END IF;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(i) ORDER BY i.line_number),
    '[]'::jsonb
  )
    INTO v_items
  FROM public.external_project_funding_items i
  WHERE i.funding_plan_id = v_plan.id
    AND i.application_id = p_application_id
    AND i.network = 'mainnet';

  SELECT *
    INTO v_assessment
  FROM public.external_project_funding_assessments a
  WHERE a.funding_plan_id = v_plan.id
    AND a.application_id = p_application_id
    AND a.network = 'mainnet'
  ORDER BY a.assessment_version DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'success', true,
    'network', 'mainnet',
    'application', to_jsonb(v_application),
    'funding_plan', to_jsonb(v_plan),
    'items', v_items,
    'assessment', CASE WHEN v_assessment.id IS NULL THEN NULL ELSE to_jsonb(v_assessment) END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.gateway_save_my_external_funding_plan_trusted(
  p_pi_uid text,
  p_application_id uuid,
  p_business_stage text,
  p_funding_model text,
  p_funding_purpose text,
  p_declared_existing_asset_base numeric,
  p_declared_existing_liquidity numeric,
  p_funding_window_start timestamptz,
  p_funding_window_end timestamptz,
  p_operating_cycle_days integer,
  p_expected_capital_cycle_days integer,
  p_required_reserve numeric,
  p_contingency_reserve numeric,
  p_notes text,
  p_items jsonb
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
  v_project public.projects%ROWTYPE;
  v_current public.external_project_funding_plans%ROWTYPE;
  v_plan_id uuid;
  v_version integer;
  v_item jsonb;
  v_index integer := 0;
  v_quantity numeric;
  v_unit_cost numeric;
  v_line_total numeric;
  v_itemized numeric := 0;
  v_document_id uuid;
BEGIN
  IF COALESCE(auth.jwt()->>'role', '') <> 'service_role' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Trusted service gateway required.';
  END IF;

  IF NULLIF(btrim(COALESCE(p_pi_uid, '')), '') IS NULL OR p_application_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Verified Pi UID and application ID are required.';
  END IF;

  IF p_business_stage IS NOT NULL
     AND p_business_stage NOT IN ('concept', 'setup', 'pre_operation', 'operating', 'expansion', 'mature') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Invalid business stage.';
  END IF;

  IF p_funding_model IS NULL OR p_funding_model NOT IN ('BUILD', 'GROW', 'OPERATE', 'ASSET', 'BRANCH', 'PRODUCT', 'RESTRUCTURE') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Invalid funding model.';
  END IF;

  IF p_funding_purpose IS NULL OR length(btrim(p_funding_purpose)) < 3 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Funding purpose is required.';
  END IF;

  IF p_declared_existing_asset_base IS NULL OR p_declared_existing_asset_base < 0
     OR p_declared_existing_liquidity IS NULL OR p_declared_existing_liquidity < 0
     OR p_declared_existing_asset_base::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_declared_existing_liquidity::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Declared asset and liquidity values must be finite, nonnegative numbers.';
  END IF;

  IF p_required_reserve IS NULL OR p_required_reserve < 0
     OR p_contingency_reserve IS NULL OR p_contingency_reserve < 0
     OR p_required_reserve::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_contingency_reserve::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Reserve values must be finite, nonnegative numbers.';
  END IF;

  IF p_funding_window_start IS NOT NULL
     AND p_funding_window_end IS NOT NULL
     AND p_funding_window_end <= p_funding_window_start THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Funding window end must be after the start.';
  END IF;

  IF (p_operating_cycle_days IS NOT NULL AND p_operating_cycle_days <= 0)
     OR (p_expected_capital_cycle_days IS NOT NULL AND p_expected_capital_cycle_days <= 0) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Capital and operating cycles must be positive.';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Funding items must be a JSON array.';
  END IF;

  IF jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Funding plan must contain between 1 and 100 items.';
  END IF;

  SELECT count(*)::integer
    INTO v_user_count
  FROM public.users u
  WHERE u.pi_uid = btrim(p_pi_uid)
    AND u.network = 'mainnet';

  IF v_user_count <> 1 THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Mainnet ALBUKHR identity could not be resolved uniquely.';
  END IF;

  SELECT u.id
    INTO v_user_id
  FROM public.users u
  WHERE u.pi_uid = btrim(p_pi_uid)
    AND u.network = 'mainnet';

  SELECT *
    INTO v_application
  FROM public.external_project_applications a
  WHERE a.id = p_application_id
    AND a.network = 'mainnet'
    AND a.applicant_user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'External Project application not found or access denied.';
  END IF;

  IF v_application.status NOT IN ('approved', 'converted') THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Funding structure is available only after External application approval.';
  END IF;

  IF v_application.status = 'converted' AND v_application.converted_project_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'Converted External Project registry link is missing.';
  END IF;

  IF v_application.converted_project_id IS NOT NULL THEN
    SELECT *
      INTO v_project
    FROM public.projects p
    WHERE p.id = v_application.converted_project_id
      AND p.network = 'mainnet'
      AND p.project_type = 'external'
      AND p.owner_albukhr_user_id = v_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'Converted External project does not match the canonical application owner.';
    END IF;
  END IF;

  SELECT *
    INTO v_current
  FROM public.external_project_funding_plans p
  WHERE p.application_id = p_application_id
    AND p.network = 'mainnet'
    AND p.applicant_user_id = v_user_id
  ORDER BY p.version_number DESC
  LIMIT 1
  FOR UPDATE;

  IF v_current.id IS NOT NULL
     AND v_current.status IN ('submitted', 'under_review', 'approved', 'rejected') THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'The current funding plan is not editable. An administrator must request a revision.';
  END IF;

  IF v_current.id IS NULL THEN
    v_version := 1;
  ELSIF v_current.status = 'revision_requested' THEN
    v_version := v_current.version_number + 1;
  ELSE
    v_version := v_current.version_number;
  END IF;

  IF v_current.id IS NOT NULL AND v_current.status = 'draft' THEN
    v_plan_id := v_current.id;

    UPDATE public.external_project_funding_plans
       SET project_id = v_application.converted_project_id,
           business_stage = p_business_stage,
           funding_model = p_funding_model,
           funding_purpose = btrim(p_funding_purpose),
           funding_window_start = p_funding_window_start,
           funding_window_end = p_funding_window_end,
           operating_cycle_days = p_operating_cycle_days,
           expected_capital_cycle_days = p_expected_capital_cycle_days,
           declared_capital_requirement = COALESCE(v_application.funding_required, 0),
           declared_existing_asset_base = p_declared_existing_asset_base,
           declared_existing_liquidity = p_declared_existing_liquidity,
           required_reserve = p_required_reserve,
           contingency_reserve = p_contingency_reserve,
           incremental_capital_requirement = NULL,
           validated_capital_requirement = NULL,
           approved_capital_requirement = NULL,
           itemized_capital_requirement = 0,
           status = 'draft',
           submitted_at = NULL,
           approved_at = NULL,
           approved_by = NULL,
           notes = p_notes,
           updated_at = now()
     WHERE id = v_plan_id;

    DELETE FROM public.external_project_funding_items
    WHERE funding_plan_id = v_plan_id
      AND application_id = p_application_id
      AND network = 'mainnet';
  ELSE
    INSERT INTO public.external_project_funding_plans (
      application_id, project_id, applicant_user_id, network, version_number,
      business_stage, funding_model, funding_purpose,
      funding_window_start, funding_window_end,
      operating_cycle_days, expected_capital_cycle_days,
      declared_capital_requirement,
      declared_existing_asset_base, declared_existing_liquidity,
      required_reserve, contingency_reserve, notes, status, updated_at
    ) VALUES (
      p_application_id, v_application.converted_project_id, v_user_id, 'mainnet', v_version,
      p_business_stage, p_funding_model, btrim(p_funding_purpose),
      p_funding_window_start, p_funding_window_end,
      p_operating_cycle_days, p_expected_capital_cycle_days,
      COALESCE(v_application.funding_required, 0),
      p_declared_existing_asset_base, p_declared_existing_liquidity,
      p_required_reserve, p_contingency_reserve, p_notes, 'draft', now()
    ) RETURNING id INTO v_plan_id;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_index := v_index + 1;

    IF COALESCE(btrim(v_item->>'category'), '') = ''
       OR COALESCE(btrim(v_item->>'description'), '') = '' THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'Every funding item needs a category and description.';
    END IF;

    BEGIN
      v_quantity := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 1);
      v_unit_cost := NULLIF(v_item->>'unit_cost', '')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'Funding item quantity or unit cost is invalid.';
    END;

    IF v_quantity IS NULL OR v_quantity <= 0 OR v_unit_cost IS NULL OR v_unit_cost < 0
       OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_unit_cost::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'Funding item quantity and unit cost must be finite; quantity must be positive and unit cost nonnegative.';
    END IF;

    IF COALESCE(v_item->>'use_type', 'other') NOT IN
       ('capex', 'opex', 'working_capital', 'reserve', 'contingency', 'other') THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'Invalid funding item use type.';
    END IF;

    v_line_total := v_quantity * v_unit_cost;
    v_document_id := NULL;

    IF NULLIF(btrim(v_item->>'supporting_document_id'), '') IS NOT NULL THEN
      BEGIN
        v_document_id := (v_item->>'supporting_document_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'Invalid supporting document ID.';
      END;

      IF NOT EXISTS (
        SELECT 1
        FROM public.external_project_application_documents d
        WHERE d.id = v_document_id
          AND d.application_id = p_application_id
      ) THEN
        RAISE EXCEPTION USING errcode = '42501', message = 'Supporting document does not belong to this External application.';
      END IF;
    END IF;

    INSERT INTO public.external_project_funding_items (
      funding_plan_id, application_id, network, line_number,
      category, description, use_type, quantity, unit, unit_cost, line_total,
      deployment_stage, notes, supporting_document_id
    ) VALUES (
      v_plan_id, p_application_id, 'mainnet', v_index,
      btrim(v_item->>'category'),
      btrim(v_item->>'description'),
      COALESCE(v_item->>'use_type', 'other'),
      v_quantity,
      COALESCE(NULLIF(btrim(v_item->>'unit'), ''), 'unit'),
      v_unit_cost,
      v_line_total,
      NULLIF(btrim(v_item->>'deployment_stage'), ''),
      NULLIF(btrim(v_item->>'notes'), ''),
      v_document_id
    );

    v_itemized := v_itemized + v_line_total;
  END LOOP;

  v_itemized := v_itemized + p_required_reserve + p_contingency_reserve;

  UPDATE public.external_project_funding_plans
     SET itemized_capital_requirement = v_itemized,
         updated_at = now()
   WHERE id = v_plan_id
     AND application_id = p_application_id
     AND network = 'mainnet';

  RETURN public.gateway_get_my_external_funding_plan_trusted(p_pi_uid, p_application_id);
END;
$function$;

/* Expose only to the trusted API service-role client. */
REVOKE ALL ON FUNCTION public.gateway_get_my_external_funding_plan_trusted(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gateway_get_my_external_funding_plan_trusted(text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gateway_get_my_external_funding_plan_trusted(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.gateway_save_my_external_funding_plan_trusted(text, uuid, text, text, text, numeric, numeric, timestamptz, timestamptz, integer, integer, numeric, numeric, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gateway_save_my_external_funding_plan_trusted(text, uuid, text, text, text, numeric, numeric, timestamptz, timestamptz, integer, integer, numeric, numeric, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gateway_save_my_external_funding_plan_trusted(text, uuid, text, text, text, numeric, numeric, timestamptz, timestamptz, integer, integer, numeric, numeric, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.gateway_get_my_external_funding_plan_trusted(text, uuid)
IS 'Mainnet External Owner funding read via Pi-verified service gateway; canonical public.users ownership; service_role only.';
COMMENT ON FUNCTION public.gateway_save_my_external_funding_plan_trusted(text, uuid, text, text, text, numeric, numeric, timestamptz, timestamptz, integer, integer, numeric, numeric, text, jsonb)
IS 'Mainnet External Owner funding draft save via Pi-verified service gateway; canonical public.users ownership; service_role only.';
