/**
 * R32 regression tests. Pins the round-32 deferred fixes + the audit
 * findings that surfaced when I re-audited R30/R31/R32 fixes.
 *
 * R32-D* = deferred from R31 (shift close race, cache scoping, token
 *          hashing, send-verification escape, audit peer filter,
 *          inventory_adjustments org_id, device cookie clear, safeErr
 *          DETAIL scrub, cf-ray trust, IDB TTL, SWR bound).
 * R32-X* = critical regressions found against R32-D fixes themselves.
 * R32-H* = high-severity findings from the full R32 audit sweep.
 * R32-M* = mediums.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R32 findings", () => {
  describe("R32-D1: shift close atomic (API route)", () => {
    const src = read("src/app/api/shift-close/route.ts");
    it("POST acquires shift-close advisory lock", () => {
      expect(src).toMatch(/pg_advisory_xact_lock[\s\S]*?`shift-close:\$\{shiftId\}`/);
    });
    it("FOR UPDATE the shift + register_sessions rows", () => {
      expect(src).toMatch(/SELECT status FROM shifts.*FOR UPDATE/);
      expect(src).toMatch(/SELECT id FROM register_sessions.*FOR UPDATE/);
    });
    it("buildZReport accepts external client", () => {
      expect(src).toMatch(/externalClient\?: ZReportClient/);
    });
  });

  describe("R32-X3: shift close atomic (closeShiftAction REGRESSION)", () => {
    const src = read("src/app/register/actions.ts");
    it("closeShiftAction also acquires shift-close advisory lock", () => {
      expect(src).toMatch(/pg_advisory_xact_lock[\s\S]*?`shift-close:\$\{shiftId\}`/);
    });
    it("commits shift close inline in one orgTx", () => {
      // The new shape should ROLLBACK on error + COMMIT on success
      // and include BOTH the shifts UPDATE and register_sessions end.
      expect(src).toMatch(/UPDATE shifts SET status = 'closed'/);
      expect(src).toMatch(/UPDATE register_sessions[\s\S]*?status = 'ended'/);
    });
  });

  describe("R32-D2: invalidateStoreCache requires orgId", () => {
    const src = read("src/lib/persistence/postgres-read-store.ts");
    it("signature requires orgId", () => {
      expect(src).toMatch(/export function invalidateStoreCache\(orgId: string\)/);
    });
    it("separate _forceInvalidateAllStoreCache for ops use", () => {
      expect(src).toMatch(/_forceInvalidateAllStoreCache/);
    });
    it("no-arg callers updated (login/register-login/session)", () => {
      const auth = read("src/lib/auth/session.ts");
      expect(auth).not.toMatch(/invalidateStoreCache\(\);/);
      const login = read("src/app/api/auth/login/route.ts");
      expect(login).toMatch(/invalidateStoreCache\(organizationId\)/);
    });
  });

  describe("R32-D3 + R32-X4: token hashing + pgcrypto", () => {
    const mig = read("supabase/migrations/062_r32_hash_tokens_at_rest.sql");
    it("creates pgcrypto extension", () => {
      expect(mig).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/);
    });
    it("renames columns to *_hash", () => {
      expect(mig).toMatch(/RENAME COLUMN verification_token TO verification_token_hash/);
      expect(mig).toMatch(/RENAME COLUMN token TO token_hash/);
    });
    it("auth.ts + verify + reset flows hash before insert/compare", () => {
      expect(read("src/app/actions/auth.ts")).toMatch(/sha256Hex\(verificationToken\)/);
      expect(read("src/app/api/auth/verify/route.ts")).toMatch(/verification_token_hash = \$1/);
      expect(read("src/app/api/auth/password-reset-confirm/route.ts")).toMatch(/token_hash = \$1/);
    });
    it("sha256Hex helper exposed", () => {
      expect(read("src/lib/auth/crypto.ts")).toMatch(/export async function sha256Hex/);
    });
  });

  describe("R32-D4: send-verification uses shared escapeHtml", () => {
    const src = read("src/lib/email/send-verification.ts");
    it("imports from @/lib/format/html-escape", () => {
      expect(src).toMatch(/from "@\/lib\/format\/html-escape"/);
    });
    it("removes inline escapeHtml", () => {
      expect(src).not.toMatch(/function escapeHtml/);
    });
  });

  describe("R32-D5: audit.view peer filter restrict", () => {
    const src = read("src/app/api/audit/route.ts");
    it("non-managers cannot filter by another employee_id", () => {
      expect(src).toMatch(/Only managers can filter audit events by another employee/);
    });
  });

  describe("R32-D6: inventory_adjustments.organization_id", () => {
    const mig = read("supabase/migrations/063_r32_d6_inventory_adjustments_org_id.sql");
    it("adds column + FK + backfill", () => {
      expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS organization_id/);
      expect(mig).toMatch(/inventory_adjustments_organization_id_fkey/);
    });
    it("every INSERT site carries organization_id", () => {
      for (const rel of [
        "src/lib/persistence/postgres-store.ts",
        "src/app/register/checkout-action.ts",
        "src/app/admin/stocktake-actions.ts",
        "src/app/api/receiving/route.ts",
        "src/app/api/offline-sync/route.ts",
      ]) {
        const src = read(rel);
        expect(src).toMatch(/INSERT INTO inventory_adjustments[\s\S]*?organization_id/);
      }
    });
  });

  describe("R32-D7: legacy unsigned device cookie auto-clear", () => {
    const src = read("src/lib/auth/session.ts");
    it("jar.delete on verify miss", () => {
      expect(src).toMatch(/jar\.delete\("bupos_register_device"\)/);
    });
  });

  describe("R32-D8: safeErr DETAIL scrub", () => {
    const src = read("src/lib/logging/safe-err.ts");
    it("scrubPgDetail strips DETAIL fragment + Key (…)=(…)", () => {
      expect(src).toMatch(/scrubPgDetail/);
      expect(src).toMatch(/DETAIL:/);
      expect(src).toMatch(/Key \(\S\)=\(\S\)/);
    });
  });

  describe("R32-D9: x-request-id requires cf-connecting-ip", () => {
    const src = read("src/lib/api/with-auth.ts");
    it("both CF headers required for cf-ray trust", () => {
      expect(src).toMatch(/cf-connecting-ip/);
      expect(src).toMatch(/if \(cfRay && cfConnecting\)/);
    });
  });

  describe("R32-D10: IDB dead-letter TTL", () => {
    const src = read("src/lib/offline/idb-store.ts");
    it("purgeStaleDeadLetters helper exported", () => {
      expect(src).toMatch(/export async function purgeStaleDeadLetters/);
    });
    it("use-online-status invokes purge on reconnect", () => {
      expect(read("src/lib/offline/use-online-status.ts")).toMatch(/purgeStaleDeadLetters/);
    });
  });

  describe("R32-D11: SWR stale-cache freshness bound", () => {
    const src = read("src/lib/persistence/postgres-read-store.ts");
    it("MAX_STALE_WAIT_MS gate", () => {
      expect(src).toMatch(/MAX_STALE_WAIT_MS/);
    });
  });

  describe("R32-X1+X2: PIN UX accepts 4-6 digits", () => {
    it("pin-login-form maxLength=6 + slice(0, 6)", () => {
      const src = read("src/components/register/pin-login-form.tsx");
      expect(src).toMatch(/maxLength=\{6\}/);
      expect(src).toMatch(/slice\(0, 6\)/);
    });
    it("approval-modal accepts 4-6 + 6 PIN dots", () => {
      const src = read("src/components/register/approval-modal.tsx");
      expect(src).toMatch(/pin\.length < 4 \|\| pin\.length > 6/);
      expect(src).toMatch(/\[0, 1, 2, 3, 4, 5\]\.map/);
    });
  });

  describe("R32-X5: race-fuzz test uses renamed columns", () => {
    const src = read("src/__tests__/integration/race-fuzz.test.ts");
    it("no references to old column names", () => {
      expect(src).not.toMatch(/verification_token[,\s)]/);
    });
    it("uses verification_token_hash", () => {
      expect(src).toMatch(/verification_token_hash/);
    });
  });

  describe("R32-H6: register refund $0 overridePrice lines", () => {
    const src = read("src/app/register/return-action.ts");
    it("refund reducer skips $0 overridePrice lines", () => {
      expect(src).toMatch(/origFromSnapshot\.overridePrice \?\? origFromSnapshot\.unitPrice\) === 0/);
    });
  });

  describe("R32-H7: layaway cancel advisory lock", () => {
    const src = read("src/app/admin/layaway-actions.ts");
    it("acquires layaway-cancel advisory lock", () => {
      expect(src).toMatch(/pg_advisory_xact_lock[\s\S]*?`layaway-cancel:\$\{layawayId\}`/);
    });
  });

  describe("R32-H8: /api/returns POST idempotent + 0.5 tax cap", () => {
    const src = read("src/app/api/returns/route.ts");
    it("honors Idempotency-Key header", () => {
      expect(src).toMatch(/Idempotency-Key/);
      expect(src).toMatch(/_idempotent: true/);
    });
    it("idempotency_key flows into returns INSERT", () => {
      expect(src).toMatch(/idempotency_key\)\s*VALUES/);
    });
    it("caps the effective tax rate at 0.5", () => {
      // R37-H2 swapped the denominator from `origSubtotal` to
      // `origTaxableBase` (= subtotal + modifiers) so refunds correctly
      // include modifier upcharges the customer paid. The 0.5 cap
      // invariant this test was originally about is unchanged.
      expect(src).toMatch(/Math\.min\(0\.5, Math\.max\(0, origTax \/ origTaxableBase\)\)/);
    });
  });

  describe("R32-H9: offline sync ordering + capture-time employee", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    it("CONCURRENCY = 1 serial sync", () => {
      const svc = read("src/lib/offline/sync-service.ts");
      expect(svc).toMatch(/const CONCURRENCY = 1/);
    });
    it("sessionEmployeeId = capturedEmployeeId (from cart, not cookie)", () => {
      expect(src).toMatch(/capturedEmployeeId = \(cart\.employeeId/);
      expect(src).toMatch(/const sessionEmployeeId = capturedEmployeeId/);
    });
  });

  describe("R32-H10: step-up auth on financial routes + employees PUT", () => {
    it("shared requireStepUp helper exists", () => {
      const src = read("src/lib/auth/step-up.ts");
      expect(src).toMatch(/export async function requireStepUp/);
    });
    it("store-credit POST requires step-up", () => {
      const src = read("src/app/api/store-credit/route.ts");
      expect(src).toMatch(/requireStepUp/);
    });
    it("gift-cards activate + reload require step-up", () => {
      const src = read("src/app/api/gift-cards/route.ts");
      const hits = src.match(/requireStepUp/g) ?? [];
      expect(hits.length).toBeGreaterThanOrEqual(2);
    });
    it("loyalty POST requires step-up on positive adjustment", () => {
      const src = read("src/app/api/loyalty/route.ts");
      expect(src).toMatch(/requireStepUp/);
    });
    it("employees PUT requires step-up on privileged edits", () => {
      const src = read("src/app/api/employees/route.ts");
      expect(src).toMatch(/privilegedEdit/);
    });
  });

  describe("R32-H11: email-receipt subject CRLF strip", () => {
    const src = read("src/app/api/email-receipt/route.ts");
    it("strips control chars from storeName before interpolating", () => {
      // R33-M-email-subj-unicode widened the regex to \p{C}\p{Cf}
      // (Unicode control + format chars) so the test now asserts
      // the broader regex, not the narrower ASCII-only one.
      expect(src).toMatch(/\\p\{C\}\\p\{Cf\}/);
    });
  });

  describe("R32-H12: migration 061 verify-before-index", () => {
    const mig = read("supabase/migrations/061_r31_schema_hardening.sql");
    it("verification block runs BEFORE CREATE UNIQUE INDEX", () => {
      const verifyIdx = mig.indexOf("Pre-index verification");
      const firstUnique = mig.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS uniq_promo_redemptions_promo_txn");
      expect(verifyIdx).toBeGreaterThan(-1);
      expect(firstUnique).toBeGreaterThan(verifyIdx);
    });
    it("RAISE EXCEPTION on duplicate slugs + return numbers", () => {
      expect(mig).toMatch(/RAISE EXCEPTION 'Schema-M3:/);
    });
  });

  describe("R32-H13 + cleanup cron: migration 064", () => {
    const mig = read("supabase/migrations/064_r32_followups.sql");
    it("rewrites inventory_adjustments RLS to pivot on organization_id", () => {
      expect(mig).toMatch(/inventory_adjustments_org_isolation/);
      expect(mig).toMatch(/DROP POLICY parent_org_isolation/);
    });
    it("adds SET search_path to audit tamper + tender-sum functions", () => {
      // R36-deploy: `ALTER FUNCTION IF EXISTS` is NOT valid PostgreSQL
      // syntax (IF EXISTS works on DROP, not ALTER). The migration now
      // wraps both ALTERs in a DO block with an explicit pg_proc
      // existence check; semantics are the same (conditional ALTER on
      // existence), shape is different. Test against the new shape.
      expect(mig).toMatch(/IF EXISTS \(SELECT 1 FROM pg_proc WHERE proname = 'audit_events_prevent_tamper'\)[\s\S]*?ALTER FUNCTION public\.audit_events_prevent_tamper\(\) SET search_path/);
      expect(mig).toMatch(/IF EXISTS \(SELECT 1 FROM pg_proc WHERE proname = 'check_tender_sum_fn'\)[\s\S]*?ALTER FUNCTION public\.check_tender_sum_fn\(\) SET search_path/);
    });
    it("run_nightly_cleanup orchestrator exists", () => {
      expect(mig).toMatch(/CREATE OR REPLACE FUNCTION public\.run_nightly_cleanup/);
    });
    it("scheduled cleanup is wired via pg_cron (R33-C1 replacement)", () => {
      // Prior R32-cron-trigger used wrangler.jsonc, but OpenNext
      // doesn't synthesize a `scheduled` handler so the trigger
      // never fired. R33 moved the schedule into Postgres pg_cron
      // via migration 065. The wrangler entry was removed.
      const mig = read("supabase/migrations/065_r33_pg_cron_cleanup.sql");
      expect(mig).toMatch(/cron\.schedule\(/);
    });
    it("internal/run-cleanup route exists", () => {
      expect(read("src/app/api/internal/run-cleanup/route.ts")).toMatch(/run_nightly_cleanup/);
    });
  });

  describe("R32-M: misc medium fixes", () => {
    it("reports hourly filters status='completed'", () => {
      expect(read("src/app/api/reports/route.ts")).toMatch(/EXTRACT\(HOUR[\s\S]*?status = 'completed'/);
    });
    it("reports employee substitutes 'Former Employee'", () => {
      expect(read("src/app/api/reports/route.ts")).toMatch(/'Former Employee'/);
    });
    it("checkout threshold uses clamped discountAmount", () => {
      expect(read("src/app/register/checkout-action.ts")).toMatch(/clampedDiscountAmount/);
    });
    it("expenses POST writes expense_created audit", () => {
      expect(read("src/app/api/expenses/route.ts")).toMatch(/expense_created/);
    });
    it("health GET rate-limits per-IP", () => {
      expect(read("src/app/api/health/route.ts")).toMatch(/health-get:\$\{clientIp\}/);
    });
    it("PO GET drops numeric(12,2) cast on SUM aggregate", () => {
      expect(read("src/app/api/purchase-orders/route.ts")).toMatch(/SUM\(pol\.quantity_ordered \* pol\.unit_cost\), 0\) as total_cost/);
    });
  });
});
