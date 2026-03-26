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
  const existing = cart.items.find(
    (i) => i.productVariantId === item.productVariantId
      && JSON.stringify(i.modifierIds) === JSON.stringify(item.modifierIds),
  );
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
  return {
    ...cart,
    items: cart.items.map((i) => (i.id === lineItemId ? { ...i, overridePrice } : i)),
    updatedAt: new Date().toISOString(),
  };
}

/** Compute effective line discount amount for a single line item. */
function lineDiscountAmount(item: CartLineItem): number {
  if (!item.lineDiscount) return 0;
  const effectivePrice = item.overridePrice ?? item.unitPrice;
  const lineSubtotal = effectivePrice * item.quantity;
  if (item.lineDiscount.mode === 'percent') {
    return Number((lineSubtotal * Math.min(100, item.lineDiscount.value) / 100).toFixed(2));
  }
  return Math.min(item.lineDiscount.value, lineSubtotal);
}

export function computeTotals(cart: Cart): CartTotals {
  let subtotal = 0;
  let modifiersTotal = 0;
  let itemCount = 0;
  let lineDiscountsTotal = 0;

  for (const item of cart.items) {
    const effectivePrice = item.overridePrice ?? item.unitPrice;
    subtotal += effectivePrice * item.quantity;
    modifiersTotal += item.modifierTotal * item.quantity;
    itemCount += item.quantity;
    lineDiscountsTotal += lineDiscountAmount(item);
  }

  // Cart-level discount: fixed amount or percentage of (subtotal + mods - line discounts)
  const afterLineDiscounts = subtotal + modifiersTotal - lineDiscountsTotal;
  let cartDiscount = 0;
  if (cart.discountMode === 'percent') {
    cartDiscount = Number((afterLineDiscounts * Math.min(100, cart.discountAmount) / 100).toFixed(2));
  } else {
    cartDiscount = Math.min(cart.discountAmount, afterLineDiscounts);
  }

  const discountTotal = Number((lineDiscountsTotal + cartDiscount).toFixed(2));
  const taxableAmount = subtotal + modifiersTotal - discountTotal;
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
