import { NextResponse } from "next/server";
import { orgTx } from "@/lib/supabase-rest";
import { withAuth } from "@/lib/api/with-auth";


import { safeErr } from "@/lib/logging/safe-err";
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
export const GET = withAuth("audit.view", async (req, ctx) => {
  const orgId = ctx.orgId;
  const sp = req.nextUrl.searchParams;
  // Cross-location read guard. audit.view is held by every role (including
  // inventory_clerk / support), so accepting a client-supplied ?location=
  // without verifying assignment let those roles read any location's sales,
  // tender mix, and employee performance. Owners and managers are allowed
  // to pass ANY location in the org (they see everything); other roles are
  // restricted to the locations in their assignment.
  const requestedLocation = sp.get("location");
  const isManager = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
  if (requestedLocation && !isManager && !(ctx.employee.locationIds ?? []).includes(requestedLocation)) {
    return NextResponse.json({ error: "Location not assigned to this employee" }, { status: 403 });
  }
  const locationId = requestedLocation ?? ctx.employee.locationIds?.[0];
  if (!locationId) {
    return NextResponse.json({ error: 'No location context' }, { status: 400 });
  }
  const range = sp.get("range") || "today";

  // R83-SEC-H2 (HIGH): use buildOrgDayRange instead of raw UTC
  // timestamps so dashboard aggregates honor the organization's
  // timezone. Prior shape bucketed on UTC midnight — a Pacific-TZ
  // store's "today" cut off at 4pm local (UTC midnight), and the
  // first 8 hours of tomorrow counted as today. Dashboard
  // disagreed with /api/reports summary for the same date.
  // Parity with R16-L-2 reports route + R82-DB-H3 eod-report.
  const { buildOrgDayRange } = await import("@/lib/reports/day-range");
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  let fromDay: string;
  let toDay: string;

  if (range === "week") {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    fromDay = d.toISOString().slice(0, 10);
    toDay = todayStr;
  } else if (range === "month") {
    const d = new Date(now); d.setDate(d.getDate() - 30);
    fromDay = d.toISOString().slice(0, 10);
    toDay = todayStr;
  } else {
    const date = sp.get("date") || todayStr;
    fromDay = date;
    toDay = date;
  }
  const { fromTs: fromDate, toTs: toDate } = await buildOrgDayRange(orgId, fromDay, toDay);

  try {
  // Run all 6 queries on ONE shared Neon client. The frontend polls this
  // endpoint every 60s, so a 6-way Promise.all of orgQuery() was creating
  // six concurrent WebSocket handshakes per poll per open tab. A busy back
  // office with 3 dashboards open = 18 pools per minute just for
  // this endpoint. Serialising on one orgTx client keeps the handshake
  // count at 1 without materially slowing the page (queries are fast).
  const client = await orgTx(orgId);
  let metricsResult, tenderResult, hourlyResult, employeeResult, lowStockResult, recentResult;
  try {
    // R27-C4: verify the requested `locationId` belongs to the caller's
    // org BEFORE running any dashboard query. Managers/owners bypass the
    // per-employee allowlist (they see everything in their own org), but
    // the owner-role check above did NOT block cross-tenant location
    // UUIDs. Without this, an owner at ORG A could pass ORG B's
    // location UUID and get ORG B's full revenue dashboard.
    const locCheck = await client.query(
      `SELECT 1 FROM locations WHERE id = $1 AND organization_id = $2`,
      [locationId, orgId],
    );
    if (locCheck.rows.length === 0) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      return NextResponse.json({ error: "Location not in this organization" }, { status: 403 });
    }

    // R27-C4: explicit organization_id filter on every query. All of
    // these had location_id-only scoping before, which matters now
    // because the postgres role bypasses RLS.
    // R82-DB-H2 (HIGH): sign-based filters. Register returns write
    // `status='completed'` with NEGATIVE grand_total (not
    // status='refunded' — that value is never used in the
    // register-side flow). Prior shape counted ZERO register
    // returns as refunds, counted refund rows as transactions
    // (inflating the count), averaged positive sales with negative
    // refunds (nonsensical avg_ticket). Mirror /api/reports
    // route.ts:149-151 which correctly splits by sign.
    metricsResult = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed' AND grand_total >= 0)::int AS transaction_count,
         COUNT(*) FILTER (WHERE status = 'voided')::int AS void_count,
         COUNT(*) FILTER (WHERE status = 'completed' AND grand_total < 0)::int AS refund_count,
         COALESCE(SUM(grand_total) FILTER (WHERE status = 'completed'), 0)::numeric AS gross_sales,
         COALESCE(SUM(discount_total) FILTER (WHERE status = 'completed' AND grand_total >= 0), 0)::numeric AS total_discounts,
         COALESCE(SUM(tax_total) FILTER (WHERE status = 'completed'), 0)::numeric AS total_tax,
         COALESCE(AVG(grand_total) FILTER (WHERE status = 'completed' AND grand_total > 0), 0)::numeric AS avg_ticket,
         COALESCE(MAX(grand_total) FILTER (WHERE status = 'completed'), 0)::numeric AS largest_sale,
         COALESCE(SUM(CASE WHEN grand_total < 0 THEN ABS(grand_total) ELSE 0 END) FILTER (WHERE status = 'completed'), 0)::numeric AS refund_total
       FROM transactions
       WHERE organization_id = $1 AND location_id = $2 AND created_at >= $3 AND created_at < $4`,
      [orgId, locationId, fromDate, toDate],
    );

    tenderResult = await client.query(
      `SELECT tt.tender_type, SUM(tt.amount)::numeric AS total, COUNT(*)::int AS count
       FROM transaction_tenders tt
       JOIN transactions t ON t.id = tt.transaction_id
       WHERE t.organization_id = $1 AND t.location_id = $2 AND t.created_at >= $3 AND t.created_at < $4 AND t.status = 'completed'
       GROUP BY tt.tender_type
       ORDER BY total DESC`,
      [orgId, locationId, fromDate, toDate],
    );

    // R83-MED: bucket hourly on ORG TIMEZONE, not UTC. Prior shape
     // showed 9pm PDT sales as hour=4 (next-day UTC) for Pacific-TZ
     // stores. Mirror R82-DB-H3 eod-report pattern.
    hourlyResult = await client.query(
      `SELECT
         EXTRACT(HOUR FROM created_at AT TIME ZONE COALESCE((SELECT timezone FROM organizations WHERE id = $1), 'UTC'))::int AS hour,
         COUNT(*)::int AS count,
         SUM(grand_total)::numeric AS total
       FROM transactions
       WHERE organization_id = $1 AND location_id = $2 AND created_at >= $3 AND created_at < $4 AND status = 'completed'
       GROUP BY EXTRACT(HOUR FROM created_at AT TIME ZONE COALESCE((SELECT timezone FROM organizations WHERE id = $1), 'UTC'))
       ORDER BY hour`,
      [orgId, locationId, fromDate, toDate],
    );

    employeeResult = await client.query(
      // R82-DB-L5: COALESCE display_name so deleted-employee rows
      // (employee_id → SET NULL in migration 046) don't show a
      // NULL name in the UI. Parity with /api/reports route.
      `SELECT t.employee_id,
              COALESCE(e.display_name, CONCAT(e.first_name, ' ', e.last_name), 'Former Employee') AS display_name,
              COUNT(*)::int AS transaction_count,
              SUM(t.grand_total)::numeric AS total_sales,
              AVG(t.grand_total)::numeric AS avg_ticket
       FROM transactions t
       LEFT JOIN employees e ON e.id = t.employee_id AND e.organization_id = $1
       WHERE t.organization_id = $1 AND t.location_id = $2 AND t.created_at >= $3 AND t.created_at < $4 AND t.status = 'completed'
       GROUP BY t.employee_id, e.display_name
       ORDER BY total_sales DESC`,
      [orgId, locationId, fromDate, toDate],
    );

    lowStockResult = await client.query(
      `SELECT il.on_hand, il.reorder_point, pv.sku, pv.barcode, p.name AS product_name,
              pv.size_label AS size, pv.color_label AS color
       FROM inventory_levels il
       JOIN product_variants pv ON pv.id = il.product_variant_id AND pv.organization_id = $1
       JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
       WHERE il.organization_id = $1 AND il.location_id = $2 AND il.on_hand <= il.reorder_point AND il.reorder_point > 0
       ORDER BY (il.on_hand::float / NULLIF(il.reorder_point, 0)) ASC
       LIMIT 10`,
      [orgId, locationId],
    );

    recentResult = await client.query(
      `SELECT t.id, t.grand_total, t.tender_type, t.status, t.created_at,
              e.display_name AS employee_name
       FROM transactions t
       LEFT JOIN employees e ON e.id = t.employee_id AND e.organization_id = $1
       WHERE t.organization_id = $1 AND t.location_id = $2 AND t.created_at >= $3 AND t.created_at < $4
       ORDER BY t.created_at DESC
       LIMIT 10`,
      [orgId, locationId, fromDate, toDate],
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

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
      // grossSales is SUM(grand_total) which is already post-discount/post-tax.
      // Net sales = grossSales - totalTax (revenue minus tax collected).
      netSales: Number((Number(m.gross_sales) - Number(m.total_tax)).toFixed(2)),
      transactionCount: m.transaction_count,
      voidCount: m.void_count,
      refundCount: m.refund_count,
      avgTicket: Number(Number(m.avg_ticket).toFixed(2)),
      largestSale: Number(Number(m.largest_sale).toFixed(2)),
    },
    hourlyBreakdown,
    tenderBreakdown: tenderResult.rows,
    // R34-D3: employeePerformance rows contain per-cashier sales /
    // commission-equivalent data. Strip for non-managers — `support`
    // + `inventory_clerk` hold `audit.view` but shouldn't see which
    // cashier moved the most revenue (social-engineering + peer
    // performance leak). Managers/owners still get full visibility.
    employeePerformance: isManager ? employeeResult.rows : [],
    recentTransactions: recentResult.rows,
    lowStockAlerts: lowStockResult.rows,
  });
  } catch (error) {
    console.error("[dashboard GET]", safeErr(error));
    return NextResponse.json({ error: "Failed to load dashboard" }, { status: 500 });
  }
});
