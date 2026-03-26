import { NextRequest, NextResponse } from "next/server";
import { orgQuery, orgTx } from "@/lib/db";
import { randomUUID } from "node:crypto";

const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";

/**
 * GET /api/gift-cards
 *
 * Query params:
 *   code   — lookup single card by code (for register use)
 *   id     — lookup single card by ID (with transaction history)
 *   status — filter by status (active, depleted, disabled, expired)
 *
 * Without params returns all gift cards with summary stats.
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;

    // ── Lookup by code (register) ──
    const code = sp.get("code");
    if (code) {
      const result = await orgQuery(
        ORG_ID,
        `SELECT gc.*, c.first_name || ' ' || c.last_name AS customer_name
         FROM gift_cards gc
         LEFT JOIN customers c ON c.id = gc.customer_id
         WHERE LOWER(gc.code) = LOWER($1)`,
        [code],
      );
      if (result.rows.length === 0) {
        return NextResponse.json({ error: "Gift card not found" }, { status: 404 });
      }
      return NextResponse.json({ giftCard: result.rows[0] });
    }

    // ── Lookup by ID (with history) ──
    const id = sp.get("id");
    if (id) {
      const card = await orgQuery(
        ORG_ID,
        `SELECT gc.*, c.first_name || ' ' || c.last_name AS customer_name,
                e.display_name AS activated_by_name
         FROM gift_cards gc
         LEFT JOIN customers c ON c.id = gc.customer_id
         LEFT JOIN employees e ON e.id = gc.activated_by
         WHERE gc.id = $1`,
        [id],
      );
      if (card.rows.length === 0) {
        return NextResponse.json({ error: "Gift card not found" }, { status: 404 });
      }

      const history = await orgQuery(
        ORG_ID,
        `SELECT gct.*, e.display_name AS employee_name
         FROM gift_card_transactions gct
         LEFT JOIN employees e ON e.id = gct.employee_id
         WHERE gct.gift_card_id = $1
         ORDER BY gct.created_at DESC`,
        [id],
      );

      return NextResponse.json({ giftCard: card.rows[0], history: history.rows });
    }

    // ── List all ──
    const status = sp.get("status");
    const where = status ? "AND gc.status = $1" : "";
    const params = status ? [status] : [];

    const cards = await orgQuery(
      ORG_ID,
      `SELECT gc.*, c.first_name || ' ' || c.last_name AS customer_name,
              e.display_name AS activated_by_name
       FROM gift_cards gc
       LEFT JOIN customers c ON c.id = gc.customer_id
       LEFT JOIN employees e ON e.id = gc.activated_by
       WHERE 1=1 ${where}
       ORDER BY gc.created_at DESC`,
      params,
    );

    // Summary stats
    const stats = await orgQuery(
      ORG_ID,
      `SELECT
         COUNT(*)::int AS total_cards,
         COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
         COALESCE(SUM(balance) FILTER (WHERE status = 'active'), 0)::numeric AS outstanding_balance,
         COALESCE(SUM(initial_balance), 0)::numeric AS total_issued
       FROM gift_cards`,
      [],
    );

    return NextResponse.json({
      giftCards: cards.rows,
      summary: stats.rows[0],
    });
  } catch (err) {
    console.error("GET /api/gift-cards error:", err);
    return NextResponse.json({ error: "Failed to fetch gift cards" }, { status: 500 });
  }
}

/**
 * POST /api/gift-cards
 *
 * Body: { action, ... }
 *   action: "activate" — { code, amount, customerId?, employeeId }
 *   action: "reload"   — { giftCardId, amount, employeeId }
 *   action: "disable"  — { giftCardId }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "activate") {
      const { code, amount, customerId, employeeId } = body;
      if (!code || !amount || amount <= 0) {
        return NextResponse.json({ error: "Code and positive amount required" }, { status: 400 });
      }

      // Check for duplicate code
      const existing = await orgQuery(ORG_ID, `SELECT id FROM gift_cards WHERE LOWER(code) = LOWER($1)`, [code]);
      if (existing.rows.length > 0) {
        return NextResponse.json({ error: `Gift card code "${code}" already exists` }, { status: 409 });
      }

      const client = await orgTx(ORG_ID);
      try {
        const gcId = randomUUID();
        await client.query(
          `INSERT INTO gift_cards (id, organization_id, code, balance, initial_balance, status, customer_id, activated_by, activated_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4, 'active', $5, $6, now(), now(), now())`,
          [gcId, ORG_ID, code, amount, customerId || null, employeeId || null],
        );

        await client.query(
          `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
           VALUES ($1, $2, 'activation', $3, $3, $4, 'New gift card activated', now())`,
          [randomUUID(), gcId, amount, employeeId || null],
        );

        await client.query("COMMIT");
        return NextResponse.json({ id: gcId, code, balance: amount, status: "active" }, { status: 201 });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    if (action === "reload") {
      const { giftCardId, amount, employeeId } = body;
      if (!giftCardId || !amount || amount <= 0) {
        return NextResponse.json({ error: "Gift card ID and positive amount required" }, { status: 400 });
      }

      const client = await orgTx(ORG_ID);
      try {
        const gc = await client.query(`SELECT * FROM gift_cards WHERE id = $1 FOR UPDATE`, [giftCardId]);
        if (gc.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Gift card not found" }, { status: 404 });
        }
        const card = gc.rows[0];
        if (card.status === "disabled" || card.status === "expired") {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: `Cannot reload ${card.status} gift card` }, { status: 400 });
        }

        const newBalance = Number(card.balance) + amount;
        await client.query(
          `UPDATE gift_cards SET balance = $1, status = 'active', updated_at = now() WHERE id = $2`,
          [newBalance, giftCardId],
        );

        await client.query(
          `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
           VALUES ($1, $2, 'reload', $3, $4, $5, 'Gift card reloaded', now())`,
          [randomUUID(), giftCardId, amount, newBalance, employeeId || null],
        );

        await client.query("COMMIT");
        return NextResponse.json({ id: giftCardId, balance: newBalance, status: "active" });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    if (action === "disable") {
      const { giftCardId } = body;
      if (!giftCardId) {
        return NextResponse.json({ error: "Gift card ID required" }, { status: 400 });
      }

      await orgQuery(
        ORG_ID,
        `UPDATE gift_cards SET status = 'disabled', updated_at = now() WHERE id = $1`,
        [giftCardId],
      );
      return NextResponse.json({ id: giftCardId, status: "disabled" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("POST /api/gift-cards error:", err);
    return NextResponse.json({ error: "Failed to process gift card action" }, { status: 500 });
  }
}
