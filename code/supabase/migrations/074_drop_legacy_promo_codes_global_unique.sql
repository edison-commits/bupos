-- Migration 074: SCH-H1 — drop legacy global UNIQUE on promo_codes.code
--
-- Original mig 001 declared `code TEXT NOT NULL UNIQUE` on promo_codes,
-- which auto-generated the constraint `promo_codes_code_key` on the bare
-- column. Mig 034 introduced the correct per-org partial index
-- `idx_promo_codes_org_code_lower_unique ON promo_codes(organization_id, lower(code))`
-- but only dropped two index names that did NOT match the auto-generated
-- constraint. The legacy global unique survived: tenant A creating "SAVE10"
-- silently DoSes tenant B from using the same code, leaking cross-tenant
-- code existence. Mirrors the gift_cards.code cleanup landed in mig 035 —
-- but for promo_codes the equivalent step never happened.
--
-- This migration is idempotent and tolerant of any constraint name shape
-- (auto-generated names can drift between Postgres versions / schema
-- restores). Discovers the constraint via pg_constraint, drops it if it
-- references only `code` and is unique, otherwise no-ops.

DO $$
DECLARE
  v_conname text;
BEGIN
  -- Find any UNIQUE/PRIMARY constraint on promo_codes that's keyed on
  -- exactly the `code` column (single-column unique). The R34 per-org
  -- constraint is on (organization_id, lower(code)) — that's an INDEX
  -- not a constraint, so it won't match this query.
  SELECT c.conname INTO v_conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE t.relname = 'promo_codes'
    AND n.nspname = 'public'
    AND c.contype = 'u'
    AND c.conkey = ARRAY[
      (SELECT attnum FROM pg_attribute
       WHERE attrelid = t.oid AND attname = 'code')
    ]
  LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE promo_codes DROP CONSTRAINT %I', v_conname);
    RAISE NOTICE 'SCH-H1: dropped legacy promo_codes unique constraint %', v_conname;
  ELSE
    RAISE NOTICE 'SCH-H1: no legacy single-column UNIQUE on promo_codes.code (already clean)';
  END IF;
END $$;

-- Verification: per-org partial index from mig 034 must still exist;
-- the audit-trigger health probe extension in mig 075 will catch DBA
-- drift on this constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'promo_codes'
      AND indexname = 'idx_promo_codes_org_code_lower_unique'
  ) THEN
    RAISE EXCEPTION 'SCH-H1: per-org unique index missing — would have left codes globally unconstrained';
  END IF;
END $$;
