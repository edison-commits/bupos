-- Tighten bundle_price from `>= 0` to `> 0`. A $0 bundle is a different
-- concept ("free with purchase") that will be modeled separately; treating
-- it as a special-case of bundles blurs the codepath and invites bugs
-- (e.g. a cashier creating a $0 bundle to hand out merchandise).
--
-- Idempotent: drops the old constraint only if it's the permissive one,
-- otherwise leaves things alone.

DO $$
BEGIN
  -- Drop any existing bundle_price check (regardless of exact name /
  -- definition) and reinstate the canonical > 0 one. This avoids leaving
  -- two conflicting checks if the migration ran partially before.
  PERFORM 1 FROM pg_constraint
   WHERE conrelid = 'product_bundles'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%bundle_price%';
  IF FOUND THEN
    EXECUTE (
      SELECT string_agg(format('ALTER TABLE product_bundles DROP CONSTRAINT %I', conname), '; ')
      FROM pg_constraint
      WHERE conrelid = 'product_bundles'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%bundle_price%'
    );
  END IF;

  ALTER TABLE product_bundles
    ADD CONSTRAINT product_bundles_bundle_price_positive
    CHECK (bundle_price > 0);
END $$;
