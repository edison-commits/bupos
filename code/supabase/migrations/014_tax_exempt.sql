-- M-01: Add missing tax_exempt column to customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT false;

-- M-02: Fix register_sessions.organization_id from TEXT to UUID with FK constraint.
--
-- R26-F6: make this block idempotent. The pre-fix SQL was:
--   ALTER TABLE register_sessions
--     ALTER COLUMN organization_id TYPE uuid USING organization_id::uuid;
--   ALTER TABLE register_sessions
--     ADD CONSTRAINT fk_register_sessions_organization
--     FOREIGN KEY (organization_id) REFERENCES organizations(id);
-- Running that a second time raises:
--   • "column is already of type uuid" if the TYPE change happened,
--   • "constraint already exists" if the FK is already present.
-- Our deploy.yml loops every migration on each deploy with a
-- _migrations tracker, so a migration only runs once. But a partial
-- failure (e.g., the FK fails because the TYPE change left orphan
-- rows) would leave us stuck — re-running the whole file in a
-- recovery deploy must not crash on already-applied statements.
DO $$
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'register_sessions' AND column_name = 'organization_id'
  ) = 'text' THEN
    ALTER TABLE register_sessions
      ALTER COLUMN organization_id TYPE uuid USING organization_id::uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'fk_register_sessions_organization'
       AND table_name = 'register_sessions'
  ) THEN
    ALTER TABLE register_sessions
      ADD CONSTRAINT fk_register_sessions_organization
      FOREIGN KEY (organization_id) REFERENCES organizations(id);
  END IF;
END
$$;

-- M-04: Add idempotency_key column to transactions for duplicate prevention
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency_key
  ON transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;
