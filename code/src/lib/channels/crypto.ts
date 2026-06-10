import "server-only"; // never bundle the channel-secret cipher into client code
/**
 * AES-256-GCM encryption for per-tenant sales-channel secrets (Shopify Admin
 * token + webhook signing secret) stored in `channel_integrations`.
 *
 * The app has no DB encryption at rest; a Shopify Admin token can read/write a
 * merchant's whole store, so we encrypt it under a Worker-level key
 * `CHANNEL_ENC_KEY` (separate from CUSTOMER_DISPLAY_SECRET — key separation).
 * The key is read with the same FAIL-CLOSED pattern as device-cookie.ts: on
 * Workers/production a missing/weak key throws (no silent dev fallback), so a
 * misconfigured deploy can't write/read tokens with a guessable key.
 *
 * Wire format: `gcm1.<base64url(iv ‖ ciphertext+tag)>` (iv = 12 random bytes).
 */

const ENC_VERSION = "gcm1.";

const DEV_STATIC_FALLBACK =
  "bupos-dev-only-channel-enc-fallback-do-not-use-in-prod-32chars-min-length";

function isWorkersRuntime(): boolean {
  try {
    return typeof navigator !== "undefined" && /Cloudflare-Workers/i.test(navigator.userAgent ?? "");
  } catch {
    return false;
  }
}

function getEncSecret(): string {
  const fromEnv = process.env.CHANNEL_ENC_KEY;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (process.env.NODE_ENV === "production" || isWorkersRuntime()) {
    throw new Error(
      "CHANNEL_ENC_KEY must be set (≥32 chars) on Workers / production to encrypt sales-channel secrets",
    );
  }
  return process.env.DEV_CHANNEL_ENC_KEY || DEV_STATIC_FALLBACK;
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
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

/** Derive a stable 32-byte AES-256 key from the (≥32-char) secret string. */
async function importAesKey(): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(getEncSecret()));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a plaintext secret to the wire format. */
export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await importAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const ct = new Uint8Array(ctBuf);
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return ENC_VERSION + base64urlEncode(combined);
}

/** Decrypt a wire-format secret. Returns null on any tamper/format/key error. */
export async function decryptSecret(encoded: string | null | undefined): Promise<string | null> {
  if (!encoded || !encoded.startsWith(ENC_VERSION)) return null;
  try {
    const combined = base64urlDecode(encoded.slice(ENC_VERSION.length));
    if (combined.length < 13) return null; // 12-byte iv + at least 1 byte
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    const key = await importAesKey();
    const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct as BufferSource);
    return new TextDecoder().decode(ptBuf);
  } catch {
    return null;
  }
}
