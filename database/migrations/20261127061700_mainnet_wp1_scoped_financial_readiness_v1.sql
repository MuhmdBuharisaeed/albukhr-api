DO $preflight$
DECLARE
  v_internal_terms oid := pg_catalog.to_regprocedure('public.get_public_internal_staking_terms_v2(uuid,text)');
  v_core_terms oid := pg_catalog.to_regprocedure('public.get_public_core_staking_terms_v2(uuid,text)');
  v_core_settlement oid := pg_catalog.to_regprocedure('public.create_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)');
  v_internal_settlement oid := pg_catalog.to_regprocedure('public.create_internal_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)');
  v_liquidity_settlement oid := pg_catalog.to_regprocedure('public.settle_project_liquidity_payment(uuid,text,text,numeric,text,text,text,uuid,jsonb)');
BEGIN
  IF pg_catalog.to_regclass('public.projects') IS NULL
     OR pg_catalog.to_regclass('public.project_treasury') IS NULL
     OR pg_catalog.to_regclass('public.internal_project_treasury') IS NULL
     OR pg_catalog.to_regclass('public.project_liquidity_payments') IS NULL
     OR pg_catalog.to_regclass('public.project_treasury_transactions') IS NULL THEN
    RAISE EXCEPTION 'WP1 preflight failed: required Mainnet source tables are missing.';
  END IF;

  IF NOT has_table_privilege('service_role','public.projects','SELECT')
     OR NOT has_table_privilege('service_role','public.project_treasury','SELECT')
     OR NOT has_table_privilege('service_role','public.internal_project_treasury','SELECT')
     OR NOT has_table_privilege('service_role','public.project_liquidity_payments','SELECT')
     OR NOT has_table_privilege('service_role','public.project_treasury_transactions','SELECT') THEN
    RAISE EXCEPTION 'WP1 preflight failed: effective backend read privileges differ from the inspected baseline.';
  END IF;

  IF v_core_terms IS NULL OR v_internal_terms IS NULL
     OR v_core_settlement IS NULL OR v_internal_settlement IS NULL
     OR v_liquidity_settlement IS NULL THEN
    RAISE EXCEPTION 'WP1 preflight failed: one or more current financial RPC signatures are missing.';
  END IF;

  IF NOT has_function_privilege('service_role',v_core_terms,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_core_settlement,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_internal_settlement,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_liquidity_settlement,'EXECUTE') THEN
    RAISE EXCEPTION 'WP1 preflight failed: a required existing service-role RPC permission is missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid=v_internal_terms
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=public, pg_catalog']
  ) THEN
    RAISE EXCEPTION 'WP1 preflight failed: internal public term projection is not SECURITY DEFINER with a pinned search_path.';
  END IF;

  IF NOT has_schema_privilege('service_role','albukhr_security','USAGE') THEN
    RAISE EXCEPTION 'WP1 preflight failed: service_role cannot use the existing albukhr_security schema.';
  END IF;

  IF pg_catalog.to_regprocedure('albukhr_security.get_mainnet_financial_readiness_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'WP1 preflight failed: readiness RPC name already exists; manual review is required.';
  END IF;
END;
$preflight$;

-- Allow the trusted Mainnet API role to use the existing published-only
-- Internal term projection. This does not grant access to the underlying table.
GRANT EXECUTE ON FUNCTION public.get_public_internal_staking_terms_v2(uuid,text)
TO service_role;

CREATE FUNCTION albukhr_security.get_mainnet_financial_readiness_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, albukhr_security
AS $function$
DECLARE
  v_core_terms oid := pg_catalog.to_regprocedure('public.get_public_core_staking_terms_v2(uuid,text)');
  v_internal_terms oid := pg_catalog.to_regprocedure('public.get_public_internal_staking_terms_v2(uuid,text)');
  v_core_settlement oid := pg_catalog.to_regprocedure('public.create_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)');
  v_internal_settlement oid := pg_catalog.to_regprocedure('public.create_internal_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)');
  v_liquidity_settlement oid := pg_catalog.to_regprocedure('public.settle_project_liquidity_payment(uuid,text,text,numeric,text,text,text,uuid,jsonb)');
  v_tables jsonb;
  v_table_access jsonb;
  v_rls jsonb;
  v_functions jsonb;
  v_network_column_ok boolean;
  v_network_constraint_ok boolean;
  v_ready boolean;
BEGIN
  IF coalesce(auth.jwt()->>'role','') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Mainnet financial readiness is restricted to the trusted API service role.';
  END IF;

  v_tables := jsonb_build_object(
    'projects', pg_catalog.to_regclass('public.projects') IS NOT NULL,
    'project_treasury', pg_catalog.to_regclass('public.project_treasury') IS NOT NULL,
    'internal_project_treasury', pg_catalog.to_regclass('public.internal_project_treasury') IS NOT NULL,
    'project_liquidity_payments', pg_catalog.to_regclass('public.project_liquidity_payments') IS NOT NULL,
    'project_treasury_transactions', pg_catalog.to_regclass('public.project_treasury_transactions') IS NOT NULL
  );

  v_table_access := jsonb_build_object(
    'projects_select', has_table_privilege('service_role','public.projects','SELECT'),
    'project_treasury_select', has_table_privilege('service_role','public.project_treasury','SELECT'),
    'internal_project_treasury_select', has_table_privilege('service_role','public.internal_project_treasury','SELECT'),
    'project_liquidity_payments_select', has_table_privilege('service_role','public.project_liquidity_payments','SELECT'),
    'project_treasury_transactions_select', has_table_privilege('service_role','public.project_treasury_transactions','SELECT'),
    'albukhr_security_usage', has_schema_privilege('service_role','albukhr_security','USAGE')
  );

  v_rls := jsonb_build_object(
    'projects', coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid=pg_catalog.to_regclass('public.projects')),false),
    'project_treasury', coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid=pg_catalog.to_regclass('public.project_treasury')),false),
    'internal_project_treasury', coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid=pg_catalog.to_regclass('public.internal_project_treasury')),false),
    'project_liquidity_payments', coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid=pg_catalog.to_regclass('public.project_liquidity_payments')),false),
    'project_treasury_transactions', coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid=pg_catalog.to_regclass('public.project_treasury_transactions')),false)
  );

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='project_treasury_transactions'
      AND column_name='network'
      AND data_type='text'
      AND is_nullable='NO'
  ) INTO v_network_column_ok;

  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid=pg_catalog.to_regclass('public.project_treasury_transactions')
      AND c.convalidated
      AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%network%'
      AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%mainnet%'
  ) INTO v_network_constraint_ok;

  v_functions := jsonb_build_object(
    'core_terms_present', v_core_terms IS NOT NULL,
    'core_terms_service_execute', coalesce(has_function_privilege('service_role',v_core_terms,'EXECUTE'),false),
    'core_terms_security_definer_pinned', coalesce((
      SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_catalog']
      FROM pg_proc p WHERE p.oid=v_core_terms
    ),false),

    'internal_terms_present', v_internal_terms IS NOT NULL,
    'internal_terms_service_execute', coalesce(has_function_privilege('service_role',v_internal_terms,'EXECUTE'),false),
    'internal_terms_security_definer_pinned', coalesce((
      SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_catalog']
      FROM pg_proc p WHERE p.oid=v_internal_terms
    ),false),

    'core_investment_settlement_present', v_core_settlement IS NOT NULL,
    'core_investment_settlement_service_execute', coalesce(has_function_privilege('service_role',v_core_settlement,'EXECUTE'),false),
    'internal_investment_settlement_present', v_internal_settlement IS NOT NULL,
    'internal_investment_settlement_service_execute', coalesce(has_function_privilege('service_role',v_internal_settlement,'EXECUTE'),false),
    'liquidity_settlement_present', v_liquidity_settlement IS NOT NULL,
    'liquidity_settlement_service_execute', coalesce(has_function_privilege('service_role',v_liquidity_settlement,'EXECUTE'),false)
  );

  v_ready :=
    (v_tables->>'projects')::boolean
    AND (v_tables->>'project_treasury')::boolean
    AND (v_tables->>'internal_project_treasury')::boolean
    AND (v_tables->>'project_liquidity_payments')::boolean
    AND (v_tables->>'project_treasury_transactions')::boolean
    AND (v_table_access->>'projects_select')::boolean
    AND (v_table_access->>'project_treasury_select')::boolean
    AND (v_table_access->>'internal_project_treasury_select')::boolean
    AND (v_table_access->>'project_liquidity_payments_select')::boolean
    AND (v_table_access->>'project_treasury_transactions_select')::boolean
    AND (v_table_access->>'albukhr_security_usage')::boolean
    AND (v_rls->>'projects')::boolean
    AND (v_rls->>'project_treasury')::boolean
    AND (v_rls->>'internal_project_treasury')::boolean
    AND (v_rls->>'project_liquidity_payments')::boolean
    AND (v_rls->>'project_treasury_transactions')::boolean
    AND v_network_column_ok
    AND v_network_constraint_ok
    AND (v_functions->>'core_terms_present')::boolean
    AND (v_functions->>'core_terms_service_execute')::boolean
    AND (v_functions->>'core_terms_security_definer_pinned')::boolean
    AND (v_functions->>'internal_terms_present')::boolean
    AND (v_functions->>'internal_terms_service_execute')::boolean
    AND (v_functions->>'internal_terms_security_definer_pinned')::boolean
    AND (v_functions->>'core_investment_settlement_present')::boolean
    AND (v_functions->>'core_investment_settlement_service_execute')::boolean
    AND (v_functions->>'internal_investment_settlement_present')::boolean
    AND (v_functions->>'internal_investment_settlement_service_execute')::boolean
    AND (v_functions->>'liquidity_settlement_present')::boolean
    AND (v_functions->>'liquidity_settlement_service_execute')::boolean;

  RETURN jsonb_build_object(
    'contract_version','mainnet_financial_readiness_v1',
    'network','mainnet',
    'checked_at',pg_catalog.clock_timestamp(),
    'ready',coalesce(v_ready,false),
    'tables',v_tables,
    'table_access',v_table_access,
    'rls_enabled',v_rls,
    'project_treasury_transactions_network_not_null',v_network_column_ok,
    'project_treasury_transactions_network_check_validated',v_network_constraint_ok,
    'functions',v_functions
  );
END;
$function$;

REVOKE ALL ON FUNCTION albukhr_security.get_mainnet_financial_readiness_v1()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION albukhr_security.get_mainnet_financial_readiness_v1()
TO service_role;

COMMENT ON FUNCTION albukhr_security.get_mainnet_financial_readiness_v1()
IS 'Mainnet-only, service-role-only, read-only metadata health projection for the ALBUKHR API. Does not execute financial mutations.';
