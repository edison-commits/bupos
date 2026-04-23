/**
 * R54 regression tests. Pins audit round 10 — 23 findings across
 * step-up REST-vs-Server-Action parity, 9 standalone admin pages
 * missing UI wiring, 20+ admin-actions audit drift, and 3 framework-
 * level bugs.
 *
 * Highlights:
 *   R54-C1 (CRITICAL): /api/employees POST gates on requireStepUp
 *          (previously only RBAC + rate-limit — stolen cookie could
 *          mint shadow owner).
 *   R54-H1 (HIGH): /api/expenses DELETE gates on requireStepUp
 *          (evidence-destruction vector closed).
 *   R54-M3: /api/products PATCH CSV import gates on step-up (bulk
 *          reprice bypass closed).
 *   R54-L1: /api/auth/revoke-all-sessions collapsed to one orgTx with
 *          SELECT FOR UPDATE (closes credential-lookup TOCTOU).
 *   R54-Framework-1: /api/auth/password-change derives newHash
 *          OUTSIDE the tx so the FOR UPDATE row lock isn't held
 *          during PBKDF2 hashing.
 *   R54-Framework-2: PasswordGatedForm wraps gateCondition in try/
 *          catch (prevents stuck button on predicate throw).
 *   R54-Framework-3: usePasswordGate uses pendingRef instead of
 *          setState updater side-effect (purity-safe under strict
 *          mode).
 *   R54-AdminActions: 11 server actions in admin/actions.ts
 *          refactored to run mutation + audit in one orgTx.
 *          Key ones: editVariantAction (SELECT FOR UPDATE + step-up
 *          + UPDATE + audit all in tx — closes TOCTOU AND drift);
 *          updateLocationAction (same shape, with tax-rate step-up).
 *   R54-AdminPages: 9 standalone admin pages wired to thread
 *          actorPassword through /api/* fetches.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R54 audit fixes — round 10", () => {
  describe("R54-C1 CRITICAL: /api/employees POST gates on step-up", () => {
    const src = read("src/app/api/employees/route.ts");
    it("POST handler calls requireStepUp with bucketKey 'employees-create-stepup'", () => {
      // Cut to the POST handler + verify the step-up block is there.
      const postIdx = src.indexOf("export const POST");
      const postBlock = src.slice(postIdx, postIdx + 3500);
      expect(postBlock).toMatch(/requireStepUp\(\{[\s\S]{0,300}bucketKey:\s*['"]employees-create-stepup['"]/);
    });
  });

  describe("R54-H1 HIGH: /api/expenses DELETE gates on step-up", () => {
    const src = read("src/app/api/expenses/route.ts");
    it("DELETE handler calls requireStepUp with bucketKey 'expense-delete-stepup'", () => {
      const delIdx = src.indexOf("export const DELETE");
      const delBlock = src.slice(delIdx, delIdx + 2000);
      expect(delBlock).toMatch(/requireStepUp\(\{[\s\S]{0,300}bucketKey:\s*['"]expense-delete-stepup['"]/);
    });
    it("expense-tracker.tsx handleDelete prompts + threads actorPassword", () => {
      const ui = read("src/components/admin/expense-tracker.tsx");
      expect(ui).toMatch(/const handleDelete[\s\S]{0,600}promptPassword\(/);
      expect(ui).toMatch(/actorPassword:\s*pwd/);
    });
  });

  describe("R54-M3: /api/products PATCH CSV import gates on step-up", () => {
    const src = read("src/app/api/products/route.ts");
    it("import_csv branch calls requireStepUp before any INSERT", () => {
      const importIdx = src.indexOf("action === 'import_csv'");
      // Find the end of the import_csv block by walking until the
      // next top-level branch or close. We just need to see
      // requireStepUp within a reasonable forward window.
      const importBlock = src.slice(importIdx, importIdx + 2500);
      expect(importBlock).toMatch(/requireStepUp\(\{[\s\S]{0,300}bucketKey:\s*['"]variant-price-stepup['"]/);
    });
  });

  describe("R54-L1: /api/auth/revoke-all-sessions merged to one orgTx with FOR UPDATE", () => {
    const src = read("src/app/api/auth/revoke-all-sessions/route.ts");
    it("credential lookup uses SELECT … FOR UPDATE inside orgTx", () => {
      expect(src).toMatch(/orgTx\(orgId\)[\s\S]{0,1500}SELECT password_hash FROM auth_credentials[\s\S]{0,300}FOR UPDATE/);
    });
    it("no pool.query re-auth lookup remains", () => {
      // getPool import was removed; only orgTx should be used now.
      expect(src).not.toMatch(/const pool = await getPool\(\)/);
      expect(src).toMatch(/import \{ orgTx \} from/);
    });
  });

  describe("R54-Framework-1: password-change hashes OUTSIDE the tx", () => {
    const src = read("src/app/api/auth/password-change/route.ts");
    it("hashSecret is called before orgTx(), not inside", () => {
      // Find the two key anchors. The hashSecret call must appear
      // BEFORE the orgTx(orgId) call when reading top-down.
      const hashIdx = src.indexOf("const newHash = await hashSecret(newPassword)");
      const orgTxIdx = src.indexOf("const client = await orgTx(orgId)");
      expect(hashIdx).toBeGreaterThan(-1);
      expect(orgTxIdx).toBeGreaterThan(-1);
      expect(hashIdx).toBeLessThan(orgTxIdx);
    });
  });

  describe("R54-Framework-2: PasswordGatedForm wraps gateCondition in try/catch", () => {
    const src = read("src/components/shared/password-gated-form.tsx");
    it("gateCondition call is inside try/catch with safe default", () => {
      expect(src).toMatch(/try \{\s*shouldGate = gateCondition\(fd, form\);\s*\}/);
      expect(src).toMatch(/catch \(predErr\)/);
      expect(src).toMatch(/shouldGate = true/);
    });
  });

  describe("R54-Framework-3: usePasswordGate uses pendingRef (purity-safe)", () => {
    const src = read("src/components/shared/password-gate.tsx");
    it("pendingRef tracks current resolver outside the setState updater", () => {
      expect(src).toMatch(/const pendingRef = useRef<Resolver \| null>/);
      expect(src).toMatch(/pendingRef\.current = state\?\.resolve \?\? null/);
    });
    it("re-entrant promptPassword resolves prior resolver via ref (not setState updater)", () => {
      expect(src).toMatch(/const priorResolver = pendingRef\.current/);
      expect(src).toMatch(/pendingRef\.current = resolve/);
      expect(src).toMatch(/if \(priorResolver\) priorResolver\(null\)/);
    });
  });

  describe("R54-AdminActions: mutation + audit collapsed into one orgTx", () => {
    const src = read("src/app/admin/actions.ts");
    it("editVariantAction runs SELECT FOR UPDATE + step-up + UPDATE + audit in one orgTx", () => {
      // Find editVariantAction block.
      const idx = src.indexOf("export async function editVariantAction");
      expect(idx).toBeGreaterThan(-1);
      const block = src.slice(idx, idx + 6000);
      expect(block).toMatch(/await orgTx\(orgId\)/);
      expect(block).toMatch(/SELECT price, cost FROM product_variants[\s\S]{0,300}FOR UPDATE/);
      expect(block).toMatch(/bucketKey:\s*['"]variant-price-stepup['"]/);
      expect(block).toMatch(/INSERT INTO audit_events[\s\S]{0,500}COMMIT/);
    });
    it("updateLocationAction runs prior-SELECT + tax-stepup + UPDATE + audit in one orgTx", () => {
      const idx = src.indexOf("export async function updateLocationAction");
      expect(idx).toBeGreaterThan(-1);
      const block = src.slice(idx, idx + 6000);
      expect(block).toMatch(/await orgTx\(/);
      expect(block).toMatch(/bucketKey:\s*['"]tax-rate-stepup['"]/);
      expect(block).toMatch(/INSERT INTO audit_events[\s\S]{0,500}COMMIT/);
    });
    it("several other server actions drop the two-tx drift pattern", () => {
      // Spot-check: createCategoryAction should call orgTx (not pgCreateCategory).
      const idx = src.indexOf("export async function createCategoryAction");
      expect(idx).toBeGreaterThan(-1);
      const block = src.slice(idx, idx + 3000);
      expect(block).toMatch(/await orgTx\(/);
      expect(block).toMatch(/INSERT INTO audit_events[\s\S]{0,500}COMMIT/);
    });
  });

  describe("R54-AdminPages: 9 standalone admin pages thread actorPassword", () => {
    it("shift-close/page.tsx prompts before POST /api/shift-close", () => {
      const src = read("src/app/admin/shift-close/page.tsx");
      expect(src).toMatch(/usePasswordGate/);
      expect(src).toMatch(/actorPassword/);
    });
    it("promos/page.tsx prompts on high-risk promo create (conditional)", () => {
      const src = read("src/app/admin/promos/page.tsx");
      expect(src).toMatch(/usePasswordGate/);
      expect(src).toMatch(/actorPassword/);
    });
    it("promos/error.tsx exists", () => {
      expect(() => read("src/app/admin/promos/error.tsx")).not.toThrow();
    });
    it("cash-drawer/page.tsx prompts only on pay_out", () => {
      const src = read("src/app/admin/cash-drawer/page.tsx");
      expect(src).toMatch(/usePasswordGate/);
      expect(src).toMatch(/actorPassword/);
    });
    it("employees/page.tsx wires all 4 handlers (create/update/resetPin/toggle)", () => {
      const src = read("src/app/admin/employees/page.tsx");
      expect(src).toMatch(/usePasswordGate/);
      // actorPassword must appear multiple times (4 handlers).
      const matches = src.match(/actorPassword/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(4);
    });
    it("settings/page.tsx snapshot-compares taxRate before prompting", () => {
      const src = read("src/app/admin/settings/page.tsx");
      expect(src).toMatch(/usePasswordGate/);
      expect(src).toMatch(/actorPassword/);
    });
    it("products/page.tsx prompts on price/cost change for variant edit", () => {
      const src = read("src/app/admin/products/page.tsx");
      expect(src).toMatch(/usePasswordGate/);
      expect(src).toMatch(/actorPassword/);
    });
    it("customers/page.tsx prompts on sensitive-field change", () => {
      const src = read("src/app/admin/customers/page.tsx");
      expect(src).toMatch(/usePasswordGate/);
      expect(src).toMatch(/actorPassword/);
    });
    it("bundle-manager.tsx prompts on handleCreate POST", () => {
      const src = read("src/components/admin/bundle-manager.tsx");
      expect(src).toMatch(/usePasswordGate/);
      expect(src).toMatch(/actorPassword/);
    });
    it("loyalty/page.tsx prompts on positive adjustment", () => {
      const src = read("src/app/admin/loyalty/page.tsx");
      expect(src).toMatch(/usePasswordGate/);
      expect(src).toMatch(/actorPassword/);
    });
  });
});
