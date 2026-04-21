"use client";

import { useState } from "react";
import type { DiscountMode, LineDiscount } from "@/lib/cart/types";
import { VirtualNumpad } from "@/components/ui/virtual-numpad";
import { VirtualKeyboard } from "@/components/ui/virtual-keyboard";
import { formatCurrency } from "@/lib/format";

interface LineDiscountModalProps {
  lineItemId: string;
  productName: string;
  variantName: string;
  lineSubtotal: number;
  currentDiscount?: LineDiscount;
  onConfirm: (lineItemId: string, discount: LineDiscount) => void;
  onClear: (lineItemId: string) => void;
  onCancel: () => void;
}

export function LineDiscountModal({
  lineItemId,
  productName,
  variantName,
  lineSubtotal,
  currentDiscount,
  onConfirm,
  onClear,
  onCancel,
}: LineDiscountModalProps) {
  const [mode, setMode] = useState<DiscountMode>(currentDiscount?.mode ?? "fixed");
  const [value, setValue] = useState<string>(currentDiscount?.value?.toString() ?? "");
  const [reason, setReason] = useState(currentDiscount?.reason ?? "");
  const [showNumpad, setShowNumpad] = useState(true);
  const [showReasonKbd, setShowReasonKbd] = useState(false);

  const numValue = Number(value) || 0;
  const discountAmount = mode === "percent"
    ? Number((lineSubtotal * Math.min(100, numValue) / 100).toFixed(2))
    : Math.min(numValue, lineSubtotal);
  const afterDiscount = Math.max(0, lineSubtotal - discountAmount);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="text-lg font-bold">Line discount</h3>
        <p className="mt-1 text-sm text-zinc-500">{productName} — {variantName}</p>
        <p className="text-sm text-zinc-600">Line subtotal: <span className="font-semibold">{formatCurrency(lineSubtotal)}</span></p>

        {/* Mode toggle */}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setMode("fixed")}
            className={`touch-button flex-1 rounded-xl border text-sm font-semibold ${
              mode === "fixed" ? "border-teal-600 bg-teal-600 text-white" : "border-zinc-200 bg-zinc-50 text-zinc-700"
            }`}
          >
            $ Fixed
          </button>
          <button
            type="button"
            onClick={() => setMode("percent")}
            className={`touch-button flex-1 rounded-xl border text-sm font-semibold ${
              mode === "percent" ? "border-teal-600 bg-teal-600 text-white" : "border-zinc-200 bg-zinc-50 text-zinc-700"
            }`}
          >
            % Percent
          </button>
        </div>

        {/* Value input */}
        <div className="mt-3">
          <label className="text-xs font-medium text-zinc-500">
            {mode === "fixed" ? "Discount amount ($)" : "Discount percentage (%)"}
          </label>
          <button
            type="button"
            onClick={() => { setShowNumpad(true); setShowReasonKbd(false); }}
            className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-lg font-semibold text-left hover:border-teal-300 transition-colors"
          >
            {value || (mode === "fixed" ? "0.00" : "0")}
          </button>
        </div>

        {/* Quick percent buttons */}
        {mode === "percent" && (
          <div className="mt-2 flex gap-2">
            {[5, 10, 15, 20, 25, 50].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => setValue(String(pct))}
                className="touch-button flex-1 rounded-lg border border-zinc-200 bg-zinc-50 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
              >
                {pct}%
              </button>
            ))}
          </div>
        )}

        {/* Reason */}
        <div className="mt-3">
          <label className="text-xs font-medium text-zinc-500">Reason (optional)</label>
          <button
            type="button"
            onClick={() => { setShowReasonKbd(true); setShowNumpad(false); }}
            className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-left hover:border-teal-300 transition-colors"
            style={{ color: reason ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          >
            {reason || "e.g., loyalty customer, damaged item"}
          </button>
        </div>

        {/* Preview */}
        <div className="mt-3 rounded-xl bg-zinc-50 px-3 py-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Discount</span>
            <span className="font-semibold text-red-600">−{formatCurrency(discountAmount)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">After discount</span>
            <span className="font-bold">{formatCurrency(afterDiscount)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-4 flex gap-2">
          {currentDiscount && (
            <button
              type="button"
              onClick={() => onClear(lineItemId)}
              className="touch-button flex-1 rounded-xl border border-red-200 bg-red-50 text-sm font-semibold text-red-600"
            >
              Remove
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="touch-button flex-1 rounded-xl border border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={numValue <= 0}
            onClick={() => onConfirm(lineItemId, { mode, value: numValue, reason: reason.trim() || undefined })}
            className={`touch-button flex-1 rounded-xl text-sm font-semibold ${
              numValue <= 0
                ? "cursor-not-allowed bg-zinc-200 text-zinc-400"
                : "bg-teal-700 text-white hover:bg-teal-800"
            }`}
          >
            Apply
          </button>
        </div>
      </div>

      {/* Virtual numpad for discount value */}
      <VirtualNumpad
        visible={showNumpad}
        value={value}
        onChange={setValue}
        onEnter={() => setShowNumpad(false)}
        onClose={() => setShowNumpad(false)}
        label={mode === "fixed" ? "Discount $" : "Discount %"}
        allowDecimal={mode === "fixed"}
      />

      {/* Virtual keyboard for reason */}
      <VirtualKeyboard
        visible={showReasonKbd}
        value={reason}
        onChange={setReason}
        onEnter={() => setShowReasonKbd(false)}
        onClose={() => setShowReasonKbd(false)}
        label="Discount reason"
      />
    </div>
  );
}
