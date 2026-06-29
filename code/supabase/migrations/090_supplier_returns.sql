BEGIN;

CREATE TABLE IF NOT EXISTS supplier_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  rtv_number text NOT NULL,
  status text NOT NULL DEFAULT 'submitted',
  reason text NOT NULL DEFAULT 'supplier_return',
  notes text,
  created_by_employee_id uuid NOT NULL REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_returns_status_check CHECK (status IN ('draft','submitted','credited','cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_returns_org_number ON supplier_returns(organization_id, rtv_number);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_org_location ON supplier_returns(organization_id, location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_supplier ON supplier_returns(supplier_id);

CREATE TABLE IF NOT EXISTS supplier_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_return_id uuid NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
  product_variant_id uuid NOT NULL REFERENCES product_variants(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_cost numeric(12,2) NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT 'return_to_vendor',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_return_lines_return ON supplier_return_lines(supplier_return_id);
CREATE INDEX IF NOT EXISTS idx_supplier_return_lines_variant ON supplier_return_lines(product_variant_id);

ALTER TABLE supplier_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_returns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON supplier_returns;
CREATE POLICY org_isolation ON supplier_returns
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE supplier_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_return_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS parent_org_isolation ON supplier_return_lines;
CREATE POLICY parent_org_isolation ON supplier_return_lines
  USING (EXISTS (SELECT 1 FROM supplier_returns sr WHERE sr.id = supplier_return_lines.supplier_return_id AND sr.organization_id = current_setting('app.current_org_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM supplier_returns sr WHERE sr.id = supplier_return_lines.supplier_return_id AND sr.organization_id = current_setting('app.current_org_id', true)::uuid));

COMMIT;
