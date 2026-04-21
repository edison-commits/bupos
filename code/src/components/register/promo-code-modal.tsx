"use client";

import { useState, useMemo } from "react";
import type { PromoCode, ProductVariant, Product } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";

interface PromoCodeModalProps {
  promoCodes: PromoCode[];
  /** Needed to preview the free variant on a `free_item` promo. */
  variants: ProductVariant[];
  /** Needed to display "<Product> — <Variant>" on the free-item preview. */
  products: Product[];
  cartSubtotal: number;
  /** IDs of promo codes already applied to this cart — prevents double-applying. */
  appliedPromoIds?: string[];
  onApply: (promo: PromoCode, discountAmount: number) => void;
  onCancel: () => void;
}

export function PromoCodeModal({ promoCodes, variants, products, cartSubtotal, appliedPromoIds, onApply, onCancel }: PromoCodeModalProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const matchedPromo = useMemo(() => {
    if (!code.trim()) return null;
    return promoCodes.find((p) => p.code.toLowerCase() === code.trim().toLowerCase()) ?? null;
  }, [promoCodes, code]);

  const validation = useMemo(() => {
    if (!matchedPromo) return null;
    // Use epoch-ms comparison so TZ-offset or fractional-second
    // differences don't flip the check. String compare only worked for
    // strictly UTC-Z ISO strings; new admin-created promos from the
    // local <input type="datetime-local"> go through `new Date(...).toISOString()`
    // which is UTC-Z, but a future import path (CSV, migration) could
    // ship `+00:00` — then the string compare would differ.
    //
    // react-hooks/purity flags Date.now inside useMemo as impure; that's
    // fine here — this validation is a UI preview, the server
    // revalidates on apply. Disabling the rule for this line.
    // eslint-disable-next-line react-hooks/purity
    const nowMs = Date.now();

    if (matchedPromo.status !== "active") {
      return { valid: false, reason: `Code is ${matchedPromo.status}` };
    }
    if (matchedPromo.startsAt && new Date(matchedPromo.startsAt).getTime() > nowMs) {
      return { valid: false, reason: "Code is not yet active" };
    }
    if (matchedPromo.expiresAt && new Date(matchedPromo.expiresAt).getTime() < nowMs) {
      return { valid: false, reason: "Code has expired" };
    }
    // Match server semantics at checkout-action.ts / offline-sync:
    //   maxRedemptions > 0 → enforced
    //   maxRedemptions = 0 → unlimited
    //   maxRedemptions = 10_000_000 → admin UI sentinel for "unlimited"
    // Combined into a single condition so 0-via-CLI and 10M-via-admin
    // both render as unlimited in the modal.
    if (
      matchedPromo.maxRedemptions > 0 &&
      matchedPromo.maxRedemptions < 10_000_000 &&
      matchedPromo.currentRedemptions >= matchedPromo.maxRedemptions
    ) {
      return { valid: false, reason: "Code has reached maximum redemptions" };
    }
    if (cartSubtotal < matchedPromo.minimumPurchase) {
      return { valid: false, reason: `Minimum purchase of ${formatCurrency(matchedPromo.minimumPurchase)} required (cart: ${formatCurrency(cartSubtotal)})` };
    }
    if (appliedPromoIds?.includes(matchedPromo.id)) {
      return { valid: false, reason: "Code is already applied to this cart" };
    }

    // Free-item resolution: look up the variant + product for preview. The
    // server revalidates on checkout; this lookup is for display only.
    if (matchedPromo.type === "free_item") {
      if (!matchedPromo.freeVariantId) {
        return { valid: false, reason: "Promo is misconfigured (no free variant)" };
      }
      const variant = variants.find((v) => v.id === matchedPromo.freeVariantId);
      const product = variant ? products.find((p) => p.id === variant.productId) : undefined;
      if (!variant || !variant.isActive || !product) {
        return { valid: false, reason: "Free item is no longer available" };
      }
      return {
        valid: true,
        // For a free-item promo, the "discount" displayed in the banner is
        // the retail price of the freebie. Checkout doesn't apply it as a
        // cart-level discount; the cart line comes through at $0.
        discountAmount: variant.price,
        freePreview: { product, variant },
      };
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
  }, [matchedPromo, cartSubtotal, variants, products, appliedPromoIds]);

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
                {matchedPromo.type === "free_item" && validation.freePreview ? (
                  <p className="mt-1 text-sm text-emerald-600">
                    Free: <span className="font-bold">
                      {validation.freePreview.product.name} — {validation.freePreview.variant.name}
                    </span>
                    <span className="ml-1 text-xs text-emerald-500">
                      ({formatCurrency(validation.freePreview.variant.price)} value)
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-emerald-600">
                    Discount: <span className="font-bold">{formatCurrency((validation.discountAmount ?? 0))}</span>
                    {matchedPromo.type === "percent" && ` (${matchedPromo.value}% off)`}
                    {matchedPromo.type === "fixed" && ` (${formatCurrency(matchedPromo.value)} off)`}
                    {matchedPromo.type === "bogo" && " (BOGO)"}
                  </p>
                )}
                <p className="mt-1 text-xs text-emerald-500">
                  {matchedPromo.maxRedemptions >= 10_000_000
                    ? "unlimited uses"
                    : `${matchedPromo.maxRedemptions - matchedPromo.currentRedemptions} uses remaining`}
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
