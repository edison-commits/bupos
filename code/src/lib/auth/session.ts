import "server-only";

import { randomUUID } from "node:crypto";
import { addDays } from "@/lib/utils/date";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifySecret } from "@/lib/auth/crypto";
import { hasPermission } from "@/lib/domain/permissions";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { mutateStore, readStore } from "@/lib/persistence/store";
import type { AdminSessionContext, RegisterSessionContext, SessionRecord } from "@/lib/persistence/types";
import type { RegisterSessionRecord, ShiftRecord, RoleKey } from "@/lib/domain/types";

const isPg = () => !!process.env.USE_POSTGRES;

const ADMIN_COOKIE = "basicuniformpos_admin_session";
const REGISTER_COOKIE = "basicuniformpos_register_session";

function buildSession(scope: SessionRecord["scope"], employeeId: string, organizationId: string, locationId?: string): SessionRecord {
  const now = new Date();
  return {
    id: randomUUID(),
    employeeId,
    organizationId,
    scope,
    locationId,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: addDays(now, scope === "admin" ? 7 : 1).toISOString(),
  };
}

async function cookieStore() {
  return cookies();
}

// ── PG session helpers ──────────────────────────────────────────────
async function pgGetPool() {
  const { default: pool } = await import("@/lib/db");
  return pool;
}

async function pgInsertSession(s: SessionRecord) {
  const pool = await pgGetPool();
  await pool.query(
    `INSERT INTO sessions (id, employee_id, organization_id, scope, location_id, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [s.id, s.employeeId, s.organizationId, s.scope, s.locationId ?? null, s.createdAt, s.lastSeenAt, s.expiresAt],
  );
}

async function pgUpdateSessionLastSeen(sessionId: string) {
  const pool = await pgGetPool();
  await pool.query(`UPDATE sessions SET last_seen_at = NOW() WHERE id = $1`, [sessionId]);
}

async function pgDeleteSessionsByEmployee(scope: string, employeeId: string) {
  const pool = await pgGetPool();
  await pool.query(`DELETE FROM sessions WHERE scope = $1 AND employee_id = $2`, [scope, employeeId]);
}

async function pgDeleteSession(sessionId: string) {
  const pool = await pgGetPool();
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

async function pgFindSession(sessionId: string, scope: string): Promise<SessionRecord | null> {
  const pool = await pgGetPool();
  const { rows } = await pool.query(
    `SELECT * FROM sessions WHERE id = $1 AND scope = $2 AND expires_at > NOW()`,
    [sessionId, scope],
  );
  if (!rows[0]) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id: r.id as string,
    employeeId: r.employee_id as string,
    organizationId: r.organization_id as string,
    scope: r.scope as SessionRecord["scope"],
    locationId: (r.location_id as string) ?? undefined,
    createdAt: String(r.created_at),
    lastSeenAt: String(r.last_seen_at),
    expiresAt: String(r.expires_at),
  };
}

// ── Resolve session (works for both JSON and PG) ────────────────────
async function resolveSession(scope: SessionRecord["scope"], cookieName: string, deviceId?: string) {
  const jar = await cookieStore();
  const sessionId = jar.get(cookieName)?.value;

  if (!sessionId) {
    return null;
  }

  // Find the session — PG mode reads sessions into store via readStoreFromPg
  let session: SessionRecord | null | undefined;
  if (isPg()) {
    session = await pgFindSession(sessionId, scope);
  } else {
    const store = await readStore();
    session = store.sessions.find((entry) => entry.id === sessionId && entry.scope === scope);
    if (session && new Date(session.expiresAt) < new Date()) session = null;
  }

  if (!session) {
    return null;
  }

  session.lastSeenAt = new Date().toISOString();
  if (isPg()) {
    await pgUpdateSessionLastSeen(session.id);
  }

  const store = await readStore(isPg() ? session.organizationId : undefined);

  const employee = store.employees.find((entry) => entry.id === session.employeeId && entry.isActive);
  if (!employee) {
    return null;
  }

  if (scope === "admin") {
    return { session, employee } satisfies AdminSessionContext;
  }

  const location = store.locations.find((entry) => entry.id === session.locationId && entry.isActive);
  if (!location) {
    return null;
  }

  let registerSession: RegisterSessionRecord | undefined;
  let activeShift: ShiftRecord | null = null;

  if (isPg()) {
    // Query register_sessions and shifts directly from PG
    const pgPool = await pgGetPool();

    // Abandoned session guard: if the auth session hasn't been seen in > 8 hours,
    // treat the register session as abandoned and close it automatically.
    const STALE_HOURS = 8;
    const { rows: rsRows } = await pgPool.query(
      `SELECT rs.* FROM register_sessions rs
       JOIN sessions s ON s.id = rs.auth_session_id
       WHERE rs.auth_session_id = $1 AND rs.status = 'active'
         AND (s.last_seen_at IS NULL OR s.last_seen_at > NOW() - INTERVAL '${STALE_HOURS} hours')
       LIMIT 1`,
      [session.id],
    );
    if (!rsRows[0]) return null;
    const rs = rsRows[0] as Record<string, unknown>;

    // Device ID verification: if a deviceId was provided and it doesn't match,
    // treat this session as invalid (closed) — another device took over.
    const sessionDeviceId = (rs.device_id as string) ?? undefined;
    if (deviceId && sessionDeviceId && sessionDeviceId !== deviceId) {
      // Close the stale session and return null
      await pgPool.query(
        `UPDATE register_sessions SET status = 'ended', ended_at = NOW()
         WHERE id = $1`,
        [rs.id],
      );
      return null;
    }

    registerSession = {
      id: rs.id as string,
      authSessionId: rs.auth_session_id as string,
      employeeId: rs.employee_id as string,
      locationId: rs.location_id as string,
      status: rs.status as "active" | "ended",
      startedAt: String(rs.started_at),
      endedAt: rs.ended_at ? String(rs.ended_at) : undefined,
      activeShiftId: (rs.active_shift_id as string) ?? undefined,
      lastCartId: (rs.last_cart_id as string) ?? undefined,
      lastTransactionId: (rs.last_transaction_id as string) ?? undefined,
      pendingExceptionIds: (rs.pending_exception_ids as string[]) ?? [],
      deviceId: sessionDeviceId,
    };

    if (registerSession.activeShiftId) {
      const { rows: shiftRows } = await pgPool.query(
        `SELECT * FROM shifts WHERE id = $1 AND status = 'open' LIMIT 1`,
        [registerSession.activeShiftId],
      );
      if (shiftRows[0]) {
        const s = shiftRows[0] as Record<string, unknown>;
        activeShift = {
          id: s.id as string,
          locationId: s.location_id as string,
          employeeId: s.employee_id as string,
          registerSessionId: s.register_session_id as string,
          status: s.status as "open" | "closed",
          openedAt: String(s.opened_at),
          openingFloat: Number(s.opening_float),
          openedNote: (s.opened_note as string) ?? undefined,
          closedAt: s.closed_at ? String(s.closed_at) : undefined,
          closingExpectedCash: s.closing_expected_cash != null ? Number(s.closing_expected_cash) : undefined,
          closingDeclaredCash: s.closing_declared_cash != null ? Number(s.closing_declared_cash) : undefined,
          closingVariance: s.closing_variance != null ? Number(s.closing_variance) : undefined,
          closedNote: (s.closed_note as string) ?? undefined,
          blindClose: (s.blind_close as boolean) ?? undefined,
        };
      }
    }
  } else {
    // Abandoned session guard for JSON (non-PG) mode
    const STALE_HOURS = 8;
    const staleCutoff = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString();
    registerSession = store.registerSessions.find(
      (entry) =>
        entry.authSessionId === session.id &&
        entry.status === "active" &&
        session.lastSeenAt >= staleCutoff,
    );
    if (!registerSession) {
      return null;
    }

    const shiftId = registerSession.activeShiftId;
    activeShift = shiftId
      ? store.shifts.find((entry) => entry.id === shiftId && entry.status === "open") ?? null
      : null;
  }

  return { session, employee, location, registerSession, activeShift } satisfies RegisterSessionContext;
}

export async function getAdminSession() {
  return resolveSession("admin", ADMIN_COOKIE) as Promise<AdminSessionContext | null>;
}

export async function getRegisterSession(deviceId?: string) {
  return resolveSession("register", REGISTER_COOKIE, deviceId) as Promise<RegisterSessionContext | null>;
}

export async function signInAdmin(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();

  if (isPg()) {
    // PG path: query auth_credentials + employees directly
    const { pgFindCredentialByEmail } = await import("@/lib/persistence/postgres-store");
    const { invalidateStoreCache } = await import("@/lib/persistence/postgres-read-store");
    const credential = await pgFindCredentialByEmail(normalizedEmail);
    if (!credential?.passwordHash) {
      throw new Error("Invalid admin credentials");
    }

    const pool = await pgGetPool();
    const { rows: empRows } = await pool.query(
      `SELECT id, organization_id, role_key, is_active FROM employees WHERE id = $1 LIMIT 1`,
      [credential.employeeId],
    );
    const emp = empRows[0] as Record<string, unknown> | undefined;
    if (!emp || emp.is_active !== true || !["owner", "manager"].includes(emp.role_key as string)) {
      throw new Error("Invalid admin credentials");
    }

    if (!verifySecret(password, credential.passwordHash)) {
      throw new Error("Invalid admin credentials");
    }

    const organizationId = emp.organization_id as string;
    const client = await pool.connect();
    let nextSession: SessionRecord | null = null;
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM sessions WHERE scope = $1 AND employee_id = $2`, ["admin", credential.employeeId]);
      nextSession = buildSession("admin", credential.employeeId, organizationId);
      await client.query(
        `INSERT INTO sessions (id, employee_id, organization_id, scope, location_id, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          nextSession.id,
          nextSession.employeeId,
          nextSession.organizationId,
          nextSession.scope,
          nextSession.locationId ?? null,
          nextSession.createdAt,
          nextSession.lastSeenAt,
          nextSession.expiresAt,
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (!nextSession) {
      throw new Error("Failed to create admin session");
    }
    invalidateStoreCache(); // ensure next readStore() call picks up fresh data including this session's employee

    const jar = await cookieStore();
    jar.set(ADMIN_COOKIE, nextSession.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(nextSession.expiresAt),
    });
    return;
  }

  // JSON path
  const session = await mutateStore(async (store) => {
    const credential = store.authCredentials.find((entry) => entry.email?.toLowerCase() === normalizedEmail);
    if (!credential?.passwordHash) {
      return null;
    }

    const employee = store.employees.find((entry) => entry.id === credential.employeeId && entry.isActive);
    if (!employee || !["owner", "manager"].includes(employee.roleKey)) {
      return null;
    }

    if (!verifySecret(password, credential.passwordHash)) {
      return null;
    }

    store.sessions = store.sessions.filter((entry) => !(entry.scope === "admin" && entry.employeeId === employee.id));
    const nextSession = buildSession("admin", employee.id, employee.organizationId);
    store.sessions.push(nextSession);
    return nextSession;
  });

  if (!session) {
    throw new Error("Invalid admin credentials");
  }

  const jar = await cookieStore();
  jar.set(ADMIN_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.expiresAt),
  });
}

export async function signInRegister(pin: string, locationId: string, deviceId?: string) {
  const cleanPin = pin.trim();

  // Rate-limit PIN attempts per location to prevent brute-force
  const rl = checkRateLimit(`register:${locationId}`);
  if (!rl.allowed) {
    const secs = Math.ceil(rl.retryAfterMs / 1000);
    redirect(`/register?error=Too+many+PIN+attempts.+Try+again+in+${secs}+seconds`);
  }

  if (isPg()) {
    const { pgFindCredentialByPin } = await import("@/lib/persistence/postgres-store");
    const pool = await pgGetPool();

    // Run credential lookup + location check in parallel (avoid full readStore)
    const [credential, locResult] = await Promise.all([
      pgFindCredentialByPin(cleanPin),
      pool.query(
        `SELECT id, is_active FROM locations WHERE id = $1 AND is_active = true LIMIT 1`,
        [locationId],
      ),
    ]);

    if (!credential) {
      redirect("/register?error=PIN+login+failed");
    }
    if (!locResult.rows[0]) {
      redirect("/register?error=PIN+login+failed");
    }

    // Lightweight employee lookup instead of full readStore
    const { rows: empRows } = await pool.query(
      `SELECT id, organization_id, role_key, location_ids, is_active FROM employees WHERE id = $1 AND is_active = true LIMIT 1`,
      [credential.employeeId],
    );
    const emp = empRows[0] as Record<string, unknown> | undefined;
    if (!emp) {
      redirect("/register?error=PIN+login+failed");
    }

    const roleKey = emp.role_key as RoleKey;
    const locationIds = (emp.location_ids as string[]) ?? [];
    if (!locationIds.includes(locationId)) {
      redirect("/register?error=PIN+login+failed");
    }

    if (!hasPermission(roleKey, "register.pin_login") || !hasPermission(roleKey, "register.open")) {
      redirect("/register?error=PIN+login+failed");
    }

    // Fetch full location for org context
    const { rows: locRows } = await pool.query(
      `SELECT id, organization_id FROM locations WHERE id = $1 AND is_active = true LIMIT 1`,
      [locationId],
    );
    if (!locRows[0]) {
      redirect("/register?error=PIN+login+failed");
    }
    const loc = locRows[0] as Record<string, unknown>;

    const timestamp = new Date().toISOString();
    const employeeId = credential.employeeId;
    const organizationId = emp.organization_id as string;

    const nextSession = buildSession("register", employeeId, organizationId, locationId);
    const registerSessionId = randomUUID();

    // Close stale sessions for the same employee (existing behavior)
    await Promise.all([
      pgDeleteSessionsByEmployee("register", employeeId),
      pool.query(
        `UPDATE register_sessions SET status = 'ended', ended_at = $1
         WHERE employee_id = $2 AND location_id = $3 AND status = 'active'`,
        [timestamp, employeeId, locationId],
      ),
    ]);

    // Close stale sessions for the same device (distributed register locking)
    if (deviceId) {
      await pool.query(
        `UPDATE register_sessions SET status = 'ended', ended_at = $1
         WHERE organization_id = $2 AND device_id = $3 AND status = 'active'`,
        [timestamp, organizationId, deviceId],
      );
    }

    await Promise.all([
      pgInsertSession(nextSession),
      pool.query(
        `INSERT INTO register_sessions (id, auth_session_id, employee_id, location_id, organization_id, device_id, status, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
        [registerSessionId, nextSession.id, employeeId, locationId, organizationId, deviceId ?? null, timestamp],
      ),
    ]);

    const jar = await cookieStore();
    jar.set(REGISTER_COOKIE, nextSession.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(nextSession.expiresAt),
    });

    return {
      employee: { id: employeeId, organizationId, roleKey },
      location: { id: locationId, organizationId },
      registerSession: { id: registerSessionId, deviceId },
      authSessionId: nextSession.id,
      authSessionExpiresAt: nextSession.expiresAt,
      deviceId,
    };
  }

  // JSON path
  const session = await mutateStore(async (store) => {
    const credential = store.authCredentials.find((entry) => entry.pinHash && verifySecret(cleanPin, entry.pinHash));
    if (!credential) {
      return null;
    }

    const employee = store.employees.find((entry) => entry.id === credential.employeeId && entry.isActive);
    const location = store.locations.find((entry) => entry.id === locationId && entry.isActive);
    if (!employee || !location || !employee.locationIds.includes(locationId)) {
      return null;
    }

    if (!hasPermission(employee.roleKey, "register.pin_login") || !hasPermission(employee.roleKey, "register.open")) {
      return null;
    }

    const timestamp = new Date().toISOString();
    store.sessions = store.sessions.filter((entry) => !(entry.scope === "register" && entry.employeeId === employee.id));
    store.registerSessions = store.registerSessions.filter(
      (entry) => !(entry.employeeId === employee.id && entry.locationId === locationId && entry.status === "active"),
    );
    // Close stale sessions for the same device (distributed register locking)
    if (deviceId) {
      store.registerSessions = store.registerSessions.filter(
        (entry) => !(entry.deviceId === deviceId && entry.status === "active"),
      );
    }

    const nextSession = buildSession("register", employee.id, employee.organizationId, locationId);
    const registerSessionId = randomUUID();

    store.sessions.push(nextSession);
    store.registerSessions.push({
      id: registerSessionId,
      authSessionId: nextSession.id,
      employeeId: employee.id,
      locationId,
      status: "active",
      startedAt: timestamp,
      pendingExceptionIds: [],
      deviceId,
    });
    store.transactionEventPlaceholders.unshift({
      id: randomUUID(),
      transactionId: "txn_register_session_placeholder",
      eventKind: "register_session_started",
      actorEmployeeId: employee.id,
      notes: `Register session started for ${employee.displayName}`,
      payload: { location_id: locationId, register_session_id: registerSessionId },
      createdAt: timestamp,
    });
    store.transactionEventPlaceholders.unshift({
      id: randomUUID(),
      transactionId: "txn_register_session_placeholder",
      eventKind: "pin_login",
      actorEmployeeId: employee.id,
      notes: `Register login for ${employee.displayName}`,
      payload: { location_id: locationId, source: "local-session", register_session_id: registerSessionId },
      createdAt: timestamp,
    });
    return {
      employee: { id: employee.id, organizationId: employee.organizationId },
      location: { id: location.id, organizationId: location.organizationId },
      registerSession: { id: registerSessionId, deviceId },
      authSessionId: nextSession.id,
      authSessionExpiresAt: nextSession.expiresAt,
      deviceId,
    };
  });

  if (!session) {
    redirect("/register?error=PIN+login+failed");
  }

  const jar = await cookieStore();
  jar.set(REGISTER_COOKIE, session.authSessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.authSessionExpiresAt),
  });
}

export async function signOutAdmin() {
  const jar = await cookieStore();
  const sessionId = jar.get(ADMIN_COOKIE)?.value;

  if (sessionId) {
    if (isPg()) {
      await pgDeleteSession(sessionId);
    } else {
      await mutateStore((store) => {
        store.sessions = store.sessions.filter((entry) => entry.id !== sessionId);
      });
    }
  }

  jar.delete(ADMIN_COOKIE);
}

export async function signOutRegister() {
  const jar = await cookieStore();
  const sessionId = jar.get(REGISTER_COOKIE)?.value;

  if (sessionId) {
    if (isPg()) {
      const pool = await pgGetPool();
      const timestamp = new Date().toISOString();

      // Close active register session + auto-close shift
      const { rows: endedRows } = await pool.query(
        `UPDATE register_sessions SET status = 'ended', ended_at = $1
         WHERE auth_session_id = $2 AND status = 'active'
         RETURNING id, employee_id, active_shift_id`,
        [timestamp, sessionId],
      );

      const registerSession = endedRows[0] as
        | { id: string; employee_id: string; active_shift_id: string | null }
        | undefined;

      if (registerSession?.active_shift_id) {
        await pool.query(
          `UPDATE shifts
           SET status = 'closed',
               closed_at = $1,
               closing_expected_cash = opening_float,
               closing_declared_cash = opening_float,
               closing_variance = 0,
               closed_note = $2
           WHERE id = $3 AND status = 'open'`,
          [
            timestamp,
            "Auto-closed because register session ended without manual shift close.",
            registerSession.active_shift_id,
          ],
        );
        await pool.query(
          `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload, created_at)
           VALUES ($1, $2, $3, 'shift_closed', 'Shift auto-closed during register logout', $4, $5)`,
          [
            randomUUID(),
            `txn_${registerSession.active_shift_id}`,
            registerSession.employee_id,
            JSON.stringify({ register_session_id: registerSession.id, auto_closed: "true" }),
            timestamp,
          ],
        );
        await pool.query(`UPDATE register_sessions SET active_shift_id = NULL WHERE id = $1`, [registerSession.id]);
      }

      await pgDeleteSession(sessionId);
    } else {
      await mutateStore((store) => {
        const timestamp = new Date().toISOString();
        const authSession = store.sessions.find((entry) => entry.id === sessionId && entry.scope === "register");
        const registerSession = store.registerSessions.find(
          (entry) => entry.authSessionId === sessionId && entry.status === "active",
        );

        if (registerSession) {
          if (registerSession.activeShiftId) {
            const shift = store.shifts.find((entry) => entry.id === registerSession.activeShiftId && entry.status === "open");
            if (shift) {
              shift.status = "closed";
              shift.closedAt = timestamp;
              shift.closingExpectedCash = shift.openingFloat;
              shift.closingDeclaredCash = shift.openingFloat;
              shift.closingVariance = 0;
              shift.closedNote = "Auto-closed because register session ended without manual shift close.";
            }

            store.transactionEventPlaceholders.unshift({
              id: randomUUID(),
              transactionId: "txn_register_shift_placeholder",
              eventKind: "shift_closed",
              actorEmployeeId: registerSession.employeeId,
              notes: "Shift auto-closed during register logout",
              payload: { register_session_id: registerSession.id, auto_closed: "true" },
              createdAt: timestamp,
            });
          }

          registerSession.status = "ended";
          registerSession.endedAt = timestamp;
          registerSession.activeShiftId = undefined;
          store.transactionEventPlaceholders.unshift({
            id: randomUUID(),
            transactionId: "txn_register_session_placeholder",
            eventKind: "register_session_ended",
            actorEmployeeId: registerSession.employeeId,
            notes: "Register session ended",
            payload: { register_session_id: registerSession.id },
            createdAt: timestamp,
          });
        }

        if (authSession) {
          store.sessions = store.sessions.filter((entry) => entry.id !== sessionId);
        }
      });
    }
  }

  jar.delete(REGISTER_COOKIE);
}
