"use client";

import { useState, useMemo, useEffect } from "react";
import type { TenderType } from "@/lib/domain/types";
import type { TransactionEventPlaceholder, TransactionTenderPlaceholder } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";

interface ReturnItem {
  productVariantId: string;
  productName: string;
  variantName: string;
  sku: string;
  unitPrice: number;
  maxQuantity: number;
  returnQuantity: number;
  /** Present iff this line is a bundle. */
  bundleId?: string;
  bundleComponents?: { productVariantId: string; quantity: number }[];
  /** Present iff this line was a free-with-purchase promo redemption. */
  promoCodeId?: string;
  /** Pretty subtitle shown under the product name (e.g. component list). */
  detail?: string;
}

interface TxnSummary {
  transactionId: string;
  timestamp: string;
  grandTotal: number;
  itemCount: number;
  tenderType: string;
}

type RefundMethod = Exclude<TenderType, "loyalty" | "split" | "gift_card">;

interface ReturnModalProps {
  transactionEvents: TransactionEventPlaceholder[];
  transactionTenders: TransactionTenderPlaceholder[];
  /** Optional — used to render human-friendly bundle component descriptions. */
  variantDirectory?: Record<string, { name: string; productName?: string }>;
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

// Shape returned by GET /api/transactions/by-id/:id?withCart=1
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
  status: string;
  grandTotal: number;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  cartSnapshot: { items?: CartSnapshotLine[] } | null;
  // Split by semantic identity per the sentinel contract documented in
  // src/lib/cart/types.ts. Bundle lines look up in `alreadyReturnedByBundle`
  // with bundleId; regular lines look up in `alreadyReturnedByVariant`
  // with productVariantId.
  alreadyReturnedByVariant: Record<string, number>;
  alreadyReturnedByBundle: Record<string, number>;
}

export function ReturnModal({
  transactionEvents,
  transactionTenders,
  variantDirectory = {},
  onConfirm,
  onCancel,
}: ReturnModalProps) {
  const [step, setStep] = useState<"search" | "items" | "confirm">("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTxn, setSelectedTxn] = useState<TxnSummary | null>(null);
  const [returnItems, setReturnItems] = useState<ReturnItem[]>([]);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  // R79-FE-M: double-submit guard on Process-return. Parent's
  // onConfirm is async + refund mutations are not idempotent — a
  // fast double-tap would otherwise fire two refund POSTs, causing
  // double-restock + double store-credit issuance.
  const [submitting, setSubmitting] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [refundMethod, setRefundMethod] = useState<RefundMethod>("cash");

  // R79-FE-M: Esc closes when not submitting.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel, submitting]);
  const [reason, setReason] = useState(RETURN_REASONS[0].value);
  const [note, setNote] = useState("");
  // Effective tax rate of the ORIGINAL sale — used to show the customer-
  // facing refund total. Derived from tax_total / subtotal; defaults to
  // 10.25% only if the original transaction had a zero subtotal.
  const [origTaxRate, setOrigTaxRate] = useState(0.1025);
  const [origDiscountFactor, setOrigDiscountFactor] = useState(1);

  // Parse completed transactions from events (search list — lightweight)
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
      (t) =>
        t.transactionId.toLowerCase().includes(q) ||
        t.grandTotal.toFixed(2).includes(q),
    );
  }, [transactions, searchQuery]);

  // When a transaction is selected, fetch its full cart_snapshot + prior-
  // returns tally so the cashier picks from real items (not a freeform
  // refund amount). Bundle lines are expanded into a single row with a
  // component subtitle.
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
        // Original tax rate (effective): tax_total / subtotal. Fall back
        // to 10.25% only on a zero-subtotal edge case.
        if (t.subtotal > 0) {
          setOrigTaxRate(Number((t.taxTotal / t.subtotal).toFixed(6)));
          setOrigDiscountFactor(Math.max(0, 1 - (t.discountTotal ?? 0) / t.subtotal));
        }
        const snapItems = t.cartSnapshot?.items ?? [];
        const items: ReturnItem[] = snapItems.map((line) => {
          const isBundle = !!line.bundleId;
          const isFreeItem = !!line.promoCodeId;
          // Pick the right tally: bundle lines tally by bundleId, regular
          // lines by productVariantId. Keeps the sentinel contract explicit
          // per src/lib/cart/types.ts.
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
            // Explicit label so the cashier isn't confused when the
            // customer hands back an item with $0 refund value. The line
            // can still be selected for return (so inventory is restocked
            // and the promo redemption is reversed), but the refund math
            // for this line is $0.
            detail = "Free-with-purchase — no refund (restocks + reverses promo)";
          }
          return {
            productVariantId: line.productVariantId,
            productName: line.productName ?? (isBundle ? "Bundle" : "Item"),
            variantName: line.variantName ?? (isBundle ? "Bundle" : ""),
            sku: line.sku ?? "",
            // For a free-item line: the customer paid $0, so the PER-LINE
            // refund value shown in the modal is 0, not the variant's list
            // price. Server clamps it too (return-action.ts).
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
        const msg = err instanceof Error ? err.message : "Failed to load transaction";
        setSnapshotError(msg);
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
  // Apply original discount factor so refund matches what the customer paid.
  const returnSubtotal = Number((returnSubtotalRaw * origDiscountFactor).toFixed(2));
  const returnTax = Number((returnSubtotal * origTaxRate).toFixed(2));
  const returnTotal = Number((returnSubtotal + returnTax).toFixed(2));

  // ── Step 1: Search transactions ─────────────────────────
  if (step === "search") {
    return (
      <div role="dialog" aria-modal="true" aria-label="Process return" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
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
                      setStep("items");
                    }}
                    className="touch-button w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-left hover:bg-blue-50 active:bg-blue-100"
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

  // ── Step 2: Select return items and quantities ──────────
  if (step === "items") {
    const selectedCount = returnItems.filter((i) => i.returnQuantity > 0).length;
    const setItemQty = (idx: number, next: number) => {
      setReturnItems((prev) =>
        prev.map((it, i) =>
          i === idx ? { ...it, returnQuantity: Math.max(0, Math.min(it.maxQuantity, next)) } : it,
        ),
      );
    };
    return (
      <div role="dialog" aria-modal="true" aria-label="Process return" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl">
          <div className="border-b border-zinc-100 px-5 py-4">
            <h2 className="text-lg font-bold">Return items</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Transaction {selectedTxn?.transactionId.slice(0, 8)}... · {formatCurrency(selectedTxn?.grandTotal ?? 0)}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {loadingSnapshot && (
              <p className="py-6 text-center text-sm text-zinc-400">Loading items…</p>
            )}
            {snapshotError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                Couldn&apos;t load this transaction: {snapshotError}
              </div>
            )}
            {!loadingSnapshot && !snapshotError && returnItems.length === 0 && (
              <p className="py-6 text-center text-sm text-zinc-400">
                This transaction has no returnable items remaining.
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
                          {item.detail && (
                            <p className="mt-1 text-xs text-zinc-500">{item.detail}</p>
                          )}
                          <p className="mt-1 text-xs text-zinc-500">
                            {formatCurrency(item.unitPrice)} · {item.maxQuantity} available to return
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
              <div className="rounded-xl bg-zinc-50 px-4 py-3 text-sm">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span className="font-semibold">{formatCurrency(returnSubtotal)}</span>
                </div>
                <div className="flex justify-between text-zinc-500">
                  <span>Tax ({(origTaxRate * 100).toFixed(2)}%)</span>
                  <span>{formatCurrency(returnTax)}</span>
                </div>
                <div className="mt-1 flex justify-between border-t border-zinc-200 pt-1 font-bold">
                  <span>Refund total</span>
                  <span>{formatCurrency(returnTotal)}</span>
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
            <button type="button" onClick={() => { setSelectedTxn(null); setStep("search"); }} className="touch-button flex-1 rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-700 hover:bg-zinc-200">
              Back
            </button>
            {/* A $0 return is legitimate when the customer is returning
                ONLY free-with-purchase items (they paid nothing, they're
                refunded nothing, but we still restock inventory and
                reverse the promo redemption). Guard on item selection,
                not dollar value. Negative totals still block — those
                would mean something's gone wrong server-side. */}
            <button
              type="button"
              disabled={loadingSnapshot || selectedCount === 0 || returnTotal < 0}
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
    <div role="dialog" aria-modal="true" aria-label="Process return" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-lg font-bold">Confirm return</h2>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Refunding <span className="font-bold">{formatCurrency(returnTotal)}</span> via <span className="font-semibold capitalize">{refundMethod === "store_credit" ? "store credit" : refundMethod}</span>
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
            disabled={submitting}
            onClick={() => {
              if (!selectedTxn) return;
              // R79-FE-M: flip synchronously so a second click can't
              // slip in before the async onConfirm runs. Parent
              // unmounts the modal on success; on failure the modal
              // stays mounted but `submitting` stays true, keeping
              // the button disabled until re-mount.
              if (submitting) return;
              setSubmitting(true);
              const items = returnItems.filter((i) => i.returnQuantity > 0);
              onConfirm(selectedTxn.transactionId, items, refundMethod, reason, note);
            }}
            className="touch-button flex-1 rounded-xl bg-red-600 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Processing…" : "Process return"}
          </button>
        </div>
      </div>
    </div>
  );
}
