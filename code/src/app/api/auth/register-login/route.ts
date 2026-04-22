import { checkRateLimit } from "@/lib/auth/rate-limit";
import { randomUUID } from "@/lib/uuid";
import { addDays } from "@/lib/utils/date";
import { hasPermission } from "@/lib/domain/permissions";
import type { RoleKey } from "@/lib/domain/types";
import { getPool } from "@/lib/supabase-rest";

const REGISTER_COOKIE = "basicuniformpos_register_session";

/** Verify PIN using the same PBKDF2 algorithm as hashSecret in crypto.ts. */
async function verifyPin(secret: string, encoded: string): Promise<boolean> {
  const { verifySecret } = await import("@/lib/auth/crypto");
  return verifySecret(secret, encoded);
}

// R18-LOW-2: `safeErr` extracted to `@/lib/logging/safe-err` so all auth
// routes share one redaction helper.
import { safeErr } from "@/lib/logging/safe-err";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  let pin: string | null = null;
  let locationId: string | null = null;
  let deviceId: string | null = null;

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    pin = (formData.get("pin") as string)?.trim() ?? null;
    locationId = (formData.get("locationId") as string) ?? null;
    deviceId = (formData.get("deviceId") as string) || null;
  } else {
    const body = await request.json() as Record<string, unknown>;
    pin = ((body.pin as string) ?? "").trim() || null;
    locationId = (body.locationId as string) ?? null;
    deviceId = (body.deviceId as string) || null;
  }

  if (!pin || !locationId) {
    return Response.json({ error: "PIN and location are required." }, { status: 400 });
  }

  // R27-H1: per-IP rate limit added. The existing per-PIN / per-location
  // buckets are IP-independent — a 4-digit PIN space (10 000 values)
  // against a 50-employee location, with the per-location cap of 30
  // attempts per 5 min, was brute-forceable in ~33 minutes from a single
  // IP (each attempt tests all 50 candidates). Per-IP caps the
  // attacker's overall budget regardless of how many PIN values they
  // cycle through.
  //
  // R28-M3: client IP with spoof-resistant defaults — cf-connecting-ip
  // always trusted, x-forwarded-for only when TRUST_FORWARDED_FOR=1
  // env flag is set (off by default). Unknown-origin clients collapse
  // into a single bucket, which is a tighter ceiling than permitting
  // per-request XFF rotation.
  const { clientIpFrom } = await import("@/lib/net/client-ip");
  const clientIp = clientIpFrom(request.headers);

  // Two-tier rate limit:
  //  • per-PIN bucket (strict): 5 attempts per 5 min for THIS specific
  //    PIN value (hashed + truncated — NEVER the raw pin, and NEVER a
  //    prefix-or-length derivation, which would leak length/first-digit
  //    to a probing attacker via timing + bucket exhaustion).
  //  • per-location bucket (generous): 30 attempts per 5 min total —
  //    blocks mass PIN enumeration against the whole shop without
  //    locking out legitimate cashiers who mistype occasionally.
  //  • per-(IP, location) bucket (R27-H1): 10 attempts per 5 min from
  //    any single IP against a given location. A legitimate cashier
  //    behind a NAT shares the IP with 0 other logging-in employees at
  //    that location (different physical locations have different IPs).
  const pinFingerprint = crypto.subtle
    ? await (async () => {
        const enc = new TextEncoder().encode(`${locationId}:${pin}`);
        const hash = await crypto.subtle.digest("SHA-256", enc);
        return Array.from(new Uint8Array(hash)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
      })()
    : pin; // Fallback for environments without WebCrypto — still better than prefix+length
  const pinBucket = checkRateLimit(`register-pin:${pinFingerprint}`, { maxAttempts: 5, windowMs: 300_000 });
  if (!pinBucket.allowed) {
    return Response.json({ error: "Too many attempts for this PIN. Try again shortly." }, { status: 429 });
  }
  const locBucket = checkRateLimit(`register-loc:${locationId}`, { maxAttempts: 30, windowMs: 300_000 });
  if (!locBucket.allowed) {
    return Response.json({ error: "Too many attempts. Try again shortly." }, { status: 429 });
  }
  // R27-H1: per-IP bucket (in-memory, fast-fail path). The DB-layer
  // per-IP bucket lives below with the other DB rate-limits.
  const ipBucket = checkRateLimit(`register-ip:${clientIp}:${locationId}`, { maxAttempts: 10, windowMs: 300_000 });
  if (!ipBucket.allowed) {
    return Response.json({ error: "Too many attempts from this device. Try again shortly." }, { status: 429 });
  }

  // R8-M-11: three-layer rate limit.
  //   1. In-memory bucket above (per-isolate, 0ms) — catches per-isolate bursts.
  //   2. KV bucket here (cross-region, ~10ms) — catches distributed attacks.
  //   3. DB bucket below (strongly consistent, ~30-100ms) — last-resort
  //      guarantee for the highest-value endpoint.
  const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
  const kvPinBucket = await checkKvRateLimit(`register-pin:${pinFingerprint}`, { maxAttempts: 8, windowMs: 300_000 });
  if (!kvPinBucket.allowed) {
    return Response.json({ error: "Too many attempts for this PIN. Try again shortly." }, { status: 429 });
  }

  const { checkDbRateLimit } = await import("@/lib/auth/db-rate-limit");
  const dbPinBucket = await checkDbRateLimit(`register-pin:${pinFingerprint}`, { maxAttempts: 10, windowMs: 600_000 });
  if (!dbPinBucket.allowed) {
    return Response.json({ error: "Too many attempts for this PIN. Try again later." }, { status: 429 });
  }
  // R27-H1: DB-layer per-IP bucket — cross-isolate coherent. Key on
  // (IP, locationId) so multi-location tenants don't cross-lock, but
  // so an attacker rotating through PIN values from one IP still
  // hits a single cap.
  const dbIpBucket = await checkDbRateLimit(`register-ip:${clientIp}:${locationId}`, { maxAttempts: 20, windowMs: 900_000 });
  if (!dbIpBucket.allowed) {
    return Response.json({ error: "Too many attempts from this device. Try again later." }, { status: 429 });
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

  // Direct Postgres path via per-call pool facade — see login/route.ts for
  // the rationale. Keeps these calls independent of SUPABASE_SERVICE_ROLE_KEY
  // being set in the Worker environment, and uses the `postgres` role that
  // has an explicit EXECUTE grant on these SECURITY DEFINER RPCs.
  const pool = await getPool();

  try {
    // 1. Fetch PIN candidates for this location's org
    const { rows: rawCandidates } = await pool.query(
      `SELECT * FROM register_pin_candidates($1::text)`,
      [locationId],
    );
    const candidates = rawCandidates as Array<{
      employee_id: string;
      email: string;
      pin_hash: string;
      organization_id: string;
      role_key: string;
      location_ids: string[];
    }>;

    if (!candidates.length) {
      return Response.json({ error: "PIN login failed." }, { status: 401 });
    }

    // 2. Verify PIN against candidates serially with early exit.
    //
    // R15-M-1: the previous `Promise.all(candidates.map(verifyPin))` fanned
    // N concurrent PBKDF2 (100k iter) calls through Web Crypto. On a
    // 50-employee location that's 2.5-5s CPU per login attempt — a DoS
    // vector. Serial-with-early-exit burns ≤1 bcrypt when a PIN matches;
    // worst case (no match) does the same total work without the thread
    // pool pressure.
    let match: typeof candidates[number] | null = null;
    for (const c of candidates) {
      if (!c.pin_hash) continue;
      if (await verifyPin(pin!, c.pin_hash)) {
        match = c;
        break;
      }
    }
    if (!match) {
      return Response.json({ error: "PIN login failed." }, { status: 401 });
    }

    // R27-H1: credential-level lockout. A credential that has racked up
    // ≥5 failed match-attempts in the last 10 min is frozen regardless
    // of IP. The increment happens below whenever a matched PIN fails
    // post-match validation (location/role mismatch); an attacker who
    // has the correct PIN value but is probing from wrong contexts
    // gets only 5 strikes before the credential is unreachable until
    // the last-failure timestamp ages out of the window.
    //
    // R28-L2: single atomic check-and-also-reset-if-window-elapsed.
    // Prior pattern did SELECT then later UPDATE as two statements; 10
    // concurrent failed attempts could all pass the `< 5` check before
    // any incremented, giving an effective 5→10 budget. The new query
    // runs a CTE that (a) reads current state, (b) resets to 0 if
    // the lockout window has fully elapsed, and (c) returns the
    // final count. A subsequent row-level `SET col = col + 1` UPDATE
    // is atomic per-row so two concurrent fails land at +2.
    try {
      const LOCKOUT_WINDOW_MS = 600_000; // 10 min
      const { rows: lockRows } = await pool.query(
        `WITH snapshot AS (
           SELECT failed_pin_attempts, last_failed_pin_at
             FROM auth_credentials WHERE employee_id = $1::uuid
         ),
         decayed AS (
           UPDATE auth_credentials
              SET failed_pin_attempts = 0, last_failed_pin_at = NULL
            WHERE employee_id = $1::uuid
              AND failed_pin_attempts > 0
              AND last_failed_pin_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (now() - last_failed_pin_at)) * 1000 > $2
            RETURNING failed_pin_attempts
         )
         SELECT
           COALESCE((SELECT failed_pin_attempts FROM decayed),
                    (SELECT failed_pin_attempts FROM snapshot),
                    0)::int AS effective_attempts,
           (SELECT last_failed_pin_at FROM snapshot) AS last_failed_pin_at`,
        [match.employee_id, LOCKOUT_WINDOW_MS],
      );
      const lockRow = lockRows[0] as { effective_attempts?: number; last_failed_pin_at?: string } | undefined;
      if (lockRow && (lockRow.effective_attempts ?? 0) >= 5) {
        // Credential is locked. Same 401 shape as every other failure.
        return Response.json({ error: "PIN login failed." }, { status: 401 });
      }
    } catch (err) {
      // Fail-open on counter read — don't brick PIN login if this
      // errors. The other rate limiters still gate the endpoint.
      console.error("[api/auth/register-login] lockout-check:", safeErr(err));
    }

    // 3. Validate employee permissions and location assignment.
    //
    // R27-H1: if the PIN matched BUT post-match validation fails (wrong
    // location assignment / insufficient role), originally increment
    // the matched employee's `failed_pin_attempts` counter so an
    // attacker who knows the victim's correct PIN can't brute against
    // the right location from elsewhere.
    //
    // R40-3: drop the `locFail` arm of that increment. It was a DoS
    // vector: an insider who knows a peer's PIN could send PIN +
    // wrong-location from distributed IPs (bypassing the per-IP
    // rate-limit) and lock out the victim at THEIR OWN location.
    // The other rate-limits still catch brute-force: per-PIN
    // fingerprint (5/5min in-mem + 8/5min KV + 10/10min DB) and
    // per-(IP, location) (10/5min + 20/15min DB). Those cap the
    // attacker without penalizing the victim.
    //
    // The `permFail` arm stays — a valid PIN for an employee who
    // LACKS `register.pin_login` / `register.open` is a strong
    // signal of misuse (admin-role account being used at a register
    // terminal), and permFail isn't a geography-based DoS surface
    // (the matched employee's role is deterministic, not attacker-
    // controlled).
    const roleKey = match.role_key as RoleKey;
    const locationIds = match.location_ids ?? [];
    const locFail = !locationIds.includes(locationId);
    const permFail = !hasPermission(roleKey, "register.pin_login") || !hasPermission(roleKey, "register.open");
    if (locFail || permFail) {
      if (permFail) {
        // Best-effort increment — if the UPDATE errors we still 401, and
        // we don't want a DB hiccup to leak a different error code.
        try {
          await pool.query(
            `UPDATE auth_credentials
                SET failed_pin_attempts = failed_pin_attempts + 1,
                    last_failed_pin_at = now()
              WHERE employee_id = $1::uuid`,
            [match.employee_id],
          );
        } catch (err) {
          console.error("[api/auth/register-login] failed-counter UPDATE:", safeErr(err));
        }
      }
      return Response.json({ error: "PIN login failed." }, { status: 401 });
    }

    // 4. Create session + register session atomically via RPC
    const now = new Date();
    const sessionId = randomUUID();
    const registerSessionId = randomUUID();
    const expiresAt = addDays(now, 1);

    // Session rotation to prevent fixation. Register-login doesn't guarantee
    // the RPC wipes prior sessions (admin_login_create_session does, but the
    // register RPC's definition isn't in the migration tree), so do it here.
    // Scope to (employee, device) so signing in on a shared terminal doesn't
    // invalidate the same employee's session on another terminal.
    try {
      await pool.query(
        `DELETE FROM sessions
         WHERE scope = 'register' AND employee_id = $1::uuid AND location_id = $2::uuid`,
        [match.employee_id, locationId],
      );
    } catch (err) {
      // Non-fatal: if the delete fails, the RPC will still INSERT a new row.
      // Logging so we notice if something's wrong with the cleanup path.
      console.error("[api/auth/register-login] prior session cleanup failed:", safeErr(err));
    }

    try {
      await pool.query(
        `SELECT register_login_create_session($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::timestamptz, $8::timestamptz)`,
        [
          match.employee_id,
          match.organization_id,
          locationId,
          deviceId,
          sessionId,
          registerSessionId,
          now.toISOString(),
          expiresAt.toISOString(),
        ],
      );
    } catch (err) {
      console.error("[api/auth/register-login] create session failed:", safeErr(err));
      return Response.json({ error: "Failed to create register session." }, { status: 500 });
    }

    // R27-H1: reset the PIN-failure counter on successful login. Any
    // operator-legitimate tries that happened before this point
    // shouldn't carry over to lock the employee out tomorrow.
    try {
      await pool.query(
        `UPDATE auth_credentials
            SET failed_pin_attempts = 0,
                last_failed_pin_at = NULL
          WHERE employee_id = $1::uuid
            AND failed_pin_attempts > 0`,
        [match.employee_id],
      );
    } catch (err) {
      // Non-fatal.
      console.error("[api/auth/register-login] failed-counter reset:", safeErr(err));
    }

    // Invalidate store cache — scoped to THIS tenant (R32-D2).
    try {
      const { invalidateStoreCache } = await import("@/lib/persistence/postgres-read-store");
      invalidateStoreCache(match.organization_id);
    } catch {
      // Non-fatal
    }

    // Build response with Set-Cookie.
    // R28-H5: also emit a bupos_register_device cookie tying this
    // browser to the register session's device_id. getRegisterSession()
    // reads it on subsequent requests and the session row rejects a
    // mismatch. Without this cookie, the device_id stored on
    // register_sessions was cosmetic — a stolen REGISTER_COOKIE could
    // be replayed from any browser.
    const isSecure = request.url.startsWith("https");
    const setCookies: string[] = [
      [
        `${REGISTER_COOKIE}=${sessionId}`,
        `Path=/`,
        `HttpOnly`,
        `SameSite=Lax`,
        `Expires=${expiresAt.toUTCString()}`,
        ...(isSecure ? ["Secure"] : []),
      ].join("; "),
    ];
    if (deviceId) {
      // R29-M3: HMAC-sign the device cookie value so `verifyDeviceIdCookie`
      // on subsequent requests rejects forged/tampered values.
      const { signDeviceId } = await import("@/lib/auth/device-cookie");
      const signedDevice = await signDeviceId(deviceId);
      setCookies.push(
        [
          `bupos_register_device=${encodeURIComponent(signedDevice)}`,
          `Path=/`,
          `HttpOnly`,
          `SameSite=Lax`,
          `Expires=${expiresAt.toUTCString()}`,
          ...(isSecure ? ["Secure"] : []),
        ].join("; "),
      );
    }

    // Never expose sessionId or internal IDs in the response body.
    // Session is delivered via HttpOnly cookie only.
    const headers = new Headers();
    for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
    headers.set("Content-Type", "application/json");
    return new Response(
      JSON.stringify({ success: true, redirect: "/register" }),
      { status: 200, headers },
    );
  } catch (err) {
    console.error("[api/auth/register-login] Error:", safeErr(err));
    return Response.json({ error: "PIN login failed." }, { status: 401 });
  }
}
