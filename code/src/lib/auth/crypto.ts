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
