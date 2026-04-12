-- Add pin_hash_prefix column for fast pre-filtering during PIN login.
-- Stores a deterministic SHA-256 prefix of the raw PIN so we can narrow
-- candidates before running expensive PBKDF2 verification.
-- Existing rows are backfilled lazily on next successful PIN login.
ALTER TABLE auth_credentials ADD COLUMN IF NOT EXISTS pin_hash_prefix TEXT;

-- Index for fast prefix lookup
CREATE INDEX IF NOT EXISTS idx_auth_credentials_pin_prefix
  ON auth_credentials(pin_hash_prefix)
  WHERE pin_hash_prefix IS NOT NULL;
