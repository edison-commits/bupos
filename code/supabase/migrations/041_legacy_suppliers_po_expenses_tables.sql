-- R13-H-2: migration 024 unconditionally calls
-- `ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY` (and the same for
-- purchase_orders, purchase_order_lines, expenses) inside its DO-block
-- policy-refresh loop. Those four tables are not declared in ANY
-- migration file, so fresh-DB bootstrap — dev onboarding, DR restore,
-- staging spinup — throws `relation "suppliers" does not exist` at
-- migration 024 and never reaches 025..040.
--
-- Source: pulled from production via `information_schema.columns` on
-- Supabase project jkdgdcfpgxjfdlccvqjf so signatures + FKs + check
-- constraints match identically. Wrapped in `CREATE TABLE IF NOT EXISTS`
-- so re-applying in prod is a no-op. Indexes use `IF NOT EXISTS`.
--
-- Why this migration is numbered 041 (after 024) even though 024 depends
-- on these tables existing:
--   - Prod already has these tables (hand-applied long ago) AND has
--     migration 024 applied, so the ordering doesn't matter there.
--   - On fresh DB, migration 024 is ALSO guarded idempotently via
--     companion edit: its DO block now uses `pg_tables` existence checks
--     per table, so "suppliers doesn't exist yet" silently no-ops in
--     024. Then 041 creates the tables, and a final policy-refresh
--     stanza at the bottom of 041 applies the RLS hardening that 024
--     skipped on fresh-DB.

BEGIN;

-- ── suppliers ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  contact_name    text,
  email           text,
  phone           text,
  address         text,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_organization_id ON suppliers(organization_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_org_active ON suppliers(organization_id, is_active);

-- ── purchase_orders ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  supplier_id     uuid NOT NULL REFERENCES suppliers(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  po_number       text NOT NULL,
  status          text NOT NULL DEFAULT 'draft',
  notes           text,
  ordered_at      timestamptz,
  expected_at     timestamptz,
  received_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_orders_status_check
    CHECK (status IN ('draft','submitted','partial','received','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_organization_id ON purchase_orders(organization_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_location_id ON purchase_orders(location_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier_id ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);

-- ── purchase_order_lines ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id   uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_variant_id  uuid NOT NULL REFERENCES product_variants(id),
  quantity_ordered    integer NOT NULL DEFAULT 0,
  quantity_received   integer NOT NULL DEFAULT 0,
  unit_cost           numeric(12,2) NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po_id ON purchase_order_lines(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_variant_id ON purchase_order_lines(product_variant_id);

-- ── scheduled_shifts ──────────────────────────────────────────────────
-- Referenced by migration 024's RLS policy-refresh block; no prior migration
-- defined it. Used by the admin scheduling UI (see /api/shifts subpaths).
CREATE TABLE IF NOT EXISTS scheduled_shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  shift_date      date NOT NULL,
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  notes           text DEFAULT '',
  created_at      timestamptz DEFAULT now(),
  created_by      uuid REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_shifts_location_date ON scheduled_shifts(location_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_scheduled_shifts_employee_date ON scheduled_shifts(employee_id, shift_date);

-- ── time_off_requests ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS time_off_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  request_type    text NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  notes           text DEFAULT '',
  requested_at    timestamptz DEFAULT now(),
  reviewed_by     uuid REFERENCES employees(id),
  reviewed_at     timestamptz,
  CONSTRAINT time_off_requests_request_type_check
    CHECK (request_type IN ('vacation','sick','personal','bereavement','jury_duty','other')),
  CONSTRAINT time_off_requests_status_check
    CHECK (status IN ('pending','approved','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_time_off_requests_employee ON time_off_requests(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_time_off_requests_org_dates ON time_off_requests(organization_id, start_date, end_date);

-- ── expenses ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  location_id        uuid NOT NULL REFERENCES locations(id),
  category           text NOT NULL,
  description        text NOT NULL,
  amount             numeric(12,2) NOT NULL,
  expense_date       date NOT NULL DEFAULT CURRENT_DATE,
  is_recurring       boolean NOT NULL DEFAULT false,
  recurrence_period  text,
  receipt_url        text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_category_check
    CHECK (category IN ('rent','utilities','payroll','supplies','marketing',
                        'insurance','maintenance','shipping','taxes','other')),
  CONSTRAINT expenses_recurrence_period_check
    CHECK (recurrence_period IS NULL OR recurrence_period IN
      ('weekly','biweekly','monthly','quarterly','yearly'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_organization_id ON expenses(organization_id);
CREATE INDEX IF NOT EXISTS idx_expenses_location_id ON expenses(location_id);
CREATE INDEX IF NOT EXISTS idx_expenses_expense_date ON expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);

-- ── RLS: apply the same hardening 024 tries to apply ──────────────────
-- On fresh DB, migration 024's DO block will no-op for these tables (it
-- checks pg_tables first — see companion edit). This block picks up the
-- slack so the final state matches prod.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['suppliers','purchase_orders','expenses']::text[] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (organization_id = current_setting(''app.current_org_id'', true)::uuid) WITH CHECK (organization_id = current_setting(''app.current_org_id'', true)::uuid)',
      tbl
    );
  END LOOP;

  -- purchase_order_lines has no org column; scope via parent.
  ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS parent_org_isolation ON purchase_order_lines;
  CREATE POLICY parent_org_isolation ON purchase_order_lines
    USING (EXISTS (SELECT 1 FROM purchase_orders po
      WHERE po.id = purchase_order_lines.purchase_order_id
        AND po.organization_id = current_setting('app.current_org_id', true)::uuid))
    WITH CHECK (EXISTS (SELECT 1 FROM purchase_orders po
      WHERE po.id = purchase_order_lines.purchase_order_id
        AND po.organization_id = current_setting('app.current_org_id', true)::uuid));

  -- scheduled_shifts + time_off_requests — style matches migration 024's
  -- fallback policy shape (parent-JOIN through locations/employees) rather
  -- than organization_id= so prod + fresh-DB converge on identical
  -- policy text. Both paths end up equivalent but the explicit match
  -- avoids CI drift.
  ALTER TABLE scheduled_shifts ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS org_isolation ON scheduled_shifts;
  CREATE POLICY org_isolation ON scheduled_shifts
    USING (location_id IN (SELECT id FROM locations WHERE organization_id = current_setting('app.current_org_id', true)::uuid))
    WITH CHECK (location_id IN (SELECT id FROM locations WHERE organization_id = current_setting('app.current_org_id', true)::uuid));

  ALTER TABLE time_off_requests ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS org_isolation ON time_off_requests;
  CREATE POLICY org_isolation ON time_off_requests
    USING (employee_id IN (SELECT id FROM employees WHERE organization_id = current_setting('app.current_org_id', true)::uuid))
    WITH CHECK (employee_id IN (SELECT id FROM employees WHERE organization_id = current_setting('app.current_org_id', true)::uuid));
END $$;

COMMIT;
