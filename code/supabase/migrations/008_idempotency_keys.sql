-- Idempotency key support for returns, transfers, and shifts
-- Ensures client retries don't create duplicate records

ALTER TABLE returns ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_idempotency
  ON returns(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_idempotency
  ON transfers(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_idempotency
  ON shifts(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
