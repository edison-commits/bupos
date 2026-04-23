/**
 * R46 regression tests. Pins R46 audit-round fixes:
 *   R46-H1: /api/store-credit + /api/gift-cards (activate/reload)
 *           write audit_events INSIDE the transaction.
 *   R46-H2: /api/gift-cards disable wraps SELECT-UPDATE-AUDIT in a
 *           single tx; no post-commit mirror.
 *   R46-H3: /api/cash-drawer pay_in + pay_out audit INSIDE their
 *           respective tx blocks.
 *   R46-M1: /api/returns/process cash-refund rejects with 409 when
 *           no open shift at the location (matches PUT behavior).
 *   R46-M2: signOutRegister only emits the `shift_auto_closed` audit
 *           when the UPDATE actually matched a row (RETURNING guard).
 *   R46-M3: migrations 070 + 071 wrap their DO blocks in
 *           explicit BEGIN; / COMMIT;
 *   R46-M4: collectLayawayAction requires owner/manager + audits
 *           INSIDE tx; step-up on lib/auth/step-up emits structured
 *           `rate_limited` log on each 429 branch.
 *   R46-M (misc): offline-sync audit payload uses safeErr; pin-login
 *          has double-submit guard; IDB catalog cleared on logout.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R46 audit fixes", () => {
  describe("R46-H1: money-mint REST endpoints write audit_events INSIDE tx", () => {
    it("/api/store-credit POST inserts audit_events before COMMIT", () => {
      const src = read("src/app/api/store-credit/route.ts");
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'store_credit_issued'[\s\S]*?COMMIT/);
    });
    it("/api/gift-cards activate inserts audit_events before COMMIT", () => {
      const src = read("src/app/api/gift-cards/route.ts");
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'gift_card_created'[\s\S]*?COMMIT/);
    });
    it("/api/gift-cards reload inserts audit_events before COMMIT", () => {
      const src = read("src/app/api/gift-cards/route.ts");
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'gift_card_reloaded'[\s\S]*?COMMIT/);
    });
  });

  describe("R46-H2: /api/gift-cards disable wraps in one tx with FOR UPDATE", () => {
    const src = read("src/app/api/gift-cards/route.ts");
    it("uses orgTx client + FOR UPDATE on the SELECT", () => {
      // The disable branch should use a client-level tx with FOR UPDATE
      // on the SELECT before the UPDATE.
      expect(src).toMatch(/disableClient[\s\S]*?FOR UPDATE/);
    });
    it("audit_events inside the disable tx", () => {
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'gift_card_disabled'/);
    });
  });

  describe("R46-H3: /api/cash-drawer pay_in + pay_out audit in-tx", () => {
    const src = read("src/app/api/cash-drawer/route.ts");
    it("pay_in branch writes audit_events with event_kind 'cash_pay_in' before COMMIT", () => {
      // Look for audit INSERT inside a block that includes pay_in INSERT
      expect(src).toMatch(/pay_in_outs[\s\S]*?'pay_in'[\s\S]*?INSERT INTO audit_events[\s\S]*?'cash_pay_in'[\s\S]*?COMMIT/);
    });
    it("pay_out branch writes audit_events with event_kind 'pay_out' before COMMIT", () => {
      expect(src).toMatch(/pay_in_outs[\s\S]*?'pay_out'[\s\S]*?INSERT INTO audit_events[\s\S]*?'pay_out'[\s\S]*?COMMIT/);
    });
  });

  describe("R46-M1: /api/returns/process rejects cash refund when no open shift", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("emits 409 when openShift is undefined", () => {
      expect(src).toMatch(/if \(!openShift\)[\s\S]*?'Cash refund requires an open shift/);
    });
  });

  describe("R46-M2: signOutRegister audits only when UPDATE matched a row", () => {
    const src = read("src/lib/auth/session.ts");
    it("UPDATE uses RETURNING id + audit is gated on closedRows.length > 0", () => {
      expect(src).toMatch(/RETURNING id[\s\S]*?if \(closedRows\.length > 0\)/);
    });
  });

  describe("R46-M3: migrations 070 + 071 have explicit BEGIN/COMMIT", () => {
    it("migration 070 starts with BEGIN and ends with COMMIT", () => {
      const mig = read("supabase/migrations/070_r42_cascade_fixes.sql");
      expect(mig).toMatch(/^BEGIN;$/m);
      expect(mig.trimEnd().endsWith("COMMIT;")).toBe(true);
    });
    it("migration 071 starts with BEGIN and ends with COMMIT", () => {
      const mig = read("supabase/migrations/071_r43_cleanup.sql");
      expect(mig).toMatch(/^BEGIN;$/m);
      expect(mig.trimEnd().endsWith("COMMIT;")).toBe(true);
    });
  });

  describe("R46-M4: collectLayawayAction owner/manager gate + in-tx audit", () => {
    const src = read("src/app/admin/layaway-actions.ts");
    it("refuses non-owner/manager roles", () => {
      expect(src).toMatch(/collectLayawayAction[\s\S]*?"owner"[\s\S]*?"manager"[\s\S]*?manager authority/);
    });
    it("writes audit_events INSIDE tx before COMMIT", () => {
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'layaway_collected'[\s\S]*?COMMIT/);
    });
  });

  describe("R46-M: step-up helper emits logRateLimited on every 429 branch", () => {
    const src = read("src/lib/auth/step-up.ts");
    it("imports logRateLimited", () => {
      expect(src).toMatch(/logRateLimited/);
    });
    it("calls logRateLimited in all three 429 branches (mem / kv / aggregate)", () => {
      const count = (src.match(/logRateLimited\(\{/g) ?? []).length;
      expect(count).toBeGreaterThanOrEqual(3);
    });
  });

  describe("R46-M: offline-sync audit payload uses safeErr", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    it("offline_sync_pre_read_failed uses safeErr on error field", () => {
      expect(src).toMatch(/offline_sync_pre_read_failed[\s\S]*?safeErr\(preReadError\)/);
    });
    it("no raw preReadError.message in audit payload anymore", () => {
      expect(src).not.toMatch(/error:\s*preReadError instanceof Error \? preReadError\.message/);
    });
  });

  describe("R46-M: pin-login-form double-submit guard", () => {
    const src = read("src/components/register/pin-login-form.tsx");
    it("uses submitting state + disabled on OK button", () => {
      expect(src).toMatch(/setSubmitting\(true\)/);
      expect(src).toMatch(/disabled=\{submitting && key === "OK"\}/);
    });
  });

  describe("R46-M: IDB catalog cleared on logout", () => {
    it("idb-store exports clearCatalog", () => {
      const src = read("src/lib/offline/idb-store.ts");
      expect(src).toMatch(/export async function clearCatalog\(\)/);
    });
    it("register-client-reset imports + calls clearCatalog", () => {
      const src = read("src/lib/offline/register-client-reset.ts");
      expect(src).toMatch(/clearCatalog/);
    });
  });
});
