// Use globalThis.crypto.randomUUID() for cross-runtime compat (Workers, browser, Node)
const randomUUID = (): string => globalThis.crypto.randomUUID();
import type { EntityId } from '@/lib/domain/types';
import type { Cart, CartLineItem, CartTotals, DiscountMode, LineDiscount } from '@/lib/cart/types';

export function createCart(registerSessionId: EntityId, employeeId: EntityId, locationId: EntityId): Cart {
  const ts = new Date().toISOString();
  return {
    id: randomUUID(),
    registerSessionId,
    employeeId,
    locationId,
    items: [],
    discountAmount: 0,
    discountMode: 'fixed',
    taxRate: 0,
    status: 'open',
    createdAt: ts,
    updatedAt: ts,
  };
}

export function addItem(cart: Cart, item: Omit<CartLineItem, 'id'>): Cart {
  if (item.quantity <= 0) return cart; // reject zero/negative quantities — no-op
  // Bundle lines are matched by bundleId so two adds of the same bundle stack.
  // Free-item promo lines are matched by (promoCodeId, variant) so re-applying
  // the same code doesn't stack a second freebie — but each free promo is
  // distinct. Regular lines match on (variantId, modifierIds).
  const existing = cart.items.find((i) => {
    if (item.bundleId && i.bundleId) return i.bundleId === item.bundleId;
    if (item.bundleId || i.bundleId) return false;
    if (item.promoCodeId && i.promoCodeId) {
      return i.promoCodeId === item.promoCodeId && i.productVariantId === item.productVariantId;
    }
    if (item.promoCodeId || i.promoCodeId) return false;
    return i.productVariantId === item.productVariantId
      && JSON.stringify(i.modifierIds) === JSON.stringify(item.modifierIds);
  });
  if (existing) {
    return {
      ...cart,
      items: cart.items.map((i) =>
        i === existing ? { ...i, quantity: i.quantity + item.quantity } : i,
      ),
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...cart,
    items: [...cart.items, { ...item, id: randomUUID() }],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Add a bundle to the cart. Computed fields are filled in by this helper so
 * callers don't hand-roll the sentinel productVariantId or forget the
 * component breakdown.
 */
export function addBundle(
  cart: Cart,
  bundle: {
    id: EntityId;
    name: string;
    slug?: string;
    bundlePrice: number;
    items: { productVariantId: EntityId; quantity: number }[];
  },
): Cart {
  return addItem(cart, {
    // productVariantId is required by the schema. Use the bundle ID as a
    // UUID-shaped sentinel; the server checkout path recognises bundle lines
    // via `bundleId` and never looks this up in product_variants.
    productVariantId: bundle.id,
    productName: bundle.name,
    variantName: 'Bundle',
    // Bracketed prefix makes this a clearly-synthetic SKU — no real SKU in
    // this system starts with '[', so a bundle line's display-only SKU
    // can't ever shadow a variant in scanner / barcode lookups (which key
    // on `product_variants.sku`, never on cart-line sku).
    sku: bundle.slug ? `[Bundle] ${bundle.slug}` : `[Bundle] ${bundle.id.slice(0, 8)}`,
    unitPrice: bundle.bundlePrice,
    quantity: 1,
    modifierIds: [],
    modifierTotal: 0,
    bundleId: bundle.id,
    bundleComponents: bundle.items.map((i) => ({
      productVariantId: i.productVariantId,
      quantity: i.quantity,
    })),
  });
}

export function removeItem(cart: Cart, lineItemId: string): Cart {
  return {
    ...cart,
    items: cart.items.filter((i) => i.id !== lineItemId),
    updatedAt: new Date().toISOString(),
  };
}

export function updateQuantity(cart: Cart, lineItemId: string, quantity: number): Cart {
  if (quantity <= 0) return removeItem(cart, lineItemId);
  return {
    ...cart,
    items: cart.items.map((i) => (i.id === lineItemId ? { ...i, quantity } : i)),
    updatedAt: new Date().toISOString(),
  };
}

export function setDiscount(cart: Cart, discountAmount: number): Cart {
  return { ...cart, discountAmount: Math.max(0, discountAmount), updatedAt: new Date().toISOString() };
}

export function setDiscountMode(cart: Cart, mode: DiscountMode): Cart {
  return { ...cart, discountMode: mode, updatedAt: new Date().toISOString() };
}

export function setLineDiscount(cart: Cart, lineItemId: string, lineDiscount: LineDiscount | undefined): Cart {
  return {
    ...cart,
    items: cart.items.map((i) => (i.id === lineItemId ? { ...i, lineDiscount } : i)),
    updatedAt: new Date().toISOString(),
  };
}

export function setPriceOverride(cart: Cart, lineItemId: string, overridePrice: number | undefined): Cart {
  // R31-M2: clamp overridePrice at 0. Every downstream math path
  // treats `item.overridePrice ?? item.unitPrice` as the EFFECTIVE
  // price; a negative override would inflate grand_total (via the
  // subtotal accumulation) and then inflate the refund path's
  // discountFactor in the same way R30-C4 closed for lineDiscount.
  // Free-item lines ARE permitted at $0 (addFreeItem sets 0 explicitly),
  // but negative values are never legitimate. Keep `undefined` as a
  // valid "clear override" signal.
  const clamped = overridePrice === undefined ? undefined : Math.max(0, overridePrice);
  return {
    ...cart,
    items: cart.items.map((i) => (i.id === lineItemId ? { ...i, overridePrice: clamped } : i)),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Add a free-with-purchase variant as a $0 cart line backed by a
 * promo_codes row of type 'free_item'. Caller is responsible for having
 * validated the promo via GET /api/promo-codes?code=X — this helper just
 * shapes the line. Server validates again at checkout.
 */
export function addFreeItem(
  cart: Cart,
  variant: {
    id: EntityId;
    name: string;
    sku: string;
    price: number;
    productName: string;
  },
  promoCodeId: EntityId,
): Cart {
  // Stack guard: if this promo is already applied, don't add a second
  // freebie. Applied-once semantics are enforced by promo_redemptions
  // uniqueness on (promo_code_id, transaction_id) — reflect that in the
  // cart UI too.
  if (cart.items.some((i) => i.promoCodeId === promoCodeId)) return cart;
  return addItem(cart, {
    productVariantId: variant.id,
    productName: variant.productName,
    variantName: variant.name,
    sku: variant.sku,
    unitPrice: variant.price,
    // Hard-wire the $0 override here so callers can't pass a non-zero
    // value by accident and expect the server to allow it.
    overridePrice: 0,
    quantity: 1,
    modifierIds: [],
    modifierTotal: 0,
    promoCodeId,
  });
}

/** Compute effective line discount amount for a single line item. */
export function lineDiscountAmount(item: CartLineItem): number {
  if (!item.lineDiscount) return 0;
  const effectivePrice = item.overridePrice ?? item.unitPrice;
  const lineSubtotal = effectivePrice * item.quantity;
  // R30-C4: clamp the raw value at 0 so a negative `lineDiscount.value`
  // CANNOT produce a negative discount (which would inflate grand_total
  // and, in the refund path, inflate `discountFactor` above 1.0 —
  // exploitable via `refundMethod='store_credit'` for customer-profit
  // fraud). Mirrors the `cartDiscount` lower-bound clamp below.
  const rawValue = Math.max(0, item.lineDiscount.value);
  if (item.lineDiscount.mode === 'percent') {
    return Number((lineSubtotal * Math.min(100, rawValue) / 100).toFixed(2));
  }
  return Math.min(rawValue, lineSubtotal);
}

export function computeTotals(cart: Cart): CartTotals {
  let subtotal = 0;
  let modifiersTotal = 0;
  let itemCount = 0;
  let lineDiscountsTotal = 0;

  for (const item of cart.items) {
    const effectivePrice = item.overridePrice ?? item.unitPrice;
    // Round each accumulation step to prevent floating-point drift across many items.
    subtotal = Number((subtotal + effectivePrice * item.quantity).toFixed(2));
    modifiersTotal = Number((modifiersTotal + item.modifierTotal * item.quantity).toFixed(2));
    itemCount += item.quantity;
    lineDiscountsTotal = Number((lineDiscountsTotal + lineDiscountAmount(item)).toFixed(2));
  }

  // Cart-level discount: fixed amount or percentage of (subtotal + mods - line discounts)
  const afterLineDiscounts = subtotal + modifiersTotal - lineDiscountsTotal;
  // R30-C4: clamp cart discountAmount at 0 as well. Offline-sync also
  // pushes discountMode/discountAmount directly from the client payload;
  // a tampered value of `-50` would otherwise produce a negative
  // cartDiscount here and inflate the grand_total.
  // R34-D4: also clamp `Infinity` / `NaN` — `Number("Infinity")` is
  // a valid JS number that passes the `|| 0` check and propagates
  // through the multiplication, yielding `Infinity` discounts that
  // bypass threshold checks elsewhere. `Number.isFinite` rejects
  // both Infinity and NaN.
  const rawCartDiscount = Number(cart.discountAmount) || 0;
  const cartDiscountAmount = Number.isFinite(rawCartDiscount)
    ? Math.max(0, rawCartDiscount)
    : 0;
  let cartDiscount = 0;
  if (cart.discountMode === 'percent') {
    cartDiscount = Number((afterLineDiscounts * Math.min(100, cartDiscountAmount) / 100).toFixed(2));
  } else {
    cartDiscount = Math.min(cartDiscountAmount, afterLineDiscounts);
  }

  // Clamp discountTotal to prevent float rounding from pushing grandTotal negative
  const rawDiscountTotal = lineDiscountsTotal + cartDiscount;
  const discountTotal = Number(Math.min(rawDiscountTotal, subtotal + modifiersTotal).toFixed(2));
  const taxableAmount = Math.max(0, subtotal + modifiersTotal - discountTotal);
  const taxTotal = Number((taxableAmount * cart.taxRate).toFixed(2));
  const grandTotal = Number((taxableAmount + taxTotal).toFixed(2));

  return { subtotal, modifiersTotal, discountTotal, taxTotal, grandTotal, itemCount };
}

export function voidCart(cart: Cart): Cart {
  return { ...cart, status: 'voided', updatedAt: new Date().toISOString() };
}

export function checkOutCart(cart: Cart): Cart {
  return { ...cart, status: 'checked_out', updatedAt: new Date().toISOString() };
}
