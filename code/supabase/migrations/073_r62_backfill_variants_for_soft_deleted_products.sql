-- R62-M2: backfill orphan active variants whose parent product was
-- soft-deleted BEFORE R60-A3 shipped the cascade-deactivation fix.
--
-- Background:
--   R58-2 switched deleteProductAction from hard-DELETE to soft-
--   delete (UPDATE is_active=false). It did NOT cascade to
--   product_variants, so any product deleted between R58-2 ship and
--   R60-A3 (which added the cascade) still has variants with
--   is_active=true pointing at products with is_active=false.
--
--   Several read paths only check pv.is_active (checkout-action
--   variant lookup, offline-sync serverPrices, receiving search),
--   so these orphan variants are still purchasable today — the
--   R60-A3 barcode-lookup filter closed ONE path but not the
--   others. /api/offline-sync was just patched in R62-H1 to
--   additionally check serverVariantActive; this migration closes
--   the data-at-rest gap.
--
-- Effect: deactivates every variant whose parent product is
-- currently inactive. Cosmetic for new mutations going forward
-- (R60-A3 already cascades), but retroactive fix for anything
-- soft-deleted pre-R60.

BEGIN;

UPDATE product_variants pv
   SET is_active = false,
       updated_at = NOW()
  FROM products p
 WHERE p.id = pv.product_id
   AND p.organization_id = pv.organization_id
   AND p.is_active = false
   AND pv.is_active = true;

COMMIT;
