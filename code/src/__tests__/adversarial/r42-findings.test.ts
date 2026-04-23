/**
 * R42 regression tests. Pins the fixes for:
 *   R42-A: /api/returns PUT now dispenses money + takes advisory lock
 *   R42-B: layaway + behavior_flags employee FK → SET NULL migration
 *   R42-C: offline-sync free-item promo loop moved inside idempotency guard
 *   R42-E: constant-time OPS_CLEANUP_SECRET compare + ≥32-char length floor
 *   R42-F: RoleGate component removed
 *   R42-G: error boundaries never render error.message; use ErrorFallback
 *   R42-H: fork-PR gates + least-privilege token on deploy/guardrails
 *   R42-I: signInAdmin timing equalization on inactive/wrong-role branches
 *   R42-J: middleware CORS allowlist cleanup + password min aligned + display-token scope prefix
 *   R42-K: safeErr in step-up/register/admin action logging
 *   R42-L: pos_device_id + IDB cleanup on logout; PasswordGate focus trap
 *   R42-M: pay_in_outs / scheduled_shifts / time_off_requests RLS policies use direct org compare; register_quick_switch fallback filters by org
 *   R42-N: npm audit signatures in guardrails workflow
 *   R42-O: signup verification email via waitUntilOrAwait
 *   R42-P: admin makeLayawayPaymentAction cash writes pay_in_outs
 *   R42-Q: NoticeToaster sanitizes URL-param content
 *   R42-R: employee PUT isActive change requires step-up (forward-compat)
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const readRoot = (rel: string) => fs.readFileSync(path.resolve(REPO, "..", rel), "utf8");

describe("R42 audit fixes", () => {
  describe("R42-A: /api/returns PUT dispenses money + takes advisory lock", () => {
    const src = read("src/app/api/returns/route.ts");
    it("PUT takes pg_advisory_xact_lock on transaction_id", () => {
      // Lock acquired inside PUT before the dispensation logic runs.
      expect(src).toMatch(/pg_advisory_xact_lock[\s\S]*?return:\$\{[\s\S]*?transaction_id/);
    });
    it("PUT dispenses cash via negative tender (+ conditional pay_out for cross-shift)", () => {
      // R43-C1: the pay_out INSERT was wrong (literal 'out' violated
      // CHECK constraint, AND double-counted with shift-close's
      // cashSales SUM which already includes negative tender rows).
      // Only the negative tender row is written for SAME-shift refunds.
      // R44-C1: re-added a CONDITIONAL pay_out when the original sale
      // is in a different register session (cross-shift refund) —
      // shift-close's cashSales aggregate doesn't see those negative
      // tenders, so a pay_out row is required to reflect the outflow.
      expect(src).toMatch(/transaction_tenders[\s\S]*?-refundAmount/);
      // The PUT section DOES have an INSERT INTO pay_in_outs now,
      // gated by the cross-shift check.
      expect(src).toMatch(/isCrossShift[\s\S]*?INSERT INTO pay_in_outs/);
    });
    it("PUT dispenses store_credit via ledger + balance UPDATE", () => {
      expect(src).toMatch(/store_credit_ledger[\s\S]*?'refund'/);
      expect(src).toMatch(/UPDATE customers SET store_credit_balance/);
    });
    it("PUT rejects cash refund when no open shift at location", () => {
      expect(src).toMatch(/Cash refund requires an open shift/);
    });
    it("PUT reverses loyalty via cumulative-share pattern", () => {
      expect(src).toMatch(/newCumulativeShare/);
      expect(src).toMatch(/priorExpectedReverse/);
    });
    it("POST rejects unsupported refund methods (exchange, unknown)", () => {
      expect(src).toMatch(/Unsupported refund method/);
    });
    it("POST caps cash/card refund at available refundable tender", () => {
      expect(src).toMatch(/exceeds remaining refundable amount/);
    });
  });

  describe("R42-B: employee FK SET NULL migration", () => {
    const mig = read("supabase/migrations/070_r42_cascade_fixes.sql");
    it("migration 070 targets layaways + layaway_payments + behavior_flags", () => {
      expect(mig).toMatch(/'layaways'/);
      expect(mig).toMatch(/'layaway_payments'/);
      expect(mig).toMatch(/'behavior_flags'/);
    });
    it("migration rewires constraint to ON DELETE SET NULL", () => {
      expect(mig).toMatch(/ON DELETE SET NULL/);
    });
  });

  describe("R42-C: offline-sync promo loop inside idempotency guard", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    it("promo loop documented as moved inside idempotency guard", () => {
      expect(src).toMatch(/R42-C/);
      expect(src).toMatch(/MOVED INSIDE/);
    });
    it("explicit end-of-if marker for the guarded block", () => {
      expect(src).toMatch(/end of `if \(!isAlreadySynced\)`/);
    });
  });

  describe("R42-E: OPS_CLEANUP_SECRET constant-time compare + length floor", () => {
    const src = read("src/app/api/internal/run-cleanup/route.ts");
    it("uses a constant-time byte-compare helper", () => {
      expect(src).toMatch(/function bearerMatches/);
      expect(src).toMatch(/new TextEncoder\(\)\.encode/);
      expect(src).toMatch(/diff \|= a\[i\] \^ b\[i\]/);
    });
    it("enforces ≥32 char secret length", () => {
      expect(src).toMatch(/opsSecret\.length\s*<\s*32/);
    });
    it("replaces plain !== comparisons with bearerMatches", () => {
      expect(src).toMatch(/bearerMatches\(authHeader/);
      expect(src).toMatch(/bearerMatches\(secret, opsSecret\)/);
    });
  });

  describe("R42-F: RoleGate component removed", () => {
    it("role-gate.tsx no longer exists", () => {
      const p = path.join(REPO, "src/components/admin/role-gate.tsx");
      expect(fs.existsSync(p)).toBe(false);
    });
    it("admin/audit/page.tsx no longer imports RoleGate", () => {
      const src = read("src/app/admin/audit/page.tsx");
      expect(src).not.toMatch(/from ['"]@\/components\/admin\/role-gate['"]/);
      expect(src).not.toMatch(/<RoleGate/);
    });
  });

  describe("R42-G: error boundaries use ErrorFallback + safeErr", () => {
    it("ErrorFallback shared component exists and uses safeErr", () => {
      const src = read("src/components/shared/error-fallback.tsx");
      expect(src).toMatch(/import { safeErr } from ['"]@\/lib\/logging\/safe-err['"]/);
      expect(src).toMatch(/error: safeErr\(error\)/);
      expect(src).not.toMatch(/\{error\.message\}/);
    });
    it("per-route error.tsx files delegate to ErrorFallback", () => {
      const routes = [
        "src/app/login/error.tsx",
        "src/app/settings/error.tsx",
        "src/app/sales/error.tsx",
        "src/app/pos/error.tsx",
        "src/app/customer-display/error.tsx",
        "src/app/dashboard/error.tsx",
        "src/app/products/error.tsx",
        "src/app/register/customer-display/error.tsx",
      ];
      for (const r of routes) {
        const src = read(r);
        expect(src, `${r} must import ErrorFallback`).toMatch(/import \{ ErrorFallback \}/);
        expect(src, `${r} must not render error.message`).not.toMatch(/\{error\.message/);
      }
    });
    it("admin, global, and register error boundaries use safeErr + generic copy", () => {
      for (const f of [
        "src/app/admin/error.tsx",
        "src/app/global-error.tsx",
        "src/app/register/error.tsx",
      ]) {
        const src = read(f);
        expect(src, `${f} must import safeErr`).toMatch(/import \{ safeErr \}/);
        expect(src, `${f} must log via safeErr`).toMatch(/error: safeErr\(error\)/);
        expect(src, `${f} must not render error.message`).not.toMatch(/\{error\.message/);
      }
    });
  });

  describe("R42-H: CI workflow fork-PR gates + least-privilege tokens", () => {
    const deploy = readRoot(".github/workflows/deploy.yml");
    const guard = readRoot(".github/workflows/guardrails.yml");
    it("deploy workflow has permissions: contents: read", () => {
      expect(deploy).toMatch(/permissions:[\s\S]*?contents:\s*read/);
    });
    it("deploy job gates on same-repo PR provenance", () => {
      expect(deploy).toMatch(/github\.event_name == 'pull_request' &&[\s\S]*?head\.repo\.full_name == github\.repository/);
    });
    it("guardrails workflow has permissions: contents: read", () => {
      expect(guard).toMatch(/permissions:[\s\S]*?contents:\s*read/);
    });
    it("guardrails jobs (check, integration, playwright) all gate on same-repo PR", () => {
      // The expression appears three times — once per job.
      const count = (guard.match(/head\.repo\.full_name == github\.repository/g) ?? []).length;
      expect(count).toBeGreaterThanOrEqual(3);
    });
  });

  describe("R42-I: signInAdmin timing equalization", () => {
    const src = read("src/lib/auth/session.ts");
    it("runDecoyVerify runs on inactive branch", () => {
      expect(src).toMatch(/is_active !== true\)[\s\S]*?runDecoyVerify/);
    });
    it("runDecoyVerify runs on wrong-role branch", () => {
      expect(src).toMatch(/\["owner", "manager"\]\.includes[\s\S]*?runDecoyVerify/);
    });
    it("fallback column-level path also equalizes timing", () => {
      expect(src).toMatch(/Column-level pool fallback[\s\S]*?R42-I[\s\S]*?runDecoyVerify/);
    });
  });

  describe("R42-J: middleware + password + display-token hardening", () => {
    it("middleware CORS allowlist drops bupos.basicuniform.com", () => {
      const src = read("middleware.ts");
      // The host must not appear inside an `allowedOrigins` array
      // entry. It can still appear in a comment as "removed" for
      // archaeology, so we constrain the check to the array literal.
      // Each allowedOrigins = [ ... ] block MUST NOT contain the host.
      const arrays = src.match(/allowedOrigins\s*=\s*\[[\s\S]*?\]/g) ?? [];
      expect(arrays.length).toBeGreaterThan(0);
      for (const arr of arrays) {
        expect(arr, `found in allowedOrigins: ${arr}`).not.toMatch(/bupos\.basicuniform\.com/);
      }
    });
    it("signupAction enforces 12-char minimum", () => {
      const src = read("src/app/actions/auth.ts");
      expect(src).toMatch(/password\.length\s*<\s*12/);
      expect(src).not.toMatch(/password\.length\s*<\s*8/);
    });
    it("display-token mint uses scope prefix + dual-verify preserved", () => {
      const src = read("src/lib/auth/display-token.ts");
      expect(src).toMatch(/SCOPE_PREFIX/);
      expect(src).toMatch(/display-token-v1/);
      expect(src).toMatch(/expectedSigV1[\s\S]*?expectedSigV0/);
    });
  });

  describe("R42-K: raw-err logging routed through safeErr", () => {
    it("step-up audit-fail log uses safeErr not err.message", () => {
      const src = read("src/lib/auth/step-up.ts");
      expect(src).toMatch(/error: safeErr\(err\)/);
      // The prior "message: err instanceof Error ? err.message : String(err)"
      // pattern should no longer be in step-up.
      expect(src).not.toMatch(/message:\s*err instanceof Error \? err\.message : String\(err\)/);
    });
    it("register openShiftAction logs via safeErr", () => {
      const src = read("src/app/register/actions.ts");
      expect(src).toMatch(/openShiftAction\] rpcOpenShift failed:['"], safeErr\(err\)\)/);
    });
    it("admin login audit payload reports classified reason, not raw err.message", () => {
      const src = read("src/app/admin/actions.ts");
      // The reason is computed as `const reason = … ? "invalid_credentials" : "internal_error"`
      // and the audit payload reads `{ email, reason }` — classified strings only.
      expect(src).toMatch(/["']invalid_credentials["']/);
      expect(src).toMatch(/["']internal_error["']/);
      // Ensure the prior-shape raw err.message leak into audit payload
      // is gone (would match `reason: err.message` literally).
      expect(src).not.toMatch(/reason:\s*err instanceof Error \? err\.message/);
    });
  });

  describe("R42-L: client-side identity cleanup on logout + focus trap", () => {
    it("register-client-reset module clears pos_device_id + IDB dead letters", () => {
      const src = read("src/lib/offline/register-client-reset.ts");
      expect(src).toMatch(/localStorage\.removeItem\(['"]pos_device_id['"]\)/);
      expect(src).toMatch(/getPendingTransactions/);
      expect(src).toMatch(/removePendingTransaction/);
    });
    it("register-console-client fires clearLocalRegisterState on logout submit", () => {
      const src = read("src/components/register/register-console-client.tsx");
      expect(src).toMatch(/clearLocalRegisterState/);
    });
    it("PasswordGate implements Tab focus trap", () => {
      const src = read("src/components/shared/password-gate.tsx");
      expect(src).toMatch(/e\.key === "Tab"/);
      expect(src).toMatch(/first\.focus\(\)/);
      expect(src).toMatch(/last\.focus\(\)/);
    });
  });

  describe("R42-M: RLS direct org compare + register_quick_switch org filter", () => {
    const mig = read("supabase/migrations/070_r42_cascade_fixes.sql");
    it("migration 070 rewrites pay_in_outs policy to ::uuid form", () => {
      expect(mig).toMatch(/pay_in_outs_tenant_access[\s\S]*?organization_id = current_setting[\s\S]*?::uuid/);
    });
    it("migration 070 rewrites scheduled_shifts policy to direct org compare", () => {
      expect(mig).toMatch(/scheduled_shifts_tenant_access/);
    });
    it("migration 070 rewrites time_off_requests policy to direct org compare", () => {
      expect(mig).toMatch(/time_off_requests_tenant_access/);
    });
    it("register_quick_switch fallback UPDATE filters by organization_id", () => {
      const src = read("src/app/register/actions.ts");
      expect(src).toMatch(/UPDATE sessions SET employee_id[\s\S]*?AND organization_id = \$3/);
      expect(src).toMatch(/UPDATE register_sessions SET employee_id[\s\S]*?AND organization_id = \$4/);
    });
  });

  describe("R42-N: npm audit signatures wired into CI", () => {
    const guard = readRoot(".github/workflows/guardrails.yml");
    it("guardrails invokes npm audit signatures", () => {
      expect(guard).toMatch(/npm audit signatures/);
    });
  });

  describe("R42-O: signup email via waitUntilOrAwait", () => {
    const src = read("src/app/actions/auth.ts");
    it("sendVerificationEmail is scheduled via waitUntilOrAwait", () => {
      expect(src).toMatch(/waitUntilOrAwait[\s\S]*?sendVerificationEmail/);
    });
  });

  describe("R42-P: admin layaway cash payment records pay_in_outs", () => {
    const src = read("src/app/admin/layaway-actions.ts");
    it("cash tender writes a pay_in row tied to the open shift", () => {
      expect(src).toMatch(/tenderType === ["']cash["']/);
      // R43-C2: literal must be `'pay_in'` to satisfy the CHECK
      // constraint. The shorter `'in'` form shipped in R42-P violated
      // SQLSTATE 23514 and bricked every cash layaway payment.
      expect(src).toMatch(/INSERT INTO pay_in_outs[\s\S]*?'pay_in'/);
    });
    it("refuses cash payment when no open shift exists", () => {
      expect(src).toMatch(/Cash layaway payment requires an open shift/);
    });
  });

  describe("R42-Q: NoticeToaster sanitizes URL-param content", () => {
    const src = read("src/components/notice-toaster.tsx");
    it("has a plain-text regex + blocked-pattern list", () => {
      expect(src).toMatch(/PLAIN_TEXT_PATTERN/);
      expect(src).toMatch(/BLOCKED_PATTERNS/);
    });
    it("blocks http/https URLs, phone numbers, and @ chars", () => {
      expect(src).toMatch(/https\?:\\\/\\\//);
      expect(src).toMatch(/\\d\{3\}\[-\.\\s\]/);
      expect(src).toMatch(/\/@\//);
    });
  });

  describe("R42-R: employee PUT isActive now gates to step-up", () => {
    const src = read("src/app/api/employees/route.ts");
    it("privilegedEdit includes isActive", () => {
      expect(src).toMatch(/privilegedEdit\s*=[\s\S]*?v\.data\.isActive !== undefined/);
    });
  });
});
