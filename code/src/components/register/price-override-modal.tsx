"use client";

import { useState, useEffect } from "react";
import { VirtualNumpad } from "@/components/ui/virtual-numpad";
import { formatCurrency } from "@/lib/format";

interface PriceOverrideModalProps {
  lineItemId: string;
  productName: string;
  variantName: string;
  currentPrice: number;
  overridePrice?: number;
  onConfirm: (lineItemId: string, newPrice: number) => void;
  onClear: (lineItemId: string) => void;
  onCancel: () => void;
}

export function PriceOverrideModal({
  lineItemId,
  productName,
  variantName,
  currentPrice,
  overridePrice,
  onConfirm,
  onClear,
  onCancel,
}: PriceOverrideModalProps) {
  const [price, setPrice] = useState<string>(overridePrice?.toFixed(2) ?? "");
  const [showNumpad, setShowNumpad] = useState(true);
  // R49: double-submit guard. onConfirm triggers an approval pathway
  // that can take several hundred ms to resolve; without this guard a
  // rapid double-tap fires onConfirm twice, which on the server side
  // burns two approval exception slots for one intent. Mirrors the
  // R48-5 VoidReasonModal pattern.
  const [submitting, setSubmitting] = useState(false);
  const priceNum = Number(price) || 0;
  const valid = priceNum > 0 && priceNum !== currentPrice;
  const isDiscount = priceNum < currentPrice;
  const diffAmount = Math.abs(priceNum - currentPrice);

  // R80-FE-H2: Esc closes when not mid-submit.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel, submitting]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Price override" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-lg font-bold">Price Override</h2>
          <p className="text-sm text-zinc-500">{productName} — {variantName}</p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-2xl bg-zinc-100 px-4 py-3 text-center">
            <p className="text-xs text-zinc-500">Original price</p>
            <p className="text-xl font-bold">{formatCurrency(currentPrice)}</p>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-zinc-600">New price</span>
            <button
              type="button"
              onClick={() => setShowNumpad(true)}
              className="mt-1 w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-right text-xl font-bold hover:border-teal-300 transition-colors"
            >
              {price ? `${formatCurrency(priceNum)}` : `${formatCurrency(currentPrice)}`}
            </button>
          </label>

          {valid && (
            <div className={`rounded-2xl px-4 py-3 text-center ${isDiscount ? "bg-red-50" : "bg-teal-50"}`}>
              <p className={`text-xs ${isDiscount ? "text-red-500" : "text-teal-500"}`}>
                {isDiscount ? "Markdown" : "Markup"}
              </p>
              <p className={`text-lg font-bold ${isDiscount ? "text-red-700" : "text-teal-700"}`}>
                {isDiscount ? "−" : "+"}{formatCurrency(diffAmount)} ({((diffAmount / currentPrice) * 100).toFixed(0)}%)
              </p>
            </div>
          )}

          {overridePrice != null && (
            <button
              type="button"
              onClick={() => onClear(lineItemId)}
              className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
            >
              Reset to original price
            </button>
          )}
        </div>

        <div className="flex gap-2 border-t border-zinc-100 p-4">
          <button
            type="button"
            onClick={onCancel}
            className="touch-button flex-1 rounded-2xl bg-zinc-100 px-4 text-sm font-semibold text-zinc-600 hover:bg-zinc-200"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || !valid}
            onClick={() => {
              if (submitting) return;
              setSubmitting(true);
              onConfirm(lineItemId, priceNum);
            }}
            className={`touch-button flex-1 rounded-2xl px-4 text-sm font-bold transition-colors ${
              submitting || !valid
                ? "cursor-not-allowed bg-zinc-200 text-zinc-400"
                : "bg-zinc-900 text-white hover:bg-zinc-800"
            }`}
          >
            Apply override
          </button>
        </div>
      </div>

      {/* Virtual numpad for price entry */}
      <VirtualNumpad
        visible={showNumpad}
        value={price}
        onChange={setPrice}
        onEnter={() => {
          setShowNumpad(false);
          if (valid && !submitting) {
            setSubmitting(true);
            onConfirm(lineItemId, priceNum);
          }
        }}
        onClose={() => setShowNumpad(false)}
        label="New price"
        allowDecimal={true}
      />
    </div>
  );
}
