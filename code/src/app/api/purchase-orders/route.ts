import { NextRequest, NextResponse } from 'next/server';
import { orgQuery, pool } from '@/lib/db';
import { requireAdminPermission } from '@/lib/authz';

const ORG_ID = '33262270-7100-4b46-b2fb-8b50ad872bbb';
const LOCATION_ID = 'c57268b3-cb14-4c1a-bda6-55e49ddc6313';

/**
 * Purchase Orders API
 *
 * GET    /api/purchase-orders              - List all POs with line counts and totals
 * GET    /api/purchase-orders?id=<uuid>    - Get single PO with full line items
 * POST   /api/purchase-orders              - Create a new PO with line items
 * PUT    /api/purchase-orders              - Update PO header / status
 * PATCH  /api/purchase-orders              - Receive items (update quantities + inventory)
 */

export async function GET(request: NextRequest) {
  const poId = request.nextUrl.searchParams.get('id');

  try {
    // Single PO detail with line items
    if (poId) {
      const { rows: poRows } = await orgQuery(
        ORG_ID,
        `SELECT po.*, s.name as supplier_name, s.contact_name as supplier_contact, s.email as supplier_email, l.name as location_name
         FROM purchase_orders po
         JOIN suppliers s ON po.supplier_id = s.id
         JOIN locations l ON po.location_id = l.id
         WHERE po.id = $1`,
        [poId],
      );

      if (poRows.length === 0) {
        return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 });
      }

      const { rows: lines } = await orgQuery(
        ORG_ID,
        `SELECT pol.*, pv.name as variant_name, pv.sku, pv.size_label, pv.color_label, p.name as product_name
         FROM purchase_order_lines pol
         JOIN product_variants pv ON pol.product_variant_id = pv.id
         JOIN products p ON pv.product_id = p.id
         WHERE pol.purchase_order_id = $1
         ORDER BY p.name, pv.name`,
        [poId],
      );

      return NextResponse.json({ order: poRows[0], lines });
    }

    // List all POs with summary
    const { rows } = await orgQuery(
      ORG_ID,
      `SELECT
        po.*,
        s.name as supplier_name,
        l.name as location_name,
        COUNT(pol.id)::int as line_count,
        COALESCE(SUM(pol.quantity_ordered), 0)::int as total_units_ordered,
        COALESCE(SUM(pol.quantity_received), 0)::int as total_units_received,
        COALESCE(SUM(pol.quantity_ordered * pol.unit_cost), 0)::numeric(12,2) as total_cost
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id
      JOIN locations l ON po.location_id = l.id
      LEFT JOIN purchase_order_lines pol ON po.id = pol.purchase_order_id
      GROUP BY po.id, s.name, l.name
      ORDER BY po.created_at DESC`,
      [],
    );

    return NextResponse.json({ orders: rows });
  } catch (error) {
    console.error('PO GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch purchase orders' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  await requireAdminPermission('catalog.manage');
  try {
    const { supplier_id, notes, expected_at, lines } = await request.json();

    if (!supplier_id) return NextResponse.json({ error: 'Supplier is required' }, { status: 400 });
    if (!lines || lines.length === 0) return NextResponse.json({ error: 'At least one line item is required' }, { status: 400 });

    // Generate PO number: BEL-PO-YYMMDD-NNN
    // Get location short code from location name
    const { rows: locRows } = await orgQuery(
      ORG_ID,
      `SELECT name FROM locations WHERE id = $1`,
      [LOCATION_ID],
    );
    const locName = locRows[0]?.name || 'STR';
    const locCode = locName.slice(0, 3).toUpperCase(); // e.g. "Bellflower" → "BEL"
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yy}${mm}${dd}`;
    const { rows: countRows } = await orgQuery(
      ORG_ID,
      `SELECT COUNT(*)::int as cnt FROM purchase_orders WHERE po_number LIKE $1`,
      [`${locCode}-PO-${dateStr}-%`],
    );
    const seq = (countRows[0].cnt || 0) + 1;
    const poNumber = `${locCode}-PO-${dateStr}-${String(seq).padStart(3, '0')}`;

    // Create PO and lines in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_org_id = '${ORG_ID}'`);

      // Insert PO
      const poResult = await client.query(
        `INSERT INTO purchase_orders (organization_id, supplier_id, location_id, po_number, status, notes, expected_at)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6)
         RETURNING *`,
        [ORG_ID, supplier_id, LOCATION_ID, poNumber, notes || null, expected_at || null],
      );
      const poId = poResult.rows[0].id;

      // Insert line items
      for (const line of lines) {
        await client.query(
          `INSERT INTO purchase_order_lines (purchase_order_id, product_variant_id, quantity_ordered, unit_cost)
           VALUES ($1, $2, $3, $4)`,
          [poId, line.product_variant_id, line.quantity_ordered || 0, line.unit_cost || 0],
        );
      }

      await client.query('COMMIT');
      return NextResponse.json({ order: poResult.rows[0], po_number: poNumber });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('PO POST error:', error);
    return NextResponse.json({ error: 'Failed to create purchase order' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  await requireAdminPermission('catalog.manage');
  try {
    const { id, status, notes, expected_at, ordered_at } = await request.json();

    if (!id) return NextResponse.json({ error: 'PO ID is required' }, { status: 400 });

    // Build dynamic update
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    if (status !== undefined) {
      sets.push(`status = $${idx}`);
      values.push(status);
      idx++;
      if (status === 'pending' && ordered_at === undefined) {
        sets.push(`ordered_at = NOW()`);
      }
    }
    if (notes !== undefined) { sets.push(`notes = $${idx}`); values.push(notes); idx++; }
    if (expected_at !== undefined) { sets.push(`expected_at = $${idx}`); values.push(expected_at); idx++; }
    if (ordered_at !== undefined) { sets.push(`ordered_at = $${idx}`); values.push(ordered_at); idx++; }

    values.push(id);

    const { rows } = await orgQuery(
      ORG_ID,
      `UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );

    if (rows.length === 0) return NextResponse.json({ error: 'PO not found' }, { status: 404 });

    return NextResponse.json({ order: rows[0] });
  } catch (error) {
    console.error('PO PUT error:', error);
    return NextResponse.json({ error: 'Failed to update purchase order' }, { status: 500 });
  }
}

/**
 * PATCH - Receive items on a PO.
 * Body: { id: poId, receives: [{ line_id, quantity_received }] }
 *
 * Updates purchase_order_lines.quantity_received, updates inventory_levels.on_hand,
 * and sets inventory_levels.received_at to NOW() for accurate aging.
 * If all lines are fully received, auto-sets PO status to 'received'.
 * If some lines are partially received, sets status to 'partial'.
 */
export async function PATCH(request: NextRequest) {
  await requireAdminPermission('catalog.manage');
  try {
    const { id, receives } = await request.json();

    if (!id) return NextResponse.json({ error: 'PO ID is required' }, { status: 400 });
    if (!receives || receives.length === 0) return NextResponse.json({ error: 'No items to receive' }, { status: 400 });

    // Verify PO exists and is receivable
    const { rows: poRows } = await orgQuery(
      ORG_ID,
      `SELECT * FROM purchase_orders WHERE id = $1`,
      [id],
    );
    if (poRows.length === 0) return NextResponse.json({ error: 'PO not found' }, { status: 404 });

    const po = poRows[0];
    if (po.status === 'cancelled') return NextResponse.json({ error: 'Cannot receive on a cancelled PO' }, { status: 400 });
    if (po.status === 'received') return NextResponse.json({ error: 'PO is already fully received' }, { status: 400 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_org_id = '${ORG_ID}'`);

      // Process each receive
      for (const recv of receives) {
        const { line_id, quantity_received } = recv;
        if (!line_id || !quantity_received || quantity_received <= 0) continue;

        // Get line item details
        const lineResult = await client.query(
          `SELECT pol.*, pv.id as variant_id FROM purchase_order_lines pol
           JOIN product_variants pv ON pol.product_variant_id = pv.id
           WHERE pol.id = $1 AND pol.purchase_order_id = $2`,
          [line_id, id],
        );
        if (lineResult.rows.length === 0) continue;

        const line = lineResult.rows[0];
        const newReceived = Math.min(line.quantity_ordered, (line.quantity_received || 0) + quantity_received);

        // Update line received quantity
        await client.query(
          `UPDATE purchase_order_lines SET quantity_received = $1 WHERE id = $2`,
          [newReceived, line_id],
        );

        // Update inventory: add received quantity and refresh received_at
        await client.query(
          `UPDATE inventory_levels
           SET on_hand = on_hand + $1, received_at = NOW(), updated_at = NOW()
           WHERE product_variant_id = $2 AND location_id = $3`,
          [quantity_received, line.variant_id, po.location_id],
        );

        // If no inventory record exists, create one
        await client.query(
          `INSERT INTO inventory_levels (organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point, received_at)
           VALUES ($1, $2, $3, $4, 0, 5, NOW())
           ON CONFLICT DO NOTHING`,
          [ORG_ID, po.location_id, line.variant_id, quantity_received],
        );
      }

      // Check if all lines are fully received
      const allLinesResult = await client.query(
        `SELECT quantity_ordered, quantity_received FROM purchase_order_lines WHERE purchase_order_id = $1`,
        [id],
      );
      const allLines = allLinesResult.rows;

      const allReceived = allLines.every((l) => l.quantity_received >= l.quantity_ordered);
      const someReceived = allLines.some((l) => l.quantity_received > 0);

      let newStatus = po.status;
      if (allReceived) {
        newStatus = 'received';
      } else if (someReceived) {
        newStatus = 'partial';
      }

      await client.query(
        `UPDATE purchase_orders SET status = $1, received_at = $2, updated_at = NOW() WHERE id = $3`,
        [newStatus, allReceived ? new Date().toISOString() : null, id],
      );

      await client.query('COMMIT');
      return NextResponse.json({ success: true, status: newStatus });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('PO PATCH error:', error);
    return NextResponse.json({ error: 'Failed to receive items' }, { status: 500 });
  }
}
