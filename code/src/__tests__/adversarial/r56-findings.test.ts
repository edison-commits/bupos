/**
 * R56 regression tests. Pins audit round 11 — 14 findings:
 *   6 HIGH: /api/products CSV import + POST-variant + DELETE missing
 *           audit/pricing gate; editVariantAction + updateLocationAction
 *           held row-locks across step-up; promos client/server
 *           divergence letting "unlimited" promos bypass gating.
 *   3 MEDIUM: password-change + revoke-all-sessions held row-lock
 *             across verifySecret / assertNotReused; createEmployeeAction
 *             lacked PIN length + collision parity with REST.
 *   5 LOW: employees page handlers lacked double-submit guards;
 *          float-equality mismatches between UI and server; no-op
 *          audit rows; comment drift.
 *
 * The marquee shape change of R56 is the "step-up OUTSIDE tx + TOCTOU
 * guard" pattern, now applied to editVariantAction, updateLocationAction,
 * password-change, and revoke-all-sessions — none of them hold an
 * auth_credentials or product_variants row lock across PBKDF2 anymore.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R56 audit fixes — round 11", () => {
  describe("R56-A1 HIGH: /api/products CSV import gates + audits", () => {
    const src = read("src/app/api/products/route.ts");
    it("CSV import requires pricing.manage permission", () => {
      const importBlock = src.slice(src.indexOf("action === 'import_csv'"));
      expect(importBlock).toMatch(/hasPermission\(employee\.roleKey,\s*["']pricing\.manage["']\)/);
    });
    it("CSV import writes a catalog_import audit INSIDE the tx", () => {
      const importBlock = src.slice(src.indexOf("action === 'import_csv'"));
      expect(importBlock).toMatch(/INSERT INTO audit_events[\s\S]{0,800}'catalog_import'[\s\S]{0,600}await client\.query\('COMMIT'\)/);
    });
  });

  describe("R56-A2 HIGH: /api/products POST variant-create gates + audits", () => {
    const src = read("src/app/api/products/route.ts");
    it("variant-create requires pricing.manage", () => {
      const block = src.slice(src.indexOf("Handle variant creation"));
      expect(block).toMatch(/hasPermission\(employee\.roleKey,\s*["']pricing\.manage["']\)/);
    });
    it("variant-create gates on requireStepUp when price > 0", () => {
      const block = src.slice(src.indexOf("Handle variant creation"));
      expect(block).toMatch(/typeof price === 'number' && price > 0/);
      expect(block).toMatch(/bucketKey:\s*['"]variant-price-stepup['"]/);
    });
    it("variant-create writes a variant_created audit", () => {
      const block = src.slice(src.indexOf("Handle variant creation"));
      expect(block).toMatch(/'variant_created'/);
    });
  });

  describe("R56-A3 HIGH: /api/products DELETE audits", () => {
    const src = read("src/app/api/products/route.ts");
    it("DELETE writes product_deleted audit INSIDE tx", () => {
      const delBlock = src.slice(src.indexOf("export const DELETE"));
      expect(delBlock).toMatch(/'product_deleted'/);
      expect(delBlock).toMatch(/INSERT INTO audit_events[\s\S]{0,500}await client\.query\('COMMIT'\)/);
    });
  });

  describe("R56-B1 HIGH: editVariantAction — step-up outside tx, TOCTOU guard", () => {
    const src = read("src/app/admin/actions.ts");
    const block = src.slice(src.indexOf("export async function editVariantAction"));
    it("uses non-locking orgQuery for the snapshot read", () => {
      expect(block).toMatch(/orgQuery\([\s\S]{0,200}SELECT price, cost FROM product_variants[\s\S]{0,200}LIMIT 1/);
    });
    it("step-up runs BEFORE orgTx (outside the lock)", () => {
      const stepUpIdx = block.indexOf("bucketKey: 'variant-price-stepup'");
      const orgTxIdx = block.indexOf("await orgTx(orgId)");
      expect(stepUpIdx).toBeGreaterThan(-1);
      expect(orgTxIdx).toBeGreaterThan(-1);
      expect(stepUpIdx).toBeLessThan(orgTxIdx);
    });
    it("tx re-reads with FOR UPDATE and compares for TOCTOU drift", () => {
      expect(block).toMatch(/SELECT price, cost FROM product_variants[\s\S]{0,200}FOR UPDATE/);
      expect(block).toMatch(/priceDrift \|\| costDrift/);
      expect(block).toMatch(/toctou_retry/);
    });
  });

  describe("R56-B2 HIGH: updateLocationAction — step-up outside tx, TOCTOU guard", () => {
    const src = read("src/app/admin/actions.ts");
    const block = src.slice(src.indexOf("export async function updateLocationAction"));
    it("uses non-locking orgQuery for the tax snapshot", () => {
      expect(block).toMatch(/orgQuery\([\s\S]{0,200}SELECT tax_rate FROM locations[\s\S]{0,200}LIMIT 1/);
    });
    it("step-up runs BEFORE orgTx", () => {
      const stepUpIdx = block.indexOf("bucketKey: \"tax-rate-stepup\"");
      const orgTxIdx = block.indexOf("await orgTx(");
      expect(stepUpIdx).toBeGreaterThan(-1);
      expect(orgTxIdx).toBeGreaterThan(-1);
      expect(stepUpIdx).toBeLessThan(orgTxIdx);
    });
    it("tx re-reads with FOR UPDATE and guards TOCTOU drift", () => {
      expect(block).toMatch(/SELECT tax_rate FROM locations[\s\S]{0,200}FOR UPDATE/);
      expect(block).toMatch(/drifted && taxRate !== undefined/);
    });
  });

  describe("R56-B3 MEDIUM: password-change — verifySecret + assertNotReused outside tx", () => {
    const src = read("src/app/api/auth/password-change/route.ts");
    it("verifySecret runs OUTSIDE orgTx (before it)", () => {
      const verifyIdx = src.indexOf("verifySecret(currentPassword,");
      const orgTxIdx = src.indexOf("const client = await orgTx(orgId)");
      expect(verifyIdx).toBeGreaterThan(-1);
      expect(orgTxIdx).toBeGreaterThan(-1);
      expect(verifyIdx).toBeLessThan(orgTxIdx);
    });
    it("assertNotReused runs OUTSIDE orgTx", () => {
      const reuseIdx = src.indexOf("assertNotReused(newPassword");
      const orgTxIdx = src.indexOf("const client = await orgTx(orgId)");
      expect(reuseIdx).toBeGreaterThan(-1);
      expect(reuseIdx).toBeLessThan(orgTxIdx);
    });
    it("tx re-reads with FOR UPDATE + compares updated_at for TOCTOU", () => {
      expect(src).toMatch(/SELECT password_hash, updated_at FROM auth_credentials[\s\S]{0,300}FOR UPDATE/);
      expect(src).toMatch(/Math\.abs\(lockedUpdatedAt - snapUpdatedAt\)/);
    });
  });

  describe("R56-B4 MEDIUM: revoke-all-sessions — verifySecret outside tx", () => {
    const src = read("src/app/api/auth/revoke-all-sessions/route.ts");
    it("verifySecret runs OUTSIDE orgTx", () => {
      const verifyIdx = src.indexOf("verifySecret(currentPassword,");
      const orgTxIdx = src.indexOf("const client = await orgTx(orgId)");
      expect(verifyIdx).toBeGreaterThan(-1);
      expect(orgTxIdx).toBeGreaterThan(-1);
      expect(verifyIdx).toBeLessThan(orgTxIdx);
    });
    it("tx compares snapshot hash vs locked hash for TOCTOU", () => {
      expect(src).toMatch(/lockedHash !== snapHash/);
    });
  });

  describe("R56-C HIGH: promo-codes client/server step-up alignment", () => {
    it("server gates on percent≥50 OR fixed≥50 OR unbounded (≥1M sentinel)", () => {
      const src = read("src/app/api/promo-codes/route.ts");
      expect(src).toMatch(/isHighValueFixed = type === 'fixed' && Number\(value\) >= 50/);
      expect(src).toMatch(/isHighPercent = type === 'percent' && Number\(value\) >= 50/);
      expect(src).toMatch(/Number\(maxRedemptions\) >= 1_000_000/);
    });
    it("client gates on same three predicates (parity)", () => {
      const src = read("src/app/admin/promos/page.tsx");
      expect(src).toMatch(/isHighValueFixed = form\.type === ["']fixed["'] && value >= 50/);
      expect(src).toMatch(/isHighPercent = form\.type === ["']percent["'] && value >= 50/);
      expect(src).toMatch(/maxAfterTransform >= 1_000_000/);
    });
  });

  describe("R56-D MEDIUM: createEmployeeAction parity with REST POST", () => {
    const src = read("src/app/admin/actions.ts");
    const block = src.slice(src.indexOf("export async function createEmployeeAction"));
    it("owner/manager require PIN length ≥ 6 (R27-H1 parity)", () => {
      expect(block).toMatch(/minPinLen = isPrivilegedRole \? 6 : 4/);
    });
    it("PIN collision check scans existing auth_credentials in org", () => {
      expect(block).toMatch(/SELECT ac\.pin_hash FROM auth_credentials[\s\S]{0,200}organization_id = \$1/);
    });
    it("audit event_kind is 'employee_created' (was misclassified as 'catalog_update')", () => {
      expect(block).toMatch(/'employee_created'/);
    });
  });

  describe("R56-E MEDIUM: employees page handlers have double-submit guards", () => {
    const src = read("src/app/admin/employees/page.tsx");
    const resetBlock = src.slice(src.indexOf("const handleResetPin"));
    const toggleBlock = src.slice(src.indexOf("const handleToggleStatus"));
    it("handleResetPin checks + sets `submitting`", () => {
      expect(resetBlock.slice(0, 2000)).toMatch(/if \(submitting\) return/);
      expect(resetBlock.slice(0, 2000)).toMatch(/setSubmitting\(true\)/);
    });
    it("handleToggleStatus checks + sets `submitting`", () => {
      expect(toggleBlock.slice(0, 2000)).toMatch(/if \(submitting\) return/);
      expect(toggleBlock.slice(0, 2000)).toMatch(/setSubmitting\(true\)/);
    });
  });

  describe("R56-LOW: float-equality uses epsilon on client (parity with server)", () => {
    it("products/page.tsx uses Math.abs(...) > 0.005 for price/cost", () => {
      const src = read("src/app/admin/products/page.tsx");
      expect(src).toMatch(/Math\.abs\(Number\(snapshot\.price\) - Number\(formData\.price\)\) > 0\.005/);
      expect(src).toMatch(/Math\.abs\(Number\(snapshot\.cost\) - Number\(formData\.cost\)\) > 0\.005/);
    });
    it("settings/page.tsx uses Math.abs(...) > 1e-6 for taxRate", () => {
      const src = read("src/app/admin/settings/page.tsx");
      expect(src).toMatch(/Math\.abs\(data\.taxRate - settings\.location\.taxRate\) > 1e-6/);
    });
  });
});
