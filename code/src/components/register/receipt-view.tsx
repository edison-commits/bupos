/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, memo } from "react";
import type { Cart, CartTotals } from "@/lib/cart/types";
import type { TenderEntry } from "./tender-panel";
import { formatReceipt, type ReceiptData } from "@/lib/receipt/format-receipt";

interface ReceiptViewProps {
  transactionId: string;
  cart: Cart;
  totals: CartTotals;
  tenders: TenderEntry[];
  changeDue: number;
  cashierName: string;
  locationName: string;
  timestamp: string;
  onNewSale: () => void;
  onPrint: () => void;
  noReceiptEnabled: boolean;
  loyaltyPointsEarned?: number;
  loyaltyPointsRedeemed?: number;
  storeName?: string;
  receiptHeader?: string;
  receiptFooter?: string;
}

export function ReceiptView({
  transactionId,
  cart,
  totals,
  tenders,
  changeDue,
  cashierName,
  locationName,
  timestamp,
  onNewSale,
  onPrint,
  noReceiptEnabled,
  loyaltyPointsEarned,
  loyaltyPointsRedeemed,
  storeName,
  receiptHeader,
  receiptFooter,
}: ReceiptViewProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" id="receipt-modal">
      <style>{`
        @keyframes checkmark-bounce {
          0% {
            transform: scale(0);
            opacity: 0;
          }
          50% {
            transform: scale(1.15);
          }
          100% {
            transform: scale(1);
            opacity: 1;
          }
        }

        @keyframes checkmark-draw {
          0% {
            stroke-dashoffset: 50;
          }
          100% {
            stroke-dashoffset: 0;
          }
        }

        .checkmark-container {
          animation: checkmark-bounce 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .checkmark-path {
          animation: checkmark-draw 0.4s ease-in-out 0.2s forwards;
          stroke-dasharray: 50;
          stroke-dashoffset: 50;
        }
      `}</style>
      
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-hidden">
        {/* Success animation and completion banner */}
        <div className="bg-gradient-to-b from-teal-50 to-white px-5 py-6 text-center" data-print-hide>
          <div className="flex justify-center mb-4">
            <div className="checkmark-container w-20 h-20 rounded-full bg-teal-100 flex items-center justify-center">
              <svg
                className="w-12 h-12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline
                  points="20 6 9 17 4 12"
                  className="checkmark-path stroke-teal-600"
                  style={{ fill: "none" }}
                />
              </svg>
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900">Sale Complete</p>
          {changeDue > 0 && (
            <div className="mt-3 inline-block rounded-full bg-teal-600 px-4 py-2 text-white font-semibold">
              Change: ${changeDue.toFixed(2)}
            </div>
          )}
        </div>

        {/* Receipt body - thermal receipt style */}
        <div className="max-h-[60vh] overflow-y-auto px-5 py-5" id="receipt-content">
          {/* Store header */}
          <div className="border-b border-dashed border-gray-300 pb-4 text-center">
            {receiptHeader && (
              <p className="text-xs text-gray-500 mb-1">{receiptHeader}</p>
            )}
            <p className="text-lg font-bold uppercase tracking-widest text-gray-900">
              {storeName || "STORE"}
            </p>
            <p className="text-sm text-gray-600 mt-1">{locationName}</p>
            <p className="text-xs text-gray-500 mt-1">{formatReceiptDate(timestamp)}</p>
            <p className="text-xs text-gray-500 mt-1">Cashier: {cashierName}</p>
            {cart.customerName && (
              <p className="text-xs text-gray-500">Customer: {cart.customerName}</p>
            )}
          </div>

          {/* Items */}
          <div className="border-b border-dashed border-gray-300 py-4">
            {cart.items.map((item) => {
              const lineTotal = (item.unitPrice + item.modifierTotal) * item.quantity;
              return (
                <div key={item.id} className="flex justify-between py-1 text-base text-gray-900">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{item.quantity}x {item.productName}</span>
                    {item.variantName !== item.productName && (
                      <span className="text-xs text-gray-600 block">({item.variantName})</span>
                    )}
                  </div>
                  <span className="shrink-0 pl-3 font-semibold">${lineTotal.toFixed(2)}</span>
                </div>
              );
            })}
          </div>

          {/* Totals section */}
          <div className="border-b border-dashed border-gray-300 py-4 space-y-2">
            <ReceiptRow
              label="Subtotal"
              value={totals.subtotal + totals.modifiersTotal}
              size="base"
            />
            {totals.discountTotal > 0 && (
              <ReceiptRow
                label="Discount"
                value={-totals.discountTotal}
                size="base"
              />
            )}
            {totals.taxTotal === 0 && cart.customerName ? (
              <p className="font-semibold text-amber-700 text-base">TAX EXEMPT</p>
            ) : (
              <ReceiptRow label="Tax" value={totals.taxTotal} size="base" />
            )}
            <div className="flex justify-between pt-2 border-t border-dashed border-gray-300">
              <span className="text-xl font-bold text-gray-900">Total</span>
              <span className="text-xl font-bold text-gray-900">
                ${totals.grandTotal.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Tender breakdown */}
          <div className="border-b border-dashed border-gray-300 py-4 space-y-1">
            {tenders.map((t, i) => (
              <ReceiptRow
                key={`${t.type}-${i}`}
                label={formatTenderLabel(t.type)}
                value={t.amount}
                size="base"
              />
            ))}
            {changeDue > 0 && (
              <ReceiptRow label="Change" value={changeDue} bold size="base" />
            )}
          </div>

          {/* Loyalty section */}
          {loyaltyPointsEarned || loyaltyPointsRedeemed ? (
            <div className="border-b border-dashed border-gray-300 py-4 space-y-1">
              {loyaltyPointsRedeemed && (
                <ReceiptRow
                  label="Points redeemed"
                  value={-loyaltyPointsRedeemed}
                  size="base"
                />
              )}
              {loyaltyPointsEarned && (
                <ReceiptRow
                  label="Points earned"
                  value={loyaltyPointsEarned}
                  size="base"
                />
              )}
            </div>
          ) : null}

          {/* Transaction ID and footer */}
          <div className="py-4 text-center space-y-2">
            {transactionId.startsWith("offline-") && (
              <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 border border-amber-300 px-3 py-1 text-xs font-bold text-amber-800 mb-1">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                OFFLINE — will sync when online
              </div>
            )}
            <p className="font-mono text-sm text-gray-600">
              TXN {transactionId.slice(0, 8).toUpperCase()}
            </p>
            <p className="text-xs text-gray-500">
              {receiptFooter || "Thank you for shopping with us!"}
            </p>
          </div>
        </div>

        {/* Actions section */}
        <div className="border-t border-gray-200 p-5 space-y-4" data-print-hide>
          {/* Thermal Print - primary action, full width on its own row */}
          <ThermalPrintButton
            transactionId={transactionId}
            cart={cart}
            totals={totals}
            tenders={tenders}
            changeDue={changeDue}
            cashierName={cashierName}
            locationName={locationName}
            timestamp={timestamp}
            storeName={storeName}
            receiptHeader={receiptHeader}
            receiptFooter={receiptFooter}
            fullWidth
          />

          {/* Email receipt input row */}
          <EmailReceiptRow
            transactionId={transactionId}
            cart={cart}
            totals={totals}
            tenders={tenders}
            changeDue={changeDue}
            cashierName={cashierName}
            locationName={locationName}
            timestamp={timestamp}
            storeName={storeName}
            receiptFooter={receiptFooter}
          />

          {/* No Receipt + New Sale row */}
          <div className="grid grid-cols-2 gap-3">
            {noReceiptEnabled && (
              <button
                type="button"
                onClick={onNewSale}
                className="flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-3 text-base font-bold text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors"
              >
                No Receipt
              </button>
            )}

            <button
              type="button"
              onClick={onNewSale}
              className={`${noReceiptEnabled ? '' : 'col-span-2'} rounded-xl bg-gradient-to-r from-teal-600 to-teal-700 px-4 py-3 text-base font-bold text-white hover:from-teal-700 hover:to-teal-800 transition-all shadow-lg hover:shadow-xl active:shadow-md`}
            >
              New Sale
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const ReceiptRow = memo(function ReceiptRow({
  label,
  value,
  bold,
  size = "base",
}: {
  label: string;
  value: number;
  bold?: boolean;
  size?: "sm" | "base" | "lg";
}) {
  const sizeClass = {
    sm: "text-sm",
    base: "text-base",
    lg: "text-lg",
  }[size];

  return (
    <div className={`flex justify-between ${sizeClass} ${bold ? "font-bold" : "font-medium"} text-gray-900`}>
      <span>{label}</span>
      <span>{value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}</span>
    </div>
  );
});

function formatTenderLabel(type: string): string {
  const map: Record<string, string> = {
    cash: "Cash",
    card: "Card",
    store_credit: "Store Credit",
    loyalty: "Loyalty Points",
    gift_card: "Gift Card",
    split: "Split",
  };
  return map[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function EmailReceiptRow({
  transactionId,
  cart,
  totals,
  tenders,
  changeDue,
  cashierName,
  locationName,
  timestamp,
  storeName,
  receiptFooter,
}: {
  transactionId: string;
  cart: Cart;
  totals: CartTotals;
  tenders: TenderEntry[];
  changeDue: number;
  cashierName: string;
  locationName: string;
  timestamp: string;
  storeName?: string;
  receiptFooter?: string;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function handleSend() {
    if (!email.trim() || !email.includes("@")) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/email-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: email.trim(),
          storeName: storeName || "Store",
          transactionId,
          date: timestamp,
          items: cart.items.map((i) => ({
            name: i.productName,
            qty: i.quantity,
            price: (i.unitPrice + i.modifierTotal) * i.quantity,
          })),
          subtotal: totals.subtotal + totals.modifiersTotal,
          tax: totals.taxTotal,
          total: totals.grandTotal,
          tenders: tenders.map((t) => ({ type: t.type, amount: t.amount })),
          loyaltyEarned: 0,
        }),
      });
      if (res.ok) {
        setStatus("sent");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <p className="rounded-xl bg-teal-50 px-4 py-3 text-center text-sm font-medium text-teal-700">
        Receipt sent to {email}
      </p>
    );
  }

  return (
    <div className="flex gap-3">
      <input
        type="email"
        placeholder="Email receipt to..."
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSend()}
        className="min-w-0 flex-1 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-base placeholder:text-gray-400 text-gray-900 focus:border-teal-400 focus:outline-none focus:ring-2 focus:ring-teal-100 transition-all"
      />
      <button
        type="button"
        onClick={handleSend}
        disabled={status === "sending" || !email.includes("@")}
        className="shrink-0 rounded-2xl bg-gray-800 px-6 py-3 text-base font-bold text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
      >
        {status === "sending" ? "Sending..." : status === "error" ? "Retry" : "Send"}
      </button>
    </div>
  );
}

function ThermalPrintButton({
  transactionId,
  cart,
  totals,
  tenders,
  changeDue,
  cashierName,
  locationName,
  timestamp,
  storeName,
  receiptHeader,
  receiptFooter,
  fullWidth,
}: {
  transactionId: string;
  cart: Cart;
  totals: CartTotals;
  tenders: TenderEntry[];
  changeDue: number;
  cashierName: string;
  locationName: string;
  timestamp: string;
  storeName?: string;
  receiptHeader?: string;
  receiptFooter?: string;
  fullWidth?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "connecting" | "printing" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handlePrint() {
    if (!("serial" in navigator)) {
      setError("Web Serial API not supported");
      setStatus("error");
      return;
    }

    setStatus("connecting");
    setError(null);

    try {
      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: 9600 });

      const writer = port.writable.getWriter();

      // Build receipt data
      const receiptData: ReceiptData = {
        storeName: storeName || "Store",
        locationName,
        cashierName,
        timestamp,
        customerName: cart.customerName,
        taxExempt: totals.taxTotal === 0 && !!cart.customerName,
        items: cart.items,
        subtotal: totals.subtotal + totals.modifiersTotal,
        discountTotal: totals.discountTotal,
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        tenders: tenders.map((t) => ({ type: t.type, amount: t.amount })),
        changeDue,
        transactionId,
        receiptHeader,
        receiptFooter,
      };

      // Format and send
      setStatus("printing");
      const commands = formatReceipt(receiptData);
      await writer.write(commands);

      writer.releaseLock();
      await port.close();

      setStatus("sent");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (e: any) {
      if (e.name !== "NotFoundError") {
        // User didn't cancel
        setError(e.message ?? "Print failed");
        setStatus("error");
      } else {
        setStatus("idle");
      }
    }
  }

  return (
    <button
      type="button"
      onClick={handlePrint}
      disabled={status !== "idle"}
      className={`flex items-center justify-center gap-2 rounded-xl ${
        fullWidth
          ? "w-full bg-gray-900 text-white px-4 py-4 text-lg hover:bg-gray-800 active:bg-black shadow-lg"
          : "border border-gray-200 bg-white text-gray-700 px-3 py-3 text-base hover:bg-gray-50"
      } font-bold disabled:opacity-50 transition-colors`}
      title={error ? error : "Print to thermal printer"}
    >
      <svg
        className={fullWidth ? "w-6 h-6" : "w-5 h-5"}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
      <span>
        {status === "idle" && "Thermal Print"}
        {status === "connecting" && "Connecting…"}
        {status === "printing" && "Printing…"}
        {status === "sent" && "Sent!"}
        {status === "error" && "Error"}
      </span>
    </button>
  );
}

function formatReceiptDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
