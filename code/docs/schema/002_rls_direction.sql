-- BasicUniformPOS RLS direction (not yet wired to auth provider)
-- Goal: every query scopes to organization and, when relevant, assigned locations.

alter table organizations enable row level security;
alter table locations enable row level security;
alter table employee_profiles enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table product_variants enable row level security;
alter table modifier_groups enable row level security;
alter table modifiers enable row level security;
alter table inventory_levels enable row level security;
alter table inventory_adjustments enable row level security;
alter table register_configurations enable row level security;
alter table audit_events enable row level security;

-- Expected future auth claims:
--   request.jwt.claim.org_id
--   request.jwt.claim.role_key
--   request.jwt.claim.location_ids (JSON array)

-- Example organization-level read gate:
create policy org_read_locations on locations
for select
using (organization_id = nullif(current_setting('request.jwt.claim.org_id', true), '')::uuid);

-- Example manager-only write gate:
create policy manager_write_categories on categories
for all
using (
  organization_id = nullif(current_setting('request.jwt.claim.org_id', true), '')::uuid
  and current_setting('request.jwt.claim.role_key', true) in ('owner', 'manager', 'inventory_clerk')
)
with check (
  organization_id = nullif(current_setting('request.jwt.claim.org_id', true), '')::uuid
  and current_setting('request.jwt.claim.role_key', true) in ('owner', 'manager', 'inventory_clerk')
);

-- Example location-scoped inventory reads:
create policy location_read_inventory on inventory_levels
for select
using (
  organization_id = nullif(current_setting('request.jwt.claim.org_id', true), '')::uuid
  and location_id::text in (
    select jsonb_array_elements_text(
      coalesce(nullif(current_setting('request.jwt.claim.location_ids', true), ''), '[]')::jsonb
    )
  )
);

-- Audit/event tables should remain append-only for most roles.
-- Final auth implementation should split cashier, manager, and owner privileges explicitly.

-- ── Milestone 0.5.6 RBAC / RLS Notes ────────────────────────────────

-- Enable RLS on new tables from milestones 0.5.4 and 0.5.5:
alter table register_sessions enable row level security;
alter table shifts enable row level security;
alter table auth_sessions enable row level security;
alter table transactions enable row level security;

-- Register sessions: employees can only see their own sessions
create policy employee_own_register_sessions on register_sessions
for all
using (
  employee_id = nullif(current_setting('request.jwt.claim.employee_id', true), '')::uuid
)
with check (
  employee_id = nullif(current_setting('request.jwt.claim.employee_id', true), '')::uuid
);

-- Shifts: employees see own shifts; managers/owners see all shifts at their locations
create policy employee_read_own_shifts on shifts
for select
using (
  employee_id = nullif(current_setting('request.jwt.claim.employee_id', true), '')::uuid
  or current_setting('request.jwt.claim.role_key', true) in ('owner', 'manager')
);

-- Transactions: cashiers see own transactions; managers/owners see all at their locations
create policy transaction_access on transactions
for select
using (
  employee_id = nullif(current_setting('request.jwt.claim.employee_id', true), '')::uuid
  or (
    current_setting('request.jwt.claim.role_key', true) in ('owner', 'manager')
    and location_id::text in (
      select jsonb_array_elements_text(
        coalesce(nullif(current_setting('request.jwt.claim.location_ids', true), ''), '[]')::jsonb
      )
    )
  )
);

-- Auth sessions: service-only, no direct user access
create policy auth_sessions_service_only on auth_sessions
for all
using (false);

-- Application-level RBAC guards (implemented in src/lib/authz.ts):
--   assertAdminRole(roleKey) — blocks non-owner/manager from admin routes
--   assertRegisterRole(roleKey) — blocks roles without register.open from register routes
--   assertPermission(roleKey, permission, redirectPath) — generic permission check
--   requireRolePermissions(roleKey, permissions[]) — bulk permission check
--
-- These guards run BEFORE any database query, providing defense-in-depth
-- alongside RLS policies. When JWT-based auth is wired, RLS will act as
-- a second enforcement layer at the database level.
