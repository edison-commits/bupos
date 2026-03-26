import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
