"use client";

import { useState, useMemo } from "react";
import type { InventoryLevel, ProductVariant, Product, Supplier } from "@/lib/domain/types";

interface LowStockAutoReorderProps {
  inventory: InventoryLevel[];
  variants: ProductVariant[];
  products: Product[];
  suppliers?: Supplier[];
  onGeneratePO?: (items: ReorderItem[]) => void;
}

interface ReorderItem {
  productVariantId: string;
  sku: string;
  productName: string;
  variantName: string;
  currentOnHand: number;
  reorderPoint: number;
  suggestedQty: number;
  unitCost: number;
}

export function LowStockAutoReorder({
  inventory,
  variants,
  products,
  suppliers: _suppliers,
  onGeneratePO,
}: LowStockAutoReorderProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);

  // Build maps for quick lookups
  const variantMap = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants]);
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Calculate low-stock items and sort by urgency (lowest stock relative to reorder point)
  const lowStockItems: ReorderItem[] = useMemo(() => {
    return inventory
      .filter((inv) => inv.onHand <= inv.reorderPoint)
      .map((inv) => {
        const variant = variantMap.get(inv.productVariantId);
        const product = variant ? productMap.get(variant.productId) : null;

        if (!variant || !product) return null;

        return {
          productVariantId: inv.productVariantId,
          sku: variant.sku,
          productName: product.name,
          variantName: variant.name,
          currentOnHand: inv.onHand,
          reorderPoint: inv.reorderPoint,
          suggestedQty: inv.reorderPoint * 2 - inv.onHand,
          unitCost: variant.cost ?? 0,
        };
      })
      .filter((item): item is ReorderItem => item !== null)
      .sort(
        (a, b) =>
          a.currentOnHand / a.reorderPoint - b.currentOnHand / b.reorderPoint
      );
  }, [inventory, variantMap, productMap]);

  // Handle select all
  const handleSelectAll = (checked: boolean) => {
    setSelectAll(checked);
    if (checked) {
      setSelectedIds(new Set(lowStockItems.map((item) => item.productVariantId)));
    } else {
      setSelectedIds(new Set());
    }
  };

  // Handle individual item selection
  const handleSelectItem = (variantId: string, checked: boolean) => {
    const newSelected = new Set(selectedIds);
    if (checked) {
      newSelected.add(variantId);
    } else {
      newSelected.delete(variantId);
    }
    setSelectedIds(newSelected);
    setSelectAll(newSelected.size === lowStockItems.length && lowStockItems.length > 0);
  };

  // Calculate summary metrics
  const selectedItems = lowStockItems.filter((item) =>
    selectedIds.has(item.productVariantId)
  );
  const estimatedOrderValue = selectedItems.reduce(
    (sum, item) => sum + item.suggestedQty * item.unitCost,
    0
  );

  // Handle generate PO
  const handleGeneratePO = () => {
    onGeneratePO?.(selectedItems);
  };

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Items below reorder point</p>
          <p className="mt-1 text-2xl font-semibold">{lowStockItems.length}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Selected for reorder</p>
          <p className="mt-1 text-2xl font-semibold">{selectedIds.size}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Estimated order value</p>
          <p className="mt-1 text-2xl font-semibold">${estimatedOrderValue.toFixed(2)}</p>
        </div>
      </div>

      {lowStockItems.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-6 py-8 text-center">
          <p className="text-sm text-zinc-500">All items are above their reorder points.</p>
        </div>
      ) : (
        <>
          {/* Items Table */}
          <div className="rounded-2xl border border-zinc-200 bg-white overflow-hidden">
            {/* Header with Select All */}
            <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-3">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selectAll}
                  onChange={(e) => handleSelectAll(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                <span className="text-sm font-semibold text-zinc-700">Select all items</span>
              </div>
            </div>

            {/* Column Headers */}
            <div className="grid grid-cols-12 gap-3 border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-xs font-semibold uppercase text-zinc-500">
              <div className="col-span-1"></div>
              <div className="col-span-4">Product</div>
              <div className="col-span-2 text-right">On Hand</div>
              <div className="col-span-2 text-right">Reorder Point</div>
              <div className="col-span-2 text-right">Suggested Qty</div>
              <div className="col-span-1 text-right">Unit Cost</div>
            </div>

            {/* Items */}
            <div className="divide-y divide-zinc-100">
              {lowStockItems.map((item) => {
                const isOutOfStock = item.currentOnHand === 0;
                const isSelected = selectedIds.has(item.productVariantId);

                return (
                  <div
                    key={item.productVariantId}
                    className={`grid grid-cols-12 gap-3 px-4 py-3 items-center transition-colors ${
                      isSelected ? "bg-teal-50" : ""
                    }`}
                  >
                    {/* Checkbox */}
                    <div className="col-span-1 flex justify-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) =>
                          handleSelectItem(item.productVariantId, e.target.checked)
                        }
                        className="rounded border-zinc-300"
                      />
                    </div>

                    {/* Product Info */}
                    <div className="col-span-4">
                      <p className="text-sm font-medium text-zinc-900">{item.productName}</p>
                      <p className="text-xs text-zinc-500">{item.variantName}</p>
                      <p className="text-xs text-zinc-400 font-mono">{item.sku}</p>
                    </div>

                    {/* Current On Hand */}
                    <div className="col-span-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-sm font-semibold text-zinc-900">
                          {item.currentOnHand}
                        </span>
                        {isOutOfStock && (
                          <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                            Out of stock
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Reorder Point */}
                    <div className="col-span-2 text-right text-sm font-medium text-zinc-700">
                      {item.reorderPoint}
                    </div>

                    {/* Suggested Quantity */}
                    <div className="col-span-2 text-right">
                      <span className="text-sm font-semibold text-teal-700">
                        {item.suggestedQty}
                      </span>
                    </div>

                    {/* Unit Cost */}
                    <div className="col-span-1 text-right text-xs text-zinc-500">
                      ${item.unitCost.toFixed(2)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Action Button */}
          <button
            onClick={handleGeneratePO}
            disabled={selectedIds.size === 0}
            className="touch-button rounded-2xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Generate draft PO ({selectedIds.size} {selectedIds.size === 1 ? "item" : "items"})
          </button>
        </>
      )}
    </div>
  );
}
