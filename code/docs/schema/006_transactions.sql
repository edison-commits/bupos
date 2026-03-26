-- Transactions table (Milestone 0.5.5)

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id),
  register_session_id uuid references register_sessions(id),
  employee_id uuid not null references employee_profiles(id),
  cart_snapshot jsonb not null,
  subtotal numeric(12,2) not null,
  discount_total numeric(12,2) not null default 0,
  tax_total numeric(12,2) not null default 0,
  grand_total numeric(12,2) not null,
  tender_type text not null check (tender_type in ('cash', 'card', 'store_credit', 'split')),
  amount_tendered numeric(12,2) not null,
  change_due numeric(12,2) not null default 0,
  status text not null default 'completed' check (status in ('completed', 'voided', 'refunded')),
  created_at timestamptz not null default now()
);

-- Link existing transaction_tenders/events/exceptions to real transactions
alter table transaction_tenders add column if not exists organization_id uuid references organizations(id);
alter table transaction_events add column if not exists organization_id uuid references organizations(id);
