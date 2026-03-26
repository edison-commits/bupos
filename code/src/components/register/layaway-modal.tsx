"use client";

import { useState } from "react";
import type { CartTotals } from "@/lib/cart/types";

interface LayawayModalProps {
  totals: CartTotals;
  customerName: string | undefined;
  onConfirm: (depositAmount: number, dueDate: string | undefined, notes: string | undefined) => void;
  onCancel: () => void;
  processing: boolean;
}

export function LayawayModal({ totals, customerName, onConfirm, onCancel, processing }: LayawayModalProps) {
  const minimumDeposit = Math.max(1, totals.grandTotal * 0.1);
  const [deposit, setDeposit] = useState<string>(minimumDeposit.toFixed(2));
  const [dueDate, setDueDate] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const depositNum = Number(deposit) || 0;
  const valid = depositNum >= minimumDeposit - 0.005 && depositNum <= totals.grandTotal;

  function handleConfirm() {
    if (!valid) return;
    onConfirm(depositNum, dueDate || undefined, notes || undefined);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <h2 className="text-xl font-bold">Create Layaway</h2>
            <p className="text-sm text-zinc-500">Total: ${totals.grandTotal.toFixed(2)}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={processing}
            className="touch-button rounded-xl bg-zinc-100 px-4 text-sm font-semibold text-zinc-600 hover:bg-zinc-200"
          >
            Cancel
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {!customerName && (
            <div className="rounded-2xl bg-red-50 px-4 py-3 text-center">
              <p className="text-sm font-medium text-red-700">A customer must be attached for layaway</p>
            </div>
          )}

          {customerName && (
            <>
              <div className="rounded-2xl bg-teal-50 px-4 py-3 text-center">
                <p className="text-xs text-teal-600">Customer</p>
                <p className="text-lg font-semibold text-teal-800">{customerName}</p>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-zinc-600">
                  Deposit amount (min ${minimumDeposit.toFixed(2)})
                </span>
                <input
                  type="number"
                  min={minimumDeposit}
                  max={totals.grandTotal}
                  step="0.01"
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                  autoFocus
                  className="mt-1 w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-right text-xl font-bold"
                />
              </label>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setDeposit(minimumDeposit.toFixed(2))}
                  className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
                >
                  Min (${minimumDeposit.toFixed(2)})
                </button>
                <button
                  type="button"
                  onClick={() => setDeposit((totals.grandTotal * 0.25).toFixed(2))}
                  className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
                >
                  25% (${(totals.grandTotal * 0.25).toFixed(2)})
                </button>
                <button
                  type="button"
                  onClick={() => setDeposit((totals.grandTotal * 0.5).toFixed(2))}
                  className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
                >
                  50% (${(totals.grandTotal * 0.5).toFixed(2)})
                </button>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-zinc-600">Due date (optional)</span>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-zinc-600">Notes (optional)</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Customer preferences, pickup instructions..."
                  className="mt-1 w-full rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm"
                  rows={2}
                />
              </label>

              <div className="rounded-2xl bg-zinc-100 px-4 py-3 text-sm">
                <div className="flex justify-between">
                  <span>Deposit</span>
                  <span className="font-semibold">${depositNum.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Balance due</span>
                  <span className="font-semibold">${Math.max(0, totals.grandTotal - depositNum).toFixed(2)}</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="border-t border-zinc-100 p-4">
          <button
            type="button"
            disabled={processing || !valid || !customerName}
            onClick={handleConfirm}
            className={`touch-button w-full rounded-2xl px-5 text-base font-bold transition-colors ${
              processing || !valid || !customerName
                ? "cursor-not-allowed bg-zinc-200 text-zinc-400"
                : "bg-indigo-700 text-white hover:bg-indigo-800 active:bg-indigo-900"
            }`}
          >
            {processing ? "Creating..." : "Create layaway"}
          </button>
        </div>
      </div>
    </div>
  );
}
