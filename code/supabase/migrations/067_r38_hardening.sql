-- R38 hardening migration. Combines a number of schema hardening fixes
-- surfaced by the R38-A/B/C audits. All changes are additive or
-- idempotent; no data is dropped except demonstrably-dead objects.

BEGIN;

-- ─── R38-A-F2: amount-scoped register-session approvals ──────────────
-- Prior shape: `register_session_exceptions(exception_code TEXT, status
-- TEXT)` — any code-match approval unlocks ANY later action of the same
-- code, regardless of amount. A cashier requests + gets a $55 discount
-- approval; same checkout applies $5000 discount and the gate passes.
-- Fix: persist the amount the manager approved; the consumer re-checks
-- `actual <= approved_amount` (with epsilon). NULL = unbounded (legacy
-- rows + non-amount exception types like item_void).
ALTER TABLE register_session_exceptions
  ADD COLUMN IF NOT EXISTS approved_amount NUMERIC(12,2);

-- ─── R38-B-F1: REVOKE defaults from anon / authenticated ─────────────
-- Supabase's default PostgREST grants let `anon` and `authenticated`
-- hit any `public.*` table unless a REVOKE is on record. RLS covers the
-- reads when `app.current_org_id` is set, but a non-RLS or BYPASSRLS
-- misconfiguration would leak. Revoke the default on every customer-
-- data table we know about; FOR ALL policies bound to `service_role`
-- remain the only legitimate path.
REVOKE ALL ON TABLE
  organizations, locations, employees, auth_credentials, sessions,
  customers, products, product_variants, inventory_levels,
  inventory_adjustments, categories, product_modifiers, modifiers,
  transactions, transaction_tenders, transaction_events,
  register_sessions, register_session_exceptions, shifts, pay_in_outs,
  returns, return_lines, layaways, layaway_payments,
  gift_cards, gift_card_transactions, store_credit_ledger,
  promo_codes, promo_redemptions, product_bundles, bundle_items,
  audit_events, pending_signups, password_resets,
  rate_limit_buckets, customer_display_state
  FROM anon, authenticated;

-- `rate_limit_buckets` used `USING(true) WITH CHECK(true)` on FOR ALL —
-- tighten the policy to service_role too (its `_migrations` helper
-- already runs as postgres, which is BYPASSRLS, so no app path loses
-- access).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'rate_limit_buckets'
      AND policyname = 'rate_limit_buckets_all'
  ) THEN
    DROP POLICY rate_limit_buckets_all ON rate_limit_buckets;
  END IF;
END$$;
CREATE POLICY rate_limit_buckets_all ON rate_limit_buckets
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── R38-B-F2: pay_in_outs RLS now pivots on its own organization_id ──
-- Parallel to R32-H13 / mig 064 (inventory_adjustments). The column
-- exists since mig 038 (backfilled + NOT NULL). Dropping the location-
-- JOIN policy removes the cross-tenant foot-gun where a wrongly-orged
-- write lands under a matching location_id in another tenant.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pay_in_outs'
      AND policyname = 'parent_org_isolation'
  ) THEN
    DROP POLICY parent_org_isolation ON pay_in_outs;
  END IF;
END$$;
CREATE POLICY pay_in_outs_org_isolation ON pay_in_outs
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));

-- ─── R38-B-F4: drop the dead `check_tender_sum_stmt()` ───────────────
-- Mig 015 created it but mig 021 + 058 only ever attached
-- `check_tender_sum_fn()`. The _stmt variant references an undefined
-- `inserted_rows()` function and would error if anyone tried to call
-- it. Clean leftover.
DROP FUNCTION IF EXISTS check_tender_sum_stmt() CASCADE;

-- ─── R38-B-F6: drop duplicate idempotency indexes ────────────────────
-- Mig 008 and mig 024 both CREATE UNIQUE INDEX on
-- (organization_id, idempotency_key) for returns/transfers/shifts. Two
-- identical unique indexes doubles write amplification and disk use;
-- keep the later, canonically-named one (mig 024).
DROP INDEX IF EXISTS idx_returns_idempotency;
DROP INDEX IF EXISTS idx_transfers_idempotency;
DROP INDEX IF EXISTS idx_shifts_idempotency;

-- ─── R38-B-F7: drop redundant / dormant transaction indexes ──────────
-- `idx_transactions_status` (mig 001) is a single-column index on an
-- enum-like field with ~3 values — the planner ignores it. Mig 066's
-- new partial index `(organization_id, location_id, created_at DESC)
-- WHERE status='completed'` subsumes most patterns that ever used the
-- 016-era `idx_transactions_location_status_created`. Drop both; the
-- partial index + the lead-column single-column indexes from mig 001
-- are enough.
DROP INDEX IF EXISTS idx_transactions_status;
DROP INDEX IF EXISTS idx_transactions_location_status_created;

-- ─── R38-B-F10/F11: extensions out of `public` ────────────────────────
-- pgcrypto was fixed in R32-X4 (mig 062) but pg_trgm was added to
-- `public` in mig 054 and uuid-ossp sits unused in `public` from mig
-- 001. Move pg_trgm to the Supabase-standard `extensions` schema and
-- drop the unused uuid-ossp.
ALTER EXTENSION pg_trgm SET SCHEMA extensions;
DROP EXTENSION IF EXISTS "uuid-ossp";

-- ─── R38-B-F9: tamper-proof triggers on other write-once tables ──────
-- R31 (mig 061) protected `audit_events`. Other append-only-after-
-- commit tables lacked any DB-level protest against after-the-fact
-- UPDATE/DELETE. Add coverage, but PER-TABLE because different tables
-- have different legitimate-write-patterns:
--
-- * transaction_tenders, transaction_events, pay_in_outs,
--   layaway_payments — block UPDATE + DELETE + TRUNCATE. Refunds /
--   reversals are modeled as NEW rows with negative amounts, never
--   mutations.
-- * promo_redemptions — block UPDATE + TRUNCATE only. The register
--   return flow (`return-action.ts`) legitimately DELETEs a free-item
--   redemption on refund to un-burn the `max_redemptions` counter.
--
-- Reuse the existing `audit_events_prevent_tamper()` function from
-- mig 061; it already has `SET search_path = public`.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'transaction_tenders',
    'transaction_events',
    'pay_in_outs',
    'layaway_payments'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_no_update ON %I', tbl, tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_no_delete ON %I', tbl, tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_no_truncate ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_no_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_events_prevent_tamper()',
      tbl, tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_events_prevent_tamper()',
      tbl, tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION audit_events_prevent_tamper()',
      tbl, tbl);
  END LOOP;
END$$;

-- promo_redemptions: UPDATE + TRUNCATE only (DELETE legitimate on refund).
DROP TRIGGER IF EXISTS trg_promo_redemptions_no_update ON promo_redemptions;
DROP TRIGGER IF EXISTS trg_promo_redemptions_no_truncate ON promo_redemptions;
CREATE TRIGGER trg_promo_redemptions_no_update
  BEFORE UPDATE ON promo_redemptions
  FOR EACH ROW EXECUTE FUNCTION audit_events_prevent_tamper();
CREATE TRIGGER trg_promo_redemptions_no_truncate
  BEFORE TRUNCATE ON promo_redemptions
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_prevent_tamper();

COMMIT;
