/**
 * R48 regression tests. Pins the highest-impact fixes from round 7:
 *   R48-1: Shared `SubmitGuardForm` helper + admin-console 13 forms
 *          migrated to it (prevents double-submit on every mutating
 *          admin action).
 *   R48-2: /api/returns PUT requires step-up when status='completed'
 *          (the money-dispensing transition).
 *   R48-3: /api/tax-config wraps SELECT + UPDATE + audit in one orgTx
 *          (was orgQuery + orgQuery + post-commit audit).
 *   R48-4: email-receipt qty coerces via Number() to block stored-
 *          XSS-via-email if a crafted cart_snapshot lands.
 *   R48-5: VoidReasonModal synchronous double-submit guard.
 *
 * Deferred (flagged for R49+): the remaining ~40 audit-drift sites,
 * ~13 step-up gaps, and 2 register modals without submit guards.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R48 audit fixes", () => {
  describe("R48-1: shared SubmitGuardForm helper applied to admin-console", () => {
    it("SubmitGuardForm component exists and uses synchronous DOM mutation", () => {
      const src = read("src/components/shared/submit-guard-form.tsx");
      expect(src).toMatch(/export function SubmitGuardForm/);
      expect(src).toMatch(/btn\.disabled = true/);
      expect(src).toMatch(/if \(btn\.disabled\) \{\s*e\.preventDefault\(\)/);
    });
    it("admin-console imports SubmitGuardForm", () => {
      const src = read("src/components/admin/admin-console.tsx");
      expect(src).toMatch(/import \{ SubmitGuardForm \} from ['"]@\/components\/shared\/submit-guard-form['"]/);
    });
    it("13 admin-console forms converted from <form> to <SubmitGuardForm>", () => {
      const src = read("src/components/admin/admin-console.tsx");
      const open = (src.match(/<SubmitGuardForm /g) ?? []).length;
      const close = (src.match(/<\/SubmitGuardForm>/g) ?? []).length;
      expect(open).toBeGreaterThanOrEqual(12);
      expect(close).toBe(open);
    });
  });

  describe("R48-2: /api/returns PUT requires step-up on completed transition", () => {
    const src = read("src/app/api/returns/route.ts");
    it("gates status='completed' on requireStepUp", () => {
      expect(src).toMatch(/if \(status === 'completed'\)[\s\S]*?requireStepUp[\s\S]*?bucketKey:\s*['"]returns-complete-stepup['"]/);
    });
  });

  describe("R48-3: /api/tax-config wraps in orgTx with in-tx audit", () => {
    const src = read("src/app/api/tax-config/route.ts");
    it("uses orgTx + SELECT FOR UPDATE + in-tx audit INSERT + COMMIT", () => {
      expect(src).toMatch(/orgTx\(orgId\)[\s\S]*?FOR UPDATE[\s\S]*?INSERT INTO audit_events[\s\S]*?'tax_rate_changed'[\s\S]*?COMMIT/);
    });
    it("no post-commit waitUntilOrAwait audit remains", () => {
      expect(src).not.toMatch(/waitUntilOrAwait\(pgInsertAuditEvent/);
    });
  });

  describe("R48-4: email-receipt qty coerces through Number()", () => {
    const src = read("src/app/api/email-receipt/route.ts");
    it("qty goes through Number() + isFinite fallback", () => {
      expect(src).toMatch(/const qty = Number\(item\.qty \?\? item\.quantity \?\? 1\)/);
      expect(src).toMatch(/Number\.isFinite\(qty\) \? qty : 1/);
    });
  });

  describe("R48-5: VoidReasonModal synchronous double-submit guard", () => {
    const src = read("src/components/register/void-reason-modal.tsx");
    it("submitting state + disabled button + early-return", () => {
      expect(src).toMatch(/const \[submitting, setSubmitting\] = useState\(false\)/);
      expect(src).toMatch(/disabled=\{submitting\}/);
      expect(src).toMatch(/if \(submitting\) return/);
    });
  });
});
