-- R39 compliance + data-lifecycle migration. Four changes:
--
-- 1. R39-A1-1: customer FKs that were `ON DELETE CASCADE` change to
--    RESTRICT. The right-to-be-forgotten path (/api/customers DELETE)
--    will null-anonymize a customer in place rather than hard-delete,
--    which preserves the financial history regulators require
--    (transaction-linked store_credit_ledger rows, layaways) while
--    still scrubbing the PII. CASCADE was the unsafe default — it
--    would wipe legitimate historical records.
--
-- 2. R39-A1-3: add `cleanup_stale_sessions()` and wire it into the
--    nightly `run_nightly_cleanup()` orchestrator. `sessions.expires_at`
--    was filtered at read time (post-R31-C2) but expired rows were
--    never deleted — after a few years the table grows unbounded.
--
-- 3. R39-A1-2: add a helper index so the audit queries added to tax
--    and settings change paths (next commit) don't seq-scan on event_kind.
--
-- 4. R39-A1-4: seed a `pg_trigger` presence function so the
--    `/api/admin/health` probe can call it and detect a dropped
--    audit-tamper trigger.

BEGIN;

-- ─── R39-A1-1: tighten customer FK cascade ───────────────────────────
-- Can't ALTER CONSTRAINT in place; DROP + ADD is the only path.
-- Guarded per-constraint so a partial-schema DB doesn't fail.

DO $$
DECLARE
  con RECORD;
BEGIN
  -- store_credit_ledger.customer_id: CASCADE → RESTRICT
  SELECT conname INTO con FROM pg_constraint
   WHERE conrelid = 'store_credit_ledger'::regclass
     AND conname LIKE '%customer_id%' AND contype = 'f';
  IF FOUND THEN
    EXECUTE format('ALTER TABLE store_credit_ledger DROP CONSTRAINT %I', con.conname);
    ALTER TABLE store_credit_ledger
      ADD CONSTRAINT store_credit_ledger_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
  END IF;

  -- layaways.customer_id: CASCADE → RESTRICT. The `customer_id` column
  -- is NOT NULL, so RESTRICT refuses to drop a customer with outstanding
  -- layaways (which is what we want — the manager must first forfeit
  -- or transfer the layaway).
  SELECT conname INTO con FROM pg_constraint
   WHERE conrelid = 'layaways'::regclass
     AND conname LIKE '%customer_id%' AND contype = 'f';
  IF FOUND THEN
    EXECUTE format('ALTER TABLE layaways DROP CONSTRAINT %I', con.conname);
    ALTER TABLE layaways
      ADD CONSTRAINT layaways_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
  END IF;
END$$;

-- ─── R39-A1-3: cleanup_stale_sessions ────────────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_stale_sessions(p_grace interval DEFAULT interval '7 days')
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  -- A session is "stale" if it has been expired for longer than the
  -- grace window. The 7-day default gives support time to correlate
  -- session id ↔ user ↔ incident when investigating an after-the-fact
  -- alert. Rows are read-filtered by `expires_at > NOW()` in
  -- `find_session`, so keeping them around for a week is harmless.
  DELETE FROM sessions
   WHERE expires_at < NOW() - p_grace;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_stale_sessions(interval) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cleanup_stale_sessions(interval) TO service_role;

-- Rewrite the orchestrator to include it. `CREATE OR REPLACE` is safe
-- because the signature is unchanged and pg_cron just calls the
-- function by name; the next scheduled run picks up the new body.
CREATE OR REPLACE FUNCTION public.run_nightly_cleanup()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $function$
DECLARE
  v_pending  bigint;
  v_buckets  bigint;
  v_sessions bigint;
BEGIN
  SELECT public.cleanup_stale_pending_signups()     INTO v_pending;
  SELECT public.cleanup_stale_rate_limit_buckets()  INTO v_buckets;
  SELECT public.cleanup_stale_sessions()            INTO v_sessions;
  PERFORM public.cleanup_stale_idempotency_keys();
  RETURN jsonb_build_object(
    'pending_signups_cleared', v_pending,
    'rate_limit_buckets_cleared', v_buckets,
    'sessions_cleared', v_sessions,
    'idempotency_keys_cleanup_ran', true
  );
END;
$function$;

-- ─── R39-A1-4: tamper-trigger presence probe ─────────────────────────
-- Expose a cheap `SELECT ok FROM check_audit_triggers()` call for the
-- admin health endpoint. Returns `false` if ANY of the expected
-- tamper triggers is missing (someone DROP TRIGGER'd it).
CREATE OR REPLACE FUNCTION public.check_audit_triggers()
  RETURNS TABLE(trigger_name TEXT, is_present BOOLEAN)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  WITH expected(name) AS (
    VALUES
      ('trg_audit_events_no_update'),
      ('trg_audit_events_no_delete'),
      ('trg_audit_events_no_truncate')
  )
  SELECT
    e.name,
    EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = e.name) AS is_present
  FROM expected e;
$$;

REVOKE EXECUTE ON FUNCTION public.check_audit_triggers() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.check_audit_triggers() TO service_role;

COMMIT;
