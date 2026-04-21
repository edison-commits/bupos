-- R31 schema hardening batch:
--   C3: returns.organization_id had NO foreign key — attach one.
--   C4: returns.return_number was GLOBALLY unique — narrow to per-org
--       (attacker could previously enumerate whether another tenant
--       had issued a given return_number via 23505 error).
--   C5: audit_events was UPDATE/DELETE-able by any authenticated admin
--       with DB access — add tamper-resistance trigger so the audit
--       trail is append-only at the DB level.
--   Schema-M10 (add-on): promo_redemptions was missing the
--       (promo_code_id, transaction_id) unique index. The R30 + R29
--       code assumed this existed (checkout-action.ts catches 23505
--       for duplicate-redemption replay), but the migration was never
--       written — a race could land two redemption rows for the same
--       (promo, transaction).
--   Schema-M3 (add-on): products.slug had no uniqueness at all;
--       categories.slug likewise. Add per-org unique partial indexes.
--
-- All changes are non-destructive; new constraints apply to new rows.
-- If existing data violates (shouldn't in normal use), the migration
-- reports the offending rows via the verification DO block at the end.

BEGIN;

-- ─── C3: returns.organization_id FK ─────────────────────────────────
-- Every other org-scoped table has a proper FK to organizations; this
-- column slipped through in migration 002.
ALTER TABLE returns
  DROP CONSTRAINT IF EXISTS returns_organization_id_fkey;

ALTER TABLE returns
  ADD CONSTRAINT returns_organization_id_fkey
  FOREIGN KEY (organization_id)
  REFERENCES organizations(id)
  ON DELETE CASCADE;

-- ─── C4: return_number globally unique → per-org unique ─────────────
-- Drop the global constraint and add a per-org partial unique index.
-- The existing indexes on (organization_id) stay untouched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'returns'::regclass AND conname = 'returns_return_number_key'
  ) THEN
    ALTER TABLE returns DROP CONSTRAINT returns_return_number_key;
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_returns_org_return_number
  ON returns (organization_id, return_number);

-- ─── C5: audit_events tamper-resistance ──────────────────────────────
-- Append-only at the DB level: BEFORE UPDATE OR DELETE raise exception.
-- This defends against an insider with RLS-privileged DB access
-- (manager / owner session with a SECDEF bypass) from scrubbing their
-- own actions. Only a role with explicit RESET of this trigger can
-- mutate the table, which in BuPOS means "manual DBA via psql" —
-- impossible for any web request path.
CREATE OR REPLACE FUNCTION audit_events_prevent_tamper()
RETURNS TRIGGER
LANGUAGE plpgsql
-- R34-D12: `SET search_path = public` matches the R21-H-3 SECDEF
-- hygiene pattern (also reinforced via ALTER in migration 064).
-- This function isn't SECURITY DEFINER, so the exposure is lower —
-- but adhering to the convention prevents a future author from
-- copy-pasting this shape without search_path elsewhere.
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (no %, use a new row)',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_events_no_update ON audit_events;
CREATE TRIGGER trg_audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_prevent_tamper();

DROP TRIGGER IF EXISTS trg_audit_events_no_delete ON audit_events;
CREATE TRIGGER trg_audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_prevent_tamper();

-- R33-M-audit-truncate: row-level triggers don't fire on TRUNCATE.
-- Add a STATEMENT-level trigger so a DBA can't silently wipe the
-- table via `TRUNCATE audit_events`. Legitimate corrections (GDPR
-- erasure, timezone fixes) require the DBA to explicitly
-- `ALTER TABLE audit_events DISABLE TRIGGER USER` — an auditable
-- DDL operation — rather than a cheap DML.
DROP TRIGGER IF EXISTS trg_audit_events_no_truncate ON audit_events;
CREATE TRIGGER trg_audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_prevent_tamper();

-- ─── Pre-index verification ─────────────────────────────────────────
-- R32-H12: moved BEFORE `CREATE UNIQUE INDEX` calls. Prior shape ran
-- verification AFTER index creation, so when a tenant had a
-- legitimate duplicate slug / return_number, the CREATE UNIQUE INDEX
-- strict-failed first and the verification's `RAISE WARNING` branch
-- never ran — the entire migration rolled back with a cryptic
-- unique-violation error and no actionable ops signal. Running
-- verification first gives ops a clear remediation warning AND lets
-- the operator choose to fix duplicates offline before re-running.
DO $$
DECLARE
  v_orphan_returns int;
  v_dup_products int;
  v_dup_categories int;
  v_dup_return_numbers int;
BEGIN
  SELECT COUNT(*) INTO v_orphan_returns FROM returns r
    WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = r.organization_id);
  IF v_orphan_returns > 0 THEN
    RAISE WARNING 'R31-C3 verify: % returns rows reference non-existent organizations (FK added anyway)', v_orphan_returns;
  END IF;

  SELECT COUNT(*) INTO v_dup_products FROM (
    SELECT organization_id, slug, COUNT(*) c
      FROM products WHERE slug IS NOT NULL
      GROUP BY organization_id, slug HAVING COUNT(*) > 1
  ) dup;
  IF v_dup_products > 0 THEN
    RAISE EXCEPTION 'Schema-M3: % (org, product-slug) duplicates exist. Resolve offline, then re-run migration.', v_dup_products;
  END IF;

  SELECT COUNT(*) INTO v_dup_categories FROM (
    SELECT organization_id, slug, COUNT(*) c
      FROM categories WHERE slug IS NOT NULL
      GROUP BY organization_id, slug HAVING COUNT(*) > 1
  ) dup;
  IF v_dup_categories > 0 THEN
    RAISE EXCEPTION 'Schema-M3: % (org, category-slug) duplicates exist. Resolve offline, then re-run migration.', v_dup_categories;
  END IF;

  SELECT COUNT(*) INTO v_dup_return_numbers FROM (
    SELECT organization_id, return_number, COUNT(*) c
      FROM returns GROUP BY organization_id, return_number HAVING COUNT(*) > 1
  ) dup;
  IF v_dup_return_numbers > 0 THEN
    RAISE EXCEPTION 'R31-C4: % (org, return_number) duplicates exist. Resolve offline, then re-run migration.', v_dup_return_numbers;
  END IF;
END$$;

-- ─── Schema-M10: promo_redemptions unique per (promo_code_id, transaction_id) ─
-- The application code assumes this exists (the 23505 catch in
-- checkout-action.ts). Making the assumption explicit here closes the
-- race window where two concurrent checkouts could both insert a
-- redemption row.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_promo_redemptions_promo_txn
  ON promo_redemptions (promo_code_id, transaction_id);

-- ─── Schema-M3: slug per-org uniqueness ─────────────────────────────
-- products.slug and categories.slug were entirely unique-less. A
-- duplicate slug within one org silently splits admin-UI routing
-- (/p/:slug matches any row). Enforce uniqueness within each org.
-- Partial unique indexes tolerate NULL (if a row's slug were ever
-- NULL) and permit cross-org slug reuse.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_products_org_slug
  ON products (organization_id, slug)
  WHERE slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_categories_org_slug
  ON categories (organization_id, slug)
  WHERE slug IS NOT NULL;

COMMIT;
