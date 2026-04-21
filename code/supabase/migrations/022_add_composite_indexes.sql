-- Add missing composite indexes for common query patterns.
-- Fresh-DB note: `shifts.organization_id` doesn't exist until migration
-- 024 adds it, so guard that one index; migration 024 + 043 both create
-- shifts-org indexes after the column lands.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_tenders_txn_type
  ON transaction_tenders(transaction_id, tender_type);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='shifts' AND column_name='organization_id'
  ) THEN
    -- Can't CREATE INDEX CONCURRENTLY inside a DO block (no tx allowed).
    -- Drop to non-concurrent; this runs once at migration time on a
    -- small / empty table, so non-concurrent is fine.
    CREATE INDEX IF NOT EXISTS idx_shifts_org_employee_status
      ON shifts(organization_id, employee_id, status)
      WHERE status = 'open';
  END IF;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_time_clock_location_created
  ON time_clock_entries(location_id, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_time_clock_employee_created
  ON time_clock_entries(employee_id, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_register_sessions_auth_session
  ON register_sessions(auth_session_id)
  WHERE status = 'active';
