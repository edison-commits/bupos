import { NextRequest, NextResponse } from "next/server";
import { orgQuery, orgTx } from "@/lib/db";
import { randomUUID } from "node:crypto";

const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";

/**
 * GET /api/store-credit
 *
 * Query params:
 *   customer — customer ID (returns balance + ledger for that customer)
 *   page     — page number (default 1)
 *   limit    — results per page (default 50)
 *
 * Without customer param returns all customers with credit + summary.
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const customerId = sp.get("customer");

    if (customerId) {
      // Single customer balance + ledger
      const customer = await orgQuery(
        ORG_ID,
        `SELECT id, first_name, last_name, email, phone, store_credit_balance
         FROM customers WHERE id = $1`,
        [customerId],
      );
      if (customer.rows.length === 0) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }

      const ledger = await orgQuery(
        ORG_ID,
        `SELECT scl.*, e.display_name AS employee_name
         FROM store_credit_ledger scl
         LEFT JOIN employees e ON e.id = scl.employee_id
         WHERE scl.customer_id = $1
         ORDER BY scl.created_at DESC`,
        [customerId],
      );

      return NextResponse.json({
        customer: customer.rows[0],
        ledger: ledger.rows,
      });
    }

    // All customers with store credit
    const customers = await orgQuery(
      ORG_ID,
      `SELECT id, first_name, last_name, email, phone, store_credit_balance
       FROM customers
       WHERE store_credit_balance > 0
       ORDER BY store_credit_balance DESC`,
      [],
    );

    const summary = await orgQuery(
      ORG_ID,
      `SELECT
         COALESCE(SUM(store_credit_balance), 0)::numeric AS total_outstanding,
         COUNT(*) FILTER (WHERE store_credit_balance > 0)::int AS customers_with_credit,
         COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'issuance'), 0)::numeric AS total_issued,
         COALESCE(SUM(ABS(amount)) FILTER (WHERE transaction_type = 'redemption'), 0)::numeric AS total_redeemed
       FROM customers
       LEFT JOIN store_credit_ledger ON customers.id = store_credit_ledger.customer_id`,
      [],
    );

    const recentLedger = await orgQuery(
      ORG_ID,
      `SELECT scl.*, e.display_name AS employee_name,
              c.first_name || ' ' || c.last_name AS customer_name
       FROM store_credit_ledger scl
       LEFT JOIN employees e ON e.id = scl.employee_id
       LEFT JOIN customers c ON c.id = scl.customer_id
       ORDER BY scl.created_at DESC
       LIMIT 50`,
      [],
    );

    return NextResponse.json({
      customers: customers.rows,
      summary: summary.rows[0],
      recentLedger: recentLedger.rows,
    });
  } catch (err) {
    console.error("GET /api/store-credit error:", err);
    return NextResponse.json({ error: "Failed to fetch store credit" }, { status: 500 });
  }
}

/**
 * POST /api/store-credit
 *
 * Body: { customerId, amount, reason, employeeId, approvedBy? }
 *
 * Issues store credit to a customer. Amount must be positive.
 */
export async function POST(req: NextRequest) {
  try {
    const { customerId, amount, reason, employeeId, approvedBy } = await req.json();

    if (!customerId || !amount || amount <= 0 || !reason) {
      return NextResponse.json({ error: "Customer ID, positive amount, and reason required" }, { status: 400 });
    }

    const client = await orgTx(ORG_ID);
    try {
      // Update customer balance
      const updated = await client.query(
        `UPDATE customers SET store_credit_balance = store_credit_balance + $1, updated_at = now()
         WHERE id = $2
         RETURNING store_credit_balance`,
        [amount, customerId],
      );
      if (updated.rows.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }

      const newBalance = updated.rows[0].store_credit_balance;

      // Insert ledger entry
      const entryId = randomUUID();
      await client.query(
        `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, reason, approved_by, created_at)
         VALUES ($1, $2, $3, 'issuance', $4, $5, $6, $7, $8, now())`,
        [entryId, ORG_ID, customerId, amount, newBalance, employeeId || null, reason, approvedBy || null],
      );

      await client.query("COMMIT");
      return NextResponse.json({ id: entryId, customerId, newBalance, amount }, { status: 201 });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("POST /api/store-credit error:", err);
    return NextResponse.json({ error: "Failed to issue store credit" }, { status: 500 });
  }
}
