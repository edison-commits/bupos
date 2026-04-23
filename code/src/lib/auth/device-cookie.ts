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
 * Formats (oldest to newest):
 *   v1: `${deviceId}.${base64url(hmacSha256(SECRET, deviceId) slice 16)}`
 *   v2: `v2.${deviceId}.${base64url(hmacSha256(SECRET, "bupos-device-cookie-v2\0" + deviceId))}`
 *
 * v2 upgrades over v1:
 *   - Full 32-byte tag (v1 was truncated to 16). Still far above the
 *     ~80-bit floor that's considered safe against forgery but aligns
 *     with "don't truncate without a reason" crypto hygiene.
 *   - Explicit scope prefix (`bupos-device-cookie-v2\0`) hard-binds
 *     the HMAC message to THIS purpose, so if any future caller reuses
 *     CUSTOMER_DISPLAY_SECRET for another signing task the outputs
 *     cannot collide even if the raw `deviceId` happens to look like
 *     the other caller's message.
 *   - Version prefix (`v2.`) lets us evolve the format again without
 *     requiring a secret rotation.
 *
 * Dual-verify: verifyDeviceIdCookie() accepts BOTH v1 and v2 during
 * the rollover window so live sessions with v1 cookies still validate.
 * Because login routes reset the cookie, v1 cookies age out naturally
 * within one day (register session TTL). Drop v1 acceptance after the
 * dual-read window closes.
 *
 * Secret: uses `CUSTOMER_DISPLAY_SECRET` — already required in prod and
 * already has a dev fallback. Reusing it avoids another env var knob.
 * The scope prefix in v2 makes cross-use with display-token payloads
 * structurally impossible even under pathological message collisions.
 */

const V2_PREFIX = "v2.";
const V2_SCOPE = "bupos-device-cookie-v2\0";

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

/**
 * Sign a deviceId for the Set-Cookie header. Always emits v2.
 */
export async function signDeviceId(deviceId: string): Promise<string> {
  const sig = await hmacSha256(getSecret(), V2_SCOPE + deviceId);
  return `${V2_PREFIX}${deviceId}.${base64urlEncode(sig)}`;
}

/**
 * Verify a signed cookie value and return the deviceId if the HMAC matches.
 *
 * Accepts both v2 (current) and v1 (legacy) formats. Returns null for
 * malformed, unsigned, or tampered values. Pre-R29-M3 unsigned values
 * also return null — callers MUST re-pair to get a signed cookie.
 *
 * R41-3: dual-verify window. v1 acceptance can be removed once the
 * rollover deploy has been live long enough that all in-flight v1
 * cookies have aged out (register session TTL = 1 day, so 48h is
 * sufficient).
 */
export async function verifyDeviceIdCookie(cookieValue: string): Promise<string | null> {
  try {
    // v2: `v2.{deviceId}.{fullTag}`
    if (cookieValue.startsWith(V2_PREFIX)) {
      const rest = cookieValue.slice(V2_PREFIX.length);
      const dot = rest.lastIndexOf(".");
      if (dot < 1) return null;
      const deviceId = rest.slice(0, dot);
      const sigB64 = rest.slice(dot + 1);
      if (!deviceId || !sigB64) return null;
      const expected = await hmacSha256(getSecret(), V2_SCOPE + deviceId);
      const provided = base64urlDecode(sigB64);
      if (!constantTimeEq(expected, provided)) return null;
      return deviceId;
    }

    // v1 (legacy): `{deviceId}.{tagSlice16}`
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
