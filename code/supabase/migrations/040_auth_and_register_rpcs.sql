-- R12-M-4: codify the 9 RPCs that exist in production Supabase but had no
-- CREATE FUNCTION migration. Without this file, fresh-DB bootstrap
-- (dev onboarding, DR restore, staging spinup) landed a schema where the
-- whole auth flow 500'd because these functions never got created.
--
-- Source: pulled from production via `pg_get_functiondef()` on Supabase
-- project jkdgdcfpgxjfdlccvqjf. Matches live prod signatures + bodies
-- exactly, so re-applying in prod is a no-op (CREATE OR REPLACE preserves
-- execute grants but replaces the body — verified identical).
--
-- Ordering note: migrations 027 + 028 REVOKE/GRANT on these RPCs. If those
-- migrations ran on a fresh DB before 040, they would fail with "function
-- does not exist". The companion edits to 027 + 028 wrap each REVOKE/GRANT
-- in an IF EXISTS guard so those migrations become idempotent and no-op
-- on first run, then this migration creates + re-applies the service-role
-- grants to land the correct final state.
--
-- All 9 RPCs are SECURITY DEFINER; the hardened grant policy (this file's
-- REVOKE + GRANT block at the bottom) restricts EXECUTE to service_role.

BEGIN;

-- ── find_session ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.find_session(p_session_id uuid, p_scope text)
  RETURNS TABLE(
    id uuid, employee_id uuid, organization_id uuid, scope text,
    location_id uuid, created_at timestamptz, last_seen_at timestamptz,
    expires_at timestamptz
  )
  LANGUAGE sql
  STABLE SECURITY DEFINER
AS $function$
  SELECT s.id, s.employee_id, s.organization_id, s.scope, s.location_id,
         s.created_at, s.last_seen_at, s.expires_at
  FROM sessions s
  WHERE s.id = p_session_id AND s.scope = p_scope AND s.expires_at > NOW()
  LIMIT 1;
$function$;

-- ── get_full_store ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_full_store(org_id uuid)
  RETURNS json
  LANGUAGE sql
  SECURITY DEFINER
AS $function$
SELECT json_build_object(
  'org',               (SELECT row_to_json(o) FROM organizations o WHERE o.id = org_id),
  'locations',         (SELECT coalesce(json_agg(l.*), '[]') FROM locations l WHERE l.organization_id = org_id AND l.is_active = true),
  'employees',         (SELECT coalesce(json_agg(e.*), '[]') FROM employees e WHERE e.organization_id = org_id),
  'categories',        (SELECT coalesce(json_agg(c.*), '[]') FROM categories c WHERE c.organization_id = org_id),
  'products',          (SELECT coalesce(json_agg(p.*), '[]') FROM products p WHERE p.organization_id = org_id),
  'variants',          (SELECT coalesce(json_agg(v.*), '[]') FROM product_variants v WHERE v.organization_id = org_id),
  'inventory',         (SELECT coalesce(json_agg(i.*), '[]') FROM inventory_levels i WHERE i.organization_id = org_id),
  'customers',         (SELECT coalesce(json_agg(cust.*), '[]') FROM customers cust WHERE cust.organization_id = org_id),
  'promo_codes',       (SELECT coalesce(json_agg(pc.*), '[]') FROM promo_codes pc WHERE pc.organization_id = org_id),
  'modifier_groups',   (SELECT coalesce(json_agg(mg.*), '[]') FROM modifier_groups mg WHERE mg.organization_id = org_id),
  'modifiers',         (SELECT coalesce(json_agg(m.*), '[]') FROM modifiers m WHERE m.organization_id = org_id),
  -- R13-H-4: project ONLY the columns the app needs. Previously `ac.*`
  -- shipped `password_hash` + `pin_hash` into every cache refresh's JSON
  -- payload, traversing Worker memory unnecessarily. Credential hashes
  -- should only flow through the narrow login-time RPCs
  -- (`admin_login_lookup`, `register_pin_candidates`). TS side at
  -- `postgres-read-store.ts:172` only consumes employee_id + email +
  -- password_last_rotated_at + pin_last_rotated_at, so this projection
  -- is a drop-in replacement.
  'auth_credentials',  (SELECT coalesce(json_agg(json_build_object(
                        'employee_id', ac.employee_id,
                        'email', ac.email,
                        'password_last_rotated_at', ac.password_last_rotated_at,
                        'pin_last_rotated_at', ac.pin_last_rotated_at
                      )), '[]')
                      FROM auth_credentials ac JOIN employees e2 ON e2.id = ac.employee_id WHERE e2.organization_id = org_id),
  'sessions',          (SELECT coalesce(json_agg(s.*), '[]') FROM (SELECT * FROM sessions WHERE organization_id = org_id ORDER BY created_at DESC LIMIT 20) s),
  'shifts',            (SELECT coalesce(json_agg(sf.*), '[]') FROM (SELECT sf.* FROM shifts sf JOIN locations loc ON loc.id = sf.location_id WHERE loc.organization_id = org_id ORDER BY sf.opened_at DESC LIMIT 20) sf),
  'register_sessions', (SELECT coalesce(json_agg(rs.*), '[]') FROM (SELECT * FROM register_sessions WHERE organization_id = org_id ORDER BY started_at DESC LIMIT 20) rs),
  'pay_in_outs',       (SELECT coalesce(json_agg(pio.*), '[]') FROM (SELECT * FROM pay_in_outs WHERE organization_id = org_id ORDER BY created_at DESC LIMIT 50) pio),
  'transaction_tenders', (
    SELECT coalesce(json_agg(tt.*), '[]')
    FROM transaction_tenders tt
    JOIN transactions t ON t.id = tt.transaction_id
    WHERE t.organization_id = org_id AND tt.created_at >= NOW() - INTERVAL '7 days'
  ),
  'transaction_events', (
    SELECT coalesce(json_agg(te.*), '[]')
    FROM transaction_events te
    JOIN transactions t ON t.id = te.transaction_id
    WHERE t.organization_id = org_id AND te.created_at >= NOW() - INTERVAL '7 days'
  ),
  'transactions', (
    SELECT coalesce(json_agg(t.*), '[]')
    FROM transactions t
    WHERE t.organization_id = org_id AND t.created_at >= NOW() - INTERVAL '7 days'
  )
)
$function$;

-- ── register_pin_candidates ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.register_pin_candidates(p_location_id text)
  RETURNS TABLE(
    employee_id text, email text, pin_hash text, pin_last_rotated_at timestamptz,
    organization_id text, role_key text, location_ids text[]
  )
  LANGUAGE sql
  SECURITY DEFINER
AS $function$
  SELECT ac.employee_id::text, ac.email::text, ac.pin_hash, ac.pin_last_rotated_at,
         e.organization_id::text, e.role_key,
         ARRAY(SELECT unnest(e.location_ids)::text)
  FROM auth_credentials ac
  JOIN employees e ON ac.employee_id = e.id
  JOIN locations l ON l.organization_id = e.organization_id
    AND l.id = p_location_id::uuid AND l.is_active = true
  WHERE e.is_active = true AND ac.pin_hash IS NOT NULL;
$function$;

-- ── register_login_create_session ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.register_login_create_session(
  p_employee_id text,
  p_organization_id text,
  p_location_id text,
  p_device_id text DEFAULT NULL,
  p_session_id text DEFAULT NULL,
  p_register_session_id text DEFAULT NULL,
  p_created_at timestamptz DEFAULT now(),
  p_expires_at timestamptz DEFAULT (now() + '1 day'::interval)
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
BEGIN
  DELETE FROM sessions WHERE scope = 'register' AND employee_id = p_employee_id::uuid;
  UPDATE register_sessions SET status = 'ended', ended_at = NOW()
    WHERE employee_id = p_employee_id::uuid
      AND location_id = p_location_id::uuid
      AND status = 'active';
  IF p_device_id IS NOT NULL THEN
    UPDATE register_sessions SET status = 'ended', ended_at = NOW()
      WHERE organization_id = p_organization_id::uuid
        AND device_id = p_device_id
        AND status = 'active';
  END IF;
  INSERT INTO sessions (id, employee_id, organization_id, scope, location_id, created_at, last_seen_at, expires_at)
  VALUES (p_session_id::uuid, p_employee_id::uuid, p_organization_id::uuid,
          'register', p_location_id::uuid, p_created_at, p_created_at, p_expires_at);
  INSERT INTO register_sessions (id, auth_session_id, employee_id, location_id, organization_id, device_id, status, started_at)
  VALUES (p_register_session_id::uuid, p_session_id::uuid, p_employee_id::uuid,
          p_location_id::uuid, p_organization_id::uuid, p_device_id, 'active', p_created_at);
  RETURN jsonb_build_object(
    'session_id', p_session_id,
    'register_session_id', p_register_session_id
  );
END;
$function$;

-- ── register_sign_out ─────────────────────────────────────────────────
-- R14-L-1: previously used `RETURNING id, ... INTO v_reg` on an UPDATE
-- whose predicate (`auth_session_id = $1 AND status='active'`) SHOULD
-- match at most one row — but a race with `register_login_create_session`
-- could leave multiple active register_sessions briefly. `INTO` captures
-- only the last scanned row; the other(s) would keep an open active_shift
-- with no auto-close. Rewrite as a loop so every row gets its shift
-- auto-closed. Same UX contract (one auth session in, one response out).
CREATE OR REPLACE FUNCTION public.register_sign_out(p_session_id text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
DECLARE
  v_ts timestamptz := NOW();
  v_reg RECORD;
  v_last_id uuid;
BEGIN
  FOR v_reg IN
    UPDATE register_sessions SET status = 'ended', ended_at = v_ts
    WHERE auth_session_id = p_session_id::uuid AND status = 'active'
    RETURNING id, employee_id, active_shift_id
  LOOP
    v_last_id := v_reg.id;
    IF v_reg.active_shift_id IS NOT NULL THEN
      UPDATE shifts SET status = 'closed', closed_at = v_ts,
        closing_expected_cash = opening_float, closing_declared_cash = opening_float,
        closing_variance = 0,
        closed_note = 'Auto-closed because register session ended without manual shift close.'
      WHERE id = v_reg.active_shift_id AND status = 'open';
      UPDATE register_sessions SET active_shift_id = NULL WHERE id = v_reg.id;
    END IF;
  END LOOP;
  DELETE FROM sessions WHERE id = p_session_id::uuid;
  RETURN jsonb_build_object('ended', true, 'register_session_id', v_last_id);
END;
$function$;

-- ── register_open_shift ───────────────────────────────────────────────
-- R14-H-2: previously used `IF EXISTS ... FOR UPDATE` to enforce the
-- "one open shift per employee" invariant, but migration 043 installed
-- a partial UNIQUE INDEX that fires 23505 first on a race. Callers
-- regex-matched against `/already has an open shift/i` — which DOESN'T
-- match pg's 23505 message `duplicate key value violates unique
-- constraint ...`. Cashiers saw generic "Failed to open shift".
--
-- Fix: catch unique_violation here and RAISE with the human message so
-- the call-site regex continues to work unchanged.
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
AS $function$
DECLARE
  v_ts timestamptz := NOW();
  v_row shifts%ROWTYPE;
BEGIN
  BEGIN
    INSERT INTO shifts (id, organization_id, location_id, employee_id, register_session_id, status, opened_at, opening_float, opened_note)
    VALUES (p_id::uuid, p_organization_id::uuid, p_location_id::uuid, p_employee_id::uuid,
            p_register_session_id::uuid, 'open', v_ts, p_opening_float, p_opened_note)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    -- Partial unique index idx_shifts_one_open_per_employee (org, employee)
    -- WHERE status='open' fired. Raise the translated message so callers
    -- can detect this specifically.
    RAISE EXCEPTION 'Employee already has an open shift';
  END;
  IF p_register_session_id IS NOT NULL THEN
    UPDATE register_sessions SET active_shift_id = p_id::uuid
    WHERE id = p_register_session_id::uuid;
  END IF;
  RETURN jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'opened_at', v_row.opened_at,
    'opening_float', v_row.opening_float
  );
END;
$function$;

-- ── register_close_shift ──────────────────────────────────────────────
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
AS $function$
DECLARE
  v_ts timestamptz := NOW();
  v_variance numeric;
  v_row shifts%ROWTYPE;
BEGIN
  v_variance := ROUND(p_closing_declared_cash - p_closing_expected_cash, 2);
  UPDATE shifts SET status = 'closed', closed_at = v_ts,
    closing_expected_cash = p_closing_expected_cash,
    closing_declared_cash = p_closing_declared_cash,
    closing_variance = v_variance,
    closed_note = p_closed_note
  WHERE id = p_shift_id::uuid AND status = 'open'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found or already closed';
  END IF;
  UPDATE register_sessions SET active_shift_id = NULL
  WHERE id = p_register_session_id::uuid;
  RETURN jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'closed_at', v_row.closed_at,
    'closing_variance', v_variance
  );
END;
$function$;

-- ── register_insert_audit ─────────────────────────────────────────────
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
  LANGUAGE sql
  SECURITY DEFINER
AS $function$
  INSERT INTO audit_events
    (organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload)
  VALUES
    (p_org_id::uuid, p_location_id::uuid, p_employee_id::uuid,
     p_entity_type, p_entity_id::uuid, p_event_kind, p_payload);
$function$;

-- ── register_quick_switch ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.register_quick_switch(
  p_session_id text,
  p_register_session_id text,
  p_active_shift_id text DEFAULT NULL,
  p_new_employee_id text DEFAULT NULL
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
BEGIN
  UPDATE sessions SET employee_id = p_new_employee_id::uuid
  WHERE id = p_session_id::uuid;
  UPDATE register_sessions SET employee_id = p_new_employee_id::uuid, updated_at = NOW()
  WHERE id = p_register_session_id::uuid;
  IF p_active_shift_id IS NOT NULL THEN
    UPDATE shifts SET employee_id = p_new_employee_id::uuid
    WHERE id = p_active_shift_id::uuid;
  END IF;
END;
$function$;

-- ── Security: lock EXECUTE to service_role ────────────────────────────
-- Mirrors migrations 027 + 028 for these 9 RPCs so fresh-DB + prod land
-- on the same hardened state. Idempotent: REVOKE on a role that already
-- lacks the grant is a no-op, and GRANT on a role that already has it
-- is also a no-op.

REVOKE EXECUTE ON FUNCTION public.find_session(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_full_store(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_pin_candidates(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_login_create_session(text, text, text, text, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_sign_out(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_open_shift(text, text, text, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_close_shift(text, text, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_insert_audit(text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_quick_switch(text, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.find_session(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_full_store(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_pin_candidates(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_login_create_session(text, text, text, text, text, text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_sign_out(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_open_shift(text, text, text, text, text, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_close_shift(text, text, numeric, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_insert_audit(text, text, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_quick_switch(text, text, text, text) TO service_role;

COMMIT;
