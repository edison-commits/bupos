-- Round 24 CRITICAL fix: these SECURITY DEFINER RPCs were created with the
-- default PUBLIC EXECUTE grant, which means any caller holding the anon key
-- could invoke them directly against /rest/v1/rpc/. That let an attacker
-- forge admin sessions, disclose password hashes, impersonate register PINs,
-- and delete sessions — all without authentication.
--
-- Server code authenticates with SUPABASE_SERVICE_ROLE_KEY, so restricting
-- these to service_role does not break login. The only RPC kept anon-callable
-- is get_default_active_location, which intentionally runs on the pre-login
-- register page before a session cookie exists.
--
-- Idempotency: wrapped in a DO block with `pg_proc` existence checks so
-- fresh-DB bootstrap (where these functions don't yet exist until migration
-- 040 creates them) silently skips the REVOKE/GRANT. Migration 040 then
-- re-applies the REVOKE/GRANT on the 5 auth RPCs in its own COMMIT block.
-- In prod, this DO block is a no-op re-application of the already-applied
-- grants.

DO $$
BEGIN
  -- admin_login_* and resolve_register_session ARE defined by earlier
  -- migrations (018/019), so these REVOKEs succeed unconditionally on
  -- fresh-DB. We still wrap them in existence checks for belt-and-suspenders
  -- re-runnability.

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'admin_login_create_session') THEN
    REVOKE EXECUTE ON FUNCTION public.admin_login_create_session(uuid, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.admin_login_create_session(uuid, uuid, uuid, timestamptz, timestamptz) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'admin_login_lookup') THEN
    REVOKE EXECUTE ON FUNCTION public.admin_login_lookup(text) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.admin_login_lookup(text) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'resolve_register_session') THEN
    REVOKE EXECUTE ON FUNCTION public.resolve_register_session(uuid) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.resolve_register_session(uuid) TO service_role;
  END IF;

  -- The rest (register_login_create_session, find_session, register_pin_candidates,
  -- register_sign_out, get_full_store) are created by migration 040 on fresh-DB.
  -- The IF EXISTS guards make these REVOKEs safe to run before 040; migration 040
  -- re-applies the REVOKE/GRANT at the end of its own transaction to finalize the
  -- hardened state.

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'register_login_create_session') THEN
    REVOKE EXECUTE ON FUNCTION public.register_login_create_session(text, text, text, text, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.register_login_create_session(text, text, text, text, text, text, timestamptz, timestamptz) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'find_session') THEN
    REVOKE EXECUTE ON FUNCTION public.find_session(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.find_session(uuid, text) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'register_pin_candidates') THEN
    REVOKE EXECUTE ON FUNCTION public.register_pin_candidates(text) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.register_pin_candidates(text) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'register_sign_out') THEN
    REVOKE EXECUTE ON FUNCTION public.register_sign_out(text) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.register_sign_out(text) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'get_full_store') THEN
    REVOKE EXECUTE ON FUNCTION public.get_full_store(uuid) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.get_full_store(uuid) TO service_role;
  END IF;
END $$;

-- get_default_active_location intentionally remains anon-callable (pre-login register page).
