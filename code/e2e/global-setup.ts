/**
 * Playwright global setup — seed an admin employee + credential so the
 * product-creation spec can log in via the standard /login form.
 *
 * Uses the Docker Postgres directly (bypasses HTTP) to idempotently
 * create an org / location / employee / auth_credentials row.
 *
 * TST2-M2: prod-host guard. `playwright.config.ts:44` only sets
 * DATABASE_URL for the webServer subprocess; globalSetup inherits the
 * parent env. A developer running `npm run test:e2e` with .env.local
 * exporting a prod DATABASE_URL would otherwise persist
 * `e2e-admin@bupos.test` (with role `owner`) to prod with no teardown.
 * Refuse to run unless the URL is localhost or the DB name is the
 * canonical e2e test DB. Override via E2E_SETUP_FORCE=1 (with warning).
 */
import { Pool } from "pg";
import crypto from "node:crypto";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/bupos_test";

function assertSafeTargetDb(): void {
  if (process.env.E2E_SETUP_FORCE === '1') {
    console.warn('[e2e/global-setup] E2E_SETUP_FORCE=1 — bypassing prod-host safety guard.');
    return;
  }
  let url: URL;
  try {
    url = new URL(DATABASE_URL);
  } catch {
    throw new Error('[e2e/global-setup] DATABASE_URL is not a valid URL');
  }
  const host = (url.hostname || '').toLowerCase();
  const dbName = (url.pathname || '').replace(/^\//, '').toLowerCase();
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  if (LOCAL_HOSTS.has(host)) return;
  if (dbName.endsWith('_test')) return;
  const PROD_HOST_SUFFIXES = [
    '.supabase.com', '.supabase.co', '.neon.tech', '.amazonaws.com',
    '.rds.amazonaws.com', '.compute.amazonaws.com', '.herokuapp.com',
    '.dbs.aiven.io',
  ];
  if (PROD_HOST_SUFFIXES.some(s => host.endsWith(s))) {
    throw new Error(
      `[e2e/global-setup] refusing to run against host '${host}' (looks like a ` +
      `production database). The e2e test seeds an owner-role admin account ` +
      `with a known password; running against prod would persist that account. ` +
      `Set E2E_SETUP_FORCE=1 to override.`,
    );
  }
}

// NOTE: these MUST be valid RFC-4122 UUIDs (version nibble 1-8, variant
// nibble 8-b) — not just any 8-4-4-4-12 hex. Postgres's `uuid` type is
// lenient, but the API input validators use zod `z.string().uuid()`
// (strict), so an all-`3`s placeholder like e2e33333-3333-3333-3333-…
// makes POST /api/products 400 on `category_id`. The 3rd group starts
// with `4` (v4) and the 4th with `8` (variant) to satisfy that.
export const SEED = {
  orgId: "e2e11111-1111-4111-8111-111111111111",
  locationId: "e2e22222-2222-4222-8222-222222222222",
  categoryId: "e2e33333-3333-4333-8333-333333333333",
  employeeId: "e2e44444-4444-4444-8444-444444444444",
  email: "e2e-admin@bupos.test",
  password: "P4ssword!e2e",
};

async function hashPbkdf2(password: string): Promise<string> {
  // Mirrors `hashSecret` in @/lib/auth/crypto:
  //   PBKDF2-SHA-256, 100k iterations, 16-byte salt, 64-byte key
  //   format `{saltHex}:{derivedHex}` with `:` separator.
  const iterations = 100_000;
  const keyLength = 64;
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, iterations, keyLength, "sha256");
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export default async function globalSetup(): Promise<void> {
  assertSafeTargetDb();
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const pwHash = await hashPbkdf2(SEED.password);

  try {
    // Idempotent seed: INSERT ... ON CONFLICT DO NOTHING for each row
    // so re-runs don't duplicate + don't fail on the unique constraints
    // added by migration 051.
    await pool.query(
      `INSERT INTO organizations (id, name, slug, legal_name, timezone, currency_code, plan, is_active)
       VALUES ($1, 'E2E Store', 'e2e-store', 'E2E Store LLC', 'America/Los_Angeles', 'USD', 'free', true)
       ON CONFLICT (id) DO NOTHING`,
      [SEED.orgId],
    );
    await pool.query(
      `INSERT INTO locations (id, organization_id, name, code, address1, city, region, postal_code, tax_rate, is_active)
       VALUES ($1, $2, 'E2E Main', 'E2E-MAIN', '1 E2E St', 'LA', 'CA', '90001', 0.0, true)
       ON CONFLICT (id) DO NOTHING`,
      [SEED.locationId, SEED.orgId],
    );
    await pool.query(
      `INSERT INTO categories (id, organization_id, name, slug, sort_order)
       VALUES ($1, $2, 'E2E Cat', 'e2e-cat', 0)
       ON CONFLICT (id) DO NOTHING`,
      [SEED.categoryId, SEED.orgId],
    );
    await pool.query(
      `INSERT INTO employees (id, organization_id, role_key, first_name, last_name, display_name, email, pin_hint, is_active, location_ids)
       VALUES ($1, $2, 'owner', 'E2E', 'Admin', 'E2E Admin', $3, '', true, ARRAY[$4]::uuid[])
       ON CONFLICT (id) DO NOTHING`,
      [SEED.employeeId, SEED.orgId, SEED.email, SEED.locationId],
    );
    // Upsert credential so password is always the SEED value (re-runs
    // may change the hash).
    await pool.query(
      `INSERT INTO auth_credentials (employee_id, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id) DO UPDATE SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash`,
      [SEED.employeeId, SEED.email, pwHash],
    );

    // Showcase-only fictional fixture data. This is local e2e state, not a
    // production seed: it exists so authenticated screenshots show useful
    // retail workflows instead of empty dashboards.
    await pool.query(`
      INSERT INTO products (id, organization_id, category_id, name, slug, description, is_active, is_touch_favorite)
      VALUES
        ('e2e88888-8888-4888-8888-888888888881', $1, $2, 'Classic Polo', 'classic-polo', 'Everyday cotton polo', true, true),
        ('e2e88888-8888-4888-8888-888888888882', $1, $2, 'Performance Chino', 'performance-chino', 'Stretch chino for the workday', true, true),
        ('e2e88888-8888-4888-8888-888888888883', $1, $2, 'Canvas Tote', 'canvas-tote', 'Reusable store tote', true, false),
        ('e2e88888-8888-4888-8888-888888888884', $1, $2, 'Merino Cardigan', 'merino-cardigan', 'Layering piece in merino blend', true, false)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_active = true`,
      [SEED.orgId, SEED.categoryId],
    );
    await pool.query(`
      INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, size_label, color_label, price, compare_at_price, cost, is_active)
      VALUES
        ('e2e99999-9999-4999-8999-999999999981', $1, 'e2e88888-8888-4888-8888-888888888881', 'POLO-NAVY-M', 'E2E-POLO-M', 'Classic Polo · M · Navy', 'M', 'Navy', 34.00, 39.00, 12.00, true),
        ('e2e99999-9999-4999-8999-999999999982', $1, 'e2e88888-8888-4888-8888-888888888882', 'CHINO-KHAKI-32', 'E2E-CHINO-32', 'Performance Chino · 32 · Khaki', '32', 'Khaki', 58.00, 64.00, 22.00, true),
        ('e2e99999-9999-4999-8999-999999999983', $1, 'e2e88888-8888-4888-8888-888888888883', 'TOTE-NATURAL', 'E2E-TOTE', 'Canvas Tote · Natural', 'One Size', 'Natural', 18.00, null, 6.00, true),
        ('e2e99999-9999-4999-8999-999999999984', $1, 'e2e88888-8888-4888-8888-888888888884', 'CARDIGAN-GREY-L', 'E2E-CARD-L', 'Merino Cardigan · L · Grey', 'L', 'Grey', 86.00, 99.00, 35.00, true)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, is_active = true`,
      [SEED.orgId],
    );
    await pool.query(`
      INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point, received_at)
      VALUES
        ($1, 'e2e99999-9999-4999-8999-999999999981', $2, 42, 3, 12, now() - interval '4 days'),
        ($1, 'e2e99999-9999-4999-8999-999999999982', $2, 18, 2, 8, now() - interval '2 days'),
        ($1, 'e2e99999-9999-4999-8999-999999999983', $2, 76, 0, 15, now() - interval '8 days'),
        ($1, 'e2e99999-9999-4999-8999-999999999984', $2, 7, 1, 6, now() - interval '1 day')
      ON CONFLICT (product_variant_id, location_id) DO UPDATE SET on_hand = EXCLUDED.on_hand, reserved = EXCLUDED.reserved, reorder_point = EXCLUDED.reorder_point`,
      [SEED.orgId, SEED.locationId],
    );
    await pool.query(`
      INSERT INTO customers (id, organization_id, first_name, last_name, email, phone, loyalty_points, total_spend, visit_count, store_credit_balance, is_active)
      VALUES
        ('e2e77777-7777-4777-8777-777777777771', $1, 'Maya', 'Rivera', 'maya.rivera@fixture.test', '555-0101', 420, 286.00, 5, 0, true),
        ('e2e77777-7777-4777-8777-777777777772', $1, 'Jordan', 'Lee', 'jordan.lee@fixture.test', '555-0102', 180, 124.00, 3, 15, true),
        ('e2e77777-7777-4777-8777-777777777773', $1, 'Casey', 'Morgan', 'casey.morgan@fixture.test', '555-0103', 75, 68.00, 2, 0, true),
        ('e2e77777-7777-4777-8777-777777777774', $1, 'Riley', 'Chen', 'riley.chen@fixture.test', '555-0104', 610, 412.00, 8, 0, true)
      ON CONFLICT (id) DO UPDATE SET loyalty_points = EXCLUDED.loyalty_points, total_spend = EXCLUDED.total_spend, visit_count = EXCLUDED.visit_count`,
      [SEED.orgId],
    );
    await pool.query(`
      INSERT INTO suppliers (id, organization_id, name, contact_name, email, phone, address, notes, is_active)
      VALUES ('e2eddddd-dddd-4ddd-8ddd-ddddddddddd1', $1, 'Northstar Apparel Supply', 'Sam Taylor', 'orders@fixture.test', '555-0110', '100 Market Street', 'Synthetic showcase supplier', true)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_active = true`,
      [SEED.orgId],
    );
    await pool.query(`
      INSERT INTO purchase_orders (id, organization_id, supplier_id, location_id, po_number, status, notes, ordered_at, expected_at)
      VALUES ('e2efffff-ffff-4fff-8fff-fffffffffff1', $1, 'e2eddddd-dddd-4ddd-8ddd-ddddddddddd1', $2, 'PO-E2E-1042', 'submitted', 'Synthetic showcase replenishment order', now() - interval '1 day', now() + interval '5 days')
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, expected_at = EXCLUDED.expected_at`,
      [SEED.orgId, SEED.locationId],
    );
    await pool.query(`
      INSERT INTO purchase_order_lines (id, purchase_order_id, product_variant_id, quantity_ordered, quantity_received, unit_cost)
      VALUES
        ('e2eaaaaa-1111-4111-8111-111111111111', 'e2efffff-ffff-4fff-8fff-fffffffffff1', 'e2e99999-9999-4999-8999-999999999981', 24, 0, 12.00),
        ('e2eaaaaa-2222-4222-8222-222222222222', 'e2efffff-ffff-4fff-8fff-fffffffffff1', 'e2e99999-9999-4999-8999-999999999982', 12, 0, 22.00)
      ON CONFLICT (id) DO UPDATE SET quantity_ordered = EXCLUDED.quantity_ordered, quantity_received = EXCLUDED.quantity_received`,
    );

    await pool.query(`
      INSERT INTO register_sessions (id, organization_id, auth_session_id, employee_id, location_id, status, started_at)
      VALUES ('e2e66666-6666-4666-8666-666666666661', $1, 'e2eaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', $2, $3, 'ended', now() - interval '9 days')
      ON CONFLICT (id) DO NOTHING`,
      [SEED.orgId, SEED.employeeId, SEED.locationId],
    );
    await pool.query(`
      INSERT INTO shifts (id, organization_id, location_id, employee_id, register_session_id, status, opened_at, opening_float, closed_at, closing_expected_cash, closing_declared_cash, closing_variance)
      VALUES ('e2ebbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', $1, $2, $3, 'e2e66666-6666-4666-8666-666666666661', 'closed', now() - interval '9 days', 200, now() - interval '9 days' + interval '8 hours', 744, 744, 0)
      ON CONFLICT (id) DO NOTHING`,
      [SEED.orgId, SEED.locationId, SEED.employeeId],
    );
    await pool.query(`
      INSERT INTO transactions (id, organization_id, location_id, register_session_id, employee_id, customer_id, cart_snapshot, subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered, change_due, status, created_at)
      VALUES
        ('e2eccccc-cccc-4ccc-8ccc-ccccccccccc1', $1, $2, 'e2e66666-6666-4666-8666-666666666661', $3, 'e2e77777-7777-4777-8777-777777777771', '{"items":[{"name":"Classic Polo","quantity":2,"price":34}],"fixture":true}', 68, 0, 6.46, 74.46, 'card', 74.46, 0, 'completed', now() - interval '2 hours'),
        ('e2eccccc-cccc-4ccc-8ccc-ccccccccccc2', $1, $2, 'e2e66666-6666-4666-8666-666666666661', $3, 'e2e77777-7777-4777-8777-777777777772', '{"items":[{"name":"Performance Chino","quantity":1,"price":58},{"name":"Canvas Tote","quantity":1,"price":18}],"fixture":true}', 76, 8, 6.46, 74.46, 'cash', 74.46, 0, 'completed', now() - interval '4 hours'),
        ('e2eccccc-cccc-4ccc-8ccc-ccccccccccc3', $1, $2, 'e2e66666-6666-4666-8666-666666666661', $3, 'e2e77777-7777-4777-8777-777777777773', '{"items":[{"name":"Merino Cardigan","quantity":1,"price":86}],"fixture":true}', 86, 0, 8.17, 94.17, 'card', 94.17, 0, 'completed', now() - interval '6 hours'),
        ('e2eccccc-cccc-4ccc-8ccc-ccccccccccc4', $1, $2, 'e2e66666-6666-4666-8666-666666666661', $3, 'e2e77777-7777-4777-8777-777777777774', '{"items":[{"name":"Classic Polo","quantity":1,"price":34},{"name":"Canvas Tote","quantity":1,"price":18}],"fixture":true}', 52, 0, 4.94, 56.94, 'card', 56.94, 0, 'completed', now() - interval '8 hours')
      ON CONFLICT (id) DO NOTHING`,
      [SEED.orgId, SEED.locationId, SEED.employeeId],
    );
    await pool.query(`
      UPDATE transactions SET amount_tendered = grand_total, change_due = 0
      WHERE id IN ('e2eccccc-cccc-4ccc-8ccc-ccccccccccc1','e2eccccc-cccc-4ccc-8ccc-ccccccccccc2','e2eccccc-cccc-4ccc-8ccc-ccccccccccc3','e2eccccc-cccc-4ccc-8ccc-ccccccccccc4')
    `);
    await pool.query(`
      INSERT INTO transaction_tenders (transaction_id, tender_type, amount)
      SELECT id, tender_type, amount_tendered FROM transactions
      WHERE id IN ('e2eccccc-cccc-4ccc-8ccc-ccccccccccc1','e2eccccc-cccc-4ccc-8ccc-ccccccccccc2','e2eccccc-cccc-4ccc-8ccc-ccccccccccc3','e2eccccc-cccc-4ccc-8ccc-ccccccccccc4')
      ON CONFLICT DO NOTHING`,
    );
  } finally {
    await pool.end();
  }
}
