"use client";

import { useState } from "react";
import type { ProductBundle, Product, ProductVariant } from "@/lib/domain/types";

interface BundleManagerProps {
  bundles: ProductBundle[];
  variants: ProductVariant[];
  products: Product[];
}

export function BundleManager({ bundles, variants, products }: BundleManagerProps) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    bundlePrice: "",
    compareAtPrice: "",
    items: [{ variantId: "", quantity: 1 }],
  });

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
    // Placeholder for server action
    console.log("Create bundle:", formData);
    setFormData({
      name: "",
      description: "",
      bundlePrice: "",
      compareAtPrice: "",
      items: [{ variantId: "", quantity: 1 }],
    });
    setShowCreateForm(false);
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
                    ${bundle.bundlePrice.toFixed(2)}
                  </span>
                  {calculateSavings(bundle) > 0 && (
                    <span className="text-xs text-emerald-700">
                      Save ${calculateSavings(bundle).toFixed(2)}
                    </span>
                  )}
                  <span className="text-xs text-zinc-500">
                    vs ${calculateItemsTotal(bundle).toFixed(2)}
                  </span>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-zinc-700">
                  <input type="checkbox" defaultChecked={bundle.isActive} className="h-4 w-4 rounded border-zinc-300" />
                  {bundle.isActive ? "Active" : "Inactive"}
                </label>
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
                    placeholder="129.99"
                    value={formData.compareAtPrice}
                    onChange={(e) => setFormData({ ...formData, compareAtPrice: e.target.value })}
                    className="rounded-2xl border border-zinc-300 bg-white px-4 py-3"
                  />
                </label>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-700">Bundle items</span>
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
                <button type="submit" className="touch-button flex-1 rounded-2xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white">
                  Create bundle
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="touch-button flex-1 rounded-2xl bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowCreateForm(true)}
            className="touch-button w-full rounded-2xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white"
          >
            + Create bundle
          </button>
        )}
      </div>
    </div>
  );
}
