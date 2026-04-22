-- R40-1: password-reuse protection.
--
-- R39-A2-8 flagged that `/api/auth/password-change` only rejects an
-- identical new == current password. An owner can rotate
-- `Passw0rd!2024` → `Passw0rd!2023` → `Passw0rd!2024` to sidestep
-- breach-list-driven mandatory rotations.
--
-- Fix: append the OLD hash to a per-credential history whenever the
-- password is rotated. On the next rotation, verify the NEW password
-- against every entry in the history and reject if ANY matches.
--
-- The history is a bounded `jsonb` array of hash strings; we cap it
-- at the last 10 hashes. Password hashes are ~100 bytes each so a
-- 10-entry cap is ~1KB per row — negligible.
--
-- `verifySecret` on 10 entries is CPU-expensive (PBKDF2 × 10 ≈ 300ms)
-- but acceptable for a rare action (rotate ≪ once per week per user).

BEGIN;

ALTER TABLE auth_credentials
  ADD COLUMN IF NOT EXISTS prior_password_hashes jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN auth_credentials.prior_password_hashes IS
  'R40-1: last up-to-10 password hashes, most-recent first. Checked on password-change / password-reset so a rotation cannot re-use a recent password. Capped in app code (src/app/api/auth/password-change/route.ts).';

COMMIT;
