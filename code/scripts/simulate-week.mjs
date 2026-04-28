#!/usr/bin/env node
/**
 * 7-day retail simulator — full-stack stress test of shifts, transactions
 * (regular + bundle + free-item promo), returns, and promo redemption
 * tracking. Writes directly to Postgres via DATABASE_URL; skips the HTTP
 * path for speed but mirrors the server's transaction/ledger logic so
 * invariants hold (current_redemptions matches promo_redemptions count,
 * inventory_adjustments delta matches sale line quantities, etc.).
 *
 * Unlike simulate-3-days.mjs this one:
 *   • 7 days × 2–3 cashiers/day × variable txn volume
 *   • Stages some returns on later days against earlier transactions —
 *     exercises return-action's restock + promo_redemption reversal
 *   • Reports reconciliation at the end: DB totals vs in-memory totals,
 *     current_redemptions vs promo_redemptions row count, any negative
 *     inventory.
 *
 * Run:  node scripts/simulate-week.mjs
 */

import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";

// ─── Config ─────────────────────────────────────────────────────────────

const DAYS = 7;
const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const LOCATION_ID = "c57268b3-cb14-4c1a-bda6-55e49ddc6313";
const TAX_RATE = 0.1025;
const BUNDLE_ID = "b0b1b2b3-aaaa-bbbb-cccc-dddddddddddd";
const BUNDLE_PRICE = 70.0;
const FREE_PROMO_ID = "c0c1c2c3-eeee-ffff-aaaa-bbbbbbbbbbbb";
const FREE_PROMO_VARIANT_ID = "021e7e4d-88c3-42bd-8b47-d8e8d97f84b7";

const VARIANTS = [
  { id: "3fcfb7b8-856c-4ed7-8cd2-cbb1666f2e18", sku: "DEN-HR-28-BLU", price: 54, name: "High Rise Straight Jean", variant: "28 / Blue" },
  { id: "13b7dd62-e5d6-4a1b-bf90-0fbaefb56032", sku: "DEN-HR-30-BLU", price: 54, name: "High Rise Straight Jean", variant: "30 / Blue" },
  { id: "20e5e39c-fa01-41ed-9a48-fe9886b0dc75", sku: "TOP-OS-L-WHT",  price: 22, name: "Oversized Essential Tee", variant: "Large / White" },
  { id: "021e7e4d-88c3-42bd-8b47-d8e8d97f84b7", sku: "TOP-OS-M-BLK",  price: 22, name: "Oversized Essential Tee", variant: "Medium / Black" },
];
const VARIANT_BY_ID = Object.fromEntries(VARIANTS.map(v => [v.id, v]));

const CASHIERS = [
  { employeeId: "4dcad700-6335-4e69-b4c3-c15e39e3e583", name: "Maya M." },
  { employeeId: "05601136-d318-4fa3-b960-465e63dcac84", name: "Chris C." },
  { employeeId: "fe47b5a2-81f3-4126-afdd-663e69fc9312", name: "Edison O." },
];
const REGISTER_SESSION_ID = "05ee071f-0d1e-493b-b8a1-bb997f966b04";

const SIM_RUN_ID = `sim-week-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;

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

function atDay(day, hour, min = 0, sec = 0) {
  const d = new Date(day);
  d.setUTCHours(hour, min, sec, 0);
  return d;
}

// ─── Cart builders ────────────────────────────────────────────────────

function buildPlainCart() {
  const nLines = randInt(1, 3);
  const chosen = new Set();
  const items = [];
  for (let i = 0; i < nLines; i++) {
    const v = choice(VARIANTS);
    if (chosen.has(v.id)) continue;
    chosen.add(v.id);
    items.push({
      id: uuid(),
      productVariantId: v.id,
      productName: v.name,
      variantName: v.variant,
      sku: v.sku,
      unitPrice: v.price,
      quantity: randInt(1, 2),
      modifierIds: [],
      modifierTotal: 0,
    });
  }
  return items;
}

function buildBundleCart() {
  const bundleLine = {
    id: uuid(),
    productVariantId: BUNDLE_ID,
    productName: "Starter Outfit",
    variantName: "Bundle",
    sku: "[Bundle] sim-starter-outfit",
    unitPrice: BUNDLE_PRICE,
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
  // Two jeans ($108) + free tee
  const items = [];
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
  const taxTotal = round2(subtotal * TAX_RATE);
  const grandTotal = round2(subtotal + taxTotal);
  return { subtotal, taxTotal, grandTotal };
}

function pickTenders(grandTotal) {
  const r = Math.random();
  if (r < 0.55) {
    const paid = round2(grandTotal + (Math.random() < 0.3 ? rand(0, 15) : 0));
    return { tenders: [{ type: "cash", amount: paid }], changeDue: round2(Math.max(0, paid - grandTotal)) };
  }
  if (r < 0.85) {
    return { tenders: [{ type: "card", amount: grandTotal }], changeDue: 0 };
  }
  const cashPart = round2(grandTotal * rand(0.3, 0.7));
  return {
    tenders: [
      { type: "cash", amount: cashPart },
      { type: "card", amount: round2(grandTotal - cashPart) },
    ],
    changeDue: 0,
  };
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
    console.error(`    [withOrgTx] ${e.message}`);
    throw e;
  } finally {
    client.release();
  }
}

async function writeTxn(pool, { employeeId, createdAt, items, tenders, totals, changeDue }) {
  const txnId = uuid();
  const primaryTenderType = tenders.length === 1 ? tenders[0].type : "split";
  const totalTendered = round2(tenders.reduce((s, t) => s + t.amount, 0));
  const cartSnapshot = {
    id: uuid(), registerSessionId: REGISTER_SESSION_ID, employeeId,
    locationId: LOCATION_ID, items,
    discountAmount: 0, discountMode: "fixed", taxRate: TAX_RATE,
    status: "checked_out",
    createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(),
    _sim: SIM_RUN_ID,
  };

  await withOrgTx(pool, async (c) => {
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
    await c.query(
      `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload, created_at)
       VALUES ($1, $2, $3, 'transaction_placeholder', $4, $5, $6)`,
      [
        uuid(), txnId, employeeId, `Checkout completed (sim)`,
        JSON.stringify({
          location_id: LOCATION_ID, register_session_id: REGISTER_SESSION_ID,
          item_count: items.reduce((s, it) => s + it.quantity, 0),
          grand_total: totals.grandTotal.toFixed(2),
          tender_count: tenders.length,
          primary_tender_type: primaryTenderType,
          change_due: changeDue.toFixed(2),
          _sim: SIM_RUN_ID,
        }),
        createdAt.toISOString(),
      ],
    );

    // Aggregate inventory by variant (bundle expansion + free items)
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
      const { rows } = await c.query(
        `INSERT INTO inventory_levels (organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point, updated_at)
         VALUES ($1, $2, $3, 0, 0, 0, $4)
         ON CONFLICT (product_variant_id, location_id)
         DO UPDATE SET on_hand = GREATEST(0, inventory_levels.on_hand - $5), updated_at = $4
         RETURNING id, on_hand`,
        [ORG_ID, LOCATION_ID, variantId, createdAt.toISOString(), qty],
      );
      await c.query(
        `INSERT INTO inventory_adjustments
         (inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand, created_at)
         VALUES ($1, $2, $3, $4, 'sale', $5, $6, $7)`,
        [rows[0].id, variantId, LOCATION_ID, employeeId, -qty, rows[0].on_hand, createdAt.toISOString()],
      );
    }
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
  });

  return txnId;
}

async function writeReturn(pool, { originalTxnId, createdAt, employeeId }) {
  // Fetch original snapshot + promo lines
  const client = await pool.connect();
  let origItems, origSubtotal, origTax, origDiscount;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [ORG_ID]);
    const { rows: orig } = await client.query(
      `SELECT cart_snapshot, subtotal, tax_total, discount_total FROM transactions WHERE id = $1`,
      [originalTxnId],
    );
    if (!orig[0]) throw new Error(`origin txn ${originalTxnId} not found`);
    const snap = typeof orig[0].cart_snapshot === "string" ? JSON.parse(orig[0].cart_snapshot) : orig[0].cart_snapshot;
    origItems = snap.items ?? [];
    origSubtotal = Number(orig[0].subtotal);
    origTax = Number(orig[0].tax_total);
    origDiscount = Number(orig[0].discount_total);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  if (origItems.length === 0) return null;

  // Pick 1-2 lines to return (random). Skip bundle lines for simplicity
  // — returning a bundle expands to component restock, which works but
  // adds noise to the sim's per-variant tallies.
  const candidateLines = origItems.filter((it) => !it.bundleId);
  if (candidateLines.length === 0) return null;
  const line = choice(candidateLines);
  const returnQty = 1; // always return 1 for simplicity

  const isFree = !!line.promoCodeId;
  const refundBase = isFree ? 0 : line.unitPrice * returnQty;
  const discountFactor = origSubtotal > 0 ? Math.max(0, 1 - origDiscount / origSubtotal) : 1;
  const effectiveTaxRate = origSubtotal > 0 ? origTax / origSubtotal : 0;
  const refundSubtotal = round2(refundBase * discountFactor);
  const refundTax = round2(refundSubtotal * effectiveTaxRate);
  const refundGrand = round2(refundSubtotal + refundTax);

  const returnTxnId = uuid();

  await withOrgTx(pool, async (c) => {
    // Return transaction (negative amounts)
    await c.query(
      `INSERT INTO transactions
       (id, organization_id, location_id, register_session_id, employee_id, cart_snapshot,
        subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered,
        change_due, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, 0, 'completed', $12, $12)`,
      [
        returnTxnId, ORG_ID, LOCATION_ID, REGISTER_SESSION_ID, employeeId,
        JSON.stringify({
          items: [{
            productVariantId: line.productVariantId,
            productName: line.productName, variantName: line.variantName, sku: line.sku,
            unitPrice: line.unitPrice, quantity: returnQty,
            ...(line.promoCodeId ? { promoCodeId: line.promoCodeId, overridePrice: 0 } : {}),
          }],
          isReturn: true,
          originalTransactionId: originalTxnId,
          reason: "changed_mind",
          _sim: SIM_RUN_ID,
        }),
        -refundSubtotal, -refundTax, -refundGrand,
        "cash", -refundGrand,
        createdAt.toISOString(),
      ],
    );

    // Refund tender line (negative)
    await c.query(
      `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata, created_at)
       VALUES ($1, $2, 'cash', $3, $4, $5)`,
      [
        uuid(), returnTxnId, -refundGrand,
        JSON.stringify({ original_transaction_id: originalTxnId, is_return: "true", reason: "changed_mind" }),
        createdAt.toISOString(),
      ],
    );

    // Restock inventory (single variant — skipping bundle expansion for sim simplicity)
    const { rows: inv } = await c.query(
      `UPDATE inventory_levels SET on_hand = on_hand + $1, updated_at = $2
       WHERE product_variant_id = $3 AND location_id = $4 RETURNING id, on_hand`,
      [returnQty, createdAt.toISOString(), line.productVariantId, LOCATION_ID],
    );
    if (inv[0]) {
      await c.query(
        `INSERT INTO inventory_adjustments
         (inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand, created_at)
         VALUES ($1, $2, $3, $4, 'return', $5, $6, $7)`,
        [inv[0].id, line.productVariantId, LOCATION_ID, employeeId, returnQty, inv[0].on_hand, createdAt.toISOString()],
      );
    }

    // Free-item line: reverse the promo_redemption and decrement
    // current_redemptions — mirrors return-action.ts logic so the sim's
    // DB state matches what production's return flow would produce.
    if (line.promoCodeId) {
      const { rows: deleted } = await c.query(
        `DELETE FROM promo_redemptions
         WHERE transaction_id = $1 AND promo_code_id = $2
         RETURNING promo_code_id`,
        [originalTxnId, line.promoCodeId],
      );
      for (const r of deleted) {
        await c.query(
          `UPDATE promo_codes
             SET current_redemptions = GREATEST(0, current_redemptions - 1),
                 status = CASE WHEN status = 'depleted' THEN 'active' ELSE status END,
                 updated_at = $1
           WHERE id = $2`,
          [createdAt.toISOString(), r.promo_code_id],
        );
      }
    }
  });

  return { returnTxnId, isFree, refundGrand, variantId: line.productVariantId, quantity: returnQty };
}

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

async function insertClockEvent(pool, { employeeId, eventType, at }) {
  await withOrgTx(pool, async (c) => {
    await c.query(
      `INSERT INTO time_clock_entries
       (organization_id, employee_id, location_id, event_type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [ORG_ID, employeeId, LOCATION_ID, eventType, at.toISOString()],
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

// ─── Simulate one cashier-day ─────────────────────────────────────────

async function simulateCashierDay(pool, day, cashier, dayTxnIds) {
  const clockIn = atDay(day, 9, randInt(0, 15));
  await insertClockEvent(pool, { employeeId: cashier.employeeId, eventType: "clock_in", at: clockIn });

  const openedAt = atDay(day, 9, 30);
  const openingFloat = 200.0;
  const shiftId = await openShift(pool, { employeeId: cashier.employeeId, openingFloat, openedAt });

  const nTxns = randInt(10, 18);
  let cashSales = 0, cashChange = 0;
  let nPlain = 0, nBundle = 0, nFree = 0;
  const txnIds = [];
  for (let i = 0; i < nTxns; i++) {
    const r = Math.random();
    let items;
    if (r < 0.6)      { items = buildPlainCart(); nPlain++; }
    else if (r < 0.85) { items = buildBundleCart(); nBundle++; }
    else               { items = buildFreeItemCart(); nFree++; }
    const totals = computeTotals(items);
    const { tenders, changeDue } = pickTenders(totals.grandTotal);
    const hourFrac = 10 + (7 * i) / Math.max(1, nTxns - 1);
    const h = Math.floor(hourFrac);
    const at = atDay(day, h, randInt(0, 59), randInt(0, 59));
    try {
      const txnId = await writeTxn(pool, { employeeId: cashier.employeeId, createdAt: at, items, tenders, totals, changeDue });
      txnIds.push(txnId);
      dayTxnIds.push({ txnId, day: day.toISOString().slice(0, 10), hasFree: nFree > 0 && items.some((it) => it.promoCodeId) });
      for (const t of tenders) if (t.type === "cash") cashSales = round2(cashSales + t.amount);
      cashChange = round2(cashChange + changeDue);
    } catch (e) {
      return { error: e.message, shiftId };
    }
  }

  // Lunch break
  await insertClockEvent(pool, { employeeId: cashier.employeeId, eventType: "break_start", at: atDay(day, 12, randInt(30, 59)) });
  await insertClockEvent(pool, { employeeId: cashier.employeeId, eventType: "break_end",   at: atDay(day, 13, randInt(0, 30)) });

  await insertPayInOut(pool, { shiftId, employeeId: cashier.employeeId, direction: "pay_out", amount: round2(rand(5, 20)), reason: "Coffee run", at: atDay(day, 10, 45) });
  await insertPayInOut(pool, { shiftId, employeeId: cashier.employeeId, direction: "pay_in",  amount: 100, reason: "Cash deposit from safe", at: atDay(day, 14, 15) });

  const payOutApprox = 10, payInFixed = 100;
  const expectedCash = round2(openingFloat + cashSales - cashChange - payOutApprox + payInFixed);
  const declaredCash = round2(expectedCash + rand(-1.5, 1.5));
  await closeShift(pool, { shiftId, closedAt: atDay(day, 17, randInt(30, 59)),
    expectedCash, declaredCash, note: `Sim ${SIM_RUN_ID}` });

  await insertClockEvent(pool, { employeeId: cashier.employeeId, eventType: "clock_out", at: atDay(day, 18, randInt(0, 15)) });

  return { shiftId, nTxns, nPlain, nBundle, nFree, cashSales, cashChange, expectedCash, declaredCash, txnIds };
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not found");
  // TST2-H2: prod-host guard via shared helper.
  const { assertSafeTargetDb } = await import("./_safe-db.mjs");
  assertSafeTargetDb({ forceEnv: 'SIMULATE_WEEK_FORCE', scriptId: 'simulate-week' });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

  console.log(`→ Simulating ${DAYS} days × variable cashiers at ${ORG_ID.slice(0, 8)}…`);
  console.log(`  run id: ${SIM_RUN_ID}\n`);

  // Record starting promo count so we can reconcile at the end
  let startingPromoRedemptions = 0;
  {
    const c = await pool.connect();
    const { rows } = await c.query(`SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code_id = $1`, [FREE_PROMO_ID]);
    startingPromoRedemptions = rows[0].n;
    c.release();
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - (DAYS - i));
    return d;
  });

  const agg = { shifts: 0, txns: 0, plain: 0, bundle: 0, free: 0, cashSales: 0, cashChange: 0, expected: 0, declared: 0, errors: [] };
  const allTxnIds = []; // { txnId, day, hasFree }
  const returns = [];

  for (let di = 0; di < days.length; di++) {
    const day = days[di];
    // Vary cashier count per day: 2 cashiers most days, 3 on busy days (Fri/Sat equivalent)
    const isBusy = di === 4 || di === 5;
    const cashiersToday = isBusy ? CASHIERS : CASHIERS.slice(0, 2);
    console.log(`── Day ${di + 1} of ${DAYS} (${day.toISOString().slice(0, 10)})  [${cashiersToday.length} cashiers${isBusy ? ", busy" : ""}] ─────────`);
    for (const cashier of cashiersToday) {
      const r = await simulateCashierDay(pool, day, cashier, allTxnIds);
      if (r.error) {
        agg.errors.push({ day: day.toISOString().slice(0, 10), cashier: cashier.name, error: r.error });
        console.log(`  ✗ ${cashier.name}: ${r.error}`);
        continue;
      }
      console.log(`  ${cashier.name.padEnd(10)} ${r.nTxns} txns (${r.nPlain} plain, ${r.nBundle} bundle, ${r.nFree} free) · cash $${r.cashSales.toFixed(2)} · variance ${(r.declaredCash - r.expectedCash).toFixed(2)}`);
      agg.shifts += 1;
      agg.txns   += r.nTxns;
      agg.plain  += r.nPlain;
      agg.bundle += r.nBundle;
      agg.free   += r.nFree;
      agg.cashSales = round2(agg.cashSales + r.cashSales);
      agg.cashChange = round2(agg.cashChange + r.cashChange);
      agg.expected   = round2(agg.expected + r.expectedCash);
      agg.declared   = round2(agg.declared + r.declaredCash);
    }

    // On days 3+, do ~3-5 returns against earlier-day transactions.
    // Stages exchange-like activity to exercise the restock + promo
    // reversal code paths.
    if (di >= 2 && allTxnIds.length > 5) {
      const nReturns = randInt(3, 5);
      for (let r = 0; r < nReturns; r++) {
        const earlyIds = allTxnIds.filter((t) => t.day !== day.toISOString().slice(0, 10));
        if (earlyIds.length === 0) break;
        const pick = choice(earlyIds);
        // Prefer returning a transaction that had a free-item line (stress the reversal path)
        const targetPref = allTxnIds.filter((t) => t.hasFree);
        const target = Math.random() < 0.4 && targetPref.length > 0 ? choice(targetPref) : pick;
        try {
          const ret = await writeReturn(pool, {
            originalTxnId: target.txnId,
            createdAt: atDay(day, randInt(14, 17), randInt(0, 59)),
            employeeId: cashiersToday[0].employeeId,
          });
          if (ret) returns.push({ day: day.toISOString().slice(0, 10), ...ret });
        } catch (e) {
          agg.errors.push({ day: day.toISOString().slice(0, 10), return: true, error: e.message });
        }
      }
      console.log(`  → ${nReturns} returns staged against earlier txns`);
    }
    console.log("");
  }

  // ─── Reconciliation ────────────────────────────────────────
  console.log("────────── Reconciliation ──────────");
  const c = await pool.connect();
  try {
    // DB totals for sim txns
    const { rows: dbAgg } = await c.query(
      `SELECT
         COUNT(*)::int AS n,
         ROUND(SUM(subtotal),2) AS sub,
         ROUND(SUM(tax_total),2) AS tax,
         ROUND(SUM(grand_total),2) AS grand
       FROM transactions
       WHERE cart_snapshot->>'_sim' = $1`,
      [SIM_RUN_ID],
    );
    console.log(`DB transactions tagged '${SIM_RUN_ID}': ${dbAgg[0].n}`);
    console.log(`  subtotal sum:    $${dbAgg[0].sub}`);
    console.log(`  tax sum:         $${dbAgg[0].tax}`);
    console.log(`  grand total sum: $${dbAgg[0].grand}`);

    const expectedTxns = agg.txns + returns.length;
    console.log(`Simulator said: ${expectedTxns} inserts (${agg.txns} sales + ${returns.length} returns)`);
    if (dbAgg[0].n !== expectedTxns) {
      console.log(`  ⚠  MISMATCH: DB has ${dbAgg[0].n}, sim said ${expectedTxns}`);
    } else {
      console.log(`  ✓ match`);
    }

    // Promo reconciliation
    const { rows: pr } = await c.query(
      `SELECT code, current_redemptions,
              (SELECT COUNT(*)::int FROM promo_redemptions WHERE promo_code_id = pc.id) AS rows
       FROM promo_codes pc WHERE id = $1`,
      [FREE_PROMO_ID],
    );
    const deltaCurrent = pr[0].current_redemptions - startingPromoRedemptions;
    const deltaRows = pr[0].rows - startingPromoRedemptions;
    console.log(`\nFREE promo (${pr[0].code}):`);
    console.log(`  current_redemptions:     ${pr[0].current_redemptions} (Δ ${deltaCurrent})`);
    console.log(`  promo_redemptions rows:  ${pr[0].rows} (Δ ${deltaRows})`);
    if (pr[0].current_redemptions !== pr[0].rows) {
      console.log(`  ⚠  DRIFT: counter (${pr[0].current_redemptions}) != rows (${pr[0].rows})`);
    } else {
      console.log(`  ✓ counter matches row count`);
    }

    // Negative inventory check
    const { rows: negInv } = await c.query(
      `SELECT product_variant_id, on_hand FROM inventory_levels
       WHERE location_id = $1 AND on_hand < 0`,
      [LOCATION_ID],
    );
    if (negInv.length > 0) {
      console.log(`\n  ⚠  NEGATIVE INVENTORY:`);
      for (const row of negInv) console.log(`    ${row.product_variant_id}: ${row.on_hand}`);
    } else {
      console.log(`\n✓ No negative inventory`);
    }

    // Orphan redemptions check (promo_redemption rows pointing at
    // non-existent transactions)
    const { rows: orphans } = await c.query(
      `SELECT pr.id, pr.promo_code_id FROM promo_redemptions pr
       LEFT JOIN transactions t ON t.id = pr.transaction_id
       WHERE t.id IS NULL`,
    );
    if (orphans.length > 0) {
      console.log(`\n  ⚠  ORPHANED promo_redemption ROWS: ${orphans.length}`);
    } else {
      console.log(`✓ No orphaned promo_redemption rows`);
    }

    // Shifts reconciliation
    const { rows: shiftCount } = await c.query(
      `SELECT COUNT(*)::int AS n FROM shifts WHERE opened_note LIKE $1`,
      [`Sim ${SIM_RUN_ID}%`],
    );
    console.log(`\nShifts opened+closed: DB=${shiftCount[0].n}, sim=${agg.shifts}`);
    if (shiftCount[0].n !== agg.shifts) console.log(`  ⚠  MISMATCH`);
    else console.log(`  ✓ match`);

  } finally {
    c.release();
  }

  console.log("\n────────── Summary ──────────");
  console.log(`Shifts:       ${agg.shifts}`);
  console.log(`Transactions: ${agg.txns} sales + ${returns.length} returns`);
  console.log(`  plain:       ${agg.plain}`);
  console.log(`  bundle:      ${agg.bundle}`);
  console.log(`  free-item:   ${agg.free}`);
  console.log(`Cash sales:   $${agg.cashSales.toFixed(2)}`);
  console.log(`Cash change:  $${agg.cashChange.toFixed(2)}`);
  console.log(`Expected cash: $${agg.expected.toFixed(2)}  Declared: $${agg.declared.toFixed(2)}  Variance: $${(agg.declared - agg.expected).toFixed(2)}`);
  if (agg.errors.length > 0) {
    console.log(`\n✗ ${agg.errors.length} errors:`);
    for (const e of agg.errors) console.log(`  ${JSON.stringify(e)}`);
  } else {
    console.log(`\n✓ No runtime errors`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
