import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";
import { requireAdminPermission } from "@/lib/authz";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";

const LOCATION_ID = "c57268b3-cb14-4c1a-bda6-55e49ddc6313";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

/**
 * GET /api/eod-report
 * Preview the report data (for testing)
 */
export async function GET(req: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const reportData = await generateReportData(orgId);
    return NextResponse.json(reportData);
  } catch (error) {
    console.error("EOD Report GET error:", error);
    return NextResponse.json(
      { error: "Failed to generate report data" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/eod-report
 * Generate and send the daily email report
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAdminPermission('audit.view');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const reportData = await generateReportData(orgId);
  try {
    // Send email if Resend API key is available
    if (RESEND_API_KEY) {
      await sendEmailReport(reportData);
      return NextResponse.json({
        success: true,
        message: "Report generated and sent",
        reportData,
      });
    } else {
      return NextResponse.json({
        success: true,
        message: "Report generated (email not sent - no API key)",
        reportData,
      });
    }
  } catch (error) {
    console.error("EOD Report POST error:", error);
    return NextResponse.json(
      { error: "Failed to generate and send report" },
      { status: 500 }
    );
  }
}

async function generateReportData(orgId: string) {
  const today = new Date().toISOString().split("T")[0];
  const startOfDay = `${today}T00:00:00Z`;
  const endOfDay = `${today}T23:59:59Z`;

  const result = await orgQuery(
    orgId,
    `WITH daily_sales AS (
       SELECT
         COUNT(*) FILTER (WHERE status = 'completed')::int AS total_sales_count,
         COALESCE(SUM(grand_total) FILTER (WHERE status = 'completed'), 0)::numeric AS total_sales_amount,
         COUNT(*) FILTER (WHERE status = 'returned')::int AS total_returns_count,
         COALESCE(SUM(grand_total) FILTER (WHERE status = 'returned'), 0)::numeric AS total_returns_amount
       FROM transactions
       WHERE created_at >= $1::timestamp AND created_at <= $2::timestamp
         AND location_id = $3
     ),
     payment_breakdown AS (
       SELECT
         COALESCE(tt.tender_type, 'unknown') AS payment_method,
         COALESCE(SUM(tt.amount), 0)::numeric AS total_amount,
         COUNT(*)::int AS transaction_count
       FROM transaction_tenders tt
       JOIN transactions t ON t.id = tt.transaction_id
       WHERE t.created_at >= $1::timestamp AND t.created_at <= $2::timestamp
         AND t.location_id = $3
       GROUP BY tt.tender_type
     ),
     employee_performance AS (
       SELECT
         COALESCE(e.display_name, 'Unknown') AS employee_name,
         COUNT(*)::int AS transaction_count,
         COALESCE(SUM(t.grand_total), 0)::numeric AS total_sales
       FROM transactions t
       LEFT JOIN employees e ON e.id = t.employee_id
       WHERE t.created_at >= $1::timestamp AND t.created_at <= $2::timestamp
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
       WHERE s.opened_at >= $1::timestamp AT TIME ZONE 'UTC'
         AND s.opened_at < ($1::timestamp AT TIME ZONE 'UTC' + INTERVAL '1 day')
         AND s.location_id = $3
     ),
     low_stock AS (
       SELECT
         p.name,
         pv.sku,
         il.on_hand,
         il.reorder_point
       FROM inventory_levels il
       JOIN product_variants pv ON pv.id = il.product_variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE il.location_id = $3
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
      startOfDay,
      endOfDay,
      LOCATION_ID,
      today,
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
      ? (netRevenue / salesSummary.total_sales_count).toFixed(2)
      : "0.00";

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

async function sendEmailReport(reportData: any) {
  const emailBody = generateEmailHTML(reportData);
  const today = new Date().toISOString().split("T")[0];

  const emailPayload = {
    from: RESEND_API_KEY.includes("test") ? "onboarding@resend.dev" : "reports@basicuniform.com",
    to: "londonpark@gmail.com",
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
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Resend API error: ${error}`);
  }

  return await response.json();
}

function generateEmailHTML(data: any): string {
  const {
    date,
    sales_summary,
    net_revenue,
    avg_transaction_value,
    payment_methods,
    top_products,
    employee_performance,
    shifts,
    low_stock_items,
  } = data;

  const formatCurrency = (val: number) => `$${Number(val).toFixed(2)}`;
  const formatCount = (val: number) => (val || 0).toString();

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
      <p style="margin: 0; opacity: 0.95;">${date}</p>
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
              (pm: any) => `
            <tr>
              <td>${pm.payment_method}</td>
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
              (p: any) => `
            <tr>
              <td>${p.name}<br><span style="font-size: 12px; color: #999;">SKU: ${p.sku}</span></td>
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
              (e: any) => `
            <tr>
              <td>${e.employee_name}</td>
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
        ${low_stock_items.map((item: any) => `<li>${item.name} (SKU: ${item.sku}) - ${item.on_hand} on hand</li>`).join("")}
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
