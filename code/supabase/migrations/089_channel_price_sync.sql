-- Migration 089: Online Selling Phase 2 — price sync columns.
--
-- BuPOS (POS-authoritative) pushes variant prices to Shopify alongside
-- inventory. Adds a per-integration toggle and the per-variant push state +
-- the Shopify product GID (productVariantsBulkUpdate requires the product id,
-- so the SKU map must carry it). Idempotent.

BEGIN;

ALTER TABLE channel_integrations
  ADD COLUMN IF NOT EXISTS sync_prices boolean NOT NULL DEFAULT true;

ALTER TABLE channel_product_map
  ADD COLUMN IF NOT EXISTS external_product_id text,
  ADD COLUMN IF NOT EXISTS last_pushed_price numeric(12, 2),
  ADD COLUMN IF NOT EXISTS last_pushed_compare_at numeric(12, 2);

COMMIT;
