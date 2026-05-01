-- Migration 079: round-4 audit fixes — schema cleanup.
--
-- Three findings from the round-4 audit:
--
-- SCH-AUDIT4-1 (HIGH): shifts.register_session_id was declared NOT
--   NULL in mig 001 but every code path admin-initiated path passes
--   NULL (mig 077 RPC `register_open_shift` declares
--   p_register_session_id text DEFAULT NULL; pgOpenShift in
--   postgres-store.ts types it `string | null`; /api/shifts POST
--   route.ts:239 passes literal null). Mig 045 introduced a partial
--   unique index `WHERE status='open' AND register_session_id IS
--   NOT NULL` — comment block already states the design assumed
--   admin shifts have NULL, but no migration ever dropped the
--   NOT NULL. Net effect: every admin POST /api/shifts hits 23502
--   not_null_violation and 500s.
--
-- SCH-AUDIT4-2 (MED): three FK columns on hard-employee-delete still
--   ON DELETE CASCADE, wiping financial / inventory history:
--     promo_redemptions.employee_id   (discount issuance audit)
--     transfers.requested_by          (inventory transfer history)
--     stocktakes.initiated_by         (stocktake adjustments — also
--                                      cascades to stocktake_lines)
--   Same hazard rationale as mig 046/070 (which fixed shifts /
--   transactions / time_clock_entries / pay_in_outs / layaways /
--   layaway_payments / behavior_flags). The app uses soft-delete
--   only, but a DBA-initiated `DELETE FROM employees` would
--   silently destroy financial / compliance records. Convert to
--   ON DELETE SET NULL + DROP NOT NULL for parity.

BEGIN;

-- ── SCH-AUDIT4-1: shifts.register_session_id nullable ───────────────
-- Idempotent: ALTER COLUMN ... DROP NOT NULL is a no-op if already
-- nullable. The partial unique index from mig 045 already filters
-- WHERE register_session_id IS NOT NULL so the index keeps working.
ALTER TABLE shifts ALTER COLUMN register_session_id DROP NOT NULL;

-- Verification: confirm the index from mig 045 still covers the
-- "one open shift per register_session" invariant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shifts'
      AND indexname = 'idx_shifts_unique_open_per_register'
  ) THEN
    RAISE NOTICE 'SCH-AUDIT4-1: idx_shifts_unique_open_per_register missing — register-session uniqueness no longer enforced';
  END IF;
END $$;

-- ── SCH-AUDIT4-2: cascade → set null on three remaining employee FKs ───

-- promo_redemptions.employee_id
DO $$
DECLARE
  v_cname text;
BEGIN
  SELECT con.conname INTO v_cname
  FROM pg_constraint con
  JOIN pg_class t ON t.oid = con.conrelid
  WHERE t.relname = 'promo_redemptions'
    AND con.contype = 'f'
    AND con.confrelid = (SELECT oid FROM pg_class WHERE relname = 'employees')
    AND con.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = t.oid AND attname = 'employee_id')];
  IF v_cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE promo_redemptions DROP CONSTRAINT %I', v_cname);
  END IF;
  ALTER TABLE promo_redemptions ALTER COLUMN employee_id DROP NOT NULL;
  ALTER TABLE promo_redemptions
    ADD CONSTRAINT promo_redemptions_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'SCH-AUDIT4-2: promo_redemptions table missing — skipped';
END $$;

-- transfers.requested_by
DO $$
DECLARE
  v_cname text;
BEGIN
  SELECT con.conname INTO v_cname
  FROM pg_constraint con
  JOIN pg_class t ON t.oid = con.conrelid
  WHERE t.relname = 'transfers'
    AND con.contype = 'f'
    AND con.confrelid = (SELECT oid FROM pg_class WHERE relname = 'employees')
    AND con.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = t.oid AND attname = 'requested_by')];
  IF v_cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE transfers DROP CONSTRAINT %I', v_cname);
  END IF;
  ALTER TABLE transfers ALTER COLUMN requested_by DROP NOT NULL;
  ALTER TABLE transfers
    ADD CONSTRAINT transfers_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'SCH-AUDIT4-2: transfers table missing — skipped';
END $$;

-- stocktakes.initiated_by
DO $$
DECLARE
  v_cname text;
BEGIN
  SELECT con.conname INTO v_cname
  FROM pg_constraint con
  JOIN pg_class t ON t.oid = con.conrelid
  WHERE t.relname = 'stocktakes'
    AND con.contype = 'f'
    AND con.confrelid = (SELECT oid FROM pg_class WHERE relname = 'employees')
    AND con.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = t.oid AND attname = 'initiated_by')];
  IF v_cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE stocktakes DROP CONSTRAINT %I', v_cname);
  END IF;
  ALTER TABLE stocktakes ALTER COLUMN initiated_by DROP NOT NULL;
  ALTER TABLE stocktakes
    ADD CONSTRAINT stocktakes_initiated_by_fkey
    FOREIGN KEY (initiated_by) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'SCH-AUDIT4-2: stocktakes table missing — skipped';
END $$;

COMMIT;
