"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
// R85-fix: bust readStore cache after shift / register-session
// mutations so /register/page.tsx sees the fresh state immediately.
// Parity with R84-final admin-side fix + R84-hand checkout/return.
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";
import { redirect } from "next/navigation";
import { requireRegisterPermission, hasPermission } from "@/lib/authz";import { getRegisterSession, getAdminSession, signInRegister, signOutRegister } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { mutateStore } from "@/lib/persistence/store";
import type { Customer } from "@/lib/domain/types";

import { safeErr } from "@/lib/logging/safe-err";
const isPg = () => !!process.env.USE_POSTGRES;

// All register-scoped RPCs now run through the direct DB pool. Round 24
// established that the Supabase REST path falls back to the anon key when
// SUPABASE_SERVICE_ROLE_KEY is not configured, and the SECURITY DEFINER
// RPCs here (register_open_shift, register_close_shift, register_insert_audit)
// were granted EXECUTE to PUBLIC/anon by default — together that was a
// free impersonation / audit-forgery primitive. Direct DB access through
// getPool() uses the `postgres` role and never depends on anon reachability.

// SCH2-H1 / ISO2-MED1 / ISO2-MED2: the catch in each wrapper used to
// be a bare `} catch {}`. That swallowed EVERY error from the SECDEF
// RPC — including the cross-tenant `RAISE EXCEPTION 'Cross-tenant
// ...'` checks that mig 077 added — and silently fell through to the
// legacy `pg*()` helper, which doesn't have those checks. Net effect:
// mig 077's defense-in-depth was dead code on every existing call path.
// Narrow the catch to only treat "RPC unavailable" classes as
// recoverable (function-not-installed, permission-denied), mirroring
// the pattern at register_quick_switch:648-653. Cross-tenant
// exceptions now propagate as errors.
function isRecoverableRpcError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /function .* does not exist/i.test(msg)
      || /permission denied for function/i.test(msg);
}

async function rpcInsertAudit(
  orgId: string, locationId: string | null, employeeId: string | null,
  entityType: string, entityId: string | null, eventKind: string,
  payload: Record<string, unknown> = {},
) {
  try {
    const { getPool } = await import("@/lib/supabase-rest");
    const pool = await getPool();
    await pool.query(
      `SELECT register_insert_audit($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb)`,
      [orgId, locationId, employeeId, entityType, entityId, eventKind, JSON.stringify(payload)],
    );
  } catch (rpcErr) {
    if (!isRecoverableRpcError(rpcErr)) throw rpcErr;
    // RPC unavailable — fall back to direct insert helper. The
    // helper itself was hardened in tandem with this commit
    // (postgres-store.ts pgInsertAuditEvent gained a cross-row org
    // consistency check) so the fallback now ALSO enforces ISO2-MED2.
    console.warn("[register_insert_audit] RPC unavailable; using column fallback:", safeErr(rpcErr));
    const { pgInsertAuditEvent } = await import("@/lib/persistence/postgres-store");
    await pgInsertAuditEvent(orgId, locationId, employeeId, entityType, entityId, eventKind, payload);
  }
}

async function rpcOpenShift(data: {
  id: string; organizationId: string; locationId: string; employeeId: string;
  registerSessionId: string | null; openingFloat: number; openedNote?: string;
}) {
  try {
    const { getPool } = await import("@/lib/supabase-rest");
    const pool = await getPool();
    await pool.query(
      `SELECT register_open_shift($1::text, $2::text, $3::text, $4::text, $5::text, $6::numeric, $7::text)`,
      [data.id, data.organizationId, data.locationId, data.employeeId, data.registerSessionId, data.openingFloat, data.openedNote ?? null],
    );
  } catch (rpcErr) {
    if (!isRecoverableRpcError(rpcErr)) throw rpcErr;
    console.warn("[register_open_shift] RPC unavailable; using column fallback:", safeErr(rpcErr));
    const { pgOpenShift } = await import("@/lib/persistence/postgres-store");
    await pgOpenShift(data);
  }
}

async function rpcCloseShift(shiftId: string, registerSessionId: string, data: {
  closingExpectedCash: number; closingDeclaredCash: number; closedNote?: string;
}, organizationId: string) {
  try {
    const { getPool } = await import("@/lib/supabase-rest");
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT register_close_shift($1::text, $2::text, $3::numeric, $4::numeric, $5::text) AS result`,
      [shiftId, registerSessionId, data.closingExpectedCash, data.closingDeclaredCash, data.closedNote ?? null],
    );
    const result = (rows[0]?.result ?? {}) as Record<string, unknown>;
    return { id: result.id as string, closingVariance: Number(result.closing_variance ?? 0) };
  } catch (rpcErr) {
    if (!isRecoverableRpcError(rpcErr)) throw rpcErr;
    console.warn("[register_close_shift] RPC unavailable; using column fallback:", safeErr(rpcErr));
    const { pgCloseShift } = await import("@/lib/persistence/postgres-store");
    return pgCloseShift(shiftId, registerSessionId, data, organizationId);
  }
}

export async function registerLoginAction(formData: FormData) {
  const locationId = String(formData.get("locationId") ?? "");
  const deviceId = String(formData.get("deviceId") ?? "") || undefined;
  const pin = String(formData.get("pin") ?? "");

  // R16-M-4: use a SHA-256 fingerprint of `${locationId}:${pin}` as the
  // bucket key, matching the `/api/auth/register-login` route. The old
  // `pin.slice(0,1)${pin.length}` key leaked the PIN's first character
  // and length via bucket-exhaustion timing — an attacker could probe
  // {"1000","2000",…,"9000"} to identify which PIN prefix+length
  // combinations have real employees.
  const pinFingerprint = crypto.subtle
    ? await (async () => {
        const enc = new TextEncoder().encode(`${locationId}:${pin}`);
        const hash = await crypto.subtle.digest("SHA-256", enc);
        return Array.from(new Uint8Array(hash)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
      })()
    : pin;
  const pinBucket = checkRateLimit(`register-pin:${pinFingerprint}`, { maxAttempts: 5, windowMs: 300_000 });
  if (!pinBucket.allowed) {
    const secs = Math.ceil(pinBucket.retryAfterMs / 1000);
    redirect(`/register?error=Too+many+attempts+for+this+PIN.+Try+again+in+${secs}+seconds`);
  }
  const locBucket = checkRateLimit(`register-loc:${locationId}`, { maxAttempts: 30, windowMs: 300_000 });
  if (!locBucket.allowed) {
    const secs = Math.ceil(locBucket.retryAfterMs / 1000);
    redirect(`/register?error=Too+many+login+attempts.+Try+again+in+${secs}+seconds`);
  }

  const loginResult = await signInRegister(
    pin,
    locationId,
    deviceId,
  );
  if (!loginResult) redirect("/register?error=PIN+login+failed");
  const { employee, location, registerSession } = loginResult;

  // Audit: log register login (non-fatal — shift open and redirect proceed regardless)
  if (isPg()) {
    rpcInsertAudit(
      employee.organizationId, location.id, employee.id,
      "session", registerSession.id, "register_login",
      { location_id: location.id, register_session_id: registerSession.id },
    ).catch((err) => console.error("[registerLoginAction] login audit failed:", safeErr(err)));

    // Auto-open shift on login — workers clock in by entering their PIN
    const shiftId = randomUUID();
    await rpcOpenShift({
      id: shiftId,
      organizationId: employee.organizationId,
      locationId: location.id,
      employeeId: employee.id,
      registerSessionId: registerSession.id,
      openingFloat: 0,
    });
    await rpcInsertAudit(
      employee.organizationId, location.id, employee.id,
      "shift", shiftId, "shift_opened",
      { register_session_id: registerSession.id, opening_float: "0.00" },
    );
  }

  invalidateStoreCache(employee.organizationId);
  revalidatePath("/register");
  redirect("/register?notice=Clocked+in");
}

export async function openShiftAction(formData: FormData) {
  const context = await requireRegisterPermission("register.open");
  const openingFloat = Number(formData.get("openingFloat") ?? 0);
  const openedNote = String(formData.get("openedNote") ?? "").trim();

  if (!Number.isFinite(openingFloat) || openingFloat < 0) {
    redirect("/register?error=Opening+float+must+be+0+or+greater");
  }

  if (isPg()) {
    if (context.registerSession.activeShiftId) {
      redirect("/register?error=Shift+already+open");
    }
    const shiftId = randomUUID();
    try {
      await rpcOpenShift({
        id: shiftId, organizationId: context.employee.organizationId, locationId: context.location.id,
        employeeId: context.employee.id,
        registerSessionId: context.registerSession.id,
        openingFloat, openedNote: openedNote || undefined,
      });
    } catch (err) {
      // Redirect throws (Next.js uses a special digest) — re-throw so routing still works.
      if (err && typeof err === "object" && "digest" in err) throw err;
      // R42-K: `msg` is used ONLY for string-classification (the
      // already-open-shift path). Never log the raw err.message — a pg
      // error can include DETAIL with bound param values. Route the
      // log through safeErr which scrubs PG DETAIL.
      const msg = err instanceof Error ? err.message : String(err);
      if (/already has an open shift/i.test(msg)) {
        redirect("/register?error=Employee+already+has+an+open+shift");
      }
      console.error("[openShiftAction] rpcOpenShift failed:", safeErr(err));
      redirect("/register?error=Failed+to+open+shift.+Please+try+again.");
    }
    await rpcInsertAudit(
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

  invalidateStoreCache(context.employee.organizationId);
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
  if (!Number.isFinite(openingFloat) || openingFloat < 0) {
    redirect("/admin/clock-in?error=Opening+float+must+be+0+or+greater");
  }

  // Verify employee and location belong to this admin's org (defense against
  // client-supplied UUIDs from another tenant). Use the per-call Pool facade
  // (getPool) — the module-scope `@/lib/db` pool binds its Neon WebSocket to
  // the first Worker request that opens it, so any subsequent concurrent
  // request throws "Cannot perform I/O on behalf of a different request"
  // (Cloudflare error 1102). This was a live regression from R8-H-8 that
  // missed the admin clock-in path.
  if (isPg()) {
    const { getPool } = await import("@/lib/supabase-rest");
    const pool = await getPool();
    const { rows: empRows } = await pool.query(
      `SELECT id FROM employees WHERE id = $1 AND organization_id = $2 AND is_active = true LIMIT 1`,
      [employeeId, ctx.employee.organizationId],
    );
    if (empRows.length === 0) {
      redirect("/admin/clock-in?error=Employee+not+found+in+your+organization");
    }
    const { rows: locRows } = await pool.query(
      `SELECT id FROM locations WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [locationId, ctx.employee.organizationId],
    );
    if (locRows.length === 0) {
      redirect("/admin/clock-in?error=Location+not+found+in+your+organization");
    }
  }

  // Check if employee already has an open shift at this location. Uses the
  // direct DB pool (getPool) — no Supabase REST fallback; relying on the
  // anon key to reach SECURITY DEFINER RPCs was the round 24 auth-bypass
  // vector.
  if (isPg()) {
    const { getPool } = await import("@/lib/supabase-rest");
    const pool = await getPool();
    // R26-F1: explicit org filter. employeeId + locationId come from
    // the form body; scope to ctx.employee.organizationId.
    const { rows: existing } = await pool.query(
      `SELECT id FROM shifts
       WHERE employee_id = $1 AND location_id = $2 AND status = 'open'
         AND organization_id = $3
       LIMIT 1`,
      [employeeId, locationId, ctx.employee.organizationId],
    );
    if (existing.length > 0) {
      redirect("/admin/clock-in?error=Employee+already+has+an+open+shift");
    }
    const shiftId = randomUUID();
    await rpcOpenShift({
      id: shiftId, organizationId: ctx.employee.organizationId, locationId, employeeId, registerSessionId: null,
      openingFloat, openedNote: openedNote || undefined,
    });
    await rpcInsertAudit(
      ctx.employee.organizationId, locationId, ctx.employee.id,
      "shift", shiftId, "shift_opened",
      { employee_id: employeeId, opening_float: openingFloat.toFixed(2) },
    );
  } else {
    redirect("/admin/clock-in?error=Admin+shift+opening+not+supported+in+JSON+mode");
  }

  // R91-M1: parity with the rest of this file + R84-R85 admin
  // cache-invalidation sweep. openShiftAdminAction writes to
  // `shifts` which IS loaded into readStore's 30s cache; without
  // this invalidation both /admin/clock-in and /admin/shifts
  // served stale data for up to 30s after the admin opened a
  // shift on behalf of an employee.
  invalidateStoreCache(ctx.employee.organizationId);
  revalidatePath("/admin/clock-in");
  revalidatePath("/admin/shifts");
  redirect("/admin/clock-in?notice=Shift+opened");
}

export async function closeShiftAction(formData: FormData) {
  const context = await requireRegisterPermission("register.open");
  // NOTE: closingExpectedCash from the form is IGNORED — we recompute it server-side
  // to prevent a dishonest cashier from fabricating expected cash to hide a shortage.
  const closingDeclaredCash = Number(formData.get("closingDeclaredCash") ?? 0);
  const closedNote = String(formData.get("closedNote") ?? "").trim();

  if (!Number.isFinite(closingDeclaredCash) || closingDeclaredCash < 0) {
    redirect("/register?error=Closing+cash+amounts+must+be+0+or+greater");
  }

  if (isPg()) {
    if (!context.registerSession.activeShiftId) {
      redirect("/register?error=No+active+shift+to+close");
    }
    const shiftId = context.registerSession.activeShiftId;

    // R32-X3 / R32-D1 sibling fix: recompute expected cash + commit
    // the close inside ONE orgTx with an advisory lock + FOR UPDATE
    // chain. Prior shape ran the reads on one client (COMMIT), then
    // rpcCloseShift on a separate tx — exactly the accounting race
    // R32-D1 closed on /api/shift-close POST. Register-side is the
    // primary path (cashiers close their own shift via the register
    // UI), so this hole was larger than the admin API version.
    //
    // Lock order mirrors /api/shift-close POST:
    //   1. pg_advisory_xact_lock(`shift-close:<id>`) — serialize
    //   2. FOR UPDATE shifts  (refuse if not 'open')
    //   3. FOR UPDATE register_sessions — blocks concurrent checkouts
    //   4. Read cash totals + commit close + end session atomically.
    const { orgTx } = await import("@/lib/supabase-rest");
    const client = await orgTx(context.employee.organizationId);
    let openingFloat = 0;
    let netCash = 0;
    let cashChange = 0;
    let netFlow = 0;
    let openedAt: string | Date = new Date(0).toISOString();
    let closingExpectedCash = 0;
    let closingVariance = 0;
    try {
      // R33-H7: re-read `active_shift_id` from register_sessions INSIDE
      // the advisory lock. Prior shape captured `activeShiftId` at
      // `requireRegisterPermission` (session resolve time) and used
      // it here without verification. If another path closed THIS
      // shift and opened a NEW one between session resolve and here
      // (rapid re-open race), the captured id pointed at the already-
      // closed shift and this handler harmlessly no-op'd the UPDATE
      // but then CLEARED active_shift_id on register_sessions —
      // orphaning the NEW shift's linkage. Re-read under lock and
      // fail if it changed.
      const { rows: regCheck } = await client.query(
        `SELECT active_shift_id FROM register_sessions
          WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [context.registerSession.id, context.employee.organizationId],
      );
      const currentActiveShiftId = regCheck[0]?.active_shift_id as string | null;
      if (currentActiveShiftId !== shiftId) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        redirect("/register?error=Shift+changed.+Please+refresh+and+try+again.");
      }
      await client.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [`shift-close:${shiftId}`],
      );
      // Shift MUST be open under the lock.
      const { rows: shiftLock } = await client.query(
        `SELECT status, opening_float, opened_at FROM shifts
          WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [shiftId, context.employee.organizationId],
      );
      if (shiftLock.length === 0 || shiftLock[0].status !== 'open') {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        redirect("/register?error=Shift+is+not+open");
      }
      openingFloat = Number(shiftLock[0].opening_float) || 0;
      openedAt = shiftLock[0].opened_at ?? new Date(0).toISOString();

      // Serialize against in-flight checkouts that hold FOR UPDATE
      // on the same register_sessions row. A concurrent checkout
      // either committed before this lock (its tender is included
      // below) or blocks here until we COMMIT, and then sees
      // status='ended' on its own FOR UPDATE retry.
      await client.query(
        `SELECT id FROM register_sessions WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [context.registerSession.id, context.employee.organizationId],
      );

      const { rows: cashRows } = await client.query(
        `SELECT
           COALESCE((SELECT SUM(tt.amount)
             FROM transaction_tenders tt
             JOIN transactions t ON t.id = tt.transaction_id
             WHERE t.register_session_id = $1 AND t.created_at >= $2 AND tt.tender_type = 'cash'
               AND t.status = 'completed'
               AND t.organization_id = $3
           ), 0)::numeric AS cash_sales,
           COALESCE((SELECT SUM(t.change_due)
             FROM transactions t
             WHERE t.register_session_id = $1 AND t.created_at >= $2
               AND t.status = 'completed'
               AND t.organization_id = $3
           ), 0)::numeric AS cash_change`,
        [context.registerSession.id, openedAt, context.employee.organizationId],
      );
      netCash = Number(cashRows[0]?.cash_sales) || 0;
      cashChange = Number(cashRows[0]?.cash_change) || 0;
      const { rows: pioRows } = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'pay_in' THEN amount ELSE -amount END), 0)::numeric AS net_flow
         FROM pay_in_outs WHERE shift_id = $1 AND organization_id = $2`,
        [shiftId, context.employee.organizationId],
      );
      netFlow = Number(pioRows[0]?.net_flow) || 0;

      closingExpectedCash = Number((openingFloat + netCash - cashChange + netFlow).toFixed(2));
      closingVariance = Number((closingDeclaredCash - closingExpectedCash).toFixed(2));
      const ts = new Date().toISOString();

      // Commit the close.
      await client.query(
        `UPDATE shifts SET status = 'closed', closed_at = $1,
           closing_expected_cash = $2, closing_declared_cash = $3,
           closing_variance = $4, closed_note = $5
         WHERE id = $6 AND organization_id = $7 AND status = 'open'`,
        [ts, closingExpectedCash, closingDeclaredCash, closingVariance, closedNote || null, shiftId, context.employee.organizationId],
      );
      // End the register session in-tx so concurrent checkouts
      // blocking on the FOR UPDATE above see 'ended' on their retry.
      await client.query(
        `UPDATE register_sessions
           SET status = 'ended', ended_at = $1, active_shift_id = NULL
         WHERE id = $2 AND organization_id = $3`,
        [ts, context.registerSession.id, context.employee.organizationId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      try { client.release(); } catch {}
    }

    // rpcCloseShift is kept around for the admin-only shift-close
    // path; this register-side server action now commits inline.
    void rpcCloseShift;
    const shift = {
      id: shiftId,
      closingVariance,
    };
    await rpcInsertAudit(
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
    // JSON fallback: in-memory store has no tenders/pay_in_outs to sum, so
    // approximate expected cash from opening_float only. Not used in production.
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
      const expected = shift.openingFloat ?? 0;
      shift.status = "closed";
      shift.closedAt = timestamp;
      shift.closingExpectedCash = expected;
      shift.closingDeclaredCash = closingDeclaredCash;
      shift.closingVariance = Number((closingDeclaredCash - expected).toFixed(2));
      shift.closedNote = closedNote || undefined;
      registerSession.activeShiftId = undefined;
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(), transactionId: "txn_register_shift_placeholder",
        eventKind: "shift_closed", actorEmployeeId: context.employee.id,
        notes: `Shift closed by ${context.employee.displayName}`,
        payload: {
          register_session_id: registerSession.id, shift_id: shift.id,
          expected_cash: expected.toFixed(2),
          declared_cash: closingDeclaredCash.toFixed(2),
          variance: shift.closingVariance.toFixed(2),
        },
        createdAt: timestamp,
      });
    });
  }

  invalidateStoreCache(context.employee.organizationId);
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
    rpcInsertAudit(
      employee.organizationId, location.id, employee.id,
      "session", sessionId, "register_logout",
      { register_session_id: registerSession.id },
    ).catch((err) => console.error("[registerLogoutAction] audit failed:", safeErr(err)));
  }

  invalidateStoreCache(employee.organizationId);
  revalidatePath("/register");
  redirect("/register?notice=Register+session+closed");
}

export async function quickSwitchAction(pin: string): Promise<{ success: boolean; error?: string; newEmployeeName?: string }> {
  const context = await requireRegisterPermission("register.open");
  if (!hasPermission(context.employee.roleKey, "register.pin_login")) {
    return { success: false, error: "Unauthorized" };
  }
  const locationId = context.location.id;

  const cleanPin = pin.trim();
  if (!cleanPin) return { success: false, error: "PIN is required" };

  // R16-M-4: SHA-256 fingerprint bucket key; see registerLoginAction above.
  const pinFingerprint = crypto.subtle
    ? await (async () => {
        const enc = new TextEncoder().encode(`${locationId}:${cleanPin}`);
        const hash = await crypto.subtle.digest("SHA-256", enc);
        return Array.from(new Uint8Array(hash)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
      })()
    : cleanPin;
  const pinBucket = checkRateLimit(`register-pin:${pinFingerprint}`, { maxAttempts: 5, windowMs: 300_000 });
  if (!pinBucket.allowed) {
    return { success: false, error: `Too many attempts for this PIN. Try again in ${Math.ceil(pinBucket.retryAfterMs / 1000)}s` };
  }
  const locBucket = checkRateLimit(`register-loc:${locationId}`, { maxAttempts: 30, windowMs: 300_000 });
  if (!locBucket.allowed) {
    return { success: false, error: `Too many attempts. Try again in ${Math.ceil(locBucket.retryAfterMs / 1000)}s` };
  }

  if (isPg()) {
    // Direct DB pool path — previously split between Supabase REST (service
    // role key) and local pool. Round 24 proved the service-role-key
    // fallback to anon exposed a full auth bypass, so we unify on direct
    // DB access via the per-call facade.
    const { getPool } = await import("@/lib/supabase-rest");
    const pool = await getPool();

    // Resolve PIN to employee using the register_pin_candidates RPC
    // executed through the pool (postgres role has EXECUTE grant).
    //
    // R14-M-1: previously used `Promise.all(candidates.map(...))` to verify
    // in parallel, which scales bcrypt CPU cost with O(N) per request and
    // creates a DoS vector (50 employees × 60ms = 3s CPU budget per PIN
    // attempt). Serialize with early exit: iterate candidates, await each
    // verify, break on first match. Worst case is the same total work
    // (every PIN fails), best case is a single bcrypt on a match.
    let credentialEmployeeId: string | null = null;
    try {
      const { verifySecret: verifyPinAsync } = await import("@/lib/auth/crypto");
      const { rows: candidates } = await pool.query(
        `SELECT * FROM register_pin_candidates($1::text)`,
        [locationId],
      );
      const typed = candidates as Array<{ employee_id: string; pin_hash: string }>;
      for (const c of typed) {
        if (!c.pin_hash) continue;
        if (await verifyPinAsync(cleanPin, c.pin_hash)) {
          credentialEmployeeId = c.employee_id;
          break;
        }
      }
    } catch {
      // RPC not provisioned — fall back to pgFindCredentialByPin.
      const { pgFindCredentialByPin } = await import("@/lib/persistence/postgres-store");
      const credential = await pgFindCredentialByPin(cleanPin, context.employee.organizationId);
      credentialEmployeeId = credential?.employeeId ?? null;
    }
    if (!credentialEmployeeId) return { success: false, error: "Invalid PIN" };

    const { readStore } = await import("@/lib/persistence/store");
    const store = await readStore(context.employee.organizationId);
    const newEmployee = store.employees.find((e) => e.id === credentialEmployeeId && e.isActive);
    if (!newEmployee || !newEmployee.locationIds.includes(locationId)) {
      return { success: false, error: "Employee not found or not assigned to this location" };
    }

    if (newEmployee.id === context.employee.id) {
      return { success: false, error: "Already signed in as this employee" };
    }

    // Switch employee via the SECURITY DEFINER RPC.
    //
    // R13-C-1: the RPC was previously called with `::uuid` casts, but the
    // function is declared with `(text, text, text, text)` params (migration
    // 040). Postgres resolves overloads by type, so `register_quick_switch(
    // uuid, uuid, uuid, uuid)` doesn't exist — every call silently threw
    // "function does not exist" and fell through to the inline UPDATE
    // fallback below. That broke the intent of routing the state change
    // through a hardened SECURITY DEFINER RPC. Casting to `::text` matches
    // the declared signature.
    //
    // The fallback is narrowed: only swallow the RPC path on the specific
    // "function does not exist" / "missing privilege" shapes, so any other
    // RPC failure surfaces as a real error instead of silently corrupting
    // session state via the raw UPDATEs.
    try {
      await pool.query(
        `SELECT register_quick_switch($1::text, $2::text, $3::text, $4::text)`,
        [
          context.session.id,
          context.registerSession.id,
          context.registerSession.activeShiftId ?? null,
          newEmployee.id,
        ],
      );
    } catch (rpcErr) {
      const msg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
      const recoverable =
        /function .* does not exist/i.test(msg) ||
        /permission denied for function/i.test(msg);
      if (!recoverable) throw rpcErr;
      // Use the per-call Pool facade's orgTx (supabase-rest), not @/lib/db's.
      // The latter uses a module-scope pool that binds its Neon WebSocket to
      // the first Worker request and fails on subsequent concurrent calls
      // (CF error 1102). Same reason as R9-C-1's fix above.
      // R45-M: log via safeErr. `msg` above is still used for the
      // `/function .* does not exist/` regex classification; we just
      // don't want it reaching the log sink with pg DETAIL fragments.
      console.warn("[register_quick_switch] RPC unavailable; using column fallback:", safeErr(rpcErr));
      const { orgTx } = await import("@/lib/supabase-rest");
      const client = await orgTx(context.employee.organizationId);
      try {
        // R42-M: defense-in-depth org filter on the sessions +
        // register_sessions UPDATEs. context.session.id is derived from
        // the authenticated HMAC-signed cookie, so in practice it's
        // already tenant-bound — but pool.query runs as the `postgres`
        // role (BYPASSRLS) so a future refactor that admits a less-
        // trusted id into context.session.id, or a pg_dump-and-reload
        // that aliases session ids across orgs, would cross-tenant
        // write without this filter. Every other session write in the
        // repo includes an explicit `organization_id` scope.
        await client.query(
          `UPDATE sessions SET employee_id = $1
            WHERE id = $2 AND organization_id = $3`,
          [newEmployee.id, context.session.id, context.employee.organizationId],
        );
        await client.query(
          `UPDATE register_sessions SET employee_id = $1, updated_at = $2
            WHERE id = $3 AND organization_id = $4`,
          [newEmployee.id, new Date().toISOString(), context.registerSession.id, context.employee.organizationId],
        );
        if (context.registerSession.activeShiftId) {
          // R26-F1: explicit org filter.
          await client.query(
            `UPDATE shifts SET employee_id = $1
             WHERE id = $2 AND organization_id = $3`,
            [newEmployee.id, context.registerSession.activeShiftId, context.employee.organizationId],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // Audit event
    await rpcInsertAudit(
      context.employee.organizationId, locationId, newEmployee.id,
      "register_session", context.registerSession.id, "pin_login",
      {
        previous_employee_id: context.employee.id,
        previous_employee_name: context.employee.displayName,
        quick_switch: "true",
      },
    );

    invalidateStoreCache(context.employee.organizationId);
    revalidatePath("/register");
    return { success: true, newEmployeeName: newEmployee.displayName };
  }

  // JSON fallback
  const { verifySecret } = await import("@/lib/auth/crypto");
  const { readStore } = await import("@/lib/persistence/store");
  const store = await readStore();
  let credential = null;
  for (const c of store.authCredentials) {
    if (c.pinHash && await verifySecret(cleanPin, c.pinHash)) {
      credential = c;
      break;
    }
  }
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

  invalidateStoreCache(context.employee.organizationId);
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
    const { pgCreateCustomer } = await import("@/lib/persistence/postgres-store");
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
