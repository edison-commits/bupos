/**
 * R58 regression tests. Pins audit round 12 — 7 findings:
 *   HIGH R58-0 (pre-existing, promoted to R58 scope): settings
 *          taxRate percent/decimal mismatch that made every
 *          realistic tax-rate edit 400.
 *   HIGH R58-1: /api/products variant-price step-up bypass via JSON
 *          string price. typeof "0.01" === 'number' returned false
 *          so the step-up gate + negative-price check slid past,
 *          but Postgres coerced the string into the numeric column.
 *   HIGH R58-2: deleteProductAction soft-delete + event_kind parity
 *          with REST DELETE.
 *   LOW R58-3: password-change TOCTOU guard adds password_hash
 *          comparison (ms-precision Date.getTime drift).
 *   LOW R58-4: password-reset-confirm moves assertNotReused
 *          OUTSIDE the tx; TOCTOU via hash + updated_at.
 *   LOW R58-5: variant-create now unconditionally requires step-up
 *          (price:0 no longer bypasses).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R58 audit fixes — round 12", () => {
  describe("R58-0: settings page displays + submits taxRate correctly (percent/decimal)", () => {
    const src = read("src/app/admin/settings/page.tsx");
    it("display scales tax_rate ×100 for the '%' label", () => {
      expect(src).toMatch(/\(data\.taxRate \* 100\)\.toFixed\(2\)\}%/);
    });
    it("input shows percent (×100) and parses percent (÷100) before storing", () => {
      expect(src).toMatch(/value=\{Number\(\(formData\.taxRate \* 100\)\.toFixed\(4\)\)\}/);
      expect(src).toMatch(/\(parseFloat\(e\.target\.value\) \|\| 0\) \/ 100/);
    });
    it("'Apply suggested' button no longer multiplies decimal×100", () => {
      expect(src).toMatch(/onClick=\{\(\) => handleChange\('taxRate', suggestedRate\)\}/);
    });
    it("step-up prompt title formats tax as percent", () => {
      expect(src).toMatch(/Change tax rate to \$\{\(data\.taxRate \* 100\)\.toFixed\(2\)\}%/);
    });
  });

  describe("R58-1 HIGH: /api/products variant-price coerces via Number() (no typeof bypass)", () => {
    const src = read("src/app/api/products/route.ts");
    it("POST variant branch uses Number() + Number.isFinite gates", () => {
      const block = src.slice(src.indexOf("Handle variant creation"));
      expect(block).toMatch(/const priceNum = rawPrice !== undefined \? Number\(rawPrice\) : undefined/);
      expect(block).toMatch(/const costNum = rawCost !== undefined \? Number\(rawCost\) : undefined/);
      expect(block).toMatch(/!Number\.isFinite\(priceNum\) \|\| priceNum < 0/);
    });
    it("PUT variant branch uses the same coercion + gating", () => {
      const block = src.slice(src.indexOf("// Handle variant update"));
      expect(block).toMatch(/const priceNum = updates\.price !== undefined \? Number\(updates\.price\) : undefined/);
      expect(block).toMatch(/const costNum = updates\.cost !== undefined \? Number\(updates\.cost\) : undefined/);
      expect(block).toMatch(/!Number\.isFinite\(priceNum\) \|\| priceNum < 0/);
    });
    it("PUT binds coerced priceNum/costNum (not raw updates.price)", () => {
      const block = src.slice(src.indexOf("// Handle variant update"));
      expect(block).toMatch(/values\.push\(priceNum\)/);
      expect(block).toMatch(/values\.push\(costNum\)/);
    });
  });

  describe("R58-2 HIGH: deleteProductAction aligned with REST DELETE (soft-delete + event_kind)", () => {
    const src = read("src/app/admin/actions.ts");
    const block = src.slice(src.indexOf("export async function deleteProductAction"));
    it("uses UPDATE is_active = false (soft delete) not DELETE FROM", () => {
      expect(block.slice(0, 3000)).toMatch(/UPDATE products SET is_active = false/);
      expect(block.slice(0, 3000)).not.toMatch(/DELETE FROM products WHERE id/);
    });
    it("emits event_kind 'product_deleted' (parity with REST)", () => {
      expect(block.slice(0, 3000)).toMatch(/'product_deleted'/);
      expect(block.slice(0, 3000)).not.toMatch(/'catalog_update'[\s\S]{0,200}"action":\s*"deleted"/);
    });
    it("returns 404 on missing product before emitting audit", () => {
      expect(block.slice(0, 3000)).toMatch(/res\.rows\.length === 0[\s\S]{0,200}ROLLBACK[\s\S]{0,200}Product\+not\+found/);
    });
  });

  describe("R58-3 LOW: password-change TOCTOU also compares password_hash", () => {
    const src = read("src/app/api/auth/password-change/route.ts");
    it("guard fires on hashDrifted OR updatedAtDrifted", () => {
      expect(src).toMatch(/const hashDrifted = locked\.password_hash !== currentHash/);
      expect(src).toMatch(/if \(updatedAtDrifted \|\| hashDrifted\)/);
    });
  });

  describe("R58-4 LOW: password-reset-confirm moves assertNotReused outside tx", () => {
    const src = read("src/app/api/auth/password-reset-confirm/route.ts");
    it("assertNotReused runs OUTSIDE the client.query BEGIN block", () => {
      const assertIdx = src.indexOf("assertNotReused(newPassword, history)");
      const beginIdx = src.indexOf('client.query("BEGIN")');
      expect(assertIdx).toBeGreaterThan(-1);
      expect(beginIdx).toBeGreaterThan(-1);
      expect(assertIdx).toBeLessThan(beginIdx);
    });
    it("tx re-reads credential with FOR UPDATE + hash/updated_at TOCTOU guard", () => {
      expect(src).toMatch(/FROM auth_credentials[\s\S]{0,200}FOR UPDATE/);
      expect(src).toMatch(/hashDrifted = \(locked\.password_hash \?\? null\) !== snapHash/);
      expect(src).toMatch(/updatedAtDrifted = Math\.abs\(lockedUpdatedAt - snapUpdatedAt\) > 0/);
    });
    it("token consumption (DELETE … RETURNING) happens AFTER the reuse check", () => {
      const assertIdx = src.indexOf("assertNotReused(newPassword, history)");
      const deleteIdx = src.indexOf("DELETE FROM password_resets");
      expect(deleteIdx).toBeGreaterThan(-1);
      expect(assertIdx).toBeLessThan(deleteIdx);
    });
  });

  describe("R58-5 LOW: variant-create step-up is now unconditional", () => {
    const src = read("src/app/api/products/route.ts");
    const block = src.slice(src.indexOf("Handle variant creation"));
    it("step-up gate does NOT wrap in `price > 0` anymore", () => {
      // The gate should be present but not guarded by the price > 0
      // predicate. Look for the requireStepUp call and verify it's
      // NOT inside an `if (typeof price === 'number' && price > 0)`
      // block.
      expect(block).toMatch(/bucketKey:\s*['"]variant-price-stepup['"]/);
      expect(block).not.toMatch(/if \(typeof price === 'number' && price > 0\)[\s\S]{0,100}requireStepUp/);
    });
  });
});
