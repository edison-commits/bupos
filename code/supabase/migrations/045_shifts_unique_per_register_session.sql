-- R14-H-3: migration 043's `idx_shifts_one_open_per_location` assumed "one
-- open shift per location at a time". That's wrong: BuPOS stores may have
-- multiple physical registers per location (different device_ids, each
-- with its own register_session). Two cashiers at the same store at
-- different registers legitimately work simultaneously with separate
-- shifts. The per-location uniqueness broke that.
--
-- Correct invariant: one open shift per **register_session**. The
-- per-employee uniqueness is kept — employees can't be in two places at
-- once. The per-location one is dropped and replaced with a per-register-
-- session constraint for callers that bind shifts to specific registers.
--
-- Idempotent: DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.

BEGIN;

DROP INDEX IF EXISTS idx_shifts_one_open_per_location;

-- Only enforce uniqueness when register_session_id IS NOT NULL; admin-
-- initiated shifts (no bound register session) aren't serialized by this
-- constraint and rely on the per-employee constraint instead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open_per_register_session
  ON shifts (organization_id, register_session_id)
  WHERE status = 'open' AND register_session_id IS NOT NULL;

COMMIT;
