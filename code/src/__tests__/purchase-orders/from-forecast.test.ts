import { describe, expect, it } from "vitest";
import { groupForecastRowsForPurchaseOrders } from "@/lib/purchase-orders/from-forecast";
import type { InventoryForecastRow } from "@/lib/inventory/forecast-report";

function row(overrides: Partial<InventoryForecastRow>): InventoryForecastRow {
  return {
    locationId: "loc-1",
    locationName: "Main",
    productId: "prod-1",
    productName: "Polo",
    variantId: "var-1",
    variantName: "Polo / M",
    sku: "POLO-M",
    sizeLabel: "M",
    colorLabel: null,
    supplierId: "sup-1",
    supplierName: "Uniform Co",
    unitCost: 12.5,
    onHand: 3,
    reorderPoint: 10,
    unitsSold30: 30,
    unitsSold90: 90,
    unitsSold365: 365,
    predictedDailyDemand: 1,
    daysUntilStockout: 3,
    risk: "critical",
    suggestedReorderQty: 25,
    confidence: "high",
    ...overrides,
  };
}

describe("groupForecastRowsForPurchaseOrders", () => {
  it("groups actionable forecast rows by supplier and location", () => {
    const result = groupForecastRowsForPurchaseOrders([
      row({ variantId: "var-1", supplierId: "sup-1", locationId: "loc-1", suggestedReorderQty: 12, unitCost: 10 }),
      row({ variantId: "var-2", supplierId: "sup-1", locationId: "loc-1", suggestedReorderQty: 5, unitCost: 8 }),
      row({ variantId: "var-3", supplierId: "sup-2", supplierName: "Other", locationId: "loc-1", suggestedReorderQty: 7, unitCost: 6 }),
      row({ variantId: "var-4", supplierId: "sup-1", locationId: "loc-2", locationName: "Second", suggestedReorderQty: 9, unitCost: 3 }),
    ]);

    expect(result.drafts).toEqual([
      {
        supplierId: "sup-1",
        supplierName: "Uniform Co",
        locationId: "loc-1",
        locationName: "Main",
        lines: [
          expect.objectContaining({ productVariantId: "var-1", quantity: 12, unitCost: 10 }),
          expect.objectContaining({ productVariantId: "var-2", quantity: 5, unitCost: 8 }),
        ],
      },
      {
        supplierId: "sup-1",
        supplierName: "Uniform Co",
        locationId: "loc-2",
        locationName: "Second",
        lines: [expect.objectContaining({ productVariantId: "var-4", quantity: 9, unitCost: 3 })],
      },
      {
        supplierId: "sup-2",
        supplierName: "Other",
        locationId: "loc-1",
        locationName: "Main",
        lines: [expect.objectContaining({ productVariantId: "var-3", quantity: 7, unitCost: 6 })],
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("skips rows without a supplier or suggested quantity", () => {
    const result = groupForecastRowsForPurchaseOrders([
      row({ variantId: "var-ok", suggestedReorderQty: 4 }),
      row({ variantId: "var-nosupplier", supplierId: null, supplierName: null }),
      row({ variantId: "var-zero", suggestedReorderQty: 0 }),
    ]);

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].lines).toHaveLength(1);
    expect(result.drafts[0].lines[0].productVariantId).toBe("var-ok");
    expect(result.skipped).toEqual([
      { productVariantId: "var-nosupplier", sku: "POLO-M", productName: "Polo", reason: "missing_supplier" },
      { productVariantId: "var-zero", sku: "POLO-M", productName: "Polo", reason: "no_suggested_quantity" },
    ]);
  });
});
