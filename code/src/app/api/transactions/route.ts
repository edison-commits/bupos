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
 *   cursor   — base64(JSON.stringify({ id, created_at })) for cursor-based pagination
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

    // ── Transaction list / search with cursor-based pagination ──
    const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 50));
    const cursorParam = sp.get("cursor");
    let cursorId: string | null = null;
    let cursorCreatedAt: string | null = null;

    if (cursorParam) {
      try {
        const decoded = JSON.parse(Buffer.from(cursorParam, "base64").toString("utf-8"));
        cursorId = decoded.id ?? null;
        cursorCreatedAt = decoded.created_at ?? null;
      } catch {
        // Invalid cursor — ignore and start from beginning
      }
    }

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

    // Cursor-based pagination: (created_at, id) < (cursor_created_at, cursor_id)
    // to get rows "before" the cursor in descending order
    if (cursorCreatedAt !== null && cursorId !== null) {
      idx++;
      conditions.push(`(t.created_at, t.id) < ($${idx}, $${idx + 1})`);
      values.push(cursorCreatedAt, cursorId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Fetch limit + 1 to determine if there's a next page
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
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $${idx + 1}`,
      [...values, limit + 1],
    );

    const hasMore = rows.rows.length > limit;
    const transactions = hasMore ? rows.rows.slice(0, limit) : rows.rows;

    let nextCursor: string | null = null;
    if (hasMore && transactions.length > 0) {
      const last = transactions[transactions.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ id: last.id, created_at: last.created_at })).toString("base64");
    }

    return NextResponse.json({
      transactions,
      nextCursor,
      hasMore,
    });
  } catch (err) {
    console.error("GET /api/transactions error:", err);
    return NextResponse.json({ error: "Failed to fetch transactions" }, { status: 500 });
  }
}
