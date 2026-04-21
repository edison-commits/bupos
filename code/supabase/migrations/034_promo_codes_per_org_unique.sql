-- Scope promo-code uniqueness to the organization. The previous
-- `UNIQUE (lower(code))` was GLOBAL, so if two orgs independently tried
-- to use "SAVE10" the second org's INSERT would fail with a confusing
-- 500. The route.ts pre-check uses orgQuery (RLS-scoped) and says "not
-- found", so the user sees "already exists" from the DB but the UI
-- thought it was available. Per-org uniqueness matches the multi-tenant
-- model used everywhere else in this schema.
--
-- Idempotent: tolerates re-running after a partial rollout.

DROP INDEX IF EXISTS idx_promo_codes_code_lower_unique;
DROP INDEX IF EXISTS idx_promo_codes_code; -- non-unique lookup index; replaced below

CREATE UNIQUE INDEX idx_promo_codes_org_code_lower_unique
  ON promo_codes (organization_id, lower(code));

-- Keep a non-unique plain-text lookup index for admin search UIs that
-- filter on `code` without lowercasing.
CREATE INDEX IF NOT EXISTS idx_promo_codes_code
  ON promo_codes (code);
