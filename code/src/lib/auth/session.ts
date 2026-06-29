import "server-only";

import { randomUUID } from "@/lib/uuid";
import { addDays } from "@/lib/utils/date";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifySecret } from "@/lib/auth/crypto";
import { hasPermission } from "@/lib/domain/permissions";
// AUTH-AUDIT6-HIGH1: register PIN-login rate-limiting moved to the shared
// `enforceRegisterPinRateLimits` gate; signInRegister no longer rate-limits
// inline, so `checkRateLimit` is no longer imported here.
import type { AdminSessionContext, LocalStoreData, RegisterSessionContext, SessionRecord } from "@/lib/persistence/types";
import type { RegisterSessionRecord, ShiftRecord, RoleKey, Employee, Location } from "@/lib/domain/types";
// R35-P3: hoist the hot-path auth modules to static. Each was previously
// dynamic-imported inside resolveSession / login / register-login — all
// functions on the auth-gated path that runs on every request. Static
// imports let the Worker bundler inline them and remove per-call
// resolver cost (~5-20ms per request). The source modules are lazy
// internally (pool creation is deferred inside supabase-rest), so
// hoisting is safe for Workers cold-start.
import { getPool } from "@/lib/supabase-rest";
import { verifyDeviceIdCookie, signDeviceId } from "@/lib/auth/device-cookie";
import { pgFindCredentialByEmail, pgFindCredentialByPin } from "@/lib/persistence/postgres-store";
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";
import { safeErr } from "@/lib/logging/safe-err";

const isPg = () => !!process.env.USE_POSTGRES;

async function loadJsonStore() {
  return import(/* turbopackIgnore: true */ "@/lib/persistence/json-store");
}

async function readStore(_orgId?: string): Promise<LocalStoreData> {
  const { readJsonStore } = await loadJsonStore();
  return readJsonStore();
}

async function mutateStore<T>(updater: (store: LocalStoreData) => Promise<T> | T): Promise<T> {
  const { readJsonStore, writeJsonStore } = await loadJsonStore();
  const store = await readJsonStore();
  const result = await updater(store);
  await writeJsonStore(store);
  return result;
}

// R41-2: cookie rename for opacity (R38-C-H6: prior names
// `basicuniformpos_admin_session` vs `basicuniformpos_register_session`
// telegraphed privilege level to proxy logs / browser DevTools
// screenshots in support tickets). New names are opaque short
// identifiers; the session scope is authoritative in the DB row, not
// the cookie label.
//
// Dual-read migration window:
//   - `getCookieValue` below checks the NEW name first, then the OLD
//     name, so live sessions don't get logged out on rollout.
//   - Every fresh session write sets the NEW cookie AND explicitly
//     deletes the OLD one. After ~7 days of traffic every active
//     session will have rotated to the new name; the next major
//     round can drop the OLD_* aliases and the dual-read branch.
const ADMIN_COOKIE = "bupos_a";
const REGISTER_COOKIE = "bupos_r";
const OLD_ADMIN_COOKIE = "basicuniformpos_admin_session";
const OLD_REGISTER_COOKIE = "basicuniformpos_register_session";

/**
 * R41-2: read a session cookie tolerating either the new short name
 * or the legacy long name. Prefers the new name (so a client with
 * BOTH — right after a rollover — uses the authoritative fresh one).
 */
function getCookieValue(
  jar: { get: (n: string) => { value: string } | undefined },
  newName: string,
  oldName: string,
): string | undefined {
  return jar.get(newName)?.value ?? jar.get(oldName)?.value;
}

/**
 * R41-2: clear the LEGACY session cookie alongside a fresh write to
 * the new name, so a rotated session doesn't leave both cookies
 * pinned on the client. Also used on explicit logout. Safe when the
 * legacy cookie isn't present (jar.delete is idempotent).
 */
function deleteLegacyCookie(
  jar: { delete: (n: string) => void },
  newName: string,
): void {
  if (newName === ADMIN_COOKIE) jar.delete(OLD_ADMIN_COOKIE);
  if (newName === REGISTER_COOKIE) jar.delete(OLD_REGISTER_COOKIE);
}

/**
 * R24-M-3: single source of truth for the cookie `secure` flag.
 *
 * Four sites in this file historically hardcoded `secure: true`
 * ("Cloudflare Workers always serve HTTPS"), two used
 * `process.env.NODE_ENV === "production"`. That drift meant local
 * dev via `next dev` + HTTP + a server-action login path dropped
 * cookies on Chromium (breaks Playwright + breaks manual dev flows).
 *
 * New rule:
 *   - In production (Workers / prod Next): `true`.
 *   - On Cloudflare Workers runtime (regardless of NODE_ENV): `true`.
 *   - In non-prod AND request URL is HTTPS: `true`.
 *   - Else (local HTTP dev + tests): `false`.
 *
 * AUTH-LOW1: the Workers-runtime branch was missing. If a Worker
 * deploy lands without NODE_ENV=production set (env-var rotation,
 * preview deploy, misconfig), the prior shape would set non-Secure
 * cookies on a HTTPS-only Workers domain. Mirrors the fail-closed
 * pattern in device-cookie.ts:58-66 and display-token.ts:53-67.
 *
 * If `req` isn't available at the cookie-set site, we still get the
 * Workers fail-closed branch above; otherwise we default to non-prod-
 * non-Workers HTTP-allowed dev mode.
 */
// AUTH-LOW2: exported so peer routes (e.g. /api/auth/verify) can
// call this same helper instead of forking inline `secureFlag` logic.
// Prior shape had verify/route.ts:204-209 reimplementing the rule —
// drift bait for any future tightening.
export function shouldUseSecureCookie(req?: { url?: string }): boolean {
  if (process.env.NODE_ENV === "production") return true;
  // AUTH-LOW1: Cloudflare Workers always serves HTTPS — force secure
  // even if NODE_ENV is undefined (e.g. mid-deploy, preview build).
  const isWorkers = typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === 'function';
  if (isWorkers) return true;
  if (req?.url && req.url.startsWith("https://")) return true;
  return false;
}

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
// IMPORTANT: all session-sensitive DB access goes through getPool() (the
// per-call facade from supabase-rest.ts) rather than the Supabase REST
// endpoint. Reasons:
//   1. REST requires a service-role JWT; falling back to the anon key is how
//      round 24's auth-bypass bug was reachable. Direct DB access uses the
//      `postgres` role, which has an explicit EXECUTE grant on these
//      SECURITY DEFINER RPCs and never depends on anon reachability.
//   2. The facade creates a one-shot pool per call on Workers, dodging the
//      "Cannot perform I/O on behalf of a different request" error that
//      killed the shared pool approach.
async function pgGetPool() {
  // R35-P3: getPool is now a static import at the top of this module.
  // Kept this wrapper for call-site brevity and so future hot-path
  // perf work can swap implementations without touching every caller.
  return getPool();
}

async function pgDeleteSession(sessionId: string) {
  // Non-critical — best effort
  try {
    const pool = await pgGetPool();
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  } catch {}
}

// pgFindSession + pgUpdateSessionLastSeen used to live here as separate helpers
// that each opened their own one-shot Pool. Both are now inlined in
// resolveSession on a shared client so the auth-gated hot path pays ONE
// WebSocket handshake instead of three.

// ── Resolve session (works for both JSON and PG) ────────────────────
async function resolveSession(scope: SessionRecord["scope"], cookieName: string, deviceId?: string) {
  const jar = await cookieStore();
  // R41-2: accept either the new short cookie name or the legacy
  // `basicuniformpos_*` name during the rollover window.
  const oldName = cookieName === ADMIN_COOKIE
    ? OLD_ADMIN_COOKIE
    : cookieName === REGISTER_COOKIE
      ? OLD_REGISTER_COOKIE
      : cookieName;
  const sessionId = getCookieValue(jar, cookieName, oldName);

  if (!sessionId) {
    return null;
  }

  // PERF: In PG mode, open ONE Neon client for the whole resolve so that
  // find_session + update last_seen_at + (for register) resolve_register_session
  // share a single TLS+WebSocket handshake. Previously each helper grabbed
  // its own one-shot Pool via getPool(), paying ~3–4 handshakes per auth-gated
  // request (~200-800ms of avoidable latency).
  // The facade returns a pg.PoolClient-shaped object. We don't import the
  // Neon types here (would pull @neondatabase into the SSR module graph), so
  // use a structural type that matches what we actually use.
  type SharedClient = {
    query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
    release: (err?: Error | boolean) => void;
  };
  let pgClient: SharedClient | null = null;
  try {
    // Find the session — PG mode reads sessions into store via readStoreFromPg
    let session: SessionRecord | null | undefined;
    if (isPg()) {
      const pool = await pgGetPool();
      pgClient = (await pool.connect()) as unknown as SharedClient;
      const { rows } = await pgClient.query(
        `SELECT * FROM find_session($1::uuid, $2::text) AS result`,
        [sessionId, scope],
      );
      const first = rows[0] as Record<string, unknown> | undefined;
      const r = ((first?.result as Record<string, unknown> | undefined) ?? first ?? null) as Record<string, unknown> | null;
      session = r && r.id ? {
        id: r.id as string,
        employeeId: r.employee_id as string,
        organizationId: r.organization_id as string,
        scope: r.scope as SessionRecord["scope"],
        locationId: (r.location_id as string) ?? undefined,
        createdAt: String(r.created_at),
        lastSeenAt: String(r.last_seen_at),
        expiresAt: String(r.expires_at),
      } : null;
    } else {
      const store = await readStore();
      session = store.sessions.find((entry) => entry.id === sessionId && entry.scope === scope);
      if (session && new Date(session.expiresAt) < new Date()) session = null;
    }

    if (!session) {
      return null;
    }

    // Admin sessions: enforce 4-hour inactivity timeout (in addition to 7-day expiry)
    const ADMIN_INACTIVITY_TIMEOUT_MS = 4 * 60 * 60 * 1000;
    if (scope === "admin" && session.lastSeenAt) {
      const lastSeen = new Date(session.lastSeenAt).getTime();
      if (Date.now() - lastSeen > ADMIN_INACTIVITY_TIMEOUT_MS) {
        return null;
      }
    }

    // R27-M2: absolute session lifetime. Before this check, an admin
    // cookie stolen via XSS / physical access / shared workstation
    // could be kept alive indefinitely inside the 7-day `expires_at`
    // window by pinging any admin route every <4h — idle timeout kept
    // sliding with `lastSeenAt`. An absolute cap on createdAt closes
    // that: once a session is 24h old it's gone, period, regardless
    // of activity. The user must log in again. Aligns with industry
    // practice (AWS console, Stripe dashboard both cap admin sessions
    // at 8–24h absolute). Register-scope sessions already have a 1-day
    // expires_at and don't need a separate absolute check.
    const ADMIN_ABSOLUTE_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24h
    if (scope === "admin" && session.createdAt) {
      const createdAtMs = new Date(session.createdAt).getTime();
      if (Date.now() - createdAtMs > ADMIN_ABSOLUTE_LIFETIME_MS) {
        return null;
      }
    }

    // R30-M3: DELAY the last_seen_at update for REGISTER scope until
    // after the device-ID verification below. Prior shape bumped
    // last_seen_at on every call — including calls from a stolen
    // cookie that then failed device-match — keeping the sessions
    // row alive indefinitely (the 8h stale guard in resolve_register_
    // session never tripped). For admin scope there's no device
    // binding, so the bump happens inline here.
    session.lastSeenAt = new Date().toISOString();
    if (scope === "admin" && isPg() && pgClient) {
      // Reuse the same client for the last_seen_at bump.
      try {
        await pgClient.query(`UPDATE sessions SET last_seen_at = NOW() WHERE id = $1`, [session.id]);
      } catch {}
    }

    // PERF: we used to read the FULL org store here (get_full_store RPC
    // returns products/variants/inventory/customers/...) just to find ONE
    // employee by id. On large datasets the JSON parse + object construction
    // ate enough Worker CPU to trip error 1102 on /api/dashboard and
    // /api/reports after only ~50 transactions. Fast path: targeted SELECT
    // on the single employee row (and, for register scope, the single
    // location row) using the shared pgClient we already have open.
    let employee: Employee | undefined;
    let location: Location | undefined;
    if (isPg() && pgClient) {
      // check-pool-org-filter: scoped-by-session-cookie-employee-id
      // session.employeeId came from the cookie-validated sessions row.
      // The org is RESOLVED from the employee row, not input — no
      // tenant-enumeration surface.
      // R44-LOW: added `AND organization_id = $2` as defense-in-depth.
      // session.organizationId is already known from the sessions row;
      // if a future refactor admits a crafted employeeId pointing to
      // a different tenant's employee (e.g., pg_dump-and-reload
      // aliasing UUIDs), this filter prevents the request from
      // executing as that tenant.
      const { rows: empRows } = await pgClient.query(
        `SELECT id, organization_id, role_key, first_name, last_name, display_name, email,
                pin_hint, is_active, location_ids, created_at, updated_at
         FROM employees WHERE id = $1 AND organization_id = $2 AND is_active = true LIMIT 1`,
        [session.employeeId, session.organizationId],
      );
      const e = empRows[0] as Record<string, unknown> | undefined;
      if (!e) return null;
      employee = {
        id: e.id as string,
        organizationId: e.organization_id as string,
        roleKey: e.role_key as Employee["roleKey"],
        firstName: e.first_name as string,
        lastName: e.last_name as string,
        displayName: e.display_name as string,
        email: (e.email as string) ?? '',
        pinHint: (e.pin_hint as string) ?? '',
        isActive: e.is_active as boolean,
        locationIds: (e.location_ids as string[]) ?? [],
        createdAt: String(e.created_at),
        updatedAt: String(e.updated_at),
      };

      if (scope === "register" && session.locationId) {
        // check-pool-org-filter: scoped-by-session-cookie-location-id
        // session.locationId came from the register session row.
        // R44-LOW: `AND organization_id = $2` defense-in-depth.
        const { rows: locRows } = await pgClient.query(
          `SELECT id, organization_id, name, code, address1, city, region, postal_code, phone,
                  tax_rate, is_active, created_at, updated_at
           FROM locations WHERE id = $1 AND organization_id = $2 AND is_active = true LIMIT 1`,
          [session.locationId, session.organizationId],
        );
        const l = locRows[0] as Record<string, unknown> | undefined;
        if (!l) return null;
        location = {
          id: l.id as string,
          organizationId: l.organization_id as string,
          name: l.name as string,
          code: l.code as string,
          address1: (l.address1 as string) ?? '',
          city: (l.city as string) ?? '',
          region: (l.region as string) ?? '',
          postalCode: (l.postal_code as string) ?? '',
          phone: (l.phone as string) ?? '',
          taxRate: Number(l.tax_rate ?? 0.1025),
          isActive: l.is_active as boolean,
          createdAt: String(l.created_at),
          updatedAt: String(l.updated_at),
        };
      }
    } else {
      // JSON fallback — no PG: use the in-memory store (dev only).
      const store = await readStore();
      employee = store.employees.find((entry) => entry.id === session.employeeId && entry.isActive);
      if (!employee) return null;
      location = scope === "register"
        ? store.locations.find((entry) => entry.id === session.locationId && entry.isActive)
        : undefined;
      if (scope === "register" && !location) return null;
    }

    if (scope === "admin") {
      return { session, employee } satisfies AdminSessionContext;
    }

    if (!location) {
      return null;
    }

    let registerSession: RegisterSessionRecord | undefined;
    let activeShift: ShiftRecord | null = null;

    if (isPg() && pgClient) {
      // Reuse the same client for the register-session resolve.
      const { rows: rpcRows } = await pgClient.query(
        `SELECT * FROM resolve_register_session($1::uuid) AS result`,
        [session.id],
      );
      const first = rpcRows[0] as Record<string, unknown> | undefined;
      const rpcData = (first?.result ?? first ?? null) as Record<string, unknown> | null;
      if (!rpcData || !rpcData.register_session) return null;

      const rs = rpcData.register_session as Record<string, unknown>;

      // R28-H5: device ID verification — fail-closed.
      //
      // Prior check was `if (deviceId && sessionDeviceId && ...)` which
      // SKIPPED verification when the caller didn't pass `deviceId`.
      // Since virtually every server-action caller today invokes
      // getRegisterSession() without an argument, the device_id column
      // was cosmetic — a stolen register cookie replayed from any
      // browser passed authentication.
      //
      // New shape:
      //   • session.device_id IS NULL → no enforcement (legacy rows
      //     created before device binding; behaviour unchanged).
      //   • session.device_id IS NOT NULL AND request deviceId missing
      //     OR mismatched → REFUSE + end the session row so a stolen
      //     cookie goes cold after one attempt.
      //
      // The `bupos_register_device` cookie is the companion to
      // REGISTER_COOKIE; both were Set-Cookie'd atomically at register-
      // login time. A cookie-theft attacker who steals only the
      // REGISTER_COOKIE will fail this check.
      const sessionDeviceId = (rs.device_id as string) ?? undefined;
      if (sessionDeviceId) {
        if (!deviceId || sessionDeviceId !== deviceId) {
          // R30-H7: ALSO delete the backing `sessions` row (the cookie's
          // server-side record). Prior shape only ended the register_
          // sessions row, leaving the auth-cookie-holder able to keep
          // the `sessions` entry alive indefinitely via polling (every
          // resolveSession bumps last_seen_at before this check). A
          // future dual-auth endpoint that reads `sessions` without
          // re-running `resolve_register_session` would then accept
          // the stolen cookie as live. Delete the sessions row AND end
          // the register_sessions row so both paths go cold.
          await pgClient.query(
            `UPDATE register_sessions SET status = 'ended', ended_at = NOW() WHERE id = $1`,
            [rs.id as string],
          );
          if (rs.auth_session_id) {
            await pgClient.query(
              `DELETE FROM sessions WHERE id = $1`,
              [rs.auth_session_id as string],
            );
          }
          return null;
        }
      }

      // R30-M3: device match passed — NOW it's safe to bump
      // last_seen_at on the backing sessions row. Stolen-cookie-only
      // attackers who never present the device cookie cannot keep
      // the sessions row alive via polling because the bump never
      // runs on their failed requests.
      if (isPg() && pgClient) {
        try {
          await pgClient.query(`UPDATE sessions SET last_seen_at = NOW() WHERE id = $1`, [session.id]);
        } catch {}
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

      if (rpcData.shift) {
        const s = rpcData.shift as Record<string, unknown>;
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
    } else {
      // Abandoned session guard for JSON (non-PG) mode. Load the in-memory
      // store only on this dev-only branch.
      const STALE_HOURS = 8;
      const staleCutoff = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString();
      const fallbackStore = await readStore();
      registerSession = fallbackStore.registerSessions.find(
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
        ? fallbackStore.shifts.find((entry) => entry.id === shiftId && entry.status === "open") ?? null
        : null;
    }

    return { session, employee, location, registerSession, activeShift } satisfies RegisterSessionContext;
  } finally {
    // Always release the shared client (if we opened one). The facade's
    // release() also ends the underlying Pool, so no WS connection leaks.
    if (pgClient) {
      try { pgClient.release(); } catch {}
    }
  }
}

// R25-perf-4: request-scoped memoization via React's `cache()`.
// A single rendered admin page composes layout.tsx + page.tsx + any
// nested server components, each of which may call getAdminSession /
// requireAdminPermission. Without memo, each call pays a ~150-300ms
// resolveSession() round-trip (pool + 3 DB queries). With Next 16's
// request-scoped cache(), the SAME request re-uses the resolved value.
//
// Safety note: the prior attempt at this caused "Cannot perform I/O
// on behalf of a different request" on Workers. That was a Next 15
// bug class where cache() occasionally crossed request boundaries.
// Next 16 App Router scopes cache() strictly per-request across
// server components, route handlers, and server actions — so the
// captured Promise never migrates between requests. If a future
// runtime change reintroduces the regression, the call sites fall
// back by importing `resolveSession` directly.
import { cache } from "react";

export const getAdminSession = cache(
  async () => resolveSession("admin", ADMIN_COOKIE) as Promise<AdminSessionContext | null>,
);

// Register session lookup varies by deviceId so we can't use a
// naïve cache() — the param would cause divergent keys. Leave as
// a plain function.
//
// R28-H5: when no explicit deviceId is passed (server-action callers
// that don't thread it through), pull it from the HttpOnly
// `bupos_register_device` cookie set at register-login. The cookie
// is signed-by-possession (HttpOnly, Secure on HTTPS, SameSite=Lax)
// just like REGISTER_COOKIE itself; treating the two cookies as a
// matched pair pins the session to the browser that originally paired.
// `resolveSession`'s device-match check (fail-closed post-R28-H5)
// refuses to resolve when the session row has a device_id but the
// request cookie is missing or mismatched.
export async function getRegisterSession(deviceId?: string) {
  let effectiveDeviceId = deviceId;
  if (!effectiveDeviceId) {
    try {
      const { cookies } = await import("next/headers");
      const jar = await cookies();
      const raw = jar.get("bupos_register_device")?.value;
      if (raw) {
        // R29-M3: the cookie is now HMAC-signed. `verifyDeviceIdCookie`
        // returns the deviceId only if the signature is intact; any
        // tampered or unsigned value returns null and the session will
        // fail the fail-closed device-match in resolveSession.
        // R35-P3: verifyDeviceIdCookie is statically imported at the top.
        const decoded = decodeURIComponent(raw);
        const verified = await verifyDeviceIdCookie(decoded);
        effectiveDeviceId = verified ?? undefined;
        // R32-D7: if the cookie exists but verification fails (tampered
        // or legacy-unsigned), clear it so the client doesn't loop-
        // log-out on every request post-R29-M3 deploy. Next login
        // writes a fresh signed cookie. Without this, a stale
        // unsigned cookie stays in the jar forever until the user
        // manually clears cookies OR goes through signInRegister.
        //
        // AUTH-MED3: emit a structured warn when the cookie-jar write
        // is silently swallowed. In RSC contexts `jar.delete` throws
        // (jar is read-only) — the fallback is "the NEXT route handler
        // / Server Action will clear it." For a register session
        // attempt that lands in RSC and never transitions to a writable
        // context (rare, but possible if the user opens the page and
        // immediately closes it), the cookie persists until the next
        // signInRegister. Logging here makes the loop observable so
        // ops can detect users stuck in fail-closed state.
        if (verified === null) {
          try {
            jar.delete("bupos_register_device");
          } catch (err) {
            // RSC contexts have a read-only jar. The next writable
            // handler will drop it — but log so we can detect users
            // that never transition out of RSC-only mode.
            console.warn("[register-device-cookie] cleanup deferred (RSC):", safeErr(err));
          }
        }
      }
    } catch {
      // Outside a request context (tests / server-actions that resolve
      // their own cookies): leave undefined. The fail-closed check in
      // resolveSession still handles sessions with a non-null device_id
      // — those won't resolve until the caller threads deviceId in.
    }
  }
  return resolveSession("register", REGISTER_COOKIE, effectiveDeviceId) as Promise<RegisterSessionContext | null>;
}

export async function signInAdmin(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();

  if (isPg()) {
    // R35-P3: invalidateStoreCache is statically imported at the top.

    // Try the fast RPC path first (direct DB pool — works on Workers, no
    // service-role-key dependency). If the RPCs aren't provisioned on this
    // DB, fall through to the column-level pool path below.
    try {
      const pool = await pgGetPool();
      const { rows: lookupRows } = await pool.query(
        `SELECT * FROM admin_login_lookup($1::text) AS result`,
        [normalizedEmail],
      );
      const lookup = (lookupRows[0]?.result ?? lookupRows[0] ?? null) as Record<string, unknown> | null;
      if (lookup && lookup.password_hash) {
        // R42-I: equalize wall-clock time across every failure branch.
        // Prior shape short-circuited on inactive / wrong-role BEFORE
        // running PBKDF2, so an attacker measuring response latency
        // could distinguish "this email has a non-admin / inactive
        // account" from "this email has a correct-role account with a
        // wrong password" — a user-enumeration oracle against ex-
        // employees and support-role accounts. `runDecoyVerify` is the
        // same pattern the `/api/auth/login` route uses to make all
        // miss branches cost one PBKDF2 regardless of outcome.
        const { runDecoyVerify } = await import("@/lib/auth/crypto");
        if (lookup.is_active !== true) {
          await runDecoyVerify(password);
          throw new Error("Invalid admin credentials");
        }
        if (!["owner", "manager"].includes(lookup.role_key as string)) {
          await runDecoyVerify(password);
          throw new Error("Invalid admin credentials");
        }
        if (!await verifySecret(password, lookup.password_hash as string)) {
          throw new Error("Invalid admin credentials");
        }

        const organizationId = lookup.organization_id as string;
        const employeeId = lookup.employee_id as string;
        const nextSession = buildSession("admin", employeeId, organizationId);

        await pool.query(
          `SELECT admin_login_create_session($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz)`,
          [employeeId, organizationId, nextSession.id, nextSession.createdAt, nextSession.expiresAt],
        );

        // R32-D2: scope the invalidation to THIS tenant. Prior no-arg
        // call wiped every other tenant's cache on every admin login.
        invalidateStoreCache(organizationId);

        // CRITICAL: set the cookie here so server actions that call
        // signInAdmin (loginAction, signupAction) actually leave the user
        // authenticated. The /api/auth/login route does its own cookie
        // handling, but void-returning callers depend on us.
        const jar = await cookieStore();
        jar.set(ADMIN_COOKIE, nextSession.id, {
          httpOnly: true,
          sameSite: "lax",
          secure: shouldUseSecureCookie(),
          path: "/",
          expires: new Date(nextSession.expiresAt),
        });
        deleteLegacyCookie(jar, ADMIN_COOKIE);

        return { sessionId: nextSession.id, expiresAt: nextSession.expiresAt };
      }
    } catch (err) {
      // "Invalid admin credentials" is the authentication failure path — re-throw as-is.
      if (err instanceof Error && err.message === "Invalid admin credentials") throw err;
      // Any other error (e.g. RPC not provisioned locally) falls through to the column-level pool path.
    }

    // Column-level pool fallback (local dev without the RPCs provisioned)
    // R35-P3: pgFindCredentialByEmail is statically imported at the top.
    // R42-I: also equalize timing on the fallback path. Same oracle
    // applies here (local dev or RPC-missing environments) — a miss or
    // inactive/wrong-role response should cost the same as a wrong
    // password response.
    const { runDecoyVerify } = await import("@/lib/auth/crypto");
    const credential = await pgFindCredentialByEmail(normalizedEmail);
    if (!credential?.passwordHash) {
      await runDecoyVerify(password);
      throw new Error("Invalid admin credentials");
    }

    const pool = await pgGetPool();
    // check-pool-org-filter: scoped-by-just-looked-up-employee-id
    // credential.employeeId came from the email→credential lookup.
    const { rows: empRows } = await pool.query(
      `SELECT id, organization_id, role_key, is_active FROM employees WHERE id = $1 LIMIT 1`,
      [credential.employeeId],
    );
    const emp = empRows[0] as Record<string, unknown> | undefined;
    if (!emp || emp.is_active !== true || !["owner", "manager"].includes(emp.role_key as string)) {
      await runDecoyVerify(password);
      throw new Error("Invalid admin credentials");
    }

    if (!await verifySecret(password, credential.passwordHash)) {
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
    // R32-D2: scope to this tenant.
    invalidateStoreCache(organizationId);

    const jar = await cookieStore();
    jar.set(ADMIN_COOKIE, nextSession.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureCookie(),
      path: "/",
      expires: new Date(nextSession.expiresAt),
    });
    deleteLegacyCookie(jar, ADMIN_COOKIE);
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

    if (!await verifySecret(password, credential.passwordHash)) {
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
    secure: shouldUseSecureCookie(),
    path: "/",
    expires: new Date(session.expiresAt),
  });
  deleteLegacyCookie(jar, ADMIN_COOKIE);
}

/**
 * "Tap your name" register clock-in. The user picks a store, then taps an
 * employee from that store's roster. CASHIERS clock in with NO PIN — the
 * convenience trade-off the operator chose. OWNER/MANAGER names are still
 * PIN-gated: tapping one requires that person's PIN (passed in `pin`), so
 * a cashier can't silently assume manager privileges just by tapping a
 * manager's name. The register session is device-bound, and the
 * (client-supplied) employeeId + locationId are RE-VALIDATED here against
 * the DB: the employee must exist, be active, be assigned to that active
 * same-org location, and the role must carry register permissions.
 * Sensitive in-checkout actions (voids, discounts, cash payouts) remain
 * gated by the separate manager-approval PIN flow too.
 *
 * Mirrors signInRegister's session/cookie creation exactly — only the
 * candidate-scan PIN step is replaced by roster validation plus, for
 * elevated roles, a targeted PIN verify against that one employee.
 */
export async function signInRegisterByEmployee(
  employeeId: string,
  locationId: string,
  // SEC-AUDIT7-CRIT1: REQUIRED. The org of the per-store register token
  // the terminal was provisioned with (clockInAction verifies the token
  // before calling). The resolved employee/location MUST belong to this
  // org, so a forged employeeId/locationId from another tenant is rejected
  // — closing the cross-tenant no-PIN takeover on the shared /register.
  expectedOrgId: string,
  deviceId?: string,
  pin?: string,
) {
  // AUTH-AUDIT4-HIGH1 parity: synthesize a deviceId when the client
  // didn't send one, so register_sessions.device_id is never NULL (a
  // NULL disables the device-bind replay guard in resolveSession).
  if (!deviceId) deviceId = randomUUID();
  if (isPg()) {
    const pool = await pgGetPool();
    // Re-validate the client-supplied (employee, location) pair. This is
    // the identity-resolution query for the no-PIN clock-in — the ORG is
    // the OUTPUT (resolved from the employee), not an input to filter by,
    // exactly like the PIN-candidate lookup. Scoped by the specific
    // employee id ($1) + location id ($2); the JOIN on organization_id
    // guarantees they share an org, ANY(location_ids) enforces assignment,
    // and both rows must be active.
    // check-pool-org-filter: scoped-by-employee-and-location-id
    const { rows } = await pool.query(
      `SELECT e.organization_id::text AS organization_id, e.role_key, ac.pin_hash
         FROM employees e
         JOIN locations l ON l.organization_id = e.organization_id
         LEFT JOIN auth_credentials ac ON ac.employee_id = e.id
        WHERE e.id = $1::uuid
          AND e.is_active = true
          AND l.id = $2::uuid
          AND l.is_active = true
          AND l.id = ANY(e.location_ids)
          -- SEC-AUDIT7-CRIT1: bind to the provisioned terminal's org. A
          -- forged employeeId/locationId from another tenant yields no row
          -- (→ the !row redirect below), so the no-PIN clock-in can't cross
          -- tenants on the shared /register surface.
          AND e.organization_id = $3::uuid
        LIMIT 1`,
      [employeeId, locationId, expectedOrgId],
    );
    const row = rows[0] as { organization_id: string; role_key: string; pin_hash: string | null } | undefined;
    if (!row) redirect("/register?error=Could+not+clock+in.+Please+pick+your+store+and+name+again.");
    const roleKey = row.role_key as RoleKey;
    if (!hasPermission(roleKey, "register.pin_login") || !hasPermission(roleKey, "register.open")) {
      redirect("/register?error=That+employee+can%27t+open+a+register.");
    }
    // Owner/manager names are PIN-gated even in the tap-your-name flow
    // (operator choice): tapping a cashier clocks in instantly, but
    // elevating to a manager/owner session requires that person's PIN, so
    // a cashier can't assume manager privileges by tapping a manager's
    // name. clockInAction already ran the shared brute-force gate on this
    // PIN before calling us. verifySecret is the PBKDF2 compare used
    // everywhere else (statically imported, line 7). A wrong/empty PIN, or
    // a manager with no PIN on file, fails closed back to the roster.
    if (roleKey === "owner" || roleKey === "manager") {
      const cleanPin = (pin ?? "").trim();
      if (!cleanPin) {
        redirect("/register?error=Enter+the+manager+PIN+to+clock+in.");
      }
      if (!row.pin_hash || !(await verifySecret(cleanPin, row.pin_hash))) {
        redirect("/register?error=Incorrect+PIN.+Please+try+again.");
      }
    }
    const organizationId = row.organization_id;
    const nextSession = buildSession("register", employeeId, organizationId, locationId);
    const registerSessionId = randomUUID();

    await pool.query(
      `SELECT register_login_create_session($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::timestamptz, $8::timestamptz)`,
      [
        employeeId,
        organizationId,
        locationId,
        deviceId ?? null,
        nextSession.id,
        registerSessionId,
        nextSession.createdAt,
        nextSession.expiresAt,
      ],
    );

    invalidateStoreCache(organizationId);

    const jar = await cookieStore();
    jar.set(REGISTER_COOKIE, nextSession.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureCookie(),
      path: "/",
      expires: new Date(nextSession.expiresAt),
    });
    deleteLegacyCookie(jar, REGISTER_COOKIE);
    if (deviceId) {
      const signed = await signDeviceId(deviceId);
      jar.set("bupos_register_device", signed, {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecureCookie(),
        path: "/",
        expires: new Date(nextSession.expiresAt),
      });
    }

    return {
      employee: { id: employeeId, organizationId, roleKey },
      location: { id: locationId, organizationId },
      registerSession: { id: registerSessionId, deviceId },
      authSessionId: nextSession.id,
      authSessionExpiresAt: nextSession.expiresAt,
      deviceId,
    };
  }

  // JSON fallback (local dev only) — production runs the PG path above.
  redirect("/register?error=Clock-in+is+not+available+in+this+mode.");
}

export async function signInRegister(pin: string, locationId: string, deviceId?: string) {
  const cleanPin = pin.trim();

  // AUTH-AUDIT6-HIGH1 / -LOW2: PIN-login rate-limiting is enforced by the
  // shared `enforceRegisterPinRateLimits` gate at the call site
  // (registerLoginAction runs it before this function; the HTTP route runs
  // it before its inline verify). The previous inline
  // `checkRateLimit("register:" + locationId)` bucket here used a key
  // prefix (`register:`) inconsistent with every other PIN path
  // (`register-pin:` / `register-loc:` / `register-ip:`), only fired on
  // the Server-Action path (not the HTTP route, which inlines the SQL),
  // and was per-isolate-in-memory so it added no cross-isolate value.
  // Removed to keep ONE consistent rate-limit surface. INVARIANT: any new
  // caller of signInRegister MUST run enforceRegisterPinRateLimits first.

  if (isPg()) {
    // Try RPC-on-pool path first (direct DB, no service-role-key dependency).
    try {
      const pool = await pgGetPool();
      // R35-P3: verifySecret is already statically imported at the top (line 7).
      // Alias preserves the local name used below.
      const verifyPinAsync = verifySecret;

      const { rows: candidateRows } = await pool.query(
        `SELECT * FROM register_pin_candidates($1::text)`,
        [locationId],
      );
      const candidates = candidateRows as Array<{
        employee_id: string; pin_hash: string; organization_id: string;
        role_key: string; location_ids: string[];
      }>;
      if (candidates.length === 0) redirect("/register?error=PIN+login+failed");

      // R15-M-1: serial-with-early-exit; see /api/auth/register-login for
      // the full rationale. Same DoS-vector + CPU-pool pressure fix.
      let match: typeof candidates[number] | null = null;
      for (const c of candidates) {
        if (!c.pin_hash) continue;
        if (await verifyPinAsync(cleanPin, c.pin_hash)) {
          match = c;
          break;
        }
      }
      if (!match) redirect("/register?error=PIN+login+failed");

      const roleKey = match.role_key as RoleKey;
      const locationIds = match.location_ids ?? [];
      if (!locationIds.includes(locationId)) redirect("/register?error=PIN+login+failed");
      if (!hasPermission(roleKey, "register.pin_login") || !hasPermission(roleKey, "register.open")) {
        redirect("/register?error=PIN+login+failed");
      }

      const employeeId = match.employee_id;
      const organizationId = match.organization_id;
      const nextSession = buildSession("register", employeeId, organizationId, locationId);
      const registerSessionId = randomUUID();

      await pool.query(
        `SELECT register_login_create_session($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::timestamptz, $8::timestamptz)`,
        [
          employeeId,
          organizationId,
          locationId,
          deviceId ?? null,
          nextSession.id,
          registerSessionId,
          nextSession.createdAt,
          nextSession.expiresAt,
        ],
      );

      // R35-P3: invalidateStoreCache is statically imported at the top.
      // R32-D2: scope to the caller's org.
      invalidateStoreCache(organizationId);

      const jar = await cookieStore();
      jar.set(REGISTER_COOKIE, nextSession.id, {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecureCookie(),
        path: "/",
        expires: new Date(nextSession.expiresAt),
      });
      deleteLegacyCookie(jar, REGISTER_COOKIE);
      // R28-H5: companion device cookie so getRegisterSession() can
      // verify the browser matches the paired device_id.
      // R29-M3: HMAC-sign the value so a cookie-write-only XSS (or an
      // attacker who knows only the session_id) can't fabricate a
      // matching device_id. `verifyDeviceIdCookie` rejects unsigned or
      // tampered values.
      if (deviceId) {
        // R35-P3: signDeviceId is statically imported at the top.
        const signed = await signDeviceId(deviceId);
        jar.set("bupos_register_device", signed, {
          httpOnly: true,
          sameSite: "lax",
          secure: shouldUseSecureCookie(),
          path: "/",
          expires: new Date(nextSession.expiresAt),
        });
      }

      return {
        employee: { id: employeeId, organizationId, roleKey },
        location: { id: locationId, organizationId },
        registerSession: { id: registerSessionId, deviceId },
        authSessionId: nextSession.id,
        authSessionExpiresAt: nextSession.expiresAt,
        deviceId,
      };
    } catch (err) {
      // Bubble up any Next.js redirect() calls untouched.
      if (err && typeof err === "object" && "digest" in err) throw err;
      // RPC not provisioned locally → fall through to column-level path.
    }

    // Column-level pool fallback (local dev without the RPCs provisioned)
    // R35-P3: pgFindCredentialByPin is statically imported at the top.
    const pool = await pgGetPool();

    // check-pool-org-filter: scoped-by-pre-login-location-picker
    // Pre-login flow — no session yet; the lookup resolves the org
    // from the location id, which is the tenant identity for this
    // call. Caller subsequently verifies the PIN against credentials
    // scoped to that org.
    const locResult = await pool.query(
      `SELECT id, organization_id, is_active FROM locations WHERE id = $1 AND is_active = true LIMIT 1`,
      [locationId],
    );
    // AUTH-AUDIT4-LOW1: verify the location row exists BEFORE
    // scanning credentials. Prior shape coerced a missing row to
    // locOrgId=undefined and called pgFindCredentialByPin(pin,
    // undefined), which treats undefined orgId as "no org filter"
    // and PBKDF2-verifies the PIN against EVERY credential in the
    // database (DoS amplification + cross-tenant timing oracle on
    // the dev/RPC fallback path). Reject the request before the
    // expensive global scan when the location is unknown.
    if (!locResult.rows[0]) redirect("/register?error=PIN+login+failed");
    const locOrgId = (locResult.rows[0] as Record<string, unknown>).organization_id as string;
    const credential = await pgFindCredentialByPin(cleanPin, locOrgId);

    if (!credential) redirect("/register?error=PIN+login+failed");

    // check-pool-org-filter: scoped-by-just-looked-up-credential
    const { rows: empRows } = await pool.query(
      `SELECT id, organization_id, role_key, location_ids, is_active FROM employees WHERE id = $1 AND is_active = true LIMIT 1`,
      [credential.employeeId],
    );
    const emp = empRows[0] as Record<string, unknown> | undefined;
    if (!emp) redirect("/register?error=PIN+login+failed");

    const roleKey = emp.role_key as RoleKey;
    const locationIds = (emp.location_ids as string[]) ?? [];
    if (!locationIds.includes(locationId)) redirect("/register?error=PIN+login+failed");
    if (!hasPermission(roleKey, "register.pin_login") || !hasPermission(roleKey, "register.open")) {
      redirect("/register?error=PIN+login+failed");
    }

    const timestamp = new Date().toISOString();
    const employeeId = credential.employeeId;
    const organizationId = emp.organization_id as string;
    const nextSession = buildSession("register", employeeId, organizationId, locationId);
    const registerSessionId = randomUUID();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM sessions WHERE scope = $1 AND employee_id = $2`, ["register", employeeId]);
      // check-pool-org-filter: scoped-by-just-authenticated-employee-id
      // employeeId + locationId were both verified as belonging to the
      // caller's org via the preceding PIN verification.
      await client.query(
        `UPDATE register_sessions SET status = 'ended', ended_at = $1
         WHERE employee_id = $2 AND location_id = $3 AND status = 'active'`,
        [timestamp, employeeId, locationId],
      );

      if (deviceId) {
        await client.query(
          `UPDATE register_sessions SET status = 'ended', ended_at = $1
           WHERE organization_id = $2 AND device_id = $3 AND status = 'active'`,
          [timestamp, organizationId, deviceId],
        );
      }

      await client.query(
        `INSERT INTO sessions (id, employee_id, organization_id, scope, location_id, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [nextSession.id, nextSession.employeeId, nextSession.organizationId, nextSession.scope,
          nextSession.locationId ?? null, nextSession.createdAt, nextSession.lastSeenAt, nextSession.expiresAt],
      );
      await client.query(
        `INSERT INTO register_sessions (id, auth_session_id, employee_id, location_id, organization_id, device_id, status, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
        [registerSessionId, nextSession.id, employeeId, locationId, organizationId, deviceId ?? null, timestamp],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const jar = await cookieStore();
    jar.set(REGISTER_COOKIE, nextSession.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureCookie(),
      path: "/",
      expires: new Date(nextSession.expiresAt),
    });
    deleteLegacyCookie(jar, REGISTER_COOKIE);
    // R28-H5: companion device cookie (column-level fallback path).
    // R29-M3: HMAC-signed — see RPC path above for rationale.
    // R35-P3: signDeviceId is statically imported at the top.
    if (deviceId) {
      const signed = await signDeviceId(deviceId);
      jar.set("bupos_register_device", signed, {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecureCookie(),
        path: "/",
        expires: new Date(nextSession.expiresAt),
      });
    }

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
    let credential = null;
    for (const entry of store.authCredentials) {
      if (entry.pinHash && await verifySecret(cleanPin, entry.pinHash)) {
        credential = entry;
        break;
      }
    }
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
    secure: shouldUseSecureCookie(),
    path: "/",
    expires: new Date(session.authSessionExpiresAt),
  });
  deleteLegacyCookie(jar, REGISTER_COOKIE);
}

export async function signOutAdmin() {
  const jar = await cookieStore();
  const sessionId = getCookieValue(jar, ADMIN_COOKIE, OLD_ADMIN_COOKIE);

  if (sessionId) {
    if (isPg()) {
      await pgDeleteSession(sessionId);
    } else {
      await mutateStore((store) => {
        store.sessions = store.sessions.filter((entry) => entry.id !== sessionId);
      });
    }
  }

  // SEC-AUDIT5-MED4: clear cookies with attributes matching what they
  // were set with. Per RFC 6265bis, Safari and Firefox may refuse to
  // clear a `Secure` cookie via a non-Secure clearing Set-Cookie even
  // on HTTPS — bare `jar.delete(name)` only emits `Path=/`, losing the
  // Secure / HttpOnly / SameSite attrs the cookie was minted with. The
  // DB-side session row IS deleted (above), so the cookie is functionally
  // dead, but a stale cookie sitting in the browser is a UX/forensic
  // issue and a future-proofing risk if any code path ever re-validates
  // sessions by id alone. Mirror the /revoke-all-sessions pattern.
  const adminClearOpts = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: shouldUseSecureCookie(),
    expires: new Date(0),
    maxAge: 0,
  };
  jar.set(ADMIN_COOKIE, "", adminClearOpts);
  jar.set(OLD_ADMIN_COOKIE, "", adminClearOpts);
}

export async function signOutRegister() {
  const jar = await cookieStore();
  const sessionId = getCookieValue(jar, REGISTER_COOKIE, OLD_REGISTER_COOKIE);

  if (sessionId) {
    if (isPg()) {
      // R44-FE1 / R45-H1: always use the column-level path, all FIVE
      // state mutations wrapped in ONE transaction for atomicity.
      //
      // Prior shape (R44-FE1) issued 5 separate `pool.query()` calls
      // (each opening a one-shot Neon pool on Workers):
      //   1. UPDATE register_sessions status='ended'
      //   2. UPDATE shifts status='closed'
      //   3. INSERT audit_events
      //   4. UPDATE register_sessions active_shift_id=NULL
      //   5. DELETE sessions
      // A Worker isolate freeze, Neon WebSocket hiccup, or transient
      // query error between steps left the register in an inconsistent
      // state (e.g., shift closed but no audit row; or register_
      // session ended but shift still open). The transaction block
      // rolls the whole thing back on any failure — subsequent logout
      // retry re-runs cleanly.
      //
      // R45-H1: do NOT fake closing_variance=0 / closing_expected_cash
      // = opening_float. Prior values SILENTLY ERASED all cash sales
      // from the shift's reconciliation ledger — a cashier with $500
      // in cash sales logging out mid-shift got a "zero variance"
      // close that hid any real discrepancy. Set the closing fields
      // to NULL and mark the close note as "auto-closed (not
      // reconciled)" so downstream reports render "unreconciled"
      // instead of "perfect close."
      {
        const { orgTx } = await import("@/lib/supabase-rest");
        const timestamp = new Date().toISOString();

        // We don't have orgId yet (that's returned by the first
        // UPDATE). Open a connection from the default pool, begin tx
        // manually, then SET LOCAL app.current_org_id once orgId is
        // known. This matches the bespoke-tx pattern used elsewhere
        // in session.ts.
        const pool = await pgGetPool();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          // sessionId is cookie-proven; orgId comes out of RETURNING.
          // check-pool-org-filter: scoped-by-auth-session-cookie
          const { rows: endedRows } = await client.query(
            `UPDATE register_sessions SET status = 'ended', ended_at = $1
             WHERE auth_session_id = $2 AND status = 'active'
             RETURNING id, employee_id, organization_id, location_id, active_shift_id`,
            [timestamp, sessionId],
          );

          const registerSession = endedRows[0] as
            | { id: string; employee_id: string; organization_id: string; location_id: string; active_shift_id: string | null }
            | undefined;

          if (registerSession?.active_shift_id) {
            // R45-M3: org filter defense-in-depth on the shift UPDATE.
            // R45-H1: set closing_* to NULL (not faked opening_float)
            // so unreconciled closes surface clearly in reports.
            // R46-M2: capture RETURNING id so we only audit when the
            // UPDATE actually matched a row. A race with manual
            // `closeShiftAction` (cashier hits "Close Shift" and then
            // "Logout" in quick succession) leaves the shift ALREADY
            // closed when signOutRegister runs — the UPDATE's
            // `status = 'open'` predicate matches zero rows, but the
            // prior shape still fired the `shift_auto_closed` +
            // `unreconciled=true` audit event, falsely attributing an
            // unreconciled close to the cashier who actually closed
            // cleanly. Conditional audit emit via rowCount closes this.
            const { rows: closedRows } = await client.query(
              `UPDATE shifts
               SET status = 'closed',
                   closed_at = $1,
                   closing_expected_cash = NULL,
                   closing_declared_cash = NULL,
                   closing_variance = NULL,
                   closed_note = $2
               WHERE id = $3 AND status = 'open' AND organization_id = $4
               RETURNING id`,
              [
                timestamp,
                "Auto-closed on register logout — NOT reconciled. Declared cash + variance must be entered manually to close the books.",
                registerSession.active_shift_id,
                registerSession.organization_id,
              ],
            );
            if (closedRows.length > 0) {
              await client.query(
                `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
                 VALUES ($1, $2, $3, $4, 'shift', $5, 'shift_auto_closed', $6, $7)`,
                [
                  randomUUID(),
                  registerSession.organization_id,
                  registerSession.location_id,
                  registerSession.employee_id,
                  registerSession.active_shift_id,
                  JSON.stringify({
                    register_session_id: registerSession.id,
                    auto_closed: "true",
                    reason: "register_logout",
                    unreconciled: "true",
                  }),
                  timestamp,
                ],
              );
            }
            // Always clear active_shift_id — if the shift was already
            // closed by closeShiftAction, the register_sessions row
            // may still point at it; clearing is idempotent either way.
            await client.query(
              `UPDATE register_sessions SET active_shift_id = NULL WHERE id = $1 AND organization_id = $2`,
              [registerSession.id, registerSession.organization_id],
            );
          }

          // Delete the auth session row too (pgDeleteSession logic
          // inline so it's in the same tx).
          await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);

          await client.query("COMMIT");
          // `orgTx` reference is intentionally kept as documentation
          // of the org-gated tx style — inline client is used instead
          // because orgId is only known AFTER the first UPDATE's
          // RETURNING. Silence the unused-var lint.
          void orgTx;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
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

  // SEC-AUDIT5-MED4: clear with matching attrs (RFC 6265bis). See
  // signOutAdmin above for rationale.
  const registerClearOpts = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: shouldUseSecureCookie(),
    expires: new Date(0),
    maxAge: 0,
  };
  jar.set(REGISTER_COOKIE, "", registerClearOpts);
  jar.set(OLD_REGISTER_COOKIE, "", registerClearOpts);
  // R28-H5: clear the companion device cookie too so the next pairing
  // re-binds cleanly.
  jar.set("bupos_register_device", "", registerClearOpts);
}
