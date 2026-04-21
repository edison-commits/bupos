-- Round 9: backfill repo migration for columns the app reads/writes but
-- the initial-schema migration never declared. These columns already exist
-- in production DB; this migration exists so a fresh `supabase db reset`
-- produces a schema matching prod.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS plan       text    NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS is_active  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS phone      text,
  ADD COLUMN IF NOT EXISTS email      text,
  ADD COLUMN IF NOT EXISTS website    text,
  ADD COLUMN IF NOT EXISTS receipt_header           text,
  ADD COLUMN IF NOT EXISTS receipt_footer           text,
  ADD COLUMN IF NOT EXISTS receipt_store_name       text,
  ADD COLUMN IF NOT EXISTS receipt_store_address    text,
  ADD COLUMN IF NOT EXISTS receipt_store_city       text,
  ADD COLUMN IF NOT EXISTS receipt_store_region     text,
  ADD COLUMN IF NOT EXISTS receipt_store_postal_code text,
  ADD COLUMN IF NOT EXISTS receipt_store_phone      text;

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS tax_rate numeric(5,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS phone    text;
