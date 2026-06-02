-- Migration 080: add the missing products.supplier_id column.
--
-- GET /api/products SELECTs `p.supplier_id` and LEFT JOINs `suppliers`
-- (to surface each product's supplier_name); the purchase-orders /
-- reorder-suggestions / receiving routes + the /admin/products `Product`
-- type (supplier_id: string | null) reference it too. But NO migration
-- ever added the column to `products`, so every `GET /api/products`
-- raised `column p.supplier_id does not exist` (SQLSTATE 42703) → the
-- /admin/products catalog page failed to load (500). The bug went
-- unnoticed because no e2e exercised /admin/products until now.
--
-- Add it as a NULLABLE FK to suppliers(id). Nullable: the products UI
-- reads supplier info but never writes it (supplier assignment happens via
-- the receiving / purchase-order flows), so most products have none.
-- ON DELETE SET NULL: deleting a supplier must not block/cascade product
-- rows. Idempotent (IF NOT EXISTS) per the repo's deploy-loop convention.

ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_supplier_id_fkey'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_supplier_id_fkey
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Supports the LEFT JOIN suppliers ON p.supplier_id = s.id lookup.
CREATE INDEX IF NOT EXISTS idx_products_supplier_id
  ON products(supplier_id) WHERE supplier_id IS NOT NULL;
