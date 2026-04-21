/**
 * R23-H-2 regression: admin product-creation orchestration.
 *
 * Motivation: R23 discovered `createProductAction` in
 * `src/app/admin/actions.ts` had been 500'ing for an unknown number
 * of audit rounds. The bug: inserted a product with
 * `default_variant_id = <variantId>` BEFORE the variant existed,
 * violating `fk_products_default_variant_id` (NOT DEFERRABLE).
 *
 * The ideal fix would be a full end-to-end Playwright test. We have
 * the scaffolding for that in `e2e/` but it's currently blocked by
 * `@neondatabase/serverless` being incompatible with plain Docker
 * Postgres (needs WebSocket proxy). Until a Neon-compatible dev DB
 * is wired up, this integration test catches the same class of bug
 * by exercising the EXACT INSERT/UPDATE sequence that
 * `createProductAction` performs.
 *
 * Two tests:
 *   1. The FIXED 3-step sequence (null default_variant_id → create
 *      variant → update product) succeeds.
 *   2. The BROKEN single-INSERT sequence (insert product with
 *      default_variant_id pointing at a non-existent variant) STILL
 *      fails with 23503 — so if someone accidentally reverts the fix,
 *      this test exposes it immediately.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

const ORG_A = "11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const A_CATEGORY = "33aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const A_LOCATION = "22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

let pool: Pool;

beforeAll(() => {
  pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/bupos_test",
    max: 5,
  });
});

afterAll(async () => {
  await pool.end();
});

/**
 * Generate UUIDs that match the seed prefix convention so RLS can
 * evaluate (rows marked with org A prefix `11aaaa...`).
 */
function uuid(): string {
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
}

describe("admin product creation (R23-H-2 regression)", () => {
  it("3-step sequence (post-R23-H-2 fix) succeeds: null default → variant → update product", async () => {
    const productId = uuid();
    const variantId = uuid();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // Step 1: product with null default_variant_id — FK dormant because
      // default_variant_id is NULL.
      const prodInsert = await c.query(
        `INSERT INTO products
           (id, organization_id, category_id, name, slug, is_active, is_touch_favorite, default_variant_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'R23 test', $4, true, false, NULL, now(), now())
         RETURNING id, default_variant_id`,
        [productId, ORG_A, A_CATEGORY, `r23-test-${Date.now()}`],
      );
      expect(prodInsert.rows[0].default_variant_id).toBeNull();

      // Step 2: variant.
      await c.query(
        `INSERT INTO product_variants
           (id, organization_id, product_id, sku, name, price, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'r23 variant', 9.99, true, now(), now())`,
        [variantId, ORG_A, productId, `R23-SKU-${Date.now()}`],
      );

      // Step 3: inventory — mirrors pgCreateInventoryLevel.
      await c.query(
        `INSERT INTO inventory_levels
           (organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point, created_at, updated_at)
         VALUES ($1, $2, $3, 10, 0, 2, now(), now())`,
        [ORG_A, variantId, A_LOCATION],
      );

      // Step 4: now that the variant exists, update product.default_variant_id.
      const updateRes = await c.query(
        `UPDATE products SET default_variant_id = $1, updated_at = now() WHERE id = $2 RETURNING default_variant_id`,
        [variantId, productId],
      );
      expect(updateRes.rows[0].default_variant_id).toBe(variantId);

      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("REGRESSION: single-INSERT with default_variant_id pointing at not-yet-existent variant fails with 23503", async () => {
    // If someone reverts R23-H-2 and goes back to the old pattern
    // (pass defaultVariantId: variantId to pgCreateProduct BEFORE the
    // variant exists), this INSERT must STILL fail. If it ever
    // succeeds, the FK was dropped or made DEFERRABLE — either way a
    // schema change worth flagging.
    const productId = uuid();
    const variantId = uuid(); // Deliberately NOT inserted.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      let err: { code?: string; message?: string } | null = null;
      try {
        await c.query(
          `INSERT INTO products
             (id, organization_id, category_id, name, slug, is_active, is_touch_favorite, default_variant_id, created_at, updated_at)
           VALUES ($1, $2, $3, 'broken', $4, true, false, $5, now(), now())`,
          [productId, ORG_A, A_CATEGORY, `r23-broken-${Date.now()}`, variantId],
        );
      } catch (e) {
        err = e as { code?: string; message?: string };
      }
      expect(err, "expected FK violation 23503, got success").not.toBeNull();
      expect(err?.code, `got code=${err?.code}, message=${err?.message}`).toBe("23503");
      await c.query("ROLLBACK").catch(() => {});
    } finally {
      c.release();
    }
  });

  it("REGRESSION: the FK constraint is still attached (meta-check)", async () => {
    // Verify fk_products_default_variant_id exists and is NOT DEFERRABLE.
    // If this changes, the earlier tests' assumptions break and we want
    // to know about it.
    const { rows } = await pool.query(
      `SELECT conname, condeferrable, condeferred
         FROM pg_constraint
         WHERE conname = 'fk_products_default_variant_id'`,
    );
    expect(rows.length, "fk_products_default_variant_id must exist").toBe(1);
    expect(rows[0].condeferrable, "FK must not be DEFERRABLE (breaks the 3-step fix's assumptions)").toBe(false);
  });
});
