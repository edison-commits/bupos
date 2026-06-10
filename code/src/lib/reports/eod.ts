import "server-only";
import { orgQuery } from "@/lib/supabase-rest";
import { formatCurrency } from "@/lib/format";
import { escapeHtml } from "@/lib/format/html-escape";

/**
 * End-of-day / digest report engine — extracted VERBATIM from
 * /api/eod-report (route files may only export handlers, so the sales-digest
 * sender couldn't import from there). Generalized in two ways for P3.2:
 *   • generateReportData takes an optional {fromDay, toDay} window (org-TZ
 *     calendar days, inclusive) so the weekly digest reuses the same SQL —
 *     omitted, it reports the org's "today" exactly as before.
 *   • sendEodEmail takes explicit recipients/subject/heading — the legacy
 *     EOD POST passes EOD_REPORT_EMAIL; the digest passes per-org config.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

export function hasResendKey(): boolean {
  return !!RESEND_API_KEY;
}

export interface SalesSummary {
  total_sales_count: number;
  total_sales_amount: number;
  total_returns_count: number;
  total_returns_amount: number;
}
export interface PaymentMethod { payment_method: string; total_amount: number; transaction_count: number }
export interface TopProduct { name: string; sku: string; total_quantity: number; total_revenue: number }
export interface EmployeePerf { employee_name: string; transaction_count: number; total_sales: number }
export interface LowStockItem { name: string; sku: string; on_hand: number; reorder_point: number }
export interface ReportData {
  date: string;
  /** Inclusive end of the window — equals `date` for a single-day report. */
  dateTo: string;
  sales_summary: SalesSummary;
  net_revenue: number;
  avg_transaction_value: number;
  payment_methods: PaymentMethod[];
  top_products: TopProduct[];
  employee_performance: EmployeePerf[];
  shifts: { id: string; started_at: string; closed_at: string | null; duration_seconds: number }[];
  low_stock_items: LowStockItem[];
}

export async function generateReportData(
  orgId: string,
  locationId?: string,
  window?: { fromDay: string; toDay: string },
): Promise<ReportData> {
  // OPS-AUDIT5-HIGH2: org-TZ "today", not UTC (see eod-report history).
  const { getOrgToday } = await import("@/lib/reports/day-range");
  const fromDay = window?.fromDay ?? (await getOrgToday(orgId));
  const toDay = window?.toDay ?? fromDay;

  // All day-windows computed in the ORG'S timezone (see /api/eod-report for
  // the full R82-DB-H3 / OPS-AUDIT5 history). $1 = window start day,
  // $4 = inclusive window end day (+1 day exclusive bound in SQL). Every
  // CTE keeps its explicit organization_id gate — location_id alone is not
  // a tenancy boundary under the BYPASSRLS role.
  const result = await orgQuery(
    orgId,
    `WITH window_bounds AS (
       SELECT ($1::date AT TIME ZONE COALESCE((SELECT timezone FROM organizations WHERE id = $2), 'UTC')) AS window_start,
              (($4::date + INTERVAL '1 day') AT TIME ZONE COALESCE((SELECT timezone FROM organizations WHERE id = $2), 'UTC')) AS window_end
     ),
     -- R82-DB-H3 (HIGH): sign-based filters — register returns are
     -- status='completed' with NEGATIVE grand_total.
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
      fromDay,     // $1 — window start day (org TZ)
      orgId,       // $2 — tenancy anchor (organization_id filter on every CTE)
      locationId,  // $3 — the active location
      toDay,       // $4 — inclusive window end day (org TZ)
    ],
  );

  if (result.rows.length === 0) {
    return {
      date: fromDay,
      dateTo: toDay,
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
    date: fromDay,
    dateTo: toDay,
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

export async function sendEodEmail(
  reportData: ReportData,
  opts?: { to?: string | string[]; subject?: string; heading?: string },
) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");
  const dateLabel =
    reportData.dateTo && reportData.dateTo !== reportData.date
      ? `${reportData.date} – ${reportData.dateTo}`
      : reportData.date;
  const emailBody = generateEmailHTML(reportData, opts?.heading ?? "BasicUniform POS - Daily Report");

  // M-11: recipient from env when not supplied (legacy EOD POST path).
  const to = opts?.to ?? process.env.EOD_REPORT_EMAIL;
  if (!to || (Array.isArray(to) && to.length === 0)) {
    throw new Error("EOD_REPORT_EMAIL not configured — skipping email send");
  }

  // OPS-LOW3: explicit EOD_REPORT_FROM env var (see eod-report history).
  const eodFrom =
    process.env.EOD_REPORT_FROM
    ?? (RESEND_API_KEY.includes("test") ? "onboarding@resend.dev" : "reports@basicuniform.com");
  const emailPayload = {
    from: eodFrom,
    to,
    subject: opts?.subject ?? `BasicUniform Daily Report - ${dateLabel}`,
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

function generateEmailHTML(data: ReportData, heading: string): string {
  const {
    date,
    dateTo,
    sales_summary,
    net_revenue,
    avg_transaction_value,
    payment_methods,
    top_products,
    employee_performance,
    shifts: _shifts,
    low_stock_items,
  } = data;

  const formatCount = (val: number) => (val || 0).toString();
  // FE-LOW1: route through the shared escapeHtml.
  const esc = (s: unknown) => escapeHtml(String(s ?? ''));
  const dateLabel = dateTo && dateTo !== date ? `${date} – ${dateTo}` : date;

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
      <h1>${esc(heading)}</h1>
      <p style="margin: 0; opacity: 0.95;">${esc(dateLabel)}</p>
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
      <p>This is an automated report from BasicUniform POS.</p>
    </div>
  </div>
</body>
</html>
  `;
}
