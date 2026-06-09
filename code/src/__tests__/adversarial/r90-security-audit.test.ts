/**
 * R90 / SEC-AUDIT10 — security-audit hardening.
 *
 *   PBKDF2 raised to 600k for passwords (OWASP 2023+) via a VERSIONED hash
 *   format, with a legacy fallback so existing credentials still verify (no
 *   mass lockout). PINs stay 100k by design (10k keyspace = iteration count
 *   is moot offline; avoids multi-candidate register-login DoS).
 *   pin_hash_prefix landmine removed. imageUrl rejects protocol-relative.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
// Reproduce the PRE-versioning hash format (`salt:derived`, 100k) so we can
// prove verifySecret still accepts credentials created before this change.
async function legacyHash(secret: string, iterations = 100_000): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, km, 64 * 8);
  return `${hex(salt)}:${hex(new Uint8Array(bits))}`;
}

describe("SEC-AUDIT10: versioned PBKDF2 with legacy fallback", () => {
  it("hashSecret produces the 600k versioned format and round-trips", async () => {
    const { hashSecret, verifySecret } = await import("@/lib/auth/crypto");
    const h = await hashSecret("correct horse battery staple");
    expect(h).toMatch(/^pbkdf2\$600000\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(await verifySecret("correct horse battery staple", h)).toBe(true);
    expect(await verifySecret("wrong password", h)).toBe(false);
  });

  it("hashPin uses the 100k versioned format and round-trips", async () => {
    const { hashPin, verifySecret } = await import("@/lib/auth/crypto");
    const h = await hashPin("4271");
    expect(h).toMatch(/^pbkdf2\$100000\$/);
    expect(await verifySecret("4271", h)).toBe(true);
    expect(await verifySecret("0000", h)).toBe(false);
  });

  it("LEGACY salt:derived hashes still verify — no mass lockout", async () => {
    const { verifySecret } = await import("@/lib/auth/crypto");
    const legacy = await legacyHash("existing-user-pw");
    expect(legacy).toMatch(/^[0-9a-f]+:[0-9a-f]+$/); // old format
    expect(await verifySecret("existing-user-pw", legacy)).toBe(true);
    expect(await verifySecret("nope", legacy)).toBe(false);
  });

  it("rejects a tampered hash claiming an absurd iteration count", async () => {
    const { verifySecret } = await import("@/lib/auth/crypto");
    // 10^9 iterations would be a CPU-exhaustion lever
    expect(await verifySecret("x", "pbkdf2$999999999$00$00")).toBe(false);
    expect(await verifySecret("x", "pbkdf2$notanumber$00$00")).toBe(false);
    expect(await verifySecret("x", "pbkdf2$600000$onlythreeparts")).toBe(false);
  });

  it("constants: passwords 600k, pins 100k, legacy 100k", () => {
    const src = read("src/lib/auth/crypto.ts");
    expect(src).toMatch(/PASSWORD_ITERATIONS = 600_000/);
    expect(src).toMatch(/PIN_ITERATIONS = 100_000/);
    expect(src).toMatch(/LEGACY_ITERATIONS = 100_000/);
    // decoy must run at password cost (timing equalization)
    expect(src).toMatch(/pbkdf2\$\$\{PASSWORD_ITERATIONS\}\$/);
  });
});

describe("SEC-AUDIT10: pin_hash_prefix landmine removed", () => {
  it("the reversible sha256(rawPin) prefilter is gone from the lookup", () => {
    const src = read("src/lib/persistence/postgres-store.ts");
    expect(src).not.toMatch(/createHash\("sha256"\)\.update\(pin\)/); // no raw-PIN hashing
    expect(src).not.toMatch(/ac\.pin_hash_prefix = \$/);              // no filter clause
  });
  it("migration 087 drops the column + index", () => {
    const src = read("supabase/migrations/087_drop_pin_hash_prefix.sql");
    expect(src).toMatch(/DROP INDEX IF EXISTS idx_auth_credentials_pin_prefix/);
    expect(src).toMatch(/DROP COLUMN IF EXISTS pin_hash_prefix/);
  });
});

describe("SEC-AUDIT10: smaller hardening", () => {
  it("imageUrl rejects protocol-relative //host", async () => {
    const { productCreateSchema } = await import("@/lib/validation/schemas");
    const base = { name: "X", category_id: "11111111-1111-4111-8111-111111111111" };
    expect(productCreateSchema.safeParse({ ...base, image_url: "//evil.com/x.png" }).success).toBe(false);
    expect(productCreateSchema.safeParse({ ...base, image_url: "/img/x.png" }).success).toBe(true);
    expect(productCreateSchema.safeParse({ ...base, image_url: "https://cdn.example.com/x.png" }).success).toBe(true);
  });
  it("token signers are server-only", () => {
    expect(read("src/lib/auth/device-cookie.ts")).toMatch(/^import "server-only";/m);
    expect(read("src/lib/auth/display-token.ts")).toMatch(/^import "server-only";/m);
  });
});
