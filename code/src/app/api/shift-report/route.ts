import { NextResponse } from "next/server";
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import { randomUUID } from "@/lib/uuid";
import { withAdminAuth, withDualAuth } from "@/lib/api/with-auth";
import { validateBody, shiftReportSchema } from "@/lib/validation/schemas";
// R95-MED: `shifts` is in readStore; POST close_shift UPDATEs
// status + closing_* fields. Bust the cache.
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";


import { safeErr } from "@/lib/logging/safe-err";
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
export const GET = withDualAuth("register.open", async (req, ctx) => {
  const { orgId, registerSession: _registerSession, locationId: defaultLocationId, employee } = ctx;

  try {
    const sp = req.nextUrl.searchParams;
    const requestedLocation = sp.get("location");
    // Z-report includes tenders, variance, cart snapshots — sensitive.
    // RLS alone only scopes by org, so a cashier at Location A could
    // read Location B's Z-report via `?location=<other-loc>` without
    // this gate. Require the requested location to be one of the
    // employee's assigned locations (or fall back to the employee's
    // default if no override is sent).
    const locationId = requestedLocation ?? defaultLocationId;
    if (requestedLocation) {
      const employeeLocIds = employee.locationIds ?? [];
      if (!employeeLocIds.includes(requestedLocation)) {
        return NextResponse.json({ error: "Location not assigned to this employee" }, { status: 403 });
      }
    }
    const date = sp.get("date") || new Date().toISOString().slice(0, 10);
    const shiftId = sp.get("shift");

    // ── Single shift report ──
    if (shiftId) {
      const shift = await orgQuery(
        orgId,
        `SELECT s.*, e.display_name AS employee_name, l.name AS location_name
         FROM shifts s
         LEFT JOIN employees e ON e.id = s.employee_id AND e.organization_id = $2
         LEFT JOIN locations l ON l.id = s.location_id AND l.organization_id = $2
         WHERE s.id = $1 AND s.organization_id = $2`,
        [shiftId, orgId],
      );
      if (shift.rows.length === 0) {
        return NextResponse.json({ error: "Shift not found" }, { status: 404 });
      }
      const s = shift.rows[0];
      // Same defense as the daily-location branch above: a cashier must
      // be assigned to this shift's location to see its Z-report.
      const employeeLocIds = employee.locationIds ?? [];
      if (!employeeLocIds.includes(s.location_id)) {
        return NextResponse.json({ error: "Shift not at an assigned location" }, { status: 403 });
      }
      const report = await buildShiftReport(orgId, shiftId, s.location_id, s.opened_at, s.closed_at || new Date().toISOString());
      return NextResponse.json({ shift: s, report });
    }

    // ── Daily Z-report for location ──
    //
    // R16-L-2 (closed): use org-timezone day boundaries, not UTC. The
    // helper `buildOrgDayRange` returns [fromTs, toTs) — toTs is the
    // EXCLUSIVE upper bound (start of next local day), so predicates use
    // `< $3`, not `<= $3`.
    const { buildOrgDayRange } = await import("@/lib/reports/day-range");
    const { fromTs, toTs } = await buildOrgDayRange(orgId, date, date);

    // Get all shifts for this location on this date
    const shifts = await orgQuery(
      orgId,
      `SELECT s.*, e.display_name AS employee_name
       FROM shifts s
       LEFT JOIN employees e ON e.id = s.employee_id AND e.organization_id = $4
       WHERE s.location_id = $1 AND s.opened_at >= $2 AND s.opened_at < $3 AND s.organization_id = $4
       ORDER BY s.opened_at`,
      [locationId, fromTs, toTs, orgId],
    );

    // Transactions for the whole day at this location
    const txns = await orgQuery(
      orgId,
      `SELECT t.id, t.status, t.subtotal, t.discount_total, t.tax_total, t.grand_total,
              t.tender_type, t.amount_tendered, t.change_due, t.employee_id, t.customer_id,
              t.created_at, t.cart_snapshot
       FROM transactions t
       WHERE t.location_id = $1 AND t.created_at >= $2 AND t.created_at < $3 AND t.organization_id = $4
       ORDER BY t.created_at`,
      [locationId, fromTs, toTs, orgId],
    );

    // R83-DB-H2 (HIGH): sign-based refund filter (parity with R82-
    // DB-H2/H3 on dashboard + eod-report). Register returns write
    // status='completed' with NEGATIVE grand_total — `status='refunded'`
    // catches ZERO rows in the register flow. Split completed into
    // `sales` (positive) and `refunded` (negative).
    const completedAll = txns.rows.filter((t: Record<string, unknown>) => t.status === "completed");
    const completed = completedAll.filter((t: Record<string, unknown>) => Number(t.grand_total) >= 0);
    const voided = txns.rows.filter((t: Record<string, unknown>) => t.status === "voided");
    const refunded = completedAll.filter((t: Record<string, unknown>) => Number(t.grand_total) < 0);

    // Tender breakdown
    const txnIds = completed.map((t: Record<string, unknown>) => t.id);
    let tenderBreakdown: Record<string, unknown>[] = [];
    if (txnIds.length > 0) {
      const tenders = await orgQuery(
        orgId,
        `SELECT tt.tender_type, SUM(tt.amount)::numeric AS total, COUNT(*)::int AS count
         FROM transaction_tenders tt
         JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $2
         WHERE tt.transaction_id = ANY($1)
         GROUP BY tt.tender_type
         ORDER BY total DESC`,
        [txnIds, orgId],
      );
      tenderBreakdown = tenders.rows;
    }

    // Pay ins/outs for the day
    const payInOuts = await orgQuery(
      orgId,
      `SELECT direction, SUM(amount)::numeric AS total, COUNT(*)::int AS count
       FROM pay_in_outs
       WHERE location_id = $1 AND created_at >= $2 AND created_at < $3 AND organization_id = $4
       GROUP BY direction`,
      [locationId, fromTs, toTs, orgId],
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
    // R83-MED: bucket on ORG TIMEZONE. Prior `getHours()` used
    // server-local (UTC on Workers). 9pm PDT showed as hour=4 next
    // day for Pacific-TZ stores.
    // check-pool-org-filter: scoped-by-id — organizations.id IS
    // the tenancy key for the organizations table itself (one row
    // per tenant), so WHERE id = $orgId is already the org filter.
    const orgTzRow = await orgQuery(orgId, `SELECT timezone FROM organizations WHERE id = $1`, [orgId]);
    const orgTz = (orgTzRow.rows[0]?.timezone as string | null) ?? 'UTC';
    const hourFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: orgTz,
      hour: 'numeric',
      hour12: false,
    });
    const hourlyMap = new Map<number, { count: number; total: number }>();
    for (const t of completed) {
      // hour: 'numeric' returns e.g. "14" or "0" in 24-hour mode.
      const parts = hourFormatter.formatToParts(new Date(t.created_at as string));
      const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
      const hour = parseInt(hourPart, 10) || 0;
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
      // R84-hand: parity with /api/reports — deleted employees
      // (employee_id → SET NULL per migration 046) have no rows in
      // `employees`, so previously surfaced as "Unknown" on shift-
      // reports. Reports route uses "Former Employee" which is the
      // standard fallback. Mirror that.
      const emps = await orgQuery(
        orgId,
        `SELECT id,
                COALESCE(display_name, CONCAT(first_name, ' ', last_name), 'Former Employee') AS display_name
           FROM employees WHERE id = ANY($1) AND organization_id = $2`,
        [empIds, orgId],
      );
      const empNames = new Map(emps.rows.map((e: Record<string, unknown>) => [e.id, e.display_name]));
      employeeBreakdown = Array.from(employeeMap.values()).map((e) => ({
        ...e,
        name: empNames.get(e.id) || "Former Employee",
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

    const location = await orgQuery(orgId, `SELECT name FROM locations WHERE id = $1 AND organization_id = $2`, [locationId, orgId]);

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
    console.error("GET /api/shift-report error:", safeErr(err));
    return NextResponse.json({ error: "Failed to generate shift report" }, { status: 500 });
  }
});

/**
 * POST /api/shift-report
 *
 * Body: { action: "close_shift", shiftId, declaredCash, note?, blindClose? }
 */
export const POST = withAdminAuth("register.open", async (req, ctx) => {
  const { orgId, employee } = ctx;
  try {
    const body = await req.json();
    const v = validateBody(shiftReportSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { action, shiftId, declaredCash, note, blindClose } = v.data;

    if (action === "close_shift") {
      if (!shiftId) return NextResponse.json({ error: "shiftId required" }, { status: 400 });

      // R33-H6: step-up auth. Sibling `/api/shift-close` POST has
      // enforced step-up via R32-X3's inline close; this sister
      // endpoint writes the SAME row through a parallel code path
      // and would let a stolen cashier cookie fabricate variance
      // without re-auth. Same bucket key as the API route so
      // attempts against either accumulate.
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: employee.id,
        orgId,
        actorPassword: (body as { actorPassword?: string }).actorPassword,
        bucketKey: 'shift-close-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }

      const client = await orgTx(orgId);
      let auditPayload: { expected: number; declared: number; variance: number; blind: boolean; location_id: string; employee_id: string };
      try {
        const shift = await client.query(
          `SELECT s.*, rs.id AS reg_session_id FROM shifts s
           LEFT JOIN register_sessions rs ON rs.id = s.register_session_id AND rs.organization_id = $2
           WHERE s.id = $1 AND s.status = 'open' AND s.organization_id = $2 FOR UPDATE`,
          [shiftId, orgId],
        );
        if (shift.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Shift not found or already closed" }, { status: 400 });
        }
        const s = shift.rows[0];

        // Cross-cashier / cross-location guard (matches /api/shift-close). The
        // sibling endpoint already enforces this; leaving it off here meant
        // any cashier with register.open could close another cashier's shift
        // at another location with a fabricated variance. Managers and owners
        // retain the ability to close any shift for end-of-day oversight.
        const isManager = ["owner", "manager"].includes(employee.roleKey);
        if (!isManager) {
          const locOk = (employee.locationIds ?? []).includes(s.location_id);
          const empOk = s.employee_id == null || s.employee_id === employee.id;
          if (!locOk || !empOk) {
            await client.query("ROLLBACK");
            return NextResponse.json(
              { error: "Cannot close a shift you don't own. Ask a manager." },
              { status: 403 },
            );
          }
        }

        // Calculate expected cash
        const txns = await client.query(
          `SELECT COALESCE(SUM(tt.amount), 0)::numeric AS cash_in
           FROM transaction_tenders tt
           JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $3
           WHERE t.location_id = $1 AND t.created_at >= $2 AND t.status = 'completed' AND tt.tender_type = 'cash'`,
          [s.location_id, s.opened_at, orgId],
        );
        const changeDue = await client.query(
          `SELECT COALESCE(SUM(t.change_due), 0)::numeric AS total_change
           FROM transactions t
           WHERE t.location_id = $1 AND t.created_at >= $2 AND t.status = 'completed' AND t.organization_id = $3`,
          [s.location_id, s.opened_at, orgId],
        );
        // check-pool-org-filter: scoped-by-shift-id-verified-in-tx
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
           WHERE id = $6 AND organization_id = $7`,
          [expectedCash, declared, variance, note || null, blindClose || false, shiftId, orgId],
        );

        // Capture scope-dependent values before transaction block closes
        auditPayload = {
          expected: expectedCash,
          declared,
          variance,
          blind: blindClose || false,
          location_id: s.location_id,
          employee_id: employee.id,
        };

        // R49: audit INSIDE the tx, matching the R47-M fix on
        // /api/shift-close. Prior shape did the audit post-commit
        // via orgQuery wrapped in a try/catch — on audit failure the
        // shift close committed with no audit row, leaving a fabricated-
        // variance vector with no trail. This sibling endpoint now
        // shares the same in-tx audit shape as /api/shift-close.
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'shift', $5, 'shift_closed', $6, now())`,
          [
            randomUUID(), orgId, auditPayload.location_id, auditPayload.employee_id, shiftId,
            JSON.stringify({
              expected: auditPayload.expected,
              declared: auditPayload.declared,
              variance: auditPayload.variance,
              blind: auditPayload.blind,
            }),
          ],
        );

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      invalidateStoreCache(orgId);
      return NextResponse.json({
        shiftId,
        status: "closed",
        expectedCash: Number(auditPayload.expected.toFixed(2)),
        declaredCash: Number(auditPayload.declared.toFixed(2)),
        variance: auditPayload.variance,
      }, { status: 200 });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("POST /api/shift-report error:", safeErr(err));
    return NextResponse.json({ error: "Failed to process shift action" }, { status: 500 });
  }
});

/** Helper: build report data for a single shift */
async function buildShiftReport(orgId: string, shiftId: string, locationId: string, openedAt: string, closedAt: string) {
  const txns = await orgQuery(
    orgId,
    `SELECT t.*, (SELECT json_agg(json_build_object('type', tt.tender_type, 'amount', tt.amount))
       FROM transaction_tenders tt WHERE tt.transaction_id = t.id) AS tenders
     FROM transactions t
     WHERE t.location_id = $1 AND t.created_at >= $2 AND t.created_at <= $3 AND t.status = 'completed' AND t.organization_id = $4`,
    [locationId, openedAt, closedAt, orgId],
  );
  const grossSales = txns.rows.reduce((s: number, t: Record<string, unknown>) => s + Number(t.grand_total), 0);
  const txnCount = txns.rows.length;
  return { grossSales: Number(grossSales.toFixed(2)), transactionCount: txnCount };
}
