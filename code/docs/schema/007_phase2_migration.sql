-- BasicUniformPOS Phase 2 Migration
-- Adds: customers, pay-in/out, behavior flags, gift cards, store credit ledger,
--        layaway, stocktakes, inter-store transfers, and schema patches.

-- ══════════════════════════════════════════════════════════════════════
-- 1. Schema patches for Phase 1 gaps
-- ══════════════════════════════════════════════════════════════════════

-- Add loyalty tender type + customer_id to transaction_tenders
alter table transaction_tenders
  drop constraint if exists transaction_tenders_tender_type_check;
alter table transaction_tenders
  add constraint transaction_tenders_tender_type_check
  check (tender_type in ('cash', 'card', 'store_credit', 'loyalty', 'split'));

-- Add password_hash + pin_hint columns if missing (some envs may lack them)
alter table employee_profiles add column if not exists password_hash text;
alter table employee_profiles add column if not exists pin_hint text default '';

-- Add blind_close to shifts
alter table shifts add column if not exists blind_close boolean not null default false;

-- Add loyalty config to register_configurations
alter table register_configurations add column if not exists loyalty_config jsonb
  not null default '{"earnRatePerDollar":1,"redemptionValuePerPoint":0.01,"minimumRedemption":100}'::jsonb;

-- ══════════════════════════════════════════════════════════════════════
-- 2. Customers
-- ══════════════════════════════════════════════════════════════════════

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  loyalty_points integer not null default 0,
  total_spend numeric(12,2) not null default 0,
  visit_count integer not null default 0,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_customers_org on customers(organization_id);
create index if not exists idx_customers_name on customers(organization_id, last_name, first_name);
create index if not exists idx_customers_email on customers(organization_id, email) where email is not null;
create index if not exists idx_customers_phone on customers(organization_id, phone) where phone is not null;

-- Link transactions to customers
alter table transactions add column if not exists customer_id uuid references customers(id);
alter table transactions add column if not exists loyalty_points_earned integer not null default 0;
alter table transactions add column if not exists loyalty_points_redeemed integer not null default 0;

-- ══════════════════════════════════════════════════════════════════════
-- 3. Pay-in / Pay-out
-- ══════════════════════════════════════════════════════════════════════

create table if not exists pay_in_outs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  shift_id uuid not null references shifts(id) on delete cascade,
  location_id uuid not null references locations(id),
  employee_id uuid not null references employee_profiles(id),
  direction text not null check (direction in ('pay_in', 'pay_out')),
  amount numeric(12,2) not null check (amount > 0),
  reason text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_pay_in_outs_shift on pay_in_outs(shift_id);

-- ══════════════════════════════════════════════════════════════════════
-- 4. Employee Behavior Flags (suspicious activity monitoring)
-- ══════════════════════════════════════════════════════════════════════

create table if not exists employee_behavior_flags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_id uuid not null references employee_profiles(id) on delete cascade,
  location_id uuid references locations(id),
  flag_type text not null,
  severity text not null check (severity in ('low', 'medium', 'high')),
  title text not null,
  description text,
  source_ref_type text,  -- 'shift', 'transaction', 'exception', etc.
  source_ref_id uuid,
  details jsonb not null default '{}'::jsonb,
  is_reviewed boolean not null default false,
  reviewed_by uuid references employee_profiles(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_behavior_flags_employee on employee_behavior_flags(employee_id);
create index if not exists idx_behavior_flags_org_severity on employee_behavior_flags(organization_id, severity);
create index if not exists idx_behavior_flags_unreviewed on employee_behavior_flags(organization_id, is_reviewed) where is_reviewed = false;

-- ══════════════════════════════════════════════════════════════════════
-- 5. Gift Cards
-- ══════════════════════════════════════════════════════════════════════

create table if not exists gift_cards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code text not null,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  initial_balance numeric(12,2) not null check (initial_balance > 0),
  status text not null default 'active' check (status in ('active', 'depleted', 'disabled', 'expired')),
  customer_id uuid references customers(id),
  activated_by uuid references employee_profiles(id),
  activated_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table if not exists gift_card_transactions (
  id uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references gift_cards(id) on delete cascade,
  transaction_type text not null check (transaction_type in ('activation', 'reload', 'redemption', 'refund', 'adjustment', 'void')),
  amount numeric(12,2) not null,
  balance_after numeric(12,2) not null,
  employee_id uuid references employee_profiles(id),
  transaction_id uuid, -- link to POS transaction if applicable
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_gift_cards_code on gift_cards(organization_id, code);
create index if not exists idx_gift_card_txns on gift_card_transactions(gift_card_id);

-- ══════════════════════════════════════════════════════════════════════
-- 6. Store Credit Ledger
-- ══════════════════════════════════════════════════════════════════════

create table if not exists store_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  transaction_type text not null check (transaction_type in ('issuance', 'redemption', 'adjustment', 'refund', 'void')),
  amount numeric(12,2) not null,
  balance_after numeric(12,2) not null,
  employee_id uuid references employee_profiles(id),
  transaction_id uuid, -- link to POS transaction
  reason text,
  approved_by uuid references employee_profiles(id),
  created_at timestamptz not null default now()
);

-- Add store credit balance to customers
alter table customers add column if not exists store_credit_balance numeric(12,2) not null default 0;

create index if not exists idx_store_credit_customer on store_credit_ledger(customer_id);

-- ══════════════════════════════════════════════════════════════════════
-- 7. Layaway / Partial-Payment Orders
-- ══════════════════════════════════════════════════════════════════════

create table if not exists layaways (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id),
  customer_id uuid not null references customers(id),
  employee_id uuid not null references employee_profiles(id),
  status text not null default 'active'
    check (status in ('active', 'partially_paid', 'paid_in_full', 'collected', 'cancelled', 'forfeited')),
  cart_snapshot jsonb not null,
  subtotal numeric(12,2) not null,
  discount_total numeric(12,2) not null default 0,
  tax_total numeric(12,2) not null default 0,
  grand_total numeric(12,2) not null,
  deposit_paid numeric(12,2) not null default 0,
  balance_due numeric(12,2) not null,
  minimum_deposit numeric(12,2) not null default 0,
  due_date date,
  notes text,
  completed_transaction_id uuid references transactions(id),
  cancelled_by uuid references employee_profiles(id),
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists layaway_payments (
  id uuid primary key default gen_random_uuid(),
  layaway_id uuid not null references layaways(id) on delete cascade,
  tender_type text not null check (tender_type in ('cash', 'card', 'store_credit', 'loyalty')),
  amount numeric(12,2) not null check (amount > 0),
  employee_id uuid not null references employee_profiles(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_layaways_customer on layaways(customer_id);
create index if not exists idx_layaways_location_status on layaways(location_id, status);
create index if not exists idx_layaway_payments on layaway_payments(layaway_id);

-- ══════════════════════════════════════════════════════════════════════
-- 8. Stocktakes
-- ══════════════════════════════════════════════════════════════════════

create table if not exists stocktakes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id),
  initiated_by uuid not null references employee_profiles(id),
  status text not null default 'in_progress'
    check (status in ('in_progress', 'pending_review', 'accepted', 'cancelled')),
  count_type text not null default 'full' check (count_type in ('full', 'cycle')),
  category_filter uuid references categories(id), -- for cycle counts
  notes text,
  accepted_by uuid references employee_profiles(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists stocktake_lines (
  id uuid primary key default gen_random_uuid(),
  stocktake_id uuid not null references stocktakes(id) on delete cascade,
  product_variant_id uuid not null references product_variants(id),
  expected_qty integer not null,
  counted_qty integer,
  variance integer generated always as (counted_qty - expected_qty) stored,
  counted_by uuid references employee_profiles(id),
  counted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_stocktakes_location on stocktakes(location_id, status);
create index if not exists idx_stocktake_lines on stocktake_lines(stocktake_id);

-- ══════════════════════════════════════════════════════════════════════
-- 9. Inter-Store Transfers
-- ══════════════════════════════════════════════════════════════════════

create table if not exists transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  source_location_id uuid not null references locations(id),
  destination_location_id uuid not null references locations(id),
  status text not null default 'requested'
    check (status in ('requested', 'in_transit', 'received', 'cancelled')),
  requested_by uuid not null references employee_profiles(id),
  shipped_by uuid references employee_profiles(id),
  shipped_at timestamptz,
  received_by uuid references employee_profiles(id),
  received_at timestamptz,
  cancelled_by uuid references employee_profiles(id),
  cancelled_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_location_id <> destination_location_id)
);

create table if not exists transfer_lines (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references transfers(id) on delete cascade,
  product_variant_id uuid not null references product_variants(id),
  quantity_requested integer not null check (quantity_requested > 0),
  quantity_shipped integer,
  quantity_received integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_transfers_status on transfers(organization_id, status);
create index if not exists idx_transfer_lines on transfer_lines(transfer_id);

-- ══════════════════════════════════════════════════════════════════════
-- 10. Performance indexes on existing tables
-- ══════════════════════════════════════════════════════════════════════

create index if not exists idx_transaction_tenders_txn on transaction_tenders(transaction_id);
create index if not exists idx_transaction_events_txn on transaction_events(transaction_id);
create index if not exists idx_transaction_events_actor on transaction_events(actor_employee_id);
create index if not exists idx_transaction_exceptions_txn on transaction_exceptions(transaction_id);
create index if not exists idx_shifts_location_status on shifts(location_id, status);
create index if not exists idx_audit_events_org on audit_events(organization_id, created_at desc);
create index if not exists idx_inventory_adjustments_location on inventory_adjustments(location_id, created_at desc);
