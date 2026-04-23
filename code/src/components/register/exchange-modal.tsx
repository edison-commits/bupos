"use client";

import { useState, useMemo, useEffect } from "react";
import type { TransactionEventPlaceholder, TransactionTenderPlaceholder, Location } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";

interface ExchangeItem {
  productVariantId: string;
  productName: string;
  variantName: string;
  sku: string;
  unitPrice: number;
  maxQuantity: number;
  returnQuantity: number;
  bundleId?: string;
  bundleComponents?: { productVariantId: string; quantity: number }[];
  promoCodeId?: string;
  detail?: string;
}

interface TxnSummary {
  transactionId: string;
  timestamp: string;
  grandTotal: number;
  itemCount: number;
  tenderType: string;
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
  /** Needed so the exchange credit uses the location's tax rate, not a hardcode. */
  location: Location;
  /** Labels for bundle component preview. */
  variantDirectory?: Record<string, { name: string; productName?: string }>;
  onConfirm: (
    originalTransactionId: string,
    returnItems: ExchangeItem[],
    returnTotal: number,
    reason: string,
    note: string,
  ) => void;
  onCancel: () => void;
}

interface CartSnapshotLine {
  productVariantId: string;
  productName?: string;
  variantName?: string;
  sku?: string;
  unitPrice: number;
  overridePrice?: number;
  quantity: number;
  bundleId?: string;
  bundleComponents?: { productVariantId: string; quantity: number }[];
  promoCodeId?: string;
}
interface FetchedTransaction {
  id: string;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  cartSnapshot: { items?: CartSnapshotLine[] } | null;
  alreadyReturnedByVariant: Record<string, number>;
  alreadyReturnedByBundle: Record<string, number>;
}

export function ExchangeModal({
  transactionEvents,
  transactionTenders,
  location,
  variantDirectory = {},
  onConfirm,
  onCancel,
}: ExchangeModalProps) {
  const [step, setStep] = useState<"search" | "items">("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTxn, setSelectedTxn] = useState<TxnSummary | null>(null);
  const [returnItems, setReturnItems] = useState<ExchangeItem[]>([]);
  const [reason, setReason] = useState(EXCHANGE_REASONS[0].value);
  const [note, setNote] = useState("");
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  // R80-FE-M: double-submit guard on Continue button. onConfirm
  // commits the credit stage; rapid double-tap fires twice.
  const [continuing, setContinuing] = useState(false);

  // R80-FE-H2: Esc closes when not mid-submit.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !continuing) onCancel();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel, continuing]);

  // Use ORIGINAL transaction's effective tax rate + discount factor so
  // the exchange credit equals what the customer paid pre-tax + tax at
  // the sale-time rate. Falls back to current location rate, not a
  // hardcoded 10.25%, if the original had a zero subtotal (edge case).
  const [origTaxRate, setOrigTaxRate] = useState(location.taxRate ?? 0);
  const [origDiscountFactor, setOrigDiscountFactor] = useState(1);

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
        } satisfies TxnSummary;
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

  // Load real cart snapshot when a transaction is selected. Same pattern
  // as ReturnModal — previously this modal set `productVariantId: "manual"`
  // which the server rejected because no snapshot line matches that ID
  // (exchange was completely broken for the PG path). Now the server
  // receives real variant/bundle/promo identifiers and the return-action
  // line-matching succeeds.
  useEffect(() => {
    if (!selectedTxn) return;
    let abort = false;
    setLoadingSnapshot(true);
    setSnapshotError(null);
    fetch(`/api/transactions/by-id/${selectedTxn.transactionId}?withCart=1`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as { found: boolean; transaction?: FetchedTransaction };
        if (abort) return;
        if (!body.found || !body.transaction) {
          setSnapshotError("Transaction not found on server");
          return;
        }
        const t = body.transaction;
        if (t.subtotal > 0) {
          setOrigTaxRate(Number((t.taxTotal / t.subtotal).toFixed(6)));
          setOrigDiscountFactor(Math.max(0, 1 - (t.discountTotal ?? 0) / t.subtotal));
        }
        const snapItems = t.cartSnapshot?.items ?? [];
        const items: ExchangeItem[] = snapItems.map((line) => {
          const isBundle = !!line.bundleId;
          const isFreeItem = !!line.promoCodeId;
          const already = isBundle
            ? (t.alreadyReturnedByBundle[line.bundleId!] ?? 0)
            : (t.alreadyReturnedByVariant[line.productVariantId] ?? 0);
          const maxQty = Math.max(0, line.quantity - already);
          let detail: string | undefined;
          if (isBundle && line.bundleComponents && line.bundleComponents.length > 0) {
            detail = line.bundleComponents
              .map((c) => {
                const v = variantDirectory[c.productVariantId];
                const label = v ? `${v.productName ?? ""} ${v.name}`.trim() : c.productVariantId.slice(0, 8);
                return `${label} ×${c.quantity}`;
              })
              .join(", ");
          }
          if (isFreeItem) {
            // Free-item lines contribute $0 to the exchange credit — the
            // customer never paid for this item. They can still exchange it
            // (restocks + reverses the promo redemption), but there's no
            // credit to apply to the new cart.
            detail = "Free-with-purchase — no exchange credit (restocks + reverses promo)";
          }
          return {
            productVariantId: line.productVariantId,
            productName: line.productName ?? (isBundle ? "Bundle" : "Item"),
            variantName: line.variantName ?? (isBundle ? "Bundle" : ""),
            sku: line.sku ?? "",
            unitPrice: isFreeItem ? 0 : line.unitPrice,
            maxQuantity: maxQty,
            returnQuantity: 0,
            bundleId: line.bundleId,
            bundleComponents: line.bundleComponents,
            promoCodeId: line.promoCodeId,
            detail,
          };
        });
        setReturnItems(items);
      })
      .catch((err: unknown) => {
        if (abort) return;
        setSnapshotError(err instanceof Error ? err.message : "Failed to load transaction");
      })
      .finally(() => {
        if (!abort) setLoadingSnapshot(false);
      });
    return () => { abort = true; };
  }, [selectedTxn, variantDirectory]);

  const returnSubtotalRaw = useMemo(
    () =>
      returnItems
        .filter((i) => i.returnQuantity > 0)
        .reduce((sum, i) => sum + i.unitPrice * i.returnQuantity, 0),
    [returnItems],
  );
  const returnSubtotal = Number((returnSubtotalRaw * origDiscountFactor).toFixed(2));
  const returnTax = Number((returnSubtotal * origTaxRate).toFixed(2));
  const returnTotal = Number((returnSubtotal + returnTax).toFixed(2));

  if (step === "search") {
    return (
      <div role="dialog" aria-modal="true" aria-label="Exchange" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
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
                      setSelectedTxn(txn);
                      setStep("items");
                    }}
                    className="touch-button w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-left hover:bg-teal-50 active:bg-teal-100"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-mono text-xs text-zinc-400">{txn.transactionId.slice(0, 8)}...</p>
                        <p className="text-sm font-semibold">{formatCurrency(txn.grandTotal)}</p>
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

  // Step 2: Pick items + qty, show exchange credit total
  const selectedCount = returnItems.filter((i) => i.returnQuantity > 0).length;
  const setItemQty = (idx: number, next: number) => {
    setReturnItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, returnQuantity: Math.max(0, Math.min(it.maxQuantity, next)) } : it)),
    );
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Exchange" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-lg font-bold">Exchange — return value</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Transaction {selectedTxn?.transactionId.slice(0, 8)}... · {formatCurrency(selectedTxn?.grandTotal ?? 0)}
          </p>
          <p className="mt-1 text-xs text-teal-600">
            The return credit will be applied as a discount on the replacement items.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loadingSnapshot && <p className="py-6 text-center text-sm text-zinc-400">Loading items…</p>}
          {snapshotError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              Couldn&apos;t load this transaction: {snapshotError}
            </div>
          )}
          {!loadingSnapshot && !snapshotError && returnItems.length === 0 && (
            <p className="py-6 text-center text-sm text-zinc-400">
              This transaction has no items available to exchange.
            </p>
          )}

          {!loadingSnapshot && !snapshotError && returnItems.length > 0 && (
            <div className="space-y-2">
              {returnItems.map((item, idx) => {
                const disabled = item.maxQuantity === 0;
                return (
                  <div
                    key={`${item.productVariantId}-${idx}`}
                    className={`rounded-xl border px-4 py-3 ${disabled ? "border-zinc-100 bg-zinc-50 opacity-60" : "border-zinc-200"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-semibold">
                          {item.bundleId ? "Bundle: " : ""}{item.productName}
                          {item.variantName && !item.bundleId ? ` — ${item.variantName}` : ""}
                        </p>
                        {item.sku && <p className="text-xs text-zinc-400">{item.sku}</p>}
                        {item.detail && <p className="mt-1 text-xs text-zinc-500">{item.detail}</p>}
                        <p className="mt-1 text-xs text-zinc-500">
                          {formatCurrency(item.unitPrice)} · {item.maxQuantity} available
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={disabled || item.returnQuantity <= 0}
                          onClick={() => setItemQty(idx, item.returnQuantity - 1)}
                          className="touch-button h-10 w-10 rounded-lg bg-zinc-100 text-lg font-bold text-zinc-700 hover:bg-zinc-200 disabled:opacity-40"
                        >−</button>
                        <span className="w-8 text-center font-semibold">{item.returnQuantity}</span>
                        <button
                          type="button"
                          disabled={disabled || item.returnQuantity >= item.maxQuantity}
                          onClick={() => setItemQty(idx, item.returnQuantity + 1)}
                          className="touch-button h-10 w-10 rounded-lg bg-zinc-100 text-lg font-bold text-zinc-700 hover:bg-zinc-200 disabled:opacity-40"
                        >+</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {selectedCount > 0 && (
            <div className="rounded-xl bg-teal-50 px-4 py-3 text-sm">
              <div className="flex justify-between">
                <span>Return subtotal</span>
                <span className="font-semibold">{formatCurrency(returnSubtotal)}</span>
              </div>
              <div className="flex justify-between text-zinc-500">
                <span>Tax ({(origTaxRate * 100).toFixed(2)}%)</span>
                <span>{formatCurrency(returnTax)}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-teal-200 pt-1 font-bold text-teal-700">
                <span>Exchange credit</span>
                <span>{formatCurrency(returnTotal)}</span>
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
          <button type="button" onClick={() => { setSelectedTxn(null); setStep("search"); }} className="touch-button flex-1 rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-700 hover:bg-zinc-200">
            Back
          </button>
          <button
            type="button"
            disabled={loadingSnapshot || selectedCount === 0 || returnTotal < 0 || !selectedTxn || continuing}
            onClick={() => {
              if (!selectedTxn) return;
              // R80-FE-M: double-submit guard — flip sync + fire once.
              if (continuing) return;
              setContinuing(true);
              const items = returnItems.filter((i) => i.returnQuantity > 0);
              onConfirm(selectedTxn.transactionId, items, returnTotal, reason, note);
            }}
            className="touch-button flex-1 rounded-xl bg-teal-700 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {continuing ? "Continuing…" : "Continue to new items"}
          </button>
        </div>
      </div>
    </div>
  );
}
