-- Add 'free_item' as a valid promo_codes.type alongside the existing
-- 'fixed', 'percent', 'bogo'. Free-item promos give away one unit of a
-- specific variant when the cart meets the minimum_purchase threshold,
-- distinct from bundles (bundles are package-priced, always > $0).
--
-- free_variant_id is a nullable FK to product_variants. The consistency
-- CHECK enforces "free_variant_id is NOT NULL iff type = free_item" so
-- the column is populated exactly when it's meaningful.

ALTER TABLE promo_codes
  ADD COLUMN free_variant_id UUID
  REFERENCES product_variants(id) ON DELETE RESTRICT;

ALTER TABLE promo_codes DROP CONSTRAINT promo_codes_type_check;
ALTER TABLE promo_codes
  ADD CONSTRAINT promo_codes_type_check
  CHECK (type IN ('fixed', 'percent', 'bogo', 'free_item'));

ALTER TABLE promo_codes
  ADD CONSTRAINT promo_codes_free_variant_id_consistency
  CHECK (
    (type = 'free_item' AND free_variant_id IS NOT NULL)
    OR (type <> 'free_item' AND free_variant_id IS NULL)
  );

CREATE INDEX idx_promo_codes_free_variant_id
  ON promo_codes(free_variant_id)
  WHERE free_variant_id IS NOT NULL;
