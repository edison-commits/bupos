-- R21-H-3 closed: SECURITY DEFINER functions without `SET search_path`
-- are vulnerable to search-path hijack. A role with CREATE on any schema
-- in the resolution path (pg_temp, or a schema the function's owner
-- might resolve) can plant a shadow table that an unqualified reference
-- in the function body resolves to first.
--
-- Compare migration 019 (`admin_login_lookup`) — which correctly does
-- `SET search_path = public` — with migrations 040 / 048 / 049 / 050
-- which all omit this hardening. Supabase's linter flags every function
-- that ships without this as "Function Search Path Mutable".
--
-- This migration applies `ALTER FUNCTION ... SET search_path = public`
-- in-place for the 12 affected functions. That's equivalent to adding
-- `SET search_path = public` to each `CREATE OR REPLACE FUNCTION` —
-- we just don't want to copy-paste the full function bodies here.
--
-- Idempotent: ALTER FUNCTION ... SET search_path applied twice is a
-- no-op. Safe to re-apply on prod.
--
-- Verification: after this migration, every SECURITY DEFINER function in
-- public.* must have an entry in `pg_proc.proconfig` containing
-- `search_path=public`. The DO block at the bottom enumerates +
-- RAISE EXCEPTIONs if any are still exposed.

BEGIN;

-- ── migration 040: 9 auth + register RPCs ─────────────────────────────
ALTER FUNCTION public.find_session(uuid, text) SET search_path = public;
ALTER FUNCTION public.get_full_store(uuid) SET search_path = public;
ALTER FUNCTION public.register_pin_candidates(text) SET search_path = public;
ALTER FUNCTION public.register_login_create_session(text, text, text, text, text, text, timestamptz, timestamptz)
  SET search_path = public;
ALTER FUNCTION public.register_sign_out(text) SET search_path = public;
ALTER FUNCTION public.register_open_shift(text, text, text, text, text, numeric, text)
  SET search_path = public;
ALTER FUNCTION public.register_close_shift(text, text, numeric, numeric, text)
  SET search_path = public;
ALTER FUNCTION public.register_insert_audit(text, text, text, text, text, text, jsonb)
  SET search_path = public;
ALTER FUNCTION public.register_quick_switch(text, text, text, text)
  SET search_path = public;

-- ── migration 048: idempotency cleanup ────────────────────────────────
ALTER FUNCTION public.cleanup_stale_idempotency_keys(interval)
  SET search_path = public;

-- ── migration 049: pending_signups cleanup ────────────────────────────
ALTER FUNCTION public.cleanup_stale_pending_signups(interval)
  SET search_path = public;

-- ── migration 050: rate-limit RPCs ────────────────────────────────────
ALTER FUNCTION public.rate_limit_check(text, int, int)
  SET search_path = public;
ALTER FUNCTION public.cleanup_stale_rate_limit_buckets()
  SET search_path = public;

-- ── Verification ──────────────────────────────────────────────────────
-- Enumerate every SECURITY DEFINER function in `public` and confirm its
-- proconfig includes `search_path=public`. Fails the migration if a new
-- SECURITY DEFINER function has landed without this hardening.
DO $$
DECLARE
  v_offender text;
BEGIN
  SELECT string_agg(
           n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           E'\n  ')
    INTO v_offender
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) AS c
          WHERE c LIKE 'search_path=%'
      );

  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION
      E'SECURITY DEFINER functions without SET search_path:\n  %',
      v_offender;
  END IF;
END $$;

COMMIT;
