-- R33-C1 replacement for the broken wrangler cron trigger.
-- The prior R32 design declared `triggers.crons` in wrangler.jsonc
-- intending to invoke `/api/internal/run-cleanup` HTTP route nightly.
-- Three R33 audit agents independently flagged that Cloudflare Worker
-- Cron Triggers require a `scheduled(event, env, ctx)` Worker export,
-- which OpenNext/Next.js App Router does NOT generate. Net: the cron
-- fired into the void and the cleanup functions (`cleanup_stale_*`)
-- never ran. Unbounded growth resumed on `pending_signups`,
-- `rate_limit_buckets`, and stale `idempotency_key` columns.
--
-- NEW SHAPE: schedule inside Postgres via `pg_cron`. The cron job
-- runs entirely within Supabase's own infrastructure — no Worker
-- hop, no HTTP auth layer, no extra failure mode. Runs as the
-- `postgres` role which already has EXECUTE on all cleanup
-- functions (per the prior migrations' GRANT patterns).
--
-- Fall back gracefully: on Postgres instances WITHOUT pg_cron
-- installed (rare on self-hosted; standard on Supabase since 2023),
-- the CREATE EXTENSION succeeds and the schedule is installed.
-- If the extension isn't available, an operator can still run
-- `run_nightly_cleanup()` manually via psql or the
-- `/api/internal/run-cleanup` Bearer-gated route.

BEGIN;

-- Install pg_cron if the Postgres instance allows it. On Supabase the
-- extension lives in the `cron` schema. `IF NOT EXISTS` is idempotent.
--
-- GUARDED: `CREATE EXTENSION IF NOT EXISTS` still ERRORS when the extension
-- is not AVAILABLE on the instance (missing control file on plain
-- postgres:17-alpine in CI / any self-hosted box without pg_cron, or
-- "can only be loaded via shared_preload_libraries"). `IF NOT EXISTS` only
-- skips an already-INSTALLED extension; it does not tolerate an
-- unavailable one. The bare statement therefore aborted the whole
-- migration on every non-pg_cron Postgres — contradicting this file's own
-- "fall back gracefully" promise and breaking CI migrate+seed. Wrap it so
-- an unavailable pg_cron degrades to a warning. On Supabase (pg_cron
-- preloaded) the body still succeeds exactly as before.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pg_cron not available (%); nightly cleanup must be scheduled externally via run_nightly_cleanup().', SQLERRM;
END$$;

-- Drop any prior schedule of the same name so re-running this
-- migration replaces rather than duplicates.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'bupos_nightly_cleanup'
  ) THEN
    PERFORM cron.unschedule('bupos_nightly_cleanup');
  END IF;
EXCEPTION WHEN undefined_table THEN
  -- pg_cron not installed or accessible; skip silently.
  NULL;
END$$;

-- Schedule `run_nightly_cleanup()` at 07:00 UTC every day.
-- The SECDEF function itself handles error reporting via RAISE NOTICE;
-- pg_cron captures and retains job run history in `cron.job_run_details`
-- for ops alerting.
DO $$
BEGIN
  PERFORM cron.schedule(
    'bupos_nightly_cleanup',
    '0 7 * * *',
    $cron$SELECT public.run_nightly_cleanup();$cron$
  );
EXCEPTION WHEN undefined_function OR undefined_table THEN
  -- pg_cron not installed or the env lacks cron schema access.
  -- Migration commits anyway; operator can install pg_cron and
  -- re-run this migration block, or configure an external scheduler.
  RAISE WARNING 'pg_cron not available; nightly cleanup must be scheduled externally. Call run_nightly_cleanup() daily via another mechanism.';
END$$;

COMMIT;
