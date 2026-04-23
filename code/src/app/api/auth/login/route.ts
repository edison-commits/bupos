import { checkRateLimit } from "@/lib/auth/rate-limit";
import { verifySecret, runDecoyVerify } from "@/lib/auth/crypto";
import { randomUUID } from "@/lib/uuid";
import { addDays } from "@/lib/utils/date";
import { getPool } from "@/lib/supabase-rest";
import { safeErr } from "@/lib/logging/safe-err";

// R41-2: opaque cookie name (see session.ts for rationale).
const ADMIN_COOKIE = "bupos_a";
const OLD_ADMIN_COOKIE = "basicuniformpos_admin_session";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  let email: string | null = null;
  let password: string | null = null;

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    email = (formData.get("email") as string)?.trim().toLowerCase() ?? null;
    password = formData.get("password") as string | null;
  } else {
    const body = await request.json() as Record<string, unknown>;
    email = ((body.email as string) ?? "").trim().toLowerCase() || null;
    password = (body.password as string) ?? null;
  }

  if (!email || !password) {
    return Response.json({ error: "Email and password are required." }, { status: 400 });
  }

  // Rate limiting — namespace the bucket so we never collide with a
  // future consumer that also uses email as a key (e.g. customer
  // lookup, password reset). Defence against cross-feature bucket
  // exhaustion, not a functional bug today.
  // R43-M: emit structured warn on every 429 so Logpush / Axiom can
  // alert on credential-stuffing flare-ups. Actor is email-prefix
  // only — never the full address (PII).
  const { logRateLimited } = await import("@/lib/logging/rate-limit-log");
  const actorPrefix = email.slice(0, 3) + "***";

  const rl = checkRateLimit(`admin-login:${email}`);
  if (!rl.allowed) {
    logRateLimited({ bucket: "admin-login", layer: "mem", actor: actorPrefix });
    return Response.json({ error: "Too many attempts. Try again shortly." }, { status: 429 });
  }

  // R8-M-11: KV layer for cross-isolate coherence — the per-isolate
  // in-memory limiter above catches bursts within one worker; KV catches
  // distributed attacks that spread across the ~32 isolates per colo.
  const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
  const kvRl = await checkKvRateLimit(`admin-login:${email}`, { maxAttempts: 8, windowMs: 300_000 });
  if (!kvRl.allowed) {
    logRateLimited({ bucket: "admin-login", layer: "kv", actor: actorPrefix });
    return Response.json({ error: "Too many attempts. Try again shortly." }, { status: 429 });
  }

  // R27-L1: DB layer backstop. /register-login already layered in-mem +
  // KV + DB; /admin-login was only 2-layer. If KV fails open (binding
  // missing / renamed), admin-login would degrade to per-isolate
  // in-memory only — ~96 attempts / 5 min / email across the ~32 Worker
  // isolates per colo. The DB layer catches that regression. Higher
  // latency than KV (~30-100ms vs ~5-20ms) but acceptable on auth paths.
  const { checkDbRateLimit } = await import("@/lib/auth/db-rate-limit");
  const dbRl = await checkDbRateLimit(`admin-login:${email}`, { maxAttempts: 10, windowMs: 600_000 });
  if (!dbRl.allowed) {
    logRateLimited({ bucket: "admin-login", layer: "db", actor: actorPrefix });
    return Response.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  // Origin validation
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const allowedOrigin = new RegExp(`^https?://${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  if (!allowedOrigin.test(origin)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  // Direct Postgres path via the per-call pool facade. We used to hit the
  // Supabase REST RPC endpoint with the service role key, but relying on a
  // separately-configured key is fragile — if SUPABASE_SERVICE_ROLE_KEY is
  // missing in production, the code silently falls back to the anon key,
  // which PostgREST accepts only while the SECURITY DEFINER function has a
  // default PUBLIC EXECUTE grant. That combination *is* the auth-bypass bug
  // round 24 closed. Using the DB pool directly uses the `postgres` role via
  // DATABASE_URL, which has an explicit EXECUTE grant and never depends on
  // JWT-based anon reachability.
  const pool = await getPool();

  try {
    // Lookup credentials
    const { rows: lookupRows } = await pool.query(
      `SELECT * FROM admin_login_lookup($1::text) AS result`,
      [email],
    );
    const lookup = (lookupRows[0]?.result ?? lookupRows[0] ?? null) as Record<string, unknown> | null;
    // R27-M1: equalize wall-clock time between "email not found" and
    // "email found but wrong password" by ALWAYS running PBKDF2 once.
    // Previously the miss branch short-circuited without running
    // verifySecret at all, so an attacker could distinguish the two
    // cases by measuring response time (~100ms delta) and enumerate
    // which emails have accounts for targeted phishing or credential
    // stuffing. Choosing the real hash when we have one, a decoy
    // otherwise, makes the code path identical.
    const inactiveOrWrongRole =
      !lookup ||
      !lookup.password_hash ||
      lookup.is_active !== true ||
      !["owner", "manager"].includes(lookup.role_key as string);
    if (inactiveOrWrongRole) {
      await runDecoyVerify(password);
      return Response.json({ error: "Invalid email or password." }, { status: 401 });
    }
    if (!(await verifySecret(password, lookup.password_hash as string))) {
      return Response.json({ error: "Invalid email or password." }, { status: 401 });
    }

    // Create session
    const organizationId = lookup.organization_id as string;
    const employeeId = lookup.employee_id as string;
    const now = new Date();
    const sessionId = randomUUID();
    const expiresAt = addDays(now, 7);

    // Session rotation is enforced inside admin_login_create_session:
    // supabase/migrations/019_admin_login_rpc.sql:45 — it deletes all prior
    // `scope = 'admin'` rows for this employee before inserting the new
    // session. That closes session fixation for the admin path.
    await pool.query(
      `SELECT admin_login_create_session($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz)`,
      [employeeId, organizationId, sessionId, now.toISOString(), expiresAt.toISOString()],
    );

    // Invalidate store cache — scoped to THIS tenant (R32-D2).
    try {
      const { invalidateStoreCache } = await import("@/lib/persistence/postgres-read-store");
      invalidateStoreCache(organizationId);
    } catch {
      // Non-fatal
    }

    // Build success response — session is delivered via HttpOnly cookie only.
    // Never expose sessionId in the response body (prevents leaks via devtools/logs).
    const isSecure = request.url.startsWith("https");
    const cookieAttrs = [
      `Path=/`,
      `HttpOnly`,
      `SameSite=Lax`,
      ...(isSecure ? ["Secure"] : []),
    ];
    const setCookieNew = [
      `${ADMIN_COOKIE}=${sessionId}`,
      ...cookieAttrs,
      `Expires=${expiresAt.toUTCString()}`,
    ].join("; ");
    // R41-2: explicitly clear the legacy cookie so a rollover client
    // doesn't end up with BOTH names pinned (could confuse later
    // read paths until they expire naturally).
    const clearOld = [
      `${OLD_ADMIN_COOKIE}=`,
      ...cookieAttrs,
      `Max-Age=0`,
    ].join("; ");

    // Next.js Response supports multiple Set-Cookie via a Headers
    // instance with repeated `append` calls.
    const headers = new Headers();
    headers.append("Set-Cookie", setCookieNew);
    headers.append("Set-Cookie", clearOld);
    return Response.json(
      { success: true, redirect: "/admin" },
      { status: 200, headers },
    );
  } catch (err) {
    // R18-LOW-2: redact via shared `safeErr`. Raw pg errors can include
    // query text + parameter values (attempted-login email) that land in
    // Cloudflare logs. The sibling register-login route pioneered this
    // pattern; extracted to @/lib/logging/safe-err for reuse.
    console.error("[api/auth/login] Error:", safeErr(err));
    return Response.json({ error: "Invalid email or password." }, { status: 401 });
  }
}
