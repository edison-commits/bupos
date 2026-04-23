/**
 * R40 regression tests. Pins the deferred items from R37-R39 that
 * landed in this round: password-reuse history, loyalty reversal
 * cumulative-share clamp, PIN lockout DoS mitigation, npm pinning,
 * ESLint-config guard, SW update-opt-in, expanded pre-commit hook.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHistory,
  appendHistory,
  assertNotReused,
  PasswordReuseError,
  HISTORY_CAP,
} from "@/lib/auth/password-history";
import { hashSecret } from "@/lib/auth/crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const readRoot = (rel: string) => fs.readFileSync(path.resolve(REPO, "..", rel), "utf8");

describe("R40 deferred fixes", () => {
  describe("R40-1: password-reuse history", () => {
    const mig = read("supabase/migrations/069_r40_password_history.sql");
    const changeRoute = read("src/app/api/auth/password-change/route.ts");
    const resetRoute = read("src/app/api/auth/password-reset-confirm/route.ts");

    it("migration 069 adds prior_password_hashes jsonb column", () => {
      expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS prior_password_hashes jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
    });
    it("password-change reads history + asserts not reused + appends", () => {
      expect(changeRoute).toMatch(/prior_password_hashes/);
      expect(changeRoute).toMatch(/assertNotReused\(newPassword, history\)/);
      expect(changeRoute).toMatch(/appendHistory\(currentHash, history\)/);
    });
    it("password-reset-confirm also checks + appends history", () => {
      // R58-4 moved the reuse-check + history read OUTSIDE the tx so
      // the FOR UPDATE lock isn't held across the PBKDF2 iterations.
      // Variable rename (oldHash → snapHash); history is now derived
      // inline via parseHistory(snapCred.prior_password_hashes). Test
      // accepts both old and new shapes.
      expect(resetRoute).toMatch(/prior_password_hashes/);
      expect(resetRoute).toMatch(/assertNotReused\(newPassword, history\)/);
      expect(resetRoute).toMatch(
        /appendHistory\((?:oldHash, history|snapHash, parseHistory\([^)]*\))\)/,
      );
    });

    it("parseHistory tolerates null / malformed / array / jsonb-string inputs", () => {
      expect(parseHistory(null)).toEqual([]);
      expect(parseHistory(undefined)).toEqual([]);
      expect(parseHistory([])).toEqual([]);
      expect(parseHistory(["h1", "h2"])).toEqual(["h1", "h2"]);
      expect(parseHistory("[\"h1\", \"h2\"]")).toEqual(["h1", "h2"]);
      expect(parseHistory("not json")).toEqual([]);
      // Mixed types filtered out
      expect(parseHistory(["h1", 42, null, "h2"])).toEqual(["h1", "h2"]);
    });

    it("appendHistory prepends new + dedups + caps at HISTORY_CAP", () => {
      expect(appendHistory("newHash", [])).toEqual(["newHash"]);
      expect(appendHistory("newHash", ["old1"])).toEqual(["newHash", "old1"]);
      // Dedup: if hash was already in history, it moves to front.
      expect(appendHistory("dupe", ["a", "dupe", "b"])).toEqual(["dupe", "a", "b"]);
      // Cap
      const eleven = Array.from({ length: 11 }, (_, i) => `h${i}`);
      const capped = appendHistory("newHash", eleven);
      expect(capped.length).toBe(HISTORY_CAP);
      expect(capped[0]).toBe("newHash");
    });

    it("assertNotReused rejects a new-password hash that matches any entry", async () => {
      const oldHash = await hashSecret("OldPassword123!");
      const history = [oldHash];
      // Reusing the same password throws PasswordReuseError.
      await expect(assertNotReused("OldPassword123!", history)).rejects.toThrow(PasswordReuseError);
      // A different password is fine.
      await expect(assertNotReused("DifferentPassword456!", history)).resolves.toBeUndefined();
    });
  });

  describe("R40-2: loyalty reversal cumulative-share clamp", () => {
    const reg = read("src/app/register/return-action.ts");
    const admin = read("src/app/api/returns/process/route.ts");
    it("register path uses cumulative-share formula (not per-refund round)", () => {
      expect(reg).toMatch(/priorExpectedReverse = Math\.round\(origPointsEarned \* priorShare\)/);
      expect(reg).toMatch(/newExpectedReverse = Math\.round\(origPointsEarned \* newCumulativeShare\)/);
      expect(reg).toMatch(/pointsToReverse = Math\.max\(0, Math\.min\([\s\S]+?newExpectedReverse - priorExpectedReverse/);
    });
    it("register path queries prior refund sum from transactions", () => {
      expect(reg).toMatch(/SELECT COALESCE\(SUM\(grand_total\), 0\)::numeric AS prior_refund[\s\S]+?originalTransactionId/);
    });
    it("admin /api/returns/process uses same cumulative-share clamp", () => {
      expect(admin).toMatch(/priorExpectedReverse = Math\.round\(origPointsEarned \* priorShare\)/);
      expect(admin).toMatch(/newExpectedReverse = Math\.round\(origPointsEarned \* newCumulativeShare\)/);
    });
  });

  describe("R40-3: PIN-lockout cross-isolate DoS mitigation", () => {
    const src = read("src/app/api/auth/register-login/route.ts");
    it("failed_pin_attempts only increments on permFail, not locFail", () => {
      // The UPDATE must be inside an `if (permFail) {` branch, not the
      // combined `locFail || permFail` branch.
      expect(src).toMatch(/if \(permFail\) \{[\s\S]+?failed_pin_attempts = failed_pin_attempts \+ 1/);
    });
    it("documents why locFail no longer increments", () => {
      expect(src).toMatch(/R40-3: drop the `locFail` arm/);
      // The rationale paragraph references the cross-IP-rotation DoS.
      expect(src).toMatch(/distributed IPs/);
    });
  });

  describe("R40-4: .npmrc pins saves + engine-strict", () => {
    const src = read(".npmrc");
    it("save-exact=true", () => expect(src).toMatch(/^save-exact=true$/m));
    it("engine-strict=true", () => expect(src).toMatch(/^engine-strict=true$/m));
  });

  describe("R40-5: husky pre-commit expanded", () => {
    const src = readRoot(".husky/pre-commit");
    it("runs pool-query + rls + eslint-guard checks", () => {
      expect(src).toMatch(/check-pool-query-org-filter\.mjs/);
      expect(src).toMatch(/check-rls-force-matching\.mjs/);
      expect(src).toMatch(/check-eslint-config-guard\.mjs/);
    });
  });

  describe("R40-6: ESLint-config guard", () => {
    const script = read("scripts/check-eslint-config-guard.mjs");
    const pkg = read("package.json");
    it("guard script checks the 3 custom rules at error level", () => {
      expect(script).toMatch(/local\/no-hand-rolled-currency/);
      expect(script).toMatch(/local\/no-workers-hazards/);
      expect(script).toMatch(/local\/pg-helpers-require-org/);
      expect(script).toMatch(/const REQUIRED_LEVEL = "error"/);
    });
    it("package.json wires check:eslint-guard into check:all", () => {
      expect(pkg).toMatch(/"check:eslint-guard":/);
      expect(pkg).toMatch(/check:all[\s\S]+?npm run check:eslint-guard/);
    });
  });

  describe("R40-7: service-worker skipWaiting is opt-in", () => {
    const sw = read("public/sw.js");
    const banner = read("src/components/sw-update-banner.tsx");
    const layout = read("src/app/layout.tsx");
    it("sw.js no longer calls skipWaiting on install", () => {
      // The install handler block must NOT contain skipWaiting.
      const installBlock = sw.slice(sw.indexOf("addEventListener(\"install\""), sw.indexOf("addEventListener(\"message\""));
      expect(installBlock).not.toMatch(/self\.skipWaiting\(\)/);
    });
    it("sw.js listens for SKIP_WAITING messages", () => {
      expect(sw).toMatch(/addEventListener\("message"[\s\S]+?event\.data\.type === "SKIP_WAITING"[\s\S]+?self\.skipWaiting\(\)/);
    });
    it("SwUpdateBanner component posts SKIP_WAITING on user click", () => {
      expect(banner).toMatch(/postMessage\(\{ type: "SKIP_WAITING" \}\)/);
    });
    it("layout renders the banner", () => {
      expect(layout).toMatch(/<SwUpdateBanner \/>/);
    });
  });
});
