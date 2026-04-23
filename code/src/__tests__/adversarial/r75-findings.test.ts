/**
 * R75 regression tests. Pins audit round 19 — 16 findings
 * (3 HIGH + 8 MEDIUM + 5 LOW). HIGH streak broken at 3 rounds
 * (R72/R73/R74 all zero HIGH/CRITICAL).
 *
 * HIGH
 *   H1: register/layaway-action.ts — cash deposits now INSERT
 *       pay_in_outs so shift-close's expectedCash sees the inflow.
 *       Without this, a cashier could take cash layaway deposits
 *       and pocket them — variance=0 at shift close.
 *   H2: /api/purchase-orders PATCH — PO row now locked with
 *       FOR UPDATE inside the tx + final UPDATE has status NOT IN
 *       ('cancelled','received') predicate. Prior shape let a
 *       concurrent PUT cancel be overwritten by PATCH receive.
 *   H3: admin/layaway-actions.ts cancelLayawayAction — inventory
 *       restore now aggregates per-variant before the unnest
 *       delta-join. Prior shape silently destroyed 2-3 units per
 *       cancelled layaway with duplicate-variant carts.
 *
 * MEDIUM
 *   M-tender: tenderType whitelist on both register-side
 *       createLayawayAction and admin-side makeLayawayPaymentAction
 *       — "Cash" / "cash " / "CASH" no longer bypass the cash
 *       pay_in and store-credit debit branches.
 *   M-po-put: /api/purchase-orders PUT gates on
 *       ctx.allowedLocations — parity with GET (R13-H-7) and
 *       PATCH (R12).
 *   M-gc-exp: /api/offline-sync gift-card redeem now SELECTs
 *       + checks expires_at (parity with register checkout).
 *   M-sc-active: 4 store-credit CREDIT write sites now filter
 *       AND is_active = true to avoid writing onto anonymized
 *       (right-to-be-forgotten) customers.
 *   M-fe-behavior / M-fe-layaway / M-fe-stocktake: Server Action
 *       calls now surface errors via try/catch + alert.
 *   M-nan: payroll-summary + order-calendar parseFloat guarded
 *       with Number.isFinite fallback to 0.
 *
 * LOW
 *   L-dl-sticky: offline-status-bar dead-letter messages are now
 *       sticky (no 5s auto-clear) so actionable cases stay visible.
 *   L-po-mgr: purchase-order-manager handleStatusChange surfaces
 *       RBAC / transition errors via setMessage.
 *   L-bundle: bundle-manager wraps all fetch calls in try/catch
 *       with setError so network errors don't escape to React's
 *       unhandled-rejection.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R75 audit fixes — round 19 (HIGH streak ended)", () => {
  describe("R75-H1 HIGH: register cash layaway deposits write pay_in_outs", () => {
    const src = read("src/app/register/layaway-action.ts");
    it("cash branch SELECTs the open shift FOR UPDATE SKIP LOCKED", () => {
      expect(src).toMatch(/if \(tenderType === "cash"\)[\s\S]{0,600}SELECT id FROM shifts[\s\S]{0,400}FOR UPDATE SKIP LOCKED/);
    });
    it("cash branch INSERTs pay_in_outs direction='pay_in'", () => {
      expect(src).toMatch(/INSERT INTO pay_in_outs[\s\S]{0,600}'pay_in'[\s\S]{0,500}layaway_payment/);
    });
    it("cash branch rejects when no open shift at location", () => {
      expect(src).toMatch(/Cash layaway deposit requires an open shift/);
    });
  });

  describe("R75-H2 HIGH: /api/purchase-orders PATCH locks PO row in-tx", () => {
    const src = read("src/app/api/purchase-orders/route.ts");
    it("PO SELECT FOR UPDATE inside the tx (after BEGIN + set_config)", () => {
      const patchStart = src.indexOf("export const PATCH");
      const block = src.slice(patchStart);
      expect(block).toMatch(/await client\.query\('BEGIN'\);[\s\S]{0,400}set_config\('app\.current_org_id'[\s\S]{0,600}FROM purchase_orders\s+WHERE id = \$1 AND organization_id = \$2\s+FOR UPDATE/);
    });
    it("final UPDATE has status NOT IN ('cancelled','received') predicate", () => {
      expect(src).toMatch(/UPDATE purchase_orders SET status = \$1[\s\S]{0,300}status NOT IN \('cancelled', 'received'\)/);
    });
    it("409 returned when status changed concurrently", () => {
      expect(src).toMatch(/PO status changed concurrently/);
    });
  });

  describe("R75-H3 HIGH: cancelLayawayAction aggregates inventory restore per-variant", () => {
    const src = read("src/app/admin/layaway-actions.ts");
    const block = src.slice(src.indexOf("export async function cancelLayawayAction"));
    it("builds totalsByVariant Map before the delta-join UPDATE", () => {
      expect(block).toMatch(/const totalsByVariant = new Map<string, number>\(\);[\s\S]{0,600}UPDATE inventory_levels il[\s\S]{0,400}unnest\(\$1::uuid\[\]\)/);
    });
  });

  describe("R75-M: tenderType whitelist on layaway create + payment", () => {
    it("register createLayawayAction normalizes + whitelists", () => {
      const src = read("src/app/register/layaway-action.ts");
      expect(src).toMatch(/const ALLOWED_TENDERS = new Set\(\[[\s\S]{0,200}"cash"[\s\S]{0,200}"store_credit"/);
      expect(src).toMatch(/!ALLOWED_TENDERS\.has\(tender\)/);
    });
    it("admin makeLayawayPaymentAction normalizes + whitelists", () => {
      const src = read("src/app/admin/layaway-actions.ts");
      expect(src).toMatch(/const ALLOWED_TENDERS = new Set/);
      expect(src).toMatch(/!ALLOWED_TENDERS\.has\(tenderType\)/);
    });
  });

  describe("R75-M: /api/purchase-orders PUT allowedLocations scope", () => {
    const src = read("src/app/api/purchase-orders/route.ts");
    it("PUT checks ctx.allowedLocations before UPDATE", () => {
      const putStart = src.indexOf("export const PUT");
      const block = src.slice(putStart);
      expect(block).toMatch(/if \(ctx\.allowedLocations !== null\)[\s\S]{0,600}SELECT location_id FROM purchase_orders/);
      expect(block).toMatch(/!ctx\.allowedLocations\.includes/);
    });
  });

  describe("R75-M: offline-sync gift_card expires_at check", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    it("SELECT includes expires_at", () => {
      expect(src).toMatch(/SELECT balance, status, expires_at FROM gift_cards/);
    });
    it("rejects card when expires_at is in the past", () => {
      expect(src).toMatch(/card\.expires_at && new Date\(card\.expires_at[\s\S]{0,100}getTime\(\) < Date\.now\(\)/);
      expect(src).toMatch(/Gift card expired during offline period/);
    });
  });

  describe("R75-M: store-credit CREDIT writes filter is_active = true", () => {
    it("/api/store-credit POST UPDATE has is_active=true", () => {
      const src = read("src/app/api/store-credit/route.ts");
      expect(src).toMatch(/UPDATE customers SET store_credit_balance = store_credit_balance \+ \$1[\s\S]{0,200}AND is_active = true/);
    });
    it("admin/store-credit-actions.ts has is_active=true filter", () => {
      const src = read("src/app/admin/store-credit-actions.ts");
      expect(src).toMatch(/UPDATE customers SET store_credit_balance = store_credit_balance \+ \$1[\s\S]{0,200}AND is_active = true/);
    });
    it("/api/returns/process store-credit lookup FOR UPDATE has is_active=true", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/SELECT id, store_credit_balance FROM customers[\s\S]{0,200}AND is_active = true[\s\S]{0,50}FOR UPDATE/);
    });
    it("register/return-action.ts store-credit UPDATE has is_active=true", () => {
      const src = read("src/app/register/return-action.ts");
      expect(src).toMatch(/UPDATE customers SET store_credit_balance = store_credit_balance \+ \$1[\s\S]{0,200}AND is_active = true/);
    });
  });

  describe("R75-F: Server Action error surfaces", () => {
    it("behavior-dashboard handleScanNow wraps in try/catch", () => {
      const src = read("src/components/admin/behavior-dashboard.tsx");
      expect(src).toMatch(/try \{\s*const result = await runFlagEngineAction\(\);[\s\S]{0,300}\} catch \(err\) \{[\s\S]{0,200}Scan failed:/);
    });
    it("behavior-dashboard handleReview wraps in try/catch", () => {
      const src = read("src/components/admin/behavior-dashboard.tsx");
      expect(src).toMatch(/try \{\s*await reviewFlagAction\(flagId, reviewNotes\);[\s\S]{0,300}\} catch \(err\) \{[\s\S]{0,200}Review failed:/);
    });
    it("layaway-manager collectLayawayAction wraps in try/catch + alert", () => {
      const src = read("src/components/admin/layaway-manager.tsx");
      expect(src).toMatch(/try \{\s*await collectLayawayAction\(lay\.id\);[\s\S]{0,300}\} catch \(err\) \{[\s\S]{0,200}window\.alert\([\s\S]{0,100}Collect failed:/);
    });
    it("stocktake-manager createStocktakeAction surfaces errors + keeps form open", () => {
      const src = read("src/components/admin/stocktake-manager.tsx");
      expect(src).toMatch(/try \{\s*await createStocktakeAction\(fd\);\s*setShowCreate\(false\);\s*\} catch \(err\) \{[\s\S]{0,200}Could not start stocktake/);
    });
    it("stocktake-manager recordCountAction surfaces errors", () => {
      const src = read("src/components/admin/stocktake-manager.tsx");
      expect(src).toMatch(/try \{\s*await recordCountAction\(fd\);\s*\} catch \(err\) \{[\s\S]{0,200}Could not save count/);
    });
  });

  describe("R75-F: NaN guards on parseFloat inputs", () => {
    it("payroll-summary hourlyRates onChange guards NaN", () => {
      const src = read("src/components/admin/payroll-summary.tsx");
      expect(src).toMatch(/const parsed = parseFloat\(e\.target\.value\);[\s\S]{0,200}Number\.isFinite\(parsed\) \? parsed : 0/);
    });
    it("order-calendar editing event amount guards NaN", () => {
      const src = read("src/components/admin/order-calendar.tsx");
      expect(src).toMatch(/const parsed = parseFloat\(e\.target\.value\);[\s\S]{0,200}Number\.isFinite\(parsed\) \? parsed : 0/);
    });
  });

  describe("R75-L: offline-status-bar dead-letter messages are sticky", () => {
    const src = read("src/components/register/offline-status-bar.tsx");
    it("dead-letter path skips the 5s auto-clear", () => {
      expect(src).toMatch(/SKIP the auto-clear when dead letters exist/);
      expect(src).toMatch(/if \(!hasDeadLetters\)/);
    });
  });

  describe("R75-L: purchase-order-manager handleStatusChange surfaces errors", () => {
    const src = read("src/components/admin/purchase-order-manager.tsx");
    it("non-ok response sets an error message (not a bare catch{})", () => {
      expect(src).toMatch(/handleStatusChange = async[\s\S]{0,1200}if \(!res\.ok\)[\s\S]{0,400}setMessage\(\{ type: 'error'/);
    });
  });

  describe("R75-L: bundle-manager fetch handlers wrap errors", () => {
    const src = read("src/components/admin/bundle-manager.tsx");
    it("handleCreateSubmit wraps fetch in try/catch with setError", () => {
      // R77-FE-M added the createSubmitting flag + setCreateSubmitting
      // calls inside handleCreateSubmit, widening the function.
      expect(src).toMatch(/handleCreateSubmit[\s\S]{0,3500}\} catch \(e\) \{[\s\S]{0,400}setError\(e instanceof Error/);
    });
    it("handleToggleActive has a catch setting network error", () => {
      expect(src).toMatch(/handleToggleActive[\s\S]{0,1200}\} catch \(e\) \{[\s\S]{0,200}setError\(e instanceof Error/);
    });
    it("handleDelete has a catch setting network error", () => {
      expect(src).toMatch(/handleDelete[\s\S]{0,1200}\} catch \(e\) \{[\s\S]{0,200}setError\(e instanceof Error/);
    });
  });
});
