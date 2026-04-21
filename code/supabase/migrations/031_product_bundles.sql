-- Product bundles — a set of product variants sold together at a package price.
--
-- Design notes:
--  * Bundle price is ALWAYS taken from the bundle row itself; we do NOT trust
--    client-supplied prices or recompute from item prices at checkout. That
--    keeps bundle discounting auditable.
--  * Items store (variant_id, quantity) pairs. Each bundle item is a single
--    row; duplicate variant_ids in the same bundle are allowed (the UI
--    collapses them but the DB doesn't enforce uniqueness — keeps "2x Item A
--    + 1x Item A promoted to 3" scenarios simple to model).
--  * organization_id is denormalized onto bundle_items so RLS can filter
--    without an extra JOIN on every read. The trigger below keeps it in sync
--    with the parent bundle on INSERT/UPDATE.
--  * Deleting a bundle cascades to its items. Deactivating (is_active=false)
--    is the soft-delete path for bundles that have been sold — bundle_items
--    must remain to reconstruct historical sales.
--
-- Idempotent: IF NOT EXISTS everywhere so re-running the migration in dev
-- doesn't blow up.

CREATE TABLE IF NOT EXISTS product_bundles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  bundle_price NUMERIC(12, 2) NOT NULL CHECK (bundle_price >= 0),
  compare_at_price NUMERIC(12, 2) CHECK (compare_at_price IS NULL OR compare_at_price >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_product_bundles_organization_id ON product_bundles(organization_id);
CREATE INDEX IF NOT EXISTS idx_product_bundles_is_active ON product_bundles(organization_id, is_active);

CREATE TABLE IF NOT EXISTS bundle_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id UUID NOT NULL REFERENCES product_bundles(id) ON DELETE CASCADE,
  -- RESTRICT so deleting a variant used in an active bundle fails loudly
  -- rather than silently breaking the bundle's composition.
  product_variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 1000),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle_id ON bundle_items(bundle_id);
CREATE INDEX IF NOT EXISTS idx_bundle_items_variant_id ON bundle_items(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_bundle_items_organization_id ON bundle_items(organization_id);

-- ─── Updated-at trigger for product_bundles ───────────────────────────
CREATE OR REPLACE FUNCTION update_product_bundles_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_product_bundles_updated_at ON product_bundles;
CREATE TRIGGER trg_product_bundles_updated_at
  BEFORE UPDATE ON product_bundles
  FOR EACH ROW EXECUTE FUNCTION update_product_bundles_timestamp();

-- ─── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE product_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_bundles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON product_bundles;
CREATE POLICY org_isolation ON product_bundles
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE bundle_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE bundle_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON bundle_items;
CREATE POLICY org_isolation ON bundle_items
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
