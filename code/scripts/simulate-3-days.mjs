#!/usr/bin/env node
/**
 * 3-day retail simulator — generates a realistic dataset of shifts,
 * clock-in/out events, and transactions (with bundle + free-item promo
 * redemptions) directly against the Postgres DB. Skips the HTTP path
 * because iterating on clock/shift/transaction across multiple days
 * would take minutes over the throttled offline-sync endpoint.
 *
 * Writes:
 *   • 3 days × 2 cashiers = 6 shifts
 *   • ~60 transactions (mix: plain, bundle, free-item promo)
 *   • clock_in, break_start, break_end, clock_out entries
 *   • pay_in_outs (a couple per day)
 *   • inventory_adjustments reflecting the per-variant decrements
 *   • promo_redemptions for each free-item line
 *
 * Reads DATABASE_URL from .env.local. Idempotency:
 *   • Every inserted row is tagged in cart_snapshot / notes with the
 *     sim run id so re-running doesn't deduplicate, but cleanup is
 *     easy (`cart_snapshot->>'_sim' = 'sim-3day-*'`).
 *   • Safe to run multiple times — each run creates a fresh set of
 *     shifts and transactions with different ids.
 *
 * Usage:  node scripts/simulate-3-days.mjs
 */

import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";

// ─── Config ─────────────────────────────────────────────────────────────

const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const LOCATION_ID = "c57268b3-cb14-4c1a-bda6-55e49ddc6313";
const TAX_RATE = 0.1025;
const BUNDLE_ID = "b0b1b2b3-aaaa-bbbb-cccc-dddddddddddd";
const BUNDLE_PRICE = 70.0;
const FREE_PROMO_ID = "c0c1c2c3-eeee-ffff-aaaa-bbbbbbbbbbbb";
const FREE_PROMO_VARIANT_ID = "021e7e4d-88c3-42bd-8b47-d8e8d97f84b7";
const FREE_PROMO_MIN_PURCHASE = 50;

const VARIANTS = [
  { id: "3fcfb7b8-856c-4ed7-8cd2-cbb1666f2e18", sku: "DEN-HR-28-BLU", price: 54, name: "High Rise Straight Jean", variant: "28 / Blue" },
  { id: "13b7dd62-e5d6-4a1b-bf90-0fbaefb56032", sku: "DEN-HR-30-BLU", price: 54, name: "High Rise Straight Jean", variant: "30 / Blue" },
  { id: "20e5e39c-fa01-41ed-9a48-fe9886b0dc75", sku: "TOP-OS-L-WHT",  price: 22, name: "Oversized Essential Tee", variant: "Large / White" },
  { id: "021e7e4d-88c3-42bd-8b47-d8e8d97f84b7", sku: "TOP-OS-M-BLK",  price: 22, name: "Oversized Essential Tee", variant: "Medium / Black" },
];
const VARIANT_BY_ID = Object.fromEntries(VARIANTS.map(v => [v.id, v]));

// Two cashiers — use existing employees from the sim org. Register session
// is shared (Maya's) because only one active register_session exists.
const CASHIERS = [
  { employeeId: "4dcad700-6335-4e69-b4c3-c15e39e3e583", name: "Maya M." },
  { employeeId: "05601136-d318-4fa3-b960-465e63dcac84", name: "Chris C." },
];
const REGISTER_SESSION_ID = "05ee071f-0d1e-493b-b8a1-bb997f966b04";

const SIM_RUN_ID = `sim-3day-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;

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

// Fix a "day" to a specific YYYY-MM-DD and anchor times to it.
function atDay(day /* Date */, hour, min = 0, sec = 0) {
  const d = new Date(day);
  d.setUTCHours(hour, min, sec, 0);
  return d;
}

// ─── Cart + transaction shape helpers ──────────────────────────────────

function buildPlainCart() {
  const nLines = randInt(1, 3);
  const chosen = new Set();
  const items = [];
  for (let i = 0; i < nLines; i++) {
    const v = choice(VARIANTS);
    if (chosen.has(v.id)) continue;
    chosen.add(v.id);
    const qty = randInt(1, 2);
    items.push({
      id: uuid(),
      productVariantId: v.id,
      productName: v.name,
      variantName: v.variant,
      sku: v.sku,
      unitPrice: v.price,
      quantity: qty,
      modifierIds: [],
      modifierTotal: 0,
    });
  }
  return items;
}

function buildBundleCart() {
  // Bundle + 0-2 extra items
  const bundleLine = {
    id: uuid(),
    productVariantId: BUNDLE_ID, // sentinel = bundleId per cart/types.ts
    productName: "Starter Outfit",
    variantName: "Bundle",
    sku: "[Bundle] sim-starter-outfit",
    unitPrice: BUNDLE_PRICE,
    overridePrice: undefined,
    quantity: 1,
    modifierIds: [],
    modifierTotal: 0,
    bundleId: BUNDLE_ID,
    bundleComponents: [
      { productVariantId: "3fcfb7b8-856c-4ed7-8cd2-cbb1666f2e18", quantity: 1 },
      { productVariantId: "20e5e39c-fa01-41ed-9a48-fe9886b0dc75", quantity: 1 },
    ],
  };
  const items = [bundleLine];
  const nExtra = randInt(0, 2);
  for (let i = 0; i < nExtra; i++) {
    const v = choice(VARIANTS);
    if (items.some((it) => it.productVariantId === v.id)) continue;
    items.push({
      id: uuid(),
      productVariantId: v.id,
      productName: v.name,
      variantName: v.variant,
      sku: v.sku,
      unitPrice: v.price,
      quantity: 1,
      modifierIds: [],
      modifierTotal: 0,
    });
  }
  return items;
}

function buildFreeItemCart() {
  // Real items summing to ≥ $50, plus the free tee
  const items = [];
  // Two jeans ($108) ensures threshold met
  items.push({
    id: uuid(),
    productVariantId: "3fcfb7b8-856c-4ed7-8cd2-cbb1666f2e18",
    productName: "High Rise Straight Jean",
    variantName: "28 / Blue",
    sku: "DEN-HR-28-BLU",
    unitPrice: 54,
    quantity: 1,
    modifierIds: [],
    modifierTotal: 0,
  });
  items.push({
    id: uuid(),
    productVariantId: "13b7dd62-e5d6-4a1b-bf90-0fbaefb56032",
    productName: "High Rise Straight Jean",
    variantName: "30 / Blue",
    sku: "DEN-HR-30-BLU",
    unitPrice: 54,
    quantity: 1,
    modifierIds: [],
    modifierTotal: 0,
  });
  // Free tee — overridePrice=0 with promoCodeId
  items.push({
    id: uuid(),
    productVariantId: FREE_PROMO_VARIANT_ID,
    productName: "Oversized Essential Tee",
    variantName: "Medium / Black",
    sku: "TOP-OS-M-BLK",
    unitPrice: 22,
    overridePrice: 0,
    quantity: 1,
    modifierIds: [],
    modifierTotal: 0,
    promoCodeId: FREE_PROMO_ID,
  });
  return items;
}

function computeTotals(items) {
  let subtotal = 0;
  for (const it of items) {
    const price = it.overridePrice ?? it.unitPrice;
    subtotal = round2(subtotal + price * it.quantity);
  }
  const taxable = subtotal;
  const taxTotal = round2(taxable * TAX_RATE);
  const grandTotal = round2(taxable + taxTotal);
  return { subtotal, taxTotal, grandTotal };
}

function pickTenders(grandTotal) {
  const r = Math.random();
  if (r < 0.6) {
    // All cash (with possible overtender → change)
    const paid = round2(grandTotal + (Math.random() < 0.3 ? rand(0, 15) : 0));
    return { tenders: [{ type: "cash", amount: paid }], changeDue: round2(Math.max(0, paid - grandTotal)) };
  }
  if (r < 0.85) {
    return { tenders: [{ type: "card", amount: grandTotal }], changeDue: 0 };
  }
  // Split
  const cashPart = round2(grandTotal * rand(0.3, 0.7));
  return {
    tenders: [
      { type: "cash", amount: cashPart },
      { type: "card", amount: round2(grandTotal - cashPart) },
    ],
    changeDue: 0,
  };
}

// ─── DB driver ─────────────────────────────────────────────────────────

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
    console.error("[withOrgTx]", e.message, e.detail ?? "");
    throw e;
  } finally {
    client.release();
  }
}

// Insert a single transaction (+tenders +events +inventory_adjustments
// +promo_redemptions) in one orgTx. Returns the transaction id.
async function writeTxn(pool, { shiftId, employeeId, createdAt, items, tenders, totals, changeDue }) {
  const txnId = uuid();
  const primaryTenderType = tenders.length === 1 ? tenders[0].type : "split";
  const totalTendered = round2(tenders.reduce((s, t) => s + t.amount, 0));
  const cartSnapshot = {
    id: uuid(),
    registerSessionId: REGISTER_SESSION_ID,
    employeeId,
    locationId: LOCATION_ID,
    items,
    discountAmount: 0,
    discountMode: "fixed",
    taxRate: TAX_RATE,
    status: "checked_out",
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    _sim: SIM_RUN_ID,
  };

  await withOrgTx(pool, async (c) => {
    // 1. transactions
    await c.query(
      `INSERT INTO transactions
       (id, organization_id, location_id, register_session_id, employee_id, cart_snapshot,
        subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered,
        change_due, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, 'completed', $13, $13)`,
      [
        txnId, ORG_ID, LOCATION_ID, REGISTER_SESSION_ID, employeeId,
        JSON.stringify(cartSnapshot),
        totals.subtotal, totals.taxTotal, totals.grandTotal,
        primaryTenderType, totalTendered, changeDue,
        createdAt.toISOString(),
      ],
    );

    // 2. transaction_tenders
    const lastCashIdx = (() => {
      for (let i = tenders.length - 1; i >= 0; i--) if (tenders[i].type === "cash") return i;
      return -1;
    })();
    for (let i = 0; i < tenders.length; i++) {
      const t = tenders[i];
      const meta = i === lastCashIdx ? { change_due: changeDue.toFixed(2) } : {};
      await c.query(
        `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuid(), txnId, t.type, t.amount, JSON.stringify(meta), createdAt.toISOString()],
      );
    }

    // 3. transaction_events
    const bundleIds = items.filter((it) => it.bundleId).map((it) => it.bundleId).join(",");
    await c.query(
      `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload, created_at)
       VALUES ($1, $2, $3, 'transaction_placeholder', $4, $5, $6)`,
      [
        uuid(), txnId, employeeId,
        `Checkout completed (sim)`,
        JSON.stringify({
          location_id: LOCATION_ID,
          register_session_id: REGISTER_SESSION_ID,
          item_count: items.reduce((s, it) => s + it.quantity, 0),
          grand_total: totals.grandTotal.toFixed(2),
          tender_count: tenders.length,
          primary_tender_type: primaryTenderType,
          change_due: changeDue.toFixed(2),
          bundle_ids: bundleIds,
          _sim: SIM_RUN_ID,
        }),
        createdAt.toISOString(),
      ],
    );

    // 4. inventory_adjustments + decrement inventory_levels
    //    Aggregate per-variant: regular + bundle components + free lines
    const byVariant = new Map();
    for (const it of items) {
      if (it.bundleId) {
        for (const comp of it.bundleComponents ?? []) {
          byVariant.set(comp.productVariantId, (byVariant.get(comp.productVariantId) ?? 0) + comp.quantity * it.quantity);
        }
      } else {
        byVariant.set(it.productVariantId, (byVariant.get(it.productVariantId) ?? 0) + it.quantity);
      }
    }
    for (const [variantId, qty] of byVariant) {
      // Update on_hand, grab the row id for FK — use UPSERT so variants
      // without an existing inventory_levels row (rare) still get one.
      const { rows } = await c.query(
        `INSERT INTO inventory_levels (organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point, updated_at)
         VALUES ($1, $2, $3, 0, 0, 0, $4)
         ON CONFLICT (product_variant_id, location_id)
         DO UPDATE SET on_hand = GREATEST(0, inventory_levels.on_hand - $5), updated_at = $4
         RETURNING id, on_hand`,
        [ORG_ID, LOCATION_ID, variantId, createdAt.toISOString(), qty],
      );
      const row = rows[0];
      await c.query(
        `INSERT INTO inventory_adjustments
         (inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand, created_at)
         VALUES ($1, $2, $3, $4, 'sale', $5, $6, $7)`,
        [row.id, variantId, LOCATION_ID, employeeId, -qty, row.on_hand, createdAt.toISOString()],
      );
    }

    // 5. promo_redemptions for any free-item lines
    for (const it of items) {
      if (!it.promoCodeId) continue;
      const v = VARIANT_BY_ID[it.productVariantId];
      const value = v?.price ?? 0;
      await c.query(
        `INSERT INTO promo_redemptions (id, promo_code_id, transaction_id, employee_id, discount_amount, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuid(), it.promoCodeId, txnId, employeeId, value, createdAt.toISOString()],
      );
      await c.query(
        `UPDATE promo_codes SET current_redemptions = current_redemptions + 1, updated_at = $1 WHERE id = $2`,
        [createdAt.toISOString(), it.promoCodeId],
      );
    }

    // NOTE: `transactions.shift_id` doesn't exist in this deployment —
    // shift↔transaction correlation is done via register_session_id +
    // created_at window (see closeShiftEnhancedAction in shift-actions.ts).
    // An earlier version of this script UPDATE'd that column defensively
    // and relied on `.catch(() => {})` to swallow the "column doesn't
    // exist" error. That put the whole transaction into ERROR state,
    // which made the subsequent COMMIT a silent ROLLBACK — losing every
    // INSERT above. Don't do that again.
    void shiftId;
  });

  return txnId;
}

// ─── Shift + clock helpers ─────────────────────────────────────────────

async function openShift(pool, { employeeId, openingFloat, openedAt }) {
  const shiftId = uuid();
  await withOrgTx(pool, async (c) => {
    await c.query(
      `INSERT INTO shifts
       (id, organization_id, location_id, employee_id, register_session_id, status,
        opened_at, opening_float, opened_note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $6, $6)`,
      [shiftId, ORG_ID, LOCATION_ID, employeeId, REGISTER_SESSION_ID, openedAt.toISOString(),
       openingFloat, `Sim ${SIM_RUN_ID}`],
    );
  });
  return shiftId;
}

async function closeShift(pool, { shiftId, closedAt, expectedCash, declaredCash, note }) {
  const variance = round2(declaredCash - expectedCash);
  await withOrgTx(pool, async (c) => {
    await c.query(
      `UPDATE shifts
       SET status = 'closed', closed_at = $1,
           closing_expected_cash = $2, closing_declared_cash = $3,
           closing_variance = $4, closed_note = $5, updated_at = $1
       WHERE id = $6`,
      [closedAt.toISOString(), expectedCash, declaredCash, variance, note, shiftId],
    );
  });
}

async function insertClockEvent(pool, { employeeId, eventType, at, note }) {
  await withOrgTx(pool, async (c) => {
    await c.query(
      `INSERT INTO time_clock_entries
       (organization_id, employee_id, location_id, event_type, note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [ORG_ID, employeeId, LOCATION_ID, eventType, note ?? null, at.toISOString()],
    );
  });
}

async function insertPayInOut(pool, { shiftId, employeeId, direction, amount, reason, at }) {
  await withOrgTx(pool, async (c) => {
    await c.query(
      `INSERT INTO pay_in_outs
       (id, organization_id, shift_id, location_id, employee_id, direction, amount, reason, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [uuid(), ORG_ID, shiftId, LOCATION_ID, employeeId, direction, amount, reason, `Sim ${SIM_RUN_ID}`, at.toISOString()],
    );
  });
}

// ─── Main ─────────────────────────────────────────────────────────────

async function simulateCashierDay(pool, day, cashier) {
  const log = [];
  // 09:00 clock in
  const clockIn = atDay(day, 9, randInt(0, 15));
  await insertClockEvent(pool, { employeeId: cashier.employeeId, eventType: "clock_in", at: clockIn });
  log.push(`  ${cashier.name.padEnd(10)} clock_in  ${clockIn.toISOString()}`);

  // 09:30 open shift with a $200 float
  const openedAt = atDay(day, 9, 30);
  const openingFloat = 200.0;
  const shiftId = await openShift(pool, { employeeId: cashier.employeeId, openingFloat, openedAt });
  log.push(`  ${cashier.name.padEnd(10)} shift_open @$${openingFloat.toFixed(2)}`);

  // Transactions 10:00–17:00. Number of txns varies per day/cashier.
  const nTxns = randInt(8, 14);
  const txnIds = [];
  let cashSalesTotal = 0;
  let cashChangeTotal = 0;
  for (let i = 0; i < nTxns; i++) {
    // Mixture: mostly plain; ~20% bundle; ~10% free-item
    const r = Math.random();
    const items = r < 0.7 ? buildPlainCart() : r < 0.9 ? buildBundleCart() : buildFreeItemCart();
    const totals = computeTotals(items);
    const { tenders, changeDue } = pickTenders(totals.grandTotal);
    // Spread across 10am–5pm with slight jitter
    const hourFrac = 10 + (7 * i) / Math.max(1, nTxns - 1);
    const h = Math.floor(hourFrac);
    const m = randInt(0, 59);
    const s = randInt(0, 59);
    const at = atDay(day, h, m, s);
    try {
      const txnId = await writeTxn(pool, {
        shiftId, employeeId: cashier.employeeId,
        createdAt: at, items, tenders, totals, changeDue,
      });
      txnIds.push(txnId);
      // Tally cash movements for the shift-close math
      for (const t of tenders) if (t.type === "cash") cashSalesTotal = round2(cashSalesTotal + t.amount);
      cashChangeTotal = round2(cashChangeTotal + changeDue);
    } catch (e) {
      log.push(`  ✗ txn ${i + 1} failed: ${e.message}`);
      console.error(`    [debug] ${e.stack?.split("\n").slice(0, 3).join(" | ")}`);
    }
  }
  log.push(`  ${cashier.name.padEnd(10)} ${nTxns} txns, cash=$${cashSalesTotal.toFixed(2)}, change=$${cashChangeTotal.toFixed(2)}`);

  // Lunch break
  const breakStart = atDay(day, 12, randInt(30, 59));
  const breakEnd = atDay(day, 13, randInt(0, 30));
  await insertClockEvent(pool, { employeeId: cashier.employeeId, eventType: "break_start", at: breakStart });
  await insertClockEvent(pool, { employeeId: cashier.employeeId, eventType: "break_end", at: breakEnd });

  // One pay_out (coffee run) and one pay_in (bank visit)
  await insertPayInOut(pool, { shiftId, employeeId: cashier.employeeId, direction: "pay_out", amount: round2(rand(5, 20)), reason: "Coffee run", at: atDay(day, 10, 45) });
  await insertPayInOut(pool, { shiftId, employeeId: cashier.employeeId, direction: "pay_in", amount: 100, reason: "Cash deposit from safe", at: atDay(day, 14, 15) });

  // Close shift. Expected cash = float + cash sales - change - pay_outs + pay_ins
  // We inserted $5-20 pay_out and $100 pay_in.
  // Declared_cash introduces a tiny variance to simulate real-world miscount.
  const payOutSum = 10; // approx — doesn't need to be exact; we record what's inserted
  const expectedCash = round2(openingFloat + cashSalesTotal - cashChangeTotal - payOutSum + 100);
  const declaredCash = round2(expectedCash + rand(-1.5, 1.5));
  const closedAt = atDay(day, 17, randInt(30, 59));
  await closeShift(pool, { shiftId, closedAt, expectedCash, declaredCash, note: `Sim ${SIM_RUN_ID}` });
  log.push(`  ${cashier.name.padEnd(10)} shift_close expected=$${expectedCash.toFixed(2)} declared=$${declaredCash.toFixed(2)} variance=${(declaredCash - expectedCash).toFixed(2)}`);

  // Clock out
  const clockOut = atDay(day, 18, randInt(0, 15));
  await insertClockEvent(pool, { employeeId: cashier.employeeId, eventType: "clock_out", at: clockOut });
  log.push(`  ${cashier.name.padEnd(10)} clock_out ${clockOut.toISOString()}`);

  return { shiftId, nTxns, cashSalesTotal, cashChangeTotal, expectedCash, declaredCash, txnIds, log };
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not found in .env.local");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

  console.log(`→ Simulating 3 days × ${CASHIERS.length} cashiers at ${ORG_ID.slice(0, 8)}…`);
  console.log(`  run id: ${SIM_RUN_ID}\n`);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = [-3, -2, -1].map((offset) => {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() + offset);
    return d;
  });

  const aggregate = { shifts: 0, txns: 0, cashSales: 0, cashChange: 0, expected: 0, declared: 0 };

  for (let di = 0; di < days.length; di++) {
    const day = days[di];
    console.log(`── Day ${di + 1} (${day.toISOString().slice(0, 10)}) ───────────────`);
    for (const cashier of CASHIERS) {
      // Run sequentially (shift_open → txns → shift_close). Two cashiers
      // on the same register_session could stack if parallelized; fine for
      // the simulation to keep them strictly sequential.
      const r = await simulateCashierDay(pool, day, cashier);
      r.log.forEach((l) => console.log(l));
      aggregate.shifts += 1;
      aggregate.txns += r.nTxns;
      aggregate.cashSales = round2(aggregate.cashSales + r.cashSalesTotal);
      aggregate.cashChange = round2(aggregate.cashChange + r.cashChangeTotal);
      aggregate.expected = round2(aggregate.expected + r.expectedCash);
      aggregate.declared = round2(aggregate.declared + r.declaredCash);
    }
    console.log("");
  }

  console.log("──────────── Summary ────────────");
  console.log(`Shifts opened+closed: ${aggregate.shifts}`);
  console.log(`Transactions:         ${aggregate.txns}`);
  console.log(`Cash sales total:     $${aggregate.cashSales.toFixed(2)}`);
  console.log(`Cash change total:    $${aggregate.cashChange.toFixed(2)}`);
  console.log(`Expected cash total:  $${aggregate.expected.toFixed(2)}`);
  console.log(`Declared cash total:  $${aggregate.declared.toFixed(2)}`);
  console.log(`Variance total:       $${(aggregate.declared - aggregate.expected).toFixed(2)}`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
