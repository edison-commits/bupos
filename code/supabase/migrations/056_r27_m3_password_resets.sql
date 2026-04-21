-- R27-M3: password-reset support.
--
-- The pre-R27 codebase shipped no password-change and no password-
-- reset flow anywhere — a legitimate owner who lost their password
-- (or suspected compromise) had no application path to recover.
-- The only way to rotate `auth_credentials.password_hash` was to
-- edit the DB directly. This migration adds the tracking table the
-- new /api/auth/password-reset-* endpoints rely on.
--
-- Table shape mirrors `pending_signups` (migration 049):
--   • one row per outstanding reset request, keyed by a 256-bit
--     verification token (base64url, 43-chars)
--   • `expires_at` bounds the window (1 hour default)
--   • `used_at` set on redemption so a token can't be replayed
--   • unique index on token so a single DELETE ... WHERE token
--     atomically redeems it
--
-- Rate-limit + dedup is handled at the application layer:
-- repeated requests for the same email inside the window resend
-- the same token rather than creating additional rows.

BEGIN;

CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  ip_address text,
  user_agent text
);

-- Token is the primary lookup key; globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_password_resets_token ON password_resets(token);

-- Lookup by email for the "resend in-flight token" path.
CREATE INDEX IF NOT EXISTS idx_password_resets_email_created
  ON password_resets(lower(email), created_at DESC);

-- FORCE RLS on this table too. The app's postgres role has BYPASSRLS
-- so this is cosmetic at the runtime layer, but forms a defense-in-
-- depth line for any future lower-privilege role.
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;

-- Service-role-only access (mirrors pending_signups pattern).
DROP POLICY IF EXISTS password_resets_service_role_full_access ON password_resets;
CREATE POLICY password_resets_service_role_full_access
  ON password_resets FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMIT;
