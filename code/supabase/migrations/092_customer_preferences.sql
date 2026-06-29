BEGIN;

CREATE TABLE IF NOT EXISTS customer_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  size_label TEXT,
  fit_preference TEXT,
  preferred_colors TEXT[] NOT NULL DEFAULT '{}',
  preferred_brands TEXT[] NOT NULL DEFAULT '{}',
  style_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, customer_id, category)
);

CREATE INDEX IF NOT EXISTS idx_customer_preferences_org_customer
  ON customer_preferences (organization_id, customer_id);

ALTER TABLE customer_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_preferences FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'customer_preferences'
      AND policyname = 'customer_preferences_tenant_isolation'
  ) THEN
    CREATE POLICY customer_preferences_tenant_isolation ON customer_preferences
      USING (organization_id = current_setting('app.current_org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
  END IF;
END$$;

COMMIT;
