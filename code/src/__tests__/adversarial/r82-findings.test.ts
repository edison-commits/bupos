/**
 * R82 regression tests. Pins audit round 26.
 *
 * HIGH
 *   DB-H1: register/return-action + /api/returns/process now reverse
 *     customers.total_spend + visit_count on refund. Prior shape
 *     reversed loyalty_points only — denormalized total_spend
 *     drifted from live-SUM detail view, so list view (gross) and
 *     detail view (net) disagreed for every customer with refunds.
 *     visit_count decrements only on the refund that crosses the
 *     full-refund boundary.
 *   DB-H2: /api/dashboard metrics now use sign-based filters.
 *     Prior shape counted ZERO register returns as refunds (they
 *     write status='completed' with negative grand_total, not
 *     status='refunded'). avg_ticket averaged positive sales with
 *     negative refunds.
 *   DB-H3: /api/eod-report now uses sign-based filters for returns
 *     + adds status='completed'+amount>0 filter on payment_breakdown.
 *   SEC-H1 / FE-H: exchange-modal now wraps onConfirm in
 *     Promise.resolve().finally so async rejections ALSO reset the
 *     continuing flag (R81's pure try/catch only caught sync
 *     throws). Five more R81-missed overlays (pos-terminal 3 modals,
 *     receipt-view, product-grid variant picker) get own Esc
 *     handlers so Esc actually dismisses (R81 added role=dialog
 *     only, which made the global Esc yield — but left Esc no-op).
 *
 * MEDIUM
 *   DB-M4: invalidateInventoryCache added to register/layaway-action,
 *     admin/layaway-actions cancel, register/return-action, and
 *     admin/stocktake-actions accept. Prior shape left POS grid
 *     stale for up to 30s TTL after these mutations.
 *
 * LOW
 *   DB-L5: /api/dashboard employee query COALESCE display_name so
 *     deleted employees show "Former Employee" instead of null.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R82 audit fixes — round 26", () => {
  describe("R82-DB-H1 HIGH: returns reverse total_spend + visit_count", () => {
    it("register/return-action.ts reverses total_spend + visit_count on full refund", () => {
      const src = read("src/app/register/return-action.ts");
      expect(src).toMatch(/SET total_spend = GREATEST\(0, total_spend - \$1\)[\s\S]{0,200}visit_count = GREATEST\(0, visit_count - \$2\)/);
      // wasPriorFullyRefunded is named with a numeric suffix locally
      // to avoid clashing with the earlier loyalty block.
      expect(src).toMatch(/wasPriorFullyRefunded[\s\S]{0,400}isNowFullyRefunded[\s\S]{0,400}visitCountDelta/);
    });
    it("/api/returns/process reverses total_spend + visit_count on full refund", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/SET total_spend = GREATEST\(0, total_spend - \$1\)[\s\S]{0,200}visit_count = GREATEST\(0, visit_count - \$2\)/);
    });
  });

  describe("R82-DB-H2 HIGH: /api/dashboard sign-based refund filter", () => {
    const src = read("src/app/api/dashboard/route.ts");
    it("transaction_count filters status=completed AND grand_total>=0", () => {
      // FILTER (WHERE ...) aliased with ::int AS transaction_count
      expect(src).toMatch(/FILTER \(WHERE status = 'completed' AND grand_total >= 0\)::int AS transaction_count/);
    });
    it("refund_count filters status=completed AND grand_total<0", () => {
      expect(src).toMatch(/FILTER \(WHERE status = 'completed' AND grand_total < 0\)::int AS refund_count/);
    });
    it("refund_total aggregated separately", () => {
      expect(src).toMatch(/AS refund_total/);
    });
  });

  describe("R82-DB-H3 HIGH: /api/eod-report sign-based filters", () => {
    const src = read("src/app/api/eod-report/route.ts");
    it("total_returns_count filters on status=completed + grand_total<0", () => {
      expect(src).toMatch(/total_returns_count[\s\S]{0,100}status = 'completed' AND grand_total < 0/);
    });
    it("payment_breakdown gates on status=completed + amount>0", () => {
      expect(src).toMatch(/AND t\.status = 'completed'\s*AND tt\.amount > 0/);
    });
  });

  describe("R82-SEC-H1 / FE-H1: exchange-modal Promise.finally handles async", () => {
    const src = read("src/components/register/exchange-modal.tsx");
    it("onConfirm wrapped with Promise.resolve().finally", () => {
      expect(src).toMatch(/Promise\.resolve\([\s\S]{0,200}\.finally\(\(\) => \{\s*\/\/[\s\S]{0,200}setContinuing\(false\)/);
    });
  });

  describe("R82-FE-H1: 5 overlays get own Esc handlers", () => {
    it("pos-terminal covers returnResult / layawayResult / heldCarts Esc", () => {
      const src = read("src/components/register/pos-terminal.tsx");
      expect(src).toMatch(/if \(returnResult\) setReturnResult\(null\)[\s\S]{0,200}setLayawayResult\(null\)[\s\S]{0,100}setShowHeldCarts\(false\)/);
    });
    it("product-grid variant picker closes on Esc", () => {
      const src = read("src/components/register/product-grid.tsx");
      expect(src).toMatch(/if \(!variantPickerProduct\) return;[\s\S]{0,200}e\.key === "Escape"[\s\S]{0,80}setVariantPickerProduct\(null\)/);
    });
    it("receipt-view dismisses via Esc (calls onNewSale)", () => {
      const src = read("src/components/register/receipt-view.tsx");
      expect(src).toMatch(/e\.key === "Escape"[\s\S]{0,80}onNewSale\(\)/);
    });
  });

  describe("R82-DB-M4 MED: invalidateInventoryCache sweep", () => {
    for (const rel of [
      "src/app/register/layaway-action.ts",
      "src/app/admin/layaway-actions.ts",
      "src/app/register/return-action.ts",
      "src/app/admin/stocktake-actions.ts",
    ]) {
      it(`${rel} calls invalidateInventoryCache`, () => {
        const src = read(rel);
        expect(src).toMatch(/invalidateInventoryCache/);
      });
    }
  });

  describe("R82-DB-L5 LOW: dashboard employee display_name COALESCE", () => {
    const src = read("src/app/api/dashboard/route.ts");
    it("wraps display_name with COALESCE + 'Former Employee' fallback", () => {
      expect(src).toMatch(/COALESCE\(e\.display_name, CONCAT\(e\.first_name, ' ', e\.last_name\), 'Former Employee'\)/);
    });
  });
});
