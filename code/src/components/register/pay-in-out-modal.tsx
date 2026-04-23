"use client";

import { useState, useEffect } from "react";
import { VirtualNumpad } from "@/components/ui/virtual-numpad";
import { VirtualKeyboard } from "@/components/ui/virtual-keyboard";
import { formatCurrency } from "@/lib/format";

export type PayDirection = "pay_in" | "pay_out";

interface PayInOutModalProps {
  direction: PayDirection;
  onConfirm: (amount: number, reason: string, note: string) => void;
  onCancel: () => void;
}

const REASONS: Record<PayDirection, { value: string; label: string }[]> = {
  pay_in: [
    { value: "change_replenishment", label: "Change replenishment" },
    { value: "float_adjustment", label: "Float adjustment" },
    { value: "cash_deposit_return", label: "Cash deposit return" },
    { value: "other", label: "Other" },
  ],
  pay_out: [
    { value: "bank_deposit", label: "Bank deposit" },
    { value: "vendor_payment", label: "Vendor payment" },
    { value: "expense_reimbursement", label: "Expense reimbursement" },
    { value: "petty_cash", label: "Petty cash" },
    { value: "other", label: "Other" },
  ],
};

export function PayInOutModal({ direction, onConfirm, onCancel }: PayInOutModalProps) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState(REASONS[direction][0].value);
  const [note, setNote] = useState("");
  const [showNumpad, setShowNumpad] = useState(true);
  const [showNoteKbd, setShowNoteKbd] = useState(false);
  // R47-H4: double-submit guard. `payInOutAction` has no idempotency
  // key; a fast double-tap on Confirm creates two `pay_in_outs` rows
  // and inflates/deflates expectedCash on shift close. Flip
  // `submitting` synchronously in the click handler before firing
  // `onConfirm`; the second click sees the disabled button + no-ops.
  const [submitting, setSubmitting] = useState(false);

  const parsedAmount = Number(amount) || 0;
  const isValid = parsedAmount > 0 && reason.length > 0;
  const title = direction === "pay_in" ? "Pay in" : "Pay out";
  const description = direction === "pay_in"
    ? "Add cash to the drawer (e.g. change replenishment)."
    : "Remove cash from the drawer (e.g. bank deposit).";

  // R79-FE-M: Esc closes the modal when not mid-submit.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel, submitting]);

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-zinc-100 px-6 py-5">
          <h2 className="text-xl font-bold">{title}</h2>
          <p className="mt-1 text-sm text-zinc-500">{description}</p>
        </div>

        <div className="space-y-4 px-6 py-5">
          <label className="grid gap-1">
            <span className="text-sm font-medium text-zinc-600">Amount</span>
            <button
              type="button"
              onClick={() => { setShowNumpad(true); setShowNoteKbd(false); }}
              className="rounded-xl border border-zinc-300 px-4 py-3 text-lg font-semibold text-left hover:border-teal-300 transition-colors"
            >
              {amount ? `${formatCurrency(parsedAmount)}` : "$0.00"}
            </button>
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-zinc-600">Reason</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="rounded-xl border border-zinc-300 px-4 py-3 text-sm"
            >
              {REASONS[direction].map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-zinc-600">Note (optional)</span>
            <button
              type="button"
              onClick={() => { setShowNoteKbd(true); setShowNumpad(false); }}
              className="min-h-16 rounded-xl border border-zinc-300 px-4 py-3 text-sm text-left hover:border-teal-300 transition-colors"
              style={{ color: note ? 'var(--text-primary)' : 'var(--text-secondary)' }}
            >
              {note || (direction === "pay_in" ? "e.g. Added rolls of quarters" : "e.g. Deposited at Chase branch")}
            </button>
          </label>
        </div>

        <div className="flex gap-3 border-t border-zinc-100 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="touch-button flex-1 rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-700 hover:bg-zinc-200"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!isValid || submitting}
            onClick={() => {
              if (submitting) return;
              setSubmitting(true);
              onConfirm(parsedAmount, reason, note.trim());
            }}
            className={`touch-button flex-1 rounded-xl text-sm font-semibold text-white ${
              direction === "pay_in"
                ? "bg-teal-700 hover:bg-teal-800"
                : "bg-amber-600 hover:bg-amber-700"
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {submitting ? "Processing…" : `${title} ${formatCurrency(parsedAmount)}`}
          </button>
        </div>
      </div>

      {/* Virtual numpad for amount */}
      <VirtualNumpad
        visible={showNumpad}
        value={amount}
        onChange={setAmount}
        onEnter={() => setShowNumpad(false)}
        onClose={() => setShowNumpad(false)}
        label={`${title} amount`}
        allowDecimal={true}
      />

      {/* Virtual keyboard for note */}
      <VirtualKeyboard
        visible={showNoteKbd}
        value={note}
        onChange={setNote}
        onEnter={() => setShowNoteKbd(false)}
        onClose={() => setShowNoteKbd(false)}
        label="Note"
      />
    </div>
  );
}
