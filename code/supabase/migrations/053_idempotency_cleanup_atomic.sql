-- R21-L-5: `cleanup_stale_idempotency_keys` previously executed four
-- UPDATEs in sequence inside a plpgsql body, but plpgsql does NOT
-- implicitly wrap the function in a savepoint — if the third UPDATE
-- failed, the first two had already committed their row locks /
-- snapshot, and the RETURN TABLE output omitted the remaining tables
-- without any error signal the caller could act on.
--
-- Fix: wrap each UPDATE in a BEGIN...EXCEPTION block that RE-RAISEs the
-- error (with a label identifying which table failed) so the caller
-- sees a single failure point and can retry idempotently. The function
-- is invoked weekly by a scheduled job — a partial success was the
-- worst-case pre-fix state because it silently left some tables with
-- stale keys the next week wouldn't retry.
--
-- Idempotent: CREATE OR REPLACE FUNCTION. Search_path already pinned by
-- migration 052.

BEGIN;

CREATE OR REPLACE FUNCTION public.cleanup_stale_idempotency_keys(
  p_older_than_interval interval DEFAULT '90 days'
)
  RETURNS TABLE(table_name text, cleared bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $function$
DECLARE
  v_cleared bigint;
BEGIN
  -- Each inner BEGIN/EXCEPTION establishes a subtransaction. If any
  -- UPDATE fails, the exception is re-raised with context identifying
  -- WHICH table failed — the caller retries cleanly next week, and
  -- all four updates are either visible in the return set or none are.

  -- transactions
  BEGIN
    UPDATE transactions
      SET idempotency_key = NULL
      WHERE idempotency_key IS NOT NULL
        AND created_at < now() - p_older_than_interval;
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
    table_name := 'transactions'; cleared := v_cleared; RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'cleanup_stale_idempotency_keys failed at transactions: %', SQLERRM;
  END;

  -- returns
  BEGIN
    UPDATE returns
      SET idempotency_key = NULL
      WHERE idempotency_key IS NOT NULL
        AND created_at < now() - p_older_than_interval;
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
    table_name := 'returns'; cleared := v_cleared; RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'cleanup_stale_idempotency_keys failed at returns: %', SQLERRM;
  END;

  -- transfers
  BEGIN
    UPDATE transfers
      SET idempotency_key = NULL
      WHERE idempotency_key IS NOT NULL
        AND created_at < now() - p_older_than_interval;
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
    table_name := 'transfers'; cleared := v_cleared; RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'cleanup_stale_idempotency_keys failed at transfers: %', SQLERRM;
  END;

  -- shifts
  BEGIN
    UPDATE shifts
      SET idempotency_key = NULL
      WHERE idempotency_key IS NOT NULL
        AND opened_at < now() - p_older_than_interval;
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
    table_name := 'shifts'; cleared := v_cleared; RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'cleanup_stale_idempotency_keys failed at shifts: %', SQLERRM;
  END;

  RETURN;
END;
$function$;

-- Grants carry over from migration 048 since CREATE OR REPLACE preserves them.

COMMIT;
