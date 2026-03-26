"use client";

import { useState, useMemo } from "react";
import { SectionCard } from "@/components/ui/section-card";
import type { Product, ProductVariant, Category, InventoryLevel } from "@/lib/domain/types";

interface ProfitMarginDashboardProps {
  products: Product[];
  variants: ProductVariant[];
  categories: Category[];
  inventory: InventoryLevel[];
}

type SortField = "productName" | "variant" | "sku" | "price" | "cost" | "marginDollar" | "marginPercent" | "onHand" | "potentialRevenue";
type SortOrder = "asc" | "desc";

interface VariantRow {
  variant: ProductVariant;
  product: Product | null;
  category: Category | null;
  onHand: number;
  marginDollar: number;
  marginPercent: number;
  potentialRevenue: number;
  hasCostData: boolean;
  productName: string;
}

export function ProfitMarginDashboard({
  products,
  variants,
  categories,
  inventory,
}: ProfitMarginDashboardProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("marginPercent");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const inventoryMap = useMemo(
    () => new Map(inventory.map((inv) => [inv.productVariantId, inv])),
    [inventory]
  );

  // Build variant rows with calculations
  const variantRows = useMemo(() => {
    return variants
      .map((variant) => {
        const product = productMap.get(variant.productId) ?? null;
        const category = product ? categoryMap.get(product.categoryId) ?? null : null;
        const inv = inventoryMap.get(variant.id);
        const onHand = inv?.onHand ?? 0;

        const hasCostData = variant.cost != null && variant.cost > 0;
        const marginDollar = hasCostData ? variant.price - (variant.cost ?? 0) : 0;
        const marginPercent = hasCostData && variant.cost ? ((marginDollar / variant.cost) * 100) : 0;
        const potentialRevenue = onHand * variant.price;

        return {
          variant,
          product,
          category,
          onHand,
          marginDollar,
          marginPercent,
          potentialRevenue,
          hasCostData,
          productName: product?.name ?? "Unknown Product",
        };
      })
      .filter((row) => selectedCategory === "all" || row.category?.id === selectedCategory);
  }, [variants, productMap, categoryMap, inventoryMap, selectedCategory]);

  // Calculate KPIs
  const kpis = useMemo(() => {
    let totalRetailValue = 0;
    let totalCostValue = 0;
    let totalPotentialRevenue = 0;

    variantRows.forEach((row) => {
      const retailValue = row.onHand * row.variant.price;
      const costValue = row.hasCostData && row.variant.cost ? row.onHand * row.variant.cost : 0;

      totalRetailValue += retailValue;
      totalCostValue += costValue;
      totalPotentialRevenue += row.potentialRevenue;
    });

    const overallMarginPercent = totalCostValue > 0 ? ((totalRetailValue - totalCostValue) / totalCostValue) * 100 : 0;

    // Weighted average margin based on inventory levels
    let weightedMarginSum = 0;
    let weightSum = 0;
    variantRows.forEach((row) => {
      if (row.hasCostData && row.onHand > 0) {
        weightedMarginSum += row.marginPercent * row.onHand;
        weightSum += row.onHand;
      }
    });
    const weightedAvgMargin = weightSum > 0 ? weightedMarginSum / weightSum : 0;

    // Highest and lowest margin
    const withMargin = variantRows.filter((r) => r.hasCostData);
    const highestMargin = withMargin.length > 0 ? withMargin.reduce((max, r) => (r.marginPercent > max.marginPercent ? r : max)) : null;
    const lowestMargin = withMargin.length > 0 ? withMargin.reduce((min, r) => (r.marginPercent < min.marginPercent ? r : min)) : null;

    return {
      totalRetailValue,
      totalCostValue,
      overallMarginPercent,
      weightedAvgMargin,
      highestMargin,
      lowestMargin,
      variantCount: variantRows.length,
    };
  }, [variantRows]);

  // Category-level margin summary
  const categoryMarginSummary = useMemo(() => {
    const grouped: Record<string, { totalRetailValue: number; totalCostValue: number; count: number }> = {};

    variantRows.forEach((row) => {
      const catId = row.category?.id ?? "unknown";
      const catName = row.category?.name ?? "Unknown";

      if (!grouped[catId]) {
        grouped[catId] = { totalRetailValue: 0, totalCostValue: 0, count: 0 };
      }

      const retailValue = row.onHand * row.variant.price;
      const costValue = row.hasCostData && row.variant.cost ? row.onHand * row.variant.cost : 0;

      grouped[catId].totalRetailValue += retailValue;
      grouped[catId].totalCostValue += costValue;
      grouped[catId].count += 1;
    });

    return Object.entries(grouped)
      .map(([catId, data]) => {
        const margin = data.totalCostValue > 0 ? ((data.totalRetailValue - data.totalCostValue) / data.totalCostValue) * 100 : 0;
        const category = categoryMap.get(catId);
        return {
          categoryId: catId,
          categoryName: category?.name ?? "Unknown",
          margin,
          variantCount: data.count,
        };
      })
      .sort((a, b) => b.margin - a.margin);
  }, [variantRows, categoryMap]);

  // Sort variant rows
  const sortedRows = useMemo(() => {
    const sorted = [...variantRows];
    sorted.sort((a, b) => {
      let aVal: string | number = "";
      let bVal: string | number = "";

      switch (sortField) {
        case "productName":
          aVal = a.productName.toLowerCase();
          bVal = b.productName.toLowerCase();
          break;
        case "variant":
          aVal = a.variant.name.toLowerCase();
          bVal = b.variant.name.toLowerCase();
          break;
        case "sku":
          aVal = a.variant.sku.toLowerCase();
          bVal = b.variant.sku.toLowerCase();
          break;
        case "price":
          aVal = a.variant.price;
          bVal = b.variant.price;
          break;
        case "cost":
          aVal = a.variant.cost ?? 0;
          bVal = b.variant.cost ?? 0;
          break;
        case "marginDollar":
          aVal = a.marginDollar;
          bVal = b.marginDollar;
          break;
        case "marginPercent":
          aVal = a.marginPercent;
          bVal = b.marginPercent;
          break;
        case "onHand":
          aVal = a.onHand;
          bVal = b.onHand;
          break;
        case "potentialRevenue":
          aVal = a.potentialRevenue;
          bVal = b.potentialRevenue;
          break;
      }

      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortOrder === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      const numA = typeof aVal === "number" ? aVal : 0;
      const numB = typeof bVal === "number" ? bVal : 0;
      return sortOrder === "asc" ? numA - numB : numB - numA;
    });

    return sorted;
  }, [variantRows, sortField, sortOrder]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const getMarginColor = (marginPercent: number) => {
    if (marginPercent >= 50) return "bg-green-50 text-green-700";
    if (marginPercent >= 25) return "bg-amber-50 text-amber-700";
    return "bg-red-50 text-red-700";
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(value);
  };

  return (
    <div className="space-y-6">
      {/* Summary KPIs */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
          <p className="text-sm text-zinc-500">Total retail value</p>
          <p className="mt-2 text-2xl font-semibold">{formatCurrency(kpis.totalRetailValue)}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
          <p className="text-sm text-zinc-500">Total cost value</p>
          <p className="mt-2 text-2xl font-semibold">{formatCurrency(kpis.totalCostValue)}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
          <p className="text-sm text-zinc-500">Overall margin %</p>
          <p className="mt-2 text-2xl font-semibold">{kpis.overallMarginPercent.toFixed(1)}%</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
          <p className="text-sm text-zinc-500">Weighted avg margin</p>
          <p className="mt-2 text-2xl font-semibold">{kpis.weightedAvgMargin.toFixed(1)}%</p>
        </div>

        {kpis.highestMargin && (
          <div className="rounded-2xl border border-teal-200 bg-teal-50 px-4 py-4">
            <p className="text-sm text-teal-700">Highest margin item</p>
            <p className="mt-1 text-sm font-semibold truncate">{kpis.highestMargin.productName}</p>
            <p className="text-lg font-semibold text-teal-900">{kpis.highestMargin.marginPercent.toFixed(1)}%</p>
          </div>
        )}

        {kpis.lowestMargin && (
          <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-4">
            <p className="text-sm text-orange-700">Lowest margin item</p>
            <p className="mt-1 text-sm font-semibold truncate">{kpis.lowestMargin.productName}</p>
            <p className="text-lg font-semibold text-orange-900">{kpis.lowestMargin.marginPercent.toFixed(1)}%</p>
          </div>
        )}
      </div>

      {/* Category-level margin summary */}
      {categoryMarginSummary.length > 0 && (
        <SectionCard title="Category margin summary" description="Average margin by category">
          <div className="space-y-2">
            {categoryMarginSummary.map((cat) => (
              <div key={cat.categoryId} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold">{cat.categoryName}</p>
                  <p className="text-xs text-zinc-500">{cat.variantCount} variants</p>
                </div>
                <div className="text-right">
                  <p className={`text-lg font-semibold ${cat.margin >= 50 ? "text-green-700" : cat.margin >= 25 ? "text-amber-700" : "text-red-700"}`}>
                    {cat.margin.toFixed(1)}%
                  </p>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Variant table */}
      <SectionCard title="Variant details" description="Click column headers to sort">
        <div className="space-y-3">
          {/* Category filter */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-zinc-700">Filter by category:</label>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
            >
              <option value="all">All categories</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-lg border border-zinc-200">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50">
                <tr>
                  <th className="cursor-pointer px-4 py-3 text-left font-semibold text-zinc-700 hover:bg-zinc-100" onClick={() => toggleSort("productName")}>
                    <div className="flex items-center gap-2">
                      Product {sortField === "productName" && <span className="text-xs">{sortOrder === "asc" ? "↑" : "↓"}</span>}
                    </div>
                  </th>
                  <th className="cursor-pointer px-4 py-3 text-left font-semibold text-zinc-700 hover:bg-zinc-100" onClick={() => toggleSort("variant")}>
                    <div className="flex items-center gap-2">
                      Variant {sortField === "variant" && <span className="text-xs">{sortOrder === "asc" ? "↑" : "↓"}</span>}
                    </div>
                  </th>
                  <th className="cursor-pointer px-4 py-3 text-left font-semibold text-zinc-700 hover:bg-zinc-100" onClick={() => toggleSort("sku")}>
                    <div className="flex items-center gap-2">
                      SKU {sortField === "sku" && <span className="text-xs">{sortOrder === "asc" ? "↑" : "↓"}</span>}
                    </div>
                  </th>
                  <th className="cursor-pointer px-4 py-3 text-right font-semibold text-zinc-700 hover:bg-zinc-100" onClick={() => toggleSort("price")}>
                    <div className="flex items-center justify-end gap-2">
                      Price {sortField === "price" && <span className="text-xs">{sortOrder === "asc" ? "↑" : "↓"}</span>}
                    </div>
                  </th>
                  <th className="cursor-pointer px-4 py-3 text-right font-semibold text-zinc-700 hover:bg-zinc-100" onClick={() => toggleSort("cost")}>
                    <div className="flex items-center justify-end gap-2">
                      Cost {sortField === "cost" && <span className="text-xs">{sortOrder === "asc" ? "↑" : "↓"}</span>}
                    </div>
                  </th>
                  <th className="cursor-pointer px-4 py-3 text-right font-semibold text-zinc-700 hover:bg-zinc-100" onClick={() => toggleSort("marginDollar")}>
                    <div className="flex items-center justify-end gap-2">
                      Margin $ {sortField === "marginDollar" && <span className="text-xs">{sortOrder === "asc" ? "↑" : "↓"}</span>}
                    </div>
                  </th>
                  <th className="cursor-pointer px-4 py-3 text-right font-semibold text-zinc-700 hover:bg-zinc-100" onClick={() => toggleSort("marginPercent")}>
                    <div className="flex items-center justify-end gap-2">
                      Margin % {sortField === "marginPercent" && <span className="text-xs">{sortOrder === "asc" ? "↑" : "↓"}</span>}
                    </div>
                  </th>
                  <th className="cursor-pointer px-4 py-3 text-right font-semibold text-zinc-700 hover:bg-zinc-100" onClick={() => toggleSort("onHand")}>
                    <div className="flex items-center justify-end gap-2">
                      Stock {sortField === "onHand" && <span className="text-xs">{sortOrder === "asc" ? "↑" : "↓"}</span>}
                    </div>
                  </th>
                  <th className="cursor-pointer px-4 py-3 text-right font-semibold text-zinc-700 hover:bg-zinc-100" onClick={() => toggleSort("potentialRevenue")}>
                    <div className="flex items-center justify-end gap-2">
                      Potential $ {sortField === "potentialRevenue" && <span className="text-xs">{sortOrder === "asc" ? "↑" : "↓"}</span>}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {sortedRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-6 text-center text-sm text-zinc-500">
                      No variants found for selected category.
                    </td>
                  </tr>
                ) : (
                  sortedRows.map((row) => (
                    <tr key={row.variant.id} className="hover:bg-zinc-50">
                      <td className="px-4 py-3 text-sm font-medium text-zinc-900">{row.productName}</td>
                      <td className="px-4 py-3 text-sm text-zinc-700">{row.variant.name}</td>
                      <td className="px-4 py-3 text-sm font-mono text-zinc-600">{row.variant.sku}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium">{formatCurrency(row.variant.price)}</td>
                      <td className="px-4 py-3 text-right text-sm">
                        {row.hasCostData ? (
                          formatCurrency(row.variant.cost ?? 0)
                        ) : (
                          <span className="text-xs text-zinc-400">no cost data</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium">
                        {row.hasCostData ? formatCurrency(row.marginDollar) : <span className="text-xs text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {row.hasCostData ? (
                          <span className={`inline-block rounded-lg px-3 py-1 font-semibold ${getMarginColor(row.marginPercent)}`}>
                            {row.marginPercent.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-zinc-900">{row.onHand}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium">{formatCurrency(row.potentialRevenue)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {sortedRows.length > 0 && (
            <p className="text-xs text-zinc-500">
              Showing {sortedRows.length} of {variants.length} variants
            </p>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
