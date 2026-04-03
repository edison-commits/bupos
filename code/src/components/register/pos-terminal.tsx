"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { Category, Customer, Employee, GiftCard, InventoryLevel, Location, Product, ProductVariant, PromoCode, RegisterConfiguration, RegisterSessionRecord, ShiftRecord } from "@/lib/domain/types";
import type { Cart, CartTotals, DiscountMode, LineDiscount, TenderLine } from "@/lib/cart/types";
import { createCart, addItem, removeItem, updateQuantity, setDiscount, setDiscountMode, setLineDiscount, setPriceOverride, computeTotals, voidCart } from "@/lib/cart/cart";
import { checkoutAction } from "@/app/register/checkout-action";
import { useOnlineStatus } from "@/lib/offline/use-online-status";
import { savePendingTransaction, cacheCatalog } from "@/lib/offline/idb-store";
import { OfflineStatusBar } from "./offline-status-bar";
import { createCustomerAction } from "@/app/register/actions";
import { logTransactionEvent, type TransactionEventType } from "@/app/register/event-action";
import { ProductGrid, type ProductGridItem } from "./product-grid";
import { CartSidebar } from "./cart-sidebar";
import { TenderPanel, type TenderEntry } from "./tender-panel";
import { ReceiptView } from "./receipt-view";
import { ApprovalModal } from "./approval-modal";
import { VoidReasonModal, type VoidTarget } from "./void-reason-modal";
import { CustomerSearchModal } from "./customer-search-modal";
import { ReturnModal } from "./return-modal";
import { LayawayModal } from "./layaway-modal";
import { PriceOverrideModal } from "./price-override-modal";
import { LineDiscountModal } from "./line-discount-modal";
import { ExchangeModal } from "./exchange-modal";
import { PromoCodeModal } from "./promo-code-modal";
import { useKeyboardShortcuts, KeyboardShortcutsOverlay } from "./keyboard-shortcuts";
import { ThemeToggle } from "./theme-toggle";
import { ProductRecommendations } from "./product-recommendations";
import { processReturnAction } from "@/app/register/return-action";
import { createLayawayAction } from "@/app/register/layaway-action";
import type { ApprovalRequest, ApprovalResult } from "@/app/register/approval-action";
import type { TransactionEventPlaceholder, TransactionTenderPlaceholder } from "@/lib/domain/types";

// Tax rate is now read from location.taxRate (set in Admin > Settings)

interface POSTerminalProps {
  products: Product[];
  variants: ProductVariant[];
  categories: Category[];
  inventory: InventoryLevel[];
  customers: Customer[];
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

type Screen = "selling" | "tender" | "receipt";

interface ReceiptData {
  transactionId: string;
  cart: Cart;
  totals: CartTotals;
  tenders: TenderEntry[];
  changeDue: number;
  timestamp: string;
  loyaltyPointsEarned: number;
  loyaltyPointsRedeemed: number;
}

interface VoidState {
  target: VoidTarget;
  lineItemId?: string;
  itemName?: string;
}

interface HeldCart {
  cart: Cart;
  heldAt: string;
  label: string;
}

export function POSTerminal({
  products,
  variants,
  categories,
  inventory,
  customers,
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
  const [cart, setCart] = useState<Cart>(() => {
    const c = createCart(registerSession.id, employee.id, location.id);
    return { ...c, taxRate: location.taxRate ?? 0.1025 };
  });
  const [screen, setScreen] = useState<Screen>("selling");
  const [processing, setProcessing] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Approval state
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
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
  const [appliedPromo, setAppliedPromo] = useState<{ code: string; discountAmount: number } | null>(null);

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

  // Offline mode
  const { isOnline } = useOnlineStatus();

  const totals = useMemo(() => computeTotals(cart), [cart]);

  // Cache product catalog to IndexedDB for offline use
  useEffect(() => {
    if (typeof window === "undefined" || !("indexedDB" in window)) return;
    cacheCatalog({
      products: products as unknown[],
      variants: variants as unknown[],
      categories: categories as unknown[],
      inventory: inventory as unknown[],
      cachedAt: new Date().toISOString(),
    }).catch(() => { /* indexedDB not available */ });
  }, [products, variants, categories, inventory]);

  // Broadcast cart state to customer-facing display
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const channel = new BroadcastChannel("basicuniformpos_customer_display");
      if (cart.items.length > 0) {
        channel.postMessage({
          type: "cart_update",
          cart,
          appliedPromo: appliedPromo?.code ?? null,
          exchangeCredit: exchangeCredit?.creditAmount ?? null,
        });
      } else {
        channel.postMessage({ type: "cart_clear" });
      }
      channel.close();
    } catch {
      // BroadcastChannel not supported — ignore
    }
  }, [cart, appliedPromo, exchangeCredit]);

  const freshCart = useCallback((): Cart => {
    const c = createCart(registerSession.id, employee.id, location.id);
    return { ...c, taxRate: location.taxRate ?? 0.1025 };
  }, [registerSession.id, employee.id, location.id, location.taxRate]);

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
  const gridItems: ProductGridItem[] = useMemo(() => {
    return products
      .filter((p) => p.isActive)
      .map((product) => {
        const productVariants = variants.filter((v) => v.productId === product.id && v.isActive);
        const productInventory = inventory.filter(
          (inv) => inv.locationId === location.id && productVariants.some((v) => v.id === inv.productVariantId),
        );
        return { product, variants: productVariants, inventory: productInventory, category: categories.find((c) => c.id === product.categoryId) };
      })
      .filter((item) => item.variants.length > 0);
  }, [products, variants, inventory, categories, location.id]);

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
      const next = removeItem(prev, lineItemId);
      logEvent("item_removed", prev.id, { line_item_id: lineItemId, reason_code: reasonCode, note });
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
        details: `Line discount on ${item.productName}: ${discount.mode === "percent" ? `${discount.value}%` : `$${discount.value.toFixed(2)}`}`,
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
    // Apply promo as a cart-level fixed discount
    setCart((prev) => {
      const withDiscount = setDiscount(prev, discountAmount);
      return { ...withDiscount, discountMode: "fixed" as const };
    });
    setAppliedPromo({ code: promo.code, discountAmount });
    setShowPromoModal(false);
    logEvent("discount_applied", cart.id, {
      promo_code: promo.code,
      promo_type: promo.type,
      discount_amount: discountAmount.toFixed(2),
    });
  }, [cart.id, logEvent]);

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
        details: `${item.productName} (${item.variantName}): $${item.unitPrice.toFixed(2)} → $${newPrice.toFixed(2)}`,
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
  }, [freshCart, logEvent]);

  // ─── Hold / Recall ──────────────────────────────────

  const handleHoldCart = useCallback(() => {
    if (cart.items.length === 0) return;
    const label = cart.items.length === 1
      ? cart.items[0].productName
      : `${cart.items.length} items · $${computeTotals(cart).grandTotal.toFixed(2)}`;
    setHeldCarts((prev) => [...prev, { cart: { ...cart }, heldAt: new Date().toISOString(), label }]);
    logEvent("cart_held", cart.id, { item_count: String(cart.items.length) });
    setCart(freshCart());
    setError(null);
  }, [cart, freshCart, logEvent]);

  const handleRecallCart = useCallback((index: number) => {
    const held = heldCarts[index];
    if (!held) return;
    if (cart.items.length > 0) {
      const label = `${cart.items.length} items · $${computeTotals(cart).grandTotal.toFixed(2)}`;
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
    setCart((prev) => ({ ...prev, customerId: undefined, customerName: undefined, taxRate: location.taxRate ?? 0.1025 }));
    setShowCustomerSearch(false);
  }, [location.taxRate]);

  // ─── Returns ──────────────────────────────────────────

  const handleReturnConfirm = useCallback(async (
    transactionId: string,
    items: { productVariantId: string; productName: string; variantName: string; sku: string; unitPrice: number; returnQuantity: number }[],
    refundMethod: "cash" | "card" | "store_credit",
    reason: string,
    note: string,
  ) => {
    setProcessing(true);
    setError(null);
    try {
      const result = await processReturnAction({
        originalTransactionId: transactionId,
        items: items.map((i) => ({ ...i, quantity: i.returnQuantity })),
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
    _returnItems: { productVariantId: string; productName: string; variantName: string; sku: string; unitPrice: number; returnQuantity: number }[],
    returnTotal: number,
    reason: string,
    note: string,
  ) => {
    setProcessing(true);
    setError(null);
    try {
      // Process the return first (refund as store credit internally)
      await processReturnAction({
        originalTransactionId,
        items: _returnItems.map((i) => ({ ...i, quantity: i.returnQuantity })),
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
    // Compute effective cart discount for threshold check
    const cartDiscountEffective = cart.discountMode === 'percent'
      ? Number((totals.subtotal * Math.min(100, cart.discountAmount) / 100).toFixed(2))
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
    const channel = new BroadcastChannel("basicuniformpos_customer_display");
    channel.postMessage({ type: "payment_started" });
    channel.close();
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
    const channel = new BroadcastChannel("basicuniformpos_customer_display");
    channel.postMessage({ type: "payment_started" });
    channel.close();
    setScreen("tender");
  }, [approvalRequest, cart.id, totals.grandTotal, logEvent]);

  const handleApprovalDenied = useCallback(() => {
    setApprovalRequest(null);
    pendingTendersRef.current = null;
  }, []);

  const handleTenderConfirm = useCallback(async (tenders: TenderEntry[]) => {
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
        const offlineId = `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const cashTendered = tenders.filter((t) => t.type === "cash").reduce((s, t) => s + t.amount, 0);
        const changeDue = Math.max(0, cashTendered - totals.grandTotal);

        await savePendingTransaction({
          id: offlineId,
          cart: cart as unknown,
          tenders: tenderLines as unknown[],
          approvedExceptions,
          totals: totals as unknown,
          timestamp: new Date().toISOString(),
          employeeName: employee.displayName,
          attempts: 0,
        });

        setReceipt({
          transactionId: offlineId,
          cart: { ...cart },
          totals: { ...totals },
          tenders,
          changeDue,
          timestamp: new Date().toISOString(),
          loyaltyPointsEarned: 0,
          loyaltyPointsRedeemed: 0,
        });
      }

      // Broadcast receipt to customer display
      const channel = new BroadcastChannel("basicuniformpos_customer_display");
      channel.postMessage({ type: "receipt", totals });
      channel.close();
      setScreen("receipt");
      setApprovedExceptions([]);
    } catch (e) {
      // If online checkout fails due to network error, try offline queue
      if (isOnline) {
        try {
          const offlineId = `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const tenderLines: TenderLine[] = tenders.map((t) => ({ type: t.type, amount: t.amount, ...(t.metadata ? { metadata: t.metadata } : {}) }));
          const cashTendered = tenders.filter((t) => t.type === "cash").reduce((s, t) => s + t.amount, 0);
          const changeDue = Math.max(0, cashTendered - totals.grandTotal);

          await savePendingTransaction({
            id: offlineId,
            cart: cart as unknown,
            tenders: tenderLines as unknown[],
            approvedExceptions,
            totals: totals as unknown,
            timestamp: new Date().toISOString(),
            employeeName: employee.displayName,
            attempts: 0,
          });

          setReceipt({
            transactionId: offlineId,
            cart: { ...cart },
            totals: { ...totals },
            tenders,
            changeDue,
            timestamp: new Date().toISOString(),
            loyaltyPointsEarned: 0,
            loyaltyPointsRedeemed: 0,
          });
          // Broadcast receipt to customer display
          const channelError = new BroadcastChannel("basicuniformpos_customer_display");
          channelError.postMessage({ type: "receipt", totals });
          channelError.close();
          setScreen("receipt");
          setApprovedExceptions([]);
        } catch {
          setError("Checkout failed and offline save failed");
          setScreen("selling");
        }
      } else {
        setError(e instanceof Error ? e.message : "Checkout failed");
        setScreen("selling");
      }
    } finally {
      setProcessing(false);
    }
  }, [cart, totals, approvedExceptions, isOnline, employee.displayName]);

  const handleNewSale = useCallback(() => {
    // Broadcast cart_clear to customer display
    const channel = new BroadcastChannel("basicuniformpos_customer_display");
    channel.postMessage({ type: "cart_clear" });
    channel.close();
    setCart(freshCart());
    setReceipt(null);
    setScreen("selling");
    setError(null);
    setApprovedExceptions([]);
    setExchangeCredit(null);
    setAppliedPromo(null);
  }, [freshCart]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  // ─── Keyboard Shortcuts ───────────────────────────────
  useKeyboardShortcuts({
    onCheckout: screen === "selling" ? handleCheckout : undefined,
    onHoldCart: handleHoldCart,
    onRecallCart: heldCarts.length > 0 ? () => setShowHeldCarts(true) : undefined,
    onCustomerSearch: () => setShowCustomerSearch(true),
    onReturn: () => setShowReturnModal(true),
    onExchange: () => setShowExchangeModal(true),
    onPromo: cart.items.length > 0 ? () => setShowPromoModal(true) : undefined,
    onLayaway: cart.items.length > 0 ? () => setShowLayawayModal(true) : undefined,
    onVoidCart: handleVoidCart,
    onNewSale: screen === "receipt" ? handleNewSale : undefined,
    onPrint: screen === "receipt" ? handlePrint : undefined,
    onToggleShortcuts: () => setShowShortcuts((v) => !v),
    screen,
    shiftOpen: !!activeShift,
  });

  // ─── Render ─────────────────────────────────────────

  const [showMoreActions, setShowMoreActions] = useState(false);

  return (
    <div className="flex h-screen flex-col gap-3 overflow-hidden">
      {/* Offline status bar */}
      <OfflineStatusBar />

      <div className="flex flex-1 flex-col gap-3 lg:flex-row overflow-hidden">
      {/* Left: Product grid + recommendations */}
      <div className="flex flex-1 flex-col gap-2 overflow-hidden lg:flex-[1.2]">
        <div className="flex-1 overflow-hidden rounded-2xl border p-3 shadow-lg sm:p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-panel)' }}>
          <ProductGrid items={gridItems} categories={categories} onAddItem={handleAddItem} />
        </div>
        {screen === "selling" && cart.items.length > 0 && (
          <ProductRecommendations
            currentCartItems={cart.items.map((i) => {
              const v = variants.find((vv) => vv.id === i.productVariantId);
              return { productVariantId: i.productVariantId, productId: v?.productId ?? "", productName: i.productName };
            })}
            transactionEvents={transactionEvents}
            products={products}
            variants={variants}
            inventory={inventory}
            onAddItem={(productId, variantId) => {
              const v = variants.find((vv) => vv.id === variantId);
              const p = products.find((pp) => pp.id === productId);
              if (v && p) handleAddItem(v, p);
            }}
          />
        )}
      </div>

      {/* Right: Cart sidebar + actions */}
      <div className="flex w-full flex-col gap-2 lg:w-[30rem]">
        {/* Compact action bar — primary actions visible, secondary in overflow */}
        <div className="flex items-center gap-2">
          {/* Customer button — always visible */}
          <button
            type="button"
            onClick={() => setShowCustomerSearch(true)}
            className="touch-button flex items-center gap-2 rounded-xl border px-4 py-3 text-base font-medium transition-colors"
            style={{ borderColor: cart.customerId ? 'var(--surface-accent)' : 'var(--border-subtle)', background: cart.customerId ? 'var(--surface-accent)' : 'var(--surface-panel)', color: cart.customerId ? 'white' : 'var(--text-secondary)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span className="max-w-32 truncate">{cart.customerName ?? "Customer"}</span>
            {cart.customerId && customers.find((c) => c.id === cart.customerId)?.taxExempt && (
              <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-bold text-amber-800">TAX EX</span>
            )}
          </button>

          {/* Hold */}
          <button
            type="button"
            onClick={handleHoldCart}
            disabled={cart.items.length === 0}
            className="touch-button rounded-xl border px-4 py-3 text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-panel)', color: 'var(--text-secondary)' }}
          >
            Hold
          </button>

          {/* Recall */}
          {heldCarts.length > 0 && (
            <button
              type="button"
              onClick={() => setShowHeldCarts(true)}
              className="touch-button rounded-xl border border-blue-300 bg-blue-50 px-4 py-3 text-base font-medium text-blue-700 transition-colors hover:bg-blue-100"
            >
              Recall&nbsp;({heldCarts.length})
            </button>
          )}

          {/* Promo badge (when applied) */}
          {appliedPromo && (
            <button
              type="button"
              onClick={() => setShowPromoModal(true)}
              className="touch-button rounded-xl border border-purple-300 bg-purple-50 px-4 py-3 text-base font-medium text-purple-700"
            >
              {appliedPromo.code}
            </button>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* More actions menu */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowMoreActions((v) => !v)}
              className="touch-button flex items-center justify-center rounded-xl border px-4 py-3 text-base font-medium transition-colors"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-panel)', color: 'var(--text-secondary)' }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
            </button>
            {showMoreActions && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMoreActions(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border p-1.5 shadow-xl" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-panel)' }}>
                  <button type="button" onClick={() => { setShowReturnModal(true); setShowMoreActions(false); }} className="flex w-full items-center gap-3 rounded-lg px-4 py-3.5 text-left text-base font-medium transition-colors hover:bg-amber-50 hover:text-amber-700" style={{ color: 'var(--text-primary)' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                    Return
                  </button>
                  <button type="button" onClick={() => { setShowExchangeModal(true); setShowMoreActions(false); }} className="flex w-full items-center gap-3 rounded-lg px-4 py-3.5 text-left text-base font-medium transition-colors hover:bg-teal-50 hover:text-teal-700" style={{ color: 'var(--text-primary)' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                    Exchange
                  </button>
                  <button type="button" disabled={cart.items.length === 0} onClick={() => { setShowLayawayModal(true); setShowMoreActions(false); }} className="flex w-full items-center gap-3 rounded-lg px-4 py-3.5 text-left text-base font-medium transition-colors hover:bg-indigo-50 hover:text-indigo-700 disabled:opacity-40" style={{ color: 'var(--text-primary)' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
                    Layaway
                  </button>
                  {!appliedPromo && (
                    <button type="button" disabled={cart.items.length === 0} onClick={() => { setShowPromoModal(true); setShowMoreActions(false); }} className="flex w-full items-center gap-3 rounded-lg px-4 py-3.5 text-left text-base font-medium transition-colors hover:bg-purple-50 hover:text-purple-700 disabled:opacity-40" style={{ color: 'var(--text-primary)' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                      Promo Code
                    </button>
                  )}
                  <div className="my-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
                  <button type="button" onClick={() => { setShowShortcuts(true); setShowMoreActions(false); }} className="flex w-full items-center gap-3 rounded-lg px-4 py-3.5 text-left text-base font-medium transition-colors" style={{ color: 'var(--text-secondary)' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></svg>
                    Keyboard Shortcuts
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Exchange credit banner */}
        {exchangeCredit && (
          <div className="rounded-xl border border-teal-300 bg-teal-50 px-4 py-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">Exchange mode</p>
                <p className="text-sm text-teal-600">
                  ${exchangeCredit.creditAmount.toFixed(2)} credit applied from return #{exchangeCredit.originalTxnId.slice(0, 8)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setExchangeCredit(null);
                  setCart((prev) => setDiscount(prev, 0));
                }}
                className="rounded-lg px-2 py-1 text-xs font-medium text-teal-600 hover:bg-teal-100"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        <CartSidebar
          cart={cart}
          totals={totals}
          onUpdateQuantity={handleUpdateQuantity}
          onRemoveItem={handleRemoveItem}
          onSetDiscount={handleSetDiscount}
          onSetDiscountMode={handleSetDiscountMode}
          onPriceOverride={handlePriceOverrideRequest}
          onLineDiscount={handleLineDiscountRequest}
          onCheckout={handleCheckout}
          onVoidCart={handleVoidCart}
          shiftOpen={!!activeShift}
        />
      </div>

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl bg-red-700 px-6 py-3 text-sm font-semibold text-white shadow-lg">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-3 underline">Dismiss</button>
        </div>
      )}

      {/* Return result */}
      {returnResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
            <div className="rounded-t-2xl bg-amber-600 px-5 py-4 text-center text-white">
              <p className="text-2xl font-bold">Return processed</p>
              <p className="mt-1 text-lg">Refund: ${returnResult.total.toFixed(2)}</p>
            </div>
            <div className="px-5 py-4 text-center text-sm text-zinc-600">
              <p>Refunded via <span className="font-semibold capitalize">{returnResult.method === "store_credit" ? "store credit" : returnResult.method}</span></p>
              <p className="mt-1 font-mono text-xs text-zinc-400">Return #{returnResult.id.slice(0, 8)}</p>
            </div>
            <div className="border-t border-zinc-100 px-5 py-4">
              <button
                type="button"
                onClick={() => setReturnResult(null)}
                className="touch-button w-full rounded-xl bg-zinc-900 text-sm font-semibold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Return modal */}
      {showReturnModal && (
        <ReturnModal
          transactionEvents={transactionEvents}
          transactionTenders={transactionTenders}
          onConfirm={handleReturnConfirm}
          onCancel={() => setShowReturnModal(false)}
        />
      )}

      {/* Promo code modal */}
      {showPromoModal && (
        <PromoCodeModal
          promoCodes={promoCodes}
          cartSubtotal={totals.subtotal + totals.modifiersTotal}
          onApply={handlePromoApply}
          onCancel={() => setShowPromoModal(false)}
        />
      )}

      {/* Exchange modal */}
      {showExchangeModal && (
        <ExchangeModal
          transactionEvents={transactionEvents}
          transactionTenders={transactionTenders}
          onConfirm={handleExchangeConfirm}
          onCancel={() => setShowExchangeModal(false)}
        />
      )}

      {/* Layaway modal */}
      {showLayawayModal && (
        <LayawayModal
          totals={totals}
          customerName={cart.customerName}
          onConfirm={handleLayawayConfirm}
          onCancel={() => setShowLayawayModal(false)}
          processing={processing}
        />
      )}

      {/* Layaway result */}
      {layawayResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
            <div className="rounded-t-2xl bg-indigo-600 px-5 py-4 text-center text-white">
              <p className="text-2xl font-bold">Layaway created</p>
              <p className="mt-1 text-lg">Deposit: ${layawayResult.deposit.toFixed(2)}</p>
            </div>
            <div className="px-5 py-4 text-center text-sm text-zinc-600">
              <p>Balance due: <span className="font-semibold">${layawayResult.balance.toFixed(2)}</span></p>
              <p className="mt-1 font-mono text-xs text-zinc-400">Layaway #{layawayResult.id.slice(0, 8)}</p>
            </div>
            <div className="border-t border-zinc-100 px-5 py-4">
              <button
                type="button"
                onClick={() => setLayawayResult(null)}
                className="touch-button w-full rounded-xl bg-zinc-900 text-sm font-semibold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Customer search modal */}
      {showCustomerSearch && (
        <CustomerSearchModal
          customers={customers}
          currentCustomerId={cart.customerId}
          transactionEvents={transactionEvents}
          transactionTenders={transactionTenders}
          onSelect={handleAttachCustomer}
          onClear={handleClearCustomer}
          onCancel={() => setShowCustomerSearch(false)}
          onCreateCustomer={async (data) => {
            const customer = await createCustomerAction(data);
            return customer;
          }}
        />
      )}

      {/* Price override modal */}
      {priceOverrideLineId && !approvalRequest && (() => {
        const item = cart.items.find((i) => i.id === priceOverrideLineId);
        if (!item) return null;
        return (
          <PriceOverrideModal
            lineItemId={item.id}
            productName={item.productName}
            variantName={item.variantName}
            currentPrice={item.unitPrice}
            overridePrice={item.overridePrice}
            onConfirm={handlePriceOverrideConfirm}
            onClear={handlePriceOverrideClear}
            onCancel={() => setPriceOverrideLineId(null)}
          />
        );
      })()}

      {/* Line discount modal */}
      {lineDiscountLineId && (() => {
        const item = cart.items.find((i) => i.id === lineDiscountLineId);
        if (!item) return null;
        const effectivePrice = item.overridePrice ?? item.unitPrice;
        return (
          <LineDiscountModal
            lineItemId={item.id}
            productName={item.productName}
            variantName={item.variantName}
            lineSubtotal={effectivePrice * item.quantity}
            currentDiscount={item.lineDiscount}
            onConfirm={handleLineDiscountConfirm}
            onClear={handleLineDiscountClear}
            onCancel={() => setLineDiscountLineId(null)}
          />
        );
      })()}

      {/* Void reason modal */}
      {voidState && (
        <VoidReasonModal
          target={voidState.target}
          itemName={voidState.itemName}
          onConfirm={(reasonCode, note) => {
            if (voidState.target === "cart") {
              handleVoidCartConfirmed(reasonCode, note);
            } else if (voidState.lineItemId) {
              handleRemoveItemConfirmed(voidState.lineItemId, reasonCode, note);
            }
          }}
          onCancel={() => setVoidState(null)}
        />
      )}

      {/* Manager approval modal */}
      {approvalRequest && (
        <ApprovalModal
          request={approvalRequest}
          onApproved={handleApprovalResult}
          onDenied={handleApprovalDenied}
        />
      )}

      {/* Held carts overlay */}
      {showHeldCarts && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
              <h2 className="text-lg font-bold">Held carts</h2>
              <button type="button" onClick={() => setShowHeldCarts(false)} className="touch-button rounded-xl bg-zinc-100 px-3 text-sm font-semibold text-zinc-600 hover:bg-zinc-200">Close</button>
            </div>
            <div className="max-h-[50vh] overflow-y-auto p-4">
              {heldCarts.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-400">No held carts.</p>
              ) : (
                <div className="space-y-2">
                  {heldCarts.map((held, i) => (
                    <button
                      key={held.cart.id}
                      type="button"
                      onClick={() => handleRecallCart(i)}
                      className="touch-button w-full rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-left hover:bg-blue-50 active:bg-blue-100"
                    >
                      <p className="font-semibold">{held.label}</p>
                      <p className="text-xs text-zinc-500">Held {new Date(held.heldAt).toLocaleTimeString()}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tender panel overlay */}
      {screen === "tender" && (
        <TenderPanel
          totals={totals}
          supportedTenders={registerConfig.supportedTenders}
          approvalThresholds={registerConfig.approvalThresholds}
          discountAmount={cart.discountAmount}
          onConfirm={handleTenderConfirm}
          onCancel={() => setScreen("selling")}
          processing={processing}
          customerLoyaltyPoints={cart.customerId ? customers.find((c) => c.id === cart.customerId)?.loyaltyPoints : undefined}
          loyaltyConfig={registerConfig.loyalty}
          customerStoreCreditBalance={cart.customerId ? customers.find((c) => c.id === cart.customerId)?.storeCreditBalance : undefined}
          giftCards={giftCards}
        />
      )}

      {/* Receipt overlay */}
      {screen === "receipt" && receipt && (
        <ReceiptView
          transactionId={receipt.transactionId}
          cart={receipt.cart}
          totals={receipt.totals}
          tenders={receipt.tenders}
          changeDue={receipt.changeDue}
          cashierName={employee.displayName}
          locationName={location.name}
          timestamp={receipt.timestamp}
          onNewSale={handleNewSale}
          onPrint={handlePrint}
          noReceiptEnabled={registerConfig.noReceiptEnabled}
          loyaltyPointsEarned={receipt.loyaltyPointsEarned}
          loyaltyPointsRedeemed={receipt.loyaltyPointsRedeemed}
          storeName={storeName}
          receiptHeader={receiptHeader}
          receiptFooter={receiptFooter}
        />
      )}

      {/* Theme toggle (floating) */}
      <div className="fixed bottom-4 left-4 z-30">
        <ThemeToggle />
      </div>

      {/* Keyboard shortcuts overlay */}
      <KeyboardShortcutsOverlay isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
      </div>
    </div>
  );
}
