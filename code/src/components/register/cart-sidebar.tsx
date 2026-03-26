"use client";

import type { Cart, CartTotals, DiscountMode } from "@/lib/cart/types";
import { useState, useRef, useCallback } from "react";
import { VirtualNumpad } from "@/components/ui/virtual-numpad";

interface CartSidebarProps {
  cart: Cart;
  totals: CartTotals;
  onUpdateQuantity: (lineItemId: string, quantity: number) => void;
  onRemoveItem: (lineItemId: string) => void;
  onSetDiscount: (amount: number) => void;
  onSetDiscountMode: (mode: DiscountMode) => void;
  onPriceOverride: (lineItemId: string) => void;
  onLineDiscount: (lineItemId: string) => void;
  onCheckout: () => void;
  onVoidCart: () => void;
  shiftOpen: boolean;
}

export function CartSidebar({
  cart,
  totals,
  onUpdateQuantity,
  onRemoveItem,
  onSetDiscount,
  onSetDiscountMode,
  onPriceOverride,
  onLineDiscount,
  onCheckout,
  onVoidCart,
  shiftOpen,
}: CartSidebarProps) {
  const isEmpty = cart.items.length === 0;
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [swipingItemId, setSwipingItemId] = useState<string | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const touchStartX = useRef(0);
  const [showDiscount, setShowDiscount] = useState(false);
  const [showDiscountNumpad, setShowDiscountNumpad] = useState(false);
  const [discountInput, setDiscountInput] = useState("");

  // Swipe-to-delete handlers
  const handleTouchStart = useCallback((e: React.TouchEvent, itemId: string) => {
    touchStartX.current = e.touches[0].clientX;
    setSwipingItemId(itemId);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!swipingItemId) return;
    const dx = touchStartX.current - e.touches[0].clientX;
    setSwipeOffset(Math.max(0, Math.min(dx, 100)));
  }, [swipingItemId]);

  const handleTouchEnd = useCallback(() => {
    if (swipeOffset > 60 && swipingItemId) {
      onRemoveItem(swipingItemId);
    }
    setSwipeOffset(0);
    setSwipingItemId(null);
  }, [swipeOffset, swipingItemId, onRemoveItem]);

  return (
    <div className="flex h-full flex-col rounded-2xl border shadow-lg overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-panel)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-3">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-secondary)' }}>
            <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
          </svg>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Current Sale</h2>
          {!isEmpty && (
            <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-teal-600 px-2 text-sm font-bold text-white">
              {totals.itemCount}
            </span>
          )}
        </div>
        {!isEmpty && (
          <button
            type="button"
            onClick={onVoidCart}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-red-50 hover:text-red-600"
            style={{ color: 'var(--text-secondary)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Void
          </button>
        )}
      </div>

      {/* Line items */}
      <div className="flex-1 overflow-y-auto px-2 py-2" style={{ scrollbarWidth: 'thin' }}>
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 px-6">
            <div className="rounded-2xl p-6" style={{ background: 'var(--surface-panel-muted)' }}>
              <svg className="h-14 w-14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.2} style={{ color: 'var(--text-secondary)', opacity: 0.4 }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-lg font-medium" style={{ color: 'var(--text-secondary)' }}>No items yet</p>
              <p className="mt-1 text-base" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>Tap products or scan a barcode</p>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {cart.items.map((item, index) => {
              const effectivePrice = item.overridePrice ?? item.unitPrice;
              const lineTotal = (effectivePrice + item.modifierTotal) * item.quantity;
              const hasOverride = item.overridePrice != null;
              const isExpanded = expandedItemId === item.id;
              const isSwiping = swipingItemId === item.id;

              return (
                <div
                  key={item.id}
                  className="relative overflow-hidden rounded-xl"
                  onTouchStart={(e) => handleTouchStart(e, item.id)}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                >
                  {/* Red delete background revealed on swipe */}
                  <div className="absolute inset-y-0 right-0 flex w-24 items-center justify-center rounded-r-xl bg-red-500 text-white">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </div>

                  {/* Main item card - slides on swipe */}
                  <div
                    className={`relative rounded-xl border transition-all ${
                      isExpanded
                        ? "border-teal-200 bg-teal-50/50"
                        : hasOverride
                          ? "border-amber-200/60 bg-amber-50/30"
                          : "border-transparent"
                    }`}
                    style={{
                      transform: isSwiping ? `translateX(-${swipeOffset}px)` : 'translateX(0)',
                      transition: isSwiping ? 'none' : 'transform 0.2s ease',
                      background: isExpanded ? undefined : hasOverride ? undefined : 'var(--surface-panel)',
                    }}
                  >
                    {/* Clickable row */}
                    <button
                      type="button"
                      onClick={() => setExpandedItemId(isExpanded ? null : item.id)}
                      className="w-full px-4 py-3.5 text-left"
                    >
                      <div className="flex items-center gap-3">
                        {/* Item number badge */}
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold" style={{ background: 'var(--surface-panel-muted)', color: 'var(--text-secondary)' }}>
                          {index + 1}
                        </div>

                        {/* Quantity + Product info */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 rounded-md bg-teal-100 px-2 py-0.5 text-sm font-bold text-teal-700">
                              ×{item.quantity}
                            </span>
                            <p className="truncate text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{item.productName}</p>
                          </div>
                          <p className="mt-1 truncate text-sm" style={{ color: 'var(--text-secondary)' }}>
                            {item.variantName}
                            {hasOverride && (
                              <span className="ml-1.5 text-amber-600">
                                <span className="line-through">${item.unitPrice.toFixed(2)}</span> → ${item.overridePrice!.toFixed(2)}
                              </span>
                            )}
                            {item.lineDiscount && (
                              <span className="ml-1.5 text-red-500">
                                {item.lineDiscount.mode === "percent" ? `−${item.lineDiscount.value}%` : `−$${item.lineDiscount.value.toFixed(2)}`}
                              </span>
                            )}
                          </p>
                        </div>

                        {/* Line total */}
                        <span className="shrink-0 text-lg font-bold text-teal-700">${lineTotal.toFixed(2)}</span>
                      </div>
                    </button>

                    {/* Expanded section */}
                    {isExpanded && (
                      <div className="px-3 pb-3">
                        {/* Quantity stepper */}
                        <div className="mb-3 flex items-center justify-center gap-2 rounded-xl p-2" style={{ background: 'var(--surface-panel-muted)' }}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              item.quantity <= 1
                                ? onRemoveItem(item.id)
                                : onUpdateQuantity(item.id, item.quantity - 1);
                            }}
                            className="flex h-12 w-14 items-center justify-center rounded-xl bg-white text-2xl font-bold shadow-sm transition-colors hover:bg-zinc-50 active:bg-zinc-100"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            −
                          </button>
                          <span className="w-16 text-center text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{item.quantity}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onUpdateQuantity(item.id, item.quantity + 1);
                            }}
                            className="flex h-12 w-14 items-center justify-center rounded-xl bg-white text-2xl font-bold shadow-sm transition-colors hover:bg-zinc-50 active:bg-zinc-100"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            +
                          </button>
                        </div>

                        {/* Detail rows */}
                        {(hasOverride || item.lineDiscount || item.modifierTotal > 0) && (
                          <div className="mb-3 space-y-1 rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--surface-panel-muted)' }}>
                            <div className="flex justify-between" style={{ color: 'var(--text-secondary)' }}>
                              <span>Unit price</span>
                              <span className="font-medium">${effectivePrice.toFixed(2)}</span>
                            </div>
                            {item.modifierTotal > 0 && (
                              <div className="flex justify-between" style={{ color: 'var(--text-secondary)' }}>
                                <span>Modifiers</span>
                                <span className="font-medium">+${item.modifierTotal.toFixed(2)}</span>
                              </div>
                            )}
                            {item.lineDiscount && (
                              <div className="flex justify-between text-red-600">
                                <span>Discount{item.lineDiscount.reason ? ` (${item.lineDiscount.reason})` : ""}</span>
                                <span className="font-medium">
                                  {item.lineDiscount.mode === "percent"
                                    ? `−${item.lineDiscount.value}%`
                                    : `−$${item.lineDiscount.value.toFixed(2)}`}
                                </span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Action buttons row */}
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onLineDiscount(item.id); }}
                            className="flex flex-col items-center gap-1.5 rounded-xl px-3 py-3 text-sm font-medium transition-colors hover:bg-teal-50"
                            style={{ color: item.lineDiscount ? '#dc2626' : 'var(--text-secondary)' }}
                          >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                            {item.lineDiscount ? "Edit Disc" : "Discount"}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onPriceOverride(item.id); }}
                            className="flex flex-col items-center gap-1.5 rounded-xl px-3 py-3 text-sm font-medium transition-colors hover:bg-amber-50"
                            style={{ color: hasOverride ? '#d97706' : 'var(--text-secondary)' }}
                          >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                            {hasOverride ? "Edit Price" : "Price"}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onRemoveItem(item.id); }}
                            className="flex flex-col items-center gap-1.5 rounded-xl px-3 py-3 text-sm font-medium text-red-500 transition-colors hover:bg-red-50"
                          >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            Remove
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Cart discount toggle + input */}
      {!isEmpty && (
        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button
            type="button"
            onClick={() => setShowDiscount((v) => !v)}
            className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium transition-colors hover:bg-zinc-50/50"
            style={{ color: cart.discountAmount > 0 ? '#dc2626' : 'var(--text-secondary)' }}
          >
            <div className="flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
              {cart.discountAmount > 0
                ? `Cart discount: ${cart.discountMode === "percent" ? `${cart.discountAmount}%` : `$${cart.discountAmount.toFixed(2)}`}`
                : "Add cart discount"}
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${showDiscount ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6"/></svg>
          </button>
          {showDiscount && (
            <div className="flex items-center gap-2 px-5 pb-3">
              <div className="inline-flex items-center rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
                <button
                  type="button"
                  onClick={() => onSetDiscountMode("fixed")}
                  className={`px-3 py-1.5 text-xs font-bold transition-colors ${
                    cart.discountMode === "fixed"
                      ? "bg-teal-600 text-white"
                      : "text-zinc-500 hover:text-zinc-700"
                  }`}
                  style={cart.discountMode !== "fixed" ? { background: 'var(--surface-panel-muted)' } : undefined}
                >
                  $
                </button>
                <button
                  type="button"
                  onClick={() => onSetDiscountMode("percent")}
                  className={`px-3 py-1.5 text-xs font-bold transition-colors ${
                    cart.discountMode === "percent"
                      ? "bg-teal-600 text-white"
                      : "text-zinc-500 hover:text-zinc-700"
                  }`}
                  style={cart.discountMode !== "percent" ? { background: 'var(--surface-panel-muted)' } : undefined}
                >
                  %
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDiscountInput(cart.discountAmount ? String(cart.discountAmount) : "");
                  setShowDiscountNumpad(true);
                }}
                className="w-24 rounded-lg border px-3 py-2 text-right text-base font-medium hover:border-teal-300 transition-colors"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-panel-muted)', color: 'var(--text-primary)' }}
              >
                {cart.discountAmount || (cart.discountMode === "percent" ? "0" : "0.00")}
              </button>
              {cart.discountAmount > 0 && (
                <button
                  type="button"
                  onClick={() => onSetDiscount(0)}
                  className="rounded-lg px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50"
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Totals section */}
      <div className="px-5 py-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <div className="space-y-2">
          <Row label="Subtotal" value={totals.subtotal + totals.modifiersTotal} />
          {totals.discountTotal > 0 && <Row label="Discount" value={-totals.discountTotal} highlight="text-red-500" />}
          <Row label={`Tax (${((cart.taxRate ?? 0) * 100).toFixed(1)}%)`} value={totals.taxTotal} />
        </div>
      </div>

      {/* Grand total + Charge button */}
      <div className="p-4">
        {/* Grand total display */}
        {!isEmpty && (
          <div className="mb-4 flex items-center justify-between px-1">
            <span className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Total</span>
            <span className="text-3xl font-extrabold tracking-tight text-teal-700">${totals.grandTotal.toFixed(2)}</span>
          </div>
        )}

        {/* Big green Charge button — Loyverse signature */}
        <button
          type="button"
          disabled={isEmpty || !shiftOpen}
          onClick={onCheckout}
          className={`touch-button relative w-full overflow-hidden rounded-2xl px-6 py-5 text-xl font-bold tracking-wide transition-all ${
            isEmpty || !shiftOpen
              ? "cursor-not-allowed bg-zinc-200 text-zinc-400"
              : "bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-teal-500/25 hover:from-emerald-600 hover:to-teal-600 hover:shadow-xl hover:shadow-teal-500/30 active:from-emerald-700 active:to-teal-700 active:shadow-md"
          }`}
        >
          {/* Subtle shine effect */}
          {!isEmpty && shiftOpen && (
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          )}
          <span className="relative flex items-center justify-center gap-3">
            {!shiftOpen ? (
              <>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                Open shift first
              </>
            ) : isEmpty ? (
              "Charge"
            ) : (
              <>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                Charge ${totals.grandTotal.toFixed(2)}
              </>
            )}
          </span>
        </button>
      </div>

      {/* Virtual numpad for cart discount */}
      <VirtualNumpad
        visible={showDiscountNumpad}
        value={discountInput}
        onChange={(v) => {
          setDiscountInput(v);
          onSetDiscount(Number(v) || 0);
        }}
        onEnter={() => setShowDiscountNumpad(false)}
        onClose={() => setShowDiscountNumpad(false)}
        label={cart.discountMode === "percent" ? "Discount %" : "Discount $"}
        allowDecimal={cart.discountMode === "fixed"}
      />
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: number; highlight?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: 'var(--text-secondary)' }} className="text-base">{label}</span>
      <span className={`text-base font-semibold ${highlight ?? ""}`} style={highlight ? undefined : { color: 'var(--text-primary)' }}>
        {value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}
      </span>
    </div>
  );
}
