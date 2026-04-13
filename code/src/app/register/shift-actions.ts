"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
import { requireRegisterPermission } from "@/lib/authz";
import { mutateStore } from "@/lib/persistence/store";
import { generateAndPersistFlags } from "@/lib/behavior/flag-engine";
import { orgTx } from "@/lib/db";

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

  if (input.amount <= 0) {
    return { success: false, error: "Amount must be greater than zero" };
  }

  if (isPg()) {
    const client = await orgTx(context.employee.organizationId);
    try {
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
      notes: `${input.direction === "pay_in" ? "Pay in" : "Pay out"}: $${input.amount.toFixed(2)} — ${input.reason}`,
      payload: {
        shift_id: context.activeShift!.id,
        direction: input.direction,
        amount: input.amount.toFixed(2),
        reason: input.reason,
      },
      createdAt: timestamp,
    });
  });

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

  const variance = Number((input.declaredCash - input.expectedCash).toFixed(2));

  if (isPg()) {
    const client = await orgTx(context.employee.organizationId);
    try {
      // 1. Close the shift with blind_close flag
      const { rows } = await client.query(
        `UPDATE shifts SET status = 'closed', closed_at = now(),
         closing_expected_cash = $1, closing_declared_cash = $2,
         closing_variance = $3, closed_note = $4, blind_close = $5
         WHERE id = $6 AND status = 'open' RETURNING id`,
        [
          input.expectedCash, input.declaredCash, variance,
          input.note || null, input.blindClose,
          context.activeShift!.id,
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
            expected_cash: input.expectedCash.toFixed(2),
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

    revalidatePath("/register");
    return { success: true };
  }

  await mutateStore((store) => {
    const timestamp = new Date().toISOString();
    const registerSession = store.registerSessions.find((s) => s.id === context.registerSession.id);
    if (!registerSession?.activeShiftId) return;

    const shift = store.shifts.find((s) => s.id === registerSession.activeShiftId && s.status === "open");
    if (!shift) return;

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

  revalidatePath("/register");
  return { success: true };
}
