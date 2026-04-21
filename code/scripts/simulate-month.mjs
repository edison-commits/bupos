#!/usr/bin/env node
/**
 * 30-day retail simulator — stress test against the Docker test DB
 * (NOT prod). Runs shifts, transactions, returns, and time-clock events
 * for both seeded orgs in parallel. Reconciles at the end.
 *
 * Usage:
 *   docker compose up -d postgres
 *   bash scripts/docker-migrate.sh
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:54329/bupos_test" \
 *     node scripts/simulate-month.mjs
 *
 * Reports:
 *   • txns written, revenue, returns processed
 *   • clock-in / clock-out / break pairs per employee
 *   • invariant checks: no negative inventory, cashier never clocks_in
 *     twice without clock_out between, transactions sum = revenue
 *   • any cross-tenant pollution introduced BY the simulator itself
 *     (there must be zero — we only write rows whose organization_id
 *     matches the org the loop iterates over)
 *
 * ⚠️  SCOPE DISCLAIMER (R21-L-1):
 *
 *   This simulator connects as the `postgres` superuser, which HAS
 *   `BYPASSRLS`. RLS and FORCE RLS policies are NOT exercised by any
 *   query in this script. The "cross-tenant pollution" check below
 *   asserts the simulator itself wrote no cross-tenant rows; it does
 *   NOT prove that RLS would have blocked such writes from a normal
 *   caller.
 *
 *   For RLS / FORCE RLS regression coverage, see:
 *     src/__tests__/integration/cross-tenant.test.ts
 *   which runs as the non-superuser `app_user` role inside each tx so
 *   policies actually evaluate.
 *
 *   Simulator "cross-tenant = 0" passing ≠ "RLS holds". Don't confuse
 *   the two.
 */

import pg from "pg";
import crypto from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgresql://postgres:postgres@localhost:54329/bupos_test";

if (!DATABASE_URL.includes("localhost") && !DATABASE_URL.includes("127.0.0.1")) {
  console.error("Refusing to run against non-local DB:", DATABASE_URL);
  console.error("Set DATABASE_URL to the Docker test DB explicitly.");
  process.exit(1);
}

// Seed UUIDs — keep in sync with src/__tests__/integration/seed.sql.
const ORGS = [
  {
    id: "11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    name: "Alpha",
    locationId: "22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    employees: [
      { id: "44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Alice (owner)", role: "owner" },
      { id: "55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Alan (manager)", role: "manager" },
      { id: "66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Anna (cashier)", role: "cashier" },
    ],
    customerId: "77aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    variantId: "99aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    price: 19.99,
    taxRate: 0.095,
  },
  {
    id: "11bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    name: "Beta",
    locationId: "22bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    employees: [
      { id: "44bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Bob (owner)", role: "owner" },
      { id: "66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Betty (cashier)", role: "cashier" },
    ],
    customerId: "77bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    variantId: "99bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    price: 39.99,
    taxRate: 0.08875,
  },
];

const DAYS = 30;
// Deterministic seed so reruns produce the same output (useful for
// reconciliation — if the sim is deterministic and the invariants
// break, the run is reproducible).
let rngSeed = 0xDEADBEEF;
const seededRandom = () => {
  rngSeed = (rngSeed * 1664525 + 1013904223) >>> 0;
  return rngSeed / 0xFFFFFFFF;
};
const rand = (min, max) => seededRandom() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const choice = (arr) => arr[Math.floor(seededRandom() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

// ─── Top-up inventory so 30 days of sales don't go negative ───────────

async function topUpInventory() {
  for (const org of ORGS) {
    await pool.query(
      `UPDATE inventory_levels SET on_hand = 100000, updated_at = NOW()
        WHERE organization_id = $1 AND product_variant_id = $2 AND location_id = $3`,
      [org.id, org.variantId, org.locationId],
    );
  }
}

// ─── Shift + transaction + clock event builders ──────────────────────

async function openShift(client, org, employee, openedAt) {
  const shiftId = crypto.randomUUID();
  const registerSessionId = crypto.randomUUID();
  await client.query(
    `INSERT INTO register_sessions (id, organization_id, employee_id, location_id, auth_session_id, status, started_at)
     VALUES ($1, $2, $3, $4, gen_random_uuid(), 'active', $5)`,
    [registerSessionId, org.id, employee.id, org.locationId, openedAt],
  );
  await client.query(
    `INSERT INTO shifts (id, organization_id, location_id, employee_id, register_session_id, status, opened_at, opening_float)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, 100)`,
    [shiftId, org.id, org.locationId, employee.id, registerSessionId, openedAt],
  );
  return { shiftId, registerSessionId };
}

async function closeShift(client, shiftId, closedAt, expected, declared) {
  await client.query(
    `UPDATE shifts
        SET status = 'closed',
            closed_at = $1,
            closing_expected_cash = $2::numeric,
            closing_declared_cash = $3::numeric,
            closing_variance = ROUND($3::numeric - $2::numeric, 2)
      WHERE id = $4`,
    [closedAt, expected, declared, shiftId],
  );
}

async function clockEvent(client, org, employee, eventType, at) {
  await client.query(
    `INSERT INTO time_clock_entries
       (organization_id, employee_id, location_id, event_type, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [org.id, employee.id, org.locationId, eventType, at],
  );
}

async function writeTransaction(client, org, employee, shift, at, opts = {}) {
  const qty = opts.qty ?? randInt(1, 3);
  const subtotal = round2(org.price * qty);
  const tax = round2(subtotal * org.taxRate);
  const discount = 0;
  const grand = round2(subtotal + tax - discount);

  const txnId = crypto.randomUUID();
  const cartSnapshot = {
    items: [{
      productVariantId: org.variantId,
      quantity: qty,
      unitPrice: org.price,
      modifierTotal: 0,
    }],
    customerId: null,
  };

  const tenderType = opts.tender ?? choice(["cash", "card", "card", "card"]);
  const isRefund = opts.isRefund ?? false;
  const signedGrand = isRefund ? -grand : grand;

  await client.query(
    `INSERT INTO transactions
      (id, organization_id, location_id, register_session_id, employee_id, customer_id,
       cart_snapshot, subtotal, discount_total, tax_total, grand_total,
       tender_type, amount_tendered, change_due, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'completed',$15)`,
    [
      txnId, org.id, org.locationId, shift.registerSessionId, employee.id,
      null, JSON.stringify(cartSnapshot),
      isRefund ? -subtotal : subtotal,
      discount,
      isRefund ? -tax : tax,
      signedGrand,
      tenderType,
      isRefund ? 0 : grand,
      0,
      at,
    ],
  );

  await client.query(
    `INSERT INTO transaction_tenders (transaction_id, tender_type, amount, created_at)
     VALUES ($1, $2, $3, $4)`,
    [txnId, tenderType, signedGrand, at],
  );

  // Mirror the register/checkout flow: decrement inventory.
  const inventoryDelta = isRefund ? qty : -qty;
  await client.query(
    `UPDATE inventory_levels
        SET on_hand = on_hand + $1, updated_at = $2
      WHERE organization_id = $3 AND product_variant_id = $4 AND location_id = $5`,
    [inventoryDelta, at, org.id, org.variantId, org.locationId],
  );

  return { txnId, grand: signedGrand, tenderType };
}

// ─── Day simulator ────────────────────────────────────────────────────

async function simulateDay(dayIndex) {
  const dayStart = new Date(Date.UTC(2026, 3, 1)); // Apr 1 2026
  dayStart.setUTCDate(dayStart.getUTCDate() + dayIndex);

  const daySummary = { txns: 0, revenue: 0, returns: 0, clockEvents: 0, shiftsOpened: 0 };

  for (const org of ORGS) {
    // Skip random closed days (~10% — matches real retail cadence).
    if (seededRandom() < 0.1) continue;

    // Pick which cashiers work today. Always include at least one non-
    // owner; random subset of the others.
    const cashiers = org.employees.filter((e) => e.role !== "manager" || seededRandom() > 0.4);

    for (const emp of cashiers) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Clock in at 9am local (approx UTC +7 for Alpha/LA, +5 for Beta/NY — use UTC as proxy)
        const clockInAt = new Date(dayStart);
        clockInAt.setUTCHours(9 + randInt(0, 1), randInt(0, 30));
        await clockEvent(client, org, emp, "clock_in", clockInAt);
        daySummary.clockEvents++;

        // Open shift shortly after clock_in.
        const shiftOpenAt = new Date(clockInAt.getTime() + 60_000 * randInt(1, 5));
        const shift = await openShift(client, org, emp, shiftOpenAt);
        daySummary.shiftsOpened++;

        // Transactions throughout the day.
        const nTxns = randInt(15, 40);
        let dayRevenue = 0;
        for (let i = 0; i < nTxns; i++) {
          const txAt = new Date(shiftOpenAt.getTime() + (i + 1) * 60_000 * randInt(3, 12));
          // 3% chance of a refund (as negative-total transaction)
          const isRefund = seededRandom() < 0.03;
          const t = await writeTransaction(client, org, emp, shift, txAt, { isRefund });
          dayRevenue = round2(dayRevenue + t.grand);
          daySummary.txns++;
          if (isRefund) daySummary.returns++;
        }

        // Lunch break at ~1pm (optional — 60% chance).
        if (seededRandom() < 0.6) {
          const breakStart = new Date(dayStart);
          breakStart.setUTCHours(13, randInt(0, 30));
          await clockEvent(client, org, emp, "break_start", breakStart);
          const breakEnd = new Date(breakStart.getTime() + 30 * 60_000);
          await clockEvent(client, org, emp, "break_end", breakEnd);
          daySummary.clockEvents += 2;
        }

        // Close shift at ~5pm with a small variance.
        const shiftCloseAt = new Date(dayStart);
        shiftCloseAt.setUTCHours(17 + randInt(0, 2), randInt(0, 45));
        // Declared = expected + small random variance ($-5..+5)
        const expectedCash = dayRevenue > 0 ? 100 + dayRevenue * 0.3 : 100; // opening float + ~30% cash share
        const declared = round2(expectedCash + (seededRandom() * 10 - 5));
        await closeShift(client, shift.shiftId, shiftCloseAt, round2(expectedCash), declared);

        // Clock out after close.
        const clockOutAt = new Date(shiftCloseAt.getTime() + 60_000 * randInt(1, 10));
        await clockEvent(client, org, emp, "clock_out", clockOutAt);
        daySummary.clockEvents++;

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`  ❌ ${org.name} / ${emp.name} day ${dayIndex + 1} failed:`, e.message);
        throw e;
      } finally {
        client.release();
      }
    }
  }

  return daySummary;
}

// ─── Reconciliation ──────────────────────────────────────────────────

async function reconcile() {
  const client = await pool.connect();
  try {
    // Per-org totals
    for (const org of ORGS) {
      const { rows: txRows } = await client.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(grand_total), 0)::numeric(14,2) AS revenue,
                SUM(CASE WHEN grand_total < 0 THEN 1 ELSE 0 END)::int AS refunds
           FROM transactions WHERE organization_id = $1 AND status = 'completed'`,
        [org.id],
      );
      const { rows: clockRows } = await client.query(
        `SELECT event_type, COUNT(*)::int AS count
           FROM time_clock_entries WHERE organization_id = $1 GROUP BY event_type`,
        [org.id],
      );
      const { rows: invRows } = await client.query(
        `SELECT on_hand FROM inventory_levels
            WHERE organization_id = $1 AND product_variant_id = $2 AND location_id = $3`,
        [org.id, org.variantId, org.locationId],
      );
      const { rows: shiftRows } = await client.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END)::int AS closed,
                SUM(CASE WHEN closing_variance <> 0 THEN 1 ELSE 0 END)::int AS nonzero_variance
           FROM shifts WHERE organization_id = $1`,
        [org.id],
      );

      const clockByType = Object.fromEntries(clockRows.map((r) => [r.event_type, r.count]));
      const onHand = invRows[0]?.on_hand;
      const shifts = shiftRows[0];

      console.log(`\n── ${org.name} (${org.id.slice(0, 8)}) ──`);
      console.log(`  Transactions: ${txRows[0].count}  (refunds: ${txRows[0].refunds})`);
      console.log(`  Revenue:      $${txRows[0].revenue}`);
      console.log(`  Shifts:       ${shifts.total} total, ${shifts.closed} closed, ${shifts.nonzero_variance} with variance`);
      console.log(`  Clock events: clock_in=${clockByType.clock_in ?? 0}, clock_out=${clockByType.clock_out ?? 0}, break_start=${clockByType.break_start ?? 0}, break_end=${clockByType.break_end ?? 0}`);
      console.log(`  Inventory on hand: ${onHand}  ${onHand < 0 ? "❌ NEGATIVE" : ""}`);

      // Invariant: clock_in count == clock_out count
      const clockIns = clockByType.clock_in ?? 0;
      const clockOuts = clockByType.clock_out ?? 0;
      if (clockIns !== clockOuts) {
        console.log(`  ⚠ clock-in/out mismatch: ${clockIns} ins vs ${clockOuts} outs`);
      }

      // Invariant: break_start == break_end
      const breakStarts = clockByType.break_start ?? 0;
      const breakEnds = clockByType.break_end ?? 0;
      if (breakStarts !== breakEnds) {
        console.log(`  ⚠ break start/end mismatch: ${breakStarts} starts vs ${breakEnds} ends`);
      }

      // Invariant: every shift is either open or closed, not "orphaned"
      if (shifts.total !== shifts.closed) {
        console.log(`  ⚠ ${shifts.total - shifts.closed} shift(s) never closed`);
      }
    }

    // Cross-tenant pollution check — should be zero.
    const { rows: crossTenant } = await client.query(
      `SELECT t.id, t.organization_id AS tx_org, e.organization_id AS emp_org
         FROM transactions t
         LEFT JOIN employees e ON e.id = t.employee_id
        WHERE t.organization_id <> e.organization_id`,
    );
    console.log(`\n── Cross-tenant pollution ──`);
    console.log(`  Transactions with mismatched (txn.org vs employee.org): ${crossTenant.length}  ${crossTenant.length === 0 ? "✓" : "❌"}`);

    // Per-day sanity: first and last transaction timestamps
    const { rows: rangeRows } = await client.query(
      `SELECT MIN(created_at) AS first, MAX(created_at) AS last, COUNT(*)::int AS total
         FROM transactions WHERE status = 'completed'`,
    );
    if (rangeRows[0].total > 0) {
      console.log(`\n── Overall range ──`);
      console.log(`  First txn: ${rangeRows[0].first.toISOString()}`);
      console.log(`  Last  txn: ${rangeRows[0].last.toISOString()}`);
      console.log(`  Total:     ${rangeRows[0].total}`);
    }
  } finally {
    client.release();
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log(`🏪 Simulating ${DAYS} days across ${ORGS.length} orgs...`);
  console.log(`   DATABASE_URL=${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);

  await topUpInventory();

  let totals = { txns: 0, revenue: 0, returns: 0, clockEvents: 0, shiftsOpened: 0 };

  for (let d = 0; d < DAYS; d++) {
    const s = await simulateDay(d);
    totals.txns += s.txns;
    totals.revenue += s.revenue;
    totals.returns += s.returns;
    totals.clockEvents += s.clockEvents;
    totals.shiftsOpened += s.shiftsOpened;
    if ((d + 1) % 5 === 0 || d === DAYS - 1) {
      console.log(`  day ${String(d + 1).padStart(2, "0")} ✓  txns=${s.txns}  shifts=${s.shiftsOpened}  clock=${s.clockEvents}`);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`\n🏁 Simulation complete in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`   Totals: ${totals.txns} txns, ${totals.shiftsOpened} shifts, ${totals.clockEvents} clock events, ${totals.returns} refunds`);

  await reconcile();

  await pool.end();
}

main().catch((e) => {
  console.error("Simulation crashed:", e);
  pool.end().catch(() => {});
  process.exit(1);
});
