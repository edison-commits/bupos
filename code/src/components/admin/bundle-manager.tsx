"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProductBundle, Product, ProductVariant } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";
// R53: step-up re-auth on bundle create. Server /api/bundles POST
// gates unconditionally on bucketKey:'bundle-price-stepup' (bundle
// pricing is cash-impacting). PATCH gates only when bundlePrice is
// in the body; the current PATCH here only toggles isActive, so no
// prompt is needed there. Prior UI didn't thread actorPassword so
// every bundle create threw.
import { usePasswordGate } from "@/components/shared/password-gate";

interface BundleManagerProps {
  bundles: ProductBundle[];
  variants: ProductVariant[];
  products: Product[];
}

export function BundleManager({ bundles, variants, products }: BundleManagerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    bundlePrice: "",
    compareAtPrice: "",
    items: [{ variantId: "", quantity: 1 }],
  });
  const [promptPassword, passwordGate] = usePasswordGate();

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      bundlePrice: "",
      compareAtPrice: "",
      items: [{ variantId: "", quantity: 1 }],
    });
    setError(null);
  };

  const handleAddItem = () => {
    setFormData({
      ...formData,
      items: [...formData.items, { variantId: "", quantity: 1 }],
    });
  };

  const handleRemoveItem = (index: number) => {
    setFormData({
      ...formData,
      items: formData.items.filter((_, i) => i !== index),
    });
  };

  const handleItemChange = (index: number, field: string, value: string | number) => {
    const newItems = [...formData.items];
    newItems[index] = { ...newItems[index], [field]: value };
    setFormData({ ...formData, items: newItems });
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Client-side sanity checks. Server validates again via Zod.
    const bundlePrice = Number.parseFloat(formData.bundlePrice);
    const compareAtPrice = formData.compareAtPrice ? Number.parseFloat(formData.compareAtPrice) : undefined;
    if (!Number.isFinite(bundlePrice) || bundlePrice <= 0) {
      setError("Bundle price must be greater than $0");
      return;
    }
    if (compareAtPrice !== undefined && (!Number.isFinite(compareAtPrice) || compareAtPrice < bundlePrice)) {
      setError("Compare-at price must be ≥ bundle price");
      return;
    }
    const items = formData.items
      .filter((i) => i.variantId && i.quantity > 0)
      .map((i) => ({ productVariantId: i.variantId, quantity: Math.floor(Number(i.quantity)) }));
    if (items.length < 2) {
      setError("Bundle needs at least 2 items");
      return;
    }

    // R53: server gates bundle create on bundle-price-stepup
    // unconditionally. Prompt for password before POST.
    const pwd = await promptPassword({
      title: `Create bundle "${formData.name.trim()}" at ${formatCurrency(bundlePrice)}?`,
      description:
        "Bundle prices affect every cart that applies them and flow through to the margin report. Confirm with your password.",
      confirmLabel: "Create bundle",
      confirmVariant: "default",
    });
    if (!pwd) return;

    const res = await fetch("/api/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        bundlePrice,
        compareAtPrice,
        items,
        actorPassword: pwd,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to create bundle" }));
      setError(body.error ?? "Failed to create bundle");
      return;
    }

    resetForm();
    setShowCreateForm(false);
    // `router.refresh()` re-runs the admin server component so store.bundles
    // picks up the new row. Wrapping in startTransition prevents the revalidation
    // fetch from blocking the close animation.
    startTransition(() => router.refresh());
  };

  const handleToggleActive = async (bundle: ProductBundle, nextActive: boolean) => {
    setError(null);
    setBusyId(bundle.id);
    try {
      const res = await fetch("/api/bundles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: bundle.id, isActive: nextActive }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed to update bundle" }));
        setError(body.error ?? "Failed to update bundle");
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (bundle: ProductBundle) => {
    if (!window.confirm(`Delete bundle "${bundle.name}"? This cannot be undone.`)) return;
    setError(null);
    setBusyId(bundle.id);
    try {
      const res = await fetch("/api/bundles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: bundle.id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed to delete bundle" }));
        setError(body.error ?? "Failed to delete bundle");
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusyId(null);
    }
  };

  const calculateItemsTotal = (bundle: ProductBundle) => {
    return bundle.items.reduce((total, item) => {
      const variant = variants.find((v) => v.id === item.productVariantId);
      return total + (variant?.price ?? 0) * item.quantity;
    }, 0);
  };

  const calculateSavings = (bundle: ProductBundle) => {
    const itemsTotal = calculateItemsTotal(bundle);
    return itemsTotal - bundle.bundlePrice;
  };

  const getVariantName = (variantId: string) => {
    const variant = variants.find((v) => v.id === variantId);
    if (!variant) return "Unknown";
    const product = products.find((p) => p.id === variant.productId);
    return `${product?.name ?? "Product"} - ${variant.name}`;
  };

  return (
    <div className="space-y-4">
      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {bundles.length === 0 ? (
        <p className="text-sm text-zinc-600">No product bundles yet. Create your first bundle to get started.</p>
      ) : (
        <div className="space-y-3">
          {bundles.map((bundle) => (
            <div key={bundle.id} className="rounded-2xl border border-zinc-200 px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <h3 className="font-semibold">{bundle.name}</h3>
                  {bundle.description && <p className="text-sm text-zinc-600">{bundle.description}</p>}
                  <div className="mt-2 space-y-1">
                    {bundle.items.map((item, idx) => (
                      <p key={idx} className="text-xs text-zinc-500">
                        {getVariantName(item.productVariantId)} × {item.quantity}
                      </p>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="rounded-lg bg-teal-50 px-3 py-1 text-lg font-bold text-teal-700">
                    {formatCurrency(bundle.bundlePrice)}
                  </span>
                  {calculateSavings(bundle) > 0 && (
                    <span className="text-xs text-emerald-700">
                      Save {formatCurrency(calculateSavings(bundle))}
                    </span>
                  )}
                  <span className="text-xs text-zinc-500">
                    vs {formatCurrency(calculateItemsTotal(bundle))}
                  </span>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-zinc-700">
                  <input
                    type="checkbox"
                    checked={bundle.isActive}
                    disabled={busyId === bundle.id || isPending}
                    onChange={(e) => handleToggleActive(bundle, e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-300"
                  />
                  {bundle.isActive ? "Active" : "Inactive"}
                </label>
                <button
                  type="button"
                  onClick={() => handleDelete(bundle)}
                  disabled={busyId === bundle.id || isPending}
                  className="rounded-lg bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6">
        {showCreateForm ? (
          <form onSubmit={handleCreateSubmit} className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <h3 className="mb-4 font-semibold">Create New Bundle</h3>
            <div className="space-y-3">
              <label className="grid gap-1 text-sm font-medium text-zinc-700">
                <span>Bundle name</span>
                <input
                  type="text"
                  placeholder="E.g., Back to School Bundle"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="rounded-2xl border border-zinc-300 bg-white px-4 py-3"
                  required
                />
              </label>

              <label className="grid gap-1 text-sm font-medium text-zinc-700">
                <span>Description (optional)</span>
                <textarea
                  placeholder="Describe what's included in this bundle"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="rounded-2xl border border-zinc-300 bg-white px-4 py-3"
                  rows={2}
                />
              </label>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium text-zinc-700">
                  <span>Bundle price</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="99.99"
                    value={formData.bundlePrice}
                    onChange={(e) => setFormData({ ...formData, bundlePrice: e.target.value })}
                    className="rounded-2xl border border-zinc-300 bg-white px-4 py-3"
                    required
                  />
                </label>

                <label className="grid gap-1 text-sm font-medium text-zinc-700">
                  <span>Compare at price (optional)</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="129.99"
                    value={formData.compareAtPrice}
                    onChange={(e) => setFormData({ ...formData, compareAtPrice: e.target.value })}
                    className="rounded-2xl border border-zinc-300 bg-white px-4 py-3"
                  />
                </label>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-700">Bundle items (at least 2)</span>
                  <button
                    type="button"
                    onClick={handleAddItem}
                    className="text-xs font-medium text-teal-700 hover:text-teal-800"
                  >
                    + Add item
                  </button>
                </div>

                {formData.items.map((item, idx) => (
                  <div key={idx} className="flex gap-2">
                    <label className="flex-1 grid gap-1 text-sm font-medium text-zinc-700">
                      <span>Product variant</span>
                      <select
                        value={item.variantId}
                        onChange={(e) => handleItemChange(idx, "variantId", e.target.value)}
                        className="rounded-2xl border border-zinc-300 bg-white px-4 py-3"
                        required
                      >
                        <option value="">Select variant...</option>
                        {variants.map((v) => {
                          const product = products.find((p) => p.id === v.productId);
                          return (
                            <option key={v.id} value={v.id}>
                              {product?.name} - {v.name}
                            </option>
                          );
                        })}
                      </select>
                    </label>

                    <label className="w-20 grid gap-1 text-sm font-medium text-zinc-700">
                      <span>Qty</span>
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={(e) => handleItemChange(idx, "quantity", parseInt(e.target.value, 10))}
                        className="rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-center"
                        required
                      />
                    </label>

                    {formData.items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveItem(idx)}
                        className="self-end rounded-2xl bg-red-50 px-3 py-3 text-xs font-medium text-red-700 hover:bg-red-100"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex gap-2 pt-3">
                <button
                  type="submit"
                  disabled={isPending}
                  className="touch-button flex-1 rounded-2xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPending ? "Creating…" : "Create bundle"}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreateForm(false); resetForm(); }}
                  disabled={isPending}
                  className="touch-button flex-1 rounded-2xl bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-300 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowCreateForm(true)}
            className="touch-button w-full rounded-2xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
          >
            + Create bundle
          </button>
        )}
      </div>
      {/* R53: shared password gate renders nothing until prompted. */}
      {passwordGate}
    </div>
  );
}
