BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS customer_display_display_name text,
  ADD COLUMN IF NOT EXISTS customer_display_welcome_text text NOT NULL DEFAULT 'Welcome',
  ADD COLUMN IF NOT EXISTS customer_display_idle_message text NOT NULL DEFAULT 'Ready to checkout',
  ADD COLUMN IF NOT EXISTS customer_display_accent_color text NOT NULL DEFAULT '#14b8a6';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_customer_display_accent_color_check'
      AND conrelid = 'organizations'::regclass
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_customer_display_accent_color_check
      CHECK (customer_display_accent_color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END$$;

COMMIT;
