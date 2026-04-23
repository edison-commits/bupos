/**
 * R44 regression tests. Pins R44 audit-round fixes:
 *   R44-C1: admin cross-shift cash refund writes a conditional pay_out
 *           row. /api/returns PUT + /api/returns/process both gate on
 *           `orig_session !== current_shift_session`.
 *   R44-H:  tax-rate mutation requires step-up on /api/tax-config PUT,
 *           /api/settings PUT section=location (when taxRate is set),
 *           and updateLocationAction.
 *   R44-FE1: register_sign_out RPC path dropped; column-level path
 *            always runs (carries the audit_events emit).
 *   R44-MED: /api/returns/process writes audit_events on completion;
 *            /api/employees PATCH uses the shared requireStepUp helper;
 *            migration 072 drops duplicate org_isolation policies on
 *            scheduled_shifts + time_off_requests and reverts
 *            store_credit_ledger.customer_id to RESTRICT; makeLayaway
 *            PaymentAction uses FOR UPDATE SKIP LOCKED on the shift
 *            row and audits INSIDE the transaction.
 *   R44-FE2: sanitizeNotice applied to /, /register, /admin server
 *            pages' URL-param banners.
 *   R44-FE3: issueStoreCreditAction requires step-up and caps at 5k
 *            (matches REST mirror).
 *   R44-FE4: SW allowlist-based (public pages only).
 *   R44-FE5: pin-login-form renders hidden deviceId input
 *            unconditionally.
 *   R44-FE6: register-client-reset imports idb-store statically.
 *   R44-FE7: theme-toggle span uses suppressHydrationWarning.
 *   R44-LOW: password-reset-initiate drops token_prefix from log;
 *            session.ts resolveSession employee + location SELECTs add
 *            organization_id filter; customers DELETE blocker subqueries
 *            add organization_id; login-form disables submit button
 *            synchronously in onSubmit; signup-form minLength=12;
 *            guardrails.yml runs `npm audit --audit-level=high`.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeNotice } from "@/lib/utils/sanitize-notice";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const readRoot = (rel: string) => fs.readFileSync(path.resolve(REPO, "..", rel), "utf8");

describe("R44 audit fixes", () => {
  describe("R44-C1: admin cross-shift cash refund conditional pay_out", () => {
    it("/api/returns PUT writes pay_in_outs only when origSession != openShift.register_session_id", () => {
      const src = read("src/app/api/returns/route.ts");
      expect(src).toMatch(/isCrossShift[\s\S]*?INSERT INTO pay_in_outs/);
      expect(src).toMatch(/origSessionId !== openShift\.register_session_id/);
      expect(src).toMatch(/'pay_out'/);
      // Rationale comment must mention cross-shift.
      expect(src).toMatch(/cross-shift/i);
    });
    it("/api/returns/process adds the same cross-shift logic", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/R44-C1/);
      expect(src).toMatch(/origSessionId !== openShift\.register_session_id/);
      expect(src).toMatch(/INSERT INTO pay_in_outs[\s\S]*?'pay_out'/);
    });
  });

  describe("R44-H: tax-rate mutation step-up", () => {
    it("/api/tax-config PUT calls requireStepUp with tax-rate-stepup bucket", () => {
      const src = read("src/app/api/tax-config/route.ts");
      expect(src).toMatch(/requireStepUp/);
      expect(src).toMatch(/bucketKey:\s*['"]tax-rate-stepup['"]/);
    });
    it("/api/settings PUT section=location gates step-up when taxRate is set", () => {
      const src = read("src/app/api/settings/route.ts");
      expect(src).toMatch(/taxRate.*!==.*undefined[\s\S]*?requireStepUp/);
      expect(src).toMatch(/bucketKey:\s*['"]tax-rate-stepup['"]/);
    });
    it("updateLocationAction server action gates step-up when taxRate is defined", () => {
      const src = read("src/app/admin/actions.ts");
      expect(src).toMatch(/taxRate !== undefined[\s\S]*?requireStepUp/);
      expect(src).toMatch(/bucketKey:\s*["']tax-rate-stepup["']/);
    });
  });

  describe("R44-FE1: register_sign_out RPC path dropped", () => {
    const src = read("src/lib/auth/session.ts");
    it("no `SELECT register_sign_out($1::text)` call remains", () => {
      expect(src).not.toMatch(/SELECT register_sign_out\(\$1::text\)/);
    });
    it("column-level path always runs (R44-FE1 comment present)", () => {
      expect(src).toMatch(/R44-FE1/);
      expect(src).toMatch(/column-level path/);
    });
  });

  describe("R44-MED: /api/returns/process audits return_completed", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("inserts an audit_events row before COMMIT", () => {
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'return_completed'[\s\S]*?COMMIT/);
    });
  });

  describe("R44-MED: /api/employees PATCH uses shared requireStepUp", () => {
    const src = read("src/app/api/employees/route.ts");
    it("PATCH handler imports requireStepUp and calls it with employees-patch-stepup", () => {
      expect(src).toMatch(/requireStepUp[\s\S]*?bucketKey:\s*['"]employees-patch-stepup['"]/);
    });
    it("no more inline pin-reset-stepup rate-limit block", () => {
      expect(src).not.toMatch(/pin-reset-stepup/);
    });
  });

  describe("R44-MED: migration 072 drops dup policies + restores store_credit RESTRICT", () => {
    const mig = read("supabase/migrations/072_r44_cleanup.sql");
    it("drops legacy org_isolation on scheduled_shifts + time_off_requests", () => {
      expect(mig).toMatch(/DROP POLICY IF EXISTS org_isolation ON scheduled_shifts/);
      expect(mig).toMatch(/DROP POLICY IF EXISTS org_isolation ON time_off_requests/);
    });
    it("reverts store_credit_ledger.customer_id to ON DELETE RESTRICT", () => {
      expect(mig).toMatch(/store_credit_ledger[\s\S]*?ON DELETE RESTRICT/);
    });
  });

  describe("R44-MED: makeLayawayPaymentAction hardening", () => {
    const src = read("src/app/admin/layaway-actions.ts");
    it("shift SELECT uses FOR UPDATE SKIP LOCKED", () => {
      expect(src).toMatch(/FOR UPDATE SKIP LOCKED/);
    });
    it("audit_events row is written INSIDE the transaction before COMMIT", () => {
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'layaway_payment'[\s\S]*?COMMIT/);
    });
    it("layaway SELECT now includes location_id so we can reuse it", () => {
      expect(src).toMatch(/SELECT id, status, balance_due, location_id FROM layaways/);
    });
  });

  describe("R44-FE2: sanitizeNotice helper + applied to server pages", () => {
    it("shared helper exists and exports sanitizeNotice", () => {
      const src = read("src/lib/utils/sanitize-notice.ts");
      expect(src).toMatch(/export function sanitizeNotice/);
      expect(src).toMatch(/\\p\{L\}\\p\{N\}/);
    });
    it("home page uses sanitizeNotice", () => {
      const src = read("src/app/page.tsx");
      expect(src).toMatch(/sanitizeNotice\(params\.error\)/);
      expect(src).toMatch(/sanitizeNotice\(params\.notice\)/);
    });
    it("/register page uses sanitizeNotice", () => {
      const src = read("src/app/register/page.tsx");
      expect(src).toMatch(/sanitizeNotice\(params\.error\)/);
    });
    it("/admin page uses sanitizeNotice", () => {
      const src = read("src/app/admin/page.tsx");
      expect(src).toMatch(/sanitizeNotice\(params\.notice\)/);
    });
    it("sanitizeNotice rejects URL-style + phone-style content", () => {
      expect(sanitizeNotice("Visit https://attacker.com for help")).toBeNull();
      expect(sanitizeNotice("Call 1-888-ATTACKER")).toBeNull();
      expect(sanitizeNotice("contact@attacker.com")).toBeNull();
      expect(sanitizeNotice("Shift closed — variance $0.05")).toBe("Shift closed — variance $0.05");
      expect(sanitizeNotice(undefined)).toBeNull();
    });
  });

  describe("R44-FE3: issueStoreCreditAction step-up + 5k cap", () => {
    const src = read("src/app/admin/store-credit-actions.ts");
    it("cap tightened to 5_000", () => {
      expect(src).toMatch(/MAX_STORE_CREDIT_ISSUANCE\s*=\s*5_000/);
    });
    it("calls requireStepUp with store-credit-stepup bucket", () => {
      expect(src).toMatch(/requireStepUp/);
      expect(src).toMatch(/bucketKey:\s*["']store-credit-stepup["']/);
    });
  });

  describe("R44-FE4: SW allowlist-based cache scope", () => {
    const src = read("public/sw.js");
    it("CACHE_NAME bumped to v5", () => {
      expect(src).toMatch(/basicuniformpos-v5/);
    });
    it("allowlist of public pages (not a blocklist of auth pages)", () => {
      expect(src).toMatch(/const publicPaths = \["\/", "\/login", "\/signup", "\/forgot-password"\]/);
      expect(src).toMatch(/isAuthenticatedPage = !isPublicPage/);
    });
  });

  describe("R44-FE5: pin-login-form hidden deviceId input unconditional", () => {
    const src = read("src/components/register/pin-login-form.tsx");
    it("renders <input name=\"deviceId\"> without a {deviceId ? : null} guard", () => {
      // The unconditional form should be present...
      expect(src).toMatch(/<input type="hidden" name="deviceId" value=\{deviceId\} \/>/);
      // ...and the conditional form should not.
      expect(src).not.toMatch(/\{deviceId \? <input type="hidden" name="deviceId"/);
    });
  });

  describe("R44-FE6: register-client-reset imports idb-store statically", () => {
    const src = read("src/lib/offline/register-client-reset.ts");
    it("static import at module top", () => {
      expect(src).toMatch(/^import \{ getPendingTransactions, removePendingTransaction \} from ['"]\.\/idb-store['"]/m);
    });
    it("no `await import(\"./idb-store\")` remains", () => {
      expect(src).not.toMatch(/await import\(["']\.\/idb-store["']\)/);
    });
  });

  describe("R44-FE7: theme-toggle suppressHydrationWarning", () => {
    const src = read("src/components/register/theme-toggle.tsx");
    it("span text nodes with derived state carry suppressHydrationWarning", () => {
      expect(src).toMatch(/suppressHydrationWarning/);
    });
  });

  describe("R44-LOW: password-reset-initiate drops token_prefix log field", () => {
    const src = read("src/app/api/auth/password-reset-initiate/route.ts");
    it("no `token_prefix: token.slice(0, 8)` remains", () => {
      expect(src).not.toMatch(/token_prefix:\s*token\.slice/);
    });
  });

  describe("R44-LOW: session.ts resolveSession org filters", () => {
    const src = read("src/lib/auth/session.ts");
    it("employee SELECT filters by id AND organization_id", () => {
      expect(src).toMatch(/FROM employees WHERE id = \$1 AND organization_id = \$2 AND is_active = true/);
    });
    it("location SELECT filters by id AND organization_id", () => {
      expect(src).toMatch(/FROM locations WHERE id = \$1 AND organization_id = \$2 AND is_active = true/);
    });
  });

  describe("R44-LOW: customers DELETE blocker subqueries are org-scoped", () => {
    const src = read("src/app/api/customers/route.ts");
    it("layaways subquery includes AND organization_id = $2", () => {
      expect(src).toMatch(/FROM layaways WHERE customer_id = \$1 AND organization_id = \$2/);
    });
    it("gift_cards subquery includes AND organization_id = $2", () => {
      expect(src).toMatch(/FROM gift_cards WHERE customer_id = \$1 AND organization_id = \$2/);
    });
  });

  describe("R44-LOW: login-form synchronous submit-button disable", () => {
    const src = read("src/components/auth/login-form.tsx");
    it("onSubmit mutates submitBtn.disabled synchronously", () => {
      expect(src).toMatch(/submitBtn\.disabled = true/);
      expect(src).toMatch(/if \(submitBtn\.disabled\) return/);
    });
  });

  describe("R44-LOW: signup-form minLength aligned to server's 12-char floor", () => {
    const src = read("src/components/auth/signup-form.tsx");
    it("minLength=12", () => {
      expect(src).toMatch(/minLength=\{12\}/);
      expect(src).not.toMatch(/minLength=\{8\}/);
    });
  });

  describe("R44-LOW: guardrails.yml runs npm audit --audit-level=high", () => {
    const guard = readRoot(".github/workflows/guardrails.yml");
    it("includes an npm audit CVE gate", () => {
      expect(guard).toMatch(/npm audit --audit-level=high/);
    });
  });
});
