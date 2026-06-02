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
      expect(src).toMatch(/signInRegisterByEmployee\(employeeId, locationId, deviceId, pin \|\| undefined\)/);
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

  describe("register/page.tsx renders TimezoneBootstrap (no #418 on clocked-in console)", () => {
    // The authenticated register console formats the shift-opened time on
    // the client (AppNav). Without setting the client TZ to the org's value
    // during render, the client fell back to the LA default and mismatched
    // the server's org-TZ render → React #418 at /register?notice=Clocked+in.
    const src = read("src/app/register/page.tsx");
    it("imports TimezoneBootstrap", () => {
      expect(src).toMatch(/import \{ TimezoneBootstrap \} from "@\/components\/system\/timezone-bootstrap"/);
    });
    it("renders <TimezoneBootstrap timezone={orgTz}> above AppNav", () => {
      expect(src).toMatch(/<TimezoneBootstrap timezone=\{orgTz\} \/>[\s\S]*?<AppNav/);
    });
  });
});
