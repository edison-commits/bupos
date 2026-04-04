import { NextRequest, NextResponse } from "next/server";
import { orgQuery, orgTx, pool } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { requireAdminPermission } from "@/lib/authz";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";
import { BUPOS_LOCATION_ID } from "@/lib/env";


/**
 * GET /api/shift-report  [DEPRECATED — not called from any UI component]
 *
 * Previously served the Z-report UI panel. That panel now uses /api/shift-close
 * for reads and POST /api/shift-report only for the close_shift action.
 *
 * Query params:
 *   shift    — shift ID (returns full Z-report for that shift)
 *   location — location ID (returns today's Z-report for all shifts at that location)
 *   date     — specific date YYYY-MM-DD (defaults to today)
 */
export async function GET(req: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const sp = req.nextUrl.searchParams;
    const locationId = sp.get("location") || BUPOS_LOCATION_ID;
    const date = sp.get("date") || new Date().toISOString().slice(0, 10);
    const shiftId = sp.get("shift");

    // ── Single shift report ──
    if (shiftId) {
      const shift = await orgQuery(
        orgId,
        `SELECT s.*, e.display_name AS employee_name, l.name AS location_name
         FROM shifts s
         LEFT JOIN employees e ON e.id = s.employee_id
         LEFT JOIN locations l ON l.id = s.location_id
         WHERE s.id = $1`,
        [shiftId],
      );
      if (shift.rows.length === 0) {
        return NextResponse.json({ error: "Shift not found" }, { status: 404 });
      }
      const s = shift.rows[0];
      const report = await buildShiftReport(orgId, shiftId, s.location_id, s.opened_at, s.closed_at || new Date().toISOString());
      return NextResponse.json({ shift: s, report });
    }

    // ── Daily Z-report for location ──
    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = `${date}T23:59:59.999Z`;

    // Get all shifts for this location on this date
    const shifts = await orgQuery(
      orgId,
      `SELECT s.*, e.display_name AS employee_name
       FROM shifts s
       LEFT JOIN employees e ON e.id = s.employee_id
       WHERE s.location_id = $1 AND s.opened_at >= $2 AND s.opened_at <= $3
       ORDER BY s.opened_at`,
      [locationId, dayStart, dayEnd],
    );

    // Transactions for the whole day at this location
    const txns = await orgQuery(
      orgId,
      `SELECT t.id, t.status, t.subtotal, t.discount_total, t.tax_total, t.grand_total,
              t.tender_type, t.amount_tendered, t.change_due, t.employee_id, t.customer_id,
              t.created_at, t.cart_snapshot
       FROM transactions t
       WHERE t.location_id = $1 AND t.created_at >= $2 AND t.created_at <= $3
       ORDER BY t.created_at`,
      [locationId, dayStart, dayEnd],
    );

    const completed = txns.rows.filter((t: Record<string, unknown>) => t.status === "completed");
    const voided = txns.rows.filter((t: Record<string, unknown>) => t.status === "voided");
    const refunded = txns.rows.filter((t: Record<string, unknown>) => t.status === "refunded");

    // Tender breakdown
    const txnIds = completed.map((t: Record<string, unknown>) => t.id);
    let tenderBreakdown: Record<string, unknown>[] = [];
    if (txnIds.length > 0) {
      const tenders = await orgQuery(
        orgId,
        `SELECT tender_type, SUM(amount)::numeric AS total, COUNT(*)::int AS count
         FROM transaction_tenders
         WHERE transaction_id = ANY($1)
         GROUP BY tender_type
         ORDER BY total DESC`,
        [txnIds],
      );
      tenderBreakdown = tenders.rows;
    }

    // Pay ins/outs for the day
    const payInOuts = await orgQuery(
      orgId,
      `SELECT direction, SUM(amount)::numeric AS total, COUNT(*)::int AS count
       FROM pay_in_outs
       WHERE location_id = $1 AND created_at >= $2 AND created_at <= $3
       GROUP BY direction`,
      [locationId, dayStart, dayEnd],
    );
    const payInTotal = Number(payInOuts.rows.find((r: Record<string, unknown>) => r.direction === "pay_in")?.total ?? 0);
    const payOutTotal = Number(payInOuts.rows.find((r: Record<string, unknown>) => r.direction === "pay_out")?.total ?? 0);

    // Item count from cart snapshots
    let totalItemsSold = 0;
    for (const t of completed) {
      const snapshot = t.cart_snapshot as { items?: unknown[] } | null;
      if (snapshot?.items) {
        for (const item of snapshot.items as { quantity?: number }[]) {
          totalItemsSold += item.quantity ?? 1;
        }
      }
    }

    // Hourly breakdown
    const hourlyMap = new Map<number, { count: number; total: number }>();
    for (const t of completed) {
      const hour = new Date(t.created_at as string).getHours();
      const existing = hourlyMap.get(hour) ?? { count: 0, total: 0 };
      existing.count += 1;
      existing.total += Number(t.grand_total);
      hourlyMap.set(hour, existing);
    }
    const hourlyBreakdown = Array.from(hourlyMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([hour, data]) => ({
        hour,
        label: `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`,
        ...data,
        total: Number(data.total.toFixed(2)),
      }));

    // Top products
    const productMap = new Map<string, { name: string; sku: string; quantity: number; revenue: number }>();
    for (const t of completed) {
      const snapshot = t.cart_snapshot as { items?: { name?: string; sku?: string; quantity?: number; price?: number; productVariantId?: string }[] } | null;
      if (snapshot?.items) {
        for (const item of snapshot.items) {
          const key = item.productVariantId || item.sku || item.name || "unknown";
          const existing = productMap.get(key) ?? { name: item.name || "Unknown", sku: item.sku || "", quantity: 0, revenue: 0 };
          existing.quantity += item.quantity ?? 1;
          existing.revenue += (item.price ?? 0) * (item.quantity ?? 1);
          productMap.set(key, existing);
        }
      }
    }
    const topProducts = Array.from(productMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map((p) => ({ ...p, revenue: Number(p.revenue.toFixed(2)) }));

    // Employee breakdown
    const employeeMap = new Map<string, { id: string; count: number; total: number }>();
    for (const t of completed) {
      const empId = t.employee_id as string;
      const existing = employeeMap.get(empId) ?? { id: empId, count: 0, total: 0 };
      existing.count += 1;
      existing.total += Number(t.grand_total);
      employeeMap.set(empId, existing);
    }
    let employeeBreakdown: Record<string, unknown>[] = [];
    if (employeeMap.size > 0) {
      const empIds = Array.from(employeeMap.keys());
      const emps = await orgQuery(orgId, `SELECT id, display_name FROM employees WHERE id = ANY($1)`, [empIds]);
      const empNames = new Map(emps.rows.map((e: Record<string, unknown>) => [e.id, e.display_name]));
      employeeBreakdown = Array.from(employeeMap.values()).map((e) => ({
        ...e,
        name: empNames.get(e.id) || "Unknown",
        total: Number(e.total.toFixed(2)),
      }));
    }

    const grossSales = completed.reduce((s: number, t: Record<string, unknown>) => s + Number(t.grand_total), 0);
    const totalDiscounts = completed.reduce((s: number, t: Record<string, unknown>) => s + Number(t.discount_total), 0);
    const totalTax = completed.reduce((s: number, t: Record<string, unknown>) => s + Number(t.tax_total), 0);
    const totalRefunds = refunded.reduce((s: number, t: Record<string, unknown>) => s + Math.abs(Number(t.grand_total)), 0);
    const netSales = grossSales - totalRefunds;

    // Cash accountability
    const cashTendered = Number(tenderBreakdown.find((t: Record<string, unknown>) => t.tender_type === "cash")?.total ?? 0);
    const totalOpeningFloat = shifts.rows.reduce((s: number, sh: Record<string, unknown>) => s + Number(sh.opening_float ?? 0), 0);
    const totalChangeDue = completed.reduce((s: number, t: Record<string, unknown>) => s + Number(t.change_due), 0);
    const expectedCashInDrawer = totalOpeningFloat + cashTendered - totalChangeDue + payInTotal - payOutTotal;

    const totalVariance = shifts.rows
      .filter((s: Record<string, unknown>) => s.status === "closed")
      .reduce((sum: number, s: Record<string, unknown>) => sum + Number(s.closing_variance ?? 0), 0);

    const location = await orgQuery(orgId, `SELECT name FROM locations WHERE id = $1`, [locationId]);

    return NextResponse.json({
      date,
      locationName: location.rows[0]?.name ?? "Unknown",
      locationId,
      summary: {
        grossSales: Number(grossSales.toFixed(2)),
        totalDiscounts: Number(totalDiscounts.toFixed(2)),
        totalTax: Number(totalTax.toFixed(2)),
        totalRefunds: Number(totalRefunds.toFixed(2)),
        netSales: Number(netSales.toFixed(2)),
        transactionCount: completed.length,
        voidCount: voided.length,
        refundCount: refunded.length,
        totalItemsSold,
        averageTicket: completed.length > 0 ? Number((grossSales / completed.length).toFixed(2)) : 0,
      },
      cash: {
        openingFloat: Number(totalOpeningFloat.toFixed(2)),
        cashTendered: Number(cashTendered.toFixed(2)),
        changeDue: Number(totalChangeDue.toFixed(2)),
        payIns: Number(payInTotal.toFixed(2)),
        payOuts: Number(payOutTotal.toFixed(2)),
        expectedInDrawer: Number(expectedCashInDrawer.toFixed(2)),
        totalVariance: Number(totalVariance.toFixed(2)),
      },
      tenderBreakdown,
      hourlyBreakdown,
      topProducts,
      employeeBreakdown,
      shifts: shifts.rows,
    });
  } catch (err) {
    console.error("GET /api/shift-report error:", err);
    return NextResponse.json({ error: "Failed to generate shift report" }, { status: 500 });
  }
}

/**
 * POST /api/shift-report
 *
 * Body: { action: "close_shift", shiftId, declaredCash, note?, blindClose? }
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAdminPermission('register.open');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "close_shift") {
      const { shiftId, declaredCash, note, blindClose, employeeId } = body;
      if (!shiftId) return NextResponse.json({ error: "shiftId required" }, { status: 400 });

      const client = await orgTx(orgId);
      let auditPayload: { expected: number; declared: number; variance: number; blind: boolean; location_id: string; employee_id: string };
      try {
        const shift = await client.query(
          `SELECT s.*, rs.id AS reg_session_id FROM shifts s
           LEFT JOIN register_sessions rs ON rs.id = s.register_session_id
           WHERE s.id = $1 AND s.status = 'open' FOR UPDATE`,
          [shiftId],
        );
        if (shift.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Shift not found or already closed" }, { status: 400 });
        }
        const s = shift.rows[0];

        // Calculate expected cash
        const txns = await client.query(
          `SELECT COALESCE(SUM(tt.amount), 0)::numeric AS cash_in
           FROM transaction_tenders tt
           JOIN transactions t ON t.id = tt.transaction_id
           WHERE t.location_id = $1 AND t.created_at >= $2 AND t.status = 'completed' AND tt.tender_type = 'cash'`,
          [s.location_id, s.opened_at],
        );
        const changeDue = await client.query(
          `SELECT COALESCE(SUM(t.change_due), 0)::numeric AS total_change
           FROM transactions t
           WHERE t.location_id = $1 AND t.created_at >= $2 AND t.status = 'completed'`,
          [s.location_id, s.opened_at],
        );
        const payInOuts = await client.query(
          `SELECT direction, COALESCE(SUM(amount), 0)::numeric AS total
           FROM pay_in_outs WHERE shift_id = $1 GROUP BY direction`,
          [shiftId],
        );

        const cashIn = Number(txns.rows[0]?.cash_in ?? 0);
        const totalChange = Number(changeDue.rows[0]?.total_change ?? 0);
        const payIn = Number(payInOuts.rows.find((r: Record<string, unknown>) => r.direction === "pay_in")?.total ?? 0);
        const payOut = Number(payInOuts.rows.find((r: Record<string, unknown>) => r.direction === "pay_out")?.total ?? 0);
        const expectedCash = Number(s.opening_float) + cashIn - totalChange + payIn - payOut;
        const declared = blindClose ? expectedCash : (declaredCash ?? expectedCash);
        const variance = Number((declared - expectedCash).toFixed(2));

        await client.query(
          `UPDATE shifts SET status = 'closed', closed_at = now(), closing_expected_cash = $1,
           closing_declared_cash = $2, closing_variance = $3, closed_note = $4, blind_close = $5, updated_at = now()
           WHERE id = $6`,
          [expectedCash, declared, variance, note || null, blindClose || false, shiftId],
        );

        // Capture scope-dependent values before transaction block closes
        auditPayload = {
          expected: expectedCash,
          declared,
          variance,
          blind: blindClose || false,
          location_id: s.location_id,
          employee_id: employeeId || s.employee_id,
        };

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      // Audit event — outside transaction so audit failure doesn't rollback the shift close
      try {
        await pool.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'shift', $5, 'shift_closed', $6, now())`,
          [
            randomUUID(), orgId, auditPayload.location_id, auditPayload.employee_id, shiftId,
            JSON.stringify({ expected: auditPayload.expected, declared: auditPayload.declared, variance: auditPayload.variance, blind: auditPayload.blind }),
          ],
        );
      } catch (err) {
        console.error("[shift-report] audit event failed:", err);
      }

      return NextResponse.json({
        shiftId,
        status: "closed",
        expectedCash: Number(auditPayload.expected.toFixed(2)),
        declaredCash: Number(auditPayload.declared.toFixed(2)),
        variance: auditPayload.variance,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("POST /api/shift-report error:", err);
    return NextResponse.json({ error: "Failed to process shift action" }, { status: 500 });
  }
}

/** Helper: build report data for a single shift */
async function buildShiftReport(orgId: string, shiftId: string, locationId: string, openedAt: string, closedAt: string) {
  const txns = await orgQuery(
    orgId,
    `SELECT t.*, (SELECT json_agg(json_build_object('type', tt.tender_type, 'amount', tt.amount))
       FROM transaction_tenders tt WHERE tt.transaction_id = t.id) AS tenders
     FROM transactions t
     WHERE t.location_id = $1 AND t.created_at >= $2 AND t.created_at <= $3 AND t.status = 'completed'`,
    [locationId, openedAt, closedAt],
  );
  const grossSales = txns.rows.reduce((s: number, t: Record<string, unknown>) => s + Number(t.grand_total), 0);
  const txnCount = txns.rows.length;
  return { grossSales: Number(grossSales.toFixed(2)), transactionCount: txnCount };
}
