-- M-01: Add missing tax_exempt column to customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT false;

-- M-02: Fix register_sessions.organization_id from TEXT to UUID with FK constraint
ALTER TABLE register_sessions
  ALTER COLUMN organization_id TYPE uuid USING organization_id::uuid;

ALTER TABLE register_sessions
  ADD CONSTRAINT fk_register_sessions_organization
  FOREIGN KEY (organization_id) REFERENCES organizations(id);

-- M-04: Add idempotency_key column to transactions for duplicate prevention
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency_key
  ON transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;
