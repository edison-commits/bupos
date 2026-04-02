-- BasicUniformPOS Phase 3: Product brand and type
-- Adds: product_brand and product_type columns to products table

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS product_brand TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS product_type TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_products_product_brand ON products(product_brand) WHERE product_brand != '';
CREATE INDEX IF NOT EXISTS idx_products_product_type ON products(product_type) WHERE product_type != '';
