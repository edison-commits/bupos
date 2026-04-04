import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";

const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";

/**
 * GET /api/dashboard
 *
 * Real-time sales dashboard. Optimized for Cloudflare Workers (minimal DB round-trips).
 *
 * Query params:
 *   location — location ID (defaults to Bellflower)
 *   date     — YYYY-MM-DD (defaults to today)
 *   range    — "today" | "week" | "month" (defaults to today)
 */
export async function GET(req: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  if (!adminCtx && !registerCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const sp = req.nextUrl.searchParams;
    const locationId = sp.get("location") || "c57268b3-cb14-4c1a-bda6-55e49ddc6313";
    const range = sp.get("range") || "today";

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    let fromDate: string;
    const toDate = `${todayStr}T23:59:59.999Z`;

    if (range === "week") {
      const d = new Date(now); d.setDate(d.getDate() - 7);
      fromDate = `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
    } else if (range === "month") {
      const d = new Date(now); d.setDate(d.getDate() - 30);
      fromDate = `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
    } else {
      const date = sp.get("date") || todayStr;
      fromDate = `${date}T00:00:00.000Z`;
    }

    // Run key queries in parallel to minimize Worker CPU time
    const [metricsResult, tenderResult, hourlyResult, employeeResult, lowStockResult, recentResult] = await Promise.all([
      // 1. Key metrics
      orgQuery(
        ORG_ID,
        `SELECT
           COUNT(*) FILTER (WHERE status = 'completed')::int AS transaction_count,
           COUNT(*) FILTER (WHERE status = 'voided')::int AS void_count,
           COUNT(*) FILTER (WHERE status = 'refunded')::int AS refund_count,
           COALESCE(SUM(grand_total) FILTER (WHERE status = 'completed'), 0)::numeric AS gross_sales,
           COALESCE(SUM(discount_total) FILTER (WHERE status = 'completed'), 0)::numeric AS total_discounts,
           COALESCE(SUM(tax_total) FILTER (WHERE status = 'completed'), 0)::numeric AS total_tax,
           COALESCE(AVG(grand_total) FILTER (WHERE status = 'completed'), 0)::numeric AS avg_ticket,
           COALESCE(MAX(grand_total) FILTER (WHERE status = 'completed'), 0)::numeric AS largest_sale
         FROM transactions
         WHERE location_id = $1 AND created_at >= $2 AND created_at <= $3`,
        [locationId, fromDate, toDate],
      ),

      // 2. Tender breakdown
      orgQuery(
        ORG_ID,
        `SELECT tt.tender_type, SUM(tt.amount)::numeric AS total, COUNT(*)::int AS count
         FROM transaction_tenders tt
         JOIN transactions t ON t.id = tt.transaction_id
         WHERE t.location_id = $1 AND t.created_at >= $2 AND t.created_at <= $3 AND t.status = 'completed'
         GROUP BY tt.tender_type
         ORDER BY total DESC`,
        [locationId, fromDate, toDate],
      ),

      // 3. Hourly breakdown
      orgQuery(
        ORG_ID,
        `SELECT
           EXTRACT(HOUR FROM created_at)::int AS hour,
           COUNT(*)::int AS count,
           SUM(grand_total)::numeric AS total
         FROM transactions
         WHERE location_id = $1 AND created_at >= $2 AND created_at <= $3 AND status = 'completed'
         GROUP BY EXTRACT(HOUR FROM created_at)
         ORDER BY hour`,
        [locationId, fromDate, toDate],
      ),

      // 4. Employee performance
      orgQuery(
        ORG_ID,
        `SELECT t.employee_id, e.display_name,
                COUNT(*)::int AS transaction_count,
                SUM(t.grand_total)::numeric AS total_sales,
                AVG(t.grand_total)::numeric AS avg_ticket
         FROM transactions t
         LEFT JOIN employees e ON e.id = t.employee_id
         WHERE t.location_id = $1 AND t.created_at >= $2 AND t.created_at <= $3 AND t.status = 'completed'
         GROUP BY t.employee_id, e.display_name
         ORDER BY total_sales DESC`,
        [locationId, fromDate, toDate],
      ),

      // 5. Low stock alerts
      orgQuery(
        ORG_ID,
        `SELECT il.on_hand, il.reorder_point, pv.sku, pv.barcode, p.name AS product_name,
                pv.size_label AS size, pv.color_label AS color
         FROM inventory_levels il
         JOIN product_variants pv ON pv.id = il.product_variant_id
         JOIN products p ON p.id = pv.product_id
         WHERE il.location_id = $1 AND il.on_hand <= il.reorder_point AND il.reorder_point > 0
         ORDER BY (il.on_hand::float / NULLIF(il.reorder_point, 0)) ASC
         LIMIT 10`,
        [locationId],
      ),

      // 6. Recent transactions
      orgQuery(
        ORG_ID,
        `SELECT t.id, t.grand_total, t.tender_type, t.status, t.created_at,
                e.display_name AS employee_name
         FROM transactions t
         LEFT JOIN employees e ON e.id = t.employee_id
         WHERE t.location_id = $1 AND t.created_at >= $2 AND t.created_at <= $3
         ORDER BY t.created_at DESC
         LIMIT 10`,
        [locationId, fromDate, toDate],
      ),
    ]);

    const m = metricsResult.rows[0];

    const hourlyBreakdown = hourlyResult.rows.map((r: Record<string, unknown>) => ({
      hour: r.hour,
      label: `${(r.hour as number) % 12 || 12}${(r.hour as number) < 12 ? "am" : "pm"}`,
      count: r.count,
      total: Number(Number(r.total).toFixed(2)),
    }));

    return NextResponse.json({
      range,
      fromDate,
      toDate,
      metrics: {
        grossSales: Number(Number(m.gross_sales).toFixed(2)),
        totalDiscounts: Number(Number(m.total_discounts).toFixed(2)),
        totalTax: Number(Number(m.total_tax).toFixed(2)),
        netSales: Number((Number(m.gross_sales) - Number(m.total_discounts)).toFixed(2)),
        transactionCount: m.transaction_count,
        voidCount: m.void_count,
        refundCount: m.refund_count,
        avgTicket: Number(Number(m.avg_ticket).toFixed(2)),
        largestSale: Number(Number(m.largest_sale).toFixed(2)),
      },
      hourlyBreakdown,
      tenderBreakdown: tenderResult.rows,
      employeePerformance: employeeResult.rows,
      recentTransactions: recentResult.rows,
      lowStockAlerts: lowStockResult.rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("GET /api/dashboard error:", message);
    return NextResponse.json({ error: "Failed to load dashboard", detail: message }, { status: 500 });
  }
}
