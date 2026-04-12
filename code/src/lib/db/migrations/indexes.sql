-- Performance indexes for bupos
-- Run against production: psql $DATABASE_URL -f indexes.sql
--
-- These target the most frequent WHERE/JOIN/ORDER BY patterns
-- found across 40+ API routes.

-- === HIGH PRIORITY (most queried columns) ===

-- Transactions: most queries filter by org + date range
CREATE INDEX IF NOT EXISTS idx_transactions_org_created
  ON transactions (organization_id, created_at DESC);

-- Transactions: location-based queries (shift reports, dashboards)
CREATE INDEX IF NOT EXISTS idx_transactions_org_location_created
  ON transactions (organization_id, location_id, created_at DESC);

-- Transaction line items: join from transactions
CREATE INDEX IF NOT EXISTS idx_transaction_lines_transaction_id
  ON transaction_line_items (transaction_id);

-- Transaction tenders: join from transactions
CREATE INDEX IF NOT EXISTS idx_transaction_tenders_transaction_id
  ON transaction_tenders (transaction_id);

-- Inventory levels: queried by variant + location (stock lookups, decrement)
CREATE INDEX IF NOT EXISTS idx_inventory_levels_variant_location
  ON inventory_levels (product_variant_id, location_id);

-- Inventory levels: low stock queries
CREATE INDEX IF NOT EXISTS idx_inventory_levels_org_on_hand
  ON inventory_levels (organization_id, on_hand)
  WHERE on_hand <= reorder_point;

-- Product variants: SKU lookups (barcode scanning, import dedup)
CREATE INDEX IF NOT EXISTS idx_product_variants_org_sku
  ON product_variants (organization_id, lower(sku));

-- Product variants: product_id join
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id
  ON product_variants (product_id);

-- Products: org + category listing
CREATE INDEX IF NOT EXISTS idx_products_org_category
  ON products (organization_id, category_id);

-- === MEDIUM PRIORITY ===

-- Customers: org-scoped lookups
CREATE INDEX IF NOT EXISTS idx_customers_org
  ON customers (organization_id);

-- Customers: loyalty points queries
CREATE INDEX IF NOT EXISTS idx_customers_org_loyalty
  ON customers (organization_id, loyalty_points)
  WHERE loyalty_points > 0;

-- Categories: org listing
CREATE INDEX IF NOT EXISTS idx_categories_org
  ON categories (organization_id);

-- Employees: org + active status
CREATE INDEX IF NOT EXISTS idx_employees_org_active
  ON employees (organization_id, is_active);

-- Register sessions: open shifts
CREATE INDEX IF NOT EXISTS idx_register_sessions_org_open
  ON register_sessions (organization_id, closed_at)
  WHERE closed_at IS NULL;

-- Shift close records: org + date
CREATE INDEX IF NOT EXISTS idx_shift_closes_org_created
  ON shift_close_records (organization_id, created_at DESC);

-- Expense records: org + date range
CREATE INDEX IF NOT EXISTS idx_expenses_org_created
  ON expense_records (organization_id, created_at DESC);

-- Offline sync events: idempotency
CREATE INDEX IF NOT EXISTS idx_sync_events_idempotency
  ON offline_sync_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Purchase orders: org + status
CREATE INDEX IF NOT EXISTS idx_purchase_orders_org_status
  ON purchase_orders (organization_id, status);

-- Returns: org + status
CREATE INDEX IF NOT EXISTS idx_returns_org_status
  ON returns (organization_id, status);

-- Transfers: org + status
CREATE INDEX IF NOT EXISTS idx_transfers_org_status
  ON transfers (organization_id, status);

-- Audit log: org + date
CREATE INDEX IF NOT EXISTS idx_audit_log_org_created
  ON audit_log (organization_id, created_at DESC);

-- Time clock entries: org + employee + date
CREATE INDEX IF NOT EXISTS idx_time_clock_org_employee
  ON time_clock_entries (organization_id, employee_id, clock_in DESC);

-- Gift cards: org + status
CREATE INDEX IF NOT EXISTS idx_gift_cards_org_status
  ON gift_cards (organization_id, status);

-- Store credit: org + customer
CREATE INDEX IF NOT EXISTS idx_store_credit_org_customer
  ON store_credit_ledger (organization_id, customer_id);
