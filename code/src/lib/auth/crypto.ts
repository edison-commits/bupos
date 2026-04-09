// H-07: scryptSync blocks the Worker thread. Migrate to Web Crypto API
// (crypto.subtle.deriveBits() with PBKDF2) for production Workers deployments.
// The sync version is kept for backward compatibility; use verifySecretAsync where possible.
import { randomBytes, scryptSync, timingSafeEqual, scrypt } from "node:crypto";

const KEY_LENGTH = 64;

export function hashSecret(secret: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(secret, salt, KEY_LENGTH).toString("hex");
  return `${salt}:${derived}`;
}

export function verifySecret(secret: string, encoded: string) {
  const [salt, stored] = encoded.split(":");

  if (!salt || !stored) {
    return false;
  }

  const derived = scryptSync(secret, salt, KEY_LENGTH);
  const storedBuffer = Buffer.from(stored, "hex");

  if (derived.length !== storedBuffer.length) {
    return false;
  }

  return timingSafeEqual(derived, storedBuffer);
}

/**
 * Async secret verification using Node.js thread pool (non-blocking).
 * Preferred over verifySecret in Workers / async contexts.
 */
export function verifySecretAsync(secret: string, encoded: string): Promise<boolean> {
  const [salt, stored] = encoded.split(":");
  if (!salt || !stored) return Promise.resolve(false);

  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_LENGTH, (err, derived) => {
      if (err) return reject(err);
      const storedBuffer = Buffer.from(stored, "hex");
      if (derived.length !== storedBuffer.length) return resolve(false);
      resolve(timingSafeEqual(derived, storedBuffer));
    });
  });
}
