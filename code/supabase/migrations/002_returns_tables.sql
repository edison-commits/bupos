-- Migration: create_returns_and_return_lines
-- Creates the returns and return_lines tables for the return processing flow

CREATE TABLE IF NOT EXISTS returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  return_number text NOT NULL UNIQUE,
  transaction_id uuid,
  customer_name text,
  reason text NOT NULL DEFAULT 'other',
  notes text,
  refund_method text NOT NULL DEFAULT 'store_credit',
  refund_amount numeric(10, 2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  processed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  product_variant_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  unit_price numeric(10, 2) NOT NULL DEFAULT 0,
  restock boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_returns_organization_id ON returns(organization_id);
CREATE INDEX IF NOT EXISTS idx_returns_location_id ON returns(location_id);
CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);
CREATE INDEX IF NOT EXISTS idx_returns_created_at ON returns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_return_lines_return_id ON return_lines(return_id);
CREATE INDEX IF NOT EXISTS idx_return_lines_product_variant_id ON return_lines(product_variant_id);