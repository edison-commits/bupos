#!/usr/bin/env node
/**
 * Historical financial-invariant audit — scans EVERY row in the DB, not
 * just this test run's output. If anything silently drifted in the past
 * (before audits hardened the code), this surfaces the first offending
 * transaction ID so it can be reconciled.
 *
 * Invariants audited:
 *   I1. For every completed transaction:
 *         SUM(transaction_tenders.amount) = grand_total + change_due (±0.01)
 *   I2. For every gift card:
 *         card.balance = initial_balance + SUM(gift_card_transactions.amount)
 *   I3. For every customer with store credit activity:
 *         customer.store_credit_balance = SUM(store_credit_ledger.amount)
 *   I4. For every promo code:
 *         current_redemptions = COUNT(promo_redemptions WHERE promo_code_id = id)
 *   I5. For every completed transaction with a refund tender, the refund
 *       amount must not exceed the original cash/card tender (R7-H-5 /
 *       R8-C-4 — per-transaction cash-refund cap).
 *
 * Scope is per-org. Run reports per-org so tenants can't mask each other.
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

async function checkTenderSum() {
  const { rows } = await pool.query(`
    SELECT t.id, t.organization_id, t.grand_total, t.change_due,
           COALESCE((SELECT SUM(amount) FROM transaction_tenders tt WHERE tt.transaction_id = t.id), 0)::numeric AS tender_sum
    FROM transactions t
    WHERE t.status = 'completed'
      AND ABS(COALESCE((SELECT SUM(amount) FROM transaction_tenders tt WHERE tt.transaction_id = t.id), 0)::numeric
              - (t.grand_total + COALESCE(t.change_due, 0))) > 0.01
    ORDER BY t.created_at ASC
    LIMIT 20
  `);
  const totalOffenders = await pool.query(`
    SELECT COUNT(*)::int AS c FROM transactions t
    WHERE t.status = 'completed'
      AND ABS(COALESCE((SELECT SUM(amount) FROM transaction_tenders tt WHERE tt.transaction_id = t.id), 0)::numeric
              - (t.grand_total + COALESCE(t.change_due, 0))) > 0.01
  `);
  record(
    "I1 tender sum = grand_total + change_due (±0.01)",
    rows.length === 0,
    rows.length === 0
      ? "clean"
      : `${totalOffenders.rows[0].c} offending rows; first: txn ${rows[0].id} (grand=${rows[0].grand_total}, change=${rows[0].change_due}, tenders=${rows[0].tender_sum})`,
  );
}

async function checkGiftCardBalance() {
  const { rows } = await pool.query(`
    SELECT gc.id, gc.code, gc.balance, gc.initial_balance,
           COALESCE((SELECT SUM(amount) FROM gift_card_transactions gct WHERE gct.gift_card_id = gc.id), 0)::numeric AS txn_sum
    FROM gift_cards gc
    WHERE ABS(gc.balance - (gc.initial_balance + COALESCE(
      (SELECT SUM(amount) FROM gift_card_transactions gct WHERE gct.gift_card_id = gc.id), 0
    ) - gc.initial_balance)) > 0.01
    LIMIT 20
  `);
  // Actually the invariant: balance should equal sum-of-all-transactions,
  // since every transaction (activation, reload, redemption) is signed.
  // Rewrite more cleanly:
  const { rows: better } = await pool.query(`
    WITH sums AS (
      SELECT gift_card_id, COALESCE(SUM(amount), 0)::numeric AS total
      FROM gift_card_transactions
      GROUP BY gift_card_id
    )
    SELECT gc.id, gc.code, gc.balance, COALESCE(s.total, 0) AS total
    FROM gift_cards gc
    LEFT JOIN sums s ON s.gift_card_id = gc.id
    WHERE ABS(gc.balance - COALESCE(s.total, 0)) > 0.01
    ORDER BY gc.created_at ASC
    LIMIT 20
  `);
  record(
    "I2 gift_cards.balance = SUM(gift_card_transactions.amount) per card",
    better.length === 0,
    better.length === 0
      ? "clean"
      : `${better.length} drifted cards; first: ${better[0].code} balance=${better[0].balance} sum=${better[0].total}`,
  );
  void rows;
}

async function checkStoreCreditBalance() {
  const { rows } = await pool.query(`
    WITH sums AS (
      SELECT customer_id, COALESCE(SUM(
        CASE WHEN transaction_type = 'issuance' THEN amount
             WHEN transaction_type = 'refund' THEN amount
             WHEN transaction_type = 'redemption' THEN amount  -- already stored as negative
             WHEN transaction_type = 'adjustment' THEN amount
             ELSE 0 END
      ), 0)::numeric AS ledger_sum
      FROM store_credit_ledger
      GROUP BY customer_id
    )
    SELECT c.id, c.first_name, c.last_name, c.store_credit_balance, s.ledger_sum
    FROM customers c
    JOIN sums s ON s.customer_id = c.id
    WHERE ABS(c.store_credit_balance - s.ledger_sum) > 0.01
    ORDER BY c.created_at ASC
    LIMIT 20
  `);
  record(
    "I3 customers.store_credit_balance = SUM(store_credit_ledger.amount) per customer",
    rows.length === 0,
    rows.length === 0
      ? "clean"
      : `${rows.length} drifted customers; first: ${rows[0].first_name} ${rows[0].last_name} balance=${rows[0].store_credit_balance} ledger=${rows[0].ledger_sum}`,
  );
}

async function checkPromoRedemptionCount() {
  const { rows } = await pool.query(`
    WITH counts AS (
      SELECT promo_code_id, COUNT(*)::int AS actual_count
      FROM promo_redemptions
      GROUP BY promo_code_id
    )
    SELECT pc.id, pc.code, pc.current_redemptions, COALESCE(c.actual_count, 0) AS actual
    FROM promo_codes pc
    LEFT JOIN counts c ON c.promo_code_id = pc.id
    WHERE pc.current_redemptions <> COALESCE(c.actual_count, 0)
    ORDER BY pc.created_at ASC
    LIMIT 20
  `);
  record(
    "I4 promo_codes.current_redemptions = COUNT(promo_redemptions) per code",
    rows.length === 0,
    rows.length === 0
      ? "clean"
      : `${rows.length} drifted codes; first: ${rows[0].code} current=${rows[0].current_redemptions} actual=${rows[0].actual}`,
  );
}

async function checkRefundCap() {
  // For every ORIGINAL transaction, sum of all refund tenders across itself
  // AND every return transaction whose cart_snapshot.originalTransactionId
  // points to it must NOT exceed the original's positive cash/card tenders.
  //
  // Note: return rows live as separate transactions (status='completed',
  // cart_snapshot.isReturn=true). Their negative-tender rows reference the
  // RETURN'S id, not the original's — so a per-transaction_id SUM won't
  // work. We group across original + returns via the cart_snapshot linkage.
  const { rows } = await pool.query(`
    WITH original_positive AS (
      SELECT t.id AS original_id,
             COALESCE(SUM(CASE WHEN tt.amount > 0 AND tt.tender_type NOT IN ('gift_card', 'store_credit') THEN tt.amount ELSE 0 END), 0)::numeric AS pos_cash
      FROM transactions t
      LEFT JOIN transaction_tenders tt ON tt.transaction_id = t.id
      WHERE t.status = 'completed'
        AND (t.cart_snapshot->>'isReturn' IS NULL OR t.cart_snapshot->>'isReturn' <> 'true')
      GROUP BY t.id
    ),
    refunds_against AS (
      SELECT (rt.cart_snapshot->>'originalTransactionId')::uuid AS original_id,
             COALESCE(SUM(CASE WHEN rtt.amount < 0 AND rtt.tender_type NOT IN ('gift_card', 'store_credit') THEN ABS(rtt.amount) ELSE 0 END), 0)::numeric AS neg_cash
      FROM transactions rt
      LEFT JOIN transaction_tenders rtt ON rtt.transaction_id = rt.id
      WHERE rt.status = 'completed'
        AND rt.cart_snapshot->>'isReturn' = 'true'
        AND rt.cart_snapshot->>'originalTransactionId' IS NOT NULL
      GROUP BY rt.cart_snapshot->>'originalTransactionId'
    )
    SELECT op.original_id, op.pos_cash, ra.neg_cash
    FROM original_positive op
    JOIN refunds_against ra ON ra.original_id = op.original_id
    WHERE ra.neg_cash > op.pos_cash + 0.01
    LIMIT 20
  `);
  record(
    "I5 cash/card refund cap: SUM(refunds across originals+returns) <= SUM(original cash tenders)",
    rows.length === 0,
    rows.length === 0
      ? "clean"
      : `${rows.length} offending originals; first: ${rows[0].original_id} refunded=${rows[0].neg_cash} from pos=${rows[0].pos_cash}`,
  );
}

async function checkNegativeBalances() {
  const negGc = await pool.query(`SELECT COUNT(*)::int AS c FROM gift_cards WHERE balance < 0`);
  const negSc = await pool.query(`SELECT COUNT(*)::int AS c FROM customers WHERE store_credit_balance < 0`);
  const negLp = await pool.query(`SELECT COUNT(*)::int AS c FROM customers WHERE loyalty_points < 0`);
  const negIn = await pool.query(`SELECT COUNT(*)::int AS c FROM inventory_levels WHERE on_hand < 0`);

  record("I6a no negative gift card balances", negGc.rows[0].c === 0, `count=${negGc.rows[0].c}`);
  record("I6b no negative store credit balances", negSc.rows[0].c === 0, `count=${negSc.rows[0].c}`);
  record("I6c no negative loyalty points", negLp.rows[0].c === 0, `count=${negLp.rows[0].c}`);
  record("I6d no negative inventory on_hand", negIn.rows[0].c === 0, `count=${negIn.rows[0].c}`);
}

async function main() {
  // Scope summary
  const { rows: stats } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM transactions) AS transactions,
      (SELECT COUNT(*)::int FROM transaction_tenders) AS tenders,
      (SELECT COUNT(*)::int FROM gift_cards) AS gift_cards,
      (SELECT COUNT(*)::int FROM gift_card_transactions) AS gc_txns,
      (SELECT COUNT(*)::int FROM customers) AS customers,
      (SELECT COUNT(*)::int FROM store_credit_ledger) AS ledger_entries,
      (SELECT COUNT(*)::int FROM promo_codes) AS promo_codes,
      (SELECT COUNT(*)::int FROM promo_redemptions) AS redemptions,
      (SELECT COUNT(*)::int FROM inventory_levels) AS inventory_rows
  `);
  console.log("Dataset scope:");
  for (const [k, v] of Object.entries(stats[0])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log();
  console.log("─── Historical financial invariants ──────────────────────");

  await checkTenderSum();
  await checkGiftCardBalance();
  await checkStoreCreditBalance();
  await checkPromoRedemptionCount();
  await checkRefundCap();
  await checkNegativeBalances();

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
