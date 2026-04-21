-- Codifies a column that exists in live Postgres but was never declared
-- by a migration file. Caught by scripts/check-schema-drift-ci.mjs when
-- wiring the drift gate into CI (pattern #4 in the "recurring issues"
-- summary — every session lookup at src/lib/auth/session.ts reads this
-- column, but no migration created it).
--
-- `IF NOT EXISTS` so the migration is a no-op on environments where the
-- column already exists (historical production), and a real DDL on fresh
-- schemas spun up from migration files alone.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS organization_id UUID;

-- Non-NULL backfill for any existing rows that happen to be in an
-- unmigrated schema. Historically every INSERT into sessions already
-- sets organization_id, so this CAST/UPDATE is defensive.
UPDATE sessions s
SET organization_id = e.organization_id
FROM employees e
WHERE s.organization_id IS NULL AND e.id = s.employee_id;

-- Match production: NOT NULL. The INSERTs in src/lib/auth/session.ts and
-- admin_login_create_session already always set this.
ALTER TABLE sessions
  ALTER COLUMN organization_id SET NOT NULL;

-- Index for the common filter: resolve session by id + scope, often
-- verified against organization_id downstream. No-op if it already exists.
CREATE INDEX IF NOT EXISTS idx_sessions_organization_id ON sessions(organization_id);

COMMIT;
