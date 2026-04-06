"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { pool } from "@/lib/db";
import { requireRegisterPermission, requireAdminPermission } from "@/lib/authz";
import { getRegisterSession, getAdminSession, signInRegister, signOutRegister } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { mutateStore } from "@/lib/persistence/store";
import {
  pgOpenShift,
  pgCloseShift,
  pgInsertAuditEvent,
} from "@/lib/persistence/postgres-store";
import type { Customer } from "@/lib/domain/types";

const isPg = () => !!process.env.USE_POSTGRES;

export async function registerLoginAction(formData: FormData) {
  const locationId = String(formData.get("locationId") ?? "");
  const deviceId = String(formData.get("deviceId") ?? "") || undefined;

  // Rate-limit by location to prevent PIN brute-force (5 attempts/min)
  const rl = checkRateLimit(`pin:${locationId}`);
  if (!rl.allowed) {
    const secs = Math.ceil(rl.retryAfterMs / 1000);
    redirect(`/register?error=Too+many+login+attempts.+Try+again+in+${secs}+seconds`);
  }

  const loginResult = await signInRegister(
    String(formData.get("pin") ?? ""),
    locationId,
    deviceId,
  );
  if (!loginResult) redirect("/register?error=PIN+login+failed");
  const { employee, location, registerSession } = loginResult;

  // Audit: log register login (non-fatal — shift open and redirect proceed regardless)
  if (isPg()) {
    pgInsertAuditEvent(
      employee.organizationId, location.id, employee.id,
      "session", registerSession.id, "register_login",
      { location_id: location.id, register_session_id: registerSession.id },
    ).catch((err) => console.error("[registerLoginAction] login audit failed:", err));

    // Auto-open shift on login — workers clock in by entering their PIN
    const shiftId = randomUUID();
    await pgOpenShift({
      id: shiftId,
      organizationId: employee.organizationId,
      locationId: location.id,
      employeeId: employee.id,
      registerSessionId: registerSession.id,
      openingFloat: 0,
    });
    await pgInsertAuditEvent(
      employee.organizationId, location.id, employee.id,
      "shift", shiftId, "shift_opened",
      { register_session_id: registerSession.id, opening_float: "0.00" },
    );
  }

  revalidatePath("/register");
  redirect("/register?notice=Clocked+in");
}

export async function openShiftAction(formData: FormData) {
  const context = await requireRegisterPermission("register.open");
  const openingFloat = Number(formData.get("openingFloat") ?? 0);
  const openedNote = String(formData.get("openedNote") ?? "").trim();

  if (Number.isNaN(openingFloat) || openingFloat < 0) {
    redirect("/register?error=Opening+float+must+be+0+or+greater");
  }

  if (isPg()) {
    if (context.registerSession.activeShiftId) {
      redirect("/register?error=Shift+already+open");
    }
    const shiftId = randomUUID();
    await pgOpenShift({
      id: shiftId, organizationId: context.employee.organizationId, locationId: context.location.id,
      employeeId: context.employee.id,
      registerSessionId: context.registerSession.id,
      openingFloat, openedNote: openedNote || undefined,
    });
    await pgInsertAuditEvent(
      context.employee.organizationId, context.location.id, context.employee.id,
      "shift", shiftId, "shift_opened",
      { register_session_id: context.registerSession.id, opening_float: openingFloat.toFixed(2) },
    );
  } else {
    await mutateStore((store) => {
      const timestamp = new Date().toISOString();
      const registerSession = store.registerSessions.find((entry) => entry.id === context.registerSession.id);
      if (!registerSession || registerSession.status !== "active") {
        redirect("/register?error=Register+session+not+available");
      }
      if (registerSession.activeShiftId) {
        redirect("/register?error=Shift+already+open");
      }
      const shiftId = randomUUID();
      store.shifts.unshift({
        id: shiftId, locationId: context.location.id,
        employeeId: context.employee.id,
        registerSessionId: registerSession.id,
        status: "open", openedAt: timestamp,
        openingFloat, openedNote: openedNote || undefined,
      });
      registerSession.activeShiftId = shiftId;
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(), transactionId: "txn_register_shift_placeholder",
        eventKind: "shift_opened", actorEmployeeId: context.employee.id,
        notes: `Shift opened by ${context.employee.displayName}`,
        payload: {
          register_session_id: registerSession.id, shift_id: shiftId,
          opening_float: openingFloat.toFixed(2),
        },
        createdAt: timestamp,
      });
    });
  }

  revalidatePath("/register");
  revalidatePath("/admin/clock-in");
  redirect("/register?notice=Shift+opened");
}

/**
 * Admin version of openShiftAction — for use from admin pages.
 * Does NOT require a register session. Uses admin auth instead.
 */
export async function adminOpenShiftAction(formData: FormData) {
  const locationId = String(formData.get("locationId") ?? "");
  const employeeId = String(formData.get("employeeId") ?? "");
  const openingFloat = Number(formData.get("openingFloat") ?? 0);
  const openedNote = String(formData.get("openedNote") ?? "").trim();

  // Only require admin auth — not POS register permission
  const ctx = await getAdminSession();
  if (!ctx || !ctx.session || !ctx.employee) {
    redirect("/?error=Not+authorized+to+open+shifts");
  }
  if (!locationId || !employeeId) {
    redirect("/admin/clock-in?error=Location+and+employee+are+required");
  }
  if (Number.isNaN(openingFloat) || openingFloat < 0) {
    redirect("/admin/clock-in?error=Opening+float+must+be+0+or+greater");
  }

  // Check if employee already has an open shift at this location
  if (isPg()) {
    const { rows: existing } = await pool.query(
      `SELECT id FROM shifts WHERE employee_id = $1 AND location_id = $2 AND status = 'open' LIMIT 1`,
      [employeeId, locationId],
    );
    if (existing.length > 0) {
      redirect("/admin/clock-in?error=Employee+already+has+an+open+shift");
    }
    const shiftId = randomUUID();
    await (await import("@/lib/persistence/postgres-store")).pgOpenShift({
      id: shiftId, organizationId: ctx.employee.organizationId, locationId, employeeId, registerSessionId: null,
      openingFloat, openedNote: openedNote || undefined,
    });
    await (await import("@/lib/persistence/postgres-store")).pgInsertAuditEvent(
      ctx.employee.organizationId, locationId, ctx.employee.id,
      "shift", shiftId, "shift_opened",
      { employee_id: employeeId, opening_float: openingFloat.toFixed(2) },
    );
  } else {
    redirect("/admin/clock-in?error=Admin+shift+opening+not+supported+in+JSON+mode");
  }

  revalidatePath("/admin/clock-in");
  revalidatePath("/admin/shifts");
  redirect("/admin/clock-in?notice=Shift+opened");
}

export async function closeShiftAction(formData: FormData) {
  const context = await requireRegisterPermission("register.open");
  const closingExpectedCash = Number(formData.get("closingExpectedCash") ?? 0);
  const closingDeclaredCash = Number(formData.get("closingDeclaredCash") ?? 0);
  const closedNote = String(formData.get("closedNote") ?? "").trim();

  if (Number.isNaN(closingExpectedCash) || Number.isNaN(closingDeclaredCash) || closingExpectedCash < 0 || closingDeclaredCash < 0) {
    redirect("/register?error=Closing+cash+amounts+must+be+0+or+greater");
  }

  if (isPg()) {
    if (!context.registerSession.activeShiftId) {
      redirect("/register?error=No+active+shift+to+close");
    }
    const shift = await pgCloseShift(context.registerSession.activeShiftId, context.registerSession.id, {
      closingExpectedCash, closingDeclaredCash, closedNote: closedNote || undefined,
    });
    await pgInsertAuditEvent(
      context.employee.organizationId, context.location.id, context.employee.id,
      "shift", shift.id, "shift_closed",
      {
        register_session_id: context.registerSession.id,
        expected_cash: closingExpectedCash.toFixed(2),
        declared_cash: closingDeclaredCash.toFixed(2),
        variance: (shift.closingVariance ?? 0).toFixed(2),
      },
    );
  } else {
    await mutateStore((store) => {
      const timestamp = new Date().toISOString();
      const registerSession = store.registerSessions.find((entry) => entry.id === context.registerSession.id);
      if (!registerSession?.activeShiftId) {
        redirect("/register?error=No+active+shift+to+close");
      }
      const shift = store.shifts.find((entry) => entry.id === registerSession.activeShiftId && entry.status === "open");
      if (!shift) {
        redirect("/register?error=Shift+not+found");
      }
      shift.status = "closed";
      shift.closedAt = timestamp;
      shift.closingExpectedCash = closingExpectedCash;
      shift.closingDeclaredCash = closingDeclaredCash;
      shift.closingVariance = Number((closingDeclaredCash - closingExpectedCash).toFixed(2));
      shift.closedNote = closedNote || undefined;
      registerSession.activeShiftId = undefined;
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(), transactionId: "txn_register_shift_placeholder",
        eventKind: "shift_closed", actorEmployeeId: context.employee.id,
        notes: `Shift closed by ${context.employee.displayName}`,
        payload: {
          register_session_id: registerSession.id, shift_id: shift.id,
          expected_cash: closingExpectedCash.toFixed(2),
          declared_cash: closingDeclaredCash.toFixed(2),
          variance: shift.closingVariance.toFixed(2),
        },
        createdAt: timestamp,
      });
    });
  }

  revalidatePath("/register");
  redirect("/register?notice=Shift+closed");
}

export async function registerLogoutAction() {
  const session = await getRegisterSession();
  if (!session) {
    redirect("/register");
  }

  // Capture context for audit before destroying the session
  const { employee, location, registerSession } = session;
  const sessionId = session.session.id;

  await signOutRegister();

  // Audit: log register logout (non-fatal — redirect still proceeds)
  if (isPg()) {
    pgInsertAuditEvent(
      employee.organizationId, location.id, employee.id,
      "session", sessionId, "register_logout",
      { register_session_id: registerSession.id },
    ).catch((err) => console.error("[registerLogoutAction] audit failed:", err));
  }

  revalidatePath("/register");
  redirect("/register?notice=Register+session+closed");
}

export async function quickSwitchAction(pin: string): Promise<{ success: boolean; error?: string; newEmployeeName?: string }> {
  const context = await requireRegisterPermission("register.open");
  const locationId = context.location.id;

  // Rate-limit by location
  const rl = checkRateLimit(`pin:${locationId}`);
  if (!rl.allowed) {
    return { success: false, error: `Too many attempts. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s` };
  }

  const cleanPin = pin.trim();
  if (!cleanPin) return { success: false, error: "PIN is required" };

  if (isPg()) {
    const { pgFindCredentialByPin } = await import("@/lib/persistence/postgres-store");
    const { verifySecret } = await import("@/lib/auth/crypto");
    const pool = (await import("@/lib/db")).default;

    const credential = await pgFindCredentialByPin(cleanPin);
    if (!credential) return { success: false, error: "Invalid PIN" };

    const { readStore } = await import("@/lib/persistence/store");
    const store = await readStore(context.employee.organizationId);
    const newEmployee = store.employees.find((e) => e.id === credential.employeeId && e.isActive);
    if (!newEmployee || !newEmployee.locationIds.includes(locationId)) {
      return { success: false, error: "Employee not found or not assigned to this location" };
    }

    if (newEmployee.id === context.employee.id) {
      return { success: false, error: "Already signed in as this employee" };
    }

    const timestamp = new Date().toISOString();

    // Update auth session employee
    await pool.query(`UPDATE sessions SET employee_id = $1 WHERE id = $2`, [newEmployee.id, context.session.id]);

    // Update register session employee
    await pool.query(
      `UPDATE register_sessions SET employee_id = $1, updated_at = $2 WHERE id = $3`,
      [newEmployee.id, timestamp, context.registerSession.id],
    );

    // Update shift employee (new person takes drawer responsibility)
    if (context.registerSession.activeShiftId) {
      await pool.query(
        `UPDATE shifts SET employee_id = $1 WHERE id = $2`,
        [newEmployee.id, context.registerSession.activeShiftId],
      );
    }

    // Audit event
    await pgInsertAuditEvent(
      context.employee.organizationId, locationId, newEmployee.id,
      "register_session", context.registerSession.id, "pin_login",
      {
        previous_employee_id: context.employee.id,
        previous_employee_name: context.employee.displayName,
        quick_switch: "true",
      },
    );

    revalidatePath("/register");
    return { success: true, newEmployeeName: newEmployee.displayName };
  }

  // JSON fallback
  const { verifySecret } = await import("@/lib/auth/crypto");
  const { readStore } = await import("@/lib/persistence/store");
  const store = await readStore();
  const credential = store.authCredentials.find((c) => c.pinHash && verifySecret(cleanPin, c.pinHash));
  if (!credential) return { success: false, error: "Invalid PIN" };

  const newEmployee = store.employees.find((e) => e.id === credential.employeeId && e.isActive);
  if (!newEmployee || !newEmployee.locationIds.includes(locationId)) {
    return { success: false, error: "Employee not found" };
  }
  if (newEmployee.id === context.employee.id) {
    return { success: false, error: "Already signed in" };
  }

  await mutateStore((s) => {
    const session = s.sessions.find((e) => e.id === context.session.id);
    if (session) session.employeeId = newEmployee.id;
    const regSession = s.registerSessions.find((e) => e.id === context.registerSession.id);
    if (regSession) regSession.employeeId = newEmployee.id;
    const shift = regSession?.activeShiftId ? s.shifts.find((e) => e.id === regSession.activeShiftId) : null;
    if (shift) shift.employeeId = newEmployee.id;

    s.transactionEventPlaceholders.unshift({
      id: randomUUID(),
      transactionId: "txn_register_session_placeholder",
      eventKind: "pin_login",
      actorEmployeeId: newEmployee.id,
      notes: `Quick switch from ${context.employee.displayName} to ${newEmployee.displayName}`,
      payload: { previous_employee_id: context.employee.id, quick_switch: "true" },
      createdAt: new Date().toISOString(),
    });
  });

  revalidatePath("/register");
  return { success: true, newEmployeeName: newEmployee.displayName };
}

export async function createCustomerAction(data: {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}): Promise<Customer | null> {
  const context = await requireRegisterPermission("register.open");

  if (!data.firstName.trim() || !data.lastName.trim()) return null;

  const id = randomUUID();
  const orgId = context.employee.organizationId;

  if (isPg()) {
    const { pgCreateCustomer } = await import("@/lib/persistence/postgres-phase2");
    const customer = await pgCreateCustomer({
      id,
      organizationId: orgId,
      firstName: data.firstName.trim(),
      lastName: data.lastName.trim(),
      email: data.email?.trim() || undefined,
      phone: data.phone?.trim() || undefined,
    });
    return customer;
  }

  // JSON fallback
  const ts = new Date().toISOString();
  const customer: Customer = {
    id,
    organizationId: orgId,
    firstName: data.firstName.trim(),
    lastName: data.lastName.trim(),
    email: data.email?.trim(),
    phone: data.phone?.trim(),
    loyaltyPoints: 0,
    totalSpend: 0,
    visitCount: 0,
    storeCreditBalance: 0,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  };

  await mutateStore((store) => {
    store.customers.push(customer);
  });

  return customer;
}
