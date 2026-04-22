/**
 * R33 regression tests. Pins the round-33 fixes from 6 parallel
 * audit agents covering:
 *   - R32 fix adversarial re-poke
 *   - Offline/sync/IDB/PWA
 *   - Migrations + deploy safety
 *   - Route-by-route API sweep
 *   - Permissions + step-up consistency
 *   - Frontend state + React concurrency
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R33 findings", () => {
  describe("R33-C1: cron delivered via pg_cron, not CF Worker", () => {
    it("migration 065 sets up pg_cron schedule", () => {
      const mig = read("supabase/migrations/065_r33_pg_cron_cleanup.sql");
      expect(mig).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_cron/);
      expect(mig).toMatch(/cron\.schedule\(\s*'bupos_nightly_cleanup'/);
    });
    it("wrangler no longer declares a broken cron trigger", () => {
      const wr = read("wrangler.jsonc");
      expect(wr).not.toMatch(/"triggers"[\s\S]*?"crons"[\s\S]*?\["0 7/);
    });
    it("/api/internal/run-cleanup rejects client-spoofed cf-cron header", () => {
      const src = read("src/app/api/internal/run-cleanup/route.ts");
      expect(src).not.toMatch(/const fromCron = !!req\.headers\.get\("cf-cron"\)/);
      expect(src).toMatch(/Bearer \$\{opsSecret\}/);
    });
  });

  describe("R33-C2: inventory_adjustments RLS no NULL bypass", () => {
    const mig = read("supabase/migrations/064_r32_followups.sql");
    it("USING clause drops IS NULL branch", () => {
      // The new policy is symmetric: USING matches org_id, not NULL.
      const policyBlock = mig.slice(mig.indexOf("CREATE POLICY inventory_adjustments_org_isolation"));
      expect(policyBlock.slice(0, 500)).not.toMatch(/organization_id IS NULL OR/);
    });
  });

  describe("R33-H1: offline fallback only on network error", () => {
    const src = read("src/components/register/usePOSTerminal.ts");
    it("catch branch distinguishes network from validation errors", () => {
      expect(src).toMatch(/isLikelyNetworkError/);
      expect(src).toMatch(/TypeError/);
      expect(src).toMatch(/"AbortError"/);
    });
  });

  describe("R33-H2: cross-employee cart reset on quick-switch", () => {
    const src = read("src/components/register/usePOSTerminal.ts");
    it("useEffect detects employee.id change and resets state", () => {
      expect(src).toMatch(/cart\.employeeId && cart\.employeeId !== employee\.id/);
      expect(src).toMatch(/setCart\(freshCart\(\)\);\s*\n\s*setApprovedExceptions\(\[\]\);/);
    });
  });

  describe("R33-H3: service worker no SHELL_URLS pre-cache", () => {
    const src = read("public/sw.js");
    it("cache name bumped to v3+", () => {
      // R40-7 bumped again to v4 when skipWaiting became opt-in. Any
      // v>=3 is acceptable — the concrete pin was tied to the R33
      // cache-eviction rollout, not an invariant forever.
      expect(src).toMatch(/CACHE_NAME = "basicuniformpos-v[3-9]"/);
    });
    it("install no longer actually calls cache.addAll(SHELL_URLS)", () => {
      // SHELL_URLS constant is gone; any remaining mention is in a comment.
      expect(src).not.toMatch(/^const SHELL_URLS /m);
    });
  });

  describe("R33-H4: pricing.manage gate on variant price/cost", () => {
    it("/api/products PUT checks pricing.manage for price/cost branch", () => {
      const src = read("src/app/api/products/route.ts");
      expect(src).toMatch(/hasPermission\(employee\.roleKey, "pricing\.manage"\)/);
      expect(src).toMatch(/Pricing changes require pricing\.manage/);
    });
    it("editVariantAction checks pricing.manage", () => {
      const src = read("src/app/admin/actions.ts");
      expect(src).toMatch(/hasPermission\(employee\.roleKey, "pricing\.manage"\)/);
      expect(src).toMatch(/Pricing\+changes\+require\+owner\+or\+manager\+role/);
    });
  });

  describe("R33-H5: step-up on cash refunds", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("requires step-up for cash/original_tender refunds", () => {
      expect(src).toMatch(/returns-process-stepup/);
      expect(src).toMatch(/refund_method === 'cash' \|\|/);
    });
  });

  describe("R33-H6: step-up on shift close (both routes)", () => {
    it("/api/shift-close POST requires step-up", () => {
      const src = read("src/app/api/shift-close/route.ts");
      expect(src).toMatch(/shift-close-stepup/);
    });
    it("/api/shift-report close_shift requires step-up", () => {
      const src = read("src/app/api/shift-report/route.ts");
      expect(src).toMatch(/shift-close-stepup/);
    });
  });

  describe("R33-H7: closeShiftAction re-reads active_shift_id under lock", () => {
    const src = read("src/app/register/actions.ts");
    it("FOR UPDATE on register_sessions and compares active_shift_id", () => {
      expect(src).toMatch(/SELECT active_shift_id FROM register_sessions/);
      expect(src).toMatch(/currentActiveShiftId !== shiftId/);
    });
  });

  describe("R33-H8: /api/returns POST idempotent replay includes full row", () => {
    const src = read("src/app/api/returns/route.ts");
    it("replay shape matches fresh create", () => {
      expect(src).toMatch(/return: existing\[0\],\s*\n\s*return_id:/);
    });
  });

  describe("R33-H9: origItems empty → refuse refund", () => {
    const src = read("src/app/register/return-action.ts");
    it("throws when PG path + no originalTransactionId", () => {
      expect(src).toMatch(/Original transaction id is required/);
    });
  });

  describe("R33-H10: step-up aggregate cross-bucket cap", () => {
    const src = read("src/lib/auth/step-up.ts");
    it("stepup-aggregate KV bucket exists", () => {
      expect(src).toMatch(/stepup-aggregate:\$\{actorId\}/);
    });
  });

  describe("R33-H11: layaway refund_cash FOR UPDATE SKIP LOCKED", () => {
    const src = read("src/app/admin/layaway-actions.ts");
    it("picks open shift with FOR UPDATE SKIP LOCKED", () => {
      expect(src).toMatch(/FOR UPDATE SKIP LOCKED/);
    });
  });

  describe("R33-M misc", () => {
    it("migration 062 uses pgcrypto WITH SCHEMA extensions + extensions.digest", () => {
      const mig = read("supabase/migrations/062_r32_hash_tokens_at_rest.sql");
      expect(mig).toMatch(/pgcrypto WITH SCHEMA extensions/);
      expect(mig).toMatch(/extensions\.digest/);
    });
    it("migration 062 column renames are idempotent (IF EXISTS guards)", () => {
      const mig = read("supabase/migrations/062_r32_hash_tokens_at_rest.sql");
      expect(mig).toMatch(/information_schema\.columns/);
    });
    it("audit_events has TRUNCATE trigger", () => {
      const mig = read("supabase/migrations/061_r31_schema_hardening.sql");
      expect(mig).toMatch(/BEFORE TRUNCATE ON audit_events/);
    });
    it("email-receipt storeName strips Unicode control + format chars", () => {
      const src = read("src/app/api/email-receipt/route.ts");
      expect(src).toMatch(/\\p\{C\}\\p\{Cf\}/);
    });
    it("imageUrlField schema blocks javascript:/data: URLs", () => {
      const src = read("src/lib/validation/schemas.ts");
      expect(src).toMatch(/imageUrl must be an https URL/);
      expect(src).toMatch(/imageUrl must not use javascript\/data\/vbscript\/file/);
    });
    it("pin-login-form has autoComplete off", () => {
      const src = read("src/components/register/pin-login-form.tsx");
      expect(src).toMatch(/autoComplete="off"/);
    });
    it("step-up helper emits step_up_verified audit event on success", () => {
      const src = read("src/lib/auth/step-up.ts");
      expect(src).toMatch(/step_up_verified/);
    });
    it("gift-cards step-up fires BEFORE role check (activate + reload)", () => {
      const src = read("src/app/api/gift-cards/route.ts");
      // The stepUp block appears BEFORE the role check in both branches.
      const activate = src.slice(src.indexOf('action === "activate"'), src.indexOf('action === "reload"'));
      const reload = src.slice(src.indexOf('action === "reload"'));
      for (const branch of [activate, reload]) {
        const stepUpIdx = branch.indexOf('requireStepUp');
        const roleIdx = branch.indexOf('requires owner or manager role');
        expect(stepUpIdx).toBeGreaterThan(-1);
        expect(roleIdx).toBeGreaterThan(-1);
        expect(stepUpIdx).toBeLessThan(roleIdx);
      }
    });
  });
});
