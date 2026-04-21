-- Idempotency key support for returns, transfers, and shifts
-- Ensures client retries don't create duplicate records.
--
-- Fresh-DB note: `shifts.organization_id` was added later in migration
-- 024 (and 013 for NOT NULL). Guard the shifts index with a column-
-- exists check so the migration can run on fresh DB; 024 + 035 will
-- recreate the definitive idx_shifts_org_idempotency_key once the
-- column lands.

ALTER TABLE returns ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_idempotency
  ON returns(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_idempotency
  ON transfers(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='shifts' AND column_name='organization_id'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_idempotency
      ON shifts(organization_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  END IF;
END $$;
