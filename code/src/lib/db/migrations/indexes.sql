-- Performance indexes for bupos
-- Only adds COMPOSITE indexes not already covered by existing single-column indexes.
-- Existing indexes already cover most single-column lookups.

-- Transactions: org + date range (reports, dashboards, shift reports)
-- Existing: idx_transactions_organization_id, idx_transactions_created_at (separate)
-- This composite replaces both for the most common pattern
CREATE INDEX IF NOT EXISTS idx_transactions_org_created
  ON transactions (organization_id, created_at DESC);

-- Transactions: org + location + date (location-scoped reports)
CREATE INDEX IF NOT EXISTS idx_transactions_org_location_created
  ON transactions (organization_id, location_id, created_at DESC);

-- Inventory: variant + location (stock lookups, decrement) — covers both cols in one index
CREATE INDEX IF NOT EXISTS idx_inventory_levels_variant_location
  ON inventory_levels (product_variant_id, location_id);

-- Product variants: case-insensitive SKU lookup for import dedup
CREATE INDEX IF NOT EXISTS idx_product_variants_org_sku_lower
  ON product_variants (organization_id, lower(sku));

-- Shifts: status filter (no org_id on this table)
CREATE INDEX IF NOT EXISTS idx_shifts_status
  ON shifts (status);

-- Expenses: org + date range composite
CREATE INDEX IF NOT EXISTS idx_expenses_org_date
  ON expenses (organization_id, expense_date DESC);

