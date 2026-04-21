#!/usr/bin/env node
/**
 * Inter-store transfer simulator. Exercises the full transfer lifecycle
 * (create → ship → receive, plus one cancel) across the three Casualwear
 * locations (Bellflower + newly-added El Monte + Torrance). Mirrors the
 * SQL logic in /api/transfers/route.ts but skips HTTP so we can backdate
 * created_at for a realistic dataset.
 *
 * Before simulating, seeds Bellflower to 50 units/variant so there's
 * enough stock to move. Reports per-location deltas before/after.
 */

import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";

const ORG = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const LOCATIONS = {
  Bellflower: "c57268b3-cb14-4c1a-bda6-55e49ddc6313",
  "El Monte": "8972123b-e4c5-47ed-bc1d-f47af5628ebf",
  Torrance:   "6c6a479c-13ee-453b-ae9c-aa318b2db9b4",
};
const VARIANTS = {
  "DEN-HR-28-BLU": "3fcfb7b8-856c-4ed7-8cd2-cbb1666f2e18",
  "DEN-HR-30-BLU": "13b7dd62-e5d6-4a1b-bf90-0fbaefb56032",
  "TOP-OS-L-WHT":  "20e5e39c-fa01-41ed-9a48-fe9886b0dc75",
  "TOP-OS-M-BLK":  "021e7e4d-88c3-42bd-8b47-d8e8d97f84b7",
};
const EMPLOYEE_EDISON = "fe47b5a2-81f3-4126-afdd-663e69fc9312"; // owner
const SEED_TARGET = 50;

const uuid = () => crypto.randomUUID();

function loadEnv() {
  const txt = fs.readFileSync("/Users/edison/Desktop/bupos/code/.env.local", "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^"|"$/g, "");
  }
}

async function withOrgTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [ORG]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function snapshotInventory(pool) {
  const c = await pool.connect();
  try {
    const { rows } = await c.query(
      `SELECT l.name AS loc, pv.sku, il.on_hand
       FROM inventory_levels il
       JOIN locations l ON l.id = il.location_id
       JOIN product_variants pv ON pv.id = il.product_variant_id
       WHERE l.organization_id = $1
       ORDER BY l.name, pv.sku`,
      [ORG],
    );
    return rows;
  } finally {
    c.release();
  }
}

function printSnapshot(title, rows) {
  console.log(`\n── ${title} ──`);
  // Display label "(Bellflower)" even though the DB row has empty name
  const lookup = (locId) => Object.entries(LOCATIONS).find(([, v]) => v === locId)?.[0] ?? "?";
  const table = rows.map((r) => ({ location: r.loc || `(Bellflower)`, sku: r.sku, on_hand: Number(r.on_hand) }));
  // Tack on zero-rows for locations that haven't been touched yet so the
  // table reads evenly across all 3 stores.
  const seen = new Set(table.map((r) => r.location + "|" + r.sku));
  for (const locName of Object.keys(LOCATIONS)) {
    const display = locName === "Bellflower" ? "(Bellflower)" : locName;
    for (const sku of Object.keys(VARIANTS)) {
      if (!seen.has(display + "|" + sku) && !seen.has(locName + "|" + sku)) {
        table.push({ location: display, sku, on_hand: 0 });
      }
    }
  }
  table.sort((a, b) => a.location.localeCompare(b.location) || a.sku.localeCompare(b.sku));
  console.table(table);
  void lookup;
}

async function seedBellflower(pool) {
  await withOrgTx(pool, async (c) => {
    for (const [, variantId] of Object.entries(VARIANTS)) {
      await c.query(
        `INSERT INTO inventory_levels (id, organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, 0, now())
         ON CONFLICT (product_variant_id, location_id)
         DO UPDATE SET on_hand = GREATEST(inventory_levels.on_hand, $5), updated_at = now()`,
        [uuid(), ORG, variantId, LOCATIONS.Bellflower, SEED_TARGET],
      );
    }
  });
}

async function runTransfer(pool, { sourceLoc, destLoc, lines, notes, outcome }) {
  const id = uuid();
  await withOrgTx(pool, async (c) => {
    // 1. create → 'requested'
    await c.query(
      `INSERT INTO transfers (id, organization_id, source_location_id, destination_location_id, status, requested_by, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'requested', $5, $6, now(), now())`,
      [id, ORG, LOCATIONS[sourceLoc], LOCATIONS[destLoc], EMPLOYEE_EDISON, notes ?? null],
    );
    for (const { sku, qty } of lines) {
      await c.query(
        `INSERT INTO transfer_lines (id, transfer_id, product_variant_id, quantity_requested, created_at)
         VALUES ($1, $2, $3, $4, now())`,
        [uuid(), id, VARIANTS[sku], qty],
      );
    }
  });

  if (outcome === "cancel") {
    await withOrgTx(pool, async (c) => {
      await c.query(
        `UPDATE transfers SET status = 'cancelled', cancelled_by = $1, cancelled_at = now(), updated_at = now() WHERE id = $2`,
        [EMPLOYEE_EDISON, id],
      );
    });
    return { id, status: "cancelled" };
  }

  // 2. ship → 'in_transit' (decrement source)
  await withOrgTx(pool, async (c) => {
    await c.query(
      `UPDATE transfers SET status = 'in_transit', shipped_by = $1, shipped_at = now(), updated_at = now() WHERE id = $2`,
      [EMPLOYEE_EDISON, id],
    );
    await c.query(
      `UPDATE transfer_lines SET quantity_shipped = quantity_requested WHERE transfer_id = $1`,
      [id],
    );
    // Stock check + decrement — mirrors route.ts logic
    for (const { sku, qty } of lines) {
      const { rows } = await c.query(
        `SELECT on_hand FROM inventory_levels
         WHERE product_variant_id = $1 AND location_id = $2
         FOR UPDATE`,
        [VARIANTS[sku], LOCATIONS[sourceLoc]],
      );
      if (!rows[0] || Number(rows[0].on_hand) < qty) {
        throw new Error(`Insufficient stock at ${sourceLoc} for ${sku} (have ${rows[0]?.on_hand ?? 0}, need ${qty})`);
      }
      await c.query(
        `UPDATE inventory_levels SET on_hand = on_hand - $1, updated_at = now()
         WHERE product_variant_id = $2 AND location_id = $3`,
        [qty, VARIANTS[sku], LOCATIONS[sourceLoc]],
      );
    }
  });

  if (outcome === "in_transit") return { id, status: "in_transit" };

  // 3. receive → 'received' (increment destination)
  await withOrgTx(pool, async (c) => {
    await c.query(
      `UPDATE transfers SET status = 'received', received_by = $1, received_at = now(), updated_at = now() WHERE id = $2`,
      [EMPLOYEE_EDISON, id],
    );
    await c.query(
      `UPDATE transfer_lines SET quantity_received = COALESCE(quantity_shipped, quantity_requested) WHERE transfer_id = $1`,
      [id],
    );
    for (const { sku, qty } of lines) {
      await c.query(
        `INSERT INTO inventory_levels (id, organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, 0, now(), now())
         ON CONFLICT (product_variant_id, location_id)
         DO UPDATE SET on_hand = inventory_levels.on_hand + $5, updated_at = now()`,
        [uuid(), ORG, VARIANTS[sku], LOCATIONS[destLoc], qty],
      );
    }
  });
  return { id, status: "received" };
}

async function main() {
  loadEnv();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

  console.log("→ Inter-store transfer simulation for Casualwear (3 locations)\n");

  // Snapshot + seed
  printSnapshot("Inventory BEFORE seed", await snapshotInventory(pool));
  await seedBellflower(pool);
  const before = await snapshotInventory(pool);
  printSnapshot("Inventory AFTER seed (Bellflower topped up to 50)", before);

  // Plan the transfers
  const plan = [
    { sourceLoc: "Bellflower", destLoc: "El Monte", lines: [{ sku: "DEN-HR-28-BLU", qty: 15 }, { sku: "TOP-OS-L-WHT", qty: 10 }], notes: "Initial stock for El Monte", outcome: "received" },
    { sourceLoc: "Bellflower", destLoc: "Torrance",  lines: [{ sku: "DEN-HR-30-BLU", qty: 12 }, { sku: "TOP-OS-M-BLK", qty: 8  }], notes: "Initial stock for Torrance",  outcome: "received" },
    { sourceLoc: "Bellflower", destLoc: "El Monte", lines: [{ sku: "TOP-OS-M-BLK", qty: 6  }],                                    notes: "Top up El Monte black tees",  outcome: "received" },
    { sourceLoc: "El Monte",  destLoc: "Torrance",  lines: [{ sku: "DEN-HR-28-BLU", qty: 3  }],                                    notes: "Torrance ran out of 28s",     outcome: "received" },
    { sourceLoc: "Bellflower", destLoc: "Torrance",  lines: [{ sku: "TOP-OS-L-WHT", qty: 4  }],                                    notes: "Replenish Torrance white tees", outcome: "in_transit" }, // ← mid-flight, not yet received
    { sourceLoc: "Bellflower", destLoc: "El Monte", lines: [{ sku: "DEN-HR-30-BLU", qty: 5  }],                                    notes: "Cancelled — wrong SKU requested", outcome: "cancel" },
  ];

  const results = [];
  for (const t of plan) {
    try {
      const r = await runTransfer(pool, t);
      results.push({ ...t, ...r });
      console.log(`  ✓ ${t.sourceLoc.padEnd(11)}→ ${t.destLoc.padEnd(9)} ${r.status.padEnd(11)} ${t.lines.map((l) => l.sku + "×" + l.qty).join(", ")}`);
    } catch (e) {
      console.log(`  ✗ ${t.sourceLoc.padEnd(11)}→ ${t.destLoc.padEnd(9)} FAILED      ${e.message}`);
      results.push({ ...t, error: e.message });
    }
  }

  const after = await snapshotInventory(pool);
  printSnapshot("Inventory AFTER transfers", after);

  // Reconciliation: compute expected deltas from the plan, compare to DB
  console.log("\n── Reconciliation ──");
  const expected = new Map(); // key: loc|sku → delta
  for (const t of results) {
    if (t.error || t.status === "cancelled") continue;
    for (const l of t.lines) {
      // Source loses qty (on ship), destination gains qty (on receive).
      // A transfer stuck in_transit loses source but destination doesn't
      // gain yet — the reconciliation should show that correctly.
      const srcKey = `${t.sourceLoc}|${l.sku}`;
      expected.set(srcKey, (expected.get(srcKey) ?? 0) - l.qty);
      if (t.status === "received") {
        const dstKey = `${t.destLoc}|${l.sku}`;
        expected.set(dstKey, (expected.get(dstKey) ?? 0) + l.qty);
      }
    }
  }
  // Also account for the Bellflower seed: before each variant might have been < 50, bumped to 50
  const snapBefore = new Map(before.map((r) => [`${r.loc || "Bellflower"}|${r.sku}`, Number(r.on_hand)]));
  const snapAfter = new Map(after.map((r) => [`${r.loc || "Bellflower"}|${r.sku}`, Number(r.on_hand)]));
  const rows = [];
  for (const locName of Object.keys(LOCATIONS)) {
    for (const sku of Object.keys(VARIANTS)) {
      const locKey = locName === "Bellflower" ? "Bellflower" : locName;
      const beforeQ = snapBefore.get(`${locKey}|${sku}`) ?? 0;
      const afterQ  = snapAfter.get(`${locKey}|${sku}`) ?? 0;
      const actualDelta = afterQ - beforeQ;
      const expectedDelta = expected.get(`${locName}|${sku}`) ?? 0;
      const ok = actualDelta === expectedDelta;
      rows.push({ location: locName, sku, before: beforeQ, after: afterQ, delta: actualDelta, expected: expectedDelta, ok: ok ? "✓" : "✗" });
    }
  }
  console.table(rows);
  const bad = rows.filter((r) => r.ok === "✗");
  if (bad.length > 0) {
    console.log(`\n⚠ ${bad.length} inventory mismatches:`);
    console.table(bad);
  } else {
    console.log("\n✓ All per-location inventory deltas match the transfer plan");
  }

  // Transfer rows summary
  console.log("\n── Transfers created this run ──");
  const c = await pool.connect();
  try {
    const { rows: tRows } = await c.query(
      `SELECT t.status, COUNT(*)::int AS n FROM transfers t
       WHERE t.organization_id = $1 AND t.created_at >= NOW() - INTERVAL '1 hour'
       GROUP BY t.status`,
      [ORG],
    );
    console.table(tRows);
  } finally {
    c.release();
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
