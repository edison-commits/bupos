-- BasicUniformPOS Phase 4: Receipt store info fields
-- Adds customizable store name, address, city/state/zip, phone for receipts

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS receipt_store_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS receipt_store_address TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS receipt_store_city TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS receipt_store_region TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS receipt_store_postal_code TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS receipt_store_phone TEXT DEFAULT '';
