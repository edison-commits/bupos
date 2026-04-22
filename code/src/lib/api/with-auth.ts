import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";
import type { PermissionKey } from "@/lib/domain/types";
import { hasPermission } from "@/lib/domain/permissions";
import { safeErr } from "@/lib/logging/safe-err";

/**
 * R25-ops-H-1: correlate Worker logs with user reports.
 * Accepts Cloudflare's `cf-ray` if present, else mints a fresh UUID.
 * Echoed in the response as `x-request-id` so users / ops dashboards
 * can cite the same ID in support tickets + log searches.
 */
function mintRequestId(req: NextRequest): string {
  // R32-D9: only trust `cf-ray` if we ALSO see another Cloudflare-
  // injected header (`cf-connecting-ip`). Prior shape accepted any
  // client-supplied `cf-ray` value — an attacker bypassing CF
  // (direct-to-origin Worker URL, preview tunnels, misconfigured
  // staging) could inject a collision with a legitimate request-id
  // to poison ops' log correlation or cite a fake id in a support
  // ticket. `cf-connecting-ip` is also CF-injected (and stripped by
  // Workers runtime on direct-origin hits), so requiring both
  // ensures the request genuinely traversed CF.
  const cfRay = req.headers.get("cf-ray");
  const cfConnecting = req.headers.get("cf-connecting-ip");
  if (cfRay && cfConnecting) return cfRay;
  return crypto.randomUUID();
}

/**
 * Emit a structured JSON error log. Cloudflare Logpush turns
 * single-line JSON into queryable columns; the string-only form
 * the prior code emitted was invisible to any log-based alerting.
 */
function logRouteError(ctx: {
  reqId: string;
  method: string;
  path: string;
  orgId?: string;
  employeeId?: string;
  roleKey?: string;
  err: unknown;
}): void {
  console.error(
    JSON.stringify({
      level: "error",
      at: new Date().toISOString(),
      event: "api_route_error",
      reqId: ctx.reqId,
      method: ctx.method,
      path: ctx.path,
      orgId: ctx.orgId,
      employeeId: ctx.employeeId,
      roleKey: ctx.roleKey,
      error: safeErr(ctx.err),
    }),
  );
}

const ADMIN_COOKIE = "basicuniformpos_admin_session";
const REGISTER_COOKIE = "basicuniformpos_register_session";

// Admin users with multiple assigned locations need a way to tell the server
// which location their UI is currently focused on — the `ctx.locationId` was
// always `locationIds[0]`, which meant every location-scoped admin endpoint
// (eod-report, inventory, shift-close, export) returned data for the first
// assignment regardless of what the manager saw on screen. Honor an explicit
// `x-active-location` header (set by the client location switcher); the
// request-level `bupos_active_location` cookie is a compatibility fallback
// for server-rendered pages. The value is validated against the employee's
// assigned locations; if absent or invalid, fall back to locationIds[0] so
// existing callers still work.
const ACTIVE_LOCATION_HEADER = "x-active-location";
const ACTIVE_LOCATION_COOKIE = "bupos_active_location";

function resolveActiveLocation(
  req: NextRequest,
  jar: { get: (name: string) => { value: string } | undefined },
  assigned: string[] | undefined,
): string | undefined {
  const candidate =
    req.headers.get(ACTIVE_LOCATION_HEADER)?.trim()
    || jar.get(ACTIVE_LOCATION_COOKIE)?.value?.trim()
    || "";
  const allowed = assigned ?? [];
  if (candidate && allowed.includes(candidate)) return candidate;
  return allowed[0];
}

// Methods that mutate state. Safe methods (GET/HEAD/OPTIONS) are skipped for
// the Origin check so read-only pages and CORS preflights aren't blocked.
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// R25-ops-M-4: cap request body size. Cloudflare Workers default is
// ~100MB; without an app-level check, a malicious client can force a
// ~100MB JSON parse just to burn the Worker's CPU budget. The
// biggest legitimate payload we accept is offline-sync with ~500 cart
// items (~150KB). 2MB leaves headroom for attached images / base64
// payloads in custom fields without blowing past the 30s CPU cap.
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
function checkBodySize(req: NextRequest): NextResponse | null {
  if (!STATE_CHANGING_METHODS.has(req.method)) return null;
  const lenHeader = req.headers.get("content-length");
  if (!lenHeader) return null; // chunked / unknown — stream will be bounded by runtime
  const len = Number(lenHeader);
  if (!Number.isFinite(len)) return null;
  if (len > MAX_REQUEST_BODY_BYTES) {
    return NextResponse.json(
      { error: "Request body too large" },
      { status: 413 },
    );
  }
  return null;
}

// Cookies are SameSite=Lax so a third-party site can't POST with credentials
// via a form submission, but any app-level XSS, a compromised browser
// extension, or a subdomain takeover could still issue cross-origin requests
// with our cookies attached. Enforcing Origin === Host on state-changing
// methods closes that gap for the common browser-CSRF case.
//
// R37-M1: map a request path to the step-up bucket key it would hit
// (gift-card-disable-stepup / customer-update-stepup / etc.). Pure
// pattern match — if the pathname isn't one we've gated, returns
// undefined. Helps log-based alerting distinguish a step-up-password
// 400 from a generic validation 400.
function inferStepUpBucket(pathname: string): string | undefined {
  if (pathname.startsWith("/api/gift-cards")) return "gift-card-*-stepup";
  if (pathname.startsWith("/api/email-receipt")) return "email-receipt-override-stepup";
  if (pathname.startsWith("/api/customers")) return "customer-update-stepup";
  if (pathname.startsWith("/api/returns/process")) return "returns-process-stepup";
  if (pathname.startsWith("/api/store-credit")) return "store-credit-stepup";
  if (pathname.startsWith("/api/loyalty")) return "loyalty-adjust-stepup";
  if (pathname.startsWith("/api/employees")) return "employees-patch-stepup";
  if (pathname.startsWith("/api/shift-close") || pathname.startsWith("/api/shift-report")) {
    return "shift-close-stepup";
  }
  return undefined;
}

// Exported so non-wrapped routes (e.g., /api/customer-display which uses
// getRegisterSession directly) can opt into the same CSRF guard.
export function checkOrigin(req: NextRequest): NextResponse | null {
  if (!STATE_CHANGING_METHODS.has(req.method)) return null;

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");

  // Non-browser clients (curl, server-to-server) typically don't send Origin
  // or Referer. We require at least one to be present on mutating calls so a
  // browser CSRF can't slip through by omitting headers — the browser always
  // sends Origin on POST/PUT/PATCH/DELETE.
  if (!origin && !referer) {
    return NextResponse.json(
      { error: "Missing Origin or Referer header" },
      { status: 403 },
    );
  }

  // Prefer Origin (scheme+host+port only); fall back to the referer's origin
  // since some privacy-conscious browsers strip Origin in specific cases.
  let sourceOrigin: string | null = origin;
  if (!sourceOrigin && referer) {
    try {
      sourceOrigin = new URL(referer).origin;
    } catch {
      sourceOrigin = null;
    }
  }
  if (!sourceOrigin) {
    return NextResponse.json({ error: "Invalid Origin" }, { status: 403 });
  }

  // Build the set of allowed origins. Same-origin (request's own host) always
  // counts; the production host and dev localhost are the only other callers.
  const requestOrigin = new URL(req.url).origin;
  const allowed = new Set<string>([
    requestOrigin,
    "https://bupos.basicuniform.com",
  ]);
  if (process.env.NODE_ENV !== "production") {
    allowed.add("http://localhost:3000");
  }

  if (!allowed.has(sourceOrigin)) {
    return NextResponse.json(
      { error: "Origin not allowed" },
      { status: 403 },
    );
  }
  return null;
}

interface AdminContext {
  session: NonNullable<Awaited<ReturnType<typeof getAdminSession>>>["session"];
  employee: NonNullable<Awaited<ReturnType<typeof getAdminSession>>>["employee"];
  orgId: string;
  locationId: string | undefined;
  /**
   * Location-scope filter for non-manager roles.
   *
   *   - `null`   → caller is owner/manager; see everything in the org
   *   - `string[]` → caller is cashier / inventory_clerk / support;
   *                  list endpoints MUST filter on
   *                  `location_id = ANY(allowedLocations)`.
   *
   * Convention: every handler reading or writing a location-scoped table
   * (transactions, shifts, inventory, customers-as-PII) checks `allowedLocations`
   * and adds the filter when it's non-null. This prevents the R7-H-2 /
   * R8-M-8 / R9-H-2 / R11-H-1 / R11-H-4 shape where a cashier holding
   * `register.open` or `audit.view` can read every location's data.
   */
  allowedLocations: string[] | null;
  /**
   * R25-ops-H-1: correlation ID for this request. Propagate into any
   * structured log emitted from a route handler so per-request logs
   * can be joined with the central api_route_error events.
   */
  reqId: string;
}

interface DualContext extends AdminContext {
  registerSession: Awaited<ReturnType<typeof getRegisterSession>>;
}

/**
 * Auth wrapper for admin-only API routes.
 * Returns 401 JSON instead of redirecting (correct for API routes).
 *
 * Usage:
 *   export const GET = withAdminAuth("audit.view", async (req, ctx) => { ... });
 */
export function withAdminAuth(
  permission: PermissionKey,
  handler: (req: NextRequest, ctx: AdminContext) => Promise<NextResponse>,
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const reqId = mintRequestId(req);
    const sizeErr = checkBodySize(req);
    if (sizeErr) {
      sizeErr.headers.set("x-request-id", reqId);
      return sizeErr;
    }
    const originErr = checkOrigin(req);
    if (originErr) {
      originErr.headers.set("x-request-id", reqId);
      return originErr;
    }

    const adminCtx = await getAdminSession();
    if (!adminCtx?.session || !adminCtx?.employee) {
      const r = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      r.headers.set("x-request-id", reqId);
      return r;
    }
    if (!hasPermission(adminCtx.employee.roleKey, permission)) {
      const r = NextResponse.json({ error: "Forbidden" }, { status: 403 });
      r.headers.set("x-request-id", reqId);
      return r;
    }
    const orgId = adminCtx.employee.organizationId;
    if (!orgId) {
      const r = NextResponse.json({ error: "No organization context" }, { status: 400 });
      r.headers.set("x-request-id", reqId);
      return r;
    }
    try {
      // cookies() throws outside a request context (e.g., unit tests
      // that invoke the handler directly). Fall back to an empty jar
      // so tests still exercise the real auth flow — the active-
      // location resolver then falls through to locationIds[0], which
      // matches the legacy (pre-R25) behavior.
      let jar: { get: (n: string) => { value: string } | undefined };
      try {
        jar = await cookies();
      } catch {
        jar = { get: () => undefined };
      }
      const role = adminCtx.employee.roleKey;
      const isManager = role === "owner" || role === "manager";
      const res = await handler(req, {
        session: adminCtx.session,
        employee: adminCtx.employee,
        orgId,
        locationId: resolveActiveLocation(req, jar, adminCtx.employee.locationIds),
        allowedLocations: isManager ? null : (adminCtx.employee.locationIds ?? []),
        reqId,
      });
      applyNoStore(res);
      res.headers.set("x-request-id", reqId);
      // R37-M1: emit a structured event for client-error responses
      // (400/401/403/409/429) so Axiom / Logpush can alert on step-up
      // failure floods, unauthorized attempts, and stale-UI 4xx spikes.
      // Previously only 5xx entered the catch below; 4xx responses went
      // out silently, making "every customer edit 400s because R36 gate
      // was wrong" invisible in monitoring.
      if (res.status >= 400 && res.status < 500) {
        const bucketHint = inferStepUpBucket(req.nextUrl.pathname);
        console.error(JSON.stringify({
          event: "api_route_client_error",
          reqId,
          method: req.method,
          path: req.nextUrl.pathname,
          status: res.status,
          orgId,
          employeeId: adminCtx.employee.id,
          roleKey: adminCtx.employee.roleKey,
          stepUpBucket: bucketHint,
        }));
      }
      return res;
    } catch (err) {
      // R21-H-2 + R25-ops-H-1: structured JSON log with correlation ID
      // + tenant context. Response echoes x-request-id so users can cite
      // it in support reports.
      logRouteError({
        reqId,
        method: req.method,
        path: req.nextUrl.pathname,
        orgId,
        employeeId: adminCtx.employee.id,
        roleKey: adminCtx.employee.roleKey,
        err,
      });
      const r = NextResponse.json({ error: "Internal server error", reqId }, { status: 500 });
      r.headers.set("x-request-id", reqId);
      return r;
    }
  };
}

// Default Cache-Control for auth-gated responses. Auth responses must not be
// cached by browsers, intermediate proxies, or the BFCache — a shared
// terminal could serve the previous user's customer/transaction data to the
// next cashier on back-forward navigation. Individual handlers may override
// by setting the header themselves before returning.
function applyNoStore(res: NextResponse): void {
  if (!res.headers.has("cache-control")) {
    res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  }
}

/** Backward-compatible alias for existing routes (audit, dashboard, reports) */
export const withAuth = withAdminAuth;

/**
 * Auth wrapper for API routes accessible from both admin panel AND register.
 * Tries admin session first, falls back to register session.
 *
 * Usage:
 *   export const GET = withDualAuth("transactions.view", async (req, ctx) => { ... });
 */
export function withDualAuth(
  permission: PermissionKey,
  handler: (req: NextRequest, ctx: DualContext) => Promise<NextResponse>,
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const reqId = mintRequestId(req);
    const sizeErr = checkBodySize(req);
    if (sizeErr) {
      sizeErr.headers.set("x-request-id", reqId);
      return sizeErr;
    }
    const originErr = checkOrigin(req);
    if (originErr) {
      originErr.headers.set("x-request-id", reqId);
      return originErr;
    }

    // PERF: resolveSession() is expensive (opens a Neon pool + runs
    // find_session + readStore). Resolving BOTH scopes concurrently on every
    // request doubles the Neon work on terminals that only have one cookie
    // set, which is the common case. Check cookies first and only resolve
    // the session whose cookie is present; fall back to the other only if
    // the first comes back null.
    //
    // cookies() throws outside a request context (e.g., unit tests that
    // invoke the handler directly). Fall back to probing BOTH session
    // helpers — the perf hit only applies to tests, which mock them.
    let jar: { get: (n: string) => { value: string } | undefined };
    let cookiesAvailable = true;
    try {
      jar = await cookies();
    } catch {
      jar = { get: () => undefined };
      cookiesAvailable = false;
    }
    const hasAdminCookie = cookiesAvailable ? !!jar.get(ADMIN_COOKIE)?.value : true;
    const hasRegisterCookie = cookiesAvailable ? !!jar.get(REGISTER_COOKIE)?.value : true;

    let adminCtx = null;
    let registerCtx = null;
    if (hasAdminCookie) {
      adminCtx = await getAdminSession();
    }
    if (!adminCtx?.session && hasRegisterCookie) {
      registerCtx = await getRegisterSession();
    }
    const ctx = adminCtx?.session && adminCtx?.employee ? adminCtx : null;
    const regCtx = registerCtx?.employee ? registerCtx : null;

    if (!ctx && !regCtx) {
      const r = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      r.headers.set("x-request-id", reqId);
      return r;
    }

    const employee = ctx?.employee ?? regCtx?.employee;
    if (!employee || !hasPermission(employee.roleKey, permission)) {
      const r = NextResponse.json({ error: "Forbidden" }, { status: 403 });
      r.headers.set("x-request-id", reqId);
      return r;
    }

    const orgId = ctx?.employee?.organizationId ?? regCtx?.employee?.organizationId;
    if (!orgId) {
      const r = NextResponse.json({ error: "No organization context" }, { status: 400 });
      r.headers.set("x-request-id", reqId);
      return r;
    }

    try {
      // Register-scope clients have a single locked location (the register
      // terminal). Admin-scope clients honor the active-location header.
      const adminLoc = ctx ? resolveActiveLocation(req, jar, ctx.employee?.locationIds) : undefined;
      const role = employee.roleKey;
      const isManager = role === "owner" || role === "manager";
      // Register-scope callers always see only their register's location
      // (regardless of role) — the register is a single-location terminal.
      // Admin-scope callers see everything if manager+, else only their
      // assigned locations.
      const allowedLocations = regCtx
        ? [regCtx.location!.id]
        : isManager
          ? null
          : (employee.locationIds ?? []);
      const res = await handler(req, {
        session: (ctx?.session ?? regCtx?.session) as AdminContext["session"],
        employee: ctx?.employee ?? regCtx!.employee,
        orgId,
        locationId: adminLoc ?? regCtx?.location?.id,
        allowedLocations,
        registerSession: regCtx,
        reqId,
      });
      applyNoStore(res);
      res.headers.set("x-request-id", reqId);
      // R37-M1: also log 4xx from dual-auth routes. See withAdminAuth
      // above for full rationale — step-up / stale-UI / validation 400s
      // are now surfaced for log-based alerting.
      if (res.status >= 400 && res.status < 500) {
        const bucketHint = inferStepUpBucket(req.nextUrl.pathname);
        console.error(JSON.stringify({
          event: "api_route_client_error",
          reqId,
          method: req.method,
          path: req.nextUrl.pathname,
          status: res.status,
          orgId,
          employeeId: employee.id,
          roleKey: employee.roleKey,
          scope: ctx ? "admin" : "register",
          stepUpBucket: bucketHint,
        }));
      }
      return res;
    } catch (err) {
      // R21-H-2 + R25-ops-H-1: structured JSON log with correlation ID.
      logRouteError({
        reqId,
        method: req.method,
        path: req.nextUrl.pathname,
        orgId,
        employeeId: employee.id,
        roleKey: employee.roleKey,
        err,
      });
      const r = NextResponse.json({ error: "Internal server error", reqId }, { status: 500 });
      r.headers.set("x-request-id", reqId);
      return r;
    }
  };
}
