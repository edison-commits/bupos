/**
 * R43 regression tests. Pins the fixes for the issues R42 introduced
 * and the new findings uncovered during round 2 of the audit loop:
 *   R43-C1: /api/returns PUT cash refund no longer writes a pay_out
 *           pay_in_outs row (the literal 'out' violated CHECK and
 *           the double-count with negative tender was wrong math)
 *   R43-C2: makeLayawayPaymentAction uses literal 'pay_in' (was 'in')
 *   R43-H3: /api/returns PUT + /api/returns/process loyalty reversal
 *           wrapped in SAVEPOINT sp_loyalty
 *   R43-H4: signupAction / loginAction (actions/auth.ts) stores
 *           classified reason, never raw err.message
 *   R43-H5: /api/returns PUT inserts audit_events row on completion
 *   R43-H6: register-console-client statically imports
 *           clearLocalRegisterState (no dynamic-import race with
 *           server-redirect)
 *   R43-H7: register-logout shift auto-close audits via audit_events
 *           instead of transaction_events (which rejected the shift
 *           id as a non-UUID)
 *   R43-M4: /api/returns/process loyalty priorReturnRows excludes self
 *   R43-M6: cash/card refund cap excludes 'loyalty' tender rows
 *   R43-M8: register_sessions.employee_id CASCADE → SET NULL
 *   R43-M9: store_credit_ledger/gift_card_transactions/layaway_payments
 *           parent FK CASCADE → SET NULL / RESTRICT
 *   R43-M10: duplicate pay_in_outs policy dropped
 *   R43-M: approval-modal + quick-switch-modal Tab focus trap
 *   R43-M: double-submit guard on register logout forms
 *   R43-M: offline-status-bar mount-guards on setState
 *   R43-M: structured warn log on 429 rate-limit denials
 *   R43-LOW: notice-toaster Unicode character class
 *   R43-LOW: deploy.yml migration probe uses ON_ERROR_STOP + numeric validation
 *   R43-LOW: pin-login-form deviceId lazy initialization
 *   R43-LOW: admin error-boundary consolidated into shared ErrorFallback
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const readRoot = (rel: string) => fs.readFileSync(path.resolve(REPO, "..", rel), "utf8");

describe("R43 audit fixes", () => {
  describe("R43-C1: /api/returns PUT cash refund uses negative tender (R44-C1 adds conditional cross-shift pay_out)", () => {
    const src = read("src/app/api/returns/route.ts");
    // R44-C1 re-added a CONDITIONAL pay_out row when the original sale
    // is in a different register session (cross-shift refund). So the
    // invariant R43-C1 asserted ("no pay_in_outs ever") doesn't hold
    // anymore — but the SPIRIT (no pay_in_outs for SAME-shift refunds)
    // does: the INSERT is gated by the isCrossShift predicate.
    it("PUT has a CONDITIONAL INSERT INTO pay_in_outs gated by cross-shift check", () => {
      expect(src).toMatch(/isCrossShift[\s\S]*?INSERT INTO pay_in_outs/);
    });
    it("PUT still writes a negative tender on cash refund", () => {
      const putSection = src.slice(src.indexOf("export const PUT"));
      expect(putSection).toMatch(/transaction_tenders[\s\S]*?-refundAmount/);
    });
    it("PUT still requires an open shift for cash refunds", () => {
      expect(src).toMatch(/Cash refund requires an open shift/);
    });
  });

  describe("R43-C2: layaway cash payment uses correct 'pay_in' literal", () => {
    const src = read("src/app/admin/layaway-actions.ts");
    it("INSERT INTO pay_in_outs uses literal 'pay_in' (CHECK-compliant)", () => {
      expect(src).toMatch(/INSERT INTO pay_in_outs[\s\S]*?'pay_in'/);
      // Assert the broken short form is absent.
      const caseStart = src.indexOf(`tenderType === "cash"`);
      const caseSection = caseStart >= 0 ? src.slice(caseStart, caseStart + 1500) : "";
      expect(caseSection).not.toMatch(/VALUES[\s\S]*?,\s*'in',/);
    });
  });

  describe("R43-H3: SAVEPOINT around loyalty reversal", () => {
    it("/api/returns PUT wraps loyalty in SAVEPOINT sp_loyalty", () => {
      const src = read("src/app/api/returns/route.ts");
      expect(src).toMatch(/SAVEPOINT sp_loyalty[\s\S]*?RELEASE SAVEPOINT sp_loyalty/);
      expect(src).toMatch(/ROLLBACK TO SAVEPOINT sp_loyalty/);
    });
    it("/api/returns/process wraps loyalty in SAVEPOINT sp_loyalty", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/SAVEPOINT sp_loyalty[\s\S]*?RELEASE SAVEPOINT sp_loyalty/);
      expect(src).toMatch(/ROLLBACK TO SAVEPOINT sp_loyalty/);
    });
  });

  describe("R43-H4: signupAction / loginAction audit never stores raw err.message", () => {
    const src = read("src/app/actions/auth.ts");
    it("audit payload uses classified reason strings", () => {
      expect(src).toMatch(/["']invalid_credentials["']/);
      expect(src).toMatch(/["']internal_error["']/);
    });
    it("admin_login_failed insertAudit does NOT pass err.message into payload", () => {
      expect(src).not.toMatch(/reason:\s*err instanceof Error \? err\.message/);
    });
  });

  describe("R43-H5: /api/returns PUT audits the status transition", () => {
    const src = read("src/app/api/returns/route.ts");
    it("inserts audit_events row on completion", () => {
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'return_completed'/);
    });
  });

  describe("R43-H6: register-console-client statically imports clearLocalRegisterState", () => {
    const src = read("src/components/register/register-console-client.tsx");
    it("static import at module top", () => {
      expect(src).toMatch(/^import \{ clearLocalRegisterState \} from ['"]@\/lib\/offline\/register-client-reset['"]/m);
    });
    it("no dynamic import of register-client-reset remains", () => {
      expect(src).not.toMatch(/import\(["']@\/lib\/offline\/register-client-reset/);
    });
  });

  describe("R43-H7: register-logout auto-close writes audit_events not transaction_events", () => {
    const src = read("src/lib/auth/session.ts");
    it("auto-close inserts into audit_events with shift entity_type", () => {
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'shift'[\s\S]*?'shift_auto_closed'/);
    });
    it("no stale INSERT INTO transaction_events with a synthesized 'txn_*' id remains", () => {
      expect(src).not.toMatch(/`txn_\$\{registerSession\.active_shift_id\}`/);
    });
  });

  describe("R43-M4: /api/returns/process loyalty priorReturnRows excludes self", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("priorReturnRows SELECT has AND id <> $3", () => {
      expect(src).toMatch(/FROM returns[\s\S]*?AND id <> \$3/);
    });
  });

  describe("R43-M6: cash/card refund cap excludes loyalty tender", () => {
    it("/api/returns POST cap excludes loyalty", () => {
      const src = read("src/app/api/returns/route.ts");
      expect(src).toMatch(/tender_type NOT IN \('gift_card', 'store_credit', 'loyalty'\)/);
    });
    it("/api/returns/process cap excludes loyalty", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/tender_type NOT IN \('gift_card', 'store_credit', 'loyalty'\)/);
    });
  });

  describe("R43-M8 + M9 + M10: migration 071 cleanup", () => {
    const mig = read("supabase/migrations/071_r43_cleanup.sql");
    it("drops duplicate pay_in_outs_org_isolation policy", () => {
      expect(mig).toMatch(/DROP POLICY IF EXISTS pay_in_outs_org_isolation ON pay_in_outs/);
    });
    it("rewires register_sessions.employee_id to SET NULL", () => {
      expect(mig).toMatch(/register_sessions[\s\S]*?ON DELETE SET NULL/);
    });
    it("rewires store_credit_ledger.customer_id to SET NULL", () => {
      expect(mig).toMatch(/store_credit_ledger[\s\S]*?ON DELETE SET NULL/);
    });
    it("rewires gift_card_transactions.gift_card_id to RESTRICT", () => {
      expect(mig).toMatch(/gift_card_transactions[\s\S]*?ON DELETE RESTRICT/);
    });
    it("rewires layaway_payments.layaway_id to RESTRICT", () => {
      expect(mig).toMatch(/layaway_payments[\s\S]*?ON DELETE RESTRICT/);
    });
  });

  describe("R43-M: modal focus traps + submit guards", () => {
    it("approval-modal has Tab focus trap", () => {
      const src = read("src/components/register/approval-modal.tsx");
      expect(src).toMatch(/e\.key === ["']Tab["']/);
      expect(src).toMatch(/first\.focus\(\)/);
      expect(src).toMatch(/last\.focus\(\)/);
    });
    it("quick-switch modal has Tab focus trap + role=dialog", () => {
      const src = read("src/components/register/register-console-client.tsx");
      // Quick-switch modal block should contain role=dialog and Tab handler.
      const block = src.slice(src.indexOf("Quick-switch PIN modal"));
      expect(block).toMatch(/role=["']dialog["']/);
      expect(block).toMatch(/e\.key === ["']Tab["']/);
    });
    it("logout forms disable submit button synchronously in onSubmit", () => {
      const src = read("src/components/register/register-console-client.tsx");
      expect(src).toMatch(/btn\.disabled = true/);
    });
  });

  describe("R43-M: offline-status-bar mount-guard", () => {
    const src = read("src/components/register/offline-status-bar.tsx");
    it("uses mountedRef in useEffect + setState callsites", () => {
      expect(src).toMatch(/const mountedRef = useRef\(true\)/);
      expect(src).toMatch(/if \(mountedRef\.current\) setPendingCount/);
    });
  });

  describe("R43-M: 429 rate-limit structured warn log", () => {
    it("logRateLimited helper exists", () => {
      const src = read("src/lib/logging/rate-limit-log.ts");
      expect(src).toMatch(/export function logRateLimited/);
      expect(src).toMatch(/event: ["']rate_limited["']/);
    });
    it("login route emits logRateLimited on all three 429 branches", () => {
      const src = read("src/app/api/auth/login/route.ts");
      const count = (src.match(/logRateLimited\(\{/g) ?? []).length;
      expect(count).toBeGreaterThanOrEqual(3);
    });
    it("register-login rate-limit gate emits logRateLimited on all 6 layers", () => {
      // AUTH-AUDIT6-HIGH1: the 6-layer PIN-login rate-limit stack (and its
      // per-denial telemetry) moved into the shared
      // `enforceRegisterPinRateLimits` gate, shared by the HTTP route AND
      // the production registerLoginAction Server Action. Count the
      // logRateLimited calls in the gate.
      const gate = read("src/lib/auth/register-pin-rate-limit.ts");
      const count = (gate.match(/logRateLimited\(\{/g) ?? []).length;
      expect(count).toBeGreaterThanOrEqual(6);
      // And the route must route through that gate.
      const route = read("src/app/api/auth/register-login/route.ts");
      expect(route).toMatch(/enforceRegisterPinRateLimits\(/);
    });
  });

  describe("R43-LOW / R45-M: notice-toaster accepts Unicode (via shared helper)", () => {
    // R45-M: the inline sanitizer was replaced with an import from
    // `@/lib/utils/sanitize-notice`. Assert the rules on the shared
    // helper source.
    const sharedSrc = read("src/lib/utils/sanitize-notice.ts");
    it("uses \\p{L}\\p{N}\\p{P}\\p{Z}\\p{S} Unicode character classes with /u flag", () => {
      expect(sharedSrc).toMatch(/\\p\{L\}\\p\{N\}/);
      expect(sharedSrc).toMatch(/}\]\{1,200\}\$\/u/);
    });
    it("still blocks http/www/phone/email/angle-bracket patterns", () => {
      expect(sharedSrc).toMatch(/BLOCKED_PATTERNS/);
    });
  });

  describe("R43-LOW: deploy.yml migration probe has ON_ERROR_STOP + numeric guard", () => {
    const deploy = readRoot(".github/workflows/deploy.yml");
    it("applied=psql invocation includes -v ON_ERROR_STOP=1", () => {
      expect(deploy).toMatch(/applied=\$\(psql "\$DB_URL" -v ON_ERROR_STOP=1 -tAc/);
    });
    it("validates \\$applied matches numeric regex before branching", () => {
      expect(deploy).toMatch(/\$applied.*=~.*\^\[0-9\]\+\$/);
    });
  });

  describe("R43-LOW: pin-login-form deviceId (hydration-safe)", () => {
    const src = read("src/components/register/pin-login-form.tsx");
    // R43-fix: reverted from lazy init to useEffect-set because the lazy
    // initializer diverges SSR (returns "") from client first render
    // (returns uuid), triggering React hydration error #418. The
    // server-side register-login route synthesizes a device id when
    // missing, so the theoretical race is benign.
    it("uses useState(\"\") + useEffect pattern (avoids hydration mismatch)", () => {
      expect(src).toMatch(/useState<string>\(""\)/);
      expect(src).toMatch(/useEffect\(\(\) => \{\s*setDeviceId\(getDeviceId\(\)\)/);
    });
  });

  describe("R43-LOW: admin error-boundary consolidated into shared ErrorFallback", () => {
    const src = read("src/components/admin/error-boundary.tsx");
    it("AdminErrorBoundary is a thin wrapper that delegates to ErrorFallback", () => {
      expect(src).toMatch(/import \{ ErrorFallback \} from ['"]@\/components\/shared\/error-fallback['"]/);
      expect(src).toMatch(/<ErrorFallback /);
      // No direct safeErr import / useEffect logger — that's delegated now.
      expect(src).not.toMatch(/useEffect/);
    });
  });
});
