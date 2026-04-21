"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { Category, Customer, Employee, GiftCard, InventoryLevel, Location, Product, ProductBundle, ProductVariant, PromoCode, RegisterConfiguration, RegisterSessionRecord, ShiftRecord } from "@/lib/domain/types";
import type { Cart, CartTotals, DiscountMode, LineDiscount, TenderLine } from "@/lib/cart/types";
import { playCheckoutComplete, playVoid, playApprovalNeeded, playError, speakTotal, speakChange } from "@/lib/audio";
import { createCart, addItem, addBundle, addFreeItem, removeItem, updateQuantity, setDiscount, setDiscountMode, setLineDiscount, setPriceOverride, computeTotals, voidCart, lineDiscountAmount } from "@/lib/cart/cart";
import { checkoutAction } from "@/app/register/checkout-action";
import { useOnlineStatus } from "@/lib/offline/use-online-status";
import { savePendingTransaction, cacheCatalog } from "@/lib/offline/idb-store";
import { logTransactionEvent, type TransactionEventType } from "@/app/register/event-action";
import type { ProductGridItem } from "./product-grid";
import type { TenderEntry } from "./tender-panel";
import type { VoidTarget } from "./void-reason-modal";
// keyboard shortcuts moved to pos-terminal.tsx component
import { processReturnAction } from "@/app/register/return-action";
import { createLayawayAction } from "@/app/register/layaway-action";
import type { ApprovalRequest, ApprovalResult } from "@/app/register/approval-action";
import type { TransactionEventPlaceholder, TransactionTenderPlaceholder } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";

// Tax rate is now read from location.taxRate (set in Admin > Settings)

/** Queue an offline transaction and build a receipt object. Extracted to avoid duplication. */
async function queueOfflineAndBuildReceipt(
  cart: Cart, tenderLines: TenderLine[], approvedExceptions: string[],
  totals: CartTotals, tenders: TenderEntry[], employeeName: string,
) {
  const offlineId = `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cashTendered = tenders.filter((t) => t.type === "cash").reduce((s, t) => s + t.amount, 0);
  const changeDue = Math.max(0, cashTendered - totals.grandTotal);
  await savePendingTransaction({
    id: offlineId, cart: cart as unknown, tenders: tenderLines as unknown[],
    approvedExceptions, totals: totals as unknown,
    timestamp: new Date().toISOString(), employeeName, attempts: 0,
  });
  return {
    transactionId: offlineId, cart: { ...cart }, totals: { ...totals }, tenders,
    changeDue, timestamp: new Date().toISOString(),
    loyaltyPointsEarned: 0, loyaltyPointsRedeemed: 0,
  };
}

/**
 * Safe BroadcastChannel helper.
 *
 * Previously opened/closed a channel per postMessage — during barcode bursts
 * that's dozens of allocations per second. Now we lazily init one module-level
 * channel and reuse it. The browser GCs channels when the tab closes, so
 * there's no explicit cleanup needed in an SPA-style POS session.
 */
let _customerDisplayChannel: BroadcastChannel | null = null;
// R34-D10: instead of a permanent-disable flag, back off exponentially
// on transient failures. Prior shape flipped `_customerDisplayInitFailed
// = true` on ANY exception (including one-time DataCloneError on a
// weird payload or a SecurityError during an iframe embed probe) and
// NEVER reset — the display integration was dead for the rest of
// the SPA session. Now: track the last-failure timestamp; if a failed
// try happened recently, skip the attempt; otherwise retry.
let _customerDisplayLastFailureAt = 0;
const _CUSTOMER_DISPLAY_BACKOFF_MS = 60_000;
function broadcastCustomerDisplay(data: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  if (_customerDisplayLastFailureAt > 0 &&
      Date.now() - _customerDisplayLastFailureAt < _CUSTOMER_DISPLAY_BACKOFF_MS) {
    return;
  }
  try {
    if (!_customerDisplayChannel) {
      _customerDisplayChannel = new BroadcastChannel("basicuniformpos_customer_display");
    }
    _customerDisplayChannel.postMessage(data);
    // Success — clear the backoff so the next message tries again.
    _customerDisplayLastFailureAt = 0;
  } catch {
    _customerDisplayLastFailureAt = Date.now();
    try { _customerDisplayChannel?.close(); } catch { /* ignore */ }
    _customerDisplayChannel = null;
  }
}

export interface POSTerminalProps {
  products: Product[];
  variants: ProductVariant[];
  categories: Category[];
  inventory: InventoryLevel[];
  customers: Customer[];
  bundles: ProductBundle[];
  transactionEvents: TransactionEventPlaceholder[];
  transactionTenders: TransactionTenderPlaceholder[];
  employee: Employee;
  location: Location;
  registerSession: RegisterSessionRecord;
  activeShift: ShiftRecord | null;
  registerConfig: RegisterConfiguration;
  giftCards: GiftCard[];
  promoCodes: PromoCode[];
  storeName?: string;
  receiptHeader?: string;
  receiptFooter?: string;
}

export type Screen = "selling" | "tender" | "receipt";

export interface ReceiptData {
  transactionId: string;
  cart: Cart;
  totals: CartTotals;
  tenders: TenderEntry[];
  changeDue: number;
  timestamp: string;
  loyaltyPointsEarned: number;
  loyaltyPointsRedeemed: number;
}

export interface VoidState {
  target: VoidTarget;
  lineItemId?: string;
  itemName?: string;
}

export interface HeldCart {
  cart: Cart;
  heldAt: string;
  label: string;
}

export function usePOSTerminal({
  products,
  variants,
  categories,
  inventory,
  customers,
  bundles,
  transactionEvents,
  transactionTenders,
  employee,
  location,
  registerSession,
  activeShift,
  registerConfig,
  giftCards,
  promoCodes,
  storeName,
  receiptHeader,
  receiptFooter,
}: POSTerminalProps) {
  // Stable device ID for distributed register locking.
  // Prefer the ID stored in the register session (set at login), otherwise
  // read from localStorage or generate a fresh one and persist it.
  const [_deviceId] = useState<string>(() => {
    if (registerSession.deviceId) return registerSession.deviceId;
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("pos_device_id");
      if (stored) return stored;
      const generated = crypto.randomUUID();
      localStorage.setItem("pos_device_id", generated);
      return generated;
    }
    return "";
  });

  const [cart, setCart] = useState<Cart>(() => {
    const c = createCart(registerSession.id, employee.id, location.id);
    return { ...c, taxRate: location.taxRate ?? 0 };
  });
  const [screen, setScreen] = useState<Screen>("selling");
  const [processing, setProcessing] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Speak change due when receipt appears
  useEffect(() => {
    if (receipt && receipt.changeDue > 0) {
      const timer = setTimeout(() => speakChange(receipt.changeDue), 2500);
      return () => clearTimeout(timer);
    }
  }, [receipt]);

  // Approval state
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);

  // Audio: play approval-needed chime when approval is requested
  useEffect(() => {
    if (approvalRequest) playApprovalNeeded();
  }, [approvalRequest]);
  const [approvedExceptions, setApprovedExceptions] = useState<string[]>([]);
  const pendingTendersRef = useRef<TenderEntry[] | null>(null);

  // Void reason state
  const [voidState, setVoidState] = useState<VoidState | null>(null);

  // Price override
  const [priceOverrideLineId, setPriceOverrideLineId] = useState<string | null>(null);

  // Line discount
  const [lineDiscountLineId, setLineDiscountLineId] = useState<string | null>(null);

  // Promo code
  const [showPromoModal, setShowPromoModal] = useState(false);
  // `appliedPromo` tracks the promo for the badge/UI banner. It includes
  // an optional `id` so `appliedPromoIds` below can be derived from a
  // SINGLE source of truth (UI state + cart lines together). Without the
  // id on the state, the dedup guard in PromoCodeModal depends on cart
  // line `promoCodeId` (only populated for free_item) — fragile if a
  // fixed/percent promo ever needs to re-check.
  const [appliedPromo, setAppliedPromo] = useState<
    { code: string; discountAmount: number; id?: string } | null
  >(null);

  // Customer
  const [showCustomerSearch, setShowCustomerSearch] = useState(false);

  // Returns
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [returnResult, setReturnResult] = useState<{ id: string; total: number; method: string } | null>(null);

  // Exchange
  const [showExchangeModal, setShowExchangeModal] = useState(false);
  const [exchangeCredit, setExchangeCredit] = useState<{ originalTxnId: string; creditAmount: number; reason: string } | null>(null);

  // Layaway
  const [showLayawayModal, setShowLayawayModal] = useState(false);
  const [layawayResult, setLayawayResult] = useState<{ id: string; deposit: number; balance: number } | null>(null);

  // Hold / recall
  const [heldCarts, setHeldCarts] = useState<HeldCart[]>([]);
  const [showHeldCarts, setShowHeldCarts] = useState(false);

  // Keyboard shortcuts
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);

  // Offline mode
  const { isOnline } = useOnlineStatus();

  const totals = useMemo(() => computeTotals(cart), [cart]);

  // Cache product catalog to IndexedDB for offline use.
  // Debounced because inventory updates (post-checkout) can fire this many
  // times per second during busy periods — each write is a full IDB transaction.
  useEffect(() => {
    if (typeof window === "undefined" || !("indexedDB" in window)) return;
    const handle = setTimeout(() => {
      cacheCatalog({
        products: products as unknown[],
        variants: variants as unknown[],
        categories: categories as unknown[],
        inventory: inventory as unknown[],
        cachedAt: new Date().toISOString(),
      }).catch(() => { /* indexedDB not available */ });
    }, 2000);
    return () => clearTimeout(handle);
  }, [products, variants, categories, inventory]);

  // Broadcast cart state to customer-facing display
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (cart.items.length > 0) {
      broadcastCustomerDisplay({
        type: "cart_update",
        cart,
        appliedPromo: appliedPromo?.code ?? null,
        exchangeCredit: exchangeCredit?.creditAmount ?? null,
      });
    } else {
      broadcastCustomerDisplay({ type: "cart_clear" });
    }
  }, [cart, appliedPromo, exchangeCredit]);

  const freshCart = useCallback((): Cart => {
    const c = createCart(registerSession.id, employee.id, location.id);
    return { ...c, taxRate: location.taxRate ?? 0 };
  }, [registerSession.id, employee.id, location.id, location.taxRate]);

  // R33-H2: reset cart + approval + receipt state whenever the
  // employee prop changes. Quick-switch (PIN-swap at the register)
  // fires `revalidatePath('/register')` which re-renders the
  // server component with the NEW employee — but client-side
  // `useState` survives that re-render, so Alice's live cart +
  // approved exceptions + receipt stay on screen for Bob. Bob
  // could then confirm tender on a cart Alice built, inheriting
  // discounts she approved. Explicit reset on employee change
  // makes quick-switch feel like a fresh login.
  useEffect(() => {
    if (cart.employeeId && cart.employeeId !== employee.id) {
      setCart(freshCart());
      setApprovedExceptions([]);
      setReceipt(null);
      setError(null);
      setScreen("selling");
    }
    // Intentionally scoped to employee.id change: we don't want to
    // reset on unrelated location.taxRate or registerSession.id
    // changes. `cart.employeeId` is read to compare but we don't
    // want to trigger on every cart mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee.id]);

  const logEvent = useCallback((eventType: TransactionEventType, referenceId: string, payload: Record<string, string>) => {
    logTransactionEvent({
      organizationId: employee.organizationId,
      locationId: location.id,
      employeeId: employee.id,
      registerSessionId: registerSession.id,
      referenceId,
      eventType,
      payload,
    }).catch(() => { /* fire-and-forget for non-critical events */ });
  }, [employee.organizationId, employee.id, location.id, registerSession.id]);

  // Build product grid items
  // Pre-build lookup maps once; then gridItems is O(P) instead of O(P * V * I).
  const variantsByProductId = useMemo(() => {
    const m = new Map<string, ProductVariant[]>();
    for (const v of variants) {
      if (!v.isActive) continue;
      const arr = m.get(v.productId);
      if (arr) arr.push(v);
      else m.set(v.productId, [v]);
    }
    return m;
  }, [variants]);

  const inventoryByVariantId = useMemo(() => {
    const m = new Map<string, InventoryLevel[]>();
    for (const inv of inventory) {
      if (inv.locationId !== location.id) continue;
      const arr = m.get(inv.productVariantId);
      if (arr) arr.push(inv);
      else m.set(inv.productVariantId, [inv]);
    }
    return m;
  }, [inventory, location.id]);

  const categoriesById = useMemo(() => {
    const m = new Map<string, Category>();
    for (const c of categories) m.set(c.id, c);
    return m;
  }, [categories]);

  const gridItems: ProductGridItem[] = useMemo(() => {
    const out: ProductGridItem[] = [];
    for (const product of products) {
      if (!product.isActive) continue;
      const productVariants = variantsByProductId.get(product.id) ?? [];
      if (productVariants.length === 0) continue;
      const productInventory: InventoryLevel[] = [];
      for (const v of productVariants) {
        const invs = inventoryByVariantId.get(v.id);
        if (invs) productInventory.push(...invs);
      }
      out.push({
        product,
        variants: productVariants,
        inventory: productInventory,
        category: categoriesById.get(product.categoryId),
      });
    }
    return out;
  }, [products, variantsByProductId, inventoryByVariantId, categoriesById]);

  // ─── Handlers ────────────────────────────────────────

  const handleAddItem = useCallback((variant: ProductVariant, product: Product) => {
    setError(null);
    setCart((prev) => {
      const next = addItem(prev, {
        productVariantId: variant.id,
        productName: product.name,
        variantName: variant.name,
        sku: variant.sku,
        unitPrice: variant.price,
        quantity: 1,
        modifierIds: [],
        modifierTotal: 0,
      });
      logEvent("item_added", prev.id, { variant_id: variant.id, product_name: product.name, price: variant.price.toFixed(2) });
      return next;
    });
  }, [logEvent]);

  const handleAddBundle = useCallback((bundle: ProductBundle) => {
    setError(null);
    setCart((prev) => {
      const next = addBundle(prev, bundle);
      logEvent("item_added", prev.id, {
        bundle_id: bundle.id,
        bundle_name: bundle.name,
        price: bundle.bundlePrice.toFixed(2),
      });
      return next;
    });
  }, [logEvent]);

  // ── Barcode scanner listener ────────────────────────────────────────
  // USB barcode scanners type characters rapidly then press Enter.
  // We detect sequences typed faster than 80ms/char and ending with Enter.
  useEffect(() => {
    if (screen !== "selling") return;
    let buffer = "";
    let lastKeyTime = 0;
    const CHAR_THRESHOLD_MS = 80;

    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const now = Date.now();
      if (now - lastKeyTime > CHAR_THRESHOLD_MS && buffer.length > 0) buffer = "";
      lastKeyTime = now;

      if (e.key === "Enter" && buffer.length >= 3) {
        e.preventDefault();
        const scanned = buffer.trim();
        buffer = "";
        const scannedLower = scanned.toLowerCase();
        const matchedVariant = variants.find(
          (v) => v.barcode?.toLowerCase() === scannedLower || v.sku.toLowerCase() === scannedLower,
        );
        if (matchedVariant) {
          const matchedProduct = products.find((p) => p.id === matchedVariant.productId);
          if (matchedProduct) handleAddItem(matchedVariant, matchedProduct);
        } else {
          setError(`No product found for barcode/SKU: ${scanned}`);
        }
      } else if (e.key.length === 1) {
        buffer += e.key;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [screen, variants, products, handleAddItem]);

  const handleUpdateQuantity = useCallback((lineItemId: string, qty: number) => {
    setCart((prev) => {
      const next = updateQuantity(prev, lineItemId, qty);
      logEvent("quantity_changed", prev.id, { line_item_id: lineItemId, new_quantity: String(qty) });
      return next;
    });
  }, [logEvent]);

  const handleRemoveItem = useCallback((lineItemId: string) => {
    // Find item name for reason modal
    const item = cart.items.find((i) => i.id === lineItemId);
    setVoidState({ target: "item", lineItemId, itemName: item ? `${item.productName} (${item.variantName})` : undefined });
  }, [cart.items]);

  const handleRemoveItemConfirmed = useCallback((lineItemId: string, reasonCode: string, note: string) => {
    setCart((prev) => {
      const removed = prev.items.find((i) => i.id === lineItemId);
      const next = removeItem(prev, lineItemId);
      logEvent("item_removed", prev.id, { line_item_id: lineItemId, reason_code: reasonCode, note });
      // Clear the applied-promo banner if the removed line was the
      // free-item line backing a free_item promo. Otherwise the PromoCode
      // button stays gated (`!appliedPromo`) and the cashier can't
      // re-apply a different code for the rest of the transaction.
      if (removed?.promoCodeId) {
        setAppliedPromo(null);
      }
      return next;
    });
    setVoidState(null);
  }, [logEvent]);

  const handleSetDiscount = useCallback((amount: number) => {
    setCart((prev) => {
      const next = setDiscount(prev, amount);
      logEvent("discount_applied", prev.id, { discount_amount: amount.toFixed(2), discount_mode: prev.discountMode });
      return next;
    });
  }, [logEvent]);

  const handleSetDiscountMode = useCallback((mode: DiscountMode) => {
    setCart((prev) => setDiscountMode(prev, mode));
  }, []);

  // ─── Line Discount ──────────────────────────────────

  const handleLineDiscountRequest = useCallback((lineItemId: string) => {
    setLineDiscountLineId(lineItemId);
  }, []);

  const handleLineDiscountConfirm = useCallback((lineItemId: string, discount: LineDiscount) => {
    const item = cart.items.find((i) => i.id === lineItemId);
    if (!item) return;

    const effectivePrice = item.overridePrice ?? item.unitPrice;
    const lineSubtotal = effectivePrice * item.quantity;
    const discountAmt = discount.mode === "percent"
      ? Number((lineSubtotal * Math.min(100, discount.value) / 100).toFixed(2))
      : Math.min(discount.value, lineSubtotal);
    const thresholds = registerConfig.approvalThresholds;

    // Check if discount exceeds threshold
    if (discountAmt > thresholds.discountOver && !approvedExceptions.includes("discount_threshold")) {
      setApprovalRequest({
        actionType: "discount_threshold",
        triggerAmount: discountAmt,
        thresholdAmount: thresholds.discountOver,
        cashierEmployeeId: employee.id,
        locationId: location.id,
        organizationId: employee.organizationId,
        details: `Line discount on ${item.productName}: ${discount.mode === "percent" ? `${discount.value}%` : `${formatCurrency(discount.value)}`}`,
      });
      return;
    }

    setCart((prev) => {
      const next = setLineDiscount(prev, lineItemId, discount);
      logEvent("discount_applied", prev.id, {
        line_item_id: lineItemId,
        discount_mode: discount.mode,
        discount_value: String(discount.value),
        discount_reason: discount.reason ?? "",
      });
      return next;
    });
    setLineDiscountLineId(null);
  }, [cart.items, registerConfig.approvalThresholds, approvedExceptions, employee, location, logEvent]);

  const handleLineDiscountClear = useCallback((lineItemId: string) => {
    setCart((prev) => setLineDiscount(prev, lineItemId, undefined));
    setLineDiscountLineId(null);
  }, []);

  // ─── Promo Code ────────────────────────────────────

  const handlePromoApply = useCallback((promo: PromoCode, discountAmount: number) => {
    // free_item promos add a $0 cart line for the configured variant
    // (requires `freeVariantId` set on the promo — DB CHECK enforces
    // this). Every other type applies as a cart-level fixed discount.
    if (promo.type === "free_item") {
      const freeVariantId = promo.freeVariantId;
      const variant = freeVariantId ? variants.find((v) => v.id === freeVariantId) : undefined;
      const product = variant ? products.find((p) => p.id === variant.productId) : undefined;
      if (!variant || !product) {
        setError("Free-item promo is misconfigured: variant not found");
        return;
      }
      setCart((prev) => addFreeItem(prev, {
        id: variant.id,
        name: variant.name,
        sku: variant.sku,
        price: variant.price,
        productName: product.name,
      }, promo.id));
      // Track as "applied" so the UI can show the badge, but with
      // discountAmount = variant.price for receipts / audit. Includes
      // `id` so the modal dedup guard can read a single source of truth.
      setAppliedPromo({ code: promo.code, discountAmount: variant.price, id: promo.id });
      setShowPromoModal(false);
      logEvent("discount_applied", cart.id, {
        promo_code: promo.code,
        promo_type: promo.type,
        free_variant_id: variant.id,
        free_variant_price: variant.price.toFixed(2),
      });
      return;
    }

    // Apply promo as a cart-level fixed discount
    setCart((prev) => {
      const withDiscount = setDiscount(prev, discountAmount);
      return { ...withDiscount, discountMode: "fixed" as const };
    });
    setAppliedPromo({ code: promo.code, discountAmount, id: promo.id });
    setShowPromoModal(false);
    logEvent("discount_applied", cart.id, {
      promo_code: promo.code,
      promo_type: promo.type,
      discount_amount: discountAmount.toFixed(2),
    });
  }, [cart.id, logEvent, variants, products]);

  // ─── Price Override ──────────────────────────────────

  const handlePriceOverrideRequest = useCallback((lineItemId: string) => {
    setPriceOverrideLineId(lineItemId);
  }, []);

  const handlePriceOverrideConfirm = useCallback((lineItemId: string, newPrice: number) => {
    const item = cart.items.find((i) => i.id === lineItemId);
    if (!item) return;

    const overrideAmount = Math.abs(newPrice - item.unitPrice);
    const thresholds = registerConfig.approvalThresholds;

    // Check if override exceeds threshold and needs approval
    if (overrideAmount > thresholds.manualPriceOverrideOver && !approvedExceptions.includes("price_override")) {
      setApprovalRequest({
        actionType: "price_override",
        triggerAmount: overrideAmount,
        thresholdAmount: thresholds.manualPriceOverrideOver,
        cashierEmployeeId: employee.id,
        locationId: location.id,
        organizationId: employee.organizationId,
        details: `${item.productName} (${item.variantName}): ${formatCurrency(item.unitPrice)} → ${formatCurrency(newPrice)}`,
      });
      // Store the pending override to apply after approval
      pendingTendersRef.current = null; // clear any pending tenders
      setPriceOverrideLineId(lineItemId);
      // Store new price in a ref-friendly way — re-apply after approval
      return;
    }

    setCart((prev) => {
      const next = setPriceOverride(prev, lineItemId, newPrice);
      logEvent("item_added", prev.id, { line_item_id: lineItemId, price_override: newPrice.toFixed(2), original_price: item.unitPrice.toFixed(2) });
      return next;
    });
    setPriceOverrideLineId(null);
  }, [cart.items, registerConfig.approvalThresholds, approvedExceptions, employee, location, logEvent]);

  const handlePriceOverrideClear = useCallback((lineItemId: string) => {
    setCart((prev) => setPriceOverride(prev, lineItemId, undefined));
    setPriceOverrideLineId(null);
  }, []);

  const handleVoidCart = useCallback(() => {
    if (cart.items.length === 0) {
      setCart(freshCart());
      return;
    }
    setVoidState({ target: "cart" });
  }, [cart.items.length, freshCart]);

  const handleVoidCartConfirmed = useCallback((reasonCode: string, note: string) => {
    setCart((prev) => {
      voidCart(prev);
      logEvent("cart_voided", prev.id, { reason_code: reasonCode, note, item_count: String(prev.items.length) });
      return freshCart();
    });
    setScreen("selling");
    setError(null);
    setVoidState(null);
    setApprovedExceptions([]);
    playVoid();
  }, [freshCart, logEvent]);

  // ─── Hold / Recall ──────────────────────────────────

  const handleHoldCart = useCallback(() => {
    if (cart.items.length === 0) return;
    const label = cart.items.length === 1
      ? cart.items[0].productName
      : `${cart.items.length} items · ${formatCurrency(computeTotals(cart).grandTotal)}`;
    setHeldCarts((prev) => [...prev, { cart: { ...cart }, heldAt: new Date().toISOString(), label }]);
    logEvent("cart_held", cart.id, { item_count: String(cart.items.length) });
    setCart(freshCart());
    setError(null);
  }, [cart, freshCart, logEvent]);

  const handleRecallCart = useCallback((index: number) => {
    const held = heldCarts[index];
    if (!held) return;
    if (cart.items.length > 0) {
      const label = `${cart.items.length} items · ${formatCurrency(computeTotals(cart).grandTotal)}`;
      setHeldCarts((prev) => [...prev.filter((_, i) => i !== index), { cart: { ...cart }, heldAt: new Date().toISOString(), label }]);
    } else {
      setHeldCarts((prev) => prev.filter((_, i) => i !== index));
    }
    setCart(held.cart);
    logEvent("cart_recalled", held.cart.id, { item_count: String(held.cart.items.length) });
    setShowHeldCarts(false);
  }, [cart, heldCarts, logEvent]);

  // ─── Customer ──────────────────────────────────────

  const handleAttachCustomer = useCallback((customer: Customer) => {
    setCart((prev) => ({
      ...prev,
      customerId: customer.id,
      customerName: `${customer.firstName} ${customer.lastName}`,
      taxRate: customer.taxExempt ? 0 : prev.taxRate,
    }));
    setShowCustomerSearch(false);
  }, []);

  const handleClearCustomer = useCallback(() => {
    setCart((prev) => ({ ...prev, customerId: undefined, customerName: undefined, taxRate: location.taxRate ?? 0 }));
    setShowCustomerSearch(false);
  }, [location.taxRate]);

  // ─── Returns ──────────────────────────────────────────

  const handleReturnConfirm = useCallback(async (
    transactionId: string,
    items: {
      productVariantId: string; productName: string; variantName: string;
      sku: string; unitPrice: number; returnQuantity: number;
      bundleId?: string;
      bundleComponents?: { productVariantId: string; quantity: number }[];
      promoCodeId?: string;
    }[],
    refundMethod: "cash" | "card" | "store_credit",
    reason: string,
    note: string,
  ) => {
    setProcessing(true);
    setError(null);
    try {
      const result = await processReturnAction({
        originalTransactionId: transactionId,
        items: items.map((i) => ({
          productVariantId: i.productVariantId,
          productName: i.productName,
          variantName: i.variantName,
          sku: i.sku,
          unitPrice: i.unitPrice,
          quantity: i.returnQuantity,
          ...(i.bundleId ? { bundleId: i.bundleId } : {}),
          ...(i.bundleComponents ? { bundleComponents: i.bundleComponents } : {}),
          ...(i.promoCodeId ? { promoCodeId: i.promoCodeId } : {}),
        })),
        refundMethod,
        reason,
        note,
      });
      setReturnResult({ id: result.returnTransactionId, total: result.refundTotal, method: result.refundMethod });
      setShowReturnModal(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Return failed");
    } finally {
      setProcessing(false);
    }
  }, []);

  // ─── Exchange ────────────────────────────────────────

  const handleExchangeConfirm = useCallback(async (
    originalTransactionId: string,
    _returnItems: {
      productVariantId: string; productName: string; variantName: string;
      sku: string; unitPrice: number; returnQuantity: number;
      bundleId?: string;
      bundleComponents?: { productVariantId: string; quantity: number }[];
      promoCodeId?: string;
    }[],
    returnTotal: number,
    reason: string,
    note: string,
  ) => {
    setProcessing(true);
    setError(null);
    try {
      // Process the return first (refund as store credit internally).
      // Pass bundle/promo fields through so the server's line-match
      // logic can identify them correctly in the original transaction.
      await processReturnAction({
        originalTransactionId,
        items: _returnItems.map((i) => ({
          productVariantId: i.productVariantId,
          productName: i.productName,
          variantName: i.variantName,
          sku: i.sku,
          unitPrice: i.unitPrice,
          quantity: i.returnQuantity,
          ...(i.bundleId ? { bundleId: i.bundleId } : {}),
          ...(i.bundleComponents ? { bundleComponents: i.bundleComponents } : {}),
          ...(i.promoCodeId ? { promoCodeId: i.promoCodeId } : {}),
        })),
        refundMethod: "store_credit",
        reason,
        note: `Exchange: ${note}`.trim(),
      });

      // Apply the return credit as a fixed cart discount on a fresh cart
      const fresh = freshCart();
      setCart({ ...fresh, discountAmount: returnTotal, discountMode: "fixed" });
      setExchangeCredit({ originalTxnId: originalTransactionId, creditAmount: returnTotal, reason });
      setShowExchangeModal(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Exchange return failed");
    } finally {
      setProcessing(false);
    }
  }, [freshCart]);

  // ─── Layaway ───────────────────────────────────────

  const handleLayawayConfirm = useCallback(async (depositAmount: number, dueDate: string | undefined, notes: string | undefined) => {
    setProcessing(true);
    setError(null);
    try {
      const result = await createLayawayAction(cart, depositAmount, dueDate, notes);
      const t = computeTotals(cart);
      setLayawayResult({ id: result.layawayId, deposit: depositAmount, balance: Number((t.grandTotal - depositAmount).toFixed(2)) });
      setShowLayawayModal(false);
      setCart(freshCart());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Layaway creation failed");
    } finally {
      setProcessing(false);
    }
  }, [cart, freshCart]);

  // ─── Checkout ───────────────────────────────────────

  const handleCheckout = useCallback(() => {
    const thresholds = registerConfig.approvalThresholds;
    // Compute effective cart discount for threshold check.
    //
    // IMPORTANT: percent base must match server logic in
    // checkout-action.ts. Server uses (subtotal + modifiers - lineDiscounts)
    // as the base; this client previously used subtotal only. The mismatch
    // meant a 10% discount on a cart with heavy modifier upcharges
    // quietly passed the client pre-check and then tripped server's
    // threshold redirect mid-checkout — cashier got an unhelpful error
    // with no approval-request affordance in-app.
    const lineDiscountsTotal = cart.items.reduce((s, i) => s + lineDiscountAmount(i), 0);
    const discountBase = Math.max(0, totals.subtotal + totals.modifiersTotal - lineDiscountsTotal);
    const cartDiscountEffective = cart.discountMode === 'percent'
      ? Number((discountBase * Math.min(100, cart.discountAmount) / 100).toFixed(2))
      : cart.discountAmount;
    if (cartDiscountEffective > thresholds.discountOver && !approvedExceptions.includes("discount_threshold")) {
      setApprovalRequest({
        actionType: "discount_threshold",
        triggerAmount: cartDiscountEffective,
        thresholdAmount: thresholds.discountOver,
        cashierEmployeeId: employee.id,
        locationId: location.id,
        organizationId: employee.organizationId,
        details: cart.discountMode === 'percent' ? `${cart.discountAmount}% cart discount` : undefined,
      });
      return;
    }
    logEvent("payment_started", cart.id, { grand_total: totals.grandTotal.toFixed(2) });
    // Broadcast payment_started to customer display
    broadcastCustomerDisplay({ type: "payment_started" });
    setScreen("tender");
    setError(null);
  }, [cart, totals, registerConfig.approvalThresholds, approvedExceptions, employee, location, logEvent]);

  const handleApprovalResult = useCallback((result: ApprovalResult) => {
    if (result.approved && result.exceptionId) {
      setApprovedExceptions((prev) => [...prev, approvalRequest?.actionType ?? ""]);
    }
    setApprovalRequest(null);
    logEvent("payment_started", cart.id, { grand_total: totals.grandTotal.toFixed(2) });
    // Broadcast payment_started to customer display
    broadcastCustomerDisplay({ type: "payment_started" });
    setScreen("tender");
  }, [approvalRequest, cart.id, totals.grandTotal, logEvent]);

  const handleApprovalDenied = useCallback(() => {
    setApprovalRequest(null);
    pendingTendersRef.current = null;
  }, []);

  // R31-H7: ref-based re-entry guard. React state updates are async, so
  // a double-click fires the callback twice BEFORE `processing` reflects
  // the first call's setState. An attacker (or a shaky tap on a POS
  // tablet) thus submits two concurrent checkout requests with no
  // idempotency key, each committing a separate transaction and
  // decrementing inventory twice. The cart.id advisory lock inside
  // checkout-action serializes but doesn't dedupe. A synchronous ref
  // short-circuits before the second call ever hits the server.
  const checkoutInFlightRef = useRef(false);
  const handleTenderConfirm = useCallback(async (tenders: TenderEntry[]) => {
    if (checkoutInFlightRef.current) return;
    checkoutInFlightRef.current = true;
    setProcessing(true);
    setError(null);
    try {
      const tenderLines: TenderLine[] = tenders.map((t) => ({ type: t.type, amount: t.amount, ...(t.metadata ? { metadata: t.metadata } : {}) }));

      if (isOnline) {
        // Online — normal checkout
        const result = await checkoutAction(cart, tenderLines, approvedExceptions);
        setReceipt({
          transactionId: result.transactionId,
          cart: { ...cart },
          totals: { ...totals },
          tenders,
          changeDue: result.changeDue,
          timestamp: new Date().toISOString(),
          loyaltyPointsEarned: result.loyaltyPointsEarned,
          loyaltyPointsRedeemed: result.loyaltyPointsRedeemed,
        });
      } else {
        // Offline — queue transaction for later sync
        const offlineReceipt = await queueOfflineAndBuildReceipt(cart, tenderLines, approvedExceptions, totals, tenders, employee.displayName);
        setReceipt(offlineReceipt);
      }

      // Broadcast receipt to customer display
      broadcastCustomerDisplay({ type: "receipt", totals });
      setScreen("receipt");

      // Audio feedback: chime + spoken total
      playCheckoutComplete();
      speakTotal(totals.grandTotal);
      setApprovedExceptions([]);
    } catch (e) {
      // R33-H1: only fall back to offline queue when the failure was
      // NETWORK-RELATED (fetch rejection, abort, connection error).
      // Prior shape caught EVERY error while `isOnline === true`,
      // including server-side validation failures (threshold
      // exceeded, stock-out, inactive variant, tender-sum mismatch)
      // and silently wrote an "offline receipt" — the customer left
      // with merchandise and a printed receipt while the transaction
      // never committed. Sync service then rejected it at the
      // server's retry path, dead-lettering invisibly.
      //
      // Distinguish by error kind: TypeError / AbortError / no
      // `.message` = probably network. Any Error with a useful
      // message = probably server-side validation → surface to
      // cashier, keep on selling screen, don't queue.
      const isLikelyNetworkError =
        e instanceof TypeError ||
        (e instanceof Error && e.name === "AbortError") ||
        !(e instanceof Error);
      if (isOnline && isLikelyNetworkError) {
        try {
          const tenderLines: TenderLine[] = tenders.map((t) => ({ type: t.type, amount: t.amount, ...(t.metadata ? { metadata: t.metadata } : {}) }));
          const offlineReceipt = await queueOfflineAndBuildReceipt(cart, tenderLines, approvedExceptions, totals, tenders, employee.displayName);
          setReceipt(offlineReceipt);
          // Broadcast receipt to customer display
          broadcastCustomerDisplay({ type: "receipt", totals });
          setScreen("receipt");
          setApprovedExceptions([]);
        } catch {
          setError("Checkout failed and offline save failed");
          setScreen("selling");
          playError();
        }
      } else {
        // Server rejected the checkout (validation, inventory,
        // approval, etc.) — show the real error to the cashier so
        // they can fix the cart BEFORE the customer walks out.
        setError(e instanceof Error ? e.message : "Checkout failed");
        setScreen("selling");
        playError();
      }
    } finally {
      // R31-H7: release the in-flight flag + loading state together.
      checkoutInFlightRef.current = false;
      setProcessing(false);
    }
  }, [cart, totals, approvedExceptions, isOnline, employee.displayName]);

  const handleNewSale = useCallback(() => {
    // Broadcast cart_clear to customer display
    broadcastCustomerDisplay({ type: "cart_clear" });
    setCart(freshCart());
    setReceipt(null);
    setScreen("selling");
    setError(null);
    setApprovedExceptions([]);
    setExchangeCredit(null);
    setAppliedPromo(null);
    // Belt-and-braces: clear any lingering modal/void state so the next
    // interaction (Log out, etc.) can't accidentally resurface the
    // previous cart's void prompt.
    setVoidState(null);
    setPriceOverrideLineId(null);
  }, [freshCart]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  // ─── Render ─────────────────────────────────────────


  return {
    // Props pass-through
    products,
    variants,
    categories,
    inventory,
    customers,
    transactionEvents,
    transactionTenders,
    employee,
    location,
    registerConfig,
    registerSession,
    activeShift,
    giftCards,
    promoCodes,
    storeName,
    receiptHeader,
    receiptFooter,
    // State
    cart,
    setCart,
    screen,
    setScreen,
    processing,
    receipt,
    error,
    setError,
    approvalRequest,
    approvedExceptions,
    voidState,
    setVoidState,
    priceOverrideLineId,
    setPriceOverrideLineId,
    lineDiscountLineId,
    setLineDiscountLineId,
    showPromoModal,
    setShowPromoModal,
    appliedPromo,
    showCustomerSearch,
    setShowCustomerSearch,
    showReturnModal,
    setShowReturnModal,
    returnResult,
    setReturnResult,
    showExchangeModal,
    setShowExchangeModal,
    exchangeCredit,
    setExchangeCredit,
    showLayawayModal,
    setShowLayawayModal,
    layawayResult,
    setLayawayResult,
    heldCarts,
    showHeldCarts,
    setShowHeldCarts,
    showShortcuts,
    setShowShortcuts,
    showMoreActions,
    setShowMoreActions,
    // Computed
    gridItems,
    totals,
    approvalThresholds: registerConfig.approvalThresholds,
    isOnline,
    // Refs
    pendingTendersRef,
    // Data surfaces
    bundles,
    // Handlers
    handleAddItem,
    handleAddBundle,
    handleUpdateQuantity,
    handleRemoveItem,
    handleRemoveItemConfirmed,
    handleSetDiscount,
    handleSetDiscountMode,
    handleLineDiscountRequest,
    handleLineDiscountConfirm,
    handleLineDiscountClear,
    handlePromoApply,
    handlePriceOverrideRequest,
    handlePriceOverrideConfirm,
    handlePriceOverrideClear,
    handleVoidCart,
    handleVoidCartConfirmed,
    handleHoldCart,
    handleRecallCart,
    handleAttachCustomer,
    handleClearCustomer,
    handleReturnConfirm,
    handleExchangeConfirm,
    handleLayawayConfirm,
    handleCheckout,
    handleApprovalResult,
    handleApprovalDenied,
    handleTenderConfirm,
    handleNewSale,
    handlePrint,
  };
}
