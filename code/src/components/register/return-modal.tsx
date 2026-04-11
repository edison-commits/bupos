"use client";

import { useState, useMemo } from "react";
import type { TenderType } from "@/lib/domain/types";
import type { TransactionEventPlaceholder, TransactionTenderPlaceholder } from "@/lib/domain/types";
import { NumpadInput } from "./numpad-input";

interface ReturnItem {
  productVariantId: string;
  productName: string;
  variantName: string;
  sku: string;
  unitPrice: number;
  maxQuantity: number;
  returnQuantity: number;
}

interface ParsedTransaction {
  transactionId: string;
  timestamp: string;
  grandTotal: number;
  itemCount: number;
  tenderType: string;
  items: ReturnItem[];
}

type RefundMethod = Exclude<TenderType, "loyalty" | "split" | "gift_card">;

interface ReturnModalProps {
  transactionEvents: TransactionEventPlaceholder[];
  transactionTenders: TransactionTenderPlaceholder[];
  onConfirm: (
    transactionId: string,
    items: ReturnItem[],
    refundMethod: RefundMethod,
    reason: string,
    note: string,
  ) => void;
  onCancel: () => void;
}

const RETURN_REASONS = [
  { value: "defective", label: "Defective / damaged" },
  { value: "wrong_size", label: "Wrong size" },
  { value: "wrong_item", label: "Wrong item" },
  { value: "changed_mind", label: "Changed mind" },
  { value: "price_match", label: "Price match" },
  { value: "other", label: "Other" },
];

export function ReturnModal({
  transactionEvents,
  transactionTenders,
  onConfirm,
  onCancel,
}: ReturnModalProps) {
  const [step, setStep] = useState<"search" | "items" | "confirm">("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTxn, setSelectedTxn] = useState<ParsedTransaction | null>(null);
  const [returnItems, setReturnItems] = useState<ReturnItem[]>([]);
  const [refundMethod, setRefundMethod] = useState<RefundMethod>("cash");
  const [reason, setReason] = useState(RETURN_REASONS[0].value);
  const [note, setNote] = useState("");

  // Parse completed transactions from events
  const transactions = useMemo(() => {
    return transactionEvents
      .filter(
        (e) =>
          e.eventKind === "transaction_placeholder" &&
          e.payload?.grand_total &&
          !e.payload?.is_return &&
          e.transactionId !== "txn_register_shift_placeholder",
      )
      .map((e) => {
        // Find the primary tender for this transaction
        const tenders = transactionTenders.filter((t) => t.transactionId === e.transactionId);
        const primaryTender = tenders.length === 1 ? tenders[0].tenderType : "split";

        // Parse items from payload if available
        const items: ReturnItem[] = [];
        // Items aren't stored in event payload — we'd need a cart snapshot.
        // For now, we'll provide a manual entry mode.

        return {
          transactionId: e.transactionId,
          timestamp: e.createdAt,
          grandTotal: Number(e.payload?.grand_total ?? 0),
          itemCount: Number(e.payload?.item_count ?? 0),
          tenderType: primaryTender,
          items,
        } satisfies ParsedTransaction;
      })
      .slice(0, 20);
  }, [transactionEvents, transactionTenders]);

  const filteredTxns = useMemo(() => {
    if (!searchQuery.trim()) return transactions;
    const q = searchQuery.toLowerCase().trim();
    return transactions.filter(
      (t) =>
        t.transactionId.toLowerCase().includes(q) ||
        t.grandTotal.toFixed(2).includes(q),
    );
  }, [transactions, searchQuery]);

  const returnSubtotal = useMemo(
    () =>
      returnItems
        .filter((i) => i.returnQuantity > 0)
        .reduce((sum, i) => sum + i.unitPrice * i.returnQuantity, 0),
    [returnItems],
  );
  const returnTax = Number((returnSubtotal * 0.1025).toFixed(2));
  const returnTotal = Number((returnSubtotal + returnTax).toFixed(2));

  // ── Step 1: Search transactions ─────────────────────────
  if (step === "search") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
          <div className="border-b border-zinc-100 px-5 py-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Process return</h2>
              <button type="button" onClick={onCancel} className="touch-button rounded-xl bg-zinc-100 px-3 text-sm font-semibold text-zinc-600 hover:bg-zinc-200">
                Cancel
              </button>
            </div>
            <p className="mt-1 text-sm text-zinc-500">Select the original transaction to return against.</p>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by transaction ID or amount..."
              className="mt-3 w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm"
              autoFocus
            />
          </div>

          <div className="max-h-[50vh] overflow-y-auto p-4">
            {filteredTxns.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-400">No transactions found</p>
            ) : (
              <div className="space-y-2">
                {filteredTxns.map((txn) => (
                  <button
                    key={txn.transactionId}
                    type="button"
                    onClick={() => {
                      setSelectedTxn(txn);
                      // Initialize return items — since we don't have full cart snapshots
                      // in the JSON store events, provide manual entry
                      setReturnItems([
                        {
                          productVariantId: "manual",
                          productName: "Return item",
                          variantName: "",
                          sku: "",
                          unitPrice: txn.grandTotal / (1 + 0.1025), // Approximate pre-tax
                          maxQuantity: txn.itemCount,
                          returnQuantity: 0,
                        },
                      ]);
                      setStep("items");
                    }}
                    className="touch-button w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-left hover:bg-blue-50 active:bg-blue-100"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-mono text-xs text-zinc-400">{txn.transactionId.slice(0, 8)}...</p>
                        <p className="text-sm font-semibold">${txn.grandTotal.toFixed(2)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-zinc-500">{txn.itemCount} items</p>
                        <p className="text-xs capitalize text-zinc-400">{txn.tenderType}</p>
                        <p className="text-xs text-zinc-400">{new Date(txn.timestamp).toLocaleString()}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Step 2: Select return items and quantities ──────────
  if (step === "items") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
          <div className="border-b border-zinc-100 px-5 py-4">
            <h2 className="text-lg font-bold">Return items</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Transaction {selectedTxn?.transactionId.slice(0, 8)}... · ${selectedTxn?.grandTotal.toFixed(2)}
            </p>
          </div>

          <div className="px-5 py-4 space-y-4">
            <label className="grid gap-1">
              <span className="text-base font-medium text-zinc-600">Refund amount (pre-tax)</span>
              <NumpadInput
                value={returnItems[0]?.unitPrice.toFixed(2) ?? "0.00"}
                onChange={(v) => {
                  const val = Number(v) || 0;
                  setReturnItems((prev) =>
                    prev.map((item, i) => (i === 0 ? { ...item, unitPrice: val, returnQuantity: val > 0 ? 1 : 0 } : item)),
                  );
                }}
                className="rounded-xl border border-zinc-300 px-4 py-3 text-lg font-semibold"
              />
            </label>

            {returnItems[0]?.returnQuantity > 0 && (
              <div className="rounded-xl bg-zinc-50 px-4 py-3 text-sm">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span className="font-semibold">${returnSubtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-500">
                  <span>Tax (10.25%)</span>
                  <span>${returnTax.toFixed(2)}</span>
                </div>
                <div className="mt-1 flex justify-between border-t border-zinc-200 pt-1 font-bold">
                  <span>Refund total</span>
                  <span>${returnTotal.toFixed(2)}</span>
                </div>
              </div>
            )}

            <label className="grid gap-1">
              <span className="text-sm font-medium text-zinc-600">Refund method</span>
              <select
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value as RefundMethod)}
                className="rounded-xl border border-zinc-300 px-4 py-3 text-sm"
              >
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="store_credit">Store credit</option>
              </select>
            </label>

            <label className="grid gap-1">
              <span className="text-sm font-medium text-zinc-600">Reason</span>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="rounded-xl border border-zinc-300 px-4 py-3 text-sm"
              >
                {RETURN_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </label>

            <label className="grid gap-1">
              <span className="text-sm font-medium text-zinc-600">Note (optional)</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Additional details..."
                className="min-h-16 rounded-xl border border-zinc-300 px-4 py-3 text-sm"
              />
            </label>
          </div>

          <div className="flex gap-3 border-t border-zinc-100 px-5 py-4">
            <button type="button" onClick={() => setStep("search")} className="touch-button flex-1 rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-700 hover:bg-zinc-200">
              Back
            </button>
            <button
              type="button"
              disabled={returnTotal <= 0}
              onClick={() => setStep("confirm")}
              className="touch-button flex-1 rounded-xl bg-amber-600 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Review return
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Step 3: Confirm return ──────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-lg font-bold">Confirm return</h2>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Refunding <span className="font-bold">${returnTotal.toFixed(2)}</span> via <span className="font-semibold capitalize">{refundMethod === "store_credit" ? "store credit" : refundMethod}</span>
          </div>

          <div className="text-sm text-zinc-600">
            <p>Original transaction: {selectedTxn?.transactionId.slice(0, 8)}...</p>
            <p>Reason: {RETURN_REASONS.find((r) => r.value === reason)?.label}</p>
            {note && <p>Note: {note}</p>}
          </div>
        </div>

        <div className="flex gap-3 border-t border-zinc-100 px-5 py-4">
          <button type="button" onClick={() => setStep("items")} className="touch-button flex-1 rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-700 hover:bg-zinc-200">
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              if (!selectedTxn) return;
              const items = returnItems.filter((i) => i.returnQuantity > 0);
              onConfirm(selectedTxn.transactionId, items, refundMethod, reason, note);
            }}
            className="touch-button flex-1 rounded-xl bg-red-600 text-sm font-semibold text-white hover:bg-red-700"
          >
            Process return
          </button>
        </div>
      </div>
    </div>
  );
}
