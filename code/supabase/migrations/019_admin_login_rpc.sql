-- RPC: look up admin credentials by email.
-- Returns employee_id, password_hash, organization_id, role_key.
-- SECURITY DEFINER bypasses RLS on auth_credentials.
CREATE OR REPLACE FUNCTION admin_login_lookup(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'employee_id', ac.employee_id,
    'password_hash', ac.password_hash,
    'organization_id', e.organization_id,
    'role_key', e.role_key,
    'is_active', e.is_active
  ) INTO v_result
  FROM auth_credentials ac
  JOIN employees e ON ac.employee_id = e.id
  WHERE LOWER(ac.email) = LOWER(p_email)
    AND e.is_active = true
  LIMIT 1;

  RETURN v_result;
END;
$$;

-- RPC: create an admin session (delete old ones first).
-- SECURITY DEFINER bypasses RLS on sessions.
CREATE OR REPLACE FUNCTION admin_login_create_session(
  p_employee_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_created_at timestamptz,
  p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM sessions WHERE scope = 'admin' AND employee_id = p_employee_id;
  INSERT INTO sessions (id, employee_id, organization_id, scope, location_id, created_at, last_seen_at, expires_at)
  VALUES (p_session_id, p_employee_id, p_organization_id, 'admin', NULL, p_created_at, p_created_at, p_expires_at);
END;
$$;
