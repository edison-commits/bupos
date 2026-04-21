-- R28-M6: per-customer promo redemption cap.
--
-- Pre-fix: only a GLOBAL `max_redemptions` cap on promo_codes. A single
-- attacker + customer accomplice could run N back-to-back checkouts
-- (each with a fresh transaction_id, so the unique (promo_code_id,
-- transaction_id) index didn't collide) consuming ONE `current_redemptions`
-- tick per txn. At max_redemptions=100 and a "Free $20 tee with $0.50
-- purchase" promo, that's $2000 of retail giveaways to one household
-- — and every OTHER legitimate customer locked out.
--
-- Fix: optional `max_redemptions_per_customer` column. NULL = unlimited
-- (backward compatible with today's data). Checkout adds a predicate
-- SELECT on promo_redemptions COUNT to enforce.

BEGIN;

ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS max_redemptions_per_customer INTEGER;

-- Sanity bound: 0 means "no redemptions per customer" which is
-- semantically meaningless; reject negatives too.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'promo_codes_max_per_customer_nonneg'
  ) THEN
    ALTER TABLE promo_codes
      ADD CONSTRAINT promo_codes_max_per_customer_nonneg
      CHECK (max_redemptions_per_customer IS NULL OR max_redemptions_per_customer > 0);
  END IF;
END
$$;

COMMIT;
