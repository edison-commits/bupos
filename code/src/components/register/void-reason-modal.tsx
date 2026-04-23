"use client";

import { useState, useEffect } from "react";

export type VoidTarget = "cart" | "item";

interface VoidReasonModalProps {
  target: VoidTarget;
  itemName?: string;
  onConfirm: (reasonCode: string, note: string) => void;
  onCancel: () => void;
}

const VOID_REASONS = [
  { value: "customer_changed_mind", label: "Customer changed mind" },
  { value: "duplicate_scan", label: "Duplicate scan" },
  { value: "cashier_error", label: "Cashier error" },
  { value: "pricing_correction", label: "Pricing correction" },
  { value: "payment_failure", label: "Payment failure" },
  { value: "manager_instruction", label: "Manager instruction" },
  { value: "damaged_item", label: "Damaged item" },
  { value: "test_transaction", label: "Test transaction" },
  { value: "other", label: "Other" },
];

export function VoidReasonModal({ target, itemName, onConfirm, onCancel }: VoidReasonModalProps) {
  const [reasonCode, setReasonCode] = useState("customer_changed_mind");
  const [note, setNote] = useState("");
  // R48: double-submit guard. Double-tap on Confirm fires onConfirm
  // twice, producing duplicate audit rows and two server-action
  // invocations. `submitting` flips synchronously on first click;
  // second click sees disabled=true + early-returns.
  const [submitting, setSubmitting] = useState(false);

  // R80-FE-H2: Esc closes when not mid-submit.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel, submitting]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Void reason" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
        <div className="rounded-t-2xl bg-red-700 px-5 py-4 text-white">
          <h2 className="text-lg font-bold">
            {target === "cart" ? "Void entire cart" : "Remove item"}
          </h2>
          {itemName && <p className="mt-1 text-sm text-red-200">{itemName}</p>}
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="text-sm font-medium text-zinc-600">Reason</label>
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm"
            >
              {VOID_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-zinc-600">Note (optional)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Additional details..."
              className="mt-1 min-h-16 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex gap-3 border-t border-zinc-100 p-4">
          <button
            type="button"
            onClick={onCancel}
            className="touch-button flex-1 rounded-2xl border border-zinc-200 bg-white px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Keep
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              if (submitting) return;
              setSubmitting(true);
              onConfirm(reasonCode, note);
            }}
            className="touch-button flex-1 rounded-2xl bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800 disabled:opacity-50"
          >
            {submitting ? "…" : target === "cart" ? "Void cart" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}
