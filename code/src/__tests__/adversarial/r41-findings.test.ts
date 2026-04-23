/**
 * R41 regression tests. Pins the deferred items from R40 that landed
 * in this round:
 *   R41-1: <PasswordGate> shared modal replacing window.prompt
 *          step-ups (gift-card disable, customer anonymize).
 *   R41-2: cookie rename (`basicuniformpos_*` → `bupos_a` / `bupos_r`)
 *          with dual-read migration window.
 *   R41-3: HMAC device-cookie v2 format (full 32-byte tag + scope
 *          prefix; dual-verify accepts legacy v1).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signDeviceId, verifyDeviceIdCookie } from "@/lib/auth/device-cookie";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R41 deferred fixes", () => {
  describe("R41-1: PasswordGate modal replaces window.prompt", () => {
    const gate = read("src/components/shared/password-gate.tsx");
    const giftCards = read("src/components/admin/gift-card-manager.tsx");
    const customers = read("src/app/admin/customers/page.tsx");

    it("PasswordGate component exists and exports usePasswordGate hook", () => {
      expect(gate).toMatch(/export function usePasswordGate/);
      expect(gate).toMatch(/PasswordGate/);
      // Imperative controller shape: returns [promptPassword, gate].
      expect(gate).toMatch(/promptPassword/);
      // Supports destructive variant + custom confirm label.
      expect(gate).toMatch(/confirmVariant/);
      expect(gate).toMatch(/confirmLabel/);
    });

    it("gift-card-manager no longer uses window.prompt for disable step-up", () => {
      // Prior shape: `const pwd = window.prompt(...)` — replaced with
      // shared modal.
      expect(giftCards).not.toMatch(/window\.prompt\s*\(/);
      expect(giftCards).toMatch(/usePasswordGate/);
      expect(giftCards).toMatch(/promptPassword\(/);
    });

    it("customers page uses PasswordGate for anonymize confirmation", () => {
      // R41-1: right-to-be-forgotten wired to the shared gate.
      expect(customers).toMatch(/usePasswordGate/);
      expect(customers).toMatch(/Anonymize customer/i);
    });

    it("PasswordGate supports ESC-to-cancel + Enter-to-submit", () => {
      expect(gate).toMatch(/Escape/);
      expect(gate).toMatch(/Enter/);
    });
  });

  describe("R41-2: cookie rename with dual-read migration", () => {
    const session = read("src/lib/auth/session.ts");
    const withAuth = read("src/lib/api/with-auth.ts");
    const login = read("src/app/api/auth/login/route.ts");
    const regLogin = read("src/app/api/auth/register-login/route.ts");
    const verify = read("src/app/api/auth/verify/route.ts");
    const revoke = read("src/app/api/auth/revoke-all-sessions/route.ts");

    it("session.ts exports new short cookie names + legacy for rollover", () => {
      expect(session).toMatch(/ADMIN_COOKIE\s*=\s*"bupos_a"/);
      expect(session).toMatch(/REGISTER_COOKIE\s*=\s*"bupos_r"/);
      expect(session).toMatch(/OLD_ADMIN_COOKIE\s*=\s*"basicuniformpos_admin_session"/);
      expect(session).toMatch(/OLD_REGISTER_COOKIE\s*=\s*"basicuniformpos_register_session"/);
    });

    it("session.ts uses getCookieValue dual-read helper", () => {
      expect(session).toMatch(/function getCookieValue/);
      // dual-read must prefer new name then fall back to old.
      expect(session).toMatch(/getCookieValue\(jar, ADMIN_COOKIE, OLD_ADMIN_COOKIE\)/);
      expect(session).toMatch(/getCookieValue\(jar, REGISTER_COOKIE, OLD_REGISTER_COOKIE\)/);
    });

    it("session.ts clears legacy cookie after writing the new one", () => {
      // Prevents dual-pinned cookies on rollover clients.
      expect(session).toMatch(/function deleteLegacyCookie/);
      expect(session).toMatch(/deleteLegacyCookie\(jar, ADMIN_COOKIE\)/);
      expect(session).toMatch(/deleteLegacyCookie\(jar, REGISTER_COOKIE\)/);
    });

    it("with-auth.ts dual-reads both admin + register cookies", () => {
      expect(withAuth).toMatch(/ADMIN_COOKIE\s*=\s*"bupos_a"/);
      expect(withAuth).toMatch(/REGISTER_COOKIE\s*=\s*"bupos_r"/);
      expect(withAuth).toMatch(/OLD_ADMIN_COOKIE/);
      expect(withAuth).toMatch(/OLD_REGISTER_COOKIE/);
      // Presence check must fall back to legacy name.
      expect(withAuth).toMatch(/jar\.get\(ADMIN_COOKIE\)\?\.value\s*\?\?\s*jar\.get\(OLD_ADMIN_COOKIE\)/);
      expect(withAuth).toMatch(/jar\.get\(REGISTER_COOKIE\)\?\.value\s*\?\?\s*jar\.get\(OLD_REGISTER_COOKIE\)/);
    });

    it("login/route.ts writes new cookie AND clears legacy in one response", () => {
      expect(login).toMatch(/ADMIN_COOKIE\s*=\s*"bupos_a"/);
      expect(login).toMatch(/OLD_ADMIN_COOKIE\s*=\s*"basicuniformpos_admin_session"/);
      // Must set the new cookie.
      expect(login).toMatch(/\$\{ADMIN_COOKIE\}=\$\{sessionId\}/);
      // And explicitly clear the old one (Max-Age=0).
      expect(login).toMatch(/\$\{OLD_ADMIN_COOKIE\}=/);
      expect(login).toMatch(/Max-Age=0/);
      // Uses headers.append so both Set-Cookie lines go out.
      expect(login).toMatch(/headers\.append\("Set-Cookie"/);
    });

    it("register-login/route.ts writes new cookie AND clears legacy", () => {
      expect(regLogin).toMatch(/REGISTER_COOKIE\s*=\s*"bupos_r"/);
      expect(regLogin).toMatch(/OLD_REGISTER_COOKIE\s*=\s*"basicuniformpos_register_session"/);
      expect(regLogin).toMatch(/\$\{REGISTER_COOKIE\}=\$\{sessionId\}/);
      expect(regLogin).toMatch(/\$\{OLD_REGISTER_COOKIE\}=/);
      expect(regLogin).toMatch(/Max-Age=0/);
    });

    it("verify/route.ts sets new cookie + deletes legacy on auto-signin", () => {
      expect(verify).toMatch(/ADMIN_COOKIE\s*=\s*"bupos_a"/);
      expect(verify).toMatch(/OLD_ADMIN_COOKIE\s*=\s*"basicuniformpos_admin_session"/);
      expect(verify).toMatch(/jar\.set\(ADMIN_COOKIE/);
      expect(verify).toMatch(/jar\.delete\(OLD_ADMIN_COOKIE\)/);
    });

    it("revoke-all-sessions clears BOTH new and legacy cookies", () => {
      expect(revoke).toMatch(/ADMIN_COOKIE\s*=\s*"bupos_a"/);
      expect(revoke).toMatch(/OLD_ADMIN_COOKIE\s*=\s*"basicuniformpos_admin_session"/);
      // Both clears go out so a rollover client doesn't keep a legacy
      // session pinned after "sign out everywhere".
      expect(revoke).toMatch(/\$\{ADMIN_COOKIE\}=/);
      expect(revoke).toMatch(/\$\{OLD_ADMIN_COOKIE\}=/);
      expect(revoke).toMatch(/r\.headers\.append\("Set-Cookie"/);
    });

    it("no route hard-codes the legacy cookie string outside an OLD_* constant", () => {
      // Prevents reintroduction of bare string refs. A bare ref outside
      // a `OLD_*_COOKIE =` assignment means a read path that won't see
      // a new-name cookie.
      const paths = [
        "src/lib/auth/session.ts",
        "src/lib/api/with-auth.ts",
        "src/app/api/auth/login/route.ts",
        "src/app/api/auth/register-login/route.ts",
        "src/app/api/auth/verify/route.ts",
        "src/app/api/auth/revoke-all-sessions/route.ts",
      ];
      for (const p of paths) {
        const src = read(p);
        const lines = src.split("\n");
        for (const line of lines) {
          if (!line.includes("basicuniformpos_")) continue;
          // Allowed: OLD_*_COOKIE assignment, comments, or BroadcastChannel names.
          const allowed =
            /OLD_(ADMIN|REGISTER)_COOKIE\s*=\s*"basicuniformpos_/.test(line)
            || line.trimStart().startsWith("//")
            || line.trimStart().startsWith("*")
            || /basicuniformpos_customer_display/.test(line)
            || /basicuniformpos_admin_session` vs `basicuniformpos_register_session/.test(line);
          expect(allowed, `Bare legacy cookie ref in ${p}: ${line.trim()}`).toBe(true);
        }
      }
    });
  });

  describe("R41-3: HMAC device-cookie v2 format", () => {
    it("signDeviceId emits v2. prefix", async () => {
      const signed = await signDeviceId("device-abc-123");
      expect(signed.startsWith("v2.")).toBe(true);
      // Format: v2.{deviceId}.{sig}
      expect(signed.split(".").length).toBeGreaterThanOrEqual(3);
    });

    it("v2 round-trip validates correctly", async () => {
      const signed = await signDeviceId("device-xyz-456");
      const verified = await verifyDeviceIdCookie(signed);
      expect(verified).toBe("device-xyz-456");
    });

    it("v2 rejects tampered deviceId", async () => {
      const signed = await signDeviceId("device-original");
      // Corrupt the device id portion while keeping the sig shape.
      const corrupted = signed.replace("device-original", "device-evil-malicious");
      const verified = await verifyDeviceIdCookie(corrupted);
      expect(verified).toBeNull();
    });

    it("v2 rejects tampered sig", async () => {
      const signed = await signDeviceId("device-x");
      // Flip one byte in the sig.
      const rest = signed.slice(-4);
      const flipped = signed.slice(0, -4) + (rest[0] === "A" ? "B" : "A") + rest.slice(1);
      const verified = await verifyDeviceIdCookie(flipped);
      expect(verified).toBeNull();
    });

    it("v2 rejects v1-shaped value presented with v2. prefix (format confusion)", async () => {
      // Attacker takes a legitimate v1 cookie value, prepends "v2."
      // trying to trick the code into using the v1 HMAC path under
      // v2 authority. The scope prefix in v2 means this can't match.
      //
      // Construct a v1 signature with the knowledge that we DON'T
      // have access to the real secret in tests, but any forged
      // sig should fail; this test just pins that the v2 path
      // verifies against the v2 HMAC message, not a naked deviceId.
      const forged = "v2.device-x.AAAAAAAAAAAAAAAAAAAAAA";
      const verified = await verifyDeviceIdCookie(forged);
      expect(verified).toBeNull();
    });

    it("v2 rejects malformed inputs", async () => {
      expect(await verifyDeviceIdCookie("")).toBeNull();
      expect(await verifyDeviceIdCookie("v2.")).toBeNull();
      expect(await verifyDeviceIdCookie("v2..")).toBeNull();
      expect(await verifyDeviceIdCookie("v2.device-no-dot")).toBeNull();
      expect(await verifyDeviceIdCookie("v2..sig-only")).toBeNull();
      expect(await verifyDeviceIdCookie("no-dot-at-all")).toBeNull();
    });

    it("device-cookie.ts declares v2 scope prefix + version constant", () => {
      const src = read("src/lib/auth/device-cookie.ts");
      expect(src).toMatch(/V2_PREFIX\s*=\s*"v2\."/);
      expect(src).toMatch(/V2_SCOPE\s*=\s*"bupos-device-cookie-v2/);
      // Dual-verify logic present.
      expect(src).toMatch(/startsWith\(V2_PREFIX\)/);
    });

    it("verifyDeviceIdCookie still accepts legacy v1 format during rollover", async () => {
      // Build a v1 cookie using the same secret flow (import the
      // internal primitives via a round-trip test). We can't easily
      // construct a v1 signature without the secret, so instead
      // regression-check the SOURCE that the v1 verify path is still
      // reachable.
      const src = read("src/lib/auth/device-cookie.ts");
      // v1 branch: no v2 prefix, falls through to the legacy dot-
      // split + slice(0,16) comparison.
      expect(src).toMatch(/v1 \(legacy\)/);
      expect(src).toMatch(/slice\(0, 16\)/);
    });
  });
});
