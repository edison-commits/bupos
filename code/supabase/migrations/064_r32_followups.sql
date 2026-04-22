-- R32 follow-up migration: closes the gaps the R32 audit agents
-- surfaced against R31/R32 migrations.
--
-- R32-H13: inventory_adjustments RLS still pivots on location_id
--   (migration 024's policy). After 063 added organization_id, the
--   policy is half-achieving its goal: a row written with the wrong
--   location_id could slip past even if organization_id is correct.
--   Rewrite the policy to pivot on organization_id directly.
--
-- R32-M-search_path: add `SET search_path = public` to the R31 and
--   R29 trigger / check functions for consistency with R21-H-3 rule.
--
-- R32-M-cleanup-cron: add stubs for calling the three cleanup
--   functions. Cloudflare Cron Triggers live in wrangler.jsonc, not
--   SQL; this migration creates a SECURITY DEFINER orchestrator that
--   a scheduled-tasks entry point can call.

BEGIN;

-- ─── R32-H13: inventory_adjustments RLS uses organization_id ───────
-- Drop the prior location-based policy and replace with one that
-- pivots on the new column. The `IF EXISTS` + redefine pattern is
-- idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'inventory_adjustments'
      AND policyname = 'parent_org_isolation'
  ) THEN
    DROP POLICY parent_org_isolation ON inventory_adjustments;
  END IF;
END$$;

-- R33-C2: tighten the policy so NULL organization_id rows are NOT
-- visible to every tenant. The prior USING shape included an
-- `organization_id IS NULL OR …` branch — intended as a soft
-- fallback for 063's backfill holes, but it cross-leaked any
-- backfill-failed row to every tenant who read the table. Drop the
-- NULL branch: a row must have a matching org_id on BOTH USING and
-- WITH CHECK. Legacy NULL rows (if any remain from 063's conditional
-- NOT NULL) stay hidden from all tenants until an operator backfills
-- them offline.
CREATE POLICY inventory_adjustments_org_isolation
  ON inventory_adjustments
  USING (
    organization_id::text = current_setting('app.current_org_id', true)
  )
  WITH CHECK (
    organization_id::text = current_setting('app.current_org_id', true)
  );

-- ─── R32-M-search_path: fix tamper trigger + tender-sum functions ──
-- R36-deploy: `ALTER FUNCTION IF EXISTS` is NOT valid PostgreSQL syntax
-- (IF EXISTS works on DROP FUNCTION but not ALTER FUNCTION). Both
-- functions are guaranteed to exist: `audit_events_prevent_tamper` is
-- CREATEd by migration 061 and `check_tender_sum_fn` by migration 058,
-- both of which run before 064 in sorted order. Wrap in a DO block
-- with an explicit existence check so this migration is still safe to
-- re-run against a DB where (for whatever reason) one of those
-- functions was dropped manually.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'audit_events_prevent_tamper') THEN
    EXECUTE 'ALTER FUNCTION public.audit_events_prevent_tamper() SET search_path = public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'check_tender_sum_fn') THEN
    EXECUTE 'ALTER FUNCTION public.check_tender_sum_fn() SET search_path = public';
  END IF;
END$$;

-- ─── R32-M-cleanup-cron: orchestrator ───────────────────────────────
-- Call all three cleanup functions from one entry point so a single
-- Cloudflare Cron trigger (wrangler.jsonc) can invoke it nightly.
-- Returns a jsonb report of rows cleared per table.
CREATE OR REPLACE FUNCTION public.run_nightly_cleanup()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $function$
DECLARE
  v_pending bigint;
  v_buckets bigint;
BEGIN
  -- pending_signups returns bigint (per migration 049).
  SELECT public.cleanup_stale_pending_signups() INTO v_pending;
  -- rate_limit_buckets returns bigint (per migration 050).
  SELECT public.cleanup_stale_rate_limit_buckets() INTO v_buckets;
  -- idempotency_keys returns a setof rows per table (migration 053);
  -- we don't need the breakdown here, just invoke it for side effect.
  PERFORM public.cleanup_stale_idempotency_keys();
  RETURN jsonb_build_object(
    'pending_signups_cleared', v_pending,
    'rate_limit_buckets_cleared', v_buckets,
    'idempotency_keys_cleanup_ran', true
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.run_nightly_cleanup() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.run_nightly_cleanup() TO service_role;

COMMIT;
