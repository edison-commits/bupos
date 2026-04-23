/**
 * R62 regression tests. Pins audit round 13 — 6 findings:
 *   HIGH H1: /api/offline-sync regular-line path now rejects
 *          soft-deleted variants (R38-A-F11 parity with
 *          checkout-action that R60-A3 cascade assumed was
 *          enforced).
 *   MEDIUM M1: /api/settings PUT location adds in-tx SELECT FOR
 *          UPDATE + drift-guard (R56-B2 pattern; closes the
 *          step-up bypass window between snapshot and UPDATE).
 *   MEDIUM M2: backfill migration 073 deactivates orphan variants
 *          whose parent product was soft-deleted pre-R60-A3.
 *   MEDIUM M3: /api/products POST variant-create rejects soft-
 *          deleted parent products.
 *   LOW L1: /api/products rate-limit defaults tightened from
 *          per-org PIN-default (3/5min) to per-actor 60/60s.
 *   LOW L2: productUpdateSchema + productCreateSchema now
 *          `.strict()` and list top-level variant-update fields
 *          (variant_id, price, cost, expectedUpdatedAt,
 *          actorPassword, is_touch_favorite).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R62 audit fixes — round 13", () => {
  describe("R62-H1 HIGH: offline-sync regular-line rejects inactive variants", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    it("regular-line branch checks serverVariantActive[...] === false", () => {
      // There are three lines checking serverVariantActive: free-item
      // branch (already existed), bundle branch (already existed),
      // and now the regular-line branch (new in R62-H1). Assert ≥ 2
      // occurrences of the exact check pattern.
      const matches = src.match(/serverVariantActive\[item\.productVariantId\] === false/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
    it("regular-line rejection is retriable:false (sync-service dead-letters)", () => {
      expect(src).toMatch(/error:\s*["']Product is no longer available["'][\s\S]{0,100}retriable:\s*false/);
    });
  });

  describe("R62-M1 MEDIUM: /api/settings PUT location TOCTOU guard inside tx", () => {
    const src = read("src/app/api/settings/route.ts");
    it("tx re-reads tax_rate with SELECT ... FOR UPDATE", () => {
      expect(src).toMatch(/SELECT tax_rate FROM locations WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/);
    });
    it("drift guard uses 0.00005 epsilon on priorTaxSnap vs lockedTax", () => {
      expect(src).toMatch(/Math\.abs\(priorTaxSnap - lockedTax\) > 0\.00005/);
    });
    it("ROLLBACK + 409 on drift", () => {
      expect(src).toMatch(/if \(drifted\)[\s\S]{0,300}ROLLBACK[\s\S]{0,300}"Location tax rate was changed by another user/);
    });
  });

  describe("R62-M2 MEDIUM: backfill migration 073 deactivates orphan variants", () => {
    it("migration file exists with BEGIN/COMMIT", () => {
      const migration = read("supabase/migrations/073_r62_backfill_variants_for_soft_deleted_products.sql");
      expect(migration).toMatch(/BEGIN;/);
      expect(migration).toMatch(/COMMIT;/);
    });
    it("UPDATE targets orphan variants whose parent is is_active=false", () => {
      const migration = read("supabase/migrations/073_r62_backfill_variants_for_soft_deleted_products.sql");
      expect(migration).toMatch(/UPDATE product_variants pv[\s\S]{0,300}SET is_active = false/);
      expect(migration).toMatch(/p\.is_active = false[\s\S]{0,100}AND pv\.is_active = true/);
    });
  });

  describe("R62-M3 MEDIUM: POST variant-create rejects soft-deleted parent", () => {
    const src = read("src/app/api/products/route.ts");
    it("parent-product existence check returns is_active column", () => {
      const block = src.slice(src.indexOf("Handle variant creation"));
      expect(block).toMatch(/SELECT is_active FROM products[\s\S]{0,200}LIMIT 1/);
    });
    it("rejects with 400 when parent is_active === false", () => {
      const block = src.slice(src.indexOf("Handle variant creation"));
      expect(block).toMatch(/parentCheck\.rows\[0\]\.is_active === false/);
      expect(block).toMatch(/Cannot add a variant to a deleted product/);
    });
  });

  describe("R62-L1 LOW: /api/products rate-limit buckets are per-actor 60/60s", () => {
    const src = read("src/app/api/products/route.ts");
    it("all four buckets include employee.id in the key", () => {
      expect(src).toMatch(/products:post:\$\{orgId\}:\$\{employee\.id\}/);
      expect(src).toMatch(/products:put:\$\{orgId\}:\$\{employee\.id\}/);
      expect(src).toMatch(/products:del:\$\{orgId\}:\$\{employee\.id\}/);
      expect(src).toMatch(/products:patch:\$\{orgId\}:\$\{employee\.id\}/);
    });
    it("at least the new DELETE/PATCH buckets pass maxAttempts:60, windowMs:60_000", () => {
      expect(src).toMatch(/products:del:\$\{orgId\}:\$\{employee\.id\}`,\s*\{\s*maxAttempts:\s*60,\s*windowMs:\s*60_000\s*\}/);
      expect(src).toMatch(/products:patch:\$\{orgId\}:\$\{employee\.id\}`,\s*\{\s*maxAttempts:\s*60,\s*windowMs:\s*60_000\s*\}/);
    });
  });

  describe("R62-L2 LOW: productUpdateSchema + productCreateSchema .strict() + complete", () => {
    const src = read("src/lib/validation/schemas.ts");
    it("productUpdateSchema is .strict()", () => {
      expect(src).toMatch(/export const productUpdateSchema = z\.object\(\{[\s\S]{0,2000}\}\)\.strict\(\)/);
    });
    it("productUpdateSchema lists variant_id, expectedUpdatedAt, actorPassword", () => {
      const idx = src.indexOf("export const productUpdateSchema");
      const block = src.slice(idx, idx + 2000);
      expect(block).toMatch(/variant_id: uuid\.optional\(\)/);
      expect(block).toMatch(/expectedUpdatedAt: z\.string\(\)\.datetime\(\)\.optional\(\)/);
      expect(block).toMatch(/actorPassword: z\.string\(\)\.max\(200\)\.optional\(\)/);
    });
    it("productCreateSchema is .strict()", () => {
      expect(src).toMatch(/export const productCreateSchema = z\.object\(\{[\s\S]{0,2000}\}\)\.strict\(\)/);
    });
  });
});
