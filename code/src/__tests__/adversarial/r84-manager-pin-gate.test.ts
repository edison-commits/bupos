/**
 * R84 regression tests — "tap your name" register clock-in with the
 * manager/owner PIN gate.
 *
 * The operator replaced the universal PIN pad with a store-picker → tap-
 * your-name roster. Cashiers clock in with no secret, but OWNER/MANAGER
 * names stay PIN-gated so a cashier physically at the register can't assume
 * manager privileges just by tapping a manager's name. These tests pin the
 * three layers of that gate against future refactors:
 *
 *   - session.ts#signInRegisterByEmployee: elevated roles must present a
 *     PIN that verifySecret-matches that one employee, else fail closed.
 *   - actions.ts#clockInAction: when a PIN is present it goes through the
 *     shared enforceRegisterPinRateLimits brute-force gate.
 *   - store-clock-in.tsx: managers/owners open a keypad; cashiers submit
 *     directly; the PIN is posted as a hidden field.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatDateTime } from "@/lib/utils/date";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R84 — manager/owner PIN gate on tap-your-name clock-in", () => {
  describe("session.ts signInRegisterByEmployee", () => {
    const src = read("src/lib/auth/session.ts");

    it("accepts a pin parameter", () => {
      expect(src).toMatch(/export async function signInRegisterByEmployee\([\s\S]*?pin\?\s*:\s*string\s*,?\s*\)/);
    });

    it("selects the employee's pin_hash for a targeted verify", () => {
      expect(src).toMatch(/LEFT JOIN auth_credentials ac ON ac\.employee_id = e\.id/);
      expect(src).toMatch(/ac\.pin_hash/);
    });

    it("requires + verifies a PIN for owner/manager, failing closed", () => {
      // The gate keys on the elevated roles…
      expect(src).toMatch(/roleKey === "owner" \|\| roleKey === "manager"/);
      // …rejects an empty PIN…
      expect(src).toMatch(/if \(!cleanPin\)[\s\S]*?redirect\(/);
      // …and rejects a missing-hash or non-matching PIN via verifySecret.
      expect(src).toMatch(/!row\.pin_hash \|\| !\(await verifySecret\(cleanPin, row\.pin_hash\)\)/);
    });
  });

  describe("actions.ts clockInAction", () => {
    const src = read("src/app/register/actions.ts");

    it("reads the pin from the form", () => {
      expect(src).toMatch(/const pin = String\(formData\.get\("pin"\)/);
    });

    it("runs the shared brute-force gate when (and only when) a PIN is present", () => {
      // The gate is inside an `if (pin)` block — cashiers (no pin) skip it.
      const m = src.match(/if \(pin\) \{[\s\S]*?enforceRegisterPinRateLimits\([\s\S]*?\}\s*\n\s*const loginResult/);
      expect(m).not.toBeNull();
    });

    it("passes the pin through to signInRegisterByEmployee", () => {
      // SEC-AUDIT7-CRIT1: now also passes the verified per-store token's org
      // (tokenOrgId) so the clock-in is bound to the provisioned tenant.
      expect(src).toMatch(/signInRegisterByEmployee\(employeeId, locationId, tokenOrgId, deviceId, pin \|\| undefined\)/);
    });
  });

  describe("store-clock-in.tsx UI", () => {
    const src = read("src/components/register/store-clock-in.tsx");

    it("gates only owner/manager behind the keypad", () => {
      expect(src).toMatch(/function requiresPin\(role: string\): boolean \{\s*return role === "owner" \|\| role === "manager";/);
    });

    it("posts the PIN as a hidden field on the keypad form", () => {
      expect(src).toMatch(/<input type="hidden" name="pin" value=\{pin\} \/>/);
    });

    it("still posts deviceId on both the cashier and the keypad forms", () => {
      const matches = src.match(/<input type="hidden" name="deviceId" value=\{deviceId\} \/>/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it("cashier path submits clockInAction directly (no keypad)", () => {
      // Cashier branch is a <form action={clockInAction}> with a submit button.
      expect(src).toMatch(/Cashier — tap to clock in, no PIN\.[\s\S]*?<form key=\{e\.id\} action=\{clockInAction\}/);
    });
  });

  describe("register clocked-in console: no #418 timezone hydration mismatch", () => {
    // Proven root cause (live Playwright probe): SSR rendered shift/session
    // dates in UTC (runWithTimeZone's async-local scope doesn't reach the
    // React render phase) while the client rendered org-local → React #418
    // at /register?notice=Clocked+in. Fix: pass the org TZ explicitly to
    // formatDateTime so SSR + client are identical.
    it("formatDateTime honors an explicit timeZone arg (overrides ambient default)", () => {
      const iso = "2026-06-02T04:21:00.000Z"; // 04:21 UTC
      const la = formatDateTime(iso, "America/Los_Angeles");
      const utc = formatDateTime(iso, "UTC");
      expect(la).not.toBe(utc);
      expect(la).toMatch(/Jun 1, 2026/); // 9:21 PM previous day in LA
      expect(utc).toMatch(/Jun 2, 2026/);
    });

    it("register-console-client passes the org tz to every formatDateTime", () => {
      const src = read("src/components/register/register-console-client.tsx");
      expect(src).toMatch(/const tz = store\.organization\?\.timezone \|\| "UTC"/);
      // No bare formatDateTime(...) call may remain (all must pass `tz`).
      const bare = src.match(/formatDateTime\([^)]*\)/g) ?? [];
      for (const call of bare) {
        // The import line is `formatDateTime(value: string, timeZone?...` — skip non-calls.
        if (call.includes("import")) continue;
        expect(call).toMatch(/,\s*tz\)/);
      }
    });

    it("app-nav formats the shift time with session.timezone", () => {
      const src = read("src/components/layout/app-nav.tsx");
      expect(src).toMatch(/formatDateTime\(session\.shiftOpenedAt, session\.timezone\)/);
    });

    it("register/page.tsx feeds the org tz into headerSession + TimezoneBootstrap", () => {
      const src = read("src/app/register/page.tsx");
      expect(src).toMatch(/timezone: store\.organization\?\.timezone \|\| "UTC"/);
      expect(src).toMatch(/<TimezoneBootstrap timezone=\{orgTz\} \/>[\s\S]*?<AppNav/);
    });
  });
});
