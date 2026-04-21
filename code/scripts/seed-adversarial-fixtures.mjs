#!/usr/bin/env node
/**
 * Seed minimal data into the victim org (Basic Uniform) so the adversarial
 * cross-tenant test has real rows to attempt writes against.
 *
 * Idempotent — safe to re-run.
 */
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";

const txt = fs.readFileSync("/Users/edison/Desktop/bupos/code/.env.local", "utf8");
for (const line of txt.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^"|"$/g, "");
}

const ORG_B = "713b3ff4-0582-40b1-98b0-02303af31e6f"; // Basic Uniform

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function orgTx(orgId, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function getOrCreateLocation(orgId) {
  const { rows } = await pool.query(
    `SELECT id FROM locations WHERE organization_id = $1 LIMIT 1`,
    [orgId],
  );
  return rows[0]?.id;
}

async function getOrCreateEmployee(orgId) {
  const { rows } = await pool.query(
    `SELECT id FROM employees WHERE organization_id = $1 LIMIT 1`,
    [orgId],
  );
  return rows[0]?.id;
}

async function main() {
  const locId = await getOrCreateLocation(ORG_B);
  const empId = await getOrCreateEmployee(ORG_B);
  console.log(`ORG_B location: ${locId}`);
  console.log(`ORG_B employee: ${empId}`);

  await orgTx(ORG_B, async (c) => {
    // Idempotent seed — use a stable UUID so reruns target the same row.
    const custId = "aaaaaaaa-bbbb-cccc-dddd-000000000001";
    await c.query(
      `INSERT INTO customers (id, organization_id, first_name, last_name, email, loyalty_points, total_spend, visit_count, store_credit_balance, is_active, created_at, updated_at)
       VALUES ($1, $2, 'Victim', 'Customer', 'victim@org-b.test', 500, 0, 0, 250.00, true, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [custId, ORG_B],
    );
    console.log(`  customer: ${custId} (store_credit=250.00, loyalty=500)`);

    const gcId = "aaaaaaaa-bbbb-cccc-dddd-000000000002";
    const gcInserted = await c.query(
      `INSERT INTO gift_cards (id, organization_id, code, balance, initial_balance, status, activated_by, activated_at, created_at, updated_at)
       VALUES ($1, $2, 'ORGB-VICTIM-GC', 100.00, 100.00, 'active', $3, NOW(), NOW(), NOW())
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [gcId, ORG_B, empId],
    );
    // Matching activation transaction so the financial-invariant audit
    // (test-historical-invariants.mjs: I2) treats this fixture as clean.
    // Only insert on first seed (ON CONFLICT handled above).
    if (gcInserted.rowCount > 0) {
      await c.query(
        `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
         VALUES (gen_random_uuid(), $1, 'activation', 100.00, 100.00, $2, 'Seed fixture', NOW())`,
        [gcId, empId],
      );
    }
    console.log(`  gift_card: ${gcId} (balance=100.00)`);

    // Variant + product for the inventory row. Use pre-existing ones if any.
    const { rows: prodRows } = await c.query(
      `SELECT id FROM products WHERE organization_id = $1 LIMIT 1`,
      [ORG_B],
    );
    let productId = prodRows[0]?.id;
    if (!productId) {
      // Need a category first — products.category_id is NOT NULL.
      const { rows: catRows } = await c.query(
        `SELECT id FROM categories WHERE organization_id = $1 LIMIT 1`,
        [ORG_B],
      );
      let categoryId = catRows[0]?.id;
      if (!categoryId) {
        categoryId = crypto.randomUUID();
        await c.query(
          `INSERT INTO categories (id, organization_id, name, slug, sort_order, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, 'Test Cat', 'test-cat-' || left($1::uuid::text, 8), 0, NOW(), NOW())`,
          [categoryId, ORG_B],
        );
      }
      productId = crypto.randomUUID();
      await c.query(
        `INSERT INTO products (id, organization_id, category_id, name, slug, description, is_active, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Victim Shirt', 'victim-shirt-' || left($1::uuid::text, 8), 'Test product', true, NOW(), NOW())`,
        [productId, ORG_B, categoryId],
      );
    }
    const { rows: varRows } = await c.query(
      `SELECT id FROM product_variants WHERE product_id = $1 LIMIT 1`,
      [productId],
    );
    let variantId = varRows[0]?.id;
    if (!variantId) {
      variantId = crypto.randomUUID();
      await c.query(
        `INSERT INTO product_variants (id, organization_id, product_id, sku, name, price, size_label, color_label, is_active, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'ORGB-VICTIM-SKU', 'M / Blue', 25.00, 'M', 'Blue', true, NOW(), NOW())`,
        [variantId, ORG_B, productId],
      );
    }
    const invId = "aaaaaaaa-bbbb-cccc-dddd-000000000003";
    await c.query(
      `INSERT INTO inventory_levels (id, organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 50, 0, 5, NOW(), NOW())
       ON CONFLICT (product_variant_id, location_id) DO UPDATE SET
         on_hand = GREATEST(inventory_levels.on_hand, 50), updated_at = NOW()`,
      [invId, ORG_B, locId, variantId],
    );
    console.log(`  inventory_level: ${invId} (variant=${variantId}, on_hand=50)`);

    // A completed transaction for returns-path adversarial tests.
    const txnId = "aaaaaaaa-bbbb-cccc-dddd-000000000004";
    const existingTxn = await c.query(`SELECT id FROM transactions WHERE id = $1`, [txnId]);
    if (existingTxn.rows.length === 0) {
      const { rows: regRows } = await c.query(
        `SELECT id FROM register_sessions WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [empId],
      );
      const regSessionId = regRows[0]?.id;
      if (regSessionId) {
        await c.query(
          `INSERT INTO transactions (id, organization_id, location_id, register_session_id, employee_id,
             subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered, change_due,
             status, cart_snapshot, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 25.00, 0, 2.00, 27.00, 'cash', 30.00, 3.00, 'completed',
             $6, NOW(), NOW())`,
          [
            txnId, ORG_B, locId, regSessionId, empId,
            JSON.stringify({
              items: [{ productVariantId: variantId, unitPrice: 25, quantity: 1, productName: "Victim Shirt" }],
              _seed: "adversarial-fixture",
            }),
          ],
        );
        await c.query(
          `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata)
           VALUES (gen_random_uuid(), $1, 'cash', 30.00, '{}')`,
          [txnId],
        );
        console.log(`  transaction: ${txnId} (grand_total=27.00)`);
      } else {
        console.log(`  transaction: skipped (no register_session for employee)`);
      }
    }
  });

  await pool.end();
  console.log("\nSeed complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
