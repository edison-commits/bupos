/**
 * End-to-end admin product creation via the /admin/products page.
 *
 * History: R23-H-2 found that the OLD inline `createProductAction` form
 * (rendered in admin-console.tsx on /admin) had been silently 500'ing —
 * it inserted a product with `default_variant_id` before the variant
 * existed, violating a non-deferrable FK. That exact regression is now
 * pinned by the integration suite
 * (src/__tests__/integration/admin-product-creation.test.ts).
 *
 * The admin Catalog UI has since MOVED: the inline /admin sections had
 * production crashes, so Catalog/Inventory/Settings became dedicated
 * routes (admin-sidebar.tsx). Product creation is now a MODAL on
 * /admin/products that POSTs to /api/products. This e2e drives that real
 * UI end-to-end:
 *   1. Log in as the seeded admin (see e2e/global-setup.ts).
 *   2. Navigate to /admin/products.
 *   3. Open the "Add Product" modal, fill it, Save.
 *   4. Verify the product landed in the DB.
 *
 * If the product-creation UI or its /api/products write regresses, this
 * test fails.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { SEED } from "./global-setup";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/bupos_test";

async function loginAsAdmin(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(SEED.email);
  await page.getByLabel(/password/i).fill(SEED.password);
  await Promise.all([
    // 30s (not 15s): /admin is a large page; its first cold compile under
    // `next dev` can take 15-25s, and the login redirect lands there.
    page.waitForURL("**/admin", { timeout: 30_000 }),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);
}

test.describe("admin product creation", () => {
  test.beforeEach(async () => {
    // Purge e2e products from the seeded org so reruns are deterministic.
    // The modal derives the slug from the name (lowercased, spaces→dashes),
    // so an "E2E Test Product …" name yields an "e2e-test-…" slug.
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      await pool.query(
        `DELETE FROM products WHERE organization_id = $1 AND slug LIKE 'e2e-test-%'`,
        [SEED.orgId],
      );
    } finally {
      await pool.end();
    }
  });

  test("creating a product via the /admin/products modal persists it", async ({ page }) => {
    // Cold-compile headroom: under `next dev` this test compiles two heavy
    // pages on first hit (/admin during login + /admin/products), which can
    // exceed the default 30s per-test budget on a cold runner.
    test.setTimeout(90_000);
    await loginAsAdmin(page);
    await page.goto("/admin/products");

    const suffix = Date.now().toString().slice(-6);
    const name = `E2E Test Product ${suffix}`;

    // Open the Add-Product modal. (The page also has "📥 Import CSV"; the
    // /Add Product/ name only matches the "+ Add Product" trigger.)
    await page.getByRole("button", { name: /Add Product/i }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();

    // Fill the name (the slug auto-derives) and pick the seeded category
    // ("E2E Cat" — global-setup creates exactly one).
    await modal.getByLabel("Product Name", { exact: true }).fill(name);
    await modal.getByRole("combobox").selectOption({ label: "E2E Cat" });

    // Save → POST /api/products. The modal closes on success.
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/products") && r.request().method() === "POST" && r.ok(),
        { timeout: 15_000 },
      ),
      modal.getByRole("button", { name: /^save$/i }).click(),
    ]);
    await expect(modal).toBeHidden({ timeout: 10_000 });

    // Verify the product row landed in the DB under the seeded org +
    // category.
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      const { rows: products } = await pool.query(
        `SELECT id, category_id, slug FROM products WHERE organization_id = $1 AND name = $2`,
        [SEED.orgId, name],
      );
      expect(products.length, `product row should exist for name=${name}`).toBe(1);
      expect(
        products[0].category_id,
        "category should be set to the seeded category",
      ).toBe(SEED.categoryId);
      expect(products[0].slug).toMatch(/^e2e-test-product-/);
    } finally {
      await pool.end();
    }
  });
});
