-- R32-D6: add `organization_id` to `inventory_adjustments`.
--
-- Prior shape had no org column; tenancy was derived via the
-- location_id JOIN in RLS (migration 009). That was fragile for two
-- reasons:
--   1. A row with a cross-tenant location_id (bug in any future
--      writer) lands in the wrong tenant's reports without any
--      explicit check failing.
--   2. Every analytical query that aggregates adjustments has to JOIN
--      through locations just to filter by org — unnecessary cost.
-- Backfill derives org from the row's location at migration time;
-- going forward, every INSERT carries the caller's verified orgId.

BEGIN;

ALTER TABLE inventory_adjustments
  ADD COLUMN IF NOT EXISTS organization_id uuid;

-- Backfill from locations. Any row whose location_id is missing from
-- the locations table (shouldn't happen; FK is present) gets NULL.
UPDATE inventory_adjustments ia
  SET organization_id = l.organization_id
  FROM locations l
  WHERE ia.location_id = l.id
    AND ia.organization_id IS NULL;

-- Make NOT NULL + FK after backfill. If any rows still have NULL
-- organization_id, leave the NOT NULL off to avoid failing the
-- migration on production data drift; `verification` block below
-- warns loudly.
DO $$
DECLARE
  v_nulls int;
BEGIN
  SELECT COUNT(*) INTO v_nulls FROM inventory_adjustments WHERE organization_id IS NULL;
  IF v_nulls = 0 THEN
    ALTER TABLE inventory_adjustments ALTER COLUMN organization_id SET NOT NULL;
  ELSE
    RAISE WARNING 'R32-D6: % inventory_adjustments rows have NULL organization_id; leaving column nullable. Backfill offline and re-run ALTER SET NOT NULL.', v_nulls;
  END IF;
END$$;

ALTER TABLE inventory_adjustments
  DROP CONSTRAINT IF EXISTS inventory_adjustments_organization_id_fkey;
ALTER TABLE inventory_adjustments
  ADD CONSTRAINT inventory_adjustments_organization_id_fkey
  FOREIGN KEY (organization_id)
  REFERENCES organizations(id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_organization_id
  ON inventory_adjustments(organization_id);

COMMIT;
