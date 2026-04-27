/**
 * seed-pg.ts — UUID-based standalone seed script for BasicUniformPOS Postgres.
 * No @/ aliases. No server-only. Just pg + node:crypto.
 *
 * TST-M1 SAFETY: this script seeds well-known credentials (the strings
 * below are NOT secrets, they are test fixtures) and TRUNCATEs every
 * table in dependency order. Running it against a non-test DB is a
 * data-loss event AND a credential-injection event. The allowlist
 * below refuses to proceed unless DATABASE_URL points at a known-test
 * host or contains the literal string 'bupos_test' in the database
 * name. Override only by explicitly setting SEED_PG_FORCE=1 — which
 * itself prints a clear warning before proceeding.
 */
import { Pool } from 'pg';
import { randomUUID, randomBytes, scryptSync, createHash } from 'node:crypto';

// ── Crypto (mirrors src/lib/auth/crypto.ts) ──
const KEY_LENGTH = 64;
function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(secret, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${derived}`;
}

// TST-M1: refuse to run unless DATABASE_URL matches an explicit
// test-DB allowlist. The seed inserts hardcoded credentials and
// TRUNCATEs every table — if a developer accidentally has prod
// DATABASE_URL set in their shell when running `npm run seed`, the
// prior shape would happily wipe production. Allowlist:
//   - hostname is localhost / 127.0.0.1 / ::1
//   - database name contains 'bupos_test' or 'basicuniformpos_test'
//   - SEED_PG_FORCE=1 environment variable explicitly bypasses (with
//     a printed warning)
function assertSafeTargetDb(connStr: string): void {
  if (process.env.SEED_PG_FORCE === '1') {
    console.warn(
      '[seed-pg] SEED_PG_FORCE=1 — bypassing safety guard. ' +
      'TARGET DB: ' + connStr.replace(/:[^:@]*@/, ':***@'),
    );
    return;
  }
  let url: URL;
  try {
    url = new URL(connStr);
  } catch {
    throw new Error(
      `[seed-pg] DATABASE_URL is not a valid URL — refusing to seed. ` +
      `Set DATABASE_URL to a test database explicitly.`,
    );
  }
  const host = (url.hostname || '').toLowerCase();
  const dbName = (url.pathname || '').replace(/^\//, '').toLowerCase();
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  const isLocal = localHosts.has(host);
  const isTestDb = dbName.includes('bupos_test') || dbName.includes('basicuniformpos_test');
  if (!isLocal && !isTestDb) {
    throw new Error(
      `[seed-pg] refusing to seed — DATABASE_URL host '${host}' is not localhost ` +
      `and database name '${dbName}' does not contain 'bupos_test'. ` +
      `Set SEED_PG_FORCE=1 to explicitly override (will print a warning).`,
    );
  }
}

async function seedAll() {
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/bupos_test';
  assertSafeTargetDb(connectionString);
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Truncate everything in dependency order
    // TST-M1: table names corrected. The codebase canonicalized to
    // `employees` (no `_profiles` suffix) and replaced the
    // `employee_locations` join table with a `location_ids UUID[]`
    // column on the employees row directly.
    await client.query(`
      TRUNCATE TABLE
        transaction_exceptions, transaction_events, transaction_tenders,
        audit_events, register_configurations, inventory_adjustments, inventory_levels,
        product_variants, product_modifier_groups, products,
        modifiers, modifier_groups, categories,
        employees, role_permissions, roles,
        locations, organizations
      CASCADE
    `);

    const now = new Date().toISOString();

    // ── UUIDs for all entities ──
    const orgId = randomUUID();
    const locBellflower = randomUUID();

    const empOwner = randomUUID();
    const empMgr = randomUUID();
    const empCash = randomUUID();

    const catDenim = randomUUID();
    const catTops = randomUUID();
    const catAccessories = randomUUID();

    const mgGift = randomUUID();
    const mgAlterations = randomUUID();

    const modGiftWrap = randomUUID();
    const modGiftBag = randomUUID();
    const modBasicHem = randomUUID();

    const prodJean = randomUUID();
    const prodTee = randomUUID();
    const prodBelt = randomUUID();

    const varJean28Blue = randomUUID();
    const varJean30Blue = randomUUID();
    const varTeeMWhite = randomUUID();
    const varBeltMBlack = randomUUID();

    const invJean28 = randomUUID();
    const invJean30 = randomUUID();
    const invTee = randomUUID();
    const invBelt = randomUUID();

    // ── 1. Roles ──
    await client.query(`
      INSERT INTO roles (key, label, description) VALUES
        ('owner', 'Owner', 'Full access'),
        ('manager', 'Manager', 'Store operations'),
        ('cashier', 'Cashier', 'Sales and register access')
    `);

    // ── 2. Organization ──
    await client.query(
      `INSERT INTO organizations (id, slug, name, legal_name, timezone, currency_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [orgId, 'casualwear', 'Casualwear', 'Casualwear Retail LLC', 'America/Los_Angeles', 'USD', now],
    );

    // ── 3. Location ──
    await client.query(
      `INSERT INTO locations (id, organization_id, code, name, address_1, city, region, postal_code, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $9)`,
      [locBellflower, orgId, 'BELL', 'Bellflower', '16108 Lakewood Blvd', 'Bellflower', 'CA', '90706', now],
    );

    // ── 4. Employees ──
    // TST-M1: passwords/PINs randomized per-run instead of hardcoded.
    // The hashed creds are still well-known (only the seeded DB has
    // them), but the printed plaintext gives developers a one-shot
    // login + force-rotates if the script runs twice. PINs stay short
    // numeric so the dev login UI works.
    const ownerPass = randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
    const mgrPass = randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
    const ownerPin = String(Math.floor(100000 + Math.random() * 900000));
    const mgrPin = String(Math.floor(100000 + Math.random() * 900000));
    const cashPin = String(Math.floor(1000 + Math.random() * 9000));
    console.log('[seed-pg] Generated test credentials (write these down):');
    console.log(`  owner  email=owner@basicuniformpos.local password=${ownerPass} pin=${ownerPin}`);
    console.log(`  manager email=manager@basicuniformpos.local password=${mgrPass} pin=${mgrPin}`);
    console.log(`  cashier (no email) pin=${cashPin}`);
    const emps = [
      { id: empOwner, role: 'owner', first: 'Edison', last: 'Owner', display: 'Edison O.', email: 'owner@basicuniformpos.local', pin: ownerPin, pass: ownerPass },
      { id: empMgr, role: 'manager', first: 'Maya', last: 'Manager', display: 'Maya M.', email: 'manager@basicuniformpos.local', pin: mgrPin, pass: mgrPass },
      { id: empCash, role: 'cashier', first: 'Chris', last: 'Cashier', display: 'Chris C.', email: null, pin: cashPin, pass: null },
    ];
    for (const e of emps) {
      // TST-M1: table is `employees` and locations are stored as
      // location_ids UUID[] (no separate join table). Mig 035 + later.
      await client.query(
        `INSERT INTO employees (id, organization_id, role_key, first_name, last_name, display_name, email, pin_hash, pin_last_rotated_at, location_ids, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $9, $9)`,
        [e.id, orgId, e.role, e.first, e.last, e.display, e.email, hashSecret(e.pin), now, [locBellflower]],
      );
    }

    // ── 5. Categories ──
    const cats = [
      { id: catDenim, slug: 'denim', name: 'Denim', sort: 1 },
      { id: catTops, slug: 'tops', name: 'Tops', sort: 2 },
      { id: catAccessories, slug: 'accessories', name: 'Accessories', sort: 3 },
    ];
    for (const c of cats) {
      await client.query(
        `INSERT INTO categories (id, organization_id, slug, name, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [c.id, orgId, c.slug, c.name, c.sort, now],
      );
    }

    // ── 6. Modifier Groups ──
    await client.query(
      `INSERT INTO modifier_groups (id, organization_id, name, selection_mode, min_selections, max_selections, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [mgGift, orgId, 'Gift Services', 'multiple', 0, 2, now],
    );
    await client.query(
      `INSERT INTO modifier_groups (id, organization_id, name, selection_mode, min_selections, max_selections, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [mgAlterations, orgId, 'Alterations', 'single', 0, 1, now],
    );

    // ── 7. Modifiers ──
    const mods = [
      { id: modGiftWrap, groupId: mgGift, name: 'Gift wrap', delta: 4, sort: 1 },
      { id: modGiftBag, groupId: mgGift, name: 'Gift bag', delta: 2, sort: 2 },
      { id: modBasicHem, groupId: mgAlterations, name: 'Basic hem', delta: 8, sort: 1 },
    ];
    for (const m of mods) {
      await client.query(
        `INSERT INTO modifiers (id, organization_id, modifier_group_id, name, price_delta, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [m.id, orgId, m.groupId, m.name, m.delta, m.sort, now],
      );
    }

    // ── 8. Products (null default_variant_id first, update after variants) ──
    const prods = [
      { id: prodJean, catId: catDenim, slug: 'high-rise-straight-jean', name: 'High Rise Straight Jean', fav: true, mgIds: [mgAlterations] },
      { id: prodTee, catId: catTops, slug: 'oversized-tee', name: 'Oversized Tee', fav: false, mgIds: [mgGift] },
      { id: prodBelt, catId: catAccessories, slug: 'canvas-belt', name: 'Canvas Belt', fav: false, mgIds: [] },
    ];
    for (const p of prods) {
      await client.query(
        `INSERT INTO products (id, organization_id, category_id, slug, name, is_active, is_touch_favorite, default_variant_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, NULL, $7, $7)`,
        [p.id, orgId, p.catId, p.slug, p.name, p.fav, now],
      );
      for (const mgId of p.mgIds) {
        await client.query(
          `INSERT INTO product_modifier_groups (product_id, modifier_group_id) VALUES ($1, $2)`,
          [p.id, mgId],
        );
      }
    }

    // ── 9. Product Variants ──
    const vars = [
      { id: varJean28Blue, prodId: prodJean, sku: 'DENIM-HR-28-BLU', name: 'High Rise 28 Blue', size: '28', color: 'Blue', price: 89.99 },
      { id: varJean30Blue, prodId: prodJean, sku: 'DENIM-HR-30-BLU', name: 'High Rise 30 Blue', size: '30', color: 'Blue', price: 89.99 },
      { id: varTeeMWhite, prodId: prodTee, sku: 'TOP-OT-M-WHT', name: 'Oversized Tee M White', size: 'M', color: 'White', price: 34.99 },
      { id: varBeltMBlack, prodId: prodBelt, sku: 'ACC-CB-M-BLK', name: 'Canvas Belt M Black', size: 'M', color: 'Black', price: 24.99 },
    ];
    for (const v of vars) {
      await client.query(
        `INSERT INTO product_variants (id, organization_id, product_id, sku, name, size_label, color_label, price, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $9)`,
        [v.id, orgId, v.prodId, v.sku, v.name, v.size, v.color, v.price, now],
      );
    }

    // ── 10. Update products with default_variant_id ──
    await client.query(`UPDATE products SET default_variant_id = $1 WHERE id = $2`, [varJean28Blue, prodJean]);
    await client.query(`UPDATE products SET default_variant_id = $1 WHERE id = $2`, [varTeeMWhite, prodTee]);
    await client.query(`UPDATE products SET default_variant_id = $1 WHERE id = $2`, [varBeltMBlack, prodBelt]);

    // ── 11. Inventory Levels ──
    const invs = [
      { id: invJean28, locId: locBellflower, varId: varJean28Blue, onHand: 15, reorder: 5 },
      { id: invJean30, locId: locBellflower, varId: varJean30Blue, onHand: 12, reorder: 5 },
      { id: invTee, locId: locBellflower, varId: varTeeMWhite, onHand: 25, reorder: 10 },
      { id: invBelt, locId: locBellflower, varId: varBeltMBlack, onHand: 20, reorder: 8 },
    ];
    for (const i of invs) {
      await client.query(
        `INSERT INTO inventory_levels (id, organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $7)`,
        [i.id, orgId, i.locId, i.varId, i.onHand, i.reorder, now],
      );
    }

    // ── 12. Register Configuration ──
    const thresholds = { discountOver: 20, itemVoidOver: 50, transactionVoidOver: 100, storeCreditIssuanceOver: 50, manualPriceOverrideOver: 25, returnWithoutManagerOver: 75 };
    await client.query(
      `INSERT INTO register_configurations (location_id, no_receipt_enabled, receipt_mode, supported_tenders, approval_thresholds, updated_at)
       VALUES ($1, true, 'browser-print', $2, $3, $4)`,
      [locBellflower, JSON.stringify(['cash', 'card', 'store_credit', 'split']), JSON.stringify(thresholds), now],
    );

    await client.query('COMMIT');

    // ── Verification ──
    const counts: Record<string, number> = {};
    for (const t of ['organizations', 'locations', 'roles', 'employees', 'categories', 'modifier_groups', 'modifiers', 'products', 'product_modifier_groups', 'product_variants', 'inventory_levels', 'register_configurations']) {
      const r = await client.query(`SELECT count(*)::int AS c FROM ${t}`);
      counts[t] = r.rows[0].c;
    }
    console.log('Seed complete. Row counts:', JSON.stringify(counts, null, 2));

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seedAll();
