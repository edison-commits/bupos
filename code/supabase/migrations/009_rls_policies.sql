-- Migration: Enable Row Level Security on all org-scoped tables
-- Policies enforce that queries only return rows matching app.current_org_id,
-- which is set by orgTx() / orgQuery() in src/lib/db/index.ts.

-- Helper: current_setting returns TEXT; cast to UUID for comparison.
-- If the setting is empty or missing the comparison safely fails (no rows returned).

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- organizations
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organizations
  USING (id = current_setting('app.current_org_id', true)::uuid);

-- locations
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON locations
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- employees
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employees
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- categories
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON categories
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- modifier_groups
ALTER TABLE modifier_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON modifier_groups
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- modifiers
ALTER TABLE modifiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON modifiers
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- products
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON products
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- product_variants
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON product_variants
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- inventory_levels
ALTER TABLE inventory_levels ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON inventory_levels
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- customers
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON customers
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- transactions
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON transactions
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- audit_events
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_events
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- gift_cards
ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON gift_cards
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- store_credit_ledger
ALTER TABLE store_credit_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON store_credit_ledger
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- behavior_flags
ALTER TABLE behavior_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON behavior_flags
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- layaways
ALTER TABLE layaways ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON layaways
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- stocktakes
ALTER TABLE stocktakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON stocktakes
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- transfers
ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON transfers
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- time_clock_entries
ALTER TABLE time_clock_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON time_clock_entries
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- promo_codes
ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON promo_codes
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- returns
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON returns
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- ============================================================================
-- CHILD TABLES (no organization_id — secured via FK joins)
-- These still need RLS enabled to prevent direct access bypassing the parent.
-- Policies use EXISTS subqueries against the already-secured parent table.
-- ============================================================================

-- transaction_tenders (child of transactions)
ALTER TABLE transaction_tenders ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON transaction_tenders
  USING (EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.id = transaction_tenders.transaction_id
      AND t.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- transaction_events (child of transactions)
ALTER TABLE transaction_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON transaction_events
  USING (EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.id = transaction_events.transaction_id
      AND t.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- transaction_exceptions (child of transactions)
ALTER TABLE transaction_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON transaction_exceptions
  USING (EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.id = transaction_exceptions.transaction_id
      AND t.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- pay_in_outs (child of shifts, has location_id)
ALTER TABLE pay_in_outs ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON pay_in_outs
  USING (EXISTS (
    SELECT 1 FROM locations l
    WHERE l.id = pay_in_outs.location_id
      AND l.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- auth_credentials (child of employees)
ALTER TABLE auth_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON auth_credentials
  USING (EXISTS (
    SELECT 1 FROM employees e
    WHERE e.id = auth_credentials.employee_id
      AND e.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- sessions (auth sessions — child of employees)
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON sessions
  USING (EXISTS (
    SELECT 1 FROM employees e
    WHERE e.id = sessions.employee_id
      AND e.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- register_sessions (child of employees + locations)
ALTER TABLE register_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON register_sessions
  USING (EXISTS (
    SELECT 1 FROM employees e
    WHERE e.id = register_sessions.employee_id
      AND e.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- shifts (child of locations)
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON shifts
  USING (EXISTS (
    SELECT 1 FROM locations l
    WHERE l.id = shifts.location_id
      AND l.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- inventory_adjustments (child of inventory_levels)
ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON inventory_adjustments
  USING (EXISTS (
    SELECT 1 FROM locations l
    WHERE l.id = inventory_adjustments.location_id
      AND l.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- gift_card_transactions (child of gift_cards)
ALTER TABLE gift_card_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON gift_card_transactions
  USING (EXISTS (
    SELECT 1 FROM gift_cards gc
    WHERE gc.id = gift_card_transactions.gift_card_id
      AND gc.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- layaway_payments (child of layaways)
ALTER TABLE layaway_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON layaway_payments
  USING (EXISTS (
    SELECT 1 FROM layaways l
    WHERE l.id = layaway_payments.layaway_id
      AND l.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- stocktake_lines (child of stocktakes)
ALTER TABLE stocktake_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON stocktake_lines
  USING (EXISTS (
    SELECT 1 FROM stocktakes st
    WHERE st.id = stocktake_lines.stocktake_id
      AND st.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- transfer_lines (child of transfers)
ALTER TABLE transfer_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON transfer_lines
  USING (EXISTS (
    SELECT 1 FROM transfers tr
    WHERE tr.id = transfer_lines.transfer_id
      AND tr.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- promo_redemptions (child of promo_codes)
ALTER TABLE promo_redemptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON promo_redemptions
  USING (EXISTS (
    SELECT 1 FROM promo_codes pc
    WHERE pc.id = promo_redemptions.promo_code_id
      AND pc.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- product_modifier_groups (junction table)
ALTER TABLE product_modifier_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON product_modifier_groups
  USING (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = product_modifier_groups.product_id
      AND p.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- register_session_exceptions (child of register_sessions)
ALTER TABLE register_session_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON register_session_exceptions
  USING (EXISTS (
    SELECT 1 FROM register_sessions rs
    JOIN employees e ON e.id = rs.employee_id
    WHERE rs.id = register_session_exceptions.register_session_id
      AND e.organization_id = current_setting('app.current_org_id', true)::uuid
  ));

-- return_lines (child of returns)
ALTER TABLE return_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_org_isolation ON return_lines
  USING (EXISTS (
    SELECT 1 FROM returns r
    WHERE r.id = return_lines.return_id
      AND r.organization_id = current_setting('app.current_org_id', true)::uuid
  ));
