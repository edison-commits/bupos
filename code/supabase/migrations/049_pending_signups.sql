-- R8-M-12 + R8-L-5 closed: email-verified signup flow.
--
-- Previously `signupAction` created org + location + employee +
-- auth_credentials immediately and signed the caller in. Attackers
-- cycling disposable emails could mint orgs at will — each signup adds
-- a row to `auth_credentials`, inflating the PIN-collision scan cost
-- for every register-login call. Plus the existence check returned a
-- distinct "account already exists" error, an email-enumeration oracle.
--
-- New flow:
--   1. signupAction INSERT only into `pending_signups` with a verification
--      token and 24h expiry. Always returns the same generic response
--      ("check your inbox") whether or not the email is already in use —
--      no enumeration.
--   2. Verification link fires a GET /api/auth/verify?token=... which
--      transactionally consumes the row, creates the org + location +
--      employee + auth_credentials, and signs the caller in.
--   3. Stale rows auto-clean via the scheduled cleanup function at the
--      bottom of this migration (7-day retention).

BEGIN;

CREATE TABLE IF NOT EXISTS pending_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  store_name text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  password_hash text NOT NULL,
  -- 32-byte URL-safe random token; indexed for verify lookup.
  verification_token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_signups_email ON pending_signups(lower(email));
CREATE INDEX IF NOT EXISTS idx_pending_signups_expires_at ON pending_signups(expires_at);

-- Not tenanted — each row belongs to a PROSPECTIVE org that doesn't exist
-- yet. Enable + force RLS anyway to match the rest of the tree; grant
-- service_role full access (the signupAction + verify route both run
-- with the service-role-provisioned `postgres` pool).
ALTER TABLE pending_signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_signups FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_full_access ON pending_signups;
CREATE POLICY service_role_full_access ON pending_signups
  USING (true)
  WITH CHECK (true);

-- Scheduled cleanup helper (see migration 048 pattern).
CREATE OR REPLACE FUNCTION public.cleanup_stale_pending_signups(
  p_older_than_interval interval DEFAULT '7 days'
)
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
DECLARE
  v_cleared bigint;
BEGIN
  DELETE FROM pending_signups
    WHERE expires_at < now() - p_older_than_interval;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  RETURN v_cleared;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cleanup_stale_pending_signups(interval) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cleanup_stale_pending_signups(interval) TO service_role;

COMMIT;
