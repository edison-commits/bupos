-- BasicUniformPOS Milestone 0–1 foundations
-- PostgreSQL-first, written to be Supabase/RLS-friendly later.

create extension if not exists pgcrypto;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  legal_name text not null,
  timezone text not null default 'America/Los_Angeles',
  currency_code text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code text not null,
  name text not null,
  address_1 text not null,
  city text not null,
  region text not null,
  postal_code text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table roles (
  key text primary key,
  label text not null,
  description text not null
);

create table role_permissions (
  role_key text not null references roles(key) on delete cascade,
  permission_key text not null,
  primary key (role_key, permission_key)
);

create table employee_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  role_key text not null references roles(key),
  first_name text not null,
  last_name text not null,
  display_name text not null,
  email text,
  pin_hash text not null,
  pin_last_rotated_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table employee_locations (
  employee_id uuid not null references employee_profiles(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  primary key (employee_id, location_id)
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  parent_category_id uuid references categories(id) on delete set null,
  slug text not null,
  name text not null,
  sort_order integer not null default 0,
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  category_id uuid not null references categories(id),
  slug text not null,
  name text not null,
  description text,
  image_url text,
  is_active boolean not null default true,
  is_touch_favorite boolean not null default false,
  default_variant_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table product_variants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  sku text not null,
  barcode text,
  name text not null,
  size_label text,
  color_label text,
  price numeric(12,2) not null,
  compare_at_price numeric(12,2),
  cost numeric(12,2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, sku)
);

alter table products
  add constraint products_default_variant_fk
  foreign key (default_variant_id) references product_variants(id) deferrable initially deferred;

create table modifier_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  selection_mode text not null check (selection_mode in ('single', 'multiple')),
  min_selections integer not null default 0,
  max_selections integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table modifiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  modifier_group_id uuid not null references modifier_groups(id) on delete cascade,
  name text not null,
  price_delta numeric(12,2) not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table product_modifier_groups (
  product_id uuid not null references products(id) on delete cascade,
  modifier_group_id uuid not null references modifier_groups(id) on delete cascade,
  primary key (product_id, modifier_group_id)
);

create table inventory_levels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  product_variant_id uuid not null references product_variants(id) on delete cascade,
  on_hand integer not null default 0,
  reserved integer not null default 0,
  reorder_point integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, product_variant_id)
);

create table inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  product_variant_id uuid not null references product_variants(id) on delete cascade,
  employee_id uuid references employee_profiles(id),
  quantity_delta integer not null,
  reason_code text not null,
  notes text,
  created_at timestamptz not null default now()
);

create table register_configurations (
  location_id uuid primary key references locations(id) on delete cascade,
  no_receipt_enabled boolean not null default true,
  receipt_mode text not null default 'browser-print' check (receipt_mode in ('browser-print', 'none')),
  supported_tenders jsonb not null default '["cash","card","store_credit","split"]'::jsonb,
  approval_thresholds jsonb not null,
  updated_at timestamptz not null default now()
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  employee_id uuid references employee_profiles(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  event_kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Checkout-adjacent placeholders reserved for Milestone 2.
create table transaction_tenders (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null,
  tender_type text not null check (tender_type in ('cash', 'card', 'store_credit', 'split')),
  amount numeric(12,2) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table transaction_events (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null,
  actor_employee_id uuid references employee_profiles(id),
  event_kind text not null,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table transaction_exceptions (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null,
  exception_code text not null,
  requires_manager_approval boolean not null default true,
  resolved_by_employee_id uuid references employee_profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
