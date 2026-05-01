/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BuPOS Reports API
 * @tags reports
 */
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { buildOrgDayRange } from "@/lib/reports/day-range";
import { safeErr, safeErrorName, safePgCode } from "@/lib/logging/safe-err";

const REPORT_TYPES = new Set(["summary", "category", "employee", "hourly", "tender", "products", "shifts"]);

function isValidDate(str: string): boolean {
  const d = new Date(str);
  return !isNaN(d.getTime());
}

export const GET = withAuth("audit.view", async (req, ctx) => {
  const orgId = ctx.orgId;

  // R34-D8: per-employee rate-limit on the reports endpoint. `audit.view`
  // is held by support + inventory_clerk too; these queries run heavy
  // `CROSS JOIN LATERAL jsonb_array_elements` on cart_snapshot JSON,
  // bounded by the 400-day cap (R31-M9). Cap at 30/5min per actor
  // so a compromised support session can't grind through the whole
  // window generating big CSVs. Similar shape to R32-M-export-RL.
  const { checkRateLimit } = await import("@/lib/auth/rate-limit");
  const rl = checkRateLimit(`reports:${orgId}:${ctx.employee.id}`, { maxAttempts: 30, windowMs: 300_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many report requests. Try again shortly." }, { status: 429 });
  }

  // Respect the active-location header/cookie wired through withAuth
  // (R8-H-7). The previous hard-pin to locationIds[0] meant a multi-location
  // manager who switched stores in the UI still saw reports for their FIRST
  // assigned store — silently wrong totals. Fall back to the first assigned
  // location only when the header wasn't provided.
  const locationId = ctx.locationId ?? ctx.employee.locationIds?.[0];
  if (!locationId) {
    return NextResponse.json({ error: 'No location context' }, { status: 400 });
  }

  const sp = req.nextUrl.searchParams;
  const type = sp.get("type") as string;
  const from = sp.get("from") as string;
  const to = sp.get("to") as string;

  if (!type || !from || !to) {
    return NextResponse.json({ error: "Missing required parameters: type, from, to" }, { status: 400 });
  }

  // Defensive: enforce allowlist on type to prevent any future switch-case injection
  if (!REPORT_TYPES.has(type)) {
    return NextResponse.json({ error: `Unknown report type: ${type}` }, { status: 400 });
  }

  // Validate date formats before use
  if (!isValidDate(from) || !isValidDate(to)) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD." }, { status: 400 });
  }

  if (from > to) {
    return NextResponse.json({ error: "'from' must be before or equal to 'to'." }, { status: 400 });
  }

  // R31-M9: cap the date range. Category / products / tender reports
  // run `CROSS JOIN LATERAL jsonb_array_elements(cart_snapshot->'items')`
  // per transaction — unbounded rowcount on a 5-year window OOMs the
  // Cloudflare Worker or runs past the 30-second time limit. 400 days
  // comfortably covers a full calendar year + month-over-month
  // comparisons; anything longer should use the export CSV path
  // (which has its own 50k row cap + per-actor rate limit).
  const MAX_REPORT_DAYS = 400;
  const fromMs = new Date(`${from}T00:00:00Z`).getTime();
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  const spanDays = Math.floor((toMs - fromMs) / 86_400_000);
  if (spanDays > MAX_REPORT_DAYS) {
    return NextResponse.json(
      { error: `Date range exceeds ${MAX_REPORT_DAYS}-day cap. Use /api/export for longer ranges.` },
      { status: 400 },
    );
  }

  let data: unknown;

  // Wrap query dispatch in a route-local try/catch so any pg
  // error reaches the response with `_diag.error_name` + pg_code
  // attached. Without this, withAuth's catch (lib/api/with-auth.ts)
  // returned a generic "Internal server error" + reqId — useful for
  // log correlation but opaque from the client side. The 500
  // response body now ALSO carries the safe class info.
  try {
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
        data = await getTenderAnalysis(orgId, locationId, from, to);
        break;
      case "products":
        data = await getTopProducts(orgId, locationId, from, to);
        break;
      case "shifts":
        data = await getShiftSummary(orgId, locationId, from, to);
        break;
      default:
        return NextResponse.json({ error: `Unknown report type: ${type}` }, { status: 400 });
    }
  } catch (err) {
    // OPS-AUDIT4-2 + OPS-AUDIT5-HIGH1: whitelist error_name + SQLSTATE
    // in response _diag.
    // OPS-AUDIT5-HIGH3: emit a structured server log too. The route
    // returns NextResponse from the catch (rather than throwing), so
    // withAuth's outer wrapper never sees the error — without this
    // line, report failures were INVISIBLE in Logpush / Workers Logs.
    const errNameLog = err instanceof Error ? err.name : 'unknown';
    const errName = safeErrorName(err);
    const errCodeLog = (err as { code?: string })?.code ?? null;
    const errCode = safePgCode(err);
    console.error(JSON.stringify({
      level: "error",
      event: "report_load_failed",
      type,
      error_name: errNameLog,
      pg_code: errCodeLog,
      error: safeErr(err),
    }));
    return NextResponse.json({
      error: `Failed to load ${type} report`,
      _diag: { error_name: errName, pg_code: errCode, type },
    }, { status: 500 });
  }

  return NextResponse.json(data);
});

async function getSalesSummary(orgId: string, locationId: string, from: string, to: string) {
  // R16-L-2 (closed): use org-timezone day boundaries, not UTC. See
  // src/lib/reports/day-range.ts. toDate is the EXCLUSIVE upper bound
  // (start of next local day), so all predicates below use `< $N`.
  const { fromTs: fromDate, toTs: toDate } = await buildOrgDayRange(orgId, from, to);

  // Get previous period (same length as current period). Still computed
  // as UTC-day offsets for simplicity — the per-period range then passes
  // through buildOrgDayRange so the resulting timestamptz bounds honor
  // the org's timezone.
  const fromObj = new Date(from);
  const toObj = new Date(to);
  const daysInRange = Math.floor((toObj.getTime() - fromObj.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const prevFromObj = new Date(fromObj.getTime() - daysInRange * 24 * 60 * 60 * 1000);
  const prevToObj = new Date(fromObj.getTime() - 1);
  const prevFrom = prevFromObj.toISOString().split("T")[0];
  const prevTo = prevToObj.toISOString().split("T")[0];
  const { fromTs: prevFromDate, toTs: prevToDate } = await buildOrgDayRange(orgId, prevFrom, prevTo);

  // Current + previous period reads share one Neon client to avoid the
  // double-pool burst (see api/dashboard and api/inventory for the pattern).
  const rptClient = await orgTx(orgId);
   
  let queries: Array<{ rows: any[] }>;
  try {
    // Filter to status='completed' so voided transactions don't inflate
    // revenue/transaction counts. Refunds are stored as completed negative
    // totals (see shift-close: register refunds write status='completed'
    // with negative grand_total), so this still picks them up correctly
    // via the sign-based sales_count / return_count splits below.
    const currentRes = await rptClient.query(
      `SELECT
        SUM(grand_total) as revenue,
        COUNT(*) as transaction_count,
        SUM(CASE WHEN grand_total > 0 THEN 1 ELSE 0 END) as sales_count,
        SUM(CASE WHEN grand_total < 0 THEN 1 ELSE 0 END) as return_count,
        COALESCE(SUM(CASE WHEN grand_total < 0 THEN ABS(grand_total) ELSE 0 END), 0) as return_total,
        SUM(tax_total) as tax_total,
        SUM(discount_total) as discount_total,
        COALESCE(SUM(jsonb_array_length(COALESCE(cart_snapshot::jsonb -> 'items', '[]'::jsonb))), 0) as item_count
      FROM transactions
      WHERE organization_id = $1 AND location_id = $2 AND created_at >= $3 AND created_at < $4
        AND status = 'completed'`,
      [orgId, locationId, fromDate, toDate]
    );
    const prevRes = await rptClient.query(
      `SELECT
        SUM(grand_total) as revenue,
        COUNT(*) as transaction_count,
        SUM(CASE WHEN grand_total > 0 THEN 1 ELSE 0 END) as sales_count,
        SUM(tax_total) as tax_total,
        SUM(discount_total) as discount_total
      FROM transactions
      WHERE organization_id = $1 AND location_id = $2 AND created_at >= $3 AND created_at < $4
        AND status = 'completed'`,
      [orgId, locationId, prevFromDate, prevToDate]
    );
    queries = [currentRes, prevRes];
    await rptClient.query("COMMIT");
  } catch (e) {
    await rptClient.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    rptClient.release();
  }

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
    returnTotal: parseFloat(currentRow.return_total || 0),
  };

  const previous = {
    revenue: parseFloat(previousRow.revenue || 0),
    avgTicket: previousRow.sales_count > 0 ? parseFloat(previousRow.revenue || 0) / parseInt(previousRow.sales_count) : 0,
  };

  return { current, previous };
}

async function getSalesByCategory(orgId: string, locationId: string, from: string, to: string) {
  // R16-L-2 (closed): use org-timezone day boundaries, not UTC. See
  // src/lib/reports/day-range.ts. toDate is the EXCLUSIVE upper bound
  // (start of next local day), so all predicates below use `< $N`.
  const { fromTs: fromDate, toTs: toDate } = await buildOrgDayRange(orgId, from, to);

  // Parse cart_snapshot JSONB to extract actual items sold per category
  const result = await orgQuery(orgId,
    `SELECT
      c.id,
      c.name,
      COUNT(DISTINCT t.id) as transaction_count,
      COALESCE(SUM((item->>'quantity')::integer), 0) as item_count,
      COALESCE(SUM((item->>'quantity')::integer * (item->>'unitPrice')::numeric), 0) as revenue
    FROM transactions t
    CROSS JOIN LATERAL jsonb_array_elements(t.cart_snapshot::jsonb -> 'items') AS item
    JOIN product_variants pv ON pv.id = (item->>'productVariantId')::uuid AND pv.organization_id = $1
    JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
    JOIN categories c ON c.id = p.category_id AND c.organization_id = $1
    WHERE t.organization_id = $1 AND t.location_id = $2
      AND t.created_at >= $3 AND t.created_at < $4
      AND t.status = 'completed'
    GROUP BY c.id, c.name
    ORDER BY revenue DESC`,
    [orgId, locationId, fromDate, toDate]
  );

  const categories = result.rows.map((row: Record<string, unknown>) => ({
    id: row.id,
    name: row.name,
    revenue: parseFloat(String(row.revenue || 0)),
    transactionCount: parseInt(String(row.transaction_count || 0)),
    itemCount: parseInt(String(row.item_count || 0)),
  }));

  const totalRevenue = categories.reduce((sum: number, cat: any) => sum + cat.revenue, 0);

  return { categories, totalRevenue };
}

async function getSalesByEmployee(orgId: string, locationId: string, from: string, to: string) {
  // R16-L-2 (closed): use org-timezone day boundaries, not UTC. See
  // src/lib/reports/day-range.ts. toDate is the EXCLUSIVE upper bound
  // (start of next local day), so all predicates below use `< $N`.
  const { fromTs: fromDate, toTs: toDate } = await buildOrgDayRange(orgId, from, to);

  // R32-M-reports-PII: deactivated employees appear in reports by
  // full legal name indefinitely. For data-minimization / GDPR
  // tolerance, substitute "Former Employee" for inactive records.
  // The sales numbers stay attributed to the id so reconciliation
  // still works, but their display name is no longer leaked every
  // time a manager pulls a 400-day retrospective report. Active
  // employees continue to display normally.
  // R32-M-reports-PII + R34-D1: LEFT JOIN with COALESCE so hard-
  // deleted employees (employee_id → SET NULL per migration 046) or
  // soft-deactivated employees still surface their transactions
  // under "Former Employee" rather than silently dropping from the
  // report. Prior INNER JOIN caused hard-delete to reduce totals
  // across the whole report, which reports-consumers read as
  // "transactions vanished" after a rotation.
  const result = await orgQuery(orgId,
    `SELECT
      COALESCE(t.employee_id, '00000000-0000-0000-0000-000000000000'::uuid) as id,
      CASE
        WHEN e.id IS NULL THEN 'Former Employee'
        WHEN e.is_active THEN COALESCE(e.display_name, CONCAT(e.first_name, ' ', e.last_name))
        ELSE 'Former Employee'
      END as name,
      COUNT(CASE WHEN t.grand_total > 0 THEN 1 END) as transaction_count,
      SUM(CASE WHEN t.grand_total > 0 THEN t.grand_total ELSE 0 END) as total_sales,
      COUNT(CASE WHEN t.grand_total < 0 THEN 1 END) as refund_count
    FROM transactions t
    LEFT JOIN employees e ON e.id = t.employee_id AND e.organization_id = $1
    WHERE t.organization_id = $1 AND t.location_id = $2 AND t.created_at >= $3 AND t.created_at < $4
      AND t.status = 'completed'
    GROUP BY t.employee_id, e.id, e.display_name, e.first_name, e.last_name, e.is_active
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
  // R16-L-2 (closed): use org-timezone day boundaries, not UTC. See
  // src/lib/reports/day-range.ts. toDate is the EXCLUSIVE upper bound
  // (start of next local day), so all predicates below use `< $N`.
  const { fromTs: fromDate, toTs: toDate } = await buildOrgDayRange(orgId, from, to);

  // R32-M-hourly-status: filter to `status = 'completed'` to match
  // every OTHER report (summary, category, tender, products, shifts).
  // Prior shape included voided/refunded/pending rows, inflating
  // hourly revenue and letting a cashier hide a void from hourly
  // drill-downs.
  // R83-MED: bucket hourly on ORG TIMEZONE, not UTC. Prior
  // `AT TIME ZONE 'UTC'` was a hardcoded literal even though
  // buildOrgDayRange already positions the window in org TZ.
  // Mirror R82-DB-H3 eod-report + R83-MED dashboard pattern.
  const result = await orgQuery(orgId,
    `SELECT
      EXTRACT(HOUR FROM created_at AT TIME ZONE COALESCE((SELECT timezone FROM organizations WHERE id = $1), 'UTC')) as hour,
      SUM(grand_total) as revenue,
      COUNT(*) as transaction_count
    FROM transactions
    WHERE organization_id = $1 AND location_id = $2
      AND status = 'completed'
      AND created_at >= $3 AND created_at < $4
    GROUP BY EXTRACT(HOUR FROM created_at AT TIME ZONE COALESCE((SELECT timezone FROM organizations WHERE id = $1), 'UTC'))
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

async function getTenderAnalysis(orgId: string, locationId: string, from: string, to: string) {
  // R16-L-2 (closed): use org-timezone day boundaries, not UTC. See
  // src/lib/reports/day-range.ts. toDate is the EXCLUSIVE upper bound
  // (start of next local day), so all predicates below use `< $N`.
  const { fromTs: fromDate, toTs: toDate } = await buildOrgDayRange(orgId, from, to);

  // Join through transactions table since transaction_tenders has no organization_id column
  const result = await orgQuery(orgId,
    `SELECT
      tt.tender_type,
      SUM(tt.amount) as amount,
      COUNT(*) as count
    FROM transaction_tenders tt
    JOIN transactions t ON t.id = tt.transaction_id
    WHERE t.organization_id = $3 AND t.location_id = $4
      AND t.created_at >= $1 AND t.created_at < $2
      AND t.status = 'completed'
    GROUP BY tt.tender_type
    ORDER BY amount DESC`,
    [fromDate, toDate, orgId, locationId]
  );

  const tenders = result.rows.map((row: Record<string, unknown>) => ({
    type: row.tender_type,
    amount: parseFloat(String(row.amount || 0)),
    count: parseInt(String(row.count || 0)),
  }));

  return { tenders };
}

async function getTopProducts(orgId: string, locationId: string, from: string, to: string) {
  // R16-L-2 (closed): use org-timezone day boundaries, not UTC. See
  // src/lib/reports/day-range.ts. toDate is the EXCLUSIVE upper bound
  // (start of next local day), so all predicates below use `< $N`.
  const { fromTs: fromDate, toTs: toDate } = await buildOrgDayRange(orgId, from, to);

  // Parse cart_snapshot JSONB to extract actual items sold per variant
  const result = await orgQuery(orgId,
    `SELECT
      pv.id as variant_id,
      COALESCE(pv.name, p.name) as name,
      SUM((item->>'quantity')::integer) as quantity,
      SUM((item->>'quantity')::integer * (item->>'unitPrice')::numeric) as revenue
    FROM transactions t
    CROSS JOIN LATERAL jsonb_array_elements(t.cart_snapshot::jsonb -> 'items') AS item
    JOIN product_variants pv ON pv.id = (item->>'productVariantId')::uuid AND pv.organization_id = $1
    JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
    WHERE t.organization_id = $1 AND t.location_id = $2
      AND t.created_at >= $3 AND t.created_at < $4
      AND t.status = 'completed'
    GROUP BY pv.id, pv.name, p.name
    ORDER BY revenue DESC
    LIMIT 20`,
    [orgId, locationId, fromDate, toDate]
  );

  const byRevenue = result.rows.slice(0, 10).map((row: Record<string, unknown>) => ({
    id: row.variant_id,
    name: row.name,
    quantity: parseInt(String(row.quantity || 0)),
    revenue: parseFloat(String(row.revenue || 0)),
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
  // R16-L-2 (closed): use org-timezone day boundaries, not UTC. See
  // src/lib/reports/day-range.ts. toDate is the EXCLUSIVE upper bound
  // (start of next local day), so all predicates below use `< $N`.
  const { fromTs: fromDate, toTs: toDate } = await buildOrgDayRange(orgId, from, to);

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
    LEFT JOIN employees e ON e.id = s.employee_id AND e.organization_id = $4
    LEFT JOIN transactions t ON t.register_session_id = s.register_session_id
      AND t.organization_id = $4
      AND t.created_at >= s.opened_at
      AND t.created_at <= COALESCE(s.closed_at, NOW())
    WHERE s.organization_id = $4 AND s.location_id = $1 AND s.opened_at >= $2 AND s.opened_at < $3
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
