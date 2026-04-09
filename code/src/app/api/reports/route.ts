/**
 * BuPOS Reports API
 * @tags reports
 */
import { orgQuery } from "@/lib/db";
import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/authz";

const REPORT_TYPES = new Set(["summary", "category", "employee", "hourly", "tender", "products", "shifts"]);

function isValidDate(str: string): boolean {
  const d = new Date(str);
  return !isNaN(d.getTime());
}

export async function GET(request: Request) {
  const adminCtx = await getAdminSession();
  const orgId = adminCtx?.employee?.organizationId;
  if (!adminCtx?.session || !adminCtx.employee || !orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasPermission(adminCtx.employee.roleKey, "audit.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const locationId = adminCtx?.employee?.locationIds?.[0];
  if (!locationId) {
    return NextResponse.json({ error: 'No location context' }, { status: 400 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get("type") as string;
  const from = url.searchParams.get("from") as string;
  const to = url.searchParams.get("to") as string;

  if (!type || !from || !to) {
    return Response.json({ error: "Missing required parameters: type, from, to" }, { status: 400 });
  }

  // Defensive: enforce allowlist on type to prevent any future switch-case injection
  if (!REPORT_TYPES.has(type)) {
    return Response.json({ error: `Unknown report type: ${type}` }, { status: 400 });
  }

  // Validate date formats before use
  if (!isValidDate(from) || !isValidDate(to)) {
    return Response.json({ error: "Invalid date format. Use YYYY-MM-DD." }, { status: 400 });
  }

  if (from > to) {
    return Response.json({ error: "'from' must be before or equal to 'to'." }, { status: 400 });
  }

  try {
    let data: any;

    switch (type) {
      case "summary":
        data = await getSalesSummary(orgId, locationId, from, to);
        break;
      case "category":
        data = await getSalesByCategory(orgId, locationId, from, to);
        break;
      case "employee":
        data = await getSalesByEmployee(orgId, locationId, from, to);
        break;
      case "hourly":
        data = await getSalesByHour(orgId, locationId, from, to);
        break;
      case "tender":
        data = await getTenderAnalysis(orgId, from, to);
        break;
      case "products":
        data = await getTopProducts(orgId, locationId, from, to);
        break;
      case "shifts":
        data = await getShiftSummary(orgId, locationId, from, to);
        break;
      default:
        return Response.json({ error: `Unknown report type: ${type}` }, { status: 400 });
    }

    return Response.json(data);
  } catch (error) {
    console.error(`Error generating ${type} report:`, error);
    return Response.json({ error: `Failed to generate ${type} report` }, { status: 500 });
  }
}

async function getSalesSummary(orgId: string, locationId: string, from: string, to: string) {
  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59Z`;

  // Get previous period (same length as current period)
  const fromObj = new Date(from);
  const toObj = new Date(to);
  const daysInRange = Math.floor((toObj.getTime() - fromObj.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const prevFromObj = new Date(fromObj.getTime() - daysInRange * 24 * 60 * 60 * 1000);
  const prevToObj = new Date(fromObj.getTime() - 1);
  const prevFrom = prevFromObj.toISOString().split("T")[0];
  const prevTo = prevToObj.toISOString().split("T")[0];
  const prevFromDate = `${prevFrom}T00:00:00Z`;
  const prevToDate = `${prevTo}T23:59:59Z`;

  const queries = await Promise.all([
    // Current period
    orgQuery(orgId,
      `SELECT 
        SUM(grand_total) as revenue,
        COUNT(*) as transaction_count,
        SUM(CASE WHEN grand_total > 0 THEN 1 ELSE 0 END) as sales_count,
        SUM(CASE WHEN grand_total < 0 THEN 1 ELSE 0 END) as return_count,
        SUM(tax_total) as tax_total,
        SUM(discount_total) as discount_total,
        COALESCE(SUM(jsonb_array_length(COALESCE(cart_snapshot::jsonb -> 'items', '[]'::jsonb))), 0) as item_count
      FROM transactions
      WHERE organization_id = $1 AND location_id = $2 AND created_at >= $3 AND created_at <= $4`,
      [orgId, locationId, fromDate, toDate]
    ),
    // Previous period
    orgQuery(orgId,
      `SELECT 
        SUM(grand_total) as revenue,
        COUNT(*) as transaction_count,
        SUM(CASE WHEN grand_total > 0 THEN 1 ELSE 0 END) as sales_count,
        SUM(tax_total) as tax_total,
        SUM(discount_total) as discount_total
      FROM transactions
      WHERE organization_id = $1 AND location_id = $2 AND created_at >= $3 AND created_at <= $4`,
      [orgId, locationId, prevFromDate, prevToDate]
    ),
  ]);

  const currentRow = queries[0].rows[0];
  const previousRow = queries[1].rows[0];

  const current = {
    revenue: parseFloat(currentRow.revenue || 0),
    transactionCount: parseInt(currentRow.transaction_count || 0),
    avgTicket: currentRow.sales_count > 0 ? parseFloat(currentRow.revenue || 0) / parseInt(currentRow.sales_count) : 0,
    itemCount: parseInt(currentRow.item_count || 0),
    taxTotal: parseFloat(currentRow.tax_total || 0),
    discountTotal: parseFloat(currentRow.discount_total || 0),
    refundCount: parseInt(currentRow.return_count || 0),
    returnTotal: Math.abs(
      queries[0].rows.reduce(
        (sum: number, row: any) =>
          sum + (parseFloat(row.grand_total || 0) < 0 ? Math.abs(parseFloat(row.grand_total)) : 0),
        0
      )
    ),
  };

  const previous = {
    revenue: parseFloat(previousRow.revenue || 0),
    avgTicket: previousRow.sales_count > 0 ? parseFloat(previousRow.revenue || 0) / parseInt(previousRow.sales_count) : 0,
  };

  return { current, previous };
}

async function getSalesByCategory(orgId: string, locationId: string, from: string, to: string) {
  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59Z`;

  const result = await orgQuery(orgId,
    `SELECT 
      c.id,
      c.name,
      SUM(t.grand_total) as revenue,
      COUNT(t.id) as transaction_count,
      SUM(COALESCE((t.cart_snapshot::jsonb -> 'items')::text::integer, 0)) as item_count
    FROM transactions t
    LEFT JOIN (
      SELECT DISTINCT ON (pv.id) t2.id as txn_id, c2.id as category_id
      FROM transaction_tenders t2
      JOIN product_variants pv ON true
      JOIN products p ON p.id = pv.product_id
      JOIN categories c2 ON c2.id = p.category_id
    ) cart_items ON cart_items.txn_id = t.id
    JOIN categories c ON c.id = COALESCE(cart_items.category_id, c.id)
    WHERE t.organization_id = $1 AND t.location_id = $2 AND t.created_at >= $3 AND t.created_at <= $4
    GROUP BY c.id, c.name
    ORDER BY revenue DESC`,
    [orgId, locationId, fromDate, toDate]
  );

  const categories = result.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    revenue: parseFloat(row.revenue || 0),
    transactionCount: parseInt(row.transaction_count || 0),
    itemCount: parseInt(row.item_count || 0),
  }));

  const totalRevenue = categories.reduce((sum: number, cat: any) => sum + cat.revenue, 0);

  return { categories, totalRevenue };
}

async function getSalesByEmployee(orgId: string, locationId: string, from: string, to: string) {
  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59Z`;

  const result = await orgQuery(orgId,
    `SELECT 
      e.id,
      COALESCE(e.display_name, CONCAT(e.first_name, ' ', e.last_name)) as name,
      COUNT(CASE WHEN t.grand_total > 0 THEN 1 END) as transaction_count,
      SUM(CASE WHEN t.grand_total > 0 THEN t.grand_total ELSE 0 END) as total_sales,
      COUNT(CASE WHEN t.grand_total < 0 THEN 1 END) as refund_count
    FROM transactions t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.organization_id = $1 AND t.location_id = $2 AND t.created_at >= $3 AND t.created_at <= $4
    GROUP BY e.id, e.display_name, e.first_name, e.last_name
    ORDER BY total_sales DESC`,
    [orgId, locationId, fromDate, toDate]
  );

  const employees = result.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    transactionCount: parseInt(row.transaction_count || 0),
    totalSales: parseFloat(row.total_sales || 0),
    avgTicket: parseInt(row.transaction_count || 0) > 0 ? parseFloat(row.total_sales || 0) / parseInt(row.transaction_count) : 0,
    refundCount: parseInt(row.refund_count || 0),
  }));

  return { employees };
}

async function getSalesByHour(orgId: string, locationId: string, from: string, to: string) {
  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59Z`;

  const result = await orgQuery(orgId,
    `SELECT 
      EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC') as hour,
      SUM(grand_total) as revenue,
      COUNT(*) as transaction_count
    FROM transactions
    WHERE organization_id = $1 AND location_id = $2 AND created_at >= $3 AND created_at <= $4
    GROUP BY EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')
    ORDER BY hour ASC`,
    [orgId, locationId, fromDate, toDate]
  );

  const hours = result.rows.map((row: any) => ({
    hour: parseInt(row.hour || 0),
    revenue: parseFloat(row.revenue || 0),
    transactionCount: parseInt(row.transaction_count || 0),
  }));

  // Fill in missing hours
  const allHours = [];
  for (let h = 0; h < 24; h++) {
    const found = hours.find((row) => row.hour === h);
    allHours.push(found || { hour: h, revenue: 0, transactionCount: 0 });
  }

  return { hours: allHours };
}

async function getTenderAnalysis(orgId: string, from: string, to: string) {
  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59Z`;

  const result = await orgQuery(orgId,
    `SELECT 
      tender_type,
      SUM(amount) as amount,
      COUNT(*) as count
    FROM transaction_tenders
    WHERE organization_id = $3 AND created_at >= $1 AND created_at <= $2
    GROUP BY tender_type
    ORDER BY amount DESC`,
    [fromDate, toDate, orgId]
  );

  const tenders = result.rows.map((row: any) => ({
    type: row.tender_type,
    amount: parseFloat(row.amount || 0),
    count: parseInt(row.count || 0),
  }));

  return { tenders };
}

async function getTopProducts(orgId: string, locationId: string, from: string, to: string) {
  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59Z`;

  const result = await orgQuery(orgId,
    `SELECT 
      pv.id as variant_id,
      COALESCE(pv.name, p.name) as name,
      SUM(
        CASE 
          WHEN t.cart_snapshot::jsonb -> 'items' IS NOT NULL 
          THEN (t.cart_snapshot::jsonb -> 'items' ->> 'quantity')::integer 
          ELSE 0 
        END
      ) as quantity,
      SUM(t.grand_total) as revenue
    FROM transactions t
    JOIN product_variants pv ON true
    JOIN products p ON p.id = pv.product_id
    WHERE t.organization_id = $1 AND t.location_id = $2 AND t.created_at >= $3 AND t.created_at <= $4
    GROUP BY pv.id, pv.name, p.name
    ORDER BY revenue DESC
    LIMIT 20`,
    [orgId, locationId, fromDate, toDate]
  );

  const byRevenue = result.rows.slice(0, 10).map((row: any) => ({
    id: row.variant_id,
    name: row.name,
    quantity: parseInt(row.quantity || 0),
    revenue: parseFloat(row.revenue || 0),
  }));

  const byQuantity = result.rows
    .sort((a: any, b: any) => parseInt(b.quantity || 0) - parseInt(a.quantity || 0))
    .slice(0, 10)
    .map((row: any) => ({
      id: row.variant_id,
      name: row.name,
      quantity: parseInt(row.quantity || 0),
      revenue: parseFloat(row.revenue || 0),
    }));

  return { byRevenue, byQuantity };
}

async function getShiftSummary(orgId: string, locationId: string, from: string, to: string) {
  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59Z`;

  const result = await orgQuery(orgId,
    `SELECT 
      s.id,
      COALESCE(e.display_name, CONCAT(e.first_name, ' ', e.last_name)) as employee,
      DATE(s.opened_at) as date,
      s.status,
      s.opening_float,
      s.closed_at,
      s.closing_expected_cash,
      s.closing_declared_cash,
      s.closing_variance,
      COUNT(t.id) as transaction_count,
      COALESCE(SUM(CASE WHEN t.grand_total > 0 THEN t.grand_total ELSE 0 END), 0) as sales
    FROM shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    LEFT JOIN transactions t ON t.register_session_id = s.register_session_id AND t.created_at >= s.opened_at AND t.created_at <= COALESCE(s.closed_at, NOW())
    WHERE s.organization_id = $4 AND s.location_id = $1 AND s.opened_at >= $2 AND s.opened_at <= $3
    GROUP BY s.id, e.display_name, e.first_name, e.last_name, s.opened_at, s.status, s.opening_float, s.closed_at, s.closing_expected_cash, s.closing_declared_cash, s.closing_variance
    ORDER BY s.opened_at DESC`,
    [locationId, fromDate, toDate, orgId]
  );

  const shifts = result.rows.map((row: any) => ({
    id: row.id,
    employee: row.employee || "Unknown",
    date: row.date ? new Date(row.date).toISOString().split("T")[0] : "N/A",
    status: row.status,
    openingFloat: parseFloat(row.opening_float || 0),
    sales: parseFloat(row.sales || 0),
    closingExpectedCash: parseFloat(row.closing_expected_cash || 0),
    closingDeclaredCash: parseFloat(row.closing_declared_cash || 0),
    variance: parseFloat(row.closing_variance || 0),
    transactionCount: parseInt(row.transaction_count || 0),
  }));

  return { shifts };
}
