-- Migration: add DB-level PIN brute-force counters to auth_credentials.
--
-- Application code in src/lib/persistence/postgres-store.ts (pgFindCredentialByPin,
-- pgCreateEmployee) has been reading/writing `failed_pin_attempts` and
-- `last_failed_pin_at` since at least round 9, but no migration existed to
-- create those columns. Every PIN login against an unmigrated DB would
-- 500 on the SELECT. Caught by scripts/test-schema-drift.mjs.
--
-- Semantics matching the code:
--   failed_pin_attempts  — INT, starts at 0. Incremented on wrong PIN.
--                          Reset to 0 on successful PIN verify.
--   last_failed_pin_at   — TIMESTAMPTZ. Set on each failed attempt; used
--                          together with failed_pin_attempts to gate the
--                          5-attempts-per-window check.

BEGIN;

ALTER TABLE auth_credentials
  ADD COLUMN IF NOT EXISTS failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failed_pin_at TIMESTAMPTZ;

-- Non-negative counter (belt-and-braces — the INSERT always writes 0 or
-- ++, but a rogue UPDATE could set negative).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_credentials_failed_pin_attempts_nonneg'
  ) THEN
    ALTER TABLE auth_credentials
      ADD CONSTRAINT auth_credentials_failed_pin_attempts_nonneg
      CHECK (failed_pin_attempts >= 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE auth_credentials
  VALIDATE CONSTRAINT auth_credentials_failed_pin_attempts_nonneg;

COMMIT;
