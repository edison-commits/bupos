-- Migration 084: repair the remaining production schema drift.
--
-- A prod-vs-migrations column diff (run after the returns drift in
-- migration 083) found four more columns that the migrations DEFINE but
-- the live prod DB is MISSING. All are the same drift class as 080/083:
-- an early table/ALTER ran against a pre-existing prod object so the
-- IF-NOT-EXISTS definition silently no-op'd. check:schema models the
-- migrations (which have these), so it stays green; only prod diverged.
--
--   organizations.approval_thresholds (mig 011) — register-config.ts
--   organizations.loyalty_config       (mig 011)   SELECTs both columns.
--     Missing -> the SELECT 42703s -> the try/catch falls back to DEFAULTS.
--     Net: per-org approval thresholds + loyalty config are SILENTLY
--     INACTIVE (every org stuck on defaults; admin customization can't
--     persist), and every config load (a hot path: offline-sync, cash-
--     drawer, checkout) burns a failing query + error log.
--   auth_credentials.pin_hash_prefix  (mig 017) — referenced by the PIN
--     candidate pre-filter in postgres-store.ts. Missing column risks a
--     42703 on that lookup path.
--   transaction_tenders.is_refund     (mig 001) — defined NOT NULL but not
--     currently read by app code; restored for schema parity + future use.
--
-- Idempotent: every ADD COLUMN IF NOT EXISTS is a no-op on fresh DBs (which
-- already have these) and repairs the drifted prod table. All defaults are
-- constants, so even transaction_tenders (large) gets PG's fast-path add
-- (no table rewrite).

-- organizations register config (mirror migration 011 defaults exactly)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS approval_thresholds jsonb NOT NULL DEFAULT '{
    "discountOver": 5,
    "itemVoidOver": 15,
    "transactionVoidOver": 20,
    "storeCreditIssuanceOver": 10,
    "manualPriceOverrideOver": 10,
    "returnWithoutManagerOver": 40
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS loyalty_config jsonb NOT NULL DEFAULT '{
    "earnRatePerDollar": 1,
    "redemptionValuePerPoint": 0.01,
    "minimumRedemption": 100
  }'::jsonb;

-- PIN prefix pre-filter (mirror migration 017)
ALTER TABLE auth_credentials ADD COLUMN IF NOT EXISTS pin_hash_prefix TEXT;
CREATE INDEX IF NOT EXISTS idx_auth_credentials_pin_prefix
  ON auth_credentials(pin_hash_prefix)
  WHERE pin_hash_prefix IS NOT NULL;

-- tender refund flag (mirror migration 001)
ALTER TABLE transaction_tenders ADD COLUMN IF NOT EXISTS is_refund BOOLEAN NOT NULL DEFAULT false;
