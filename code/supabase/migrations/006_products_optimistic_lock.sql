-- Add updated_at columns for optimistic locking on product edits
-- These columns may already exist in some deployments; ADD COLUMN IF NOT EXISTS is idempotent
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
