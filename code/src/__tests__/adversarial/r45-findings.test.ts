/**
 * R45 regression tests. Pins R45 audit-round fixes:
 *   R45-C1: R44-C1 extended to check `created_at >= openShift.opened_at`
 *           in addition to session equality (same register_session can
 *           span multiple shifts).
 *   R45-H1: signOutRegister wraps all state mutations in one tx; sets
 *           closing_* to NULL instead of fake opening_float.
 *   R45-H2: register-side return-action.ts cap excludes 'loyalty'.
 *   R45-H3: run-cleanup replay-guard ordering — branch on x-cleanup-ts
 *           BEFORE the plain-bearer check so the signed form reaches
 *           the replay guard.
 *   R45-H4: gift-card activate/reload server actions require step-up.
 *   R45-M: cancelLayawayAction step-up on refund branches; notice-
 *          toaster uses shared sanitizer; /admin/clock-in sanitize;
 *          employees PATCH step-up hoisted to top; store-credit /
 *          gift-card money-mint audit INSIDE tx; signup-form double-
 *          submit guard; admin/page.tsx redirect no raw err.message;
 *          raw err.message log in signup.
 *   R45-LOW: makeLayawayPaymentAction step-up; guardrails npm audit
 *            blocking; revoke-all-sessions clears register cookies
 *            too; migration 072 explicit BEGIN/COMMIT.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const readRoot = (rel: string) => fs.readFileSync(path.resolve(REPO, "..", rel), "utf8");

describe("R45 audit fixes", () => {
  describe("R45-C1: cross-shift detection includes time-window check", () => {
    it("/api/returns PUT compares orig created_at vs openShift opened_at", () => {
      const src = read("src/app/api/returns/route.ts");
      expect(src).toMatch(/openShiftOpenedAt = new Date\(openShift\.opened_at\)\.getTime\(\)/);
      expect(src).toMatch(/inShiftWindow = sameSession && origCreatedAt >= openShiftOpenedAt/);
    });
    it("/api/returns/process has the same time-window extension", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/inShiftWindow = sameSession && origCreatedAt >= openShiftOpenedAt/);
    });
  });

  describe("R45-H1: signOutRegister transactional + unreconciled close", () => {
    const src = read("src/lib/auth/session.ts");
    it("uses explicit BEGIN/COMMIT + ROLLBACK pattern", () => {
      // The column-level path now wraps in an `orgTx`-style client
      // transaction so the 5 mutations are atomic.
      expect(src).toMatch(/await client\.query\("BEGIN"\)[\s\S]*?await client\.query\("COMMIT"\)/);
      expect(src).toMatch(/ROLLBACK/);
    });
    it("sets closing_* to NULL and marks close unreconciled (no fake variance=0)", () => {
      expect(src).toMatch(/closing_expected_cash = NULL/);
      expect(src).toMatch(/closing_declared_cash = NULL/);
      expect(src).toMatch(/closing_variance = NULL/);
      expect(src).toMatch(/NOT reconciled/);
    });
    it("shifts UPDATE carries organization_id filter (R45-M3)", () => {
      expect(src).toMatch(/UPDATE shifts[\s\S]*?WHERE id = \$3 AND status = 'open' AND organization_id = \$4/);
    });
  });

  describe("R45-H2: register return-action cap excludes loyalty", () => {
    const src = read("src/app/register/return-action.ts");
    it("cash_tendered + prior_cash_refunded queries exclude loyalty", () => {
      const cnt = (src.match(/NOT IN \('gift_card', 'store_credit', 'loyalty'\)/g) ?? []).length;
      expect(cnt).toBeGreaterThanOrEqual(2);
    });
  });

  describe("R45-H3: run-cleanup replay guard order", () => {
    const src = read("src/app/api/internal/run-cleanup/route.ts");
    it("branches on x-cleanup-ts BEFORE plain-bearer check", () => {
      // The `else` branch is the plain-bearer fallback; reaching it
      // means we checked tsHeader first.
      expect(src).toMatch(/if \(tsHeader\) \{[\s\S]*?\} else \{[\s\S]*?bearerMatches\(authHeader, `Bearer \$\{opsSecret\}`\)/);
    });
  });

  describe("R45-H4: gift-card activate/reload step-up", () => {
    const src = read("src/app/admin/gift-card-actions.ts");
    it("activateGiftCardAction calls requireStepUp with gift-card-activate-stepup bucket", () => {
      expect(src).toMatch(/activateGiftCardAction[\s\S]*?bucketKey:\s*["']gift-card-activate-stepup["']/);
    });
    it("reloadGiftCardAction calls requireStepUp with gift-card-reload-stepup bucket", () => {
      expect(src).toMatch(/reloadGiftCardAction[\s\S]*?bucketKey:\s*["']gift-card-reload-stepup["']/);
    });
  });

  describe("R45-M: cancelLayawayAction step-up on refund branches", () => {
    const src = read("src/app/admin/layaway-actions.ts");
    it("gates on refund_cash + refund_store_credit", () => {
      expect(src).toMatch(/disposition === "refund_cash" \|\| disposition === "refund_store_credit"[\s\S]*?requireStepUp/);
      expect(src).toMatch(/bucketKey:\s*["']layaway-cancel-stepup["']/);
    });
  });

  describe("R45-M: notice-toaster + /admin/clock-in use shared sanitizer", () => {
    it("notice-toaster imports sanitizeNotice", () => {
      const src = read("src/components/notice-toaster.tsx");
      expect(src).toMatch(/import \{ sanitizeNotice \} from ['"]@\/lib\/utils\/sanitize-notice['"]/);
    });
    it("/admin/clock-in page imports sanitizeNotice + applies to urlError and notice", () => {
      const src = read("src/app/admin/clock-in/page.tsx");
      expect(src).toMatch(/import \{ sanitizeNotice \}/);
      expect(src).toMatch(/sanitizeNotice\(searchParams\.get\("error"\)/);
      expect(src).toMatch(/sanitizeNotice\(searchParams\.get\("notice"\)/);
    });
  });

  describe("R45-M: employees PATCH step-up hoisted to top", () => {
    const src = read("src/app/api/employees/route.ts");
    it("requireStepUp call appears BEFORE the target role-lookup SELECT", () => {
      const stepupIdx = src.indexOf("const stepUp = await requireStepUp");
      const selectIdx = src.indexOf("SELECT role_key FROM employees WHERE id = $1 AND organization_id = $2");
      expect(stepupIdx).toBeGreaterThan(-1);
      expect(selectIdx).toBeGreaterThan(-1);
      expect(stepupIdx).toBeLessThan(selectIdx);
    });
    it("PATCH has exactly one requireStepUp call (the hoisted one)", () => {
      // R45-M: The file has two call sites — one each for PATCH (at
      // handler top) and PUT (when v.data.isActive/roleKey/etc set).
      // The fix was hoisting PATCH's call ABOVE the role-lookup;
      // verify the PATCH section contains exactly one.
      const patchSection = src.slice(src.indexOf("export const PATCH"));
      const nextExport = patchSection.indexOf("\nexport const ");
      const patchOnly = nextExport > 0 ? patchSection.slice(0, nextExport) : patchSection;
      const matches = patchOnly.match(/const stepUp = await requireStepUp/g) ?? [];
      expect(matches.length).toBe(1);
    });
  });

  describe("R45-M: money-mint server actions write audit INSIDE tx", () => {
    it("issueStoreCreditAction inserts audit_events before COMMIT", () => {
      const src = read("src/app/admin/store-credit-actions.ts");
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'store_credit_issued'[\s\S]*?COMMIT/);
    });
    it("activateGiftCardAction inserts audit_events before COMMIT", () => {
      const src = read("src/app/admin/gift-card-actions.ts");
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'gift_card_activated'[\s\S]*?COMMIT/);
    });
    it("reloadGiftCardAction inserts audit_events before COMMIT", () => {
      const src = read("src/app/admin/gift-card-actions.ts");
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'gift_card_reloaded'[\s\S]*?COMMIT/);
    });
  });

  describe("R45-M: signup-form double-submit guard", () => {
    const src = read("src/components/auth/signup-form.tsx");
    it("onSubmit mutates submit button disabled synchronously", () => {
      expect(src).toMatch(/btn\.disabled = true/);
    });
  });

  describe("R45-M: admin/page.tsx no raw err.message in redirect", () => {
    const src = read("src/app/admin/page.tsx");
    it("does NOT embed msg in redirect URL", () => {
      expect(src).not.toMatch(/encodeURIComponent\(['"]Store load failed: ['"] \+ msg\)/);
    });
    it("redirects to static /?error=Store+load+failed", () => {
      expect(src).toMatch(/\/\?error=Store\+load\+failed/);
    });
    it("logs via safeErr for ops diagnosis", () => {
      expect(src).toMatch(/safeErr\(e\)/);
    });
  });

  describe("R45-M: raw err.message logs routed through safeErr", () => {
    it("actions/auth signupAction catch uses safeErr", () => {
      const src = read("src/app/actions/auth.ts");
      // The prior `msg = err.message` + `console.error("Signup error:", msg)` pattern
      // is replaced with `safeErr(e)`.
      expect(src).toMatch(/console\.error\("Signup error:", safeErr\(e\)\)/);
    });
    it("register/actions register_quick_switch fallback logs via safeErr", () => {
      const src = read("src/app/register/actions.ts");
      expect(src).toMatch(/register_quick_switch\][\s\S]*?safeErr\(rpcErr\)/);
    });
  });

  describe("R45-LOW: makeLayawayPaymentAction step-up", () => {
    const src = read("src/app/admin/layaway-actions.ts");
    it("calls requireStepUp with layaway-payment-stepup bucket", () => {
      expect(src).toMatch(/makeLayawayPaymentAction[\s\S]*?bucketKey:\s*["']layaway-payment-stepup["']/);
    });
  });

  describe("R45-LOW: guardrails.yml npm audit blocks (no continue-on-error)", () => {
    const guard = readRoot(".github/workflows/guardrails.yml");
    it("npm audit step does not have continue-on-error: true", () => {
      const npmAuditBlock = guard.slice(guard.indexOf("npm audit (high/critical CVEs)"));
      const nextStep = npmAuditBlock.indexOf("\n      - name:", 50);
      const block = nextStep > 0 ? npmAuditBlock.slice(0, nextStep) : npmAuditBlock.slice(0, 500);
      expect(block).not.toMatch(/continue-on-error:\s*true/);
    });
  });

  describe("R45-LOW: revoke-all-sessions clears register cookies too", () => {
    const src = read("src/app/api/auth/revoke-all-sessions/route.ts");
    it("emits Set-Cookie for bupos_r + legacy register + device cookie", () => {
      expect(src).toMatch(/clearReg = \[`bupos_r=`/);
      expect(src).toMatch(/clearRegOld = \[`basicuniformpos_register_session=`/);
      expect(src).toMatch(/clearRegDev = \[`bupos_register_device=`/);
    });
  });

  describe("R45-LOW: migration 072 explicit BEGIN/COMMIT", () => {
    const mig = read("supabase/migrations/072_r44_cleanup.sql");
    it("starts with BEGIN and ends with COMMIT", () => {
      expect(mig).toMatch(/^BEGIN;$/m);
      expect(mig.trimEnd().endsWith("COMMIT;")).toBe(true);
    });
  });
});
