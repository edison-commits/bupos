import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';

const ORG_ID = '33262270-7100-4b46-b2fb-8b50ad872bbb';

/**
 * GET /api/reorder-suggestions
 *
 * Returns all inventory items at or below their reorder point,
 * grouped by supplier (via a product→supplier mapping).
 * Suggests order quantities to bring stock up to 2× reorder point.
 *
 * Also returns items with no supplier assigned so they can be flagged.
 */
export async function GET() {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  if (!adminCtx && !registerCtx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    // Find all low/out-of-stock items with supplier info if available
    const { rows } = await pool.query(
      `SELECT
        il.id as inventory_id,
        il.on_hand,
        il.reorder_point,
        il.location_id,
        pv.id as variant_id,
        pv.product_id,
        pv.sku,
        pv.name as variant_name,
        pv.size_label,
        pv.color_label,
        pv.cost,
        p.name as product_name,
        p.supplier_id,
        s.name as supplier_name,
        l.name as location_name
      FROM inventory_levels il
      JOIN product_variants pv ON il.product_variant_id = pv.id
      JOIN products p ON pv.product_id = p.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN locations l ON il.location_id = l.id
      WHERE il.organization_id = $1
        AND il.on_hand <= il.reorder_point
      ORDER BY s.name NULLS LAST, p.name, pv.name`,
      [ORG_ID],
    );

    // Group by supplier
    const bySupplier: Record<string, { supplier_id: string | null; supplier_name: string; items: typeof rows }> = {};

    for (const row of rows) {
      const key = row.supplier_id || '_unassigned';
      if (!bySupplier[key]) {
        bySupplier[key] = {
          supplier_id: row.supplier_id,
          supplier_name: row.supplier_name || 'No Supplier Assigned',
          items: [],
        };
      }
      bySupplier[key].items.push({
        ...row,
        suggested_qty: Math.max(1, (row.reorder_point * 2) - row.on_hand),
      });
    }

    const groups = Object.values(bySupplier);
    const totalItems = rows.length;

    return NextResponse.json({ groups, totalItems });
  } catch (error) {
    console.error('Reorder suggestions error:', error);
    return NextResponse.json({ error: 'Failed to fetch reorder suggestions' }, { status: 500 });
  }
}
