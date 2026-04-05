import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";

/**
 * BuPOS Transaction History API
 * @tags transactions
 *
 * GET /api/transactions
 *
 * Query params:
 *   search   — search by transaction ID prefix or employee name
 *   status   — filter by status (completed, voided, refunded)
 *   tender   — filter by tender_type
 *   from     — start date (ISO)
 *   to       — end date (ISO)
 *   customer — customer ID
 *   page     — page number (default 1)
 *   limit    — results per page (default 50, max 200)
 *   id       — fetch single transaction by ID (returns full detail with tenders/events)
 */
export async function GET(req: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }  if (!adminCtx && !registerCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sp = req.nextUrl.searchParams;

    // ── Single transaction detail ──
    const id = sp.get("id");
    if (id) {
      const txn = await orgQuery(
        orgId,
        `SELECT t.*,
                e.display_name AS employee_name,
                c.first_name || ' ' || c.last_name AS customer_name,
                c.email AS customer_email,
                c.phone AS customer_phone
         FROM transactions t
         LEFT JOIN employees e ON e.id = t.employee_id
         LEFT JOIN customers c ON c.id = t.customer_id
         WHERE t.id = $1`,
        [id],
      );

      if (txn.rows.length === 0) {
        return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
      }

      const tenders = await orgQuery(
        orgId,
        `SELECT * FROM transaction_tenders WHERE transaction_id = $1 ORDER BY created_at`,
        [id],
      );

      const events = await orgQuery(
        orgId,
        `SELECT te.*, e.display_name AS actor_name
         FROM transaction_events te
         LEFT JOIN employees e ON e.id = te.actor_employee_id
         WHERE te.transaction_id = $1
         ORDER BY te.created_at`,
        [id],
      );

      const exceptions = await orgQuery(
        orgId,
        `SELECT tex.*, e.display_name AS approver_name
         FROM transaction_exceptions tex
         LEFT JOIN employees e ON e.id = tex.approved_by
         WHERE tex.transaction_id = $1
         ORDER BY tex.created_at`,
        [id],
      );

      return NextResponse.json({
        transaction: txn.rows[0],
        tenders: tenders.rows,
        events: events.rows,
        exceptions: exceptions.rows,
      });
    }

    // ── Transaction list / search ──
    const page = Math.max(1, Number(sp.get("page")) || 1);
    const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 50));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 0;

    const search = sp.get("search");
    if (search) {
      idx++;
      conditions.push(`(t.id::text ILIKE $${idx} OR e.display_name ILIKE $${idx})`);
      values.push(`%${search}%`);
    }

    const status = sp.get("status");
    if (status) {
      idx++;
      conditions.push(`t.status = $${idx}`);
      values.push(status);
    }

    const tender = sp.get("tender");
    if (tender) {
      idx++;
      conditions.push(`t.tender_type = $${idx}`);
      values.push(tender);
    }

    const from = sp.get("from");
    if (from) {
      idx++;
      conditions.push(`t.created_at >= $${idx}`);
      values.push(from);
    }

    const to = sp.get("to");
    if (to) {
      idx++;
      conditions.push(`t.created_at <= $${idx}`);
      values.push(to);
    }

    const customer = sp.get("customer");
    if (customer) {
      idx++;
      conditions.push(`t.customer_id = $${idx}`);
      values.push(customer);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await orgQuery(
      orgId,
      `SELECT COUNT(*)::int AS total FROM transactions t LEFT JOIN employees e ON e.id = t.employee_id ${whereClause}`,
      values,
    );
    const total = countResult.rows[0]?.total ?? 0;

    const rows = await orgQuery(
      orgId,
      `SELECT t.id, t.status, t.tender_type, t.subtotal, t.discount_total, t.tax_total,
              t.grand_total, t.amount_tendered, t.change_due, t.created_at,
              t.customer_id,
              e.display_name AS employee_name,
              c.first_name || ' ' || c.last_name AS customer_name,
              (SELECT COUNT(*)::int FROM transaction_tenders tt WHERE tt.transaction_id = t.id) AS tender_count
       FROM transactions t
       LEFT JOIN employees e ON e.id = t.employee_id
       LEFT JOIN customers c ON c.id = t.customer_id
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT $${idx + 1} OFFSET $${idx + 2}`,
      [...values, limit, offset],
    );

    const transactions = rows.rows;

    return NextResponse.json({
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("GET /api/transactions error:", err);
    return NextResponse.json({ error: "Failed to fetch transactions" }, { status: 500 });
  }
}
