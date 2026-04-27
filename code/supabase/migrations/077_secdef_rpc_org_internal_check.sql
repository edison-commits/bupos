-- Migration 077: ISO-MED1 — defense-in-depth org checks inside the
-- register_* SECDEF RPCs.
--
-- The four RPCs in mig 040 (register_open_shift, register_close_shift,
-- register_insert_audit, register_quick_switch) execute as SECURITY
-- DEFINER and update rows keyed on id alone. Live attack surface is
-- closed at the application layer (every caller verifies the row's
-- org membership in the same orgTx — see e.g. src/app/register/
-- actions.ts:639-647 for register_quick_switch). But defense-in-depth
-- says: a future caller forgetting the app-layer check would silently
-- mutate a foreign tenant's row.
--
-- Fix: add cross-row consistency checks. Each RPC verifies that all
-- of its target rows belong to the SAME org and (when org_id is
-- supplied as a parameter) that the supplied org matches what the
-- target rows contain. RAISE EXCEPTION on mismatch. No signature
-- change — keeps every existing caller working.

-- ── register_open_shift ─────────────────────────────────────────────
-- Already takes p_organization_id; add a verification step that the
-- supplied org matches the location's org and the employee's org.
CREATE OR REPLACE FUNCTION public.register_open_shift(
  p_id text,
  p_organization_id text,
  p_location_id text,
  p_employee_id text,
  p_register_session_id text DEFAULT NULL,
  p_opening_float numeric DEFAULT 0,
  p_opened_note text DEFAULT NULL
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $function$
DECLARE
  v_ts timestamptz := NOW();
  v_row shifts%ROWTYPE;
  v_loc_org uuid;
  v_emp_org uuid;
  v_rs_org uuid;
BEGIN
  -- ISO-MED1: verify caller-supplied org matches what the target
  -- rows actually claim. Fail closed on cross-tenant inputs.
  SELECT organization_id INTO v_loc_org FROM locations WHERE id = p_location_id::uuid;
  SELECT organization_id INTO v_emp_org FROM employees WHERE id = p_employee_id::uuid;
  IF v_loc_org IS NULL OR v_emp_org IS NULL THEN
    RAISE EXCEPTION 'Location or employee not found';
  END IF;
  IF v_loc_org <> p_organization_id::uuid OR v_emp_org <> p_organization_id::uuid THEN
    RAISE EXCEPTION 'Cross-tenant location/employee in shift open';
  END IF;
  IF p_register_session_id IS NOT NULL THEN
    SELECT organization_id INTO v_rs_org FROM register_sessions WHERE id = p_register_session_id::uuid;
    IF v_rs_org IS NULL OR v_rs_org <> p_organization_id::uuid THEN
      RAISE EXCEPTION 'Cross-tenant register_session in shift open';
    END IF;
  END IF;

  BEGIN
    INSERT INTO shifts (id, organization_id, location_id, employee_id, register_session_id, status, opened_at, opening_float, opened_note)
    VALUES (p_id::uuid, p_organization_id::uuid, p_location_id::uuid, p_employee_id::uuid,
            p_register_session_id::uuid, 'open', v_ts, p_opening_float, p_opened_note)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Employee already has an open shift';
  END;
  IF p_register_session_id IS NOT NULL THEN
    UPDATE register_sessions SET active_shift_id = p_id::uuid
    WHERE id = p_register_session_id::uuid
      AND organization_id = p_organization_id::uuid;
  END IF;
  RETURN jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'opened_at', v_row.opened_at,
    'opening_float', v_row.opening_float
  );
END;
$function$;

-- ── register_close_shift ────────────────────────────────────────────
-- Did NOT previously take org_id. Verify the shift and register_session
-- both belong to the SAME org via cross-table consistency check.
CREATE OR REPLACE FUNCTION public.register_close_shift(
  p_shift_id text,
  p_register_session_id text,
  p_closing_expected_cash numeric,
  p_closing_declared_cash numeric,
  p_closed_note text DEFAULT NULL
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $function$
DECLARE
  v_ts timestamptz := NOW();
  v_variance numeric;
  v_row shifts%ROWTYPE;
  v_shift_org uuid;
  v_rs_org uuid;
BEGIN
  -- ISO-MED1: cross-row consistency check. shift and register_session
  -- must share the same org_id; otherwise a future caller passing a
  -- shift_id from one tenant + register_session_id from another would
  -- close shift A while clearing register_session B's active_shift_id.
  SELECT organization_id INTO v_shift_org FROM shifts WHERE id = p_shift_id::uuid;
  SELECT organization_id INTO v_rs_org FROM register_sessions WHERE id = p_register_session_id::uuid;
  IF v_shift_org IS NULL OR v_rs_org IS NULL THEN
    RAISE EXCEPTION 'Shift or register_session not found';
  END IF;
  IF v_shift_org <> v_rs_org THEN
    RAISE EXCEPTION 'Cross-tenant shift/register_session pair';
  END IF;

  v_variance := ROUND(p_closing_declared_cash - p_closing_expected_cash, 2);
  UPDATE shifts SET status = 'closed', closed_at = v_ts,
    closing_expected_cash = p_closing_expected_cash,
    closing_declared_cash = p_closing_declared_cash,
    closing_variance = v_variance,
    closed_note = p_closed_note
  WHERE id = p_shift_id::uuid AND status = 'open'
    AND organization_id = v_shift_org
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found or already closed';
  END IF;
  UPDATE register_sessions SET active_shift_id = NULL
  WHERE id = p_register_session_id::uuid
    AND organization_id = v_rs_org;
  RETURN jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'closed_at', v_row.closed_at,
    'closing_variance', v_variance
  );
END;
$function$;

-- ── register_insert_audit ───────────────────────────────────────────
-- Already takes p_org_id; verify the supplied org matches what the
-- referenced rows (location, employee) actually claim. Catches a future
-- caller passing a body-derived org_id with mismatched location/employee.
CREATE OR REPLACE FUNCTION public.register_insert_audit(
  p_org_id text,
  p_location_id text DEFAULT NULL,
  p_employee_id text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id text DEFAULT NULL,
  p_event_kind text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $function$
DECLARE
  v_loc_org uuid;
  v_emp_org uuid;
BEGIN
  -- ISO-MED1: when location_id is supplied, verify it belongs to the
  -- claimed org. Same for employee_id. NULL is allowed (some events
  -- don't have a location or actor).
  IF p_location_id IS NOT NULL THEN
    SELECT organization_id INTO v_loc_org FROM locations WHERE id = p_location_id::uuid;
    IF v_loc_org IS NULL OR v_loc_org <> p_org_id::uuid THEN
      RAISE EXCEPTION 'Cross-tenant location in audit insert';
    END IF;
  END IF;
  IF p_employee_id IS NOT NULL THEN
    SELECT organization_id INTO v_emp_org FROM employees WHERE id = p_employee_id::uuid;
    IF v_emp_org IS NULL OR v_emp_org <> p_org_id::uuid THEN
      RAISE EXCEPTION 'Cross-tenant employee in audit insert';
    END IF;
  END IF;

  INSERT INTO audit_events
    (organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload)
  VALUES
    (p_org_id::uuid, p_location_id::uuid, p_employee_id::uuid,
     p_entity_type, p_entity_id::uuid, p_event_kind, p_payload);
END;
$function$;

-- ── register_quick_switch ───────────────────────────────────────────
-- Did NOT previously take org_id. Verify session, register_session,
-- shift, and new_employee all belong to the SAME org.
CREATE OR REPLACE FUNCTION public.register_quick_switch(
  p_session_id text,
  p_register_session_id text,
  p_active_shift_id text DEFAULT NULL,
  p_new_employee_id text DEFAULT NULL
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
  -- ISO-MED1: cross-row consistency check. All four ids must resolve
  -- to the SAME org. A future caller forgetting the app-layer check
  -- would otherwise silently flip a foreign tenant's session to a
  -- different employee.
  SELECT organization_id INTO v_session_org FROM sessions WHERE id = p_session_id::uuid;
  SELECT organization_id INTO v_rs_org FROM register_sessions WHERE id = p_register_session_id::uuid;
  IF v_session_org IS NULL OR v_rs_org IS NULL THEN
    RAISE EXCEPTION 'Session or register_session not found';
  END IF;
  IF v_session_org <> v_rs_org THEN
    RAISE EXCEPTION 'Cross-tenant session/register_session pair';
  END IF;
  IF p_new_employee_id IS NOT NULL THEN
    SELECT organization_id INTO v_new_emp_org FROM employees WHERE id = p_new_employee_id::uuid;
    IF v_new_emp_org IS NULL OR v_new_emp_org <> v_session_org THEN
      RAISE EXCEPTION 'Cross-tenant employee in quick switch';
    END IF;
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

-- Re-grant — CREATE OR REPLACE preserves grants but be defensive.
REVOKE EXECUTE ON FUNCTION public.register_open_shift(text, text, text, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_close_shift(text, text, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_insert_audit(text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_quick_switch(text, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.register_open_shift(text, text, text, text, text, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_close_shift(text, text, numeric, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_insert_audit(text, text, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_quick_switch(text, text, text, text) TO service_role;
