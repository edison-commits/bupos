-- R14-M-6: migration 039 correctly fixed the audit FKs to ON DELETE SET NULL
-- so hard-deleting an employee preserves their audit trail. But the
-- operational sales-history FKs were left on ON DELETE CASCADE:
--   shifts.employee_id              → CASCADE (001_initial_schema.sql:228)
--   transactions.employee_id        → CASCADE (001_initial_schema.sql:255)
--   time_clock_entries.employee_id  → CASCADE (001_initial_schema.sql:343)
--   pay_in_outs.employee_id         → CASCADE (001_initial_schema.sql:390)
--
-- A single "DELETE FROM employees WHERE id = X" in Supabase Studio (or
-- any admin tool that bypasses the app's deactivate path) wipes every
-- shift, transaction, clock-in/out, and pay-in/out that employee ever
-- touched. That's worse than the audit trail destruction 039 closed —
-- it loses operational history used for payroll reconciliation and
-- compliance.
--
-- The app path uses soft delete (is_active = false), so no prod damage
-- today; this migration hardens the schema against future mistakes.
-- FK widened to nullable, CASCADE → SET NULL. Reports + UIs already
-- COALESCE the join to a placeholder name when the employee row is
-- gone (e.g., "Unknown" / "Former employee").
--
-- Idempotent: ALTER CONSTRAINT is rewritten via DROP + ADD; guarded on
-- existence of the current constraint name.

BEGIN;

-- shifts.employee_id
ALTER TABLE shifts ALTER COLUMN employee_id DROP NOT NULL;
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_employee_id_fkey;
ALTER TABLE shifts ADD CONSTRAINT shifts_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;

-- transactions.employee_id
ALTER TABLE transactions ALTER COLUMN employee_id DROP NOT NULL;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_employee_id_fkey;
ALTER TABLE transactions ADD CONSTRAINT transactions_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;

-- time_clock_entries.employee_id
ALTER TABLE time_clock_entries ALTER COLUMN employee_id DROP NOT NULL;
ALTER TABLE time_clock_entries DROP CONSTRAINT IF EXISTS time_clock_entries_employee_id_fkey;
ALTER TABLE time_clock_entries ADD CONSTRAINT time_clock_entries_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;

-- pay_in_outs.employee_id
ALTER TABLE pay_in_outs ALTER COLUMN employee_id DROP NOT NULL;
ALTER TABLE pay_in_outs DROP CONSTRAINT IF EXISTS pay_in_outs_employee_id_fkey;
ALTER TABLE pay_in_outs ADD CONSTRAINT pay_in_outs_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;

COMMIT;
