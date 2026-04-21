#!/usr/bin/env node
/**
 * Concurrent operations targeting the SAME entity — boundary-contention
 * tests that the 300-txn bulk load can't hit directly.
 *
 * Scenarios:
 *   1. Promo at max_redemptions - 1 + 2 concurrent redeemers.
 *      Expect: exactly one succeeds, one fails.
 *   2. Gift card with $50 balance + 2 concurrent $30 redemptions.
 *      Expect: exactly one succeeds (final balance $20, not -$10).
 *   3. Customer with $100 store credit + 2 concurrent $60 deducts.
 *      Expect: exactly one succeeds.
 *   4. Two concurrent shift closes on the same shift.
 *      Expect: exactly one commits closed status.
 *   5. Two concurrent pay_in on same shift.
 *      Expect: both commit (different rows, shouldn't race).
 *
 * Each scenario sets up a seeded entity in a clean state, fires the two
 * concurrent writers, then asserts the post-state matches exactly-once
 * semantics.
 *
 * Run:  node scripts/test-concurrent-same-entity.mjs
 */

import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";

const txt = fs.readFileSync("/Users/edison/Desktop/bupos/code/.env.local", "utf8");
for (const line of txt.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^"|"$/g, "");
}

const ORG = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const LOCATION = "c57268b3-cb14-4c1a-bda6-55e49ddc6313";
const EMPLOYEE = "fe47b5a2-81f3-4126-afdd-663e69fc9312";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "\u2713" : "\u2717"} ${name}${detail ? `  (${detail})` : ""}`);
}

async function orgTx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_org_id', $1, true)", [ORG]);
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

// ─── Scenario 1: Promo boundary race ────────────────────────────────────

async function testPromoBoundaryRace() {
  const promoId = crypto.randomUUID();
  await orgTx(async (c) => {
    // Promo with max_redemptions=2 and current=1 — exactly 1 slot left.
    await c.query(
      `INSERT INTO promo_codes (id, organization_id, code, description, type, value,
                                minimum_purchase, max_redemptions, current_redemptions,
                                status, starts_at, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'RACE-PROMO-' || LEFT($1::uuid::text, 8), 'boundary race test',
               'percent', 10, 0, 2, 1, 'active', NOW(), NOW() + INTERVAL '1 day', NOW(), NOW())`,
      [promoId, ORG],
    );
  });

  // Two concurrent "redeem this promo" attempts. Each runs the same SQL
  // the production path (offline-sync / register checkout) runs: FOR UPDATE
  // on the promo row, check max, bump counter.
  const redeem = async () => {
    try {
      return await orgTx(async (c) => {
        const { rows } = await c.query(
          `SELECT current_redemptions, max_redemptions FROM promo_codes
           WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [promoId, ORG],
        );
        const p = rows[0];
        if (p.current_redemptions >= p.max_redemptions) {
          return { status: "rejected", reason: "depleted" };
        }
        await c.query(
          `UPDATE promo_codes SET current_redemptions = current_redemptions + 1,
           status = CASE WHEN current_redemptions + 1 >= max_redemptions THEN 'depleted' ELSE status END,
           updated_at = NOW() WHERE id = $1 AND organization_id = $2`,
          [promoId, ORG],
        );
        return { status: "accepted" };
      });
    } catch (e) {
      return { status: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, 80) };
    }
  };

  const [a, b] = await Promise.all([redeem(), redeem()]);
  const { rows: post } = await pool.query(
    `SELECT current_redemptions, status FROM promo_codes WHERE id = $1`,
    [promoId],
  );

  const accepted = [a, b].filter((r) => r.status === "accepted").length;
  const rejected = [a, b].filter((r) => r.status === "rejected").length;
  record(
    "promo max_redemptions boundary: exactly one of two concurrent redeems succeeds",
    accepted === 1 && rejected === 1 && Number(post[0].current_redemptions) === 2,
    `accepted=${accepted}, rejected=${rejected}, final count=${post[0].current_redemptions}, status=${post[0].status}`,
  );

  // Cleanup
  await pool.query(`DELETE FROM promo_codes WHERE id = $1`, [promoId]);
}

// ─── Scenario 2: Gift card balance race ─────────────────────────────────

async function testGiftCardBalanceRace() {
  const gcId = crypto.randomUUID();
  await orgTx(async (c) => {
    await c.query(
      `INSERT INTO gift_cards (id, organization_id, code, balance, initial_balance,
                               status, activated_by, activated_at, created_at, updated_at)
       VALUES ($1, $2, 'RACE-GC-' || LEFT($1::uuid::text, 8), 50.00, 50.00, 'active',
               $3, NOW(), NOW(), NOW())`,
      [gcId, ORG, EMPLOYEE],
    );
  });

  // Two concurrent $30 redemptions against a $50 card — exactly one can
  // succeed (30+30=60 > 50).
  const redeem = async (amount) => {
    try {
      return await orgTx(async (c) => {
        const { rows } = await c.query(
          `SELECT balance, status FROM gift_cards WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [gcId, ORG],
        );
        const card = rows[0];
        if (card.status !== "active" || Number(card.balance) < amount) {
          return { status: "rejected", reason: "insufficient" };
        }
        const newBal = Number(card.balance) - amount;
        await c.query(
          `UPDATE gift_cards SET balance = $1::numeric,
           status = CASE WHEN $1::numeric <= 0 THEN 'depleted' ELSE 'active' END,
           updated_at = NOW() WHERE id = $2 AND organization_id = $3`,
          [newBal, gcId, ORG],
        );
        return { status: "accepted", newBal };
      });
    } catch (e) {
      return { status: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, 80) };
    }
  };

  const [a, b] = await Promise.all([redeem(30), redeem(30)]);
  const { rows: post } = await pool.query(
    `SELECT balance FROM gift_cards WHERE id = $1`,
    [gcId],
  );

  const accepted = [a, b].filter((r) => r.status === "accepted").length;
  const errors = [a, b].filter((r) => r.status === "error");
  const finalBal = Number(post[0].balance);
  record(
    "gift card balance: concurrent $30 redeems on $50 card — exactly one succeeds",
    accepted === 1 && finalBal === 20,
    `accepted=${accepted}, errors=${errors.length}, final balance=${finalBal} (expected 20). ${errors.length ? "err[0]: " + errors[0].error : ""}`,
  );

  await pool.query(`DELETE FROM gift_cards WHERE id = $1`, [gcId]);
}

// ─── Scenario 3: Store credit race ──────────────────────────────────────

async function testStoreCreditRace() {
  const custId = crypto.randomUUID();
  await orgTx(async (c) => {
    await c.query(
      `INSERT INTO customers (id, organization_id, first_name, last_name, email,
                              store_credit_balance, loyalty_points, total_spend, visit_count,
                              is_active, created_at, updated_at)
       VALUES ($1, $2, 'Race', 'Test', 'race-' || LEFT($1::uuid::text, 8) || '@test.local',
               100.00, 0, 0, 0, true, NOW(), NOW())`,
      [custId, ORG],
    );
  });

  const deduct = async (amount) => {
    try {
      return await orgTx(async (c) => {
        const { rows } = await c.query(
          `SELECT store_credit_balance FROM customers WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [custId, ORG],
        );
        const cur = Number(rows[0].store_credit_balance);
        if (cur < amount) return { status: "rejected" };
        await c.query(
          `UPDATE customers SET store_credit_balance = store_credit_balance - $1, updated_at = NOW()
           WHERE id = $2 AND organization_id = $3`,
          [amount, custId, ORG],
        );
        return { status: "accepted" };
      });
    } catch (e) {
      return { status: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, 80) };
    }
  };

  const [a, b] = await Promise.all([deduct(60), deduct(60)]);
  const { rows: post } = await pool.query(
    `SELECT store_credit_balance FROM customers WHERE id = $1`,
    [custId],
  );
  const accepted = [a, b].filter((r) => r.status === "accepted").length;
  const finalBal = Number(post[0].store_credit_balance);
  record(
    "store credit: concurrent $60 deducts on $100 balance — exactly one succeeds",
    accepted === 1 && finalBal === 40,
    `accepted=${accepted}, final balance=${finalBal} (expected 40, not -20)`,
  );

  await pool.query(`DELETE FROM customers WHERE id = $1`, [custId]);
}

// ─── Scenario 4: Shift double-close ─────────────────────────────────────

async function testShiftDoubleClose() {
  const shiftId = crypto.randomUUID();
  const openedAt = new Date(Date.now() - 60_000).toISOString();
  await orgTx(async (c) => {
    // Need a register_session referencing this shift? actually shifts table
    // has a FK on register_session_id. Pass NULL is allowed per schema.
    await c.query(
      `INSERT INTO shifts (id, organization_id, location_id, employee_id,
                           register_session_id, opening_float, opened_at,
                           status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, 100.00, $5, 'open', NOW(), NOW())`,
      [shiftId, ORG, LOCATION, EMPLOYEE, openedAt],
    );
  });

  // Mirror shift-report POST's tx body: lock the row WHERE status='open',
  // if zero rows → already closed.
  const close = async (declaredCash) => {
    try {
      return await orgTx(async (c) => {
        const { rows } = await c.query(
          `SELECT id, status FROM shifts WHERE id = $1 AND status = 'open' FOR UPDATE`,
          [shiftId],
        );
        if (rows.length === 0) return { status: "rejected", reason: "already closed" };
        // Simulate the actual close time (computing expectedCash is omitted
        // because we care about the lock semantics, not the arithmetic).
        await c.query(
          `UPDATE shifts SET status = 'closed', closed_at = NOW(), closing_expected_cash = 100,
           closing_declared_cash = $1::numeric, closing_variance = $1::numeric - 100, updated_at = NOW()
           WHERE id = $2`,
          [declaredCash, shiftId],
        );
        return { status: "accepted" };
      });
    } catch (e) {
      return { status: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, 80) };
    }
  };

  const [a, b] = await Promise.all([close(100), close(90)]);
  const { rows: post } = await pool.query(
    `SELECT status, closing_declared_cash FROM shifts WHERE id = $1`,
    [shiftId],
  );
  const accepted = [a, b].filter((r) => r.status === "accepted").length;
  const errors = [a, b].filter((r) => r.status === "error");
  record(
    "shift double-close: two concurrent closes — exactly one commits",
    accepted === 1 && post[0].status === "closed",
    `accepted=${accepted}, errors=${errors.length}, status=${post[0].status}, declared=${post[0].closing_declared_cash}. ${errors.length ? "err[0]: " + errors[0].error : ""}`,
  );

  await pool.query(`DELETE FROM shifts WHERE id = $1`, [shiftId]);
}

// ─── Scenario 5: Concurrent pay_in (should both succeed, different rows) ──

async function testConcurrentPayIn() {
  const shiftId = crypto.randomUUID();
  await orgTx(async (c) => {
    await c.query(
      `INSERT INTO shifts (id, organization_id, location_id, employee_id,
                           register_session_id, opening_float, opened_at,
                           status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, 100.00, NOW(), 'open', NOW(), NOW())`,
      [shiftId, ORG, LOCATION, EMPLOYEE],
    );
  });

  const payIn = async (amount) => {
    try {
      return await orgTx(async (c) => {
        // Matches cash-drawer pay_in path: lock the shift, then insert row.
        const shift = await c.query(
          `SELECT id FROM shifts WHERE id = $1 AND status = 'open' FOR UPDATE`,
          [shiftId],
        );
        if (shift.rows.length === 0) return { status: "rejected" };
        await c.query(
          `INSERT INTO pay_in_outs (id, shift_id, location_id, employee_id,
                                    direction, amount, reason, organization_id, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'pay_in', $4, 'test', $5, NOW())`,
          [shiftId, LOCATION, EMPLOYEE, amount, ORG],
        );
        return { status: "accepted" };
      });
    } catch (e) {
      return { status: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, 80) };
    }
  };

  const [a, b] = await Promise.all([payIn(10), payIn(20)]);
  const { rows: post } = await pool.query(
    `SELECT COUNT(*)::int AS c, COALESCE(SUM(amount), 0)::numeric AS total
     FROM pay_in_outs WHERE shift_id = $1 AND direction = 'pay_in'`,
    [shiftId],
  );
  const accepted = [a, b].filter((r) => r.status === "accepted").length;
  record(
    "concurrent pay_in: both commit as separate rows (no lost update)",
    accepted === 2 && post[0].c === 2 && Number(post[0].total) === 30,
    `accepted=${accepted}, rows=${post[0].c}, total=${post[0].total}`,
  );

  // Cleanup
  await pool.query(`DELETE FROM pay_in_outs WHERE shift_id = $1`, [shiftId]);
  await pool.query(`DELETE FROM shifts WHERE id = $1`, [shiftId]);
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("─── Concurrent same-entity tests ──────────────────────────");
  await testPromoBoundaryRace();
  await testGiftCardBalanceRace();
  await testStoreCreditRace();
  await testShiftDoubleClose();
  await testConcurrentPayIn();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log();
  console.log(`${passed}/${results.length} passed, ${failed} failed`);

  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
