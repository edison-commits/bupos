/**
 * R28 wave-2: pins fixes for the four HIGH findings left open after
 * the initial R28 sweep landed.
 *
 *   H4 — Employees PATCH `deactivate` was a silent toggle with no
 *        step-up; compromised manager cookie could DoS the store or
 *        silently re-activate fired hostile employees.
 *   H5 — `device_id` binding on register sessions was cosmetic: the
 *        check was `if (deviceId && sessionDeviceId && …)` which
 *        SKIPPED verification when the request didn't pass a deviceId
 *        (every server-action call, in practice).
 *   H6 — `pgAdjustInventory` accepted unbounded deltas; an inventory-
 *        clerk could mint 10 M units of stock and cloak pilferage.
 *   H7 — `/api/auth/revoke-all-sessions` cleared the admin cookie
 *        without the `Secure` attribute; some browsers refuse to
 *        clear a Secure cookie via a non-Secure Set-Cookie.
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

describe("R28 wave-2 HIGH fixes", () => {
  describe("H4 — employees PATCH: activate/deactivate are explicit + step-up required", () => {
    const src = read("src/app/api/employees/route.ts");
    const schema = read("src/lib/validation/schemas.ts");

    it("employeePatchSchema accepts 'activate' and 'deactivate' (not a toggle)", () => {
      expect(schema).toMatch(
        /action: z\.enum\(\["activate", "deactivate", "reset_pin"\]\)/,
      );
    });

    it("UPDATE uses explicit `is_active = $1` keyed on target state, not `NOT is_active`", () => {
      expect(src).toMatch(/UPDATE employees SET is_active = \$1, updated_at/);
      // And the OLD toggle is gone.
      expect(src).not.toMatch(/SET is_active = NOT is_active/);
    });

    it("refuses no-op transitions (409 when already in target state)", () => {
      expect(src).toMatch(/Employee is already \$\{targetActive \? 'active' : 'inactive'\}/);
    });

    it("step-up auth is required at the top of the handler for all actions", () => {
      // The actorPassword check + rate-limit + verifySecret used to
      // live INSIDE the `reset_pin` branch. Post-H4 it's hoisted above
      // the action switch so activate/deactivate get the same gate.
      const actionSwitchIdx = src.indexOf("if (action === 'activate' || action === 'deactivate')");
      const stepupRlIdx = src.indexOf("const stepupRl = rl(`pin-reset-stepup:");
      expect(actionSwitchIdx).toBeGreaterThan(-1);
      expect(stepupRlIdx).toBeGreaterThan(-1);
      // Rate-limit gate MUST come BEFORE the action branch.
      expect(stepupRlIdx).toBeLessThan(actionSwitchIdx);
    });

    it("step-up rate-limit result is gated (fail-closed, mirrors R28-C6 fix)", () => {
      expect(src).toMatch(/if \(!stepupRl\.allowed\)/);
    });
  });

  describe("H5 — device_id binding is enforced fail-closed", () => {
    const sessSrc = read("src/lib/auth/session.ts");
    const loginSrc = read("src/app/api/auth/register-login/route.ts");

    it("resolveSession fails-closed when session.device_id is set but request deviceId is missing/mismatched", () => {
      // Previous pattern: `if (deviceId && sessionDeviceId && sessionDeviceId !== deviceId)`
      // — SKIPPED when caller didn't pass deviceId. New pattern:
      // `if (sessionDeviceId) { if (!deviceId || ...) return null; }`
      expect(sessSrc).toMatch(/if \(sessionDeviceId\) \{\s*if \(!deviceId \|\| sessionDeviceId !== deviceId\)/);
    });

    it("getRegisterSession pulls the device cookie when no arg is passed", () => {
      expect(sessSrc).toMatch(/jar\.get\("bupos_register_device"\)/);
    });

    it("register-login sets a `bupos_register_device` cookie on success", () => {
      expect(loginSrc).toMatch(/bupos_register_device=/);
    });

    it("signOutRegister clears the device cookie too", () => {
      expect(sessSrc).toMatch(/jar\.delete\("bupos_register_device"\)/);
    });
  });

  describe("H6 — adjustInventoryAction caps delta", () => {
    const src = read("src/app/admin/actions.ts");

    it("owner/manager cap ≤ 10_000 per adjustment", () => {
      expect(src).toMatch(/MAX_DELTA_MANAGER = 10_000/);
    });

    it("inventory clerk cap ≤ 1_000 (tighter for lower-privilege role)", () => {
      expect(src).toMatch(/MAX_DELTA_CLERK = 1_000/);
    });

    it("rejects abs(delta) > cap before DB work", () => {
      expect(src).toMatch(/Math\.abs\(delta\) > cap/);
    });
  });

  describe("H7 — revoke-all-sessions clear-cookie includes Secure on HTTPS", () => {
    const src = read("src/app/api/auth/revoke-all-sessions/route.ts");

    it("clear-cookie emits Secure when request URL is HTTPS", () => {
      expect(src).toMatch(/isSecure = req\.url\.startsWith\("https:\/\/"\)/);
      expect(src).toMatch(/isSecure \? \["Secure"\] : \[\]/);
    });

    it("clear-cookie includes both Expires=1970 AND Max-Age=0", () => {
      // Belt-and-braces — different browsers prefer different attrs.
      expect(src).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
      expect(src).toMatch(/Max-Age=0/);
    });
  });
});
