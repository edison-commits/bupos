import { NextResponse } from 'next/server';
import { orgQuery, getPool } from '@/lib/supabase-rest';
import { withDualAuth, withAdminAuth } from '@/lib/api/with-auth';
import { randomUUID } from '@/lib/uuid';
import { validateBody, receivingCreateSchema } from '@/lib/validation/schemas';
import { invalidateInventoryCache } from "@/lib/cache/inventory-cache";

import { safeErr } from "@/lib/logging/safe-err";
/**
 * Receiving API
 *
 * GET  /api/receiving?type=open_pos           - List open purchase orders
 * GET  /api/receiving?type=po_details&id=<id> - Get PO with line items
 * GET  /api/receiving?type=search&q=<query>   - Search products by SKU/name
 * POST /api/receiving                          - Process receiving batch
 */

export const GET = withDualAuth("inventory.adjust", async (request, ctx) => {
  const { orgId, locationId } = ctx;

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
        [orgId, locationId]
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
        JOIN purchase_orders po ON po.id = pol.purchase_order_id AND po.organization_id = $2
        JOIN product_variants pv ON pol.product_variant_id = pv.id AND pv.organization_id = $2
        JOIN products p ON pv.product_id = p.id AND p.organization_id = $2
        WHERE pol.purchase_order_id = $1
        ORDER BY p.name, pv.name`,
        [poId, orgId]
      );

      return NextResponse.json({ lines });
    }

    if (type === 'search') {
      const q = request.nextUrl.searchParams.get('q');
      if (!q || q.length < 2) {
        return NextResponse.json({ variants: [] });
      }

      const searchTerm = `%${q.toUpperCase().replace(/[%_\\]/g, '\\$&')}%`;
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
        JOIN products p ON pv.product_id = p.id AND p.organization_id = $1 AND p.is_active = true
        LEFT JOIN inventory_levels il ON pv.id = il.product_variant_id
          AND il.location_id = $2
          AND il.organization_id = $1
        WHERE pv.organization_id = $1
          AND (UPPER(pv.sku) LIKE $3 OR UPPER(p.name) LIKE $3 OR UPPER(pv.name) LIKE $3)
          AND pv.is_active = true
        LIMIT 20`,
        // R64-M5: added `p.is_active = true` so a receiving clerk
        // scanning at the dock can't find a soft-deleted product.
        // Defense-in-depth against R64-H1 CSV-reactivate, and
        // against any future reactivation path that misses
        // propagating is_active down to variants.
        [orgId, locationId, searchTerm]
      );

      return NextResponse.json({ variants: rows });
    }

    return NextResponse.json({ error: 'Invalid type parameter' }, { status: 400 });
  } catch (error) {
    console.error('Receiving GET error:', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to fetch receiving data' },
      { status: 500 }
    );
  }
});

// R27-H2: receiving writes purchase_order_lines + inventory — back-office
// flow, not a register terminal action. GET stays dual for clerk UI.
export const POST = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId, employee, locationId } = ctx;
  const employeeId = employee.id;

  try {
    const body = await request.json();
    const v = validateBody(receivingCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { items, mode, po_id } = v.data;
    // Use validated items from schema, not raw body

    // Cross-location PO guard: the receiving cashier uses ctx.locationId for
    // the inventory write. If we accept a po_id without verifying the PO
    // belongs to THIS location (and this org), a cashier at Location A can
    // submit Location B's open PO — stock lands at A, Loc B's PO is marked
    // received, the shipment meant for B never appears. Mirrors the check
    // /api/purchase-orders enforces on its PATCH receive path.
    if (mode === 'po' && po_id) {
      const { rows: poRows } = await orgQuery(
        orgId,
        `SELECT location_id FROM purchase_orders WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [po_id, orgId],
      );
      if (poRows.length === 0) {
        return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 });
      }
      if (poRows[0].location_id !== locationId) {
        return NextResponse.json(
          { error: 'Purchase order does not belong to your location' },
          { status: 403 },
        );
      }
    }

    // Process receiving in transaction
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_org_id', $1, true)", [orgId]
      );

      // R17-M-1: verify every client-supplied product_variant_id belongs to
      // this org BEFORE any inventory writes. The FK is tenant-agnostic, so
      // a receiving POST in adhoc mode (no PO) with a foreign variant UUID
      // would create an inventory_levels row linking caller's org to the
      // foreign variant. PO mode is already gated via the PO's org_id, but
      // adhoc mode bypassed it. Same class as R16-L-4 (PO + transfer lines).
      const variantIds = Array.from(new Set(items.map((i) => i.product_variant_id)));
      if (variantIds.length > 0) {
        const { rows: vCheck } = await client.query(
          `SELECT id FROM product_variants WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
          [variantIds, orgId],
        );
        if (vCheck.length !== variantIds.length) {
          await client.query('ROLLBACK');
          return NextResponse.json(
            { error: 'One or more product_variant_id values do not belong to this organization' },
            { status: 400 },
          );
        }
      }

      for (const item of items) {
        // Get current inventory level
        // FOR UPDATE locks the row so concurrent receiving POSTs on the same
        // variant/location serialize correctly. Otherwise two reads both see
        // on_hand=N and both write N+delta, losing one receipt.
        const levelRes = await client.query(
          `SELECT id, on_hand FROM inventory_levels
           WHERE product_variant_id = $1 AND location_id = $2 AND organization_id = $3
           FOR UPDATE`,
          [item.product_variant_id, locationId, orgId]
        );

        let inventoryLevelId: string;
        let currentOnHand: number;

        if (levelRes.rows.length > 0) {
          inventoryLevelId = levelRes.rows[0].id;
          currentOnHand = levelRes.rows[0].on_hand;
        } else {
          // Create inventory level if it doesn't exist
          // R78-DB-M1: default reorder_point=5 for first-time
          // receives at a new location, parity with PO PATCH
          // receive + transfers RECEIVE (R76-DB-M). Prior default
          // 0 hid the variant from reorder-suggestions / low-stock
          // alerts until someone manually set a threshold.
          const createRes = await client.query(
            `INSERT INTO inventory_levels
              (organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point)
             VALUES ($1, $2, $3, 0, 0, 5)
             RETURNING id`,
            [orgId, locationId, item.product_variant_id]
          );
          inventoryLevelId = createRes.rows[0].id;
          currentOnHand = 0;
        }

        // Compute the effective received delta. In PO mode, clamp to the PO
        // line's remaining quantity_ordered so over-receives don't add phantom
        // inventory beyond what was actually ordered. In adhoc mode, accept
        // the raw quantity.
        // R31-H6: FOR UPDATE the PO line so two concurrent receives
        // on the same line can't both read `quantity_received = 0`,
        // both clamp to ordered, both UPDATE additively, and
        // double-credit inventory. Prior shape had no lock here.
        let effectiveDelta = Number(item.quantity);
        if (mode === 'po' && item.po_line_id) {
          // R26-F1: JOIN through purchase_orders for explicit org
          // scoping. po_line_id + po_id are from the client payload.
          const lineRes = await client.query(
            `SELECT pol.quantity_ordered, COALESCE(pol.quantity_received, 0) AS received
             FROM purchase_order_lines pol
             JOIN purchase_orders po ON po.id = pol.purchase_order_id
             WHERE pol.id = $1 AND pol.purchase_order_id = $2
               AND po.organization_id = $3
             FOR UPDATE OF pol`,
            [item.po_line_id, po_id, orgId],
          );
          if (lineRes.rows.length === 0) {
            // Either bad line id or wrong PO — skip silently (defensive) rather than polluting inventory.
            continue;
          }
          const ordered = Number(lineRes.rows[0].quantity_ordered);
          const alreadyRecv = Number(lineRes.rows[0].received);
          const remaining = Math.max(0, ordered - alreadyRecv);
          effectiveDelta = Math.max(0, Math.min(remaining, Number(item.quantity)));
          if (effectiveDelta === 0) continue;
        }

        // Calculate new on_hand using the CLAMPED delta.
        const newOnHand = currentOnHand + effectiveDelta;

        // Update inventory level. received_at is touched here because this IS
        // a receiving operation (contrast with refund restocks which should not).
        // R26-F1: inventoryLevelId was fetched from an org-scoped
        // SELECT earlier in this handler; explicit filter on UPDATE
        // for defense-in-depth.
        await client.query(
          `UPDATE inventory_levels
           SET on_hand = $1, received_at = NOW(), updated_at = NOW()
           WHERE id = $2 AND organization_id = $3`,
          [newOnHand, inventoryLevelId, orgId]
        );

        // Create inventory adjustment record using the clamped delta.
        // R32-D6: include organization_id (migration 063).
        await client.query(
          `INSERT INTO inventory_adjustments
            (organization_id, inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            orgId,
            inventoryLevelId,
            item.product_variant_id,
            locationId,
            employeeId,
            'received',
            effectiveDelta,
            newOnHand,
          ]
        );

        // Update PO line with the clamped delta only. line was
        // verified org-scoped above via the lineRes SELECT.
        // check-pool-org-filter: scoped-by-prior-fk-verified-select
        if (mode === 'po' && item.po_line_id) {
          await client.query(
            `UPDATE purchase_order_lines
             SET quantity_received = COALESCE(quantity_received, 0) + $1
             WHERE id = $2 AND purchase_order_id = $3`,
            [effectiveDelta, item.po_line_id, po_id],
          );
        }
      }

      // Update PO status if in PO mode. po_id was validated via the
      // earlier line-level JOIN (if we got here with mode='po', the
      // JOIN-against-organization_id succeeded for at least one line).
      if (mode === 'po' && po_id) {
        // R26-F1: JOIN to purchase_orders to scope the aggregate.
        const statusRes = await client.query(
          `SELECT
            COUNT(*)::int as total,
            SUM(CASE WHEN pol.quantity_received >= pol.quantity_ordered THEN 1 ELSE 0 END)::int as completed
           FROM purchase_order_lines pol
           JOIN purchase_orders po ON po.id = pol.purchase_order_id
           WHERE pol.purchase_order_id = $1 AND po.organization_id = $2`,
          [po_id, orgId]
        );

        // Cast to numbers — node-pg returns NUMERIC aggregates as strings, which
        // would make `completed === total` always false / lexical.
        const total = Number(statusRes.rows[0].total);
        const completed = Number(statusRes.rows[0].completed);
        let newStatus = 'partial';

        if (completed === total) {
          newStatus = 'received';
        }

        // R26-F1: explicit org filter on PO status update.
        await client.query(
          `UPDATE purchase_orders
           SET status = $1, received_at = NOW(), updated_at = NOW()
           WHERE id = $2 AND organization_id = $3`,
          [newStatus, po_id, orgId]
        );
      }

      // R49: audit INSIDE the receiving tx. Prior shape wrote the audit
      // row post-commit via waitUntilOrAwait — if the post-commit write
      // failed (Neon WebSocket blip, Worker eviction), the inventory mint
      // committed with NO audit trail. inventory_received is how minted
      // stock turns into sellable units; audit drop here is a fraud-
      // evidence gap on every receiving batch.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'inventory', $5, 'inventory_received', $6, now())`,
        [
          randomUUID(), orgId, locationId, employeeId, null,
          JSON.stringify({
            items_count: items.length,
            mode,
            po_id: po_id || null,
            description: `Received ${items.length} item(s)`,
          }),
        ],
      );

      await client.query('COMMIT');
      invalidateInventoryCache(orgId);
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
    console.error('Receiving POST error:', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to process receiving' },
      { status: 500 }
    );
  }
});
