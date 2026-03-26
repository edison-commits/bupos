-- Register sessions and shifts (Milestone 0.5.4)

create table if not exists register_sessions (
  id uuid primary key default gen_random_uuid(),
  auth_session_id text not null,
  employee_id uuid not null references employee_profiles(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'ended')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  active_shift_id uuid,
  last_cart_id uuid,
  last_transaction_id uuid,
  pending_exception_ids jsonb not null default '[]'::jsonb
);

create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  employee_id uuid not null references employee_profiles(id) on delete cascade,
  register_session_id uuid not null references register_sessions(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  opening_float numeric(12,2) not null default 0,
  opened_note text,
  closed_at timestamptz,
  closing_expected_cash numeric(12,2),
  closing_declared_cash numeric(12,2),
  closing_variance numeric(12,2),
  closed_note text
);

alter table register_sessions
  add constraint register_sessions_active_shift_fk
  foreign key (active_shift_id) references shifts(id) deferrable initially deferred;

-- Auth sessions table (maps cookie session IDs to employees)
create table if not exists auth_sessions (
  id text primary key,
  employee_id uuid not null references employee_profiles(id) on delete cascade,
  scope text not null check (scope in ('admin', 'register')),
  location_id uuid references locations(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
