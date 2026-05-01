import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withAdminAuth, withDualAuth } from "@/lib/api/with-auth";
import { validateBody, eodReportSchema } from "@/lib/validation/schemas";
import { formatCurrency } from "@/lib/format";
import { safeErr } from "@/lib/logging/safe-err";
// FE-LOW1: route through the shared `escapeHtml` so any future
// tightening (e.g. backtick escape for attribute context) propagates
// here. Prior shape forked an inline 5-char `esc` helper — drift bait
// already cleaned up in email-receipt + send-verification (R32-D4 /
// R39-A1-6 sweep), but eod-report was missed.
import { escapeHtml } from "@/lib/format/html-escape";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

interface SalesSummary {
  total_sales_count: number;
  total_sales_amount: number;
  total_returns_count: number;
  total_returns_amount: number;
}
interface PaymentMethod { payment_method: string; total_amount: number; transaction_count: number }
interface TopProduct { name: string; sku: string; total_quantity: number; total_revenue: number }
interface EmployeePerf { employee_name: string; transaction_count: number; total_sales: number }
interface LowStockItem { name: string; sku: string; on_hand: number; reorder_point: number }
interface ReportData {
  date: string;
  sales_summary: SalesSummary;
  net_revenue: number;
  avg_transaction_value: number;
  payment_methods: PaymentMethod[];
  top_products: TopProduct[];
  employee_performance: EmployeePerf[];
  shifts: { id: string; started_at: string; closed_at: string | null; duration_seconds: number }[];
  low_stock_items: LowStockItem[];
}

/**
 * GET /api/eod-report  [DEPRECATED — no UI consumer; hardcoded locationId]
 *
 * Previously used by an EOD email cron. The email delivery now uses POST.
 * GET has no active consumer and relies on the hardcoded BUPOS_locationId,
 * making it unreliable for multi-location deployments.
 */
export const GET = withDualAuth("audit.view", async (req, ctx) => {
  const { orgId, locationId } = ctx;
  try {
    const reportData = await generateReportData(orgId, locationId);
    return NextResponse.json(reportData);
  } catch (error) {
    console.error("EOD Report GET error:", safeErr(error));
    return NextResponse.json(
      { error: "Failed to generate report data" },
      { status: 500 }
    );
  }
});

/**
 * POST /api/eod-report
 * Generate and send the daily email report
 */
export const POST = withAdminAuth("audit.view", async (req, ctx) => {
  const { orgId, employee } = ctx;
  const body = await req.json().catch(() => ({}));
  const v = validateBody(eodReportSchema, body);
  if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });

  // Prefer the active-location header/cookie (wired through withAdminAuth)
  // so a multi-location manager gets the EOD for the store they're viewing,
  // not the first in their assignment. Fall back to ctx.locationId (already
  // resolved to locationIds[0] by the wrapper) for non-JS clients.
  const locationId = ctx.locationId ?? employee.locationIds?.[0];
  let reportData: ReportData;
  try {
    reportData = await generateReportData(orgId, locationId);
  } catch (error) {
    console.error("EOD Report: data generation failed:", safeErr(error));
    return NextResponse.json({ error: "Failed to generate report data" }, { status: 500 });
  }

  if (!RESEND_API_KEY) {
    return NextResponse.json({
      success: true,
      message: "Report generated (email not sent - no API key)",
      reportData,
    });
  }

  try {
    await sendEmailReport(reportData);
    return NextResponse.json({ success: true, message: "Report generated and sent", reportData });
  } catch (error) {
    console.error("EOD Report: email send failed:", safeErr(error));
    // Report was generated OK; email delivery failed — surface this clearly
    return NextResponse.json(
      { error: "Report generated but email delivery failed" },
      { status: 502 }
    );
  }
});

async function generateReportData(orgId: string, locationId?: string): Promise<ReportData> {
  // OPS-AUDIT5-HIGH2: org-TZ "today", not UTC. Cron fires daily; if it
  // runs at 00:30 UTC for a Pacific-TZ org, UTC `today` is May 1 but
  // the org's ledger considers Apr 30 still in progress. Prior shape
  // would generate an EOD report for May 1 (empty, because no sales
  // have happened yet at 16:30 PDT), missing all of Apr 30. Use the
  // org-TZ today so the EOD always covers the local calendar day.
  const { getOrgToday } = await import("@/lib/reports/day-range");
  const today = await getOrgToday(orgId);

  // Compute all day-windows in the ORG'S configured timezone. Previously
  // daily_sales/payment_breakdown/employee_performance used UTC (startOfDay/
  // endOfDay) while shift_info used AT TIME ZONE organization. For a
  // Pacific-TZ store the two windows overlapped by only ~17 hours — sales
  // at 18:00 PDT showed in "today's totals" but the shift that generated
  // them was in the PREVIOUS day's shift_info, making reconciliation off
  // by the evening's sales every single day. Passing `today` as a date and
  // letting SQL compute both windows in the org TZ unifies the sources.
  // Every CTE gates its org-scoped source table by `organization_id = $2`
  // (on top of `location_id = $3`). `location_id` alone is not a tenancy
  // boundary: location UUIDs are tenant-unique but a crafted/foreign id
  // wouldn't be caught by RLS (BYPASSRLS under the postgres role), so the
  // explicit org filter is what blocks cross-tenant reads. The JOINed
  // `employees` / `product_variants` / `products` rows are also gated so
  // display names / SKUs can't bleed across tenants via a foreign FK.
  const result = await orgQuery(
    orgId,
    `WITH window_bounds AS (
       SELECT ($1::date AT TIME ZONE COALESCE((SELECT timezone FROM organizations WHERE id = $2), 'UTC')) AS window_start,
              (($1::date + INTERVAL '1 day') AT TIME ZONE COALESCE((SELECT timezone FROM organizations WHERE id = $2), 'UTC')) AS window_end
     ),
     -- R82-DB-H3 (HIGH): sign-based filters. Register returns write
     -- status='completed' with NEGATIVE grand_total (there's no
     -- status='returned' value in the register flow). Prior shape
     -- showed ZERO returns on EOD for every store using the
     -- register-side returns. payment_breakdown also missed a
     -- status filter — summed transaction_tenders across voided +
     -- pending rows. Now: completed+positive for sales,
     -- completed+negative for refunds, positive tenders only in the
     -- payment breakdown so negative-amount refund tenders don't
     -- distort the sale-side totals.
     daily_sales AS (
       SELECT
         COUNT(*) FILTER (WHERE status = 'completed' AND grand_total >= 0)::int AS total_sales_count,
         COALESCE(SUM(grand_total) FILTER (WHERE status = 'completed' AND grand_total >= 0), 0)::numeric AS total_sales_amount,
         COUNT(*) FILTER (WHERE status = 'completed' AND grand_total < 0)::int AS total_returns_count,
         COALESCE(SUM(ABS(grand_total)) FILTER (WHERE status = 'completed' AND grand_total < 0), 0)::numeric AS total_returns_amount
       FROM transactions
       WHERE organization_id = $2
         AND created_at >= (SELECT window_start FROM window_bounds)
         AND created_at < (SELECT window_end FROM window_bounds)
         AND location_id = $3
     ),
     payment_breakdown AS (
       SELECT
         COALESCE(tt.tender_type, 'unknown') AS payment_method,
         COALESCE(SUM(tt.amount), 0)::numeric AS total_amount,
         COUNT(*)::int AS transaction_count
       FROM transaction_tenders tt
       JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $2
       WHERE t.created_at >= (SELECT window_start FROM window_bounds)
         AND t.created_at < (SELECT window_end FROM window_bounds)
         AND t.location_id = $3
         AND t.status = 'completed'
         AND tt.amount > 0
       GROUP BY tt.tender_type
     ),
     employee_performance AS (
       SELECT
         COALESCE(e.display_name, 'Unknown') AS employee_name,
         COUNT(*)::int AS transaction_count,
         COALESCE(SUM(t.grand_total), 0)::numeric AS total_sales
       FROM transactions t
       LEFT JOIN employees e ON e.id = t.employee_id AND e.organization_id = $2
       WHERE t.organization_id = $2
         AND t.created_at >= (SELECT window_start FROM window_bounds)
         AND t.created_at < (SELECT window_end FROM window_bounds)
         AND t.location_id = $3
         AND t.status = 'completed'
       GROUP BY e.id, e.display_name
       ORDER BY transaction_count DESC
     ),
     shift_info AS (
       SELECT
         s.id,
         s.opened_at AS started_at,
         s.closed_at,
         EXTRACT(EPOCH FROM (COALESCE(s.closed_at, NOW()) - s.opened_at))::int AS duration_seconds
       FROM shifts s
       WHERE s.organization_id = $2
         AND s.opened_at >= (SELECT window_start FROM window_bounds)
         AND s.opened_at < (SELECT window_end FROM window_bounds)
         AND s.location_id = $3
     ),
     low_stock AS (
       SELECT
         p.name,
         pv.sku,
         il.on_hand,
         il.reorder_point
       FROM inventory_levels il
       JOIN product_variants pv ON pv.id = il.product_variant_id AND pv.organization_id = $2
       JOIN products p ON p.id = pv.product_id AND p.organization_id = $2
       WHERE il.organization_id = $2
         AND il.location_id = $3
         AND il.on_hand < il.reorder_point
       LIMIT 10
     )
     SELECT
       (SELECT row_to_json(daily_sales.*) FROM daily_sales) AS sales_summary,
       (SELECT coalesce(json_agg(row_to_json(payment_breakdown.*)), '[]'::json)
        FROM payment_breakdown) AS payment_methods,
       '[]'::json AS top_products,
       (SELECT coalesce(json_agg(row_to_json(employee_performance.*)), '[]'::json)
        FROM employee_performance) AS employee_performance,
       (SELECT coalesce(json_agg(row_to_json(shift_info.*)), '[]'::json)
        FROM shift_info) AS shifts,
       (SELECT coalesce(json_agg(row_to_json(low_stock.*)), '[]'::json)
        FROM low_stock) AS low_stock_items`,
    [
      today,       // $1 — date used to derive the window_bounds in org TZ
      orgId,       // $2 — tenancy anchor (organization_id filter on every CTE)
      locationId,  // $3 — the active location
    ],
  );

  if (result.rows.length === 0) {
    return {
      date: today,
      sales_summary: {
        total_sales_count: 0,
        total_sales_amount: 0,
        total_returns_count: 0,
        total_returns_amount: 0,
      },
      net_revenue: 0,
      avg_transaction_value: 0,
      payment_methods: [],
      top_products: [],
      employee_performance: [],
      shifts: [],
      low_stock_items: [],
    };
  }

  const data = result.rows[0];
  const salesSummary = data.sales_summary || {};
  const netRevenue = (salesSummary.total_sales_amount || 0) - (salesSummary.total_returns_amount || 0);
  const avgTransactionValue =
    salesSummary.total_sales_count > 0
      ? Math.round((netRevenue / salesSummary.total_sales_count) * 100) / 100
      : 0;

  return {
    date: today,
    sales_summary: {
      total_sales_count: salesSummary.total_sales_count || 0,
      total_sales_amount: salesSummary.total_sales_amount || 0,
      total_returns_count: salesSummary.total_returns_count || 0,
      total_returns_amount: salesSummary.total_returns_amount || 0,
    },
    net_revenue: netRevenue,
    avg_transaction_value: avgTransactionValue,
    payment_methods: data.payment_methods || [],
    top_products: data.top_products || [],
    employee_performance: data.employee_performance || [],
    shifts: data.shifts || [],
    low_stock_items: data.low_stock_items || [],
  };
}

async function sendEmailReport(reportData: ReportData) {
  const emailBody = generateEmailHTML(reportData);
  // OPS-AUDIT5-HIGH2: reuse the report's `date` field (already org-TZ'd
  // upstream by generateReportData) instead of recomputing UTC today.
  // The email subject/body referenced UTC today which could disagree
  // with the report's actual date by one day for Pacific-TZ orgs near
  // UTC-midnight cron fires.
  const today = reportData.date ?? new Date().toISOString().split("T")[0];

  // M-11: Read recipient from env var instead of hardcoding
  const eodRecipient = process.env.EOD_REPORT_EMAIL;
  if (!eodRecipient) {
    throw new Error("EOD_REPORT_EMAIL not configured — skipping email send");
  }

  // OPS-LOW3: explicit EOD_REPORT_FROM env var instead of brittle
  // `RESEND_API_KEY.includes("test")` substring sniffing. The prior
  // shape would silently send EOD email from the sandbox sender if
  // a prod key happened to contain the literal substring "test"
  // (vanishingly unlikely random base62, but possible). Explicit env
  // var also makes the from-address swap visible in deploy diffs.
  // Falls back to the prior heuristic if the env var isn't set so
  // existing deploys keep working unchanged.
  const eodFrom =
    process.env.EOD_REPORT_FROM
    ?? (RESEND_API_KEY.includes("test") ? "onboarding@resend.dev" : "reports@basicuniform.com");
  const emailPayload = {
    from: eodFrom,
    to: eodRecipient,
    subject: `BasicUniform Daily Report - ${today}`,
    html: emailBody,
  };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(emailPayload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Resend API error: ${error}`);
  }

  return await response.json();
}

function generateEmailHTML(data: ReportData): string {
  const {
    date,
    sales_summary,
    net_revenue,
    avg_transaction_value,
    payment_methods,
    top_products,
    employee_performance,
    shifts: _shifts,
    low_stock_items,
  } = data;

  // Use the shared helper (imported at top of file, R10 sweep). Local
  // shadow removed so locale/currency changes propagate.
  const formatCount = (val: number) => (val || 0).toString();
  // FE-LOW1: route through the shared escapeHtml. Local alias keeps
  // call sites short and matches the prior `esc()` shape.
  const esc = (s: unknown) => escapeHtml(String(s ?? ''));

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #333; }
    .container { max-width: 800px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%); color: white; padding: 20px; border-radius: 8px; }
    .section { margin-top: 30px; }
    .section-title { font-size: 18px; font-weight: bold; color: #0d9488; border-bottom: 2px solid #14b8a6; padding-bottom: 10px; }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 15px; }
    .stat-card { background: #f0f9f8; padding: 15px; border-radius: 6px; border-left: 4px solid #14b8a6; }
    .stat-label { font-size: 12px; color: #666; text-transform: uppercase; }
    .stat-value { font-size: 24px; font-weight: bold; color: #0d9488; margin-top: 5px; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th { background: #f0f9f8; text-align: left; padding: 12px; font-weight: 600; font-size: 12px; color: #0d9488; }
    td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
    .alert { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 6px; margin-top: 15px; }
    .footer { margin-top: 30px; font-size: 12px; color: #999; border-top: 1px solid #e5e7eb; padding-top: 15px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>BasicUniform POS - Daily Report</h1>
      <p style="margin: 0; opacity: 0.95;">${esc(date)}</p>
    </div>

    <div class="section">
      <div class="section-title">Sales Summary</div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Sales</div>
          <div class="stat-value">${formatCount(sales_summary.total_sales_count)}</div>
          <div style="font-size: 14px; color: #0d9488; margin-top: 5px;">${formatCurrency(sales_summary.total_sales_amount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Returns</div>
          <div class="stat-value">${formatCount(sales_summary.total_returns_count)}</div>
          <div style="font-size: 14px; color: #0d9488; margin-top: 5px;">${formatCurrency(sales_summary.total_returns_amount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Net Revenue</div>
          <div class="stat-value">${formatCurrency(net_revenue)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Transaction</div>
          <div class="stat-value">${formatCurrency(avg_transaction_value)}</div>
        </div>
      </div>
    </div>

    ${
      payment_methods.length > 0
        ? `
    <div class="section">
      <div class="section-title">Payment Methods</div>
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Transactions</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${payment_methods
            .map(
              (pm: PaymentMethod) => `
            <tr>
              <td>${esc(pm.payment_method)}</td>
              <td>${pm.transaction_count}</td>
              <td>${formatCurrency(pm.total_amount)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
    `
        : ""
    }

    ${
      top_products.length > 0
        ? `
    <div class="section">
      <div class="section-title">Top 5 Products</div>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Qty Sold</th>
            <th>Revenue</th>
          </tr>
        </thead>
        <tbody>
          ${top_products
            .map(
              (p: TopProduct) => `
            <tr>
              <td>${esc(p.name)}<br><span style="font-size: 12px; color: #999;">SKU: ${esc(p.sku)}</span></td>
              <td>${p.total_quantity}</td>
              <td>${formatCurrency(p.total_revenue)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
    `
        : ""
    }

    ${
      employee_performance.length > 0
        ? `
    <div class="section">
      <div class="section-title">Employee Performance</div>
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Transactions</th>
            <th>Sales Total</th>
          </tr>
        </thead>
        <tbody>
          ${employee_performance
            .map(
              (e: EmployeePerf) => `
            <tr>
              <td>${esc(e.employee_name)}</td>
              <td>${e.transaction_count}</td>
              <td>${formatCurrency(e.total_sales)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
    `
        : ""
    }

    ${
      low_stock_items.length > 0
        ? `
    <div class="alert">
      <strong>Low Stock Alert</strong>
      <p style="margin: 10px 0 0 0; font-size: 14px;">
        ${low_stock_items.length} item(s) below reorder point:
      </p>
      <ul style="margin: 10px 0 0 0; padding-left: 20px;">
        ${low_stock_items.map((item: LowStockItem) => `<li>${esc(item.name)} (SKU: ${esc(item.sku)}) - ${item.on_hand} on hand</li>`).join("")}
      </ul>
    </div>
    `
        : ""
    }

    <div class="footer">
      <p>This is an automated daily report from BasicUniform POS. Generated at ${new Date().toISOString()}</p>
    </div>
  </div>
</body>
</html>
  `;
}
