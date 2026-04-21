#!/usr/bin/env node
/**
 * Migration 035 dry-run.
 *
 * Runs supabase/migrations/035_r8_tenant_hardening.sql inside a BEGIN/ROLLBACK
 * transaction so the changes don't persist, and reports:
 *   1. Does the migration apply cleanly against current data?
 *   2. Would any VALIDATE CONSTRAINT step fail (i.e. existing negative
 *      balances that would block the CHECK constraints)?
 *   3. Does the DROP CONSTRAINT gift_cards_code_key step find the unique
 *      to drop? And does the new per-org partial index build?
 *   4. Any cross-org gift_cards.code collisions that would block the new
 *      per-org unique index?
 *
 * Run:  node scripts/test-migration-035-dryrun.mjs
 */

import pg from "pg";
import fs from "node:fs";

const txt = fs.readFileSync("/Users/edison/Desktop/bupos/code/.env.local", "utf8");
for (const line of txt.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^"|"$/g, "");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "\u2713" : "\u2717"} ${name}${detail ? `  (${detail})` : ""}`);
}

async function main() {
  console.log("─── Pre-flight checks ────────────────────────────────────");

  // 1. Any rows that would fail the CHECK constraints?
  const preflight = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM gift_cards WHERE balance < 0) AS negative_gift_cards,
      (SELECT COUNT(*)::int FROM customers WHERE store_credit_balance < 0) AS negative_store_credit,
      (SELECT COUNT(*)::int FROM customers WHERE loyalty_points < 0) AS negative_loyalty,
      (SELECT COUNT(*)::int FROM inventory_levels WHERE on_hand < 0) AS negative_inventory
  `);
  const pf = preflight.rows[0];
  console.log(`  negative_gift_cards:     ${pf.negative_gift_cards}`);
  console.log(`  negative_store_credit:   ${pf.negative_store_credit}`);
  console.log(`  negative_loyalty:        ${pf.negative_loyalty}`);
  console.log(`  negative_inventory:      ${pf.negative_inventory}`);
  const preflightClean =
    pf.negative_gift_cards === 0 &&
    pf.negative_store_credit === 0 &&
    pf.negative_loyalty === 0 &&
    pf.negative_inventory === 0;
  record(
    "Pre-flight: no negative balances that would block VALIDATE",
    preflightClean,
    preflightClean ? "clean" : "existing violations would block migration",
  );

  // 2. Gift card code collisions cross-org
  const collisions = await pool.query(`
    SELECT LOWER(code) AS code, COUNT(DISTINCT organization_id)::int AS orgs
    FROM gift_cards
    GROUP BY LOWER(code)
    HAVING COUNT(DISTINCT organization_id) > 1
  `);
  record(
    "Pre-flight: no cross-org gift card code collisions",
    collisions.rows.length === 0,
    collisions.rows.length > 0
      ? `${collisions.rows.length} codes used by multiple tenants`
      : "no collisions",
  );

  // 3. Does the global unique constraint actually exist (to drop)?
  const constraintCheck = await pool.query(`
    SELECT conname FROM pg_constraint
    WHERE conname = 'gift_cards_code_key' AND conrelid = 'gift_cards'::regclass
  `);
  console.log(`  gift_cards_code_key constraint exists: ${constraintCheck.rows.length > 0}`);

  console.log("");
  console.log("─── Dry-run of migration 035 ────────────────────────────");

  const migrationPath = "/Users/edison/Desktop/bupos/code/supabase/migrations/035_r8_tenant_hardening.sql";
  const migrationSql = fs.readFileSync(migrationPath, "utf8");

  // The migration itself uses BEGIN/COMMIT. For dry-run we strip those and
  // wrap the whole thing in our own transaction that always rolls back.
  // Remove only the outermost BEGIN/COMMIT — leave any DO $$ ... $$ blocks
  // alone (they open their own subtransactions).
  const dryRunBody = migrationSql
    .replace(/^\s*BEGIN\s*;/m, "")
    .replace(/\n\s*COMMIT\s*;\s*$/m, "");

  const client = await pool.connect();
  let ok = false;
  let errMsg = "";
  try {
    await client.query("BEGIN");
    // Statement timeout so a runaway VALIDATE doesn't hang the test.
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(dryRunBody);

    // Verify the post-state inside the tx.
    const postGiftIdx = await client.query(`
      SELECT COUNT(*)::int AS c FROM pg_indexes
      WHERE indexname = 'gift_cards_org_code_uniq' AND schemaname = 'public'
    `);
    const postChecks = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'gift_cards_balance_nonneg',
        'customers_store_credit_nonneg',
        'customers_loyalty_points_nonneg',
        'inventory_levels_on_hand_nonneg'
      )
      ORDER BY conname
    `);
    const hasDisplayTable = await client.query(`
      SELECT COUNT(*)::int AS c FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'customer_display_state'
    `);
    const postEnum = await client.query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'customer_display_state_payment_status_check'
    `);

    console.log(`  gift_cards_org_code_uniq index exists: ${postGiftIdx.rows[0].c > 0}`);
    console.log(`  CHECK constraints created: ${postChecks.rows.map((r) => r.conname).join(", ") || "<none>"}`);
    const enumDef = postEnum.rows[0]?.def ?? "";
    const displayTablePresent = hasDisplayTable.rows[0].c > 0;
    console.log(`  customer_display_state table present: ${displayTablePresent}`);
    console.log(`  customer_display_state enum def: ${enumDef || "<not applied — table absent>"}`);
    console.log("");

    record(
      "Migration applies cleanly",
      postGiftIdx.rows[0].c > 0 && postChecks.rows.length === 4,
      `new_index=${postGiftIdx.rows[0].c}, new_checks=${postChecks.rows.length}`,
    );
    // The enum extension only applies when the underlying table exists
    // (migration 010 was run). If the table isn't here, the block was
    // skipped — that's the expected behavior of the hardened guard.
    if (displayTablePresent) {
      record(
        "payment_status enum extended",
        enumDef.includes("'failed'") && enumDef.includes("'cancelled'"),
        enumDef.includes("'failed'") ? "has 'failed' and 'cancelled'" : "missing new states",
      );
    } else {
      record(
        "payment_status enum extended (skipped — table absent)",
        true,
        "migration 010 not applied; guard correctly skipped the block",
      );
    }

    ok = true;
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
    record("Migration applies cleanly", false, errMsg.slice(0, 200));
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }

  if (ok) {
    console.log("\nMigration 035 is safe to apply (all changes rolled back in dry-run).");
  } else {
    console.log(`\nMigration would fail: ${errMsg}`);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log("");
  console.log(`${passed}/${results.length} passed, ${failed} failed`);

  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
