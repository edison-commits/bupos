-- Migration 087: drop the dead, landmine `pin_hash_prefix` column.
--
-- SEC-AUDIT10. `auth_credentials.pin_hash_prefix` (added by migration 017,
-- re-added to prod by the drift-repair migration 084) was a fast-filter that
-- NO code path ever wrote — every row is NULL and the lookup filter was a
-- no-op. It was also a latent security landmine: the intended value was an
-- UNSALTED SHA-256 prefix of the raw 4-digit PIN, which is trivially
-- reversible (10k-entry rainbow table). Had anyone acted on the old "backfill
-- on next rotation" comment, a read-only DB leak would have yielded every PIN
-- without touching the PBKDF2 hash at all. The reading code is removed
-- (postgres-store.ts), so drop the column + its index to eliminate the
-- landmine. Idempotent.

DROP INDEX IF EXISTS idx_auth_credentials_pin_prefix;
ALTER TABLE auth_credentials DROP COLUMN IF EXISTS pin_hash_prefix;
