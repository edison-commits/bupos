/**
 * BuPOS Customer Management API
 * @tags customers
 */
import { NextRequest, NextResponse } from 'next/server';
import { orgQuery } from '@/lib/db';
import { withAdminAuth } from '@/lib/api/with-auth';
import { pgInsertAuditEvent } from '@/lib/persistence/postgres-store';
import { validateBody, customerCreateSchema, customerUpdateSchema } from '@/lib/validation/schemas';
import { checkRateLimit } from '@/lib/auth/rate-limit';

export const GET = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId } = ctx;

  // Escape SQL LIKE wildcards in search so % and _ are treated as literal characters
  const rawSearch = request.nextUrl.searchParams.get('search')?.trim() || '';
  const search = rawSearch.replace(/[%_\\]/g, '\\$&');
  const id = request.nextUrl.searchParams.get('id')?.trim() || '';
  const statsOnly = request.nextUrl.searchParams.get('stats')?.trim() === 'true';
  const pageSizeRaw = parseInt(request.nextUrl.searchParams.get('pageSize') || '50', 10);
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(100, pageSizeRaw) : 50;
  const cursorParam = request.nextUrl.searchParams.get('cursor')?.trim() || null;
  let cursorUpdatedAt: string | null = null;
  let cursorId: string | null = null;
  if (cursorParam) {
    try {
      const decoded = JSON.parse(Buffer.from(cursorParam, 'base64').toString('utf-8'));
      cursorUpdatedAt = decoded.updated_at ?? null;
      cursorId = decoded.id ?? null;
    } catch {
      // Invalid cursor — ignore
    }
  }

  // Stats-only mode: return aggregate stats without fetching customer rows
  if (statsOnly) {
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const searchWhere = search
        ? ` AND (first_name ILIKE $2 OR last_name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)`
        : '';
      const searchVal = search ? [`%${search}%`] : [];

      const [statsRes] = await Promise.all([
        orgQuery(
          orgId,
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE created_at >= $3)::int AS new_this_month,
             COALESCE(AVG(total_spend) FILTER (WHERE total_spend IS NOT NULL), 0)::numeric AS avg_spend,
             COALESCE(SUM(loyalty_points), 0)::bigint AS total_points
           FROM customers
           WHERE organization_id = $1${searchWhere}`,
          [orgId, ...searchVal, monthStart]
        ),
      ]);
      const s = statsRes.rows[0];
      return NextResponse.json({
        total: s.total,
        newThisMonth: s.new_this_month,
        avgSpend: Number(s.avg_spend) || 0,
        totalPointsOutstanding: Number(s.total_points) || 0,
      });
    } catch (error) {
      console.error('Customers stats error:', error);
      return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
    }
  }

  try {
    // Single customer detail with purchase history
    if (id) {
      const [customerRes, transactionsRes, statsRes] = await Promise.all([
        orgQuery(
          orgId,
          `SELECT id, organization_id, customer_id, total, subtotal, tax_amount, discount_amount, status, created_at FROM customers WHERE id = $1 AND organization_id = $2`,
          [id, orgId]
        ),
        orgQuery(
          orgId,
          `SELECT id, created_at, grand_total, customer_id, employee_id
           FROM transactions
           WHERE customer_id = $1 AND organization_id = $2
           ORDER BY created_at DESC LIMIT 20`,
          [id, orgId]
        ),
        orgQuery(
          orgId,
          `SELECT
             COUNT(*)::int as visit_count,
             COALESCE(SUM(grand_total), 0)::numeric as total_spend
           FROM transactions
           WHERE customer_id = $1 AND organization_id = $2`,
          [id, orgId]
        ),
      ]);

      if (customerRes.rows.length === 0) {
        return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
      }

      const customer = customerRes.rows[0];
      const stats = statsRes.rows[0];

      return NextResponse.json({
        customer: {
          ...customer,
          visit_count: stats.visit_count,
          total_spend: stats.total_spend,
        },
        transactions: transactionsRes.rows,
      });
    }

    // List customers with cursor-based pagination
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (search) {
      conditions.push(`(c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR c.email ILIKE $${idx} OR c.phone ILIKE $${idx})`);
      values.push(`%${search}%`);
      idx++;
    }

    // Cursor: (updated_at, id) < (cursor_updated_at, cursor_id) for descending order
    if (cursorUpdatedAt !== null && cursorId !== null) {
      conditions.push(`(c.updated_at, c.id) < ($${idx}, $${idx + 1})`);
      values.push(cursorUpdatedAt, cursorId);
      idx += 2;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Fetch pageSize + 1 to determine if there's a next page
    const dataRes = await orgQuery(
      orgId,
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.address,
        c.loyalty_points, c.total_spend, c.visit_count, c.store_credit_balance,
        c.is_active, c.created_at, c.updated_at
        FROM customers c
        ${whereClause}
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT $${idx}`,
      [...values, pageSize + 1],
    );

    const hasMore = dataRes.rows.length > pageSize;
    const customers = hasMore ? dataRes.rows.slice(0, pageSize) : dataRes.rows;

    let nextCursor: string | null = null;
    if (hasMore && customers.length > 0) {
      const last = customers[customers.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ id: last.id, updated_at: last.updated_at })).toString("base64");
    }

    return NextResponse.json({
      customers,
      nextCursor,
      hasMore,
    });
  } catch (error) {
    console.error('Customers GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch customers' }, { status: 500 });
  }
});

export const POST = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId, employee } = ctx;
  const rl = checkRateLimit(`customers:post:${orgId}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  try {
    const body = await request.json();
    const v = validateBody(customerCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { first_name, last_name, email, phone, address, notes } = v.data;

    const { rows } = await orgQuery(
      orgId,
      `INSERT INTO customers (first_name, last_name, email, phone, address, notes, loyalty_points, total_spend, visit_count, store_credit_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0)
       RETURNING *`,
      [first_name.trim(), last_name.trim(), email?.trim() || null, phone?.trim() || null, address?.trim() || null, notes?.trim() || null],
    );
    return NextResponse.json({ customer: rows[0] }, { status: 201 });
  } catch (error) {
    console.error('Customers POST error:', error);
    return NextResponse.json({ error: 'Failed to create customer' }, { status: 500 });
  }
});

export const PUT = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId, employee } = ctx;
  const rl = checkRateLimit(`customers:put:${orgId}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  try {
    const body = await request.json();
    const v = validateBody(customerUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id, first_name, last_name, email, phone, address, notes, is_active } = v.data;

    const { rows } = await orgQuery(
      orgId,
      `UPDATE customers
       SET first_name = $1, last_name = $2, email = $3, phone = $4, address = $5, notes = $6, is_active = $7, updated_at = NOW()
       WHERE id = $8 AND organization_id = $9
       RETURNING *`,
      [first_name?.trim() || null, last_name?.trim() || null, email?.trim() || null, phone?.trim() || null, address?.trim() || null, notes?.trim() || null, is_active ?? true, id, orgId],
    );
    if (rows.length === 0) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    const customer = rows[0];
    pgInsertAuditEvent(
      orgId, null, employee.id,
      "customer", id, "customer_updated",
      { id, first_name: customer.first_name, last_name: customer.last_name },
    ).catch((err) => console.error("[audit] Failed to insert audit event:", err));
    return NextResponse.json({ customer }, { status: 200 });
  } catch (error) {
    console.error('Customers PUT error:', error);
    return NextResponse.json({ error: 'Failed to update customer' }, { status: 500 });
  }
});
