import { NextResponse } from "next/server";
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import { withDualAuth, withAdminAuth } from "@/lib/api/with-auth";
import { pgCloseShift } from "@/lib/persistence/postgres-store";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { validateBody, shiftCloseSchema } from "@/lib/validation/schemas";

import { safeErr } from "@/lib/logging/safe-err";
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
         WHERE s.location_id = $1 AND s.status = 'open' AND s.organization_id = $2
         ORDER BY s.opened_at DESC LIMIT 1`,
        [locationId, orgId],
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
         LEFT JOIN employees e ON e.id = s.employee_id AND e.organization_id = $2
         WHERE s.id = $1 AND s.organization_id = $2`,
        [shiftId, orgId],
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
    console.error("[shift-close GET]", safeErr(error));
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

    // R33-H6 (sibling to shift-report close_shift): step-up auth on
    // admin-driven shift close. Manager/owner can fabricate variance
    // and frame a cashier via this endpoint, so require password
    // re-entry. Shares the `shift-close-stepup` bucket with
    // /api/shift-report action=close_shift so brute-force attempts
    // aggregate. Register-side `closeShiftAction` still doesn't
    // need step-up because the cashier already entered their PIN.
    const { requireStepUp } = await import('@/lib/auth/step-up');
    const stepUp = await requireStepUp({
      actorId: ctx.employee.id,
      orgId,
      actorPassword: (body as { actorPassword?: string }).actorPassword,
      bucketKey: 'shift-close-stepup',
    });
    if (!stepUp.ok) {
      return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
    }

    // Get shift to find registerSessionId and verify it's still open. Also
    // fetch location_id and employee_id so we can refuse cross-cashier and
    // cross-location closes — otherwise any cashier holding register.open
    // can close another cashier's shift at another location with a
    // fabricated declared_cash, and the variance lands on the victim.
    const shiftRes = await orgQuery(
      orgId,
      `SELECT register_session_id, status, location_id, employee_id FROM shifts WHERE id = $1 AND organization_id = $2`,
      [shiftId, orgId],
    );
    if (shiftRes.rows.length === 0) {
      return NextResponse.json({ error: "Shift not found" }, { status: 404 });
    }
    if (shiftRes.rows[0].status !== 'open') {
      return NextResponse.json({ error: "Shift is not open" }, { status: 400 });
    }
    const shiftLocationId = shiftRes.rows[0].location_id as string;
    const shiftEmployeeId = shiftRes.rows[0].employee_id as string | null;
    const isManager = ["owner", "manager"].includes(ctx.employee.roleKey);
    if (!isManager) {
      // Cashiers can only close their OWN shifts at a location they're
      // assigned to. Managers/owners can close anything in the org (they
      // need this for end-of-day oversight).
      const locOk = (ctx.employee.locationIds ?? []).includes(shiftLocationId);
      const empOk = shiftEmployeeId === null || shiftEmployeeId === ctx.employee.id;
      if (!locOk || !empOk) {
        return NextResponse.json(
          { error: "Cannot close a shift you don't own. Ask a manager." },
          { status: 403 },
        );
      }
    }
    const registerSessionId = shiftRes.rows[0].register_session_id;

    // R32-D1: build the Z-report + commit the close inside ONE orgTx
    // with a FOR UPDATE lock on the shift row + an advisory lock keyed
    // on the shift id. Prior shape ran `buildZReport` on one client
    // (read snapshot COMMIT), then `pgCloseShift` on another. A cash
    // checkout could commit between the two and its tender row would
    // be missed by expectedCash, showing as a fake "over" variance on
    // the cashier's Z-report. With the advisory lock + in-tx
    // recomputation, concurrent checkouts either complete BEFORE the
    // lock (and are included) or wait BEHIND the lock (and hit a
    // "shift is closed" rejection on the FOR UPDATE of register_
    // sessions the checkout performs). Accounting is now consistent.
    const closeClient = await orgTx(orgId);
    let expectedCash: number;
    let report: ZReportData;
    try {
      await closeClient.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [`shift-close:${shiftId}`],
      );
      // FOR UPDATE the shift row too so any other code path touching
      // this shift blocks until our commit.
      const lockRes = await closeClient.query(
        `SELECT status FROM shifts WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [shiftId, orgId],
      );
      if (lockRes.rows.length === 0 || lockRes.rows[0].status !== 'open') {
        await closeClient.query('ROLLBACK');
        closeClient.release();
        return NextResponse.json({ error: "Shift is not open" }, { status: 400 });
      }

      // R32-D1: also FOR UPDATE the register_session. Checkout-action
      // takes FOR UPDATE on this row before committing a sale — by
      // acquiring it here FIRST, a concurrent in-flight checkout
      // either committed BEFORE (buildZReport sees it) or blocks
      // BEHIND our lock (and will see status='ended' on retry,
      // rejecting). Without this, the Z-report's snapshot could
      // miss a checkout that committed between the report read and
      // the close UPDATE.
      if (registerSessionId) {
        await closeClient.query(
          `SELECT id FROM register_sessions WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [registerSessionId, orgId],
        );
      }

      report = await buildZReport(orgId, shiftId, closeClient);
      expectedCash = report.expectedCash;

      // Inline the close — pgCloseShift opened its own orgTx which
      // would deadlock against our lock. Use the SAME client so the
      // whole lock-compute-write sequence is one serializable unit.
      const ts = new Date().toISOString();
      const variance = Number((Number(declaredCash) - expectedCash).toFixed(2));
      await closeClient.query(
        `UPDATE shifts SET status = 'closed', closed_at = $1, closing_expected_cash = $2,
         closing_declared_cash = $3, closing_variance = $4, closed_note = $5
         WHERE id = $6 AND status = 'open' AND organization_id = $7`,
        [ts, expectedCash, Number(declaredCash), variance, notes || null, shiftId, orgId],
      );
      if (registerSessionId) {
        // End the register session + clear active_shift_id.
        await closeClient.query(
          `UPDATE register_sessions
             SET status = 'ended', ended_at = $1, active_shift_id = NULL
           WHERE id = $2 AND organization_id = $3`,
          [ts, registerSessionId, orgId],
        );
      }
      await closeClient.query('COMMIT');
    } catch (e) {
      await closeClient.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      closeClient.release();
    }
    void pgCloseShift; // kept for legacy callers; not used on this path.

    return NextResponse.json({
      success: true,
      shift: { id: shiftId, closedAt: new Date().toISOString(), expectedCash, declaredCash: Number(declaredCash), variance: Number((Number(declaredCash) - expectedCash).toFixed(2)) },
      report,
    });
  } catch (error) {
    console.error("[shift-close POST]", safeErr(error));
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

interface ZReportClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

async function buildZReport(
  orgId: string,
  shiftId: string,
  externalClient?: ZReportClient,
): Promise<ZReportData> {
  // R25-perf-2: consolidate onto a single orgTx client. Prior shape
  // fired 3 concurrent `orgQuery` calls on remote, each opening a
  // fresh Neon WebSocket pool (~50-150ms handshake each). At end of
  // shift every cashier pays this — now one handshake amortized across
  // all reads, ~200-400ms faster modal open.
  // R32-D1: accept an external client so shift-close POST can run
  // the Z-report INSIDE the same tx as the UPDATE, closing the race
  // where a checkout commits between the report's COMMIT and the
  // close's UPDATE.
  const ownClient = externalClient ? null : await orgTx(orgId);
  const client: ZReportClient = (externalClient ?? ownClient) as ZReportClient;
  let shiftRes, txnsRes, payRes;
  try {
    shiftRes = await client.query(
      `SELECT opening_float, register_session_id, opened_at, closed_at FROM shifts WHERE id = $1 AND organization_id = $2`,
      [shiftId, orgId],
    );
    // Scope transactions to the shift window, not the entire register session
    // (which could include prior shifts sharing the session).
    txnsRes = await client.query(
      `SELECT t.id, t.status, t.grand_total, t.change_due
       FROM transactions t
       JOIN shifts s ON t.register_session_id = s.register_session_id AND s.organization_id = $2
       WHERE s.id = $1
         AND t.organization_id = $2
         AND t.created_at >= s.opened_at
         AND (s.closed_at IS NULL OR t.created_at <= s.closed_at)`,
      [shiftId, orgId],
    );
    // check-pool-org-filter: scoped-by-shift-id-verified-in-tx
    payRes = await client.query(
      `SELECT direction, SUM(amount)::numeric AS total
       FROM pay_in_outs
       WHERE shift_id = $1
       GROUP BY direction`,
      [shiftId],
    );
    if (ownClient) {
      await ownClient.query("COMMIT");
    }
  } catch (e) {
    if (ownClient) {
      await ownClient.query("ROLLBACK").catch(() => {});
    }
    throw e;
  } finally {
    if (ownClient) {
      (ownClient as { release: () => void }).release();
    }
  }

  const openingFloat = shiftRes.rows[0] ? Number(shiftRes.rows[0].opening_float) : 0;
  interface TenderRow { tender_type: string; amount: string; count: number }
  interface PayRow { direction: string; total: string }

  interface TxnRowWithChange { id: string; status: string; grand_total: string; change_due: string | null }
  const txns = txnsRes.rows as unknown as TxnRowWithChange[];
  // Returns are recorded by register return-action as status='completed' with
  // NEGATIVE grand_total. Detect refunds by sign, not just by status string.
  const completed = txns.filter((t) => t.status === "completed" && Number(t.grand_total) >= 0);
  const refunded = txns.filter(
    (t) => t.status === "refunded" || t.status === "returned" ||
           (t.status === "completed" && Number(t.grand_total) < 0),
  );
  const cashChangeGiven = completed.reduce((s, t) => s + (Number(t.change_due) || 0), 0);

  // Include BOTH positive-total sales and negative-total register refunds so
  // the tender breakdown reflects every cash movement for the shift window.
  // Previously only positive-sale tender rows were summed, so a register-side
  // cash refund (negative grand_total, status='completed') was invisible to
  // the Z-report and expectedCash was overstated by the refund amount.
  const allShiftTxnIds = [...completed.map((t) => t.id), ...refunded.map((t) => t.id)];
  let tenderBreakdown: Array<{ type: string; count: number; amount: number }> = [];

  if (allShiftTxnIds.length > 0) {
    // R32-D1: when called inside the shift-close tx, run this query
    // on the SAME client so it sees the same locked snapshot. When
    // called standalone (GET /api/shift-close or admin preview), fall
    // back to a fresh orgQuery.
    const tenderRes = externalClient
      ? await externalClient.query(
          `SELECT tt.tender_type, SUM(tt.amount)::numeric AS amount, COUNT(*)::int AS count
           FROM transaction_tenders tt
           JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $2
           WHERE tt.transaction_id = ANY($1)
           GROUP BY tt.tender_type
           ORDER BY amount DESC`,
          [allShiftTxnIds, orgId],
        )
      : await orgQuery(
          orgId,
          `SELECT tt.tender_type, SUM(tt.amount)::numeric AS amount, COUNT(*)::int AS count
           FROM transaction_tenders tt
           JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $2
           WHERE tt.transaction_id = ANY($1)
           GROUP BY tt.tender_type
           ORDER BY amount DESC`,
          [allShiftTxnIds, orgId],
        );
    tenderBreakdown = (tenderRes.rows as TenderRow[]).map((r) => ({
      type: r.tender_type,
      count: r.count,
      amount: Number(r.amount),
    }));
  }

  const salesAmount = completed.reduce((s, t) => s + Number(t.grand_total), 0);
  const refundsAmount = refunded.reduce((s, t) => s + Math.abs(Number(t.grand_total)), 0);

  const payRows = payRes.rows as unknown as PayRow[];
  const payIns = Number(payRows.find((r) => r.direction === "pay_in")?.total ?? 0);
  const payOuts = Number(payRows.find((r) => r.direction === "pay_out")?.total ?? 0);

  const cashTender = tenderBreakdown.find((t) => t.type === "cash");
  const cashSales = cashTender?.amount ?? 0;
  // Expected cash in drawer = opening_float + cash sales - change given back + pay_ins - pay_outs.
  // Without subtracting change_due, the drawer is always "short" by the total change given.
  const expectedCash = Number((openingFloat + cashSales - cashChangeGiven + payIns - payOuts).toFixed(2));

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
