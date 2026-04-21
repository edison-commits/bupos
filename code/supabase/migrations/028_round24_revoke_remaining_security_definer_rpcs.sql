-- Round 24 CRITICAL fix, part 2: even broader than the part-1 migration.
-- Several other SECURITY DEFINER RPCs were still granted EXECUTE to PUBLIC/
-- anon/authenticated:
--
--   • org_rest_query / org_rest_tx — accept arbitrary SQL text + params and
--     EXECUTE it. With anon EXECUTE, any visitor holding the public anon
--     key could dump auth_credentials (password/PIN hashes) or run DML
--     against any table the `postgres` role can write. This is even worse
--     than the auth-forgery bug part 1 closed. These RPCs are unused by
--     application code (grep confirmed zero call sites in src/).
--   • register_open_shift / register_close_shift / register_quick_switch —
--     modify shift and session state with no caller authentication. Anon
--     could impersonate employees, close shifts with a fabricated variance,
--     or quick-switch any session to any employee.
--   • register_insert_audit / register_insert_exception — write to audit
--     and exception tables. Anon could forge audit trails or approve
--     exceptions without a real manager override.
--   • register_check_open_shift — read-only but still leaks shift/employee
--     structure with no auth.
--
-- Server callers were refactored in the same commit to go through the
-- direct DB pool (getPool()), which uses the `postgres` role via
-- DATABASE_URL. The `postgres` role keeps EXECUTE via `postgres=X/postgres`
-- (function owner), so the refactored callers are unaffected.
--
-- get_default_active_location is the ONLY RPC that legitimately needs anon
-- reach (pre-login register page). It stays granted.
--
-- Idempotency: wrapped in a DO block with existence checks so fresh-DB
-- bootstrap (where most of these functions don't yet exist until migration
-- 040 creates the 4 we still use) doesn't fail. The unused ones
-- (org_rest_query / org_rest_tx / register_check_open_shift /
-- register_insert_exception) simply stay undefined on fresh-DB — more
-- secure than "defined but revoked". Migration 040 re-applies REVOKE/GRANT
-- on the 4 register_* RPCs it codifies so the final state is hardened.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'org_rest_query') THEN
    REVOKE EXECUTE ON FUNCTION public.org_rest_query(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'org_rest_tx') THEN
    REVOKE EXECUTE ON FUNCTION public.org_rest_tx(uuid, jsonb) FROM PUBLIC, anon, authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'register_check_open_shift') THEN
    REVOKE EXECUTE ON FUNCTION public.register_check_open_shift(text, text) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.register_check_open_shift(text, text) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'register_close_shift') THEN
    REVOKE EXECUTE ON FUNCTION public.register_close_shift(text, text, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.register_close_shift(text, text, numeric, numeric, text) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'register_insert_audit') THEN
    REVOKE EXECUTE ON FUNCTION public.register_insert_audit(text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.register_insert_audit(text, text, text, text, text, text, jsonb) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'register_insert_exception') THEN
    REVOKE EXECUTE ON FUNCTION public.register_insert_exception(text, text, text, text, numeric, numeric, text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.register_insert_exception(text, text, text, text, numeric, numeric, text, text, text, text) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'register_open_shift') THEN
    REVOKE EXECUTE ON FUNCTION public.register_open_shift(text, text, text, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.register_open_shift(text, text, text, text, text, numeric, text) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'register_quick_switch') THEN
    REVOKE EXECUTE ON FUNCTION public.register_quick_switch(text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.register_quick_switch(text, text, text, text) TO service_role;
  END IF;
END $$;

-- Deliberately NOT granting service_role on org_rest_query / org_rest_tx —
-- those are arbitrary-SQL RPCs with no business need; leaving them
-- postgres-only puts them out of reach of even the service key. If future
-- work legitimately needs them, grant explicitly.
