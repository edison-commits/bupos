// Edge-compatible crypto using Web Crypto API (PBKDF2).
// No Node.js built-ins — works on Cloudflare Workers.

const KEY_LENGTH = 64;
const PBKDF2_ITERATIONS = 100_000;

function hexToUint8Array(hex: string): Uint8Array {
  const matches = hex.match(/.{1,2}/g);
  return new Uint8Array(matches ? matches.map((b) => parseInt(b, 16)) : []);
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * R32-D3: hex-encoded SHA-256 of an input string. Used to hash
 * verification/reset tokens at rest so a DB read doesn't yield
 * working account-takeover links.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return uint8ArrayToHex(new Uint8Array(digest));
}

function getSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

async function deriveKey(secret: string, salt: Uint8Array): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = getSalt();
  const derived = await deriveKey(secret, salt);
  return `${uint8ArrayToHex(salt)}:${uint8ArrayToHex(derived)}`;
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  const colonIndex = encoded.indexOf(":");
  if (colonIndex === -1) return false;
  const saltHex = encoded.slice(0, colonIndex);
  const storedHex = encoded.slice(colonIndex + 1);
  if (!saltHex || !storedHex) return false;

  const salt = hexToUint8Array(saltHex);
  const derived = await deriveKey(secret, salt);
  const stored = hexToUint8Array(storedHex);
  return timingSafeEqual(derived, stored);
}

// Alias for clarity — same function, async-only
export const verifySecretAsync = verifySecret;

// R27-M1: decoy hash for constant-time login. `verifySecret` is
// ~100ms (PBKDF2 100 000 iterations). When the caller wants to keep
// the endpoint's response time indistinguishable between "email
// exists" and "email doesn't exist", they must run the SAME work
// on the miss branch. `runDecoyVerify(password)` runs PBKDF2 against
// a fixed decoy hash and discards the result. The hash is constant
// across restarts so the SAME password always produces the SAME
// wall-clock time — which is what we want for indistinguishability
// (an attacker can't time-oracle "is this email registered?"
// because the PBKDF2 work runs regardless).
//
// The decoy salt + hash were generated with hashSecret("decoy") at
// the time this file was authored. They're baked in as literals
// below — not secret; the whole point is that this hash exists and
// can be "verified" against any password to burn PBKDF2 CPU.
const DECOY_HASH =
  "00112233445566778899aabbccddeeff" +
  ":" +
  // PBKDF2(SHA-256, "decoy", salt=<above>, iter=100000, keyLen=64).
  // NOT a real credential — this is a random constant whose ONLY
  // purpose is to be a non-null, well-formed target for
  // `verifySecret(password, DECOY_HASH)`.
  "deadbeef".repeat(16);

export async function runDecoyVerify(password: string): Promise<void> {
  // Parse + derive exactly like verifySecret, but throw away the
  // comparison result. Errors (including encoding surprises) are
  // silently caught so the decoy path can never produce a
  // user-visible error that would itself be a side-channel.
  try {
    await verifySecret(password, DECOY_HASH);
  } catch {
    // Swallow — decoy verify is purely for wall-clock equalization.
  }
}
