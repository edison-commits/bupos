"use client";

import { useState, useMemo } from "react";
import type { TransactionEventPlaceholder, TransactionTenderPlaceholder } from "@/lib/domain/types";
import { NumpadInput } from "./numpad-input";

interface ExchangeItem {
  productVariantId: string;
  productName: string;
  variantName: string;
  sku: string;
  unitPrice: number;
  maxQuantity: number;
  returnQuantity: number;
}

const EXCHANGE_REASONS = [
  { value: "wrong_size", label: "Wrong size" },
  { value: "wrong_color", label: "Wrong color" },
  { value: "wrong_item", label: "Wrong item" },
  { value: "defective", label: "Defective / damaged" },
  { value: "customer_preference", label: "Customer preference" },
  { value: "other", label: "Other" },
];

interface ExchangeModalProps {
  transactionEvents: TransactionEventPlaceholder[];
  transactionTenders: TransactionTenderPlaceholder[];
  onConfirm: (
    originalTransactionId: string,
    returnItems: ExchangeItem[],
    returnTotal: number,
    reason: string,
    note: string,
  ) => void;
  onCancel: () => void;
}

export function ExchangeModal({
  transactionEvents,
  transactionTenders,
  onConfirm,
  onCancel,
}: ExchangeModalProps) {
  const [step, setStep] = useState<"search" | "items">("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTxnId, setSelectedTxnId] = useState<string | null>(null);
  const [returnItems, setReturnItems] = useState<ExchangeItem[]>([]);
  const [reason, setReason] = useState(EXCHANGE_REASONS[0].value);
  const [note, setNote] = useState("");

  // Parse completed transactions
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
        const tenders = transactionTenders.filter((t) => t.transactionId === e.transactionId);
        const primaryTender = tenders.length === 1 ? tenders[0].tenderType : "split";
        return {
          transactionId: e.transactionId,
          timestamp: e.createdAt,
          grandTotal: Number(e.payload?.grand_total ?? 0),
          itemCount: Number(e.payload?.item_count ?? 0),
          tenderType: primaryTender,
        };
      })
      .slice(0, 20);
  }, [transactionEvents, transactionTenders]);

  const filteredTxns = useMemo(() => {
    if (!searchQuery.trim()) return transactions;
    const q = searchQuery.toLowerCase().trim();
    return transactions.filter(
      (t) => t.transactionId.toLowerCase().includes(q) || t.grandTotal.toFixed(2).includes(q),
    );
  }, [transactions, searchQuery]);

  const selectedTxn = transactions.find((t) => t.transactionId === selectedTxnId) ?? null;

  const returnSubtotal = useMemo(
    () => returnItems.filter((i) => i.returnQuantity > 0).reduce((sum, i) => sum + i.unitPrice * i.returnQuantity, 0),
    [returnItems],
  );
  const returnTax = Number((returnSubtotal * 0.1025).toFixed(2));
  const returnTotal = Number((returnSubtotal + returnTax).toFixed(2));

  if (step === "search") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
          <div className="border-b border-zinc-100 px-5 py-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">Exchange</h2>
                <p className="text-xs text-teal-600 font-medium">Return items → pick replacements</p>
              </div>
              <button type="button" onClick={onCancel} className="touch-button rounded-xl bg-zinc-100 px-3 text-sm font-semibold text-zinc-600 hover:bg-zinc-200">
                Cancel
              </button>
            </div>
            <p className="mt-2 text-sm text-zinc-500">Select the original transaction.</p>
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
                      setSelectedTxnId(txn.transactionId);
                      setReturnItems([{
                        productVariantId: "manual",
                        productName: "Return item",
                        variantName: "",
                        sku: "",
                        unitPrice: txn.grandTotal / (1 + 0.1025),
                        maxQuantity: txn.itemCount,
                        returnQuantity: 0,
                      }]);
                      setStep("items");
                    }}
                    className="touch-button w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-left hover:bg-teal-50 active:bg-teal-100"
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

  // Step 2: Define return items + reason, then proceed to exchange
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-lg font-bold">Exchange — return value</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Transaction {selectedTxn?.transactionId.slice(0, 8)}... · ${selectedTxn?.grandTotal.toFixed(2)}
          </p>
          <p className="mt-1 text-xs text-teal-600">
            The return credit will be applied as a discount on the replacement items.
          </p>
        </div>

        <div className="px-5 py-4 space-y-4">
          <label className="grid gap-1">
            <span className="text-base font-medium text-zinc-600">Return amount (pre-tax)</span>
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

          {returnTotal > 0 && (
            <div className="rounded-xl bg-teal-50 px-4 py-3 text-sm">
              <div className="flex justify-between">
                <span>Return subtotal</span>
                <span className="font-semibold">${returnSubtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-zinc-500">
                <span>Tax (10.25%)</span>
                <span>${returnTax.toFixed(2)}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-teal-200 pt-1 font-bold text-teal-700">
                <span>Exchange credit</span>
                <span>${returnTotal.toFixed(2)}</span>
              </div>
            </div>
          )}

          <label className="grid gap-1">
            <span className="text-sm font-medium text-zinc-600">Reason</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="rounded-xl border border-zinc-300 px-4 py-3 text-sm"
            >
              {EXCHANGE_REASONS.map((r) => (
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
            disabled={returnTotal <= 0 || !selectedTxn}
            onClick={() => {
              if (!selectedTxn) return;
              const items = returnItems.filter((i) => i.returnQuantity > 0);
              onConfirm(selectedTxn.transactionId, items, returnTotal, reason, note);
            }}
            className="touch-button flex-1 rounded-xl bg-teal-700 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Continue to new items
          </button>
        </div>
      </div>
    </div>
  );
}
