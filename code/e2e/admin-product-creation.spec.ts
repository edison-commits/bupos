/**
 * R23-H-2 regression: end-to-end admin product creation.
 *
 * R23 discovered that `createProductAction` had been silently failing
 * for an unknown number of audit rounds. The bug: the action inserted
 * a product with `default_variant_id = <variantId>` BEFORE the variant
 * existed, violating the non-deferrable FK
 * `fk_products_default_variant_id`. Every product-creation attempt
 * through the admin UI 500'd.
 *
 * No test exercised this path. A unit test couldn't catch it because
 * unit tests mocked out the DB. The only reliable way to catch this
 * class of bug is end-to-end: log in, submit the form, verify the
 * product appears.
 *
 * This test does the minimum viable e2e flow:
 *   1. Log in as the seeded admin (see e2e/global-setup.ts).
 *   2. Navigate to /admin.
 *   3. Fill in the "Create product" form.
 *   4. Submit.
 *   5. Verify the product landed in the DB (and Playwright sees a
 *      success/redirect path).
 *
 * If R23-H-2 or any similar orchestration regression ships, this test
 * fails.
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
    page.waitForURL("**/admin", { timeout: 15_000 }),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);
}

test.describe("admin product creation (R23-H-2 regression)", () => {
  test.beforeEach(async () => {
    // Purge products from the seeded org so the test is deterministic
    // across reruns.
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

  test("form submission creates product + variant + inventory without FK violation", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto("/admin");

    // The admin console starts on the Dashboard section; the Create-
    // product form lives in the Catalog section. Click the sidebar
    // button to switch.
    await page.getByRole("button", { name: /^🏷️\s*Catalog$/i }).click();

    // The form uses server-action `createProductAction`. Fill the
    // required fields. Slug is derived from name — we pick a unique
    // name per run so reruns don't collide with a leftover row.
    const suffix = Date.now().toString().slice(-6);
    const name = `E2E Test Product ${suffix}`;
    const sku = `E2E-SKU-${suffix}`;
    const variantName = "Default";

    // Fill the Create-product form inside the Catalog section. Use
    // name-attribute selectors (stable across UI changes) instead of
    // placeholder text (brittle + some placeholders collide).
    const createForm = page.locator("form").filter({ hasText: "Create product" });
    await createForm.locator('input[name="name"]').fill(name);
    await createForm.locator('input[name="sku"]').fill(sku);
    await createForm.locator('input[name="variantName"]').fill(variantName);
    await createForm.locator('input[name="price"]').fill("19.99");
    await createForm.locator('input[name="openingStock"]').fill("10");

    // The Category <select> defaults to the first option — since the
    // seed only creates one category, that's the one we want.

    // Submit. A 500 (R23-H-2) would manifest as an error toast or an
    // error page. We assert BOTH that the page redirected/re-rendered
    // AND that the product row exists in the DB.
    await Promise.all([
      page.waitForLoadState("networkidle"),
      createForm.getByRole("button", { name: /create product/i }).click(),
    ]);

    // Verify in the DB: product + variant + inventory row.
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      const { rows: products } = await pool.query(
        `SELECT id, default_variant_id FROM products WHERE organization_id = $1 AND name = $2`,
        [SEED.orgId, name],
      );
      expect(products.length, `product row should exist for name=${name}`).toBe(1);
      expect(
        products[0].default_variant_id,
        "default_variant_id should be populated (R23-H-2 regression: used to be missing/500)",
      ).not.toBeNull();

      const { rows: variants } = await pool.query(
        `SELECT id, sku FROM product_variants WHERE product_id = $1`,
        [products[0].id],
      );
      expect(variants.length).toBe(1);
      expect(variants[0].sku).toBe(sku);
      expect(variants[0].id).toBe(products[0].default_variant_id);

      const { rows: inv } = await pool.query(
        `SELECT on_hand FROM inventory_levels WHERE product_variant_id = $1 AND location_id = $2`,
        [variants[0].id, SEED.locationId],
      );
      expect(inv.length).toBe(1);
      expect(Number(inv[0].on_hand)).toBe(10);
    } finally {
      await pool.end();
    }
  });
});
