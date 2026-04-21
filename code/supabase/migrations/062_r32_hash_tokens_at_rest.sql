-- R32-D3 / R31-M11: hash `pending_signups.verification_token` and
-- `password_resets.token` at rest.
--
-- Prior shape stored both as plaintext. A read-only DB compromise
-- (backup leak, log sink, replica access) handed the attacker:
--   • working `/api/auth/verify?token=…` links for every pending
--     signup — account takeover at signup-completion time.
--   • working `/api/auth/password-reset-confirm?token=…` links for
--     every outstanding reset — instant takeover of any account
--     currently in reset-flow, without needing the victim's email.
-- Standard practice: store `sha256(token)` and compare on redemption.
-- The raw token stays ONLY in the email we just sent the user.
--
-- Backward-compat: existing rows (if any) get their tokens hashed
-- in-place by re-running sha256 on the stored plaintext. Anyone
-- holding a pre-deploy email link will still be able to redeem
-- because `/api/auth/verify` and `password-reset-confirm` are
-- updated in the same deploy to hash the incoming token BEFORE
-- lookup.
--
-- Column rename: rename `verification_token` → `verification_token_
-- hash` and `token` → `token_hash` to make the semantic shift
-- explicit so no future edit accidentally compares plaintext.

BEGIN;

-- R32-X4 + R33-M-pgcrypto-schema: install pgcrypto INTO extensions
-- schema (Supabase convention). Prior shape was unqualified → on
-- fresh DBs pgcrypto could land in `public` and break later Supabase
-- managed upgrades that expect `extensions.digest`. `IF NOT EXISTS`
-- is still idempotent: if pgcrypto is already present (Supabase
-- default) the CREATE is a no-op regardless of schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ─── pending_signups ────────────────────────────────────────────────
-- R33-M-062-idem: make the column rename idempotent. Prior shape
-- failed on re-run with `column "verification_token" does not
-- exist`. Guard each step so ops can safely replay this file.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
      WHERE table_name = 'pending_signups' AND column_name = 'verification_token'
  ) THEN
    -- Hash existing plaintext tokens in-place so legacy in-flight
    -- emails still resolve. Any row written post-deploy arrives
    -- already-hashed.
    UPDATE pending_signups
      SET verification_token = encode(extensions.digest(verification_token, 'sha256'), 'hex')
      WHERE length(verification_token) <> 64;  -- 64 hex chars = already sha256

    ALTER TABLE pending_signups
      RENAME COLUMN verification_token TO verification_token_hash;

    ALTER TABLE pending_signups
      DROP CONSTRAINT IF EXISTS pending_signups_verification_token_key;
    ALTER TABLE pending_signups
      ADD CONSTRAINT pending_signups_verification_token_hash_key
      UNIQUE (verification_token_hash);
  END IF;
END$$;

-- ─── password_resets ────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
      WHERE table_name = 'password_resets' AND column_name = 'token'
  ) THEN
    UPDATE password_resets
      SET token = encode(extensions.digest(token, 'sha256'), 'hex')
      WHERE length(token) <> 64;

    ALTER TABLE password_resets
      RENAME COLUMN token TO token_hash;

    DROP INDEX IF EXISTS uniq_password_resets_token;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_password_resets_token_hash
      ON password_resets(token_hash);
  END IF;
END$$;

COMMIT;
