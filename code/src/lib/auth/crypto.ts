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

async function deriveKey(secret: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const derived = await deriveKey(secret, salt);
  return `${uint8ArrayToHex(salt)}:${uint8ArrayToHex(derived)}`;
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  const [saltHex, storedHex] = encoded.split(":");
  if (!saltHex || !storedHex) return false;

  const salt = hexToUint8Array(saltHex);
  const stored = hexToUint8Array(storedHex);
  const derived = await deriveKey(secret, salt);

  return timingSafeEqual(derived, stored);
}

/**
 * Async secret verification — same as verifySecret (both are async now).
 * Kept for API compatibility.
 */
export async function verifySecretAsync(secret: string, encoded: string): Promise<boolean> {
  return verifySecret(secret, encoded);
}
