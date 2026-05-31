/**
 * AUTH-AUDIT6-HIGH1: shared PIN-login rate-limit gate.
 *
 * Background. There are TWO entry points for register PIN login:
 *   1. `POST /api/auth/register-login` (the HTTP route) — historically
 *      carried the full 6-layer defense (in-mem per-PIN / per-location /
 *      per-IP, KV per-PIN, DB per-PIN, DB per-IP) plus a credential-level
 *      `failed_pin_attempts` lockout.
 *   2. `registerLoginAction` Server Action (src/app/register/actions.ts) —
 *      the path the production PIN pad actually submits to
 *      (`register/page.tsx` → `<form action={registerLoginAction}>`).
 *
 * Until round 6 the Server Action only ran the TWO in-memory buckets and
 * skipped the KV + DB + per-IP layers entirely. The in-memory limiter is
 * per-isolate (see rate-limit.ts); Cloudflare spreads requests across
 * ~32 isolates per colo, so on the path users actually hit, the per-PIN
 * cap degraded from a globally-coherent ~13/5min (5/30min absolute) down
 * to ~5 × 32 ≈ 160 attempts / 5 min per PIN fingerprint with NO
 * cross-isolate backstop and NO per-IP cap. For 4-digit cashier PINs
 * that is the difference between ~167h and a few hours of brute force.
 *
 * The fix is this single source of truth. Both the HTTP route and the
 * Server Action (registerLoginAction + quickSwitchAction) call
 * `enforceRegisterPinRateLimits` so the defense can never drift between
 * the two paths again. The credential-level `failed_pin_attempts`
 * lockout stays inline in the HTTP route because it is post-match
 * (it needs the resolved employee_id); the pre-verification rate-limit
 * stack — which is what the HIGH finding was about — lives here.
 */

import { checkRateLimit } from "@/lib/auth/rate-limit";
import { logRateLimited } from "@/lib/logging/rate-limit-log";

export interface RegisterPinRateLimitResult {
  allowed: boolean;
  /** User-facing message for the tripped layer (already phrased per bucket). */
  message?: string;
  /** Milliseconds until the tripped bucket frees up (best-effort). */
  retryAfterMs?: number;
}

/**
 * SHA-256 fingerprint of `${locationId}:${pin}`, first 8 bytes hex.
 *
 * R16-M-4: NEVER key a bucket on the raw PIN or a prefix/length
 * derivation — that leaks the PIN's first digit + length to a probing
 * attacker via bucket-exhaustion timing. The fingerprint is a stable,
 * opaque per-(location,pin) key. Falls back to the raw pin only in
 * environments without WebCrypto (still better than prefix+length).
 */
async function pinFingerprintOf(locationId: string, pin: string): Promise<string> {
  if (!crypto.subtle) return pin;
  const enc = new TextEncoder().encode(`${locationId}:${pin}`);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Run the full pre-verification PIN-login rate-limit stack. Returns
 * `{ allowed: true }` to proceed, or `{ allowed: false, message,
 * retryAfterMs }` on the first tripped layer. Telemetry (`logRateLimited`)
 * is emitted internally per denial so every entry point reports
 * consistently to Logpush/Axiom.
 *
 * Layer order (fastest → strongest), mirroring the original HTTP route:
 *   1. in-mem per-PIN          5 / 5 min   (per-isolate burst)
 *   2. in-mem per-location    30 / 5 min   (whole-shop enumeration)
 *   3. in-mem per-(IP,loc)    10 / 5 min   (single-device burst)
 *   4. KV per-PIN              8 / 5 min   (cross-region coherence)
 *   5. DB per-PIN             5 / 30 min   (strongly-consistent absolute)
 *   6. DB per-(IP,loc)       20 / 15 min   (strongly-consistent per device)
 */
export async function enforceRegisterPinRateLimits(opts: {
  pin: string;
  locationId: string;
  clientIp: string;
}): Promise<RegisterPinRateLimitResult> {
  const { pin, locationId, clientIp } = opts;
  const fingerprint = await pinFingerprintOf(locationId, pin);

  // 1. in-memory per-PIN
  const memPin = checkRateLimit(`register-pin:${fingerprint}`, { maxAttempts: 5, windowMs: 300_000 });
  if (!memPin.allowed) {
    logRateLimited({ bucket: "register-pin", layer: "mem", actor: fingerprint.slice(0, 6) });
    return { allowed: false, message: "Too many attempts for this PIN. Try again shortly.", retryAfterMs: memPin.retryAfterMs };
  }

  // 2. in-memory per-location
  const memLoc = checkRateLimit(`register-loc:${locationId}`, { maxAttempts: 30, windowMs: 300_000 });
  if (!memLoc.allowed) {
    logRateLimited({ bucket: "register-loc", layer: "mem", actor: locationId.slice(0, 8) });
    return { allowed: false, message: "Too many login attempts. Try again shortly.", retryAfterMs: memLoc.retryAfterMs };
  }

  // 3. in-memory per-(IP, location)
  const memIp = checkRateLimit(`register-ip:${clientIp}:${locationId}`, { maxAttempts: 10, windowMs: 300_000 });
  if (!memIp.allowed) {
    logRateLimited({ bucket: "register-ip", layer: "mem", actor: `${clientIp}|${locationId.slice(0, 8)}` });
    return { allowed: false, message: "Too many attempts from this device. Try again shortly.", retryAfterMs: memIp.retryAfterMs };
  }

  // 4. KV per-PIN (cross-region). Fail-open on KV error — the mem layer
  //    above and the DB layers below still gate.
  try {
    const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
    const kvPin = await checkKvRateLimit(`register-pin:${fingerprint}`, { maxAttempts: 8, windowMs: 300_000 });
    if (!kvPin.allowed) {
      logRateLimited({ bucket: "register-pin", layer: "kv", actor: fingerprint.slice(0, 6) });
      return { allowed: false, message: "Too many attempts for this PIN. Try again shortly.", retryAfterMs: kvPin.retryAfterMs };
    }
  } catch {
    // KV unavailable — continue to the DB layer.
  }

  // 5 + 6. DB layers (strongly consistent). Fail-open on DB error.
  try {
    const { checkDbRateLimit } = await import("@/lib/auth/db-rate-limit");
    // AUTH-MED4: 5/30min absolute per-PIN cap (see route history).
    const dbPin = await checkDbRateLimit(`register-pin:${fingerprint}`, { maxAttempts: 5, windowMs: 1_800_000 });
    if (!dbPin.allowed) {
      logRateLimited({ bucket: "register-pin", layer: "db", actor: fingerprint.slice(0, 6) });
      return { allowed: false, message: "Too many attempts for this PIN. Try again later.", retryAfterMs: dbPin.retryAfterMs };
    }
    const dbIp = await checkDbRateLimit(`register-ip:${clientIp}:${locationId}`, { maxAttempts: 20, windowMs: 900_000 });
    if (!dbIp.allowed) {
      logRateLimited({ bucket: "register-ip", layer: "db", actor: `${clientIp}|${locationId.slice(0, 8)}` });
      return { allowed: false, message: "Too many attempts from this device. Try again later.", retryAfterMs: dbIp.retryAfterMs };
    }
  } catch {
    // DB rate-limit unavailable — the mem + KV layers above still gate.
  }

  return { allowed: true };
}
