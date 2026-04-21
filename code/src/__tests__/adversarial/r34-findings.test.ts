/**
 * R34 regression tests. Pins the R33-deferred fixes landed this round.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R34 findings", () => {
  describe("R34-D1: hard-deleted employees surface as 'Former Employee'", () => {
    const src = read("src/app/api/reports/route.ts");
    it("employee report uses LEFT JOIN + NULL-safe CASE", () => {
      expect(src).toMatch(/LEFT JOIN employees e ON e\.id = t\.employee_id AND e\.organization_id = \$1/);
      expect(src).toMatch(/WHEN e\.id IS NULL THEN 'Former Employee'/);
    });
  });

  describe("R34-D2: /api/loyalty GET strips PII for non-managers", () => {
    const src = read("src/app/api/loyalty/route.ts");
    it("managers get email/phone/store_credit_balance; others don't", () => {
      expect(src).toMatch(/const isManager = ctx\.employee\.roleKey === "owner" \|\| ctx\.employee\.roleKey === "manager"/);
      expect(src).toMatch(/customer = isManager \? customerFull : \{/);
    });
  });

  describe("R34-D3: dashboard employeePerformance gated", () => {
    const src = read("src/app/api/dashboard/route.ts");
    it("non-managers get empty array", () => {
      expect(src).toMatch(/employeePerformance: isManager \? employeeResult\.rows : \[\]/);
    });
  });

  describe("R34-D4: Infinity/NaN guard on discountAmount", () => {
    it("cart.ts uses Number.isFinite", () => {
      expect(read("src/lib/cart/cart.ts")).toMatch(/Number\.isFinite\(rawCartDiscount\)/);
    });
    it("checkout-action.ts uses Number.isFinite", () => {
      expect(read("src/app/register/checkout-action.ts")).toMatch(/Number\.isFinite\(rawDiscountAmount\)/);
    });
    it("offline-sync uses Number.isFinite", () => {
      expect(read("src/app/api/offline-sync/route.ts")).toMatch(/Number\.isFinite\(rawDiscountAmount\)/);
    });
  });

  describe("R34-D5: adjustInventoryAction step-up on high deltas", () => {
    const src = read("src/app/admin/actions.ts");
    it("requires step-up above HIGH_DELTA threshold", () => {
      expect(src).toMatch(/HIGH_DELTA_MANAGER = 5_000/);
      expect(src).toMatch(/HIGH_DELTA_CLERK = 500/);
      expect(src).toMatch(/inventory-adjust-stepup/);
    });
  });

  describe("R34-D6: sync-service scrubs lastError before IDB write", () => {
    const src = read("src/lib/offline/sync-service.ts");
    it("strips DETAIL, Key fragments, emails, phones", () => {
      expect(src).toMatch(/\\s\*DETAIL:.\*\$/);
      expect(src).toMatch(/\[email\]/);
      expect(src).toMatch(/\[phone\]/);
    });
  });

  describe("R34-D7: approval modal re-entry + unmount guards", () => {
    const src = read("src/components/register/approval-modal.tsx");
    it("submitInFlightRef gates double-tap", () => {
      expect(src).toMatch(/submitInFlightRef/);
    });
    it("mountedRef prevents setState on unmounted modal", () => {
      expect(src).toMatch(/mountedRef/);
    });
  });

  describe("R34-D8: /api/reports rate-limited", () => {
    const src = read("src/app/api/reports/route.ts");
    it("checkRateLimit on reports:<org>:<actor>", () => {
      expect(src).toMatch(/checkRateLimit\(`reports:/);
    });
  });

  describe("R34-D9 + R36-H4: offline sync rejects deactivated capture-time employee", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    it("SELECTs is_active + rejects on deactivated (R36-H4 upgraded from warn→reject)", () => {
      expect(src).toMatch(/SELECT is_active FROM employees/);
      // R36-H4 tightened the policy: offline sales from a now-deactivated
      // capture-time employee are REFUSED (sync rejected), not warn-accepted.
      // A fired cashier's offline-capable device can no longer keep
      // submitting fraudulent sales after termination.
      expect(src).toMatch(/sync rejected/);
      expect(src).toMatch(/A manager must manually re-enter this sale/);
      // And the old accept-warn path must not silently creep back in.
      expect(src).not.toMatch(/sync accepted but flagging/);
    });
  });

  describe("R34-D10: BroadcastChannel exponential-backoff (no permanent disable)", () => {
    const src = read("src/components/register/usePOSTerminal.ts");
    it("_customerDisplayLastFailureAt drives retry", () => {
      expect(src).toMatch(/_customerDisplayLastFailureAt/);
      expect(src).toMatch(/_CUSTOMER_DISPLAY_BACKOFF_MS/);
    });
    it("no _customerDisplayInitFailed permanent latch", () => {
      expect(src).not.toMatch(/_customerDisplayInitFailed = true/);
    });
  });

  describe("R34-D11: customer database admin fetch AbortController", () => {
    const src = read("src/components/admin/customer-database.tsx");
    it("uses AbortController on fetch", () => {
      expect(src).toMatch(/fetchAbortRef/);
      expect(src).toMatch(/ctrl\.signal/);
    });
  });

  describe("R34-D12: audit_events_prevent_tamper has SET search_path", () => {
    const mig = read("supabase/migrations/061_r31_schema_hardening.sql");
    it("SET search_path = public on the trigger fn", () => {
      const fnBlock = mig.slice(mig.indexOf("CREATE OR REPLACE FUNCTION audit_events_prevent_tamper"));
      expect(fnBlock.slice(0, 300)).toMatch(/SET search_path = public/);
    });
  });

  describe("R34-D13: JOIN defense-in-depth", () => {
    it("/api/receiving products + inventory_levels gated", () => {
      const src = read("src/app/api/receiving/route.ts");
      expect(src).toMatch(/JOIN products p ON pv\.product_id = p\.id AND p\.organization_id = \$1/);
      expect(src).toMatch(/il\.organization_id = \$1/);
    });
    it("reports shiftSummary gates employees + transactions", () => {
      const src = read("src/app/api/reports/route.ts");
      expect(src).toMatch(/LEFT JOIN employees e ON e\.id = s\.employee_id AND e\.organization_id = \$4/);
      expect(src).toMatch(/LEFT JOIN transactions t[\s\S]*?AND t\.organization_id = \$4/);
    });
  });

  describe("R34-D14: /api/returns/search explicit column list", () => {
    const src = read("src/app/api/returns/search/route.ts");
    it("SELECT names the columns (no `SELECT t.*` in executable SQL)", () => {
      // Only the commented historical reference remains; match the
      // explicit column list instead.
      expect(src).toMatch(/SELECT t\.id, t\.status, t\.tender_type/);
      // Assert at most ONE mention (the comment), not SQL.
      const hits = src.match(/SELECT t\.\*/g) ?? [];
      expect(hits.length).toBeLessThanOrEqual(1);
    });
    it("employees + customers JOINs gated by org", () => {
      expect(src).toMatch(/LEFT JOIN employees e[\s\S]*?AND e\.organization_id = \$2/);
      expect(src).toMatch(/LEFT JOIN customers c[\s\S]*?AND c\.organization_id = \$2/);
    });
  });

  describe("R34-D16: useOnlineStatus interval refresh + status-bar timeout cleanup", () => {
    it("interval depends on isOnline", () => {
      const src = read("src/lib/offline/use-online-status.ts");
      expect(src).toMatch(/pollMs = isOnline \? 30_000 : 60_000/);
      expect(src).toMatch(/\}, \[checkConnectivity, isOnline\]\)/);
    });
    it("offline-status-bar clears timeout on unmount", () => {
      const src = read("src/components/register/offline-status-bar.tsx");
      expect(src).toMatch(/clearResultTimeoutRef/);
    });
  });

  describe("R34-D17: deploy + duplicates runbooks", () => {
    it("runbook-deploy.md exists", () => {
      const doc = read("docs/runbook-deploy.md");
      expect(doc).toMatch(/Deploy Runbook/);
      expect(doc).toMatch(/OPS_CLEANUP_SECRET/);
    });
    it("runbook-061-duplicates.md exists", () => {
      const doc = read("docs/runbook-061-duplicates.md");
      expect(doc).toMatch(/Duplicate product slugs/);
    });
  });
});
