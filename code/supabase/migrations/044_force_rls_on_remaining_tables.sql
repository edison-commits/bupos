-- R14-C-1 + R14-H-8: every RLS policy we have relies on
-- `app.current_org_id` being evaluated by the policy. But the Supabase
-- `postgres` role both OWNS the tables and has BYPASSRLS — it skips
-- policies entirely unless the table has `FORCE ROW LEVEL SECURITY`.
-- Migration 012 applied FORCE to ~27 tables but later migrations
-- (010's customer_display_state, 041's 6 legacy tables) created new
-- tables that were only `ENABLE`d, not `FORCE`d. Result: on those
-- tables, every read/write the app makes through `orgQuery` runs
-- WITHOUT tenant filtering — the RLS policy is inert.
--
-- Idempotent: `FORCE ROW LEVEL SECURITY` is a no-op if already set.
-- Also guarded per-table via pg_tables because customer_display_state
-- and legacy tables may not exist on every DB.
--
-- This migration also establishes the invariant that gets enforced by a
-- new lint rule (`local/rls-force-matching` in eslint-rules/index.mjs):
-- any `ENABLE ROW LEVEL SECURITY` in a migration must be paired with
-- a `FORCE ROW LEVEL SECURITY` somewhere in the tree.

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'suppliers', 'purchase_orders', 'purchase_order_lines',
    'expenses', 'scheduled_shifts', 'time_off_requests',
    'customer_display_state'
  ]::text[] LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl) THEN
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    END IF;
  END LOOP;
END $$;
