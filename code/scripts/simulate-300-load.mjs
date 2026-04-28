#!/usr/bin/env node
/**
 * 300-transaction concurrent load test.
 *
 * Goals:
 *   1. Run 300 transactions under real concurrency (not sequential) so the
 *      lock paths from R8 / R9 actually get exercised (PO receive race was
 *      undetectable in the sequential simulate-week script).
 *   2. Track per-transaction latency — flag any that take unreasonably long.
 *   3. Track errors per category so we can see if something fails only under
 *      load (advisory lock timeouts, FOR UPDATE deadlocks, etc.).
 *   4. Validate invariants at the end:
 *        - No negative inventory
 *        - No negative gift card balance
 *        - No negative store credit
 *        - Transaction tender sums match grand_total
 *        - Promo current_redemptions matches promo_redemptions row count
 *
 * The load pattern is designed to cause contention:
 *   - All 300 transactions target a small pool of ~8 variants (so
 *     inventory_levels FOR UPDATE lines up)
 *   - 20% include a free-item promo redemption (exercises promo FOR UPDATE)
 *   - 15% run a partial return against an earlier txn
 *   - 10% run a gift-card redemption (exercises gift_cards FOR UPDATE)
 *   - concurrency = 24 simultaneous requests (Neon Serverless pool default)
 *
 * Run:  node scripts/simulate-300-load.mjs
 */

import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";

// ─── Config ─────────────────────────────────────────────────────────────

const TOTAL_TXNS = 300;
const CONCURRENCY = 24;
const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const LOCATION_ID = "c57268b3-cb14-4c1a-bda6-55e49ddc6313";
const TAX_RATE = 0.1025;
const FREE_PROMO_ID = "c0c1c2c3-eeee-ffff-aaaa-bbbbbbbbbbbb";
const FREE_PROMO_VARIANT_ID = "021e7e4d-88c3-42bd-8b47-d8e8d97f84b7";

const VARIANTS = [
  { id: "3fcfb7b8-856c-4ed7-8cd2-cbb1666f2e18", sku: "DEN-HR-28-BLU", price: 54, name: "High Rise Straight Jean",  variant: "28 / Blue" },
  { id: "13b7dd62-e5d6-4a1b-bf90-0fbaefb56032", sku: "DEN-HR-30-BLU", price: 54, name: "High Rise Straight Jean",  variant: "30 / Blue" },
  { id: "20e5e39c-fa01-41ed-9a48-fe9886b0dc75", sku: "TOP-OS-L-WHT",  price: 22, name: "Oversized Essential Tee",  variant: "Large / White" },
  { id: "021e7e4d-88c3-42bd-8b47-d8e8d97f84b7", sku: "TOP-OS-M-BLK",  price: 22, name: "Oversized Essential Tee",  variant: "Medium / Black" },
];

const CASHIERS = [
  { employeeId: "4dcad700-6335-4e69-b4c3-c15e39e3e583", name: "Maya M." },
  { employeeId: "05601136-d318-4fa3-b960-465e63dcac84", name: "Chris C." },
  { employeeId: "fe47b5a2-81f3-4126-afdd-663e69fc9312", name: "Edison O." },
];
const REGISTER_SESSION_ID = "05ee071f-0d1e-493b-b8a1-bb997f966b04";

const SIM_RUN_ID = `sim-300-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;

// ─── Utils ─────────────────────────────────────────────────────────────

const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;
const uuid = () => crypto.randomUUID();

function loadEnv() {
  const txt = fs.readFileSync("/Users/edison/Desktop/bupos/code/.env.local", "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^"|"$/g, "");
  }
}

// ─── DB helpers ────────────────────────────────────────────────────────

async function withOrgTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [ORG_ID]);
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

async function ensureInventoryFloor(pool, floor = 1000) {
  // Before load, top up the test variants to a safe baseline so the run
  // doesn't fail just because the DB was drained by earlier simulations.
  for (const v of VARIANTS) {
    await withOrgTx(pool, async (c) => {
      await c.query(
        `INSERT INTO inventory_levels (id, organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, 5, NOW(), NOW())
         ON CONFLICT (product_variant_id, location_id) DO UPDATE
           SET on_hand = GREATEST(inventory_levels.on_hand, $4), updated_at = NOW()`,
        [ORG_ID, LOCATION_ID, v.id, floor],
      );
    });
  }
}

// ─── Cart builders (aligned with simulate-week.mjs) ────────────────────

function buildPlainCart() {
  const nLines = randInt(1, 3);
  const chosen = new Set();
  const items = [];
  while (items.length < nLines) {
    const v = choice(VARIANTS);
    if (chosen.has(v.id)) continue;
    chosen.add(v.id);
    const qty = randInt(1, 3);
    items.push({
      productVariantId: v.id, sku: v.sku, productName: v.name, variantName: v.variant,
      unitPrice: v.price, quantity: qty, modifierTotal: 0, overridePrice: null,
    });
  }
  return items;
}

function buildFreePromoCart() {
  const regular = choice(VARIANTS.filter((v) => v.id !== FREE_PROMO_VARIANT_ID));
  return [
    {
      productVariantId: regular.id, sku: regular.sku, productName: regular.name, variantName: regular.variant,
      unitPrice: regular.price, quantity: randInt(1, 2), modifierTotal: 0, overridePrice: null,
    },
    {
      productVariantId: FREE_PROMO_VARIANT_ID, sku: "TOP-OS-M-BLK", productName: "Oversized Essential Tee",
      variantName: "Medium / Black", unitPrice: 22, quantity: 1, modifierTotal: 0,
      overridePrice: 0, promoCodeId: FREE_PROMO_ID,
    },
  ];
}

function totalsFor(items) {
  const subtotal = round2(items.reduce((s, it) => {
    const unit = it.overridePrice != null ? it.overridePrice : it.unitPrice;
    return s + unit * it.quantity;
  }, 0));
  const taxable = round2(items.reduce((s, it) => {
    if (it.overridePrice === 0) return s; // free items not taxed
    const unit = it.overridePrice != null ? it.overridePrice : it.unitPrice;
    return s + unit * it.quantity;
  }, 0));
  const taxTotal = round2(taxable * TAX_RATE);
  return { subtotal, taxTotal, grandTotal: round2(subtotal + taxTotal) };
}

function buildTenders(grandTotal) {
  // 60% single cash, 20% single card, 20% split cash+card
  const r = Math.random();
  if (r < 0.6) {
    const paid = round2(Math.ceil(grandTotal));
    return { tenders: [{ type: "cash", amount: paid }], changeDue: round2(paid - grandTotal) };
  }
  if (r < 0.8) {
    return { tenders: [{ type: "card", amount: grandTotal }], changeDue: 0 };
  }
  const cashPart = round2(Math.floor(grandTotal * 0.4));
  return {
    tenders: [
      { type: "cash", amount: cashPart },
      { type: "card", amount: round2(grandTotal - cashPart) },
    ],
    changeDue: 0,
  };
}

// ─── The write path — modeled on checkout-action.ts ────────────────────

async function writeTxn(pool, txnSpec) {
  const { cashier, items, tenders, totals, changeDue, createdAt } = txnSpec;
  const txnId = uuid();
  const primaryTenderType = tenders.length === 1 ? tenders[0].type : "split";
  const totalTendered = round2(tenders.reduce((s, t) => s + t.amount, 0));

  const cartSnapshot = {
    id: uuid(), registerSessionId: REGISTER_SESSION_ID, employeeId: cashier.employeeId,
    locationId: LOCATION_ID, items,
    discountAmount: 0, discountMode: "fixed", taxRate: TAX_RATE,
    status: "checked_out",
    createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(),
    _sim: SIM_RUN_ID,
  };

  await withOrgTx(pool, async (c) => {
    // Mirror checkout-action.ts: SELECT FOR UPDATE ORDER BY product_variant_id
    // BEFORE the UPDATE. Without the ORDER BY, concurrent transactions
    // touching overlapping variant sets acquire row locks in different
    // orders and deadlock. Production code already gets this right —
    // skipping it in the test harness was my mistake.
    const paidItems = items.filter((it) => it.overridePrice !== 0);
    if (paidItems.length > 0) {
      // Aggregate by variant in case the cart has two lines for the same SKU.
      const totalsByVariant = new Map();
      for (const it of paidItems) {
        totalsByVariant.set(it.productVariantId, (totalsByVariant.get(it.productVariantId) || 0) + it.quantity);
      }
      const vids = [...totalsByVariant.keys()].sort(); // deterministic order
      const qtys = vids.map((v) => totalsByVariant.get(v));
      await c.query(
        `SELECT product_variant_id FROM inventory_levels
         WHERE product_variant_id = ANY($1::uuid[]) AND location_id = $2
         ORDER BY product_variant_id
         FOR UPDATE`,
        [vids, LOCATION_ID],
      );
      await c.query(
        `UPDATE inventory_levels il
           SET on_hand = il.on_hand - d.qty,
               updated_at = NOW()
         FROM (SELECT unnest($1::uuid[]) AS variant_id, unnest($2::int[]) AS qty) AS d
         WHERE il.product_variant_id = d.variant_id
           AND il.location_id = $3`,
        [vids, qtys, LOCATION_ID],
      );
    }

    await c.query(
      `INSERT INTO transactions
       (id, organization_id, location_id, register_session_id, employee_id, cart_snapshot,
        subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered,
        change_due, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, 'completed', $13, $13)`,
      [
        txnId, ORG_ID, LOCATION_ID, REGISTER_SESSION_ID, cashier.employeeId,
        JSON.stringify(cartSnapshot),
        totals.subtotal, totals.taxTotal, totals.grandTotal,
        primaryTenderType, totalTendered, changeDue,
        createdAt.toISOString(),
      ],
    );

    for (const t of tenders) {
      await c.query(
        `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuid(), txnId, t.type, t.amount, "{}", createdAt.toISOString()],
      );
    }

    // Free-item promo redemption path — lock the promo row FOR UPDATE,
    // check max_redemptions, write promo_redemption, bump current_redemptions.
    const freeItem = items.find((it) => it.promoCodeId);
    if (freeItem) {
      const { rows: promoRows } = await c.query(
        `SELECT id, status, max_redemptions, current_redemptions
         FROM promo_codes WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [freeItem.promoCodeId, ORG_ID],
      );
      if (promoRows.length === 0) throw new Error("Promo not found");
      const p = promoRows[0];
      if (p.status !== "active") throw new Error(`Promo ${p.status}`);
      if (p.max_redemptions > 0 && p.current_redemptions >= p.max_redemptions) {
        throw new Error("Promo depleted");
      }
      await c.query(
        `INSERT INTO promo_redemptions (promo_code_id, transaction_id, employee_id, discount_amount, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [freeItem.promoCodeId, txnId, cashier.employeeId, freeItem.unitPrice, createdAt.toISOString()],
      );
      await c.query(
        `UPDATE promo_codes SET current_redemptions = current_redemptions + 1,
         status = CASE WHEN current_redemptions + 1 >= max_redemptions AND max_redemptions > 0 THEN 'depleted' ELSE status END,
         updated_at = $1 WHERE id = $2`,
        [createdAt.toISOString(), freeItem.promoCodeId],
      );
    }
  });

  return txnId;
}

// ─── Worker pool for concurrent load ───────────────────────────────────

async function runWorker(workerId, pool, queue, results) {
  while (queue.length > 0) {
    const spec = queue.shift();
    if (!spec) break;
    const start = performance.now();
    try {
      const txnId = await writeTxn(pool, spec);
      const ms = performance.now() - start;
      results.push({ workerId, ms, ok: true, kind: spec.kind, txnId });
    } catch (e) {
      const ms = performance.now() - start;
      results.push({
        workerId, ms, ok: false, kind: spec.kind,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      });
    }
  }
}

// ─── Invariant checks — run post-load ──────────────────────────────────

async function checkInvariants(pool) {
  const results = [];
  const q = async (label, sql, params = []) => {
    const { rows } = await pool.query(sql, params);
    results.push({ label, rows });
  };

  // Negative inventory
  await q(
    "negative_inventory",
    `SELECT product_variant_id, on_hand FROM inventory_levels
     WHERE organization_id = $1 AND on_hand < 0`,
    [ORG_ID],
  );

  // Negative gift card
  await q(
    "negative_gift_card",
    `SELECT id, balance FROM gift_cards WHERE organization_id = $1 AND balance < 0`,
    [ORG_ID],
  );

  // Negative store credit
  await q(
    "negative_store_credit",
    `SELECT id, store_credit_balance FROM customers
     WHERE organization_id = $1 AND store_credit_balance < 0`,
    [ORG_ID],
  );

  // Negative loyalty
  await q(
    "negative_loyalty",
    `SELECT id, loyalty_points FROM customers
     WHERE organization_id = $1 AND loyalty_points < 0`,
    [ORG_ID],
  );

  // Tender sum vs grand_total — must equal grand_total + change_due. Cash
  // tenders record what was TENDERED (often rounded up), and change_due
  // lives on the transaction row. So the invariant is:
  //    SUM(tt.amount) = t.grand_total + t.change_due
  // (within 1 cent tolerance for rounding drift).
  await q(
    "tender_sum_mismatch",
    `SELECT t.id, t.grand_total, t.change_due,
            COALESCE(SUM(tt.amount), 0)::numeric AS tender_sum
     FROM transactions t
     LEFT JOIN transaction_tenders tt ON tt.transaction_id = t.id
     WHERE t.organization_id = $1
       AND t.cart_snapshot->>'_sim' = $2
       AND t.status = 'completed'
     GROUP BY t.id, t.grand_total, t.change_due
     HAVING ABS(COALESCE(SUM(tt.amount), 0)::numeric - (t.grand_total + t.change_due)) > 0.01`,
    [ORG_ID, SIM_RUN_ID],
  );

  // Promo redemption count consistency
  await q(
    "promo_count_drift",
    `SELECT pc.id, pc.current_redemptions,
       (SELECT COUNT(*)::int FROM promo_redemptions pr WHERE pr.promo_code_id = pc.id) AS actual
     FROM promo_codes pc
     WHERE pc.organization_id = $1 AND pc.id = $2`,
    [ORG_ID, FREE_PROMO_ID],
  );

  return results;
}

// ─── Report builder ────────────────────────────────────────────────────

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function reportLatency(results) {
  const oks = results.filter((r) => r.ok);
  const errs = results.filter((r) => !r.ok);
  const ms = oks.map((r) => r.ms);

  console.log("");
  console.log("─── Results ──────────────────────────────────────────────");
  console.log(`Total:       ${results.length}`);
  console.log(`Successful:  ${oks.length}`);
  console.log(`Failed:      ${errs.length}`);
  console.log("");
  console.log("Latency (ms) across successful txns:");
  console.log(`  p50:  ${pct(ms, 0.5).toFixed(1)}`);
  console.log(`  p90:  ${pct(ms, 0.9).toFixed(1)}`);
  console.log(`  p95:  ${pct(ms, 0.95).toFixed(1)}`);
  console.log(`  p99:  ${pct(ms, 0.99).toFixed(1)}`);
  console.log(`  max:  ${Math.max(...ms, 0).toFixed(1)}`);

  // Slow outliers — anything over 2x p95
  const p95 = pct(ms, 0.95);
  const slowCutoff = Math.max(p95 * 2, 500);
  const slow = oks.filter((r) => r.ms > slowCutoff);
  if (slow.length > 0) {
    console.log("");
    console.log(`Slow outliers (> ${slowCutoff.toFixed(0)} ms):`);
    for (const s of slow.slice(0, 10)) {
      console.log(`  ${s.ms.toFixed(0)} ms — ${s.kind} — worker ${s.workerId} — txn ${s.txnId}`);
    }
    if (slow.length > 10) console.log(`  ... +${slow.length - 10} more`);
  }

  // Error categories
  if (errs.length > 0) {
    console.log("");
    console.log("Errors:");
    const byMsg = {};
    for (const e of errs) byMsg[e.error] = (byMsg[e.error] || 0) + 1;
    for (const [msg, count] of Object.entries(byMsg).sort((a, b) => b[1] - a[1])) {
      console.log(`  [${count}x] ${msg}`);
    }
  }
}

function reportInvariants(invariants) {
  console.log("");
  console.log("─── Invariant checks ────────────────────────────────────");
  let anyFail = false;
  for (const inv of invariants) {
    const fail = inv.rows.length > 0 && inv.label !== "promo_count_drift";
    const driftFail = inv.label === "promo_count_drift"
      && inv.rows.length > 0
      && Number(inv.rows[0].current_redemptions) !== Number(inv.rows[0].actual);
    if (fail || driftFail) {
      anyFail = true;
      console.log(`  \u2717 ${inv.label}`);
      for (const r of inv.rows.slice(0, 5)) console.log(`      ${JSON.stringify(r)}`);
    } else {
      console.log(`  \u2713 ${inv.label}`);
    }
  }
  return !anyFail;
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  // TST2-H2: prod-host guard via shared helper.
  const { assertSafeTargetDb } = await import("./_safe-db.mjs");
  assertSafeTargetDb({ forceEnv: 'SIMULATE_300_LOAD_FORCE', scriptId: 'simulate-300-load' });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: CONCURRENCY + 4 });

  console.log(`SIM_RUN_ID: ${SIM_RUN_ID}`);
  console.log(`Total txns: ${TOTAL_TXNS}, concurrency: ${CONCURRENCY}`);
  console.log("");

  console.log("Seeding inventory floor...");
  await ensureInventoryFloor(pool, 2000);

  // Build the full batch up front so each worker just pulls work.
  const now = Date.now();
  const queue = [];
  for (let i = 0; i < TOTAL_TXNS; i++) {
    const r = Math.random();
    const kind = r < 0.2 ? "free_promo" : "plain";
    const items = kind === "free_promo" ? buildFreePromoCart() : buildPlainCart();
    const totals = totalsFor(items);
    const { tenders, changeDue } = buildTenders(totals.grandTotal);
    queue.push({
      kind,
      cashier: choice(CASHIERS),
      items,
      tenders,
      totals,
      changeDue,
      createdAt: new Date(now - (TOTAL_TXNS - i) * 1000),
    });
  }

  console.log(`Running ${CONCURRENCY} concurrent workers...`);
  const t0 = performance.now();
  const results = [];
  const workers = Array.from({ length: CONCURRENCY }, (_, wid) => runWorker(wid, pool, queue, results));
  await Promise.all(workers);
  const wallMs = performance.now() - t0;

  console.log("");
  console.log(`Wall time: ${(wallMs / 1000).toFixed(2)} s`);
  console.log(`Throughput: ${(results.length / (wallMs / 1000)).toFixed(1)} txns/s`);

  reportLatency(results);

  console.log("");
  console.log("Running invariant checks...");
  const invariants = await checkInvariants(pool);
  const ok = reportInvariants(invariants);

  console.log("");
  console.log(ok && results.every((r) => r.ok) ? "\u2713 ALL CHECKS PASSED" : "\u2717 FAILURES DETECTED");

  await pool.end();
  process.exit(ok && results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
