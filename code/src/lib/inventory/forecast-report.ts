import { orgQuery } from "@/lib/supabase-rest";
import { calculateStockoutForecast, type StockoutRisk } from "@/lib/inventory/forecast";

export interface InventoryForecastParams {
  orgId: string;
  locationId?: string;
  risk?: StockoutRisk | "all";
  limit?: number;
}

export interface InventoryForecastRow {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  variantId: string;
  variantName: string | null;
  sku: string;
  sizeLabel: string | null;
  colorLabel: string | null;
  supplierId: string | null;
  supplierName: string | null;
  onHand: number;
  reorderPoint: number;
  unitsSold30: number;
  unitsSold90: number;
  unitsSold365: number;
  predictedDailyDemand: number;
  daysUntilStockout: number | null;
  risk: StockoutRisk;
  suggestedReorderQty: number;
  confidence: "high" | "medium" | "low";
}

function parseInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function boundedLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 500;
  return Math.max(1, Math.min(500, Math.floor(limit)));
}

function sortByRisk(a: InventoryForecastRow, b: InventoryForecastRow): number {
  const rank: Record<StockoutRisk, number> = { critical: 0, soon: 1, watch: 2, unknown: 3, healthy: 4 };
  const riskDelta = rank[a.risk] - rank[b.risk];
  if (riskDelta !== 0) return riskDelta;
  const aDays = a.daysUntilStockout ?? Number.POSITIVE_INFINITY;
  const bDays = b.daysUntilStockout ?? Number.POSITIVE_INFINITY;
  return aDays - bDays;
}

export async function getInventoryForecast(params: InventoryForecastParams): Promise<InventoryForecastRow[]> {
  const limit = boundedLimit(params.limit);
  const queryParams: unknown[] = [params.orgId];
  let locationFilter = "";
  if (params.locationId) {
    queryParams.push(params.locationId);
    locationFilter = `AND il.location_id = $${queryParams.length}`;
  }
  queryParams.push(limit);

  const result = await orgQuery(
    params.orgId,
    `WITH sold AS (
       SELECT
         t.location_id,
         (item.value->>'productVariantId')::uuid AS variant_id,
         COALESCE(SUM(CASE WHEN t.created_at >= now() - interval '30 days' THEN (item.value->>'quantity')::integer ELSE 0 END), 0) AS units_sold_30,
         COALESCE(SUM(CASE WHEN t.created_at >= now() - interval '90 days' THEN (item.value->>'quantity')::integer ELSE 0 END), 0) AS units_sold_90,
         COALESCE(SUM((item.value->>'quantity')::integer), 0) AS units_sold_365,
         COUNT(DISTINCT DATE(t.created_at)) AS history_days_365
       FROM transactions t
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.cart_snapshot::jsonb -> 'items', '[]'::jsonb)) AS item(value)
       WHERE t.organization_id = $1
         AND t.status = 'completed'
         AND t.grand_total > 0
         AND t.created_at >= now() - interval '365 days'
       GROUP BY t.location_id, (item.value->>'productVariantId')::uuid
     )
     SELECT
       il.location_id,
       COALESCE(l.name, l.code, 'Unknown Store') AS location_name,
       p.id AS product_id,
       p.name AS product_name,
       pv.id AS variant_id,
       pv.name AS variant_name,
       pv.sku,
       pv.size_label,
       pv.color_label,
       p.supplier_id,
       s.name AS supplier_name,
       il.on_hand,
       il.reorder_point,
       COALESCE(sold.units_sold_30, 0) AS units_sold_30,
       COALESCE(sold.units_sold_90, 0) AS units_sold_90,
       COALESCE(sold.units_sold_365, 0) AS units_sold_365,
       COALESCE(sold.history_days_365, 0) AS history_days_365
     FROM inventory_levels il
     JOIN product_variants pv ON il.product_variant_id = pv.id AND pv.organization_id = $1
     JOIN products p ON pv.product_id = p.id AND p.organization_id = $1
     LEFT JOIN suppliers s ON p.supplier_id = s.id AND s.organization_id = $1
     LEFT JOIN locations l ON il.location_id = l.id AND l.organization_id = $1
     LEFT JOIN sold ON sold.location_id = il.location_id AND sold.variant_id = pv.id
     WHERE il.organization_id = $1
       ${locationFilter}
     ORDER BY p.name ASC, pv.name ASC
     LIMIT $${queryParams.length}`,
    queryParams,
  );

  return result.rows
    .map((row: Record<string, unknown>): InventoryForecastRow => {
      const onHand = parseInteger(row.on_hand);
      const reorderPoint = parseInteger(row.reorder_point);
      const unitsSold30 = parseInteger(row.units_sold_30);
      const unitsSold90 = parseInteger(row.units_sold_90);
      const unitsSold365 = parseInteger(row.units_sold_365);
      const historyDays365 = parseInteger(row.history_days_365);
      const forecast = calculateStockoutForecast({
        onHand,
        reorderPoint,
        last30: { days: Math.min(30, historyDays365 || 30), unitsSold: unitsSold30 },
        last90: { days: Math.min(90, historyDays365 || 90), unitsSold: unitsSold90 },
        last365: { days: Math.min(365, historyDays365 || 365), unitsSold: unitsSold365 },
      });

      return {
        locationId: String(row.location_id),
        locationName: String(row.location_name ?? "Unknown Store"),
        productId: String(row.product_id),
        productName: String(row.product_name),
        variantId: String(row.variant_id),
        variantName: nullableString(row.variant_name),
        sku: String(row.sku ?? ""),
        sizeLabel: nullableString(row.size_label),
        colorLabel: nullableString(row.color_label),
        supplierId: nullableString(row.supplier_id),
        supplierName: nullableString(row.supplier_name),
        onHand,
        reorderPoint,
        unitsSold30,
        unitsSold90,
        unitsSold365,
        predictedDailyDemand: forecast.predictedDailyDemand,
        daysUntilStockout: forecast.daysUntilStockout,
        risk: forecast.risk,
        suggestedReorderQty: forecast.suggestedReorderQty,
        confidence: forecast.confidence,
      };
    })
    .filter((row) => !params.risk || params.risk === "all" || row.risk === params.risk)
    .sort(sortByRisk);
}

export function summarizeInventoryForecast(rows: InventoryForecastRow[]): Record<StockoutRisk, number> {
  return rows.reduce<Record<StockoutRisk, number>>((acc, row) => {
    acc[row.risk] += 1;
    return acc;
  }, { critical: 0, soon: 0, watch: 0, healthy: 0, unknown: 0 });
}
