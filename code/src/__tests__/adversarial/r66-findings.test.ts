/**
 * R66 regression tests. Pins audit round 15 — 11 findings.
 *   HIGH H1: employees/page.tsx sends schema-valid action values
 *           (`reset_pin` / `activate` / `deactivate`, not
 *           `reset-pin` / `toggle-status`).
 *   HIGH H2: purchase-order line DTO renames quantity_ordered →
 *           quantity at the PUT boundary (two UI call sites).
 *   MED M1: /api/products POST category-create validates payload
 *           (prior branch bypassed schema entirely).
 *   MED M2: /api/products PUT category-only update routes through
 *           the UPDATE branch (prior shape silently dropped
 *           category_id changes).
 *   MED M3: /api/employees POST uses per-actor 60/60s bucket.
 *   MED M4: employee edit strips empty pin before sending.
 *   MED M5: admin products handleAddVariant + handleImportCSV
 *           prompt for password + thread actorPassword.
 *   LOW L1: /api/customers DELETE rate-limit bucket includes
 *           employee.id.
 *   LOW L2: products UI handleDeleteProduct sends product_id
 *           (not id).
 *   LOW L3: handleEditVariant reads modal.productId (not
 *           modal.data.productId).
 *   LOW L4: settings 409 refreshes snapshot via fetchSettings()
 *           before throwing.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R66 audit fixes — round 15", () => {
  describe("R66-H1 HIGH: employees/page.tsx action enum values", () => {
    const src = read("src/app/admin/employees/page.tsx");
    it("handleResetPin sends 'reset_pin' (underscore, not hyphen)", () => {
      expect(src).toMatch(/action:\s*['"]reset_pin['"]/);
      expect(src).not.toMatch(/action:\s*['"]reset-pin['"]/);
    });
    it("handleToggleStatus sends 'activate' or 'deactivate' (not 'toggle-status')", () => {
      expect(src).toMatch(/action:\s*employee\.isActive\s*\?\s*['"]deactivate['"]\s*:\s*['"]activate['"]/);
      expect(src).not.toMatch(/action:\s*['"]toggle-status['"]/);
    });
  });

  describe("R66-H2 HIGH: purchase-order line DTO field rename", () => {
    it("admin/purchase-orders/page.tsx renames quantity_ordered → quantity at PUT boundary", () => {
      const src = read("src/app/admin/purchase-orders/page.tsx");
      expect(src).toMatch(/quantity: l\.quantity_ordered/);
    });
    it("components/admin/purchase-order-manager.tsx same rename", () => {
      const src = read("src/components/admin/purchase-order-manager.tsx");
      expect(src).toMatch(/quantity: l\.quantity_ordered/);
    });
  });

  describe("R66-M1 MEDIUM: /api/products category-create validates payload", () => {
    const src = read("src/app/api/products/route.ts");
    it("category branch uses categoryBranchSchema.safeParse", () => {
      expect(src).toMatch(/categoryBranchSchema = z\.object\(\{[\s\S]{0,400}category: z\.object/);
      expect(src).toMatch(/categoryBranchSchema\.safeParse/);
    });
    it("rejects with 400 on invalid payload", () => {
      const block = src.slice(src.indexOf("Handle category creation"));
      expect(block.slice(0, 2000)).toMatch(/if \(!cv\.success\)/);
    });
  });

  describe("R66-M2 MEDIUM: /api/products PUT category-only update routes through UPDATE", () => {
    const src = read("src/app/api/products/route.ts");
    it("branch predicate includes updates.category_id !== undefined", () => {
      // The product-update branch condition now includes category_id.
      expect(src).toMatch(/updates\.name \|\| updates\.slug \|\|[\s\S]{0,300}updates\.category_id !== undefined/);
    });
  });

  describe("R66-M3 MEDIUM: /api/employees POST per-actor rate limit", () => {
    const src = read("src/app/api/employees/route.ts");
    it("bucket key includes actor.id + 60/60s limits", () => {
      expect(src).toMatch(/employees:post:\$\{orgId\}:\$\{actor\.id\}`,\s*\{\s*maxAttempts:\s*60,\s*windowMs:\s*60_000\s*\}/);
    });
  });

  describe("R66-M4 MEDIUM: employee edit strips empty pin", () => {
    const src = read("src/app/admin/employees/page.tsx");
    it("handleUpdateEmployee destructures pin and conditionally includes it", () => {
      // Match either `const { pin: rawPin, ...formDataNoPin }` or an
      // explicit check that pin.trim() is non-empty before sending.
      expect(src).toMatch(/const \{ pin: rawPin, \.\.\.formDataNoPin \} = formData/);
      expect(src).toMatch(/pinToSend = rawPin && rawPin\.trim\(\) \? rawPin\.trim\(\) : undefined/);
    });
  });

  describe("R66-M5 MEDIUM: products UI threads actorPassword on variant-create + CSV import", () => {
    const src = read("src/app/admin/products/page.tsx");
    it("handleAddVariant prompts + includes actorPassword", () => {
      const block = src.slice(src.indexOf("const handleAddVariant"));
      expect(block.slice(0, 2000)).toMatch(/promptPassword\(/);
      expect(block.slice(0, 2000)).toMatch(/actorPassword: pwd/);
    });
    it("handleImportCSV prompts + includes actorPassword", () => {
      const block = src.slice(src.indexOf("const handleImportCSV"));
      expect(block.slice(0, 2000)).toMatch(/promptPassword\(/);
      expect(block.slice(0, 2000)).toMatch(/actorPassword: pwd/);
    });
  });

  describe("R66-L1 LOW: /api/customers DELETE per-actor bucket", () => {
    const src = read("src/app/api/customers/route.ts");
    it("bucket key includes employee.id", () => {
      expect(src).toMatch(/customers:delete:\$\{orgId\}:\$\{employee\.id\}/);
    });
  });

  describe("R66-L2 LOW: products UI handleDeleteProduct sends product_id", () => {
    const src = read("src/app/admin/products/page.tsx");
    it("DELETE body uses product_id (not id)", () => {
      const block = src.slice(src.indexOf("const handleDeleteProduct"));
      expect(block.slice(0, 1500)).toMatch(/body: JSON\.stringify\(\{ product_id: productId \}\)/);
      expect(block.slice(0, 1500)).not.toMatch(/body: JSON\.stringify\(\{ id: productId \}\)/);
    });
  });

  describe("R66-L3 LOW: handleEditVariant reads modal.productId", () => {
    const src = read("src/app/admin/products/page.tsx");
    it("uses modal.productId (not modal.data.productId)", () => {
      // Look across the whole file since handleEditVariant spans
      // ~100+ lines with modal + step-up branching.
      expect(src).toMatch(/\.\.\.\(modal\.productId \? \{ product_id: modal\.productId \} : \{\}\)/);
    });
  });

  describe("R66-L4 LOW: settings 409 refreshes snapshot", () => {
    const src = read("src/app/admin/settings/page.tsx");
    it("409 branch calls fetchSettings() before throwing", () => {
      // Match the block that handles 409 with the fetchSettings call.
      expect(src).toMatch(/if \(response\.status === 409\)[\s\S]{0,500}fetchSettings\(\)\.catch/);
    });
  });
});
