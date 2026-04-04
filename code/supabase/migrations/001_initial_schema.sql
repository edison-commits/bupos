-- BasicUniformPOS Initial Schema Migration
-- Comprehensive Supabase migration for all phases of the POS system

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Organizations - multi-tenant root entity
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  legal_name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

-- Locations - per-store records
CREATE TABLE IF NOT EXISTS locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  address1 TEXT NOT NULL,
  city TEXT NOT NULL,
  region TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locations_organization_id ON locations(organization_id);
CREATE INDEX IF NOT EXISTS idx_locations_code ON locations(code);

-- Employees
CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL CHECK (role_key IN ('owner', 'manager', 'cashier', 'inventory_clerk', 'support')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  pin_hint TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true NOT NULL,
  location_ids UUID[] DEFAULT '{}' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_employees_organization_id ON employees(organization_id);
CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email);
CREATE INDEX IF NOT EXISTS idx_employees_is_active ON employees(is_active);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL,
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_organization_id ON categories(organization_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent_category_id ON categories(parent_category_id);
CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);

-- Modifier Groups
CREATE TABLE IF NOT EXISTS modifier_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  selection_mode TEXT NOT NULL CHECK (selection_mode IN ('single', 'multiple')),
  min_selections INTEGER NOT NULL,
  max_selections INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_modifier_groups_organization_id ON modifier_groups(organization_id);

-- Modifiers
CREATE TABLE IF NOT EXISTS modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_delta NUMERIC(12, 2) NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_modifiers_organization_id ON modifiers(organization_id);
CREATE INDEX IF NOT EXISTS idx_modifiers_modifier_group_id ON modifiers(modifier_group_id);

-- Product ↔ Modifier Groups junction (required by pgCreateProduct / pgUpdateProduct)
CREATE TABLE IF NOT EXISTS product_modifier_groups (
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, modifier_group_id)
);

CREATE INDEX IF NOT EXISTS idx_product_modifier_groups_product_id ON product_modifier_groups(product_id);
CREATE INDEX IF NOT EXISTS idx_product_modifier_groups_modifier_group_id ON product_modifier_groups(modifier_group_id);

-- Products
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  is_active BOOLEAN DEFAULT true NOT NULL,
  is_touch_favorite BOOLEAN DEFAULT false NOT NULL,
  default_variant_id UUID,
  modifier_group_ids UUID[] DEFAULT '{}' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_organization_id ON products(organization_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active);

-- Product Variants
CREATE TABLE IF NOT EXISTS product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  barcode TEXT,
  name TEXT NOT NULL,
  size_label TEXT,
  color_label TEXT,
  price NUMERIC(12, 2) NOT NULL,
  compare_at_price NUMERIC(12, 2),
  cost NUMERIC(12, 2),
  is_active BOOLEAN DEFAULT true NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_variants_organization_id ON product_variants(organization_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_sku ON product_variants(sku);
CREATE INDEX IF NOT EXISTS idx_product_variants_barcode ON product_variants(barcode);

-- Inventory Levels
CREATE TABLE IF NOT EXISTS inventory_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  product_variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  on_hand INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_levels_organization_id ON inventory_levels(organization_id);
CREATE INDEX IF NOT EXISTS idx_inventory_levels_location_id ON inventory_levels(location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_levels_product_variant_id ON inventory_levels(product_variant_id);

-- Customers
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  total_spend NUMERIC(12, 2) NOT NULL DEFAULT 0,
  visit_count INTEGER NOT NULL DEFAULT 0,
  store_credit_balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  is_active BOOLEAN DEFAULT true NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_organization_id ON customers(organization_id);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- Register Sessions - user's POS session
CREATE TABLE IF NOT EXISTS register_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_session_id UUID NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  active_shift_id UUID,
  last_cart_id UUID,
  last_transaction_id UUID,
  pending_exception_ids UUID[] DEFAULT '{}' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_register_sessions_employee_id ON register_sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_register_sessions_location_id ON register_sessions(location_id);
CREATE INDEX IF NOT EXISTS idx_register_sessions_status ON register_sessions(status);

-- Shifts
CREATE TABLE IF NOT EXISTS shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  register_session_id UUID NOT NULL REFERENCES register_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at TIMESTAMPTZ NOT NULL,
  opening_float NUMERIC(12, 2) NOT NULL,
  opened_note TEXT,
  closed_at TIMESTAMPTZ,
  closing_expected_cash NUMERIC(12, 2),
  closing_declared_cash NUMERIC(12, 2),
  closing_variance NUMERIC(12, 2),
  closed_note TEXT,
  blind_close BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shifts_location_id ON shifts(location_id);
CREATE INDEX IF NOT EXISTS idx_shifts_employee_id ON shifts(employee_id);
CREATE INDEX IF NOT EXISTS idx_shifts_register_session_id ON shifts(register_session_id);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);

-- Transactions - main POS transaction record
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  register_session_id UUID NOT NULL REFERENCES register_sessions(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  cart_snapshot JSONB NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL,
  discount_total NUMERIC(12, 2) NOT NULL,
  tax_total NUMERIC(12, 2) NOT NULL,
  grand_total NUMERIC(12, 2) NOT NULL,
  tender_type TEXT NOT NULL,
  amount_tendered NUMERIC(12, 2) NOT NULL,
  change_due NUMERIC(12, 2) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'voided', 'pending')),
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_organization_id ON transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_transactions_location_id ON transactions(location_id);
CREATE INDEX IF NOT EXISTS idx_transactions_register_session_id ON transactions(register_session_id);
CREATE INDEX IF NOT EXISTS idx_transactions_employee_id ON transactions(employee_id);
CREATE INDEX IF NOT EXISTS idx_transactions_customer_id ON transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);

-- Transaction Tenders - normalized tender lines
CREATE TABLE IF NOT EXISTS transaction_tenders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tender_type TEXT NOT NULL CHECK (tender_type IN ('cash', 'card', 'store_credit', 'loyalty', 'gift_card', 'split')),
  amount NUMERIC(12, 2) NOT NULL,
  is_refund BOOLEAN DEFAULT false NOT NULL,
  metadata JSONB DEFAULT '{}' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transaction_tenders_transaction_id ON transaction_tenders(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_tenders_tender_type ON transaction_tenders(tender_type);

-- Transaction Events - audit trail for transaction actions
CREATE TABLE IF NOT EXISTS transaction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  actor_employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL,
  notes TEXT,
  payload JSONB DEFAULT '{}' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transaction_events_transaction_id ON transaction_events(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_events_actor_employee_id ON transaction_events(actor_employee_id);
CREATE INDEX IF NOT EXISTS idx_transaction_events_event_kind ON transaction_events(event_kind);

-- Transaction Exceptions - approval-required exceptions
CREATE TABLE IF NOT EXISTS transaction_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  exception_code TEXT NOT NULL,
  requires_manager_approval BOOLEAN NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transaction_exceptions_transaction_id ON transaction_exceptions(transaction_id);

-- Audit Events - comprehensive audit trail
CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  actor_employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  event_kind TEXT NOT NULL,
  payload JSONB DEFAULT '{}' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_organization_id ON audit_events(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_location_id ON audit_events(location_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_employee_id ON audit_events(actor_employee_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_kind ON audit_events(event_kind);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);

-- Pay In / Out Records
CREATE TABLE IF NOT EXISTS pay_in_outs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('pay_in', 'pay_out')),
  amount NUMERIC(12, 2) NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pay_in_outs_shift_id ON pay_in_outs(shift_id);
CREATE INDEX IF NOT EXISTS idx_pay_in_outs_location_id ON pay_in_outs(location_id);
CREATE INDEX IF NOT EXISTS idx_pay_in_outs_employee_id ON pay_in_outs(employee_id);

-- Auth Credentials - employee authentication
CREATE TABLE IF NOT EXISTS auth_credentials (
  employee_id UUID PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  email TEXT,
  password_hash TEXT,
  pin_hash TEXT,
  password_last_rotated_at TIMESTAMPTZ,
  pin_last_rotated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_credentials_email ON auth_credentials(email);

-- Sessions - auth/admin sessions
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('admin', 'register')),
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_employee_id ON sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Inventory Adjustments
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_level_id UUID NOT NULL REFERENCES inventory_levels(id) ON DELETE CASCADE,
  product_variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  delta INTEGER NOT NULL,
  resulting_on_hand INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_inventory_level_id ON inventory_adjustments(inventory_level_id);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_employee_id ON inventory_adjustments(employee_id);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_location_id ON inventory_adjustments(location_id);

-- ============================================================================
-- PHASE 2 TABLES
-- ============================================================================

-- Gift Cards
CREATE TABLE IF NOT EXISTS gift_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  balance NUMERIC(12, 2) NOT NULL,
  initial_balance NUMERIC(12, 2) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'depleted', 'disabled', 'expired')),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  activated_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gift_cards_organization_id ON gift_cards(organization_id);
CREATE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);
CREATE INDEX IF NOT EXISTS idx_gift_cards_customer_id ON gift_cards(customer_id);
CREATE INDEX IF NOT EXISTS idx_gift_cards_status ON gift_cards(status);

-- Gift Card Transactions
CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id UUID NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('activation', 'reload', 'redemption', 'refund', 'adjustment', 'void')),
  amount NUMERIC(12, 2) NOT NULL,
  balance_after NUMERIC(12, 2) NOT NULL,
  employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gift_card_transactions_gift_card_id ON gift_card_transactions(gift_card_id);
CREATE INDEX IF NOT EXISTS idx_gift_card_transactions_transaction_id ON gift_card_transactions(transaction_id);

-- Store Credit Ledger
CREATE TABLE IF NOT EXISTS store_credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('issuance', 'redemption', 'adjustment', 'refund', 'void')),
  amount NUMERIC(12, 2) NOT NULL,
  balance_after NUMERIC(12, 2) NOT NULL,
  employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  reason TEXT,
  approved_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_organization_id ON store_credit_ledger(organization_id);
CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_customer_id ON store_credit_ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_transaction_id ON store_credit_ledger(transaction_id);

-- Employee Behavior Flags
CREATE TABLE IF NOT EXISTS behavior_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  flag_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  title TEXT NOT NULL,
  description TEXT,
  source_ref_type TEXT,
  source_ref_id UUID,
  details JSONB DEFAULT '{}' NOT NULL,
  is_reviewed BOOLEAN DEFAULT false NOT NULL,
  reviewed_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_behavior_flags_organization_id ON behavior_flags(organization_id);
CREATE INDEX IF NOT EXISTS idx_behavior_flags_employee_id ON behavior_flags(employee_id);
CREATE INDEX IF NOT EXISTS idx_behavior_flags_severity ON behavior_flags(severity);

-- Layaways
CREATE TABLE IF NOT EXISTS layaways (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'partially_paid', 'paid_in_full', 'collected', 'cancelled', 'forfeited')),
  cart_snapshot JSONB NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL,
  discount_total NUMERIC(12, 2) NOT NULL,
  tax_total NUMERIC(12, 2) NOT NULL,
  grand_total NUMERIC(12, 2) NOT NULL,
  deposit_paid NUMERIC(12, 2) NOT NULL,
  balance_due NUMERIC(12, 2) NOT NULL,
  minimum_deposit NUMERIC(12, 2) NOT NULL,
  due_date TIMESTAMPTZ,
  notes TEXT,
  completed_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  cancelled_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_layaways_organization_id ON layaways(organization_id);
CREATE INDEX IF NOT EXISTS idx_layaways_location_id ON layaways(location_id);
CREATE INDEX IF NOT EXISTS idx_layaways_customer_id ON layaways(customer_id);
CREATE INDEX IF NOT EXISTS idx_layaways_employee_id ON layaways(employee_id);
CREATE INDEX IF NOT EXISTS idx_layaways_status ON layaways(status);

-- Layaway Payments
CREATE TABLE IF NOT EXISTS layaway_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layaway_id UUID NOT NULL REFERENCES layaways(id) ON DELETE CASCADE,
  tender_type TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  metadata JSONB DEFAULT '{}' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_layaway_payments_layaway_id ON layaway_payments(layaway_id);

-- Stocktakes
CREATE TABLE IF NOT EXISTS stocktakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  initiated_by UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'pending_review', 'accepted', 'cancelled')),
  count_type TEXT NOT NULL CHECK (count_type IN ('full', 'cycle')),
  category_filter UUID REFERENCES categories(id) ON DELETE SET NULL,
  notes TEXT,
  accepted_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stocktakes_organization_id ON stocktakes(organization_id);
CREATE INDEX IF NOT EXISTS idx_stocktakes_location_id ON stocktakes(location_id);
CREATE INDEX IF NOT EXISTS idx_stocktakes_status ON stocktakes(status);

-- Stocktake Lines
CREATE TABLE IF NOT EXISTS stocktake_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id UUID NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  product_variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  expected_qty INTEGER NOT NULL,
  counted_qty INTEGER,
  variance INTEGER,
  counted_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  counted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stocktake_lines_stocktake_id ON stocktake_lines(stocktake_id);

-- Transfers
CREATE TABLE IF NOT EXISTS transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  destination_location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('requested', 'in_transit', 'received', 'cancelled')),
  requested_by UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shipped_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  shipped_at TIMESTAMPTZ,
  received_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transfers_organization_id ON transfers(organization_id);
CREATE INDEX IF NOT EXISTS idx_transfers_source_location_id ON transfers(source_location_id);
CREATE INDEX IF NOT EXISTS idx_transfers_destination_location_id ON transfers(destination_location_id);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);

-- Transfer Lines
CREATE TABLE IF NOT EXISTS transfer_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  product_variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity_requested INTEGER NOT NULL,
  quantity_shipped INTEGER,
  quantity_received INTEGER,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transfer_lines_transfer_id ON transfer_lines(transfer_id);

-- ============================================================================
-- PHASE 3 TABLES
-- ============================================================================

-- Time Clock Entries
CREATE TABLE IF NOT EXISTS time_clock_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('clock_in', 'clock_out', 'break_start', 'break_end')),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_time_clock_entries_organization_id ON time_clock_entries(organization_id);
CREATE INDEX IF NOT EXISTS idx_time_clock_entries_employee_id ON time_clock_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_time_clock_entries_location_id ON time_clock_entries(location_id);
CREATE INDEX IF NOT EXISTS idx_time_clock_entries_event_type ON time_clock_entries(event_type);

-- Promo Codes
CREATE TABLE IF NOT EXISTS promo_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('fixed', 'percent', 'bogo')),
  value NUMERIC(12, 2) NOT NULL,
  minimum_purchase NUMERIC(12, 2) NOT NULL,
  max_redemptions INTEGER NOT NULL,
  current_redemptions INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'disabled', 'depleted')),
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_organization_id ON promo_codes(organization_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_status ON promo_codes(status);

-- Promo Redemptions
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  discount_amount NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_promo_code_id ON promo_redemptions(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_transaction_id ON promo_redemptions(transaction_id);

-- ============================================================================
-- CONSTRAINTS AND REFERENTIAL INTEGRITY
-- ============================================================================

-- Add foreign key constraint for product default_variant_id
ALTER TABLE products
ADD CONSTRAINT fk_products_default_variant_id
FOREIGN KEY (default_variant_id) REFERENCES product_variants(id) ON DELETE SET NULL;

-- Add foreign key constraint for shifts active_shift_id in register_sessions
ALTER TABLE register_sessions
ADD CONSTRAINT fk_register_sessions_active_shift_id
FOREIGN KEY (active_shift_id) REFERENCES shifts(id) ON DELETE SET NULL;

-- ============================================================================
-- COMMENTS FOR CLARITY
-- ============================================================================

COMMENT ON TABLE organizations IS 'Multi-tenant root entity housing all organizational data';
COMMENT ON TABLE locations IS 'Individual store locations within an organization';
COMMENT ON TABLE employees IS 'Employee records with role assignments and active locations';
COMMENT ON TABLE transactions IS 'Main transaction records with cart snapshots for full audit trail';
COMMENT ON TABLE transaction_tenders IS 'Normalized payment tender lines (cash, card, store_credit, etc.)';
COMMENT ON TABLE transaction_events IS 'Audit trail of actions taken on transactions (add item, discount, etc.)';
COMMENT ON TABLE transaction_exceptions IS 'Approval-required exceptions that must be resolved by a manager';
COMMENT ON TABLE audit_events IS 'Comprehensive audit trail for compliance and monitoring';
COMMENT ON TABLE register_sessions IS 'User POS session, tied to employee and location';
COMMENT ON TABLE shifts IS 'Shift records with float tracking and variance calculation';
COMMENT ON TABLE inventory_levels IS 'Per-location inventory tracking with on_hand and reserved quantities';
COMMENT ON TABLE gift_cards IS 'Phase 2: Gift card records with balance and status tracking';
COMMENT ON TABLE store_credit_ledger IS 'Phase 2: Customer store credit ledger with transaction history';
COMMENT ON TABLE layaways IS 'Phase 2: Layaway orders with deposit tracking and status workflow';
COMMENT ON TABLE stocktakes IS 'Phase 2: Physical inventory counts with variance tracking';
COMMENT ON TABLE transfers IS 'Phase 2: Inter-store inventory transfers with status workflow';
COMMENT ON TABLE time_clock_entries IS 'Phase 3: Employee time clock entries for timekeeping';
COMMENT ON TABLE promo_codes IS 'Phase 3: Promotional codes with redemption tracking';
