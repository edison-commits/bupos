-- Prevent duplicate inventory level rows for the same variant+location
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_levels_variant_location
  ON inventory_levels(product_variant_id, location_id)
  WHERE product_variant_id IS NOT NULL;
