"use client";

import { useState } from "react";
import {
  usePOSTerminal,
  type POSTerminalProps,
  type Screen,
  type ReceiptData,
  type VoidState,
  type HeldCart,
} from "./usePOSTerminal";
import { setDiscount, computeTotals } from "@/lib/cart/cart";
import { createCustomerAction } from "@/app/register/actions";
import { ProductGrid } from "./product-grid";
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
import { AudioToggle } from "./audio-toggle";
import { ProductRecommendations } from "./product-recommendations";

export type { POSTerminalProps, Screen, ReceiptData, VoidState, HeldCart };

export function POSTerminal(props: POSTerminalProps) {
  const {
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
    activeShift,
    giftCards,
    promoCodes,
    storeName,
    receiptHeader,
    receiptFooter,
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
    gridItems,
    totals,
    approvalThresholds,
    isOnline,
    handleAddItem,
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
  } = usePOSTerminal(props);

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

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
      {/* Offline status bar */}

      <div className="flex flex-1 flex-col gap-3 lg:flex-row">
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
            aria-label="Search customer"
            className="touch-button flex items-center gap-2 rounded-xl border px-4 py-3 text-base font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-teal-500"
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
            aria-label="Hold cart"
            className="touch-button rounded-xl border px-4 py-3 text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-teal-500"
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
              aria-label="More actions"
              className="touch-button flex items-center justify-center rounded-xl border px-4 py-3 text-base font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-teal-500"
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

      {/* Theme + Audio toggles (floating) */}
      <div className="fixed bottom-4 left-4 z-30 flex items-center gap-2">
        <ThemeToggle />
        <AudioToggle />
      </div>

      {/* Keyboard shortcuts overlay */}
      <KeyboardShortcutsOverlay isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
      </div>
    </div>
  );
}
