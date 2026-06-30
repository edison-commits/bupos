BEGIN;

CREATE TABLE IF NOT EXISTS special_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'ordered', 'received', 'ready', 'fulfilled', 'cancelled')),
  request_notes TEXT,
  deposit_due NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (deposit_due >= 0),
  deposit_paid NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (deposit_paid >= 0),
  needed_by DATE,
  created_by_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS special_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  special_order_id UUID NOT NULL REFERENCES special_orders(id) ON DELETE CASCADE,
  product_variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 10000),
  unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_special_orders_org_status
  ON special_orders (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_special_orders_org_customer
  ON special_orders (organization_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_special_orders_location
  ON special_orders (organization_id, location_id, status);
CREATE INDEX IF NOT EXISTS idx_special_order_lines_order
  ON special_order_lines (organization_id, special_order_id);

ALTER TABLE special_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE special_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE special_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE special_order_lines FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS special_orders_tenant_isolation ON special_orders;
  CREATE POLICY special_orders_tenant_isolation ON special_orders
    USING (organization_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

  DROP POLICY IF EXISTS special_order_lines_tenant_isolation ON special_order_lines;
  CREATE POLICY special_order_lines_tenant_isolation ON special_order_lines
    USING (organization_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
END$$;

COMMIT;
