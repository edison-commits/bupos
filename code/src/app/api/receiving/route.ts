import { BUPOS_LOCATION_ID } from '@/lib/env';
import { NextRequest, NextResponse } from 'next/server';
import { orgQuery, pool } from '@/lib/db';
import { requireAdminPermission } from '@/lib/authz';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';
import { pgInsertAuditEvent } from '@/lib/persistence/postgres-store';

const LOCATION_ID = BUPOS_LOCATION_ID;

/**
 * Receiving API
 *
 * GET  /api/receiving?type=open_pos           - List open purchase orders
 * GET  /api/receiving?type=po_details&id=<id> - Get PO with line items
 * GET  /api/receiving?type=search&q=<query>   - Search products by SKU/name
 * POST /api/receiving                          - Process receiving batch
 */

export async function GET(request: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }  if (!adminCtx && !registerCtx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const type = request.nextUrl.searchParams.get('type');

  try {
    if (type === 'open_pos') {
      // List open purchase orders
      const { rows } = await orgQuery(
        orgId,
        `SELECT
          po.*,
          s.name as supplier_name,
          l.name as location_name,
          COUNT(pol.id)::int as line_count,
          COALESCE(SUM(pol.quantity_ordered), 0)::int as total_units_ordered,
          COALESCE(SUM(pol.quantity_received), 0)::int as total_units_received
        FROM purchase_orders po
        JOIN suppliers s ON po.supplier_id = s.id
        JOIN locations l ON po.location_id = l.id
        LEFT JOIN purchase_order_lines pol ON po.id = pol.purchase_order_id
        WHERE po.organization_id = $1
          AND po.status IN ('pending', 'partial')
          AND po.location_id = $2
        GROUP BY po.id, s.name, l.name
        ORDER BY po.created_at DESC`,
        [orgId, LOCATION_ID]
      );

      return NextResponse.json({ orders: rows });
    }

    if (type === 'po_details') {
      const poId = request.nextUrl.searchParams.get('id');
      if (!poId) {
        return NextResponse.json({ error: 'PO ID required' }, { status: 400 });
      }

      const { rows: lines } = await orgQuery(
        orgId,
        `SELECT
          pol.*,
          pv.sku,
          pv.name as variant_name,
          p.name as product_name
        FROM purchase_order_lines pol
        JOIN product_variants pv ON pol.product_variant_id = pv.id
        JOIN products p ON pv.product_id = p.id
        WHERE pol.purchase_order_id = $1
        ORDER BY p.name, pv.name`,
        [poId]
      );

      return NextResponse.json({ lines });
    }

    if (type === 'search') {
      const q = request.nextUrl.searchParams.get('q');
      if (!q || q.length < 2) {
        return NextResponse.json({ variants: [] });
      }

      const searchTerm = `%${q.toUpperCase()}%`;
      const { rows } = await orgQuery(
        orgId,
        `SELECT
          pv.id,
          pv.sku,
          pv.name,
          pv.product_id,
          p.name as product_name,
          COALESCE(il.on_hand, 0) as on_hand
        FROM product_variants pv
        JOIN products p ON pv.product_id = p.id
        LEFT JOIN inventory_levels il ON pv.id = il.product_variant_id
          AND il.location_id = $2
        WHERE pv.organization_id = $1
          AND (UPPER(pv.sku) LIKE $3 OR UPPER(p.name) LIKE $3 OR UPPER(pv.name) LIKE $3)
          AND pv.is_active = true
        LIMIT 20`,
        [orgId, LOCATION_ID, searchTerm]
      );

      return NextResponse.json({ variants: rows });
    }

    return NextResponse.json({ error: 'Invalid type parameter' }, { status: 400 });
  } catch (error) {
    console.error('Receiving GET error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch receiving data' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAdminPermission('catalog.manage');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { items, mode, po_id } = await request.json();

    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: 'No items to receive' },
        { status: 400 }
      );
    }

    const employeeId = ctx.employee.id;

    // Process receiving in transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SET LOCAL app.current_org_id = '${orgId}'`
      );

      for (const item of items) {
        // Get current inventory level
        const levelRes = await client.query(
          `SELECT id, on_hand FROM inventory_levels
           WHERE product_variant_id = $1 AND location_id = $2 AND organization_id = $3`,
          [item.variant_id, LOCATION_ID, orgId]
        );

        let inventoryLevelId: string;
        let currentOnHand: number;

        if (levelRes.rows.length > 0) {
          inventoryLevelId = levelRes.rows[0].id;
          currentOnHand = levelRes.rows[0].on_hand;
        } else {
          // Create inventory level if it doesn't exist
          const createRes = await client.query(
            `INSERT INTO inventory_levels
              (organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point)
             VALUES ($1, $2, $3, 0, 0, 0)
             RETURNING id`,
            [orgId, LOCATION_ID, item.variant_id]
          );
          inventoryLevelId = createRes.rows[0].id;
          currentOnHand = 0;
        }

        // Calculate new on_hand
        const newOnHand = currentOnHand + item.quantity;

        // Update inventory level
        await client.query(
          `UPDATE inventory_levels
           SET on_hand = $1, updated_at = NOW()
           WHERE id = $2`,
          [newOnHand, inventoryLevelId]
        );

        // Create inventory adjustment record
        await client.query(
          `INSERT INTO inventory_adjustments
            (inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            inventoryLevelId,
            item.variant_id,
            LOCATION_ID,
            employeeId,
            'received',
            item.quantity,
            newOnHand,
          ]
        );

        // Update PO line if in PO mode
        if (mode === 'po' && item.po_line_id) {
          await client.query(
            `UPDATE purchase_order_lines
             SET quantity_received = $1
             WHERE id = $2`,
            [item.quantity, item.po_line_id]
          );
        }
      }

      // Update PO status if in PO mode
      if (mode === 'po' && po_id) {
        const statusRes = await client.query(
          `SELECT
            COUNT(*) as total,
            SUM(CASE WHEN quantity_received >= quantity_ordered THEN 1 ELSE 0 END) as completed
           FROM purchase_order_lines
           WHERE purchase_order_id = $1`,
          [po_id]
        );

        const { total, completed } = statusRes.rows[0];
        let newStatus = 'partial';

        if (completed === total) {
          newStatus = 'received';
        }

        await client.query(
          `UPDATE purchase_orders
           SET status = $1, received_at = NOW(), updated_at = NOW()
           WHERE id = $2`,
          [newStatus, po_id]
        );
      }

      await client.query('COMMIT');
      pgInsertAuditEvent(
        orgId, null, employeeId,
        "inventory", null, "inventory_received",
        { items_count: items.length, mode, po_id: po_id || null, description: `Received ${items.length} item(s)` },
      ).catch(() => {});
      return NextResponse.json({
        success: true,
        message: `Successfully received ${items.length} item(s)`,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Receiving POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to process receiving' },
      { status: 500 }
    );
  }
}
