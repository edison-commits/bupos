-- R21-C-1 + R21-H-4 closed: the uniqueness constraints the schema always
-- meant to have but never did. Two separate regressions landed on the
-- same audit round so they ship in one migration.
--
-- ── R21-C-1: auth_credentials.email + pending_signups.email ──────────
-- The new email-verified signup flow (migration 049) assumed uniqueness
-- on `auth_credentials.email` and on the in-flight `pending_signups.email`,
-- but neither was enforced at the DB level. Two concurrent signupAction
-- calls for the same email both landed pending_signups rows; both
-- verification links created separate `organizations + auth_credentials`
-- pairs with the same login email. `admin_login_lookup` later returned
-- an arbitrary row via `LIMIT 1`, so the victim could be silently
-- signed into either org.
--
-- Fix: case-insensitive unique indexes on both tables. The pre-existing
-- `idx_auth_credentials_email` (migration 001 line 366) and
-- `idx_pending_signups_email` (migration 049 line 36) were plain (non-
-- unique) indexes — we drop and replace.
--
-- ── R21-H-4: product_variants (org, sku) + (org, barcode) ─────────────
-- The `/api/barcode-lookup` POST handler (shipped in R11-L-1) catches
-- 23505 `unique_violation` on insert and translates to a 409 for the
-- client. But `product_variants.sku` had only a plain `idx_product_
-- variants_sku` (migration 001 line 155) — no unique constraint — so
-- duplicate scans silently created duplicate variants with split
-- inventory. The 23505 branch was unreachable under normal inputs.
--
-- Fix: unique index per-org on sku (always) and on barcode (when non-
-- NULL). Scoped to `is_active = true` so soft-deleted variants don't
-- block reactivation of the same SKU post-cleanup.

BEGIN;

-- ── auth_credentials.email ────────────────────────────────────────────
DO $$
DECLARE
  v_dup_count bigint;
BEGIN
  SELECT count(*) INTO v_dup_count
    FROM (
      SELECT lower(email) AS e, count(*) AS n
        FROM auth_credentials
       WHERE email IS NOT NULL
       GROUP BY lower(email)
      HAVING count(*) > 1
    ) d;
  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add unique index on auth_credentials(lower(email)): % duplicate email(s) present. Reconcile manually before re-running this migration.',
      v_dup_count;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_auth_credentials_email;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_auth_credentials_email_lower
  ON auth_credentials(lower(email)) WHERE email IS NOT NULL;

-- ── pending_signups.email ─────────────────────────────────────────────
-- No dedup check: pending_signups is fully ephemeral (expires in 24h)
-- and migration 049 just created it. But cleanup any stale rows with
-- the same email just in case they leaked in during R20→R21 window.
--
-- R22-L-2: compare the composite (created_at, id) pair so tied
-- timestamps at ms resolution still pick a deterministic "keep" row.
-- Prior `a.created_at < b.created_at` left both rows when timestamps
-- tied under signup bursts, and the subsequent CREATE UNIQUE INDEX
-- failed with 23505.
DELETE FROM pending_signups a USING pending_signups b
  WHERE lower(a.email) = lower(b.email)
    AND a.id <> b.id
    AND (a.created_at, a.id) < (b.created_at, b.id);

DROP INDEX IF EXISTS idx_pending_signups_email;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_signups_email_lower
  ON pending_signups(lower(email));

-- ── product_variants (org, sku) ───────────────────────────────────────
DO $$
DECLARE
  v_dup_count bigint;
BEGIN
  SELECT count(*) INTO v_dup_count
    FROM (
      SELECT organization_id, sku, count(*) AS n
        FROM product_variants
       WHERE is_active = true
       GROUP BY organization_id, sku
      HAVING count(*) > 1
    ) d;
  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add unique index on product_variants(organization_id, sku): % duplicate active SKU(s) present. Merge or deactivate duplicates before re-running.',
      v_dup_count;
  END IF;
END $$;

-- Keep the non-unique lookup index (some code paths query sku without
-- knowing the org yet and rely on the plain index being present); add
-- the new unique partial index alongside.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_variants_org_sku_active
  ON product_variants(organization_id, sku) WHERE is_active;

-- ── product_variants (org, barcode) ───────────────────────────────────
DO $$
DECLARE
  v_dup_count bigint;
BEGIN
  SELECT count(*) INTO v_dup_count
    FROM (
      SELECT organization_id, barcode, count(*) AS n
        FROM product_variants
       WHERE is_active = true AND barcode IS NOT NULL AND barcode <> ''
       GROUP BY organization_id, barcode
      HAVING count(*) > 1
    ) d;
  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add unique index on product_variants(organization_id, barcode): % duplicate active barcode(s) present. Merge or deactivate duplicates before re-running.',
      v_dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_variants_org_barcode_active
  ON product_variants(organization_id, barcode)
  WHERE is_active AND barcode IS NOT NULL AND barcode <> '';

COMMIT;
