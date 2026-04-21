/**
 * R29-M3: HMAC-signed wrapper around the `bupos_register_device` cookie
 * value.
 *
 * The cookie stores the register-session's paired device_id alongside
 * an HMAC tag. A request that sets the cookie with a forged device_id
 * (e.g. a browser with an XSS that can write cookies but not read
 * HttpOnly values, or an attacker who learned only the session_id)
 * fails verification here and `getRegisterSession()` falls through to
 * the fail-closed branch in `resolveSession`.
 *
 * Format: `${deviceId}.${base64url(hmacSha256(SECRET, deviceId) slice 16)}`.
 *
 * Secret: uses `CUSTOMER_DISPLAY_SECRET` — already required in prod and
 * already has a dev fallback. Reusing it avoids another env var knob.
 * The signed message differs from display-token payloads
 * (`deviceId` vs `registerSessionId.expiresAt`) so cross-use is
 * structurally impossible.
 */

const DEV_STATIC_FALLBACK =
  "bupos-dev-only-display-fallback-do-not-use-in-prod-32chars-min-length";

// R30-H8: any Workers runtime (staging, preview, canary) must refuse
// to boot without a real CUSTOMER_DISPLAY_SECRET. Prior shape gated
// the throw on `NODE_ENV === "production"`, but Cloudflare Workers
// builds don't necessarily set NODE_ENV correctly in every pipeline —
// a staging Worker built with NODE_ENV unset silently used the
// committed dev fallback, letting anyone who knew the deploy was
// "non-prod" mint valid HMAC-signed device cookies + pair them with
// stolen session_ids (bypassing R28-H5/R29-M3 entirely). The NEW
// gate is: if we're running on Workers (detected via globalThis),
// a weak/missing secret fails closed regardless of NODE_ENV. Local
// `next dev` still works with DEV_DISPLAY_SECRET or the static
// fallback because it runs in Node, not Workers.
function isWorkersRuntime(): boolean {
  // Cloudflare Workers exposes `caches.default` and `Navigator.userAgent === "Cloudflare-Workers"`.
  // Fall back to `navigator.userAgent` — safer than checking for absence of `process` (Next.js polyfills it).
  try {
    return typeof navigator !== "undefined" && /Cloudflare-Workers/i.test(navigator.userAgent ?? "");
  } catch {
    return false;
  }
}

function getSecret(): string {
  const fromEnv = process.env.CUSTOMER_DISPLAY_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (process.env.NODE_ENV === "production" || isWorkersRuntime()) {
    throw new Error(
      "CUSTOMER_DISPLAY_SECRET must be set (≥32 chars) on Workers / production for device-cookie signing",
    );
  }
  return process.env.DEV_DISPLAY_SECRET || DEV_STATIC_FALLBACK;
}

function base64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return new Uint8Array(sig);
}

function constantTimeEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Sign a deviceId for the Set-Cookie header. */
export async function signDeviceId(deviceId: string): Promise<string> {
  const sig = (await hmacSha256(getSecret(), deviceId)).slice(0, 16);
  return `${deviceId}.${base64urlEncode(sig)}`;
}

/**
 * Verify a signed cookie value and return the deviceId if the HMAC matches.
 * Returns null for malformed, unsigned, or tampered values. Legacy
 * (unsigned, pre-R29-M3) values also return null — callers MUST re-pair
 * to get a signed cookie. Because both cookies are reset on login, this
 * only affects sessions in-flight across the deploy; they're short-lived.
 */
export async function verifyDeviceIdCookie(cookieValue: string): Promise<string | null> {
  try {
    const dot = cookieValue.lastIndexOf(".");
    if (dot < 1) return null;
    const deviceId = cookieValue.slice(0, dot);
    const sigB64 = cookieValue.slice(dot + 1);
    if (!deviceId || !sigB64) return null;
    const expected = (await hmacSha256(getSecret(), deviceId)).slice(0, 16);
    const provided = base64urlDecode(sigB64);
    if (!constantTimeEq(expected, provided)) return null;
    return deviceId;
  } catch {
    return null;
  }
}
