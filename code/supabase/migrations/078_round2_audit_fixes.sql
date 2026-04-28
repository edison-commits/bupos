-- Migration 078: round-2 audit fixes — schema cleanup.
--
-- Two findings from the round-2 audit:
--
-- SCH2-M1: register_quick_switch p_new_employee_id had `DEFAULT NULL`
--   in mig 077, but sessions/register_sessions/shifts.employee_id
--   columns are all NOT NULL — a NULL pass would hit constraint 23502
--   AFTER the cross-row org checks ran. Live impact zero (current
--   caller always passes non-null), but the DEFAULT signals NULL is
--   allowed. Drop the default + add an explicit NULL-check for a
--   clearer error message.
--
-- SCH2-L1: shifts.blind_close BOOLEAN lacked NOT NULL. The TS
--   contract types it as non-null and every code path supplies a
--   value, but a future code path that omits the column would insert
--   NULL and downstream `if (shift.blindClose)` would treat NULL as
--   falsy without protest.

-- ── SCH2-M1: register_quick_switch defensive NULL check ──────────────
-- CREATE OR REPLACE preserves grants; we redeclare the function with
-- the same signature minus the DEFAULT NULL and add an explicit
-- RAISE EXCEPTION for missing employee_id.
CREATE OR REPLACE FUNCTION public.register_quick_switch(
  p_session_id text,
  p_register_session_id text,
  p_active_shift_id text DEFAULT NULL,
  p_new_employee_id text DEFAULT NULL  -- kept for binary signature
                                       -- compat with mig 077; the
                                       -- runtime check below makes
                                       -- the DEFAULT a clear error
                                       -- rather than a NOT NULL
                                       -- violation downstream.
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $function$
DECLARE
  v_session_org uuid;
  v_rs_org uuid;
  v_shift_org uuid;
  v_new_emp_org uuid;
BEGIN
  -- SCH2-M1: explicit NULL check. sessions/register_sessions/shifts.
  -- employee_id are all NOT NULL — the prior shape would hit 23502
  -- AFTER the cross-row checks ran, with a confusing DB error. Now
  -- the caller gets a clear semantic error.
  IF p_new_employee_id IS NULL THEN
    RAISE EXCEPTION 'register_quick_switch: p_new_employee_id is required';
  END IF;

  -- ISO-MED1: cross-row consistency check. All four ids must resolve
  -- to the SAME org.
  SELECT organization_id INTO v_session_org FROM sessions WHERE id = p_session_id::uuid;
  SELECT organization_id INTO v_rs_org FROM register_sessions WHERE id = p_register_session_id::uuid;
  IF v_session_org IS NULL OR v_rs_org IS NULL THEN
    RAISE EXCEPTION 'Session or register_session not found';
  END IF;
  IF v_session_org <> v_rs_org THEN
    RAISE EXCEPTION 'Cross-tenant session/register_session pair';
  END IF;
  SELECT organization_id INTO v_new_emp_org FROM employees WHERE id = p_new_employee_id::uuid;
  IF v_new_emp_org IS NULL OR v_new_emp_org <> v_session_org THEN
    RAISE EXCEPTION 'Cross-tenant employee in quick switch';
  END IF;
  IF p_active_shift_id IS NOT NULL THEN
    SELECT organization_id INTO v_shift_org FROM shifts WHERE id = p_active_shift_id::uuid;
    IF v_shift_org IS NULL OR v_shift_org <> v_session_org THEN
      RAISE EXCEPTION 'Cross-tenant shift in quick switch';
    END IF;
  END IF;

  UPDATE sessions SET employee_id = p_new_employee_id::uuid
  WHERE id = p_session_id::uuid
    AND organization_id = v_session_org;
  UPDATE register_sessions SET employee_id = p_new_employee_id::uuid, updated_at = NOW()
  WHERE id = p_register_session_id::uuid
    AND organization_id = v_rs_org;
  IF p_active_shift_id IS NOT NULL THEN
    UPDATE shifts SET employee_id = p_new_employee_id::uuid
    WHERE id = p_active_shift_id::uuid
      AND organization_id = v_shift_org;
  END IF;
END;
$function$;

-- Re-grant defensively (CREATE OR REPLACE preserves them, but pinning
-- here makes the migration self-contained for fresh-DB replays).
REVOKE EXECUTE ON FUNCTION public.register_quick_switch(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.register_quick_switch(text, text, text, text) TO service_role;

-- ── SCH2-L1: shifts.blind_close NOT NULL ────────────────────────────
-- Existing rows must have a value (DEFAULT was `false`), so the SET
-- NOT NULL should not fail. Defensive backfill is included anyway.
UPDATE shifts SET blind_close = false WHERE blind_close IS NULL;
ALTER TABLE shifts ALTER COLUMN blind_close SET NOT NULL;

-- Verification: blind_close is NOT NULL after this migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'shifts'
      AND column_name = 'blind_close'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'SCH2-L1: blind_close did not land as NOT NULL — abort';
  END IF;
END $$;
