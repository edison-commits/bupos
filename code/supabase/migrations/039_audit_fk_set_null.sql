-- R12-M-3: `audit_events.actor_employee_id` and
-- `transaction_events.actor_employee_id` were declared with
-- `ON DELETE CASCADE` in 001_initial_schema.sql. Hard-deleting an
-- employee wipes their entire audit trail — the opposite of what an
-- audit log should do.
--
-- Switch both to `ON DELETE SET NULL` so the trail survives an
-- employee hard delete. We also widen the column to nullable to make
-- the new FK behavior valid. No backfill needed — existing rows all
-- reference live employees (no hard deletes have happened yet).
--
-- Callers that render "actor_name" already COALESCE against the
-- employees join (`COALESCE(e.display_name, e.first_name || ' ' || e.last_name, 'Unknown')`);
-- after SET NULL, the join yields no row and the COALESCE falls to
-- 'Unknown' / 'System'. That's the correct "this actor no longer exists"
-- display, vs. silently disappearing the log entry.

BEGIN;

-- ── transaction_events.actor_employee_id ──────────────────────────────
ALTER TABLE transaction_events
  ALTER COLUMN actor_employee_id DROP NOT NULL;

ALTER TABLE transaction_events
  DROP CONSTRAINT IF EXISTS transaction_events_actor_employee_id_fkey;

ALTER TABLE transaction_events
  ADD CONSTRAINT transaction_events_actor_employee_id_fkey
  FOREIGN KEY (actor_employee_id)
  REFERENCES employees(id)
  ON DELETE SET NULL;

-- ── audit_events.actor_employee_id ────────────────────────────────────
ALTER TABLE audit_events
  ALTER COLUMN actor_employee_id DROP NOT NULL;

ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS audit_events_actor_employee_id_fkey;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_actor_employee_id_fkey
  FOREIGN KEY (actor_employee_id)
  REFERENCES employees(id)
  ON DELETE SET NULL;

COMMIT;
