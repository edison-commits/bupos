-- Prevent duplicate customers with the same email per organization
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_org_email
  ON customers(organization_id, LOWER(email))
  WHERE email IS NOT NULL AND email != '';
