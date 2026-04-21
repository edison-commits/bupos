-- Round 9 audit fixes (applied to prod via Supabase MCP).
--
-- (1) Make the (product_variant_id, location_id) index on inventory_levels
--     actually UNIQUE. Migration 004 declared it UNIQUE but prod only had a
--     non-unique index with the same name. Consequence: purchase_orders and
--     offline_sync used `ON CONFLICT (product_variant_id, location_id)` but
--     there was no unique constraint to infer, so conflict handling was broken.
-- (2) No schema change needed for purchase_orders.status — the CHECK constraint
--     is correct (draft/submitted/partial/received/cancelled); the app code
--     was wrong (used "ordered"). Fixed in validation/schemas.ts and
--     purchase-orders/route.ts.

DROP INDEX IF EXISTS idx_inventory_levels_variant_location;
CREATE UNIQUE INDEX idx_inventory_levels_variant_location
  ON inventory_levels(product_variant_id, location_id);
