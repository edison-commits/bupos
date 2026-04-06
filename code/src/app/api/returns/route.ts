import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { orgQuery } from '@/lib/db';
import { requireAdminPermission } from '@/lib/authz';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';
import { BUPOS_LOCATION_ID } from '@/lib/env';

/**
 * Returns API
 * GET  - List all returns (paginated)
 * POST - Create a new return with line items
 * PUT  - Update status (approve/complete/reject). On complete with restock, updates inventory.
 */
export async function GET(request: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
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
}

export async function POST(request: NextRequest) {
  const ctx = await requireAdminPermission('employee.manage');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { customer_name, reason, notes, refund_method, lines } = await request.json();

    if (!lines || lines.length === 0) {
      return NextResponse.json({ error: 'At least one return item is required' }, { status: 400 });
    }

    // Generate return number: RET-BEL-YYMMDD-NNN — retry loop handles concurrent collision
    const { rows: locRows } = await orgQuery(orgId, 'SELECT name FROM locations WHERE id = $1', [BUPOS_LOCATION_ID]);
    const locCode = (locRows[0]?.name || 'STR').slice(0, 3).toUpperCase();
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    // Calculate refund amount upfront (needed before the insert)
    const refundAmount = lines.reduce((sum: number, l: { quantity: number; unit_price: number }) =>
      sum + (l.quantity * l.unit_price), 0);

    const returnId = randomUUID();
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
          [returnId, orgId, BUPOS_LOCATION_ID, returnNumber, customer_name || null, reason || 'other', notes || null, refund_method || 'store_credit', refundAmount],
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
        [returnId, line.product_variant_id, line.quantity || 1, line.unit_price || 0, line.restock !== false],
      );
    }

    return NextResponse.json({ return: retRows[0], return_number: returnNumber }, { status: 201 });
  } catch (error) {
    console.error('Returns POST error:', error);
    return NextResponse.json({ error: 'Failed to create return' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const ctx = await requireAdminPermission('employee.manage');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id, status, processed_by } = await request.json();
    if (!id || !status) return NextResponse.json({ error: 'ID and status required' }, { status: 400 });

    const existingReturnResult = await orgQuery(
      orgId,
      `SELECT id, status FROM returns WHERE id = $1`,
      [id],
    );
    if (existingReturnResult.rows.length === 0) {
      return NextResponse.json({ error: 'Return not found' }, { status: 404 });
    }
    const existingStatus = existingReturnResult.rows[0].status;

    // If completing for the first time, restock items marked for restock
    if (status === 'completed' && existingStatus !== 'completed') {
      const { rows: lines } = await orgQuery(
        orgId,
        `SELECT rl.* FROM return_lines rl
         JOIN returns r ON rl.return_id = r.id
         WHERE r.id = $1 AND rl.restock = true`,
        [id],
      );

      for (const line of lines) {
        await orgQuery(
          orgId,
          `UPDATE inventory_levels SET on_hand = on_hand + $1, received_at = NOW(), updated_at = NOW()
           WHERE product_variant_id = $2 AND location_id = (SELECT location_id FROM returns WHERE id = $3)`,
          [line.quantity, line.product_variant_id, id],
        );
      }
    }

    const { rows } = await orgQuery(
      orgId,
      `UPDATE returns SET status = $1, processed_by = $2 WHERE id = $3 RETURNING *`,
      [status, processed_by || null, id],
    );

    return NextResponse.json({ return: rows[0] }, { status: 200 });
  } catch (error) {
    console.error('Returns PUT error:', error);
    return NextResponse.json({ error: 'Failed to update return' }, { status: 500 });
  }
}
