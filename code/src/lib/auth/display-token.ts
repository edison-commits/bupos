import "server-only"; // SEC-AUDIT10: never bundle the HMAC signer into client code
/**
 * R8-H-4 closed: HMAC-signed short-lived tokens for the customer-display
 * device. Previously the display had to share browser state (cookie) with
 * the cashier terminal — a physically separate display (common retail
 * deployment) couldn't poll because the register-session cookie wasn't
 * available.
 *
 * Flow:
 *   1. POST /api/customer-display (from the cashier terminal, cookie-auth'd)
 *      responds with `displayToken` in addition to its normal 200.
 *   2. The cashier terminal passes the token to the display device (QR
 *      code on pairing, localStorage on iframe, postMessage if embedded).
 *   3. GET /api/customer-display?registerSessionId=X&displayToken=Y
 *      validates the HMAC + expiry in lieu of the cookie.
 *
 * Token shape: `${base64url(payload)}.${base64url(sig)}` where
 *   payload = `${registerSessionId}.${expiresAtEpochMs}`
 *   sig     = HMAC-SHA-256(secret, payload) truncated to 16 bytes
 *
 * Secret: `CUSTOMER_DISPLAY_SECRET` env var. Production bootstrap MUST
 * set this to a 32+ byte random value — absence is a fatal error in prod,
 * and in dev we derive a deterministic fallback from DATABASE_URL so
 * `npm run dev` works without setup.
 *
 * Rotation: every POST returns a fresh token with TTL = DISPLAY_TOKEN_TTL_MS.
 * The display should re-POST (or ask the cashier to pair again) when the
 * token is near expiry. Stale tokens fail validation cleanly.
 */

const TTL_MS = 15 * 60_000; // 15 minutes; display polls frequently

// R27-L3: dev fallback is no longer derived from DATABASE_URL.
// Deriving from the DB URL meant anyone who read `.env.local` (the
// committed-but-gitignored file containing the prod DB password)
// automatically obtained the customer-display-token signing secret
// too — one leak = two secrets gone. The replacement derives from
// a per-dev-machine random value stored in a session-scoped env
// var (DEV_DISPLAY_SECRET), or falls back to a static string that's
// explicitly NOT derived from any production credential.
//
// In prod the env var must be set; the throw below is unchanged.
const DEV_STATIC_FALLBACK =
  "bupos-dev-only-display-fallback-do-not-use-in-prod-32chars-min-length";

function isWorkersRuntime(): boolean {
  try {
    return typeof navigator !== "undefined" && /Cloudflare-Workers/i.test(navigator.userAgent ?? "");
  } catch {
    return false;
  }
}

function getSecret(): string {
  const fromEnv = process.env.CUSTOMER_DISPLAY_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  // R30-H8: fail closed on ANY Workers runtime (staging / preview /
  // canary builds may not set NODE_ENV=production), not just when
  // NODE_ENV === "production". Mirrors the device-cookie.ts hardening.
  if (process.env.NODE_ENV === "production" || isWorkersRuntime()) {
    throw new Error(
      "CUSTOMER_DISPLAY_SECRET must be set (≥32 chars) on Workers / production for customer-display device auth",
    );
  }
  // Dev fallback. Prefer a DEV_DISPLAY_SECRET the developer set
  // locally; otherwise a static string that's safe to commit because
  // it only works outside production (the throw above gates prod).
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
 * R42-J: HMAC message now has an explicit scope prefix
 * (`display-token-v1\0`) so `CUSTOMER_DISPLAY_SECRET` cannot produce
 * colliding HMACs across callsites. device-cookie.ts already uses this
 * pattern in its v2 format; display-token was the last outlier. Today
 * the two message shapes (register UUID + decimal epoch vs. device id)
 * can't collide by coincidence, but the hygiene rule is "hard-bind
 * every HMAC to its purpose" — a future third caller reusing the same
 * secret is one shape-overlap away from being able to forge / validate
 * across domains. Backward-compat: verifyDisplayToken accepts both
 * v0-unprefixed + v1-prefixed messages during a 15-minute rollover
 * (TTL_MS above). After one TTL window, v0 acceptance can be removed.
 */
const SCOPE_PREFIX = "display-token-v1\0";

/** Mint a short-lived HMAC-signed token for a register_session. */
export async function mintDisplayToken(registerSessionId: string): Promise<string> {
  const secret = getSecret();
  const expiresAt = Date.now() + TTL_MS;
  const payload = `${registerSessionId}.${expiresAt}`;
  const sigBytes = await hmacSha256(secret, SCOPE_PREFIX + payload);
  // 16-byte truncation — balances log/URL length against brute-force work.
  const sig = sigBytes.slice(0, 16);
  const payloadB64 = base64urlEncode(new TextEncoder().encode(payload));
  const sigB64 = base64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

export interface DisplayTokenClaims {
  registerSessionId: string;
  expiresAt: number;
}

/**
 * Verify a token. Returns claims on success, or null if invalid/expired.
 * Does NOT throw — caller handles null as 401.
 *
 * R21-H-5: always compute HMAC before the expiry check so the
 * external-observable timing doesn't leak expired-vs-invalid. Prior
 * ordering short-circuited on expired tokens before HMAC work, letting
 * an attacker probe `Date.now() > expiresAt` without the secret by
 * watching latency. Post-fix every well-formed token path takes
 * approximately the same time (one HMAC-SHA-256 + one base64url decode).
 * Malformed tokens still short-circuit early — that's a parse error,
 * not an expiry oracle.
 */
export async function verifyDisplayToken(token: string): Promise<DisplayTokenClaims | null> {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return null;

    const payloadBytes = base64urlDecode(payloadB64);
    const payload = new TextDecoder().decode(payloadBytes);
    const [registerSessionId, expiresAtStr] = payload.split(".");
    if (!registerSessionId || !expiresAtStr) return null;
    if (!/^[0-9a-f-]{36}$/i.test(registerSessionId)) return null;
    const expiresAt = Number(expiresAtStr);
    if (!Number.isFinite(expiresAt)) return null;

    // Compute HMAC FIRST, unconditionally. Both expired + non-expired
    // paths now do equivalent crypto work.
    //
    // R42-J: accept EITHER the v1 scope-prefixed HMAC OR the v0 legacy
    // (unprefixed) form, to carry in-flight tokens across the deploy.
    // Both computations run unconditionally so timing stays equal; the
    // boolean is the ORed result. One TTL window (15 min) is enough to
    // age out all v0 tokens — drop the v0 branch after that.
    const secret = getSecret();
    const expectedSigV1 = (await hmacSha256(secret, SCOPE_PREFIX + payload)).slice(0, 16);
    const expectedSigV0 = (await hmacSha256(secret, payload)).slice(0, 16);
    const providedSig = base64urlDecode(sigB64);
    const sigValid = constantTimeEq(expectedSigV1, providedSig)
      || constantTimeEq(expectedSigV0, providedSig);
    const notExpired = Date.now() <= expiresAt;

    // Single combined branch — no intermediate `if` that could leak via
    // branch predictors (nit) or, more importantly, via `return null`
    // happening at wildly different times for `expired && valid-sig` vs
    // `unexpired && invalid-sig`.
    if (!sigValid || !notExpired) return null;

    return { registerSessionId, expiresAt };
  } catch {
    return null;
  }
}
