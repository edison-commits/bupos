-- RPC function: resolve a register session by auth session ID.
-- Returns session, register_session, and active shift in a single HTTP call.
-- SECURITY DEFINER so the anon key can call it (bypasses RLS).
CREATE OR REPLACE FUNCTION resolve_register_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session   jsonb;
  v_reg       jsonb;
  v_shift     jsonb;
  v_stale_hours constant int := 8;
BEGIN
  -- 1. Find valid auth session
  SELECT jsonb_build_object(
    'id', s.id,
    'employee_id', s.employee_id,
    'organization_id', s.organization_id,
    'scope', s.scope,
    'location_id', s.location_id,
    'created_at', s.created_at,
    'last_seen_at', s.last_seen_at,
    'expires_at', s.expires_at
  ) INTO v_session
  FROM sessions s
  WHERE s.id = p_session_id
    AND s.scope = 'register'
    AND s.expires_at > NOW()
  LIMIT 1;

  IF v_session IS NULL THEN
    RETURN NULL;
  END IF;

  -- 2. Touch last_seen_at
  UPDATE sessions SET last_seen_at = NOW() WHERE id = p_session_id;

  -- 3. Find active register session (with stale guard)
  SELECT jsonb_build_object(
    'id', rs.id,
    'auth_session_id', rs.auth_session_id,
    'employee_id', rs.employee_id,
    'location_id', rs.location_id,
    'status', rs.status,
    'started_at', rs.started_at,
    'ended_at', rs.ended_at,
    'active_shift_id', rs.active_shift_id,
    'last_cart_id', rs.last_cart_id,
    'last_transaction_id', rs.last_transaction_id,
    'pending_exception_ids', rs.pending_exception_ids,
    'device_id', rs.device_id
  ) INTO v_reg
  FROM register_sessions rs
  JOIN sessions s ON s.id = rs.auth_session_id
  WHERE rs.auth_session_id = p_session_id
    AND rs.status = 'active'
    AND (s.last_seen_at IS NULL OR s.last_seen_at > NOW() - make_interval(hours => v_stale_hours))
  LIMIT 1;

  IF v_reg IS NULL THEN
    RETURN jsonb_build_object('session', v_session, 'register_session', NULL, 'shift', NULL);
  END IF;

  -- 4. Find active shift if any
  IF (v_reg->>'active_shift_id') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', sh.id,
      'location_id', sh.location_id,
      'employee_id', sh.employee_id,
      'register_session_id', sh.register_session_id,
      'status', sh.status,
      'opened_at', sh.opened_at,
      'opening_float', sh.opening_float,
      'opened_note', sh.opened_note,
      'closed_at', sh.closed_at,
      'closing_expected_cash', sh.closing_expected_cash,
      'closing_declared_cash', sh.closing_declared_cash,
      'closing_variance', sh.closing_variance,
      'closed_note', sh.closed_note,
      'blind_close', sh.blind_close
    ) INTO v_shift
    FROM shifts sh
    WHERE sh.id = (v_reg->>'active_shift_id')::uuid
      AND sh.status = 'open'
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object('session', v_session, 'register_session', v_reg, 'shift', v_shift);
END;
$$;
