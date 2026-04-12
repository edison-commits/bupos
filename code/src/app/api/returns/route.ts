/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { orgQuery, orgTx } from '@/lib/db';
import { withDualAuth, withAdminAuth } from '@/lib/api/with-auth';
import { validateBody, returnCreateSchema, returnUpdateSchema } from '@/lib/validation/schemas';

export const runtime = "edge";

/**
 * Returns API
 * GET  - List all returns (paginated)
 * POST - Create a new return with line items
 * PUT  - Update status (approve/complete/reject). On complete with restock, updates inventory.
 */
export const GET = withDualAuth("audit.view", async (request, ctx) => {
  const { orgId } = ctx;
  const pageRaw = parseInt(request.nextUrl.searchParams.get('page') ?? '1', 10);
  const pageSizeRaw = parseInt(request.nextUrl.searchParams.get('pageSize') ?? '20', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(100, pageSizeRaw) : 20;
  const offset = (page - 1) * pageSize;
  try {
    const [countResult, { rows }] = await Promise.all([
      orgQuery(
        orgId,
        `SELECT COUNT(*)::int as total FROM returns WHERE organization_id = $1`,
        [orgId],
      ),
      orgQuery(
        orgId,
        `SELECT r.*,
        l.name as location_name,
        COUNT(rl.id)::int as line_count,
        COALESCE(SUM(rl.quantity), 0)::int as total_items
      FROM returns r
      JOIN locations l ON r.location_id = l.id
      LEFT JOIN return_lines rl ON r.id = rl.return_id
      WHERE r.organization_id = $1
      GROUP BY r.id, l.name
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3`,
        [orgId, pageSize, offset],
      ),
    ]);
    const total = countResult.rows[0]?.total ?? 0;
    return NextResponse.json({ returns: rows, total, page });
  } catch (error) {
    console.error('Returns GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch returns' }, { status: 500 });
  }
});

export const POST = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(returnCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { customer_name, reason, notes, refund_method, lines } = v.data;

    const locationId = ctx.employee.locationIds?.[0];

    // Generate return number: RET-BEL-YYMMDD-NNN — retry loop handles concurrent collision
    const { rows: locRows } = await orgQuery(orgId, 'SELECT name FROM locations WHERE id = $1', [locationId]);
    const locCode = (locRows[0]?.name || 'STR').slice(0, 3).toUpperCase();
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    // Calculate refund amount upfront (needed before the insert)
    const refundAmount = lines.reduce((sum: number, l: { quantity: number; unit_price: number }) =>
      sum + (l.quantity * l.unit_price), 0);

    const returnId = crypto.randomUUID();
    let returnNumber = '';
    let retRows: any = null;

    // Retry loop: count → generate → insert; on duplicate key, re-count and retry
    for (let attempt = 0; attempt < 5; attempt++) {
      const { rows: countRows } = await orgQuery(
        orgId,
        `SELECT COUNT(*)::int as cnt FROM returns WHERE organization_id = $1 AND return_number LIKE $2`,
        [orgId, `RET-${locCode}-${dateStr}-%`],
      );
      const seq = (countRows[0].cnt || 0) + 1;
      returnNumber = `RET-${locCode}-${dateStr}-${String(seq).padStart(3, '0')}`;
      try {
        retRows = await orgQuery(
          orgId,
          `INSERT INTO returns (id, organization_id, location_id, return_number, customer_name, reason, notes, refund_method, refund_amount, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
           RETURNING *`,
          [returnId, orgId, locationId, returnNumber, customer_name || null, reason || 'other', notes || null, refund_method || 'store_credit', refundAmount],
        );
        break;
      } catch (e) {
        if (!(e instanceof Error && (e.message.includes('duplicate key') || e.message.includes('23505')))) throw e;
        // collision — retry with fresh count
      }
    }
    if (!retRows) {
      return NextResponse.json({ error: 'Failed to generate unique return number' }, { status: 500 });
    }

    for (const line of lines) {
      await orgQuery(
        orgId,
        `INSERT INTO return_lines (return_id, product_variant_id, quantity, unit_price, restock)
         VALUES ($1, $2, $3, $4, $5)`,
        [returnId, line.product_variant_id, line.quantity || 1, line.unit_price || 0, true],
      );
    }

    return NextResponse.json({ return: retRows[0], return_number: returnNumber }, { status: 201 });
  } catch (error) {
    console.error('Returns POST error:', error);
    return NextResponse.json({ error: 'Failed to create return' }, { status: 500 });
  }
});

export const PUT = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(returnUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id, status, processed_by } = v.data;

    const client = await orgTx(orgId);
    try {
      const { rows: ret } = await client.query(
        `SELECT id, status, location_id FROM returns WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (ret.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: 'Return not found' }, { status: 404 });
      }
      if (status === 'completed' && ret[0].status === 'completed') {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: 'Return already completed' }, { status: 409 });
      }

      if (status === 'completed' && ret[0].status !== 'completed') {
        const { rows: lines } = await client.query(
          `SELECT product_variant_id, quantity
           FROM return_lines
           WHERE return_id = $1 AND restock = true`,
          [id],
        );

        for (const line of lines) {
          await client.query(
            `UPDATE inventory_levels
             SET on_hand = on_hand + $1, received_at = NOW(), updated_at = NOW()
             WHERE product_variant_id = $2 AND location_id = $3`,
            [line.quantity, line.product_variant_id, ret[0].location_id],
          );
        }
      }

      const { rows } = await client.query(
        `UPDATE returns SET status = $1, processed_by = $2 WHERE id = $3 RETURNING *`,
        [status, processed_by || null, id],
      );
      await client.query("COMMIT");
      return NextResponse.json({ return: rows[0] }, { status: 200 });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Returns PUT error:', error);
    return NextResponse.json({ error: 'Failed to update return' }, { status: 500 });
  }
});
