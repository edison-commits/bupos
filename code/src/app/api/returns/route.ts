import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

const ORG_ID = '33262270-7100-4b46-b2fb-8b50ad872bbb';
const LOCATION_ID = 'c57268b3-cb14-4c1a-bda6-55e49ddc6313';

/**
 * Returns API
 * GET  - List all returns
 * POST - Create a new return with line items
 * PUT  - Update status (approve/complete/reject). On complete with restock, updates inventory.
 */
export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT r.*,
        l.name as location_name,
        COUNT(rl.id)::int as line_count,
        COALESCE(SUM(rl.quantity), 0)::int as total_items
      FROM returns r
      JOIN locations l ON r.location_id = l.id
      LEFT JOIN return_lines rl ON r.id = rl.return_id
      WHERE r.organization_id = $1
      GROUP BY r.id, l.name
      ORDER BY r.created_at DESC`,
      [ORG_ID],
    );
    return NextResponse.json({ returns: rows });
  } catch (error) {
    console.error('Returns GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch returns' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { customer_name, reason, notes, refund_method, lines } = await request.json();

    if (!lines || lines.length === 0) {
      return NextResponse.json({ error: 'At least one return item is required' }, { status: 400 });
    }

    // Generate return number: RET-BEL-YYMMDD-NNN
    const { rows: locRows } = await pool.query('SELECT name FROM locations WHERE id = $1', [LOCATION_ID]);
    const locCode = (locRows[0]?.name || 'STR').slice(0, 3).toUpperCase();
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int as cnt FROM returns WHERE organization_id = $1 AND return_number LIKE $2`,
      [ORG_ID, `RET-${locCode}-${dateStr}-%`],
    );
    const seq = (countRows[0].cnt || 0) + 1;
    const returnNumber = `RET-${locCode}-${dateStr}-${String(seq).padStart(3, '0')}`;

    // Calculate refund amount
    const refundAmount = lines.reduce((sum: number, l: { quantity: number; unit_price: number }) =>
      sum + (l.quantity * l.unit_price), 0);

    const { rows: retRows } = await pool.query(
      `INSERT INTO returns (organization_id, location_id, return_number, customer_name, reason, notes, refund_method, refund_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING *`,
      [ORG_ID, LOCATION_ID, returnNumber, customer_name || null, reason || 'other', notes || null, refund_method || 'store_credit', refundAmount],
    );
    const returnId = retRows[0].id;

    for (const line of lines) {
      await pool.query(
        `INSERT INTO return_lines (return_id, product_variant_id, quantity, unit_price, restock)
         VALUES ($1, $2, $3, $4, $5)`,
        [returnId, line.product_variant_id, line.quantity || 1, line.unit_price || 0, line.restock !== false],
      );
    }

    return NextResponse.json({ return: retRows[0], return_number: returnNumber });
  } catch (error) {
    console.error('Returns POST error:', error);
    return NextResponse.json({ error: 'Failed to create return' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { id, status, processed_by } = await request.json();
    if (!id || !status) return NextResponse.json({ error: 'ID and status required' }, { status: 400 });

    // If completing, restock items marked for restock
    if (status === 'completed') {
      const { rows: lines } = await pool.query(
        `SELECT rl.* FROM return_lines rl
         JOIN returns r ON rl.return_id = r.id
         WHERE r.id = $1 AND rl.restock = true`,
        [id],
      );

      for (const line of lines) {
        await pool.query(
          `UPDATE inventory_levels SET on_hand = on_hand + $1, received_at = NOW(), updated_at = NOW()
           WHERE product_variant_id = $2 AND location_id = (SELECT location_id FROM returns WHERE id = $3)`,
          [line.quantity, line.product_variant_id, id],
        );
      }
    }

    const { rows } = await pool.query(
      `UPDATE returns SET status = $1, processed_by = $2 WHERE id = $3 AND organization_id = $4 RETURNING *`,
      [status, processed_by || null, id, ORG_ID],
    );

    if (rows.length === 0) return NextResponse.json({ error: 'Return not found' }, { status: 404 });
    return NextResponse.json({ return: rows[0] });
  } catch (error) {
    console.error('Returns PUT error:', error);
    return NextResponse.json({ error: 'Failed to update return' }, { status: 500 });
  }
}
