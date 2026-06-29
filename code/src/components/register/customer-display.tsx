"use client";

import { useState, useEffect } from "react";
import type { Cart, CartTotals } from "@/lib/cart/types";
import { formatCurrency } from "@/lib/format";

interface CustomerDisplayProps {
  cart: Cart;
  totals: CartTotals;
  storeName: string;
  customerName?: string;
  appliedPromo?: string | null;
  exchangeCredit?: number | null;
  paymentStatus?: "pending" | "processing";
}

type DisplayMode = "idle" | "active" | "payment" | "receipt";

/**
 * Customer-facing display component.
 * Shows cart updates, totals, and payment status on a second screen
 * during checkout. Displays in a dark theme with teal accents.
 */
export function CustomerDisplay({
  cart,
  totals,
  storeName,
  customerName,
  appliedPromo,
  exchangeCredit,
  paymentStatus = "pending",
}: CustomerDisplayProps) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>("idle");
  const [transactionComplete, setTransactionComplete] = useState(false);

  // Auto-rotate between idle, active, and payment modes
  useEffect(() => {
    if (paymentStatus === "processing" && totals.itemCount > 0) {
      setDisplayMode("payment");
    } else if (totals.itemCount > 0) {
      setDisplayMode("active");
    } else {
      setDisplayMode("idle");
    }
  }, [totals.itemCount, paymentStatus]);

  // Reset transaction complete flag after a few seconds
  useEffect(() => {
    if (transactionComplete) {
      const timer = setTimeout(() => {
        setTransactionComplete(false);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [transactionComplete]);

  return (
    <div className="flex flex-col h-screen w-full bg-slate-950 text-white overflow-hidden">
      {displayMode === "idle" && (
        <IdleScreen storeName={storeName} />
      )}

      {displayMode === "active" && (
        <ActiveCartScreen
          cart={cart}
          totals={totals}
          customerName={customerName}
          appliedPromo={appliedPromo}
          exchangeCredit={exchangeCredit}
        />
      )}

      {displayMode === "payment" && (
        <PaymentScreen totals={totals} />
      )}

      {displayMode === "receipt" && (
        <ReceiptScreen storeName={storeName} totals={totals} />
      )}
    </div>
  );
}

/**
 * Idle screen: shows branding and welcome message
 */
function IdleScreen({ storeName }: { storeName: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 to-slate-950 px-8 text-center">
      <div className="mb-12">
        <div className="text-7xl font-bold text-teal-500 mb-4">
          ◆
        </div>
        <h1 className="text-6xl font-bold text-white mb-4 tracking-tight">
          {storeName}
        </h1>
      </div>

      <div className="max-w-xl">
        <p className="text-4xl text-gray-300 mb-8 font-light">
          Welcome
        </p>
        <p className="text-2xl text-gray-400">
          Ready to checkout
        </p>
      </div>

      <div className="mt-12 flex gap-2 text-teal-500">
        <div className="w-3 h-3 rounded-full animate-pulse"></div>
        <div className="w-3 h-3 rounded-full animate-pulse delay-100"></div>
        <div className="w-3 h-3 rounded-full animate-pulse delay-200"></div>
      </div>
    </div>
  );
}

/**
 * Active cart screen: shows items and running totals
 */
interface ActiveCartScreenProps {
  cart: Cart;
  totals: CartTotals;
  customerName?: string;
  appliedPromo?: string | null;
  exchangeCredit?: number | null;
}

function ActiveCartScreen({
  cart,
  totals,
  customerName,
  appliedPromo,
  exchangeCredit,
}: ActiveCartScreenProps) {
  const formatCurr = (amount: number) => formatCurrency(amount);

  return (
    <div className="flex-1 flex flex-col bg-slate-950 overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-teal-600 to-teal-700 px-8 py-6 shadow-lg">
        <div className="text-3xl font-bold text-white">
          {customerName ? `Customer: ${customerName}` : "Current Order"}
        </div>
      </div>

      {/* Line Items */}
      <div className="flex-1 overflow-y-auto px-8 py-6 space-y-4">
        {cart.items.length === 0 ? (
          <div className="h-full flex items-center justify-center text-gray-400 text-3xl">
            No items yet
          </div>
        ) : (
          cart.items.map((item) => (
            <div
              key={item.id}
              className="flex justify-between items-start bg-slate-800 rounded-lg p-6 border border-slate-700 hover:border-teal-500 transition-colors"
            >
              <div className="flex-1">
                <div className="text-2xl font-semibold text-white mb-2">
                  {item.productName}
                </div>
                <div className="text-lg text-gray-400">
                  {item.variantName && item.variantName !== item.productName && (
                    <span>{item.variantName} • </span>
                  )}
                  <span>SKU: {item.sku}</span>
                </div>
              </div>

              <div className="text-right ml-6">
                <div className="text-2xl font-bold text-teal-400 mb-2">
                  {formatCurr(item.quantity * (item.overridePrice ?? item.unitPrice))}
                </div>
                <div className="text-lg text-gray-400">
                  Qty: {item.quantity} × {formatCurr(item.overridePrice ?? item.unitPrice)}
                </div>
                {item.modifierTotal > 0 && (
                  <div className="text-sm text-teal-300 mt-1">
                    +{formatCurr(item.modifierTotal)} modifiers
                  </div>
                )}
                {item.lineDiscount && (
                  <div className="text-sm text-orange-400 mt-1">
                    -{formatCurr(item.lineDiscount.value)}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Totals Section */}
      <div className="bg-slate-800 border-t border-slate-700 px-8 py-8 space-y-4">
        {/* Promos and credits */}
        <div className="space-y-2 text-lg">
          {appliedPromo && (
            <div className="flex justify-between text-teal-300">
              <span>Promo Applied:</span>
              <span className="font-semibold">{appliedPromo}</span>
            </div>
          )}
          {exchangeCredit != null && exchangeCredit > 0 && (
            <div className="flex justify-between text-teal-300">
              <span>Exchange Credit:</span>
              <span className="font-semibold">{formatCurr(exchangeCredit)}</span>
            </div>
          )}
        </div>

        {/* Main totals */}
        <div className="space-y-3 border-t border-slate-600 pt-6 text-2xl">
          <div className="flex justify-between text-gray-300">
            <span>Subtotal:</span>
            <span>{formatCurr(totals.subtotal)}</span>
          </div>

          {totals.discountTotal > 0 && (
            <div className="flex justify-between text-orange-400">
              <span>Discount:</span>
              <span>-{formatCurr(totals.discountTotal)}</span>
            </div>
          )}

          {totals.modifiersTotal > 0 && (
            <div className="flex justify-between text-gray-300">
              <span>Modifiers:</span>
              <span>+{formatCurr(totals.modifiersTotal)}</span>
            </div>
          )}

          <div className="flex justify-between text-gray-300">
            <span>Tax:</span>
            <span>{formatCurr(totals.taxTotal)}</span>
          </div>

          <div className="flex justify-between text-3xl font-bold text-teal-400 border-t border-slate-600 pt-4">
            <span>Total:</span>
            <span>{formatCurr(totals.grandTotal)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface PaymentScreenProps {
  totals: CartTotals;
}

function PaymentScreen({ totals }: PaymentScreenProps) {
  const formatCurr = (amount: number) => formatCurrency(amount);
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 to-slate-950 px-8 text-center">
      <p className="mb-6 text-2xl font-semibold uppercase tracking-[0.3em] text-teal-300">Payment in progress</p>
      <h2 className="mb-10 text-6xl font-bold text-white">Almost done</h2>
      <div className="w-full max-w-xl rounded-3xl border border-teal-500/40 bg-slate-800 p-12 shadow-2xl shadow-teal-950/40">
        <p className="text-2xl text-gray-300">Amount due</p>
        <p className="mt-4 text-7xl font-black text-teal-400">{formatCurr(totals.grandTotal)}</p>
      </div>
      <p className="mt-10 text-2xl text-gray-400">Please follow the cashier’s instructions.</p>
    </div>
  );
}

/**
 * Receipt screen: thank you message
 */
interface ReceiptScreenProps {
  storeName: string;
  totals: CartTotals;
}

function ReceiptScreen({ storeName, totals }: ReceiptScreenProps) {
  const formatCurr = (amount: number) => formatCurrency(amount);

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-teal-900/30 to-slate-950 px-8 text-center">
      <div className="mb-12">
        <div className="text-8xl mb-8 animate-bounce">
          ✓
        </div>
        <h1 className="text-6xl font-bold text-white mb-4">
          Thank You!
        </h1>
        <p className="text-3xl text-teal-400 font-semibold">
          Transaction Complete
        </p>
      </div>

      <div className="bg-slate-800 rounded-lg p-12 mb-12 max-w-lg w-full">
        <div className="text-4xl font-bold text-teal-400 mb-8">
          {formatCurr(totals.grandTotal)}
        </div>
        <p className="text-2xl text-gray-300">
          Thank you for shopping at {storeName}
        </p>
      </div>

      <p className="text-2xl text-gray-400">
        Please take your receipt
      </p>
    </div>
  );
}
