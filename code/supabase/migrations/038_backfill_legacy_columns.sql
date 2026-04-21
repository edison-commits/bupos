-- Backfill columns that production has but no migration file declares.
-- Caught by scripts/check-schema-drift-ci.mjs when we wired the drift
-- gate. Each ADD COLUMN IF NOT EXISTS is idempotent on environments
-- where production DDL has already added them; creates the column on
-- fresh schemas spun up from migration files alone.

BEGIN;

-- pay_in_outs.organization_id — every cash-drawer event references this
-- column (see src/app/api/cash-drawer/route.ts). Needed for RLS
-- WITH CHECK + the reporting joins.
ALTER TABLE pay_in_outs
  ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE pay_in_outs p
SET organization_id = l.organization_id
FROM locations l
WHERE p.organization_id IS NULL AND l.id = p.location_id;

ALTER TABLE pay_in_outs
  ALTER COLUMN organization_id SET NOT NULL;

-- R14-M-5: constraint-add guarded so re-running against a schema that
-- already has the FK doesn't fail. DR restores and bootstrap-from-partial-
-- dump paths otherwise halt here, blocking every later migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pay_in_outs_organization_id_fkey'
      AND conrelid = 'public.pay_in_outs'::regclass
  ) THEN
    ALTER TABLE pay_in_outs
      ADD CONSTRAINT pay_in_outs_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      NOT VALID;
    ALTER TABLE pay_in_outs VALIDATE CONSTRAINT pay_in_outs_organization_id_fkey;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pay_in_outs_org_shift ON pay_in_outs(organization_id, shift_id);

-- customers.address — used by /api/customers POST/PUT and the R5 H-4
-- explicit RETURNING column list. Was added to production at some point
-- but the migration file was lost.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS address TEXT;

-- Sibling columns the live schema has but migration files don't declare.
-- last_visit_at is read by /api/loyalty reports. Safe to add as a
-- nullable column on fresh schemas.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS last_visit_at TIMESTAMPTZ;

COMMIT;
