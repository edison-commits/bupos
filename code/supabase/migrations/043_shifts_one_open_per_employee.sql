-- R13-M-3: shifts' "one open shift per employee, one open shift per
-- location" invariant is currently enforced by a SELECT FOR UPDATE in
-- open_shift handlers (cash-drawer + shift-actions). On busy locations
-- this serializes every open-shift attempt and holds locks on every
-- matching row. Replace with partial UNIQUE indexes so the constraint
-- is DB-enforced — open_shift can INSERT and let the index raise 23505
-- if a duplicate exists, then map to a 409 response.
--
-- Partial indexes only cover status='open' rows, so closed/old rows
-- don't pollute the index and concurrent close operations never touch
-- the guard. INSERTs that race a close would only block if both target
-- the same row.
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS.
-- Prod-safe: existing data already satisfies the invariant (enforced by
-- the FOR UPDATE logic all along) so the index creation can't fail on
-- pre-existing violations.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open_per_employee
  ON shifts (organization_id, employee_id)
  WHERE status = 'open';

CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open_per_location
  ON shifts (organization_id, location_id)
  WHERE status = 'open';

COMMIT;
