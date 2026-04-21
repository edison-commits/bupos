-- R8-M-11 closed (partial): DB-backed rate-limit buckets.
--
-- The in-memory `src/lib/auth/rate-limit.ts` limiter is per-isolate;
-- Cloudflare Workers spreads requests across ~32 isolates per colo so
-- a brute-forcer gets ~32× the attempt budget. A full fix would use
-- Cloudflare KV or a Durable Object for cross-isolate coherence. This
-- migration adds a Postgres-backed limiter for the highest-value
-- endpoint (register-pin login) as an interim — one round-trip per
-- attempt, tolerable for auth flows, gives globally-consistent
-- accounting.
--
-- Usage: every caller UPSERTs a row keyed by a fingerprint (e.g.
-- SHA-256 of `${locationId}:${pin}`). The row tracks `attempts` and
-- `last_attempt_at`. A cleanup function prunes rows older than the
-- longest rate-limit window (1h today) so the table stays bounded.
--
-- Not tenanted — the fingerprint is already per-tenant (includes
-- locationId). The table is `postgres`-owned + service_role-only.

BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  -- Fingerprint of (locationId, pin) — or any other bucket key. Opaque.
  bucket_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- Window start, set on first attempt after a full reset. Used so
  -- cleanup can prune buckets whose window has fully elapsed.
  window_started_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_window ON rate_limit_buckets(window_started_at);

-- Not tenanted, but enforce RLS to keep policy-parity (FORCE ensures
-- the postgres role doesn't accidentally leak).
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_buckets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_full_access ON rate_limit_buckets;
CREATE POLICY service_role_full_access ON rate_limit_buckets
  USING (true) WITH CHECK (true);

-- Atomic upsert-and-check. Returns the new attempts count + whether
-- the caller should be blocked (attempts > max within window).
CREATE OR REPLACE FUNCTION public.rate_limit_check(
  p_bucket_key text,
  p_max_attempts int,
  p_window_ms int
) RETURNS TABLE(allowed boolean, attempts int, retry_after_ms int)
LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_attempts int;
BEGIN
  -- Try to find an existing bucket; fall through to INSERT if not.
  SELECT window_started_at, r.attempts
    INTO v_window_start, v_attempts
    FROM rate_limit_buckets r
    WHERE r.bucket_key = p_bucket_key
    FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO rate_limit_buckets (bucket_key, attempts, last_attempt_at, window_started_at)
      VALUES (p_bucket_key, 1, v_now, v_now)
      ON CONFLICT (bucket_key) DO UPDATE
        SET attempts = rate_limit_buckets.attempts + 1,
            last_attempt_at = v_now
      RETURNING rate_limit_buckets.attempts, rate_limit_buckets.window_started_at
      INTO v_attempts, v_window_start;
  ELSIF (EXTRACT(EPOCH FROM (v_now - v_window_start)) * 1000) > p_window_ms THEN
    -- Window elapsed — reset.
    UPDATE rate_limit_buckets
      SET attempts = 1, window_started_at = v_now, last_attempt_at = v_now
      WHERE bucket_key = p_bucket_key;
    v_attempts := 1;
    v_window_start := v_now;
  ELSE
    UPDATE rate_limit_buckets
      SET attempts = rate_limit_buckets.attempts + 1, last_attempt_at = v_now
      WHERE rate_limit_buckets.bucket_key = p_bucket_key
      RETURNING rate_limit_buckets.attempts INTO v_attempts;
  END IF;

  allowed := v_attempts <= p_max_attempts;
  attempts := v_attempts;
  retry_after_ms := GREATEST(
    0,
    p_window_ms - ((EXTRACT(EPOCH FROM (v_now - v_window_start)) * 1000)::int)
  );
  RETURN NEXT;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rate_limit_check(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.rate_limit_check(text, int, int) TO service_role;

-- Cleanup: prune buckets whose window is fully elapsed + 1 hour grace.
CREATE OR REPLACE FUNCTION public.cleanup_stale_rate_limit_buckets()
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
DECLARE
  v_cleared bigint;
BEGIN
  DELETE FROM rate_limit_buckets
    WHERE last_attempt_at < now() - interval '1 hour';
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  RETURN v_cleared;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cleanup_stale_rate_limit_buckets() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cleanup_stale_rate_limit_buckets() TO service_role;

COMMIT;
