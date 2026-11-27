-- ALBUKHR Mainnet WP2 — preserve legacy durations while accepting the approved future catalogue.
-- Applied migration version: 20261127072311
-- Existing term and payment rows are not rewritten or published.

DO $preflight$
DECLARE
  v_core_def text;
  v_internal_def text;
  v_old text := 'IF p_duration_days NOT IN (30,60,90,180,365,430) THEN';
  v_core_count integer;
  v_internal_count integer;
BEGIN
  IF to_regclass('public.project_staking_term_versions') IS NULL
     OR to_regclass('public.core_investment_payments') IS NULL
     OR to_regclass('public.internal_investment_payments') IS NULL THEN
    RAISE EXCEPTION 'WP2 duration preflight failed: one or more Mainnet term/payment tables are missing.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.project_staking_term_versions WHERE duration_days NOT IN (30,60,90,180,365,430,730,1095))
     OR EXISTS (SELECT 1 FROM public.core_investment_payments WHERE duration_days NOT IN (30,60,90,180,365,430,730,1095))
     OR EXISTS (SELECT 1 FROM public.internal_investment_payments WHERE duration_days NOT IN (30,60,90,180,365,430,730,1095)) THEN
    RAISE EXCEPTION 'WP2 duration preflight failed: existing duration data is outside the expanded catalogue.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.project_staking_term_versions'::regclass
      AND conname='project_staking_term_versions_duration_ck' AND convalidated
      AND pg_get_constraintdef(oid) ILIKE '%30%' AND pg_get_constraintdef(oid) ILIKE '%430%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%730%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.core_investment_payments'::regclass
      AND conname='core_investment_payments_duration_ck' AND convalidated
      AND pg_get_constraintdef(oid) ILIKE '%30%' AND pg_get_constraintdef(oid) ILIKE '%430%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%730%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.internal_investment_payments'::regclass
      AND conname='internal_investment_payments_duration_ck' AND convalidated
      AND pg_get_constraintdef(oid) ILIKE '%30%' AND pg_get_constraintdef(oid) ILIKE '%430%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%730%'
  ) THEN
    RAISE EXCEPTION 'WP2 duration preflight failed: one or more constraints differ from the reviewed old catalogue.';
  END IF;

  v_core_def := pg_get_functiondef('public.create_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)'::regprocedure);
  v_internal_def := pg_get_functiondef('public.create_internal_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)'::regprocedure);
  v_core_count := length(v_core_def) - length(replace(v_core_def, v_old, ''));
  v_internal_count := length(v_internal_def) - length(replace(v_internal_def, v_old, ''));
  IF v_core_count <> length(v_old) OR v_internal_count <> length(v_old) THEN
    RAISE EXCEPTION 'WP2 duration preflight failed: settlement RPC duration guards do not match the exact reviewed source.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid='public.create_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)'::regprocedure
      AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_catalog']
      AND has_function_privilege('service_role',p.oid,'EXECUTE')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid='public.create_internal_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)'::regprocedure
      AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_catalog']
      AND has_function_privilege('service_role',p.oid,'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'WP2 duration preflight failed: settlement RPC security/grants differ from the reviewed baseline.';
  END IF;
END;
$preflight$;

ALTER TABLE public.project_staking_term_versions DROP CONSTRAINT project_staking_term_versions_duration_ck;
ALTER TABLE public.project_staking_term_versions
  ADD CONSTRAINT project_staking_term_versions_duration_ck
  CHECK (duration_days = ANY (ARRAY[30,60,90,180,365,430,730,1095]::integer[])) NOT VALID;
ALTER TABLE public.project_staking_term_versions VALIDATE CONSTRAINT project_staking_term_versions_duration_ck;

ALTER TABLE public.core_investment_payments DROP CONSTRAINT core_investment_payments_duration_ck;
ALTER TABLE public.core_investment_payments
  ADD CONSTRAINT core_investment_payments_duration_ck
  CHECK (duration_days = ANY (ARRAY[30,60,90,180,365,430,730,1095]::integer[])) NOT VALID;
ALTER TABLE public.core_investment_payments VALIDATE CONSTRAINT core_investment_payments_duration_ck;

ALTER TABLE public.internal_investment_payments DROP CONSTRAINT internal_investment_payments_duration_ck;
ALTER TABLE public.internal_investment_payments
  ADD CONSTRAINT internal_investment_payments_duration_ck
  CHECK (duration_days = ANY (ARRAY[30,60,90,180,365,430,730,1095]::integer[])) NOT VALID;
ALTER TABLE public.internal_investment_payments VALIDATE CONSTRAINT internal_investment_payments_duration_ck;

DO $rpc_update$
DECLARE
  v_core_def text;
  v_internal_def text;
  v_old text := 'IF p_duration_days NOT IN (30,60,90,180,365,430) THEN';
  v_new text := 'IF p_duration_days NOT IN (30,60,90,180,365,430,730,1095) THEN';
BEGIN
  v_core_def := pg_get_functiondef('public.create_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)'::regprocedure);
  v_internal_def := pg_get_functiondef('public.create_internal_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)'::regprocedure);
  EXECUTE replace(v_core_def, v_old, v_new);
  EXECUTE replace(v_internal_def, v_old, v_new);
END;
$rpc_update$;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.project_staking_term_versions'::regclass
      AND conname='project_staking_term_versions_duration_ck' AND convalidated
      AND pg_get_constraintdef(oid) ILIKE '%730%' AND pg_get_constraintdef(oid) ILIKE '%1095%'
      AND pg_get_constraintdef(oid) ILIKE '%60%' AND pg_get_constraintdef(oid) ILIKE '%430%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.core_investment_payments'::regclass
      AND conname='core_investment_payments_duration_ck' AND convalidated
      AND pg_get_constraintdef(oid) ILIKE '%730%' AND pg_get_constraintdef(oid) ILIKE '%1095%'
      AND pg_get_constraintdef(oid) ILIKE '%60%' AND pg_get_constraintdef(oid) ILIKE '%430%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.internal_investment_payments'::regclass
      AND conname='internal_investment_payments_duration_ck' AND convalidated
      AND pg_get_constraintdef(oid) ILIKE '%730%' AND pg_get_constraintdef(oid) ILIKE '%1095%'
      AND pg_get_constraintdef(oid) ILIKE '%60%' AND pg_get_constraintdef(oid) ILIKE '%430%'
  ) THEN
    RAISE EXCEPTION 'WP2 duration postflight failed: expanded duration constraints are not validated.';
  END IF;

  IF pg_get_functiondef('public.create_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)'::regprocedure)
       NOT LIKE '%30,60,90,180,365,430,730,1095%'
     OR pg_get_functiondef('public.create_internal_stake_from_completed_payment(uuid,text,text,numeric,text,text,text,uuid,integer,jsonb)'::regprocedure)
       NOT LIKE '%30,60,90,180,365,430,730,1095%' THEN
    RAISE EXCEPTION 'WP2 duration postflight failed: settlement RPC whitelists are not expanded.';
  END IF;
END;
$postflight$;
