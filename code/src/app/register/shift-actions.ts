"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
// R85-fix: bust readStore cache so /register page reflects shift
// open/close + pay_in/out immediately. Parity with R84-final
// admin-side + R84-hand checkout/return sweep.
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";
import { requireRegisterPermission } from "@/lib/authz";
import { mutateStore } from "@/lib/persistence/store";
import { generateAndPersistFlags } from "@/lib/behavior/flag-engine";
import { orgTx } from "@/lib/supabase-rest";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getRegisterConfig } from "@/lib/config/register-config";
import { hasPermission } from "@/lib/domain/permissions";
import { formatCurrency } from "@/lib/format";

const isPg = () => !!process.env.USE_POSTGRES;

// ── Pay in / Pay out ──────────────────────────────────────

export interface PayInOutInput {
  direction: "pay_in" | "pay_out";
  amount: number;
  reason: string;
  note: string;
}

export async function payInOutAction(input: PayInOutInput): Promise<{ success: boolean; error?: string }> {
  const context = await requireRegisterPermission("register.open");

  if (!context.activeShift) {
    return { success: false, error: "No active shift" };
  }

  // Bound + sanitize amount. Mirrors the /api/cash-drawer REST guards; without
  // these, a compromised client could extract arbitrary cash via this action.
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { success: false, error: "Amount must be a positive number" };
  }
  if (input.amount > 10_000) {
    return { success: false, error: "Amount exceeds maximum allowed" };
  }

  if (!input.reason || typeof input.reason !== "string" || input.reason.trim().length === 0) {
    return { success: false, error: "Reason is required" };
  }

  // Rate-limit per employee
  const rl = checkRateLimit(`pay-in-out:${context.employee.id}`);
  if (!rl.allowed) {
    return { success: false, error: "Too many requests" };
  }

  // Enforce manager-approval threshold on pay_outs above configured limit.
  if (input.direction === "pay_out") {
    const isManager = hasPermission(context.employee.roleKey, "approval.void_transaction");
    const config = await getRegisterConfig(context.employee.organizationId);
    const threshold = config.approvalThresholds.transactionVoidOver ?? 50;
    if (!isManager && input.amount > threshold) {
      return { success: false, error: `Pay-out exceeds $${threshold}; manager approval required.` };
    }
  }

  if (isPg()) {
    const client = await orgTx(context.employee.organizationId);
    try {
      // R76-DB-H2: FOR UPDATE the shift with status='open' predicate
      // BEFORE the INSERT so a concurrent closeShiftEnhancedAction
      // serializes — either this pay_in/out lands before the close
      // sees it (aggregated into expectedCash) or the close's lock
      // makes this SELECT wait + then return 0 rows (shift already
      // closed, reject). Prior shape let pay_in_outs land AFTER the
      // close's aggregation but BEFORE the close's UPDATE committed,
      // producing an invisible cash inflow / outflow.
      const { rows: shiftLock } = await client.query(
        `SELECT id FROM shifts WHERE id = $1 AND status = 'open' AND organization_id = $2 FOR UPDATE`,
        [context.activeShift!.id, context.employee.organizationId],
      );
      if (shiftLock.length === 0) {
        await client.query("ROLLBACK");
        return { success: false, error: "Shift is closed or not found" };
      }

      // 1. Insert pay-in/out record
      await client.query(
        `INSERT INTO pay_in_outs (id, organization_id, shift_id, location_id, employee_id, direction, amount, reason, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(), context.employee.organizationId, context.activeShift!.id,
          context.location.id, context.employee.id, input.direction,
          input.amount, input.reason, input.note || null,
        ],
      );

      // 2. Audit event — inside transaction (atomic with pay-in/out)
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'shift', $5, $6, $7, now())`,
        [
          randomUUID(), context.employee.organizationId, context.location.id,
          context.employee.id, context.activeShift!.id, input.direction,
          JSON.stringify({
            shift_id: context.activeShift!.id,
            direction: input.direction,
            amount: input.amount.toFixed(2),
            reason: input.reason,
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

    invalidateStoreCache(context.employee.organizationId);
  revalidatePath("/register");
    return { success: true };
  }

  await mutateStore((store) => {
    const timestamp = new Date().toISOString();

    store.payInOuts.unshift({
      id: randomUUID(),
      shiftId: context.activeShift!.id,
      locationId: context.location.id,
      employeeId: context.employee.id,
      direction: input.direction,
      amount: input.amount,
      reason: input.reason,
      note: input.note || undefined,
      createdAt: timestamp,
    });

    store.transactionEventPlaceholders.unshift({
      id: randomUUID(),
      transactionId: "txn_register_shift_placeholder",
      eventKind: input.direction,
      actorEmployeeId: context.employee.id,
      notes: `${input.direction === "pay_in" ? "Pay in" : "Pay out"}: ${formatCurrency(input.amount)} — ${input.reason}`,
      payload: {
        shift_id: context.activeShift!.id,
        direction: input.direction,
        amount: input.amount.toFixed(2),
        reason: input.reason,
      },
      createdAt: timestamp,
    });
  });

  invalidateStoreCache(context.employee.organizationId);
  revalidatePath("/register");
  return { success: true };
}

// ── Enhanced close shift (called from client component) ───

export interface CloseShiftInput {
  declaredCash: number;
  expectedCash: number;
  note: string;
  blindClose: boolean;
}

export async function closeShiftEnhancedAction(
  input: CloseShiftInput,
): Promise<{ success: boolean; error?: string }> {
  const context = await requireRegisterPermission("register.open");

  if (!context.activeShift) {
    return { success: false, error: "No active shift" };
  }

  if (isPg()) {
    const client = await orgTx(context.employee.organizationId);
    try {
      // 1. Recompute expected cash SERVER-SIDE. Never trust client input here —
      //    a dishonest cashier could fabricate expectedCash to erase a shortage.
      //    expected = opening_float + SUM(cash tenders on this shift) + SUM(pay_in) - SUM(pay_out)
      const shiftId = context.activeShift!.id;
      const orgId = context.employee.organizationId;

      // R76-DB-H2 (HIGH): serialize this close against concurrent
      // pay_in_outs writers (cash layaway deposits, cross-shift cash
      // refunds, payInOutAction). Prior shape:
      //   1. SELECT opening_float (no lock)
      //   2. Aggregate transaction_tenders + pay_in_outs
      //   3. UPDATE shifts WHERE status='open'
      // Between (2) and (3), a concurrent pay_in commit adds to
      // pay_in_outs that (2) never saw → expectedCash under-counts
      // by that amount → variance looks -N → cashier appears short.
      // Mirror /api/shift-close/route.ts:158-187: advisory lock +
      // FOR UPDATE on both shifts and register_sessions rows
      // BEFORE the aggregation.
      await client.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [`shift-close:${shiftId}`],
      );
      const { rows: sRows } = await client.query(
        `SELECT opening_float FROM shifts WHERE id = $1 AND status = 'open' AND organization_id = $2 FOR UPDATE`,
        [shiftId, orgId],
      );
      if (sRows.length === 0) {
        await client.query("ROLLBACK");
        return { success: false, error: "Shift not found or already closed" };
      }
      // Also lock the register_session so a concurrent session swap
      // or a payInOutAction (which doesn't currently lock) serializes
      // behind this close.
      await client.query(
        `SELECT id FROM register_sessions WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [context.registerSession.id, orgId],
      );
      const openingFloat = Number(sRows[0].opening_float) || 0;

      // Cash sales AND cash change given in one roundtrip, scoped to the
      // shift window. Without subtracting change_due the drawer is always
      // "short" by the total change given.
      const { rows: cashRows } = await client.query(
        `SELECT
           COALESCE((SELECT SUM(tt.amount)
             FROM transaction_tenders tt
             JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $3
             WHERE t.register_session_id = $1
               AND t.organization_id = $3
               AND t.created_at >= (SELECT opened_at FROM shifts WHERE id = $2 AND organization_id = $3)
               AND tt.tender_type = 'cash'
               AND t.status = 'completed'
           ), 0)::numeric AS cash_sales,
           COALESCE((SELECT SUM(t.change_due)
             FROM transactions t
             WHERE t.register_session_id = $1
               AND t.organization_id = $3
               AND t.created_at >= (SELECT opened_at FROM shifts WHERE id = $2 AND organization_id = $3)
               AND t.status = 'completed'
           ), 0)::numeric AS cash_change`,
        [context.registerSession.id, shiftId, orgId],
      );
      const netCash = Number(cashRows[0]?.cash_sales) || 0;
      const cashChange = Number(cashRows[0]?.cash_change) || 0;

      // pay_in_outs.direction is 'pay_in'/'pay_out', not 'in'/'out'.
      const { rows: pioRows } = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'pay_in' THEN amount ELSE -amount END), 0)::numeric AS net_flow
         FROM pay_in_outs
         WHERE shift_id = $1 AND organization_id = $2`,
        [shiftId, orgId],
      );
      const netFlow = Number(pioRows[0]?.net_flow) || 0;

      const expectedCash = Number((openingFloat + netCash - cashChange + netFlow).toFixed(2));
      const variance = Number((input.declaredCash - expectedCash).toFixed(2));

      // 2. Close the shift with blind_close flag (expected cash is SERVER-computed)
      const { rows } = await client.query(
        `UPDATE shifts SET status = 'closed', closed_at = now(),
         closing_expected_cash = $1, closing_declared_cash = $2,
         closing_variance = $3, closed_note = $4, blind_close = $5
         WHERE id = $6 AND status = 'open' AND organization_id = $7 RETURNING id`,
        [
          expectedCash, input.declaredCash, variance,
          input.note || null, input.blindClose,
          context.activeShift!.id, orgId,
        ],
      );

      if (!rows[0]) {
        await client.query("ROLLBACK");
        return { success: false, error: "Shift not found or already closed" };
      }

      // 2. Clear active shift on register session
      await client.query(
        `UPDATE register_sessions SET active_shift_id = NULL WHERE id = $1`,
        [context.registerSession.id],
      );

      // 3. Audit event — inside transaction (atomic with shift close)
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'shift', $5, 'shift_closed', $6, now())`,
        [
          randomUUID(), context.employee.organizationId, context.location.id,
          context.employee.id, context.activeShift!.id,
          JSON.stringify({
            register_session_id: context.registerSession.id,
            shift_id: context.activeShift!.id,
            // expected_cash MUST use the server-recomputed value, not
            // input.expectedCash. A dishonest cashier can submit a fabricated
            // expected_cash to the action; the shifts row writes the server
            // value, but logging the client value here would leave the audit
            // trail pointing at the wrong number.
            expected_cash: expectedCash.toFixed(2),
            declared_cash: input.declaredCash.toFixed(2),
            variance: variance.toFixed(2),
            blind_close: String(input.blindClose),
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

    invalidateStoreCache(context.employee.organizationId);
  revalidatePath("/register");
    return { success: true };
  }

  await mutateStore((store) => {
    const timestamp = new Date().toISOString();
    const registerSession = store.registerSessions.find((s) => s.id === context.registerSession.id);
    if (!registerSession?.activeShiftId) return;

    const shift = store.shifts.find((s) => s.id === registerSession.activeShiftId && s.status === "open");
    if (!shift) return;

    // JSON fallback: no transaction_tenders or pay_in_outs tables, so fall back
    // to trusting input.expectedCash for variance. Non-production path.
    const variance = Number((input.declaredCash - input.expectedCash).toFixed(2));

    shift.status = "closed";
    shift.closedAt = timestamp;
    shift.closingExpectedCash = input.expectedCash;
    shift.closingDeclaredCash = input.declaredCash;
    shift.closingVariance = variance;
    shift.closedNote = input.note || undefined;
    shift.blindClose = input.blindClose;
    registerSession.activeShiftId = undefined;

    store.transactionEventPlaceholders.unshift({
      id: randomUUID(),
      transactionId: "txn_register_shift_placeholder",
      eventKind: "shift_closed",
      actorEmployeeId: context.employee.id,
      notes: `Shift closed by ${context.employee.displayName}${input.blindClose ? " (blind)" : ""}`,
      payload: {
        register_session_id: registerSession.id,
        shift_id: shift.id,
        expected_cash: input.expectedCash.toFixed(2),
        declared_cash: input.declaredCash.toFixed(2),
        variance: variance.toFixed(2),
        blind_close: String(input.blindClose),
      },
      createdAt: timestamp,
    });

    // Run behavior flag engine on shift close to detect anomalies
    generateAndPersistFlags(store);
  });

  invalidateStoreCache(context.employee.organizationId);
  revalidatePath("/register");
  return { success: true };
}
