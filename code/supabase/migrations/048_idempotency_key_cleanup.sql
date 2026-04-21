-- R8-L-11 closed: scheduled cleanup of idempotency_key columns on
-- `returns`, `transactions`, `transfers`, `shifts`. These are set once
-- per mutating API call and never queried after the at-most-once window
-- (~minutes). After a year of daily use that's ~365k rows per store.
--
-- The column stays NOT NULL-friendly (it's already nullable per
-- migration 024), so NULL-ing old values is safe: the only consumer is
-- the SELECT that reads back the just-inserted row to respond with
-- `_idempotent: true`, which always happens within seconds of insert.
-- Anything older than 90 days is guaranteed stale.
--
-- Strategy:
--   1. Create a SECURITY DEFINER helper `cleanup_stale_idempotency_keys()`
--      that NULLs old keys across all 4 tables in one tx.
--   2. Document the scheduled-invocation contract in a comment + runbook
--      entry. Actual invocation (a Cloudflare Cron Trigger or
--      Supabase Scheduled Job) is set up outside migrations.
--
-- Idempotent: CREATE OR REPLACE + per-table scoped UPDATE.

BEGIN;

CREATE OR REPLACE FUNCTION public.cleanup_stale_idempotency_keys(
  p_older_than_interval interval DEFAULT '90 days'
)
  RETURNS TABLE(table_name text, cleared bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
DECLARE
  v_cleared bigint;
BEGIN
  -- transactions
  UPDATE transactions
    SET idempotency_key = NULL
    WHERE idempotency_key IS NOT NULL
      AND created_at < now() - p_older_than_interval;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  table_name := 'transactions'; cleared := v_cleared; RETURN NEXT;

  -- returns
  UPDATE returns
    SET idempotency_key = NULL
    WHERE idempotency_key IS NOT NULL
      AND created_at < now() - p_older_than_interval;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  table_name := 'returns'; cleared := v_cleared; RETURN NEXT;

  -- transfers
  UPDATE transfers
    SET idempotency_key = NULL
    WHERE idempotency_key IS NOT NULL
      AND created_at < now() - p_older_than_interval;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  table_name := 'transfers'; cleared := v_cleared; RETURN NEXT;

  -- shifts
  UPDATE shifts
    SET idempotency_key = NULL
    WHERE idempotency_key IS NOT NULL
      AND opened_at < now() - p_older_than_interval;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  table_name := 'shifts'; cleared := v_cleared; RETURN NEXT;

  RETURN;
END;
$function$;

-- Only service_role invokes this (scheduled job). PUBLIC / anon / authenticated
-- have no legitimate reason to clean the ledger.
REVOKE EXECUTE ON FUNCTION public.cleanup_stale_idempotency_keys(interval) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cleanup_stale_idempotency_keys(interval) TO service_role;

COMMIT;

-- Runbook:
--   Schedule this to run weekly via Cloudflare Cron Trigger OR Supabase
--   Scheduled Jobs:
--     SELECT * FROM cleanup_stale_idempotency_keys('90 days'::interval);
--   Expected output: 4 rows, one per table, with the row count that was
--   NULLed. Log the result so ops can spot anomalies (e.g., 0 rows cleared
--   after a quiet week is fine; 1M rows cleared suggests the prior schedule
--   wasn't running).
