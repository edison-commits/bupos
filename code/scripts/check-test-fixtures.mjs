#!/usr/bin/env node
/**
 * Quick query to see what orgs/fixtures exist so the adversarial test can
 * pick two known tenants rather than hard-coding UUIDs that might not
 * match the current DB state.
 */
import pg from "pg";
import fs from "node:fs";

const txt = fs.readFileSync("/Users/edison/Desktop/bupos/code/.env.local", "utf8");
for (const line of txt.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^"|"$/g, "");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows: orgs } = await pool.query(
  `SELECT id, name, slug FROM organizations ORDER BY created_at LIMIT 10`,
);
console.log("Orgs:");
for (const o of orgs) console.log(`  ${o.id}  ${o.name}  (${o.slug})`);

for (const o of orgs.slice(0, 3)) {
  const [locs, emps, custs, invs, gcs] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int c FROM locations WHERE organization_id = $1`, [o.id]),
    pool.query(`SELECT COUNT(*)::int c FROM employees WHERE organization_id = $1`, [o.id]),
    pool.query(`SELECT COUNT(*)::int c FROM customers WHERE organization_id = $1`, [o.id]),
    pool.query(`SELECT COUNT(*)::int c FROM inventory_levels WHERE organization_id = $1`, [o.id]),
    pool.query(`SELECT COUNT(*)::int c FROM gift_cards WHERE organization_id = $1`, [o.id]),
  ]);
  console.log(`\n  ${o.slug}:`);
  console.log(`    locations=${locs.rows[0].c}  employees=${emps.rows[0].c}  customers=${custs.rows[0].c}  inventory_levels=${invs.rows[0].c}  gift_cards=${gcs.rows[0].c}`);
}

await pool.end();
