/**
 * R68 regression tests. Pins audit round 16 — 12 findings:
 *   HIGH H1: reorder-suggestions `quantity` rename.
 *   HIGH H2: createTransferAction step-up + UI wiring.
 *   HIGH H3: store-credit issuance form threads actorPassword.
 *   HIGH H4: /api/barcode-lookup POST pricing.manage + step-up + UI.
 *   HIGH H5: /admin/returns/page.tsx step-up wiring.
 *   HIGH H6: category INSERT slug + sort_order NOT NULL fix.
 *   MED M1: category-create branch writes audit in-tx.
 *   MED M2: /api/products PUT category_id FK tenant check.
 *   MED M3: /api/products PUT null category_id rejected with 400.
 *   MED M4: CSV import category INSERT includes sort_order.
 *   LOW L1 / L2: R66 comment typo + fetchSettings() awaited.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R68 audit fixes — round 16", () => {
  describe("R68-H1 HIGH: reorder-suggestions quantity rename", () => {
    const src = read("src/components/admin/reorder-suggestions.tsx");
    it("DTO sends `quantity:` (not `quantity_ordered:`)", () => {
      expect(src).toMatch(/quantity: qtys\[item\.variant_id\] \|\| item\.suggested_qty/);
    });
  });

  describe("R68-H2 HIGH: createTransferAction step-up + UI wiring", () => {
    const action = read("src/app/admin/transfer-actions.ts");
    const ui = read("src/components/admin/transfer-manager.tsx");
    it("Server Action calls requireStepUp with transfer-create-stepup bucket", () => {
      expect(action).toMatch(/requireStepUp\(\{[\s\S]{0,300}bucketKey:\s*["']transfer-create-stepup["']/);
    });
    it("transfer-manager UI imports usePasswordGate + prompts before POST", () => {
      expect(ui).toMatch(/usePasswordGate/);
      expect(ui).toMatch(/fd\.set\(["']actorPassword["'], pwd\)/);
    });
  });

  describe("R68-H3 HIGH: store-credit issuance threads actorPassword", () => {
    const src = read("src/components/admin/store-credit-manager.tsx");
    it("form onSubmit prompts password + threads into FormData", () => {
      expect(src).toMatch(/usePasswordGate/);
      expect(src).toMatch(/fd\.set\(["']actorPassword["'], pwd\)/);
    });
  });

  describe("R68-H4 HIGH: /api/barcode-lookup POST gated on pricing.manage + step-up", () => {
    const route = read("src/app/api/barcode-lookup/route.ts");
    const ui = read("src/components/admin/barcode-lookup.tsx");
    it("POST handler checks hasPermission(pricing.manage)", () => {
      expect(route).toMatch(/hasPermission\(employee\.roleKey,\s*["']pricing\.manage["']\)/);
    });
    it("POST handler calls requireStepUp with variant-price-stepup bucket", () => {
      expect(route).toMatch(/bucketKey:\s*['"]variant-price-stepup['"]/);
    });
    it("barcode-lookup UI prompts password before POST", () => {
      expect(ui).toMatch(/usePasswordGate/);
      expect(ui).toMatch(/actorPassword: pwd/);
    });
  });

  describe("R68-H5 HIGH: /admin/returns/page.tsx threads actorPassword on step-up conditions", () => {
    const src = read("src/app/admin/returns/page.tsx");
    it("prompts when refund_method ∈ {cash, original_tender} or refund_amount > 100", () => {
      expect(src).toMatch(/refundMethod === ['"]cash['"][\s\S]{0,80}refundMethod === ['"]original_tender['"][\s\S]{0,80}refundAmount > 100/);
    });
    it("actorPassword included in /api/returns/process body when required", () => {
      expect(src).toMatch(/\.\.\.\(actorPassword \? \{ actorPassword \} : \{\}\)/);
    });
  });

  describe("R68-H6 HIGH: category INSERT includes sort_order + derives slug", () => {
    const src = read("src/app/api/products/route.ts");
    it("INSERT targets (id, organization_id, name, slug, sort_order, created_at, updated_at)", () => {
      expect(src).toMatch(/INSERT INTO categories \(id, organization_id, name, slug, sort_order, created_at, updated_at\)/);
    });
    it("slug is derived from name when absent", () => {
      expect(src).toMatch(/finalSlug = rawSlug && rawSlug\.length > 0[\s\S]{0,200}name\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\+\/g, '-'\)/);
    });
  });

  describe("R68-M1 MEDIUM: category-create branch writes catalog_update audit", () => {
    const src = read("src/app/api/products/route.ts");
    it("audit_events INSERT before COMMIT in category branch", () => {
      const block = src.slice(src.indexOf("Handle category creation"));
      expect(block.slice(0, 3000)).toMatch(/INSERT INTO audit_events[\s\S]{0,400}'catalog_update'[\s\S]{0,300}COMMIT/);
    });
  });

  describe("R68-M2 MEDIUM: /api/products PUT category_id FK tenant check", () => {
    const src = read("src/app/api/products/route.ts");
    it("FK check uses SELECT FOR SHARE on categories with organization_id filter", () => {
      expect(src).toMatch(/SELECT 1 FROM categories WHERE id = \$1 AND organization_id = \$2 LIMIT 1 FOR SHARE/);
    });
    it("rejects with 400 when category belongs to another org", () => {
      expect(src).toMatch(/catFkCheck\.rows\.length === 0[\s\S]{0,200}category_id does not exist in this organization/);
    });
  });

  describe("R68-M3 MEDIUM: /api/products PUT null category_id rejected", () => {
    const src = read("src/app/api/products/route.ts");
    it("null or empty category_id returns 400", () => {
      expect(src).toMatch(/updates\.category_id === null \|\| updates\.category_id === ''/);
      expect(src).toMatch(/category_id cannot be null/);
    });
  });

  describe("R68-M4 MEDIUM: CSV import category INSERT includes sort_order", () => {
    const src = read("src/app/api/products/route.ts");
    it("CSV batch INSERT column list includes sort_order", () => {
      expect(src).toMatch(/INSERT INTO categories \(id, organization_id, name, slug, sort_order, created_at, updated_at\)/);
    });
    it("CSV batch VALUES includes literal 0 for sort_order", () => {
      expect(src).toMatch(/gen_random_uuid\(\), \$1, \$\$\{idx\}, \$\$\{idx \+ 1\}, 0, NOW\(\), NOW\(\)/);
    });
  });

  describe("R68-L2 LOW: settings fetchSettings() is awaited on 409", () => {
    const src = read("src/app/admin/settings/page.tsx");
    it("409 branch awaits fetchSettings() before throw", () => {
      expect(src).toMatch(/if \(response\.status === 409\)[\s\S]{0,500}await fetchSettings\(\)/);
    });
  });
});
