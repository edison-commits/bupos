import { orgQuery } from "@/lib/supabase-rest";
import { buildOrgDayRange } from "@/lib/reports/day-range";

export type SalesGroupBy = "day" | "month" | "year";

export interface SalesByStoreParams {
  orgId: string;
  from: string;
  to: string;
  groupBy: SalesGroupBy;
  locationIds?: string[];
}

export interface SalesByStoreRow {
  locationId: string;
  locationName: string;
  period: string;
  revenue: number;
  transactionCount: number;
  unitsSold: number;
  avgTicket: number;
  refundCount: number;
  returnTotal: number;
}

const PERIOD_SQL: Record<SalesGroupBy, string> = {
  day: "TO_CHAR(DATE_TRUNC('day', t.created_at AT TIME ZONE COALESCE(org_tz.timezone, 'UTC')), 'YYYY-MM-DD')",
  month: "TO_CHAR(DATE_TRUNC('month', t.created_at AT TIME ZONE COALESCE(org_tz.timezone, 'UTC')), 'YYYY-MM')",
  year: "TO_CHAR(DATE_TRUNC('year', t.created_at AT TIME ZONE COALESCE(org_tz.timezone, 'UTC')), 'YYYY')",
};

function parseNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getSalesByStorePeriod(params: SalesByStoreParams): Promise<SalesByStoreRow[]> {
  const { orgId, from, to, groupBy, locationIds } = params;
  const periodSql = PERIOD_SQL[groupBy];
  const { fromTs, toTs } = await buildOrgDayRange(orgId, from, to);
  const queryParams: unknown[] = [orgId, fromTs, toTs];

  let locationFilter = "";
  if (locationIds && locationIds.length > 0) {
    queryParams.push(locationIds);
    locationFilter = `AND t.location_id = ANY($${queryParams.length}::uuid[])`;
  }

  const result = await orgQuery(
    orgId,
    `WITH org_tz AS (
       SELECT timezone
       FROM organizations
       WHERE id = $1
     )
     SELECT
       t.location_id,
       COALESCE(l.name, l.code, 'Unknown Store') AS location_name,
       ${periodSql} AS period,
       COALESCE(SUM(t.grand_total), 0) AS revenue,
       COUNT(*) AS transaction_count,
       COALESCE(SUM(CASE WHEN t.grand_total > 0 THEN (item.value->>'quantity')::integer ELSE 0 END), 0) AS units_sold,
       CASE
         WHEN COUNT(CASE WHEN t.grand_total > 0 THEN 1 END) > 0
         THEN COALESCE(SUM(CASE WHEN t.grand_total > 0 THEN t.grand_total ELSE 0 END), 0) / COUNT(CASE WHEN t.grand_total > 0 THEN 1 END)
         ELSE 0
       END AS avg_ticket,
       COUNT(CASE WHEN t.grand_total < 0 THEN 1 END) AS refund_count,
       COALESCE(SUM(CASE WHEN t.grand_total < 0 THEN ABS(t.grand_total) ELSE 0 END), 0) AS return_total
     FROM transactions t
     CROSS JOIN org_tz
     JOIN locations l ON l.id = t.location_id AND l.organization_id = $1
     LEFT JOIN LATERAL jsonb_array_elements(COALESCE(t.cart_snapshot::jsonb -> 'items', '[]'::jsonb)) AS item(value) ON true
     WHERE t.organization_id = $1
       AND t.created_at >= $2
       AND t.created_at < $3
       AND t.status = 'completed'
       ${locationFilter}
     GROUP BY t.location_id, l.name, l.code, period
     ORDER BY period ASC, location_name ASC`,
    queryParams,
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    locationId: String(row.location_id),
    locationName: String(row.location_name ?? "Unknown Store"),
    period: String(row.period),
    revenue: parseNumber(row.revenue),
    transactionCount: parseInteger(row.transaction_count),
    unitsSold: parseInteger(row.units_sold),
    avgTicket: parseNumber(row.avg_ticket),
    refundCount: parseInteger(row.refund_count),
    returnTotal: parseNumber(row.return_total),
  }));
}
