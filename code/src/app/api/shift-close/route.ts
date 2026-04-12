import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";
import { withDualAuth, withAdminAuth } from "@/lib/api/with-auth";
import { pgCloseShift } from "@/lib/persistence/postgres-store";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { validateBody, shiftCloseSchema } from "@/lib/validation/schemas";

export const runtime = "edge";

/**
 * GET /api/shift-close?shift=<id>
 * Fetch current open shift and Z-report data.
 * If no shift param, fetches the most recent open shift.
 */
export const GET = withDualAuth("register.open", async (req, ctx) => {
  const { orgId, locationId } = ctx;
  try {
    let shiftId = req.nextUrl.searchParams.get("shift");

    if (!shiftId) {
      const openShifts = await orgQuery(
        orgId,
        `SELECT s.id FROM shifts s
         WHERE s.location_id = $1 AND s.status = 'open'
         ORDER BY s.opened_at DESC LIMIT 1`,
        [locationId],
      );

      if (openShifts.rows.length === 0) {
        return NextResponse.json({ error: "No open shift found" }, { status: 404 });
      }
      shiftId = openShifts.rows[0].id;
    }

    // Fetch shift + employee name, and build Z-report in parallel
    const [shiftResult, report] = await Promise.all([
      orgQuery(
        orgId,
        `SELECT s.*, e.display_name AS employee_name
         FROM shifts s
         LEFT JOIN employees e ON e.id = s.employee_id
         WHERE s.id = $1`,
        [shiftId],
      ),
      buildZReport(orgId, shiftId!),
    ]);

    if (shiftResult.rows.length === 0) {
      return NextResponse.json({ error: "Shift not found" }, { status: 404 });
    }

    const shift = shiftResult.rows[0];

    return NextResponse.json({
      shift: {
        id: shift.id,
        employeeName: shift.employee_name,
        openedAt: shift.opened_at,
        closedAt: shift.closed_at,
        openingFloat: Number(shift.opening_float),
        status: shift.status,
      },
      report,
    });
  } catch (error) {
    console.error("[shift-close GET]", error);
    return NextResponse.json({ error: "Failed to fetch shift data" }, { status: 500 });
  }
});

/**
 * POST /api/shift-close
 * Close a shift with declared cash count.
 * Body: { shiftId, declaredCash, notes? }
 */
export const POST = withAdminAuth('register.open', async (req, ctx) => {
  const employeeId = ctx.employee.id;

  const rl = checkRateLimit(`shift-close:${employeeId}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { orgId } = ctx;

  try {
    const body = await req.json();
    const v = validateBody(shiftCloseSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { shiftId, declaredCash, notes } = v.data;

    // Get shift to find registerSessionId
    const shiftRes = await orgQuery(
      orgId,
      `SELECT register_session_id FROM shifts WHERE id = $1`,
      [shiftId],
    );
    if (shiftRes.rows.length === 0) {
      return NextResponse.json({ error: "Shift not found" }, { status: 404 });
    }
    const registerSessionId = shiftRes.rows[0].register_session_id;

    const report = await buildZReport(orgId, shiftId);
    const expectedCash = report.expectedCash;

    // Use pgCloseShift if register session exists, otherwise do inline close
    if (registerSessionId) {
      await pgCloseShift(shiftId, registerSessionId, {
        closingExpectedCash: expectedCash,
        closingDeclaredCash: Number(declaredCash),
        closedNote: notes,
      });
    } else {
      // Admin-initiated shift — no register session to clean up
      const ts = new Date().toISOString();
      const variance = Number((Number(declaredCash) - expectedCash).toFixed(2));
      await orgQuery(
        orgId,
        `UPDATE shifts SET status = 'closed', closed_at = $1, closing_expected_cash = $2,
         closing_declared_cash = $3, closing_variance = $4, closed_note = $5
         WHERE id = $6`,
        [ts, expectedCash, Number(declaredCash), variance, notes || null, shiftId],
      );
    }

    return NextResponse.json({
      success: true,
      shift: { id: shiftId, closedAt: new Date().toISOString(), expectedCash, declaredCash: Number(declaredCash), variance: Number((Number(declaredCash) - expectedCash).toFixed(2)) },
      report,
    });
  } catch (error) {
    console.error("[shift-close POST]", error);
    return NextResponse.json({ error: "Failed to close shift" }, { status: 500 });
  }
});

// ── Z-Report builder ─────────────────────────────────────────

interface ZReportData {
  salesCount: number;
  salesAmount: number;
  tenderBreakdown: Array<{ type: string; count: number; amount: number }>;
  refundsCount: number;
  refundsAmount: number;
  netSales: number;
  payIns: number;
  payOuts: number;
  expectedCash: number;
  openingFloat: number;
}

async function buildZReport(orgId: string, shiftId: string): Promise<ZReportData> {
  const [shiftRes, txnsRes, payRes] = await Promise.all([
    orgQuery(orgId, `SELECT opening_float, register_session_id FROM shifts WHERE id = $1`, [shiftId]),
    orgQuery(
      orgId,
      `SELECT t.id, t.status, t.grand_total
       FROM transactions t
       JOIN shifts s ON t.register_session_id = s.register_session_id
       WHERE s.id = $1`,
      [shiftId],
    ),
    orgQuery(
      orgId,
      `SELECT direction, SUM(amount)::numeric AS total
       FROM pay_in_outs
       WHERE shift_id = $1
       GROUP BY direction`,
      [shiftId],
    ),
  ]);

  const openingFloat = shiftRes.rows[0] ? Number(shiftRes.rows[0].opening_float) : 0;
  interface TxnRow { id: string; status: string; grand_total: string }
  interface TenderRow { tender_type: string; amount: string; count: number }
  interface PayRow { direction: string; total: string }

  const txns = txnsRes.rows as TxnRow[];
  const completed = txns.filter((t) => t.status === "completed");
  const refunded = txns.filter((t) => t.status === "refunded" || t.status === "returned");

  const txnIds = completed.map((t) => t.id);
  let tenderBreakdown: Array<{ type: string; count: number; amount: number }> = [];

  if (txnIds.length > 0) {
    const tenderRes = await orgQuery(
      orgId,
      `SELECT tender_type, SUM(amount)::numeric AS amount, COUNT(*)::int AS count
       FROM transaction_tenders
       WHERE transaction_id = ANY($1)
       GROUP BY tender_type
       ORDER BY amount DESC`,
      [txnIds],
    );
    tenderBreakdown = (tenderRes.rows as TenderRow[]).map((r) => ({
      type: r.tender_type,
      count: r.count,
      amount: Number(r.amount),
    }));
  }

  const salesAmount = completed.reduce((s, t) => s + Number(t.grand_total), 0);
  const refundsAmount = refunded.reduce((s, t) => s + Math.abs(Number(t.grand_total)), 0);

  const payRows = payRes.rows as PayRow[];
  const payIns = Number(payRows.find((r) => r.direction === "pay_in")?.total ?? 0);
  const payOuts = Number(payRows.find((r) => r.direction === "pay_out")?.total ?? 0);

  const cashTender = tenderBreakdown.find((t) => t.type === "cash");
  const cashSales = cashTender?.amount ?? 0;
  const expectedCash = openingFloat + cashSales + payIns - payOuts;

  return {
    salesCount: completed.length,
    salesAmount,
    tenderBreakdown,
    refundsCount: refunded.length,
    refundsAmount,
    netSales: salesAmount - refundsAmount,
    payIns,
    payOuts,
    expectedCash,
    openingFloat,
  };
}
