"use client";

import { useState, useMemo } from "react";
import type { PromoCode } from "@/lib/domain/types";

interface PromoCodeModalProps {
  promoCodes: PromoCode[];
  cartSubtotal: number;
  onApply: (promo: PromoCode, discountAmount: number) => void;
  onCancel: () => void;
}

export function PromoCodeModal({ promoCodes, cartSubtotal, onApply, onCancel }: PromoCodeModalProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const matchedPromo = useMemo(() => {
    if (!code.trim()) return null;
    return promoCodes.find((p) => p.code.toLowerCase() === code.trim().toLowerCase()) ?? null;
  }, [promoCodes, code]);

  const validation = useMemo(() => {
    if (!matchedPromo) return null;
    const now = new Date().toISOString();

    if (matchedPromo.status !== "active") {
      return { valid: false, reason: `Code is ${matchedPromo.status}` };
    }
    if (matchedPromo.startsAt > now) {
      return { valid: false, reason: "Code is not yet active" };
    }
    if (matchedPromo.expiresAt && matchedPromo.expiresAt < now) {
      return { valid: false, reason: "Code has expired" };
    }
    if (matchedPromo.currentRedemptions >= matchedPromo.maxRedemptions) {
      return { valid: false, reason: "Code has reached maximum redemptions" };
    }
    if (cartSubtotal < matchedPromo.minimumPurchase) {
      return { valid: false, reason: `Minimum purchase of $${matchedPromo.minimumPurchase.toFixed(2)} required (cart: $${cartSubtotal.toFixed(2)})` };
    }

    // Calculate discount
    let discountAmount = 0;
    if (matchedPromo.type === "fixed") {
      discountAmount = Math.min(matchedPromo.value, cartSubtotal);
    } else if (matchedPromo.type === "percent") {
      discountAmount = Number((cartSubtotal * matchedPromo.value / 100).toFixed(2));
    } else if (matchedPromo.type === "bogo") {
      // BOGO: discount = value of cheapest qualifying item (simplified as 50% off for now)
      discountAmount = Number((cartSubtotal * 0.5).toFixed(2));
    }

    return { valid: true, discountAmount };
  }, [matchedPromo, cartSubtotal]);

  const handleApply = () => {
    if (!matchedPromo) {
      setError("No promo code entered");
      return;
    }
    if (!validation?.valid) {
      setError(validation?.reason ?? "Invalid code");
      return;
    }
    onApply(matchedPromo, validation.discountAmount ?? 0);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="text-lg font-bold">Apply promo code</h3>
        <p className="mt-1 text-sm text-zinc-500">Enter a coupon or promotional code.</p>

        <div className="mt-4">
          <input
            type="text"
            value={code}
            onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(null); }}
            placeholder="e.g., WELCOME10"
            autoFocus
            className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-lg font-mono font-semibold uppercase tracking-wider focus:border-purple-400 focus:bg-white focus:outline-none"
          />
        </div>

        {/* Code status */}
        {code.trim() && (
          <div className="mt-3">
            {!matchedPromo ? (
              <p className="text-sm text-red-500">Code not found</p>
            ) : !validation?.valid ? (
              <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{validation?.reason}</div>
            ) : (
              <div className="rounded-xl bg-emerald-50 px-3 py-2">
                <p className="text-sm font-semibold text-emerald-700">
                  {matchedPromo.description ?? matchedPromo.code}
                </p>
                <p className="mt-1 text-sm text-emerald-600">
                  Discount: <span className="font-bold">${(validation.discountAmount ?? 0).toFixed(2)}</span>
                  {matchedPromo.type === "percent" && ` (${matchedPromo.value}% off)`}
                  {matchedPromo.type === "fixed" && ` ($${matchedPromo.value.toFixed(2)} off)`}
                  {matchedPromo.type === "bogo" && " (BOGO)"}
                </p>
                <p className="mt-1 text-xs text-emerald-500">
                  {matchedPromo.maxRedemptions - matchedPromo.currentRedemptions} uses remaining
                </p>
              </div>
            )}
          </div>
        )}

        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="touch-button flex-1 rounded-xl border border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!validation?.valid}
            onClick={handleApply}
            className={`touch-button flex-1 rounded-xl text-sm font-semibold ${
              validation?.valid
                ? "bg-purple-700 text-white hover:bg-purple-800"
                : "cursor-not-allowed bg-zinc-200 text-zinc-400"
            }`}
          >
            Apply code
          </button>
        </div>
      </div>
    </div>
  );
}
