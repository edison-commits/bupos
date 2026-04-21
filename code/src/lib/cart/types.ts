import type { EntityId, TenderType } from '@/lib/domain/types';

export type DiscountMode = "fixed" | "percent";

export interface LineDiscount {
  mode: DiscountMode;
  value: number; // dollar amount or percentage (0–100)
  reason?: string;
}

/**
 * A cart line item. Can represent either a single variant or a bundle.
 *
 * ── The bundle sentinel contract ────────────────────────────────────────
 * Bundle lines are distinguished by the presence of `bundleId`. When set:
 *   • `unitPrice` is the `product_bundles.bundle_price` (not the sum of
 *     component prices — the whole point of a bundle is package pricing).
 *   • `productVariantId` is populated with `bundleId` as a sentinel so the
 *     field stays non-null and UUID-shaped. The server NEVER looks this up
 *     in `product_variants` for bundle lines; it validates against
 *     `product_bundles` instead.
 *   • `bundleComponents` is a SNAPSHOT of the component breakdown at the
 *     moment the bundle was added to the cart. Server-side code re-reads
 *     from `bundle_items` (authoritative) at checkout and refund time;
 *     this field is ONLY used as a fallback when the bundle itself has
 *     since been deleted.
 *   • `productName` is the bundle name; `variantName` is usually "Bundle".
 *
 * The productVariantId=bundleId coincidence means the same key works in
 * maps/lookups for both "returned by variant" and "returned by bundle"
 * tallies. Code that builds or reads those maps should call
 * `cartLineLookupKey(line)` (defined in this module) instead of hand-rolling
 * the sentinel check — that keeps the contract visible in one place.
 *
 * For non-bundle lines: `bundleId` and `bundleComponents` are undefined and
 * all existing behavior is preserved.
 */
export interface CartLineItem {
  id: string;
  productVariantId: EntityId;
  productName: string;
  variantName: string;
  sku: string;
  unitPrice: number;
  overridePrice?: number;
  quantity: number;
  modifierIds: EntityId[];
  modifierTotal: number;
  lineDiscount?: LineDiscount;
  /** Set iff this line represents a bundle. */
  bundleId?: EntityId;
  /** Component breakdown — only set when `bundleId` is set. */
  bundleComponents?: { productVariantId: EntityId; quantity: number }[];
  /**
   * Set iff this line is a free-with-purchase redemption backed by a
   * `promo_codes` row of type `free_item`. When set:
   *   • `productVariantId` is a REAL variant (the free item)
   *   • `unitPrice` is the variant's list price (for display / receipts)
   *   • `overridePrice` is 0 (server validates this against promo_codes)
   *   • `quantity` is always 1 — you don't stack free-with-purchase
   * Server-side code in checkout-action / offline-sync re-fetches the
   * promo row, verifies it's active + the variant matches + the cart
   * subtotal (excluding this line) meets minimum_purchase, and inserts
   * a `promo_redemptions` row inside the checkout transaction.
   */
  promoCodeId?: EntityId;
}

export interface CartTotals {
  subtotal: number;
  modifiersTotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  itemCount: number;
}

export interface Cart {
  id: string;
  registerSessionId: EntityId;
  employeeId: EntityId;
  locationId: EntityId;
  customerId?: EntityId;
  customerName?: string;
  items: CartLineItem[];
  discountAmount: number;
  discountMode: DiscountMode;
  taxRate: number;
  status: 'open' | 'checked_out' | 'voided';
  createdAt: string;
  updatedAt: string;
}

/**
 * Compute the canonical lookup key for a cart line. For bundle lines this
 * is the bundleId; for regular lines it's the productVariantId. The two
 * happen to be the same value today (bundle lines set productVariantId =
 * bundleId as a sentinel), but expressing the lookup through this helper
 * decouples callers from that coincidence — if the storage shape ever
 * changes, only this function needs updating.
 */
export function cartLineLookupKey(line: Pick<CartLineItem, "productVariantId" | "bundleId">): string {
  return line.bundleId ?? line.productVariantId;
}

export interface TenderLine {
  type: TenderType;
  amount: number;
  metadata?: Record<string, string>;
}

export interface CheckoutRequest {
  cartId: string;
  tenders: TenderLine[];
}

export interface CheckoutResult {
  transactionId: string;
  cartId: string;
  grandTotal: number;
  tenders: TenderLine[];
  changeDue: number;
  loyaltyPointsEarned: number;
  loyaltyPointsRedeemed: number;
}
