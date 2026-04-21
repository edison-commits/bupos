-- Round 8 tenant-hardening migration
--
-- 1. Drop the global unique on gift_cards.code and replace with per-org.
--    The global constraint leaked cross-tenant existence via the
--    "code already exists" response in the activation path, and let one
--    tenant burn short codes that other tenants wanted (DoS).
-- 2. Add CHECK (>= 0) constraints on money/stock columns that the app
--    already defends with GREATEST(0, ...) patterns — the DB is the last
--    line of defense if any new write path misses the clamp.

BEGIN;

-- R8-C-3: Per-org gift card code uniqueness.
-- Two-phase drop to tolerate both old and new environments.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gift_cards_code_key' AND conrelid = 'gift_cards'::regclass
  ) THEN
    ALTER TABLE gift_cards DROP CONSTRAINT gift_cards_code_key;
  END IF;
END
$$;

-- Unique by (organization_id, LOWER(code)) so codes are case-insensitive
-- within a tenant but can collide freely across tenants.
CREATE UNIQUE INDEX IF NOT EXISTS gift_cards_org_code_uniq
  ON gift_cards (organization_id, LOWER(code));

-- R8-H-11: CHECK constraints on money/stock.
-- Use NOT VALID so the migration doesn't rewrite the whole table on apply;
-- then VALIDATE separately in a follow-up so running workloads aren't
-- blocked. Any existing violations must be cleaned up before VALIDATE.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gift_cards_balance_nonneg'
  ) THEN
    ALTER TABLE gift_cards
      ADD CONSTRAINT gift_cards_balance_nonneg CHECK (balance >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_store_credit_nonneg'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_store_credit_nonneg CHECK (store_credit_balance >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_loyalty_points_nonneg'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_loyalty_points_nonneg CHECK (loyalty_points >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_levels_on_hand_nonneg'
  ) THEN
    ALTER TABLE inventory_levels
      ADD CONSTRAINT inventory_levels_on_hand_nonneg CHECK (on_hand >= 0) NOT VALID;
  END IF;
END
$$;

-- Validate the constraints. If any row is already negative, fix it before
-- running this (UPDATE ... SET col = 0 WHERE col < 0). Splitting ADD + VALIDATE
-- lets us push the ADD safely and run VALIDATE in maintenance windows if
-- the tables are huge.
ALTER TABLE gift_cards VALIDATE CONSTRAINT gift_cards_balance_nonneg;
ALTER TABLE customers VALIDATE CONSTRAINT customers_store_credit_nonneg;
ALTER TABLE customers VALIDATE CONSTRAINT customers_loyalty_points_nonneg;
ALTER TABLE inventory_levels VALIDATE CONSTRAINT inventory_levels_on_hand_nonneg;

-- R8-L-14: Extend customer_display_state.payment_status with 'failed' +
-- 'cancelled' so card-terminal integrations can reflect terminal outcomes
-- on the customer-facing display.
--
-- Wrapped in a table-existence guard so this migration is applicable on
-- environments that haven't yet run migration 010 (which creates the
-- customer_display_state table). Without the guard, a fresh-ish schema
-- without migration 010 would fail the whole 035 transaction — caught by
-- scripts/test-migration-035-dryrun.mjs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'customer_display_state'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'customer_display_state_payment_status_check'
    ) THEN
      ALTER TABLE customer_display_state
        DROP CONSTRAINT customer_display_state_payment_status_check;
    END IF;

    ALTER TABLE customer_display_state
      ADD CONSTRAINT customer_display_state_payment_status_check
      CHECK (payment_status IS NULL OR payment_status IN ('pending', 'processing', 'complete', 'failed', 'cancelled'));
  END IF;
END
$$;

COMMIT;
