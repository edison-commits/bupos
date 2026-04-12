-- Composite indexes for frequent query patterns
CREATE INDEX IF NOT EXISTS idx_transactions_location_status_created
  ON transactions(location_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_levels_low_stock
  ON inventory_levels(location_id, on_hand)
  WHERE on_hand <= reorder_point AND reorder_point > 0;

CREATE INDEX IF NOT EXISTS idx_customers_org_name
  ON customers(organization_id, last_name, first_name);
