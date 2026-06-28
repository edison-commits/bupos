import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOrgQuery = vi.fn();

vi.mock("@/lib/supabase-rest", () => ({
  orgQuery: (...args: unknown[]) => mockOrgQuery(...args),
}));

const { getInventoryForecast } = await import("@/lib/inventory/forecast-report");

describe("getInventoryForecast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries inventory and maps stockout forecast rows", async () => {
    mockOrgQuery.mockResolvedValueOnce({
      rows: [
        {
          location_id: "loc-1",
          location_name: "Redondo",
          product_id: "prod-1",
          product_name: "Polo Shirt",
          variant_id: "var-1",
          variant_name: "Polo Shirt / M / Navy",
          sku: "POLO-M-NAVY",
          size_label: "M",
          color_label: "Navy",
          supplier_id: "sup-1",
          supplier_name: "Uniform Co",
          on_hand: "6",
          reorder_point: "10",
          units_sold_30: "30",
          units_sold_90: "90",
          units_sold_365: "365",
          history_days_365: "365",
        },
      ],
    });

    const rows = await getInventoryForecast({ orgId: "org-1", locationId: "loc-1" });

    expect(mockOrgQuery).toHaveBeenCalledTimes(1);
    const [orgId, sql, params] = mockOrgQuery.mock.calls[0];
    expect(orgId).toBe("org-1");
    expect(sql).toContain("FROM inventory_levels il");
    expect(sql).toContain("JOIN product_variants pv ON il.product_variant_id = pv.id AND pv.organization_id = $1");
    expect(sql).toContain("JOIN products p ON pv.product_id = p.id AND p.organization_id = $1");
    expect(sql).toContain("LEFT JOIN suppliers s ON p.supplier_id = s.id AND s.organization_id = $1");
    expect(sql).toContain("LEFT JOIN locations l ON il.location_id = l.id AND l.organization_id = $1");
    expect(sql).toContain("t.grand_total > 0");
    expect(sql).toContain("il.location_id = $2");
    expect(params).toEqual(["org-1", "loc-1", 500]);
    expect(rows).toEqual([
      expect.objectContaining({
        locationId: "loc-1",
        locationName: "Redondo",
        productId: "prod-1",
        productName: "Polo Shirt",
        variantId: "var-1",
        sku: "POLO-M-NAVY",
        onHand: 6,
        reorderPoint: 10,
        unitsSold30: 30,
        unitsSold90: 90,
        unitsSold365: 365,
        predictedDailyDemand: 1,
        daysUntilStockout: 6,
        risk: "critical",
        suggestedReorderQty: 22,
        confidence: "high",
      }),
    ]);
  });

  it("filters by risk after calculating forecasts", async () => {
    mockOrgQuery.mockResolvedValueOnce({
      rows: [
        {
          location_id: "loc-1",
          location_name: "Redondo",
          product_id: "prod-1",
          product_name: "Fast Item",
          variant_id: "var-1",
          variant_name: null,
          sku: "FAST",
          size_label: null,
          color_label: null,
          supplier_id: null,
          supplier_name: null,
          on_hand: "5",
          reorder_point: "10",
          units_sold_30: "30",
          units_sold_90: "90",
          units_sold_365: "365",
          history_days_365: "365",
        },
        {
          location_id: "loc-1",
          location_name: "Redondo",
          product_id: "prod-2",
          product_name: "Slow Item",
          variant_id: "var-2",
          variant_name: null,
          sku: "SLOW",
          size_label: null,
          color_label: null,
          supplier_id: null,
          supplier_name: null,
          on_hand: "100",
          reorder_point: "5",
          units_sold_30: "30",
          units_sold_90: "90",
          units_sold_365: "365",
          history_days_365: "365",
        },
      ],
    });

    const rows = await getInventoryForecast({ orgId: "org-1", risk: "critical" });

    expect(rows).toHaveLength(1);
    expect(rows[0].productName).toBe("Fast Item");
    expect(rows[0].risk).toBe("critical");
  });

  it("caps limit to 500 and omits location filter when location is not provided", async () => {
    mockOrgQuery.mockResolvedValueOnce({ rows: [] });

    await getInventoryForecast({ orgId: "org-1", limit: 9999 });

    const [, sql, params] = mockOrgQuery.mock.calls[0];
    expect(sql).not.toContain("il.location_id = $2");
    expect(params).toEqual(["org-1", 500]);
  });
});
