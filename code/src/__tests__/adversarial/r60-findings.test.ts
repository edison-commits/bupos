/**
 * R60 regression tests. Pins audit round 12 — 10 findings:
 *   CRITICAL A1: locationSettingsSchema accepts `isActive` so the
 *          Location Details save stops 400ing (pre-existing
 *          blocker; UI sends isActive on every PUT but Zod
 *          `.strict()` rejected it).
 *   HIGH A2: /api/settings PUT location tax step-up gates only on
 *          ACTUAL tax change (snapshot-compare with 0.00005 epsilon),
 *          not mere presence.
 *   MEDIUM A3: deleteProductAction + REST DELETE cascade soft-
 *          deactivation to product_variants in the same tx, and
 *          /api/barcode-lookup filters out inactive products.
 *   LOW B1: /api/products POST variant-create validates
 *          compare_at_price with Number.isFinite + non-negative.
 *   LOW B2: Number() coercion in POST + PUT variant branches
 *          rejects null/[]/object/boolean before coercing, so
 *          `{"price":null}` no longer silently reprices to $0.
 *   LOW B3: /api/products DELETE + PATCH have per-org rate limits
 *          (parity with POST + PUT).
 *   LOW B4: admin purchase-orders + labels product pickers pass
 *          `?active=true` so soft-deleted products don't surface.
 *   LOW B5: settings/page.tsx suggested-rate caption template-
 *          literal typo fixed (missing `$` + wrong formatter).
 *   LOW B6: products/page.tsx empty numeric input coalesces to 0
 *          on save (no NaN → null → silent-zero).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R60 audit fixes — round 12", () => {
  describe("R60-A1 CRITICAL: locationSettingsSchema accepts isActive", () => {
    const src = read("src/lib/validation/schemas.ts");
    it("locationSettingsSchema lists isActive alongside taxRate etc.", () => {
      // The schema is `.strict()`; isActive must be explicitly
      // declared for the admin settings PUT to not 400.
      const block = src.slice(src.indexOf("const locationSettingsSchema"));
      expect(block.slice(0, 1200)).toMatch(/isActive: z\.boolean\(\)\.optional\(\)/);
    });
  });

  describe("R60-A2 HIGH: /api/settings PUT location tax step-up snapshot-compares", () => {
    const src = read("src/app/api/settings/route.ts");
    it("non-locking prior-tax SELECT runs before requireStepUp", () => {
      expect(src).toMatch(/SELECT tax_rate FROM locations[\s\S]{0,200}LIMIT 1/);
      const priorIdx = src.indexOf("SELECT tax_rate FROM locations");
      const stepUpIdx = src.indexOf("bucketKey: 'tax-rate-stepup'");
      expect(priorIdx).toBeGreaterThan(-1);
      expect(stepUpIdx).toBeGreaterThan(-1);
      expect(priorIdx).toBeLessThan(stepUpIdx);
    });
    it("gate fires only when new tax differs by > 0.00005", () => {
      expect(src).toMatch(/taxChanged = priorTax === null \|\| Math\.abs\(priorTax - submittedTax\) > 0\.00005/);
    });
  });

  describe("R60-A3 MEDIUM: soft-delete cascades to variants + barcode-lookup filters", () => {
    it("deleteProductAction cascades UPDATE product_variants SET is_active = false", () => {
      const src = read("src/app/admin/actions.ts");
      const block = src.slice(src.indexOf("export async function deleteProductAction"));
      expect(block.slice(0, 4000)).toMatch(/UPDATE product_variants SET is_active = false[\s\S]{0,200}WHERE product_id = \$1/);
    });
    it("REST /api/products DELETE cascades the same", () => {
      const src = read("src/app/api/products/route.ts");
      const block = src.slice(src.indexOf("export const DELETE"));
      expect(block.slice(0, 3000)).toMatch(/UPDATE product_variants SET is_active = false[\s\S]{0,200}WHERE product_id = \$1/);
    });
    it("barcode-lookup requires both p.is_active AND pv.is_active", () => {
      const src = read("src/app/api/barcode-lookup/route.ts");
      expect(src).toMatch(/p\.is_active = true/);
      expect(src).toMatch(/pv\.is_active = true/);
    });
  });

  describe("R60-B1 LOW: compare_at_price validated with Number.isFinite", () => {
    const src = read("src/app/api/products/route.ts");
    it("POST variant branch rejects non-finite or negative compare_at_price", () => {
      const block = src.slice(src.indexOf("Handle variant creation"));
      expect(block).toMatch(/compareAtPriceNum !== undefined && \(!Number\.isFinite\(compareAtPriceNum\) \|\| compareAtPriceNum < 0\)/);
    });
  });

  describe("R60-B2 LOW: Number() coercion rejects null/bool/array/object", () => {
    const src = read("src/app/api/products/route.ts");
    it("POST variant branch rejects non-number/non-string inputs", () => {
      const block = src.slice(src.indexOf("Handle variant creation"));
      expect(block).toMatch(/isAcceptablePriceInput = \(v: unknown\)/);
      expect(block).toMatch(/typeof v === 'number' \|\| typeof v === 'string'/);
    });
    it("PUT variant branch has the same guard", () => {
      const block = src.slice(src.indexOf("// Handle variant update"));
      expect(block).toMatch(/isAcceptableUpdate = \(v: unknown\)/);
      expect(block).toMatch(/typeof v === 'number' \|\| typeof v === 'string'/);
    });
  });

  describe("R60-B3 LOW: /api/products DELETE + PATCH have per-org rate limits", () => {
    const src = read("src/app/api/products/route.ts");
    it("DELETE handler calls checkRateLimit('products:del:${orgId}')", () => {
      expect(src).toMatch(/checkRateLimit\(`products:del:\$\{orgId\}`\)/);
    });
    it("PATCH handler calls checkRateLimit('products:patch:${orgId}')", () => {
      expect(src).toMatch(/checkRateLimit\(`products:patch:\$\{orgId\}`\)/);
    });
  });

  describe("R60-B4 LOW: product pickers filter ?active=true", () => {
    it("purchase-orders/page.tsx passes active=true", () => {
      const src = read("src/app/admin/purchase-orders/page.tsx");
      expect(src).toMatch(/\/api\/products\?search=\$\{[^}]+\}&active=true/);
    });
    it("labels/page.tsx passes active=true", () => {
      const src = read("src/app/admin/labels/page.tsx");
      expect(src).toMatch(/\/api\/products\?search=\$\{[^}]+\}&active=true/);
    });
  });

  describe("R60-B5 LOW: settings/page.tsx suggested-rate caption formatted correctly", () => {
    const src = read("src/app/admin/settings/page.tsx");
    it("template literal no longer has literal '{formatCurrency' (fixed)", () => {
      expect(src).not.toMatch(/: \{formatCurrency/);
      expect(src).toMatch(/: \$\{\(suggestedRate \* 100\)\.toFixed\(2\)\}%/);
    });
  });

  describe("R60-B6 LOW: products/page.tsx numeric inputs coalesce NaN→0 on save", () => {
    const src = read("src/app/admin/products/page.tsx");
    it("price/cost onChange uses `parseFloat(…) || 0`", () => {
      // Applies to BOTH CreateVariantModal and EditVariantModal.
      const priceMatches = src.match(/price: parseFloat\(e\.target\.value\) \|\| 0/g) ?? [];
      const costMatches = src.match(/cost: parseFloat\(e\.target\.value\) \|\| 0/g) ?? [];
      expect(priceMatches.length).toBeGreaterThanOrEqual(2);
      expect(costMatches.length).toBeGreaterThanOrEqual(2);
    });
  });
});
