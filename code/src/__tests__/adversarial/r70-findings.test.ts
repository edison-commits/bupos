/**
 * R70 regression tests. Pins audit round 17 — 11 findings:
 *   HIGH H1: createProductAction gates on pricing.manage +
 *           variant-price-stepup + admin-console UI prompts.
 *   HIGH H2: store-credit + gift-card Server Actions add the same
 *           pg_advisory_xact_lock + 24h aggregate cap that REST
 *           enforces (so Server Action can't be used as a bypass).
 *   HIGH H3: Loyalty Tiers UI wrapped in a <fieldset disabled>
 *           preview banner; "+ Add Custom Tier" button disabled.
 *   MED M1: /api/transfers SHIP gates on step-up (bucketKey
 *           'transfer-ship-stepup') in both REST + Server Action.
 *   MED M2: admin/returns/page.tsx handleQuantityChange coerces
 *           NaN to 1 before Math.max/min clamp.
 *   LOW L1: ship + receive audit events in both REST + Server
 *           Action.
 *   LOW L2: /api/promo-codes disable uses UPDATE … RETURNING +
 *           404 when promo not found (no phantom audit row).
 *   LOW L3: createCategoryAction catches 23505 + redirects with
 *           friendly slug-conflict message.
 *   LOW L4: barcode-lookup stale "non-functional" comment removed.
 *   LOW L5: transfer-manager full cancel reset (src/dest/variant/qty).
 *   LOW L6: bundle-manager parseInt fallback-to-1.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R70 audit fixes — round 17", () => {
  describe("R70-H1 HIGH: createProductAction gates on pricing.manage + step-up", () => {
    const action = read("src/app/admin/actions.ts");
    const ui = read("src/components/admin/admin-console.tsx");
    it("Server Action checks hasPermission(pricing.manage)", () => {
      const block = action.slice(action.indexOf("export async function createProductAction"));
      expect(block.slice(0, 2000)).toMatch(/hasPermission\(employee\.roleKey,\s*["']pricing\.manage["']\)/);
    });
    it("Server Action calls requireStepUp with variant-price-stepup bucket", () => {
      const block = action.slice(action.indexOf("export async function createProductAction"));
      expect(block.slice(0, 2000)).toMatch(/bucketKey:\s*["']variant-price-stepup["']/);
    });
    it("admin-console wraps createProductAction form in <PasswordGatedForm>", () => {
      expect(ui).toMatch(/<PasswordGatedForm[\s\S]{0,1200}action=\{createProductAction\}/);
    });
  });

  describe("R70-H2 HIGH: store-credit + gift-card Server Actions enforce 24h aggregate cap", () => {
    it("issueStoreCreditAction uses pg_advisory_xact_lock + 24h SELECT SUM", () => {
      const src = read("src/app/admin/store-credit-actions.ts");
      expect(src).toMatch(/pg_advisory_xact_lock/);
      expect(src).toMatch(/store-credit-actor:\$\{orgId\}:\$\{ctx\.employee\.id\}/);
      expect(src).toMatch(/24 hours/);
      expect(src).toMatch(/MAX_DAILY_STORE_CREDIT_PER_ACTOR = 25_000/);
    });
    it("activateGiftCardAction + reloadGiftCardAction enforce 25k daily mint cap", () => {
      const src = read("src/app/admin/gift-card-actions.ts");
      const matches = src.match(/MAX_DAILY_MINT_PER_ACTOR = 25_000/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
      const lockMatches = src.match(/gift-card-actor:\$\{orgId\}:\$\{ctx\.employee\.id\}/g) ?? [];
      expect(lockMatches.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("R70-H3 HIGH: Loyalty Tiers UI wrapped in preview fieldset", () => {
    const src = read("src/components/admin/loyalty-tiers.tsx");
    it("preview banner displayed", () => {
      expect(src).toMatch(/Preview:\s*<\/strong>\s*tier configuration is not yet/);
    });
    it("tier editor wrapped in <fieldset disabled>", () => {
      expect(src).toMatch(/<fieldset disabled className="grid gap-4 opacity-75">/);
    });
    it("Add Custom Tier button disabled", () => {
      expect(src).toMatch(/disabled\s*\n\s*title="Custom tier persistence not yet available"/);
    });
  });

  describe("R70-M1 MEDIUM: /api/transfers SHIP gates on step-up", () => {
    it("REST ship action requires step-up with transfer-ship-stepup bucket", () => {
      const src = read("src/app/api/transfers/route.ts");
      const block = src.slice(src.indexOf('action === "ship"'));
      expect(block.slice(0, 3000)).toMatch(/bucketKey:\s*["']transfer-ship-stepup["']/);
    });
    it("shipTransferAction accepts actorPassword param + calls requireStepUp", () => {
      const src = read("src/app/admin/transfer-actions.ts");
      expect(src).toMatch(/export async function shipTransferAction\(transferId: string, actorPassword\?: string\)/);
      expect(src).toMatch(/bucketKey:\s*["']transfer-ship-stepup["']/);
    });
  });

  describe("R70-M2 MEDIUM: returns handleQuantityChange coerces NaN", () => {
    const src = read("src/app/admin/returns/page.tsx");
    it("guards Number.isFinite(quantity) + q > 0 before clamp", () => {
      expect(src).toMatch(/const q = Number\.isFinite\(quantity\) && quantity > 0 \? quantity : 1/);
    });
  });

  describe("R70-L1 LOW: ship + receive emit audit events in-tx", () => {
    it("REST ship emits transfer_shipped audit INSERT", () => {
      const src = read("src/app/api/transfers/route.ts");
      expect(src).toMatch(/'transfer_shipped'/);
    });
    it("REST receive emits transfer_received audit INSERT", () => {
      const src = read("src/app/api/transfers/route.ts");
      expect(src).toMatch(/'transfer_received'/);
    });
    it("Server Action paths audit both ship and receive", () => {
      const src = read("src/app/admin/transfer-actions.ts");
      expect(src).toMatch(/'transfer_shipped'/);
      expect(src).toMatch(/'transfer_received'/);
    });
  });

  describe("R70-L2 LOW: /api/promo-codes disable uses UPDATE RETURNING + 404", () => {
    const src = read("src/app/api/promo-codes/route.ts");
    it("UPDATE has RETURNING id + 404 on rows.length === 0", () => {
      expect(src).toMatch(/UPDATE promo_codes SET status = 'disabled'[\s\S]{0,300}RETURNING id/);
      expect(src).toMatch(/if \(upd\.rows\.length === 0\)[\s\S]{0,200}ROLLBACK[\s\S]{0,200}404/);
    });
  });

  describe("R70-L3 LOW: createCategoryAction catches 23505", () => {
    const src = read("src/app/admin/actions.ts");
    it("slug-conflict path redirects with friendly message", () => {
      const block = src.slice(src.indexOf("export async function createCategoryAction"));
      expect(block.slice(0, 3500)).toMatch(/code === "23505"/);
      expect(block.slice(0, 3500)).toMatch(/A category with slug/);
    });
  });

  describe("R70-L5 LOW: transfer-manager cancel resets all form fields", () => {
    const src = read("src/components/admin/transfer-manager.tsx");
    it("cancel resets sourceLocationId, destLocationId, selectedVariant, selectedQty", () => {
      expect(src).toMatch(/setSourceLocationId\(locations\[0\]\?\.id \?\? ""\);/);
      expect(src).toMatch(/setDestLocationId\(locations\[1\]\?\.id \?\? locations\[0\]\?\.id \?\? ""\);/);
      expect(src).toMatch(/setSelectedVariant\(""\);/);
      expect(src).toMatch(/setSelectedQty\(1\);/);
    });
  });

  describe("R70-L6 LOW: bundle-manager parseInt fallback-to-1", () => {
    const src = read("src/components/admin/bundle-manager.tsx");
    it("quantity onChange uses `parseInt(..., 10) || 1`", () => {
      expect(src).toMatch(/parseInt\(e\.target\.value, 10\) \|\| 1/);
    });
  });
});
