// Edge-compatible crypto using Web Crypto API (PBKDF2).
// No Node.js built-ins — works on Cloudflare Workers.

const KEY_LENGTH = 64;
// SEC-AUDIT10: PBKDF2-SHA256 iteration counts.
//  - PASSWORD_ITERATIONS: OWASP 2023+ baseline (>=600k). Admin passwords are
//    min-12-char/high-entropy, and password login verifies ONE candidate, so
//    the cost lands only on the rare login path.
//  - PIN_ITERATIONS: a 4-digit PIN has a 10k keyspace — NO iteration count
//    meaningfully resists offline brute of a leaked PIN hash, so the real
//    controls are DB security + online rate-limiting. Register login verifies
//    up to N location-employee candidates serially, so raising this would
//    multiply CPU (a DoS lever) for no offline gain. Kept at 100k by design.
//  - LEGACY_ITERATIONS: pre-versioned `salt:derived` hashes were all 100k.
//    verifySecret falls back to this so EXISTING credentials keep working
//    (no mass lockout); they upgrade to the versioned format on next rotation.
const PASSWORD_ITERATIONS = 600_000;
const PIN_ITERATIONS = 100_000;
const LEGACY_ITERATIONS = 100_000;

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

async function deriveKey(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
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
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Hash a secret. Default = PASSWORD_ITERATIONS. PIN callers should use
 * `hashPin` (PIN_ITERATIONS). Output is the SEC-AUDIT10 versioned format
 * `pbkdf2$<iterations>$<saltHex>$<derivedHex>` so verifySecret can use the
 * exact count the hash was created with — letting us raise the cost over
 * time without re-hashing existing rows.
 */
export async function hashSecret(secret: string, iterations: number = PASSWORD_ITERATIONS): Promise<string> {
  const salt = getSalt();
  const derived = await deriveKey(secret, salt, iterations);
  return `pbkdf2$${iterations}$${uint8ArrayToHex(salt)}$${uint8ArrayToHex(derived)}`;
}

/** Hash a low-entropy PIN at PIN_ITERATIONS — see the constant's rationale. */
export async function hashPin(pin: string): Promise<string> {
  return hashSecret(pin, PIN_ITERATIONS);
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  // SEC-AUDIT10 versioned format: pbkdf2$<iterations>$<saltHex>$<derivedHex>
  if (encoded.startsWith("pbkdf2$")) {
    const parts = encoded.split("$");
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    // Bound the count: reject absurd values (a tampered hash claiming 10^9
    // iterations would be a CPU-exhaustion lever).
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
    const salt = hexToUint8Array(parts[2]);
    const stored = hexToUint8Array(parts[3]);
    if (!salt.length || !stored.length) return false;
    const derived = await deriveKey(secret, salt, iterations);
    return timingSafeEqual(derived, stored);
  }

  // Legacy unversioned format `<saltHex>:<derivedHex>` — all created at
  // LEGACY_ITERATIONS (100k). Kept so existing credentials still verify;
  // they re-hash to the versioned format on the next password/PIN change.
  const colonIndex = encoded.indexOf(":");
  if (colonIndex === -1) return false;
  const saltHex = encoded.slice(0, colonIndex);
  const storedHex = encoded.slice(colonIndex + 1);
  if (!saltHex || !storedHex) return false;

  const salt = hexToUint8Array(saltHex);
  const derived = await deriveKey(secret, salt, LEGACY_ITERATIONS);
  const stored = hexToUint8Array(storedHex);
  return timingSafeEqual(derived, stored);
}

// Alias for clarity — same function, async-only
export const verifySecretAsync = verifySecret;

// R27-M1: decoy hash for constant-time login. When the caller wants the
// endpoint's response time indistinguishable between "email exists" and
// "email doesn't exist", they must run the SAME PBKDF2 work on the miss
// branch. `runDecoyVerify(password)` verifies against a fixed decoy hash and
// discards the result, so an attacker can't time-oracle "is this email
// registered?".
//
// SEC-AUDIT10: the decoy MUST run at PASSWORD_ITERATIONS so its cost matches
// a real password verify (which now uses the 600k versioned format) — a 100k
// decoy vs a 600k real verify would reopen the timing oracle. Hence the
// versioned `pbkdf2$600000$...` literal below. The derived value is arbitrary
// (deadbeef…) — its only job is to be a well-formed target that forces the
// full PBKDF2 then mismatches. Not a real credential.
const DECOY_HASH =
  `pbkdf2$${PASSWORD_ITERATIONS}$` +
  "00112233445566778899aabbccddeeff" +
  "$" +
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
