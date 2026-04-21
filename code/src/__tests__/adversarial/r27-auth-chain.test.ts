/**
 * R27 regression: attack-chain B (auth-side) sweep.
 *
 * Background: R27's auth audit identified a realistic tenant-takeover
 * path from one compromised cashier:
 *   1. Anon visitor to /register leaks a live locationId via the
 *      `get_default_active_location` anon-callable RPC. (M6)
 *   2. With that locationId, attacker brute-forces PINs at
 *      /api/auth/register-login. The existing rate limits are all
 *      IP-independent, so a single IP gets ~33min to first manager
 *      match. (H1)
 *   3. Once matched, the manager-PIN register session passes through
 *      `withDualAuth` to reach ~24 admin-permission endpoints
 *      (settings, products, promo-codes, purchase-orders, etc.),
 *      unlocking tenant-level damage. (H2)
 *   4. The legitimate owner has NO password-change / password-reset
 *      flow to recover — only direct DB access. (M3)
 *
 * Adjacent findings:
 *   • admin /login is a timing oracle for email enumeration (M1)
 *   • admin session lifetime is unbounded within 7-day window (M2)
 *   • /api and loginAction use DIFFERENT rate-limit buckets for the
 *     same brute-force target (M5)
 *
 * This test file pins the fixes with static-code assertions (no
 * integration level — that would need a real Postgres + 2 tenants).
 * The guardrail tests below prevent "refactor-reverts".
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("R27 attack-chain B regression: auth-path hardening", () => {
  describe("H1 — PIN brute-force lockout", () => {
    const src = read("src/app/api/auth/register-login/route.ts");

    it("derives a client IP from cf-connecting-ip / x-forwarded-for", () => {
      // Without a client IP, the per-IP bucket is trivially defeated.
      expect(src).toMatch(/cf-connecting-ip/i);
      expect(src).toMatch(/x-forwarded-for/i);
    });

    it("adds a per-(IP, location) in-memory rate limit bucket", () => {
      expect(src).toMatch(/register-ip:\$\{clientIp\}:\$\{locationId\}/);
    });

    it("adds a per-(IP, location) DB-layer rate limit bucket", () => {
      // Cross-isolate coherence — a Workers colo has ~32 isolates.
      // Without the DB layer the in-memory bucket gives the attacker
      // ~32× the budget across isolates.
      expect(src).toMatch(/checkDbRateLimit\([^)]*register-ip:/);
    });

    it("increments failed_pin_attempts on post-match validation fail", () => {
      // An attacker who has the CORRECT PIN but is probing from the
      // wrong IP / location / role combination would otherwise get
      // unlimited tries. The counter converts that into a finite
      // attack budget.
      expect(src).toMatch(/UPDATE auth_credentials[\s\S]*?failed_pin_attempts = failed_pin_attempts \+ 1/);
    });

    it("resets failed_pin_attempts on successful login", () => {
      expect(src).toMatch(/UPDATE auth_credentials[\s\S]*?failed_pin_attempts = 0,\s*last_failed_pin_at = NULL/);
    });

    it("checks current lockout state before minting a session", () => {
      // If the credential is locked, we must short-circuit BEFORE the
      // session-create RPC fires.
      expect(src).toMatch(/SELECT failed_pin_attempts, last_failed_pin_at/);
      expect(src).toMatch(/LOCKOUT_WINDOW_MS = 600_000/);
    });

    it("enforces 6-digit PINs for owner/manager at employee creation", () => {
      const empSrc = read("src/app/api/employees/route.ts");
      expect(empSrc).toMatch(
        /roleKey === 'owner' \|\| roleKey === 'manager'[\s\S]*?pin\.length < 6/,
      );
    });

    it("enforces 6-digit PINs for owner/manager on PIN reset", () => {
      const empSrc = read("src/app/api/employees/route.ts");
      expect(empSrc).toMatch(
        /targetRole === 'owner' \|\| targetRole === 'manager'[\s\S]*?pin\.length < 6/,
      );
    });

    it("resets lockout counter when an admin rotates a PIN", () => {
      const empSrc = read("src/app/api/employees/route.ts");
      // The UPDATE should ALSO zero failed_pin_attempts, otherwise a
      // locked-out employee stays locked after the admin resets their PIN.
      expect(empSrc).toMatch(
        /UPDATE auth_credentials[\s\S]*?pin_hash = \$1[\s\S]*?failed_pin_attempts = 0,\s*last_failed_pin_at = NULL/,
      );
    });
  });

  describe("H2 — withDualAuth admin-only endpoint downgrade", () => {
    const forAdminOnly: Array<[string, string[]]> = [
      ["src/app/api/products/route.ts", ["POST", "PUT", "PATCH", "DELETE"]],
      ["src/app/api/purchase-orders/route.ts", ["POST", "PUT", "PATCH"]],
      ["src/app/api/expenses/route.ts", ["POST", "DELETE"]],
      ["src/app/api/receiving/route.ts", ["POST"]],
    ];

    for (const [file, methods] of forAdminOnly) {
      for (const m of methods) {
        it(`${file} ${m} uses withAdminAuth (not withDualAuth)`, () => {
          const src = read(file);
          // Regex: `export const <METHOD> = withAdminAuth(`
          const rx = new RegExp(`export\\s+const\\s+${m}\\s*=\\s*withAdminAuth\\(`);
          expect(src).toMatch(rx);
          // Negative: the SAME method should NOT be wrapped by withDualAuth
          const badRx = new RegExp(`export\\s+const\\s+${m}\\s*=\\s*withDualAuth\\(`);
          expect(src).not.toMatch(badRx);
        });
      }
    }
  });

  describe("M1 — constant-time admin login", () => {
    const src = read("src/app/api/auth/login/route.ts");
    const cryptoSrc = read("src/lib/auth/crypto.ts");

    it("runs decoy PBKDF2 on the email-miss branch", () => {
      // Without this, an attacker times the 401 response and
      // distinguishes "email exists" (PBKDF2 runs, ~100ms) from
      // "email doesn't exist" (short-circuit, <10ms).
      expect(src).toMatch(/runDecoyVerify/);
    });

    it("decoy verify runs the same PBKDF2 cost as the real path", () => {
      // The decoy MUST parse like a real hash + call verifySecret
      // so the CPU cost is equal.
      expect(cryptoSrc).toMatch(/runDecoyVerify/);
      expect(cryptoSrc).toMatch(/verifySecret\(password, DECOY_HASH\)/);
    });
  });

  describe("M2 — absolute admin session lifetime", () => {
    const src = read("src/lib/auth/session.ts");

    it("has an absolute-lifetime check separate from idle-timeout", () => {
      // Idle timeout slides with lastSeenAt; absolute lifetime bounds
      // createdAt so a stolen cookie can't be kept alive indefinitely.
      expect(src).toMatch(/ADMIN_ABSOLUTE_LIFETIME_MS/);
      expect(src).toMatch(/session\.createdAt/);
    });
  });

  describe("M5 — unified admin-login rate-limit buckets", () => {
    const src = read("src/app/actions/auth.ts");

    it("loginAction uses the same namespaced bucket as /api/auth/login", () => {
      // Prior: `checkRateLimit(email)` (plain) vs API's `admin-login:${email}`.
      // After: both use `admin-login:${email}`.
      expect(src).toMatch(/checkRateLimit\([^)]*admin-login:\$\{email\}/);
    });

    it("loginAction also layers the KV rate limiter", () => {
      // Without KV, the server-action entry point was per-isolate only,
      // doubling the attacker's cross-isolate budget.
      expect(src).toMatch(/checkKvRateLimit\([^)]*admin-login:\$\{email\}/);
    });
  });

  describe("M6 — no anon locationId leak", () => {
    it("/register/page.tsx uses direct pool lookup (not anon RPC)", () => {
      const src = read("src/app/register/page.tsx");
      // The old code hit the anon RPC via fetch with the anon key.
      expect(src).not.toMatch(/rpc\/get_default_active_location/);
      // The new code picks the location via a direct SQL query.
      expect(src).toMatch(/FROM locations l/);
    });

    it("migration 055 revokes the anon grant on get_default_active_location", () => {
      const src = read("supabase/migrations/055_r27_m6_revoke_default_location_anon.sql");
      expect(src).toMatch(/REVOKE EXECUTE ON FUNCTION public\.get_default_active_location/);
      expect(src).toMatch(/FROM anon, authenticated/);
    });
  });

  describe("M3 — password recovery + session revocation routes exist", () => {
    it("/api/auth/password-change requires re-auth + kills all admin sessions", () => {
      const src = read("src/app/api/auth/password-change/route.ts");
      // Re-auth check.
      expect(src).toMatch(/verifySecret\(currentPassword, currentHash\)/);
      // All admin sessions killed on success.
      expect(src).toMatch(
        /DELETE FROM sessions WHERE scope = 'admin' AND employee_id = \$1/,
      );
    });

    it("/api/auth/password-reset-initiate always returns 200 (no email oracle)", () => {
      // An "exists / doesn't exist" distinction here would be a user-
      // enumeration oracle worse than the M1 timing one.
      const src = read("src/app/api/auth/password-reset-initiate/route.ts");
      // Every return in the happy-path branches must be { ok: true }.
      expect(src).toMatch(/NextResponse\.json\(\{ ok: true \}\)/);
      // Should NOT return a 404 / 401 on unknown email.
      expect(src).not.toMatch(/status:\s*404[\s\S]*email/i);
    });

    it("/api/auth/password-reset-confirm atomically consumes token + rotates + kills sessions", () => {
      const src = read("src/app/api/auth/password-reset-confirm/route.ts");
      // Token consumed via DELETE-RETURNING (idempotent + atomic).
      expect(src).toMatch(/DELETE FROM password_resets[\s\S]*?RETURNING/);
      // Password rotated.
      expect(src).toMatch(/UPDATE auth_credentials[\s\S]*?SET password_hash/);
      // Sessions killed.
      expect(src).toMatch(
        /DELETE FROM sessions WHERE scope = 'admin' AND employee_id = \$1/,
      );
    });

    it("/api/auth/revoke-all-sessions requires admin session + checkOrigin + clears cookie", () => {
      const src = read("src/app/api/auth/revoke-all-sessions/route.ts");
      expect(src).toMatch(/getAdminSession/);
      expect(src).toMatch(/checkOrigin\(req\)/);
      // Cookie cleared via Expires in the past.
      expect(src).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it("migration 056 creates the password_resets table", () => {
      const src = read("supabase/migrations/056_r27_m3_password_resets.sql");
      expect(src).toMatch(/CREATE TABLE IF NOT EXISTS password_resets/);
      expect(src).toMatch(/uniq_password_resets_token/);
      expect(src).toMatch(/ENABLE ROW LEVEL SECURITY/);
      expect(src).toMatch(/FORCE ROW LEVEL SECURITY/);
    });
  });

  describe("M4 — employees.email ↔ auth_credentials.email sync on PUT", () => {
    const src = read("src/app/api/employees/route.ts");

    it("PUT updates auth_credentials.email when employees.email changes", () => {
      // Without this, the login-email becomes frozen at signup.
      expect(src).toMatch(
        /UPDATE auth_credentials[\s\S]*?SET email = \$1[\s\S]*?WHERE employee_id = \$2/,
      );
    });

    it("rolls back on 23505 (login-email already taken)", () => {
      expect(src).toMatch(/code === '23505'/);
      expect(src).toMatch(/already registered to another account/);
    });

    it("kills sessions on email change so the old email can't re-authenticate", () => {
      expect(src).toMatch(/if \(email !== undefined\) \{[\s\S]*?invalidateEmployeeSessions/);
    });
  });
});
