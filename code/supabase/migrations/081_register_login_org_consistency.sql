-- Migration 081: SEC-AUDIT7-LOW — register_login_create_session cross-row
-- org-consistency guard (defense-in-depth parity with migration 077).
--
-- Unlike the four register RPCs hardened in mig 077, this one INSERTed the
-- session / register_session rows with whatever p_organization_id it was
-- handed, without verifying the employee + location actually belong to that
-- org. Every current caller (signInRegister, signInRegisterByEmployee, the
-- /api/auth/register-login route) derives the org from a validated lookup,
-- so it is NOT live-exploitable today — but a future caller that sourced the
-- org from a request body would write a session into the wrong tenant with
-- no DB backstop. Add the same RAISE EXCEPTION cross-row check the other
-- register RPCs got. CREATE OR REPLACE keeps the existing grants.

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
  -- SEC-AUDIT7-LOW: the employee AND the location must belong to
  -- p_organization_id (fail closed). Parity with mig 077's register RPCs.
  IF NOT EXISTS (
    SELECT 1 FROM employees e
     WHERE e.id = p_employee_id::uuid AND e.organization_id = p_organization_id::uuid
  ) THEN
    RAISE EXCEPTION 'Cross-tenant employee in register login';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM locations l
     WHERE l.id = p_location_id::uuid AND l.organization_id = p_organization_id::uuid
  ) THEN
    RAISE EXCEPTION 'Cross-tenant location in register login';
  END IF;

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
