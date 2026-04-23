/**
 * R64 regression tests. Pins audit round 14 — 12 findings:
 *   CRITICAL C1: R62-L2 .strict() schemas broke admin product
 *           create + edit (UI sent `id` instead of `product_id`;
 *           spread Product shape with extra fields). Now:
 *           - productCreateSchema: `variant` optional (AddProductModal
 *             doesn't send it); `category_id` optional.
 *           - productUpdateSchema: `product_id` optional (variant-
 *             update branch doesn't require it).
 *           - Admin UI whitelists payloads to schema-known fields.
 *   HIGH H1: CSV import rejects soft-deleted products from name
 *           lookup (closes variant-reactivation via re-import).
 *   HIGH H2: /api/bundles PATCH adds SELECT FOR UPDATE + drift
 *           guard on bundle_price (R56-B1 pattern parity).
 *   MEDIUM M1: settings 409 tax-rate-drift error bubbles up to UI.
 *   MEDIUM M2: /api/products POST variant-create parent check
 *           uses FOR SHARE lock (TOCTOU on concurrent soft-delete).
 *   MEDIUM M3: /api/tax-config PUT has per-actor rate limit.
 *   MEDIUM M4: /api/transfers POST rejects inactive variants.
 *   MEDIUM M5: /api/receiving search filters p.is_active.
 *   LOW L1: /api/bundles + /api/suppliers + /api/expenses +
 *           /api/transfers have per-actor 60/60s rate limits.
 *   LOW L2: /api/customers POST + PUT switched from per-org
 *           default to per-actor 60/60s.
 *   LOW L3: (category_id defensive — handled by the schema.optional
 *           change in C1).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R64 audit fixes — round 14", () => {
  describe("R64-C1 CRITICAL: .strict() schemas loosened for admin UI shape", () => {
    const schemas = read("src/lib/validation/schemas.ts");
    it("productCreateSchema has `variant` optional", () => {
      const idx = schemas.indexOf("export const productCreateSchema");
      const block = schemas.slice(idx, idx + 2000);
      expect(block).toMatch(/variant: variantCreateSchema\.optional\(\)/);
    });
    it("productCreateSchema has `category_id` optional", () => {
      const idx = schemas.indexOf("export const productCreateSchema");
      const block = schemas.slice(idx, idx + 2000);
      expect(block).toMatch(/category_id: uuid\.optional\(\)/);
    });
    it("productUpdateSchema has `product_id` optional", () => {
      const idx = schemas.indexOf("export const productUpdateSchema");
      const block = schemas.slice(idx, idx + 2000);
      expect(block).toMatch(/product_id: uuid\.optional\(\)/);
    });
    it("admin UI handleEditProduct sends product_id (not id)", () => {
      const ui = read("src/app/admin/products/page.tsx");
      const block = ui.slice(ui.indexOf("const handleEditProduct"));
      expect(block.slice(0, 2000)).toMatch(/product_id: productId/);
    });
    it("admin UI handleEditProduct does NOT spread full formData", () => {
      const ui = read("src/app/admin/products/page.tsx");
      const block = ui.slice(ui.indexOf("const handleEditProduct"));
      // No `...formData` in the request body.
      expect(block.slice(0, 2500)).not.toMatch(/body: JSON\.stringify\(\{[\s\S]{0,300}\.\.\.formData/);
    });
  });

  describe("R64-H1 HIGH: CSV import excludes soft-deleted products from name lookup", () => {
    const src = read("src/app/api/products/route.ts");
    it("productsByName SELECT filters WHERE organization_id = $1 AND is_active = true", () => {
      expect(src).toMatch(/SELECT id, name, category_id FROM products WHERE organization_id = \$1 AND is_active = true/);
    });
  });

  describe("R64-H2 HIGH: /api/bundles PATCH adds TOCTOU drift guard", () => {
    const src = read("src/app/api/bundles/route.ts");
    it("non-locking snapshot of bundle_price before step-up", () => {
      expect(src).toMatch(/SELECT bundle_price FROM product_bundles WHERE id = \$1 AND organization_id = \$2 LIMIT 1/);
    });
    it("in-tx SELECT FOR UPDATE on bundle_price", () => {
      expect(src).toMatch(/SELECT bundle_price FROM product_bundles[\s\S]{0,200}FOR UPDATE/);
    });
    it("rejects with 409 on drift > 0.005", () => {
      expect(src).toMatch(/Math\.abs\(priorBundlePriceSnap - lockedBundlePrice\) > 0\.005/);
      expect(src).toMatch(/"Bundle price was changed by another user/);
    });
  });

  describe("R64-M1 MEDIUM: settings 409 message bubbles up to UI", () => {
    const src = read("src/app/admin/settings/page.tsx");
    it("handleSaveLocation branches on response.status === 409", () => {
      expect(src).toMatch(/response\.status === 409[\s\S]{0,400}throw new Error\(body\.error/);
    });
  });

  describe("R64-M2 MEDIUM: /api/products variant-create parent check uses FOR SHARE", () => {
    const src = read("src/app/api/products/route.ts");
    it("parent is_active SELECT uses FOR SHARE", () => {
      expect(src).toMatch(/SELECT is_active FROM products WHERE id = \$1 AND organization_id = \$2 LIMIT 1 FOR SHARE/);
    });
  });

  describe("R64-M3 MEDIUM: /api/tax-config PUT has per-actor rate limit", () => {
    const src = read("src/app/api/tax-config/route.ts");
    it("checkRateLimit with tax-config-put bucket", () => {
      expect(src).toMatch(/checkRateLimit\(`tax-config-put:\$\{orgId\}:\$\{employee\.id\}`,\s*\{\s*maxAttempts:\s*10,\s*windowMs:\s*300_000\s*\}\)/);
    });
  });

  describe("R64-M4 MEDIUM: /api/transfers POST rejects inactive variants", () => {
    const src = read("src/app/api/transfers/route.ts");
    it("SELECT includes is_active column", () => {
      expect(src).toMatch(/SELECT id, is_active FROM product_variants WHERE id = ANY\(\$1::uuid\[\]\) AND organization_id = \$2/);
    });
    it("rejects with 409 when any variant is inactive", () => {
      expect(src).toMatch(/inactiveVariants = vCheck\.filter/);
      expect(src).toMatch(/product variants are inactive and cannot be transferred/);
    });
  });

  describe("R64-M5 MEDIUM: /api/receiving search filters p.is_active", () => {
    const src = read("src/app/api/receiving/route.ts");
    it("JOIN products also filters p.is_active = true", () => {
      expect(src).toMatch(/JOIN products p ON pv\.product_id = p\.id AND p\.organization_id = \$1 AND p\.is_active = true/);
    });
  });

  describe("R64-L1 LOW: mutation endpoints have per-actor rate limits", () => {
    it("bundles POST/PATCH/DELETE have per-actor buckets", () => {
      const src = read("src/app/api/bundles/route.ts");
      expect(src).toMatch(/bundles:post:\$\{orgId\}:\$\{employee\.id\}/);
      expect(src).toMatch(/bundles:patch:\$\{orgId\}:\$\{employee\.id\}/);
      expect(src).toMatch(/bundles:del:\$\{orgId\}:\$\{employee\.id\}/);
    });
    it("suppliers POST/PUT have per-actor buckets", () => {
      const src = read("src/app/api/suppliers/route.ts");
      expect(src).toMatch(/suppliers:post:\$\{orgId\}:\$\{employee\.id\}/);
      expect(src).toMatch(/suppliers:put:\$\{orgId\}:\$\{employee\.id\}/);
    });
    it("expenses POST/DELETE have per-actor buckets", () => {
      const src = read("src/app/api/expenses/route.ts");
      expect(src).toMatch(/expenses:post:\$\{orgId\}:\$\{ctx\.employee\.id\}/);
      expect(src).toMatch(/expenses:delete:\$\{orgId\}:\$\{ctx\.employee\.id\}/);
    });
    it("transfers POST has a per-actor bucket", () => {
      const src = read("src/app/api/transfers/route.ts");
      expect(src).toMatch(/transfers:post:\$\{orgId\}:\$\{employeeId\}/);
    });
  });

  describe("R64-L2 LOW: /api/customers POST + PUT use per-actor buckets", () => {
    const src = read("src/app/api/customers/route.ts");
    it("POST is per-actor with 60/60s", () => {
      expect(src).toMatch(/customers:post:\$\{orgId\}:\$\{employee\.id\}`,\s*\{\s*maxAttempts:\s*60,\s*windowMs:\s*60_000\s*\}/);
    });
    it("PUT is per-actor with 60/60s", () => {
      expect(src).toMatch(/customers:put:\$\{orgId\}:\$\{employee\.id\}`,\s*\{\s*maxAttempts:\s*60,\s*windowMs:\s*60_000\s*\}/);
    });
  });
});
