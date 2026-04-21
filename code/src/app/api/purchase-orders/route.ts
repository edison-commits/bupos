import { NextResponse } from 'next/server';
import { orgQuery, getPool } from '@/lib/supabase-rest';
import { withDualAuth, withAdminAuth } from '@/lib/api/with-auth';
import { pgInsertAuditEvent } from '@/lib/persistence/postgres-store';
import { validateBody, purchaseOrderCreateSchema, purchaseOrderUpdateSchema, purchaseOrderReceiveSchema } from '@/lib/validation/schemas';
import { invalidateInventoryCache } from "@/lib/cache/inventory-cache";

import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
/**
 * Purchase Orders API
 *
 * GET    /api/purchase-orders              - List all POs with line counts and totals
 * GET    /api/purchase-orders?id=<uuid>    - Get single PO with full line items
 * POST   /api/purchase-orders              - Create a new PO with line items
 * PUT    /api/purchase-orders              - Update PO header / status
 * PATCH  /api/purchase-orders              - Receive items (update quantities + inventory)
 */

export const GET = withDualAuth("inventory.adjust", async (request, ctx) => {
  const { orgId } = ctx;

  // R13-H-7: inventory.adjust is held by inventory_clerk. Without the
  // allowedLocations filter, a clerk at Store A lists every store's POs
  // including cost totals, supplier contact info, and expected-at dates.
  // Same retrofit shape as R12 applied to audit/returns/gift-cards.
  const allowedLocations = ctx.allowedLocations;

  const poId = request.nextUrl.searchParams.get('id');

  try {
    // Single PO detail with line items.
    //
    // R14-C-1 defense-in-depth: migration 044 adds FORCE ROW LEVEL SECURITY
    // to purchase_orders so RLS is now active, but the explicit
    // `AND po.organization_id = $2` filter below is belt-and-suspenders —
    // if RLS is ever dropped or the table is recreated without FORCE, the
    // query still won't cross tenants. Every other detail-by-id path in
    // this repo follows the same pattern.
    if (poId) {
      const { rows: poRows } = await orgQuery(
        orgId,
        `SELECT po.*, s.name as supplier_name, s.contact_name as supplier_contact, s.email as supplier_email, l.name as location_name
         FROM purchase_orders po
         JOIN suppliers s ON po.supplier_id = s.id
         JOIN locations l ON po.location_id = l.id
         WHERE po.id = $1 AND po.organization_id = $2`,
        [poId, orgId],
      );

      if (poRows.length === 0) {
        return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 });
      }

      // Location membership check on detail path — mirror R12's
      // by-id/returns/transfers pattern. 404 (not 403) so we don't leak
      // existence to unassigned roles.
      if (allowedLocations !== null) {
        const poLoc = poRows[0].location_id as string;
        if (!allowedLocations.includes(poLoc)) {
          return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 });
        }
      }

      const { rows: lines } = await orgQuery(
        orgId,
        `SELECT pol.*, pv.name as variant_name, pv.sku, pv.size_label, pv.color_label, p.name as product_name
         FROM purchase_order_lines pol
         JOIN purchase_orders po ON po.id = pol.purchase_order_id AND po.organization_id = $2
         JOIN product_variants pv ON pol.product_variant_id = pv.id AND pv.organization_id = $2
         JOIN products p ON pv.product_id = p.id AND p.organization_id = $2
         WHERE pol.purchase_order_id = $1
         ORDER BY p.name, pv.name`,
        [poId, orgId],
      );

      return NextResponse.json({ order: poRows[0], lines });
    }

    // List all POs with summary
    const params: unknown[] = [orgId];
    let locClause = "";
    if (allowedLocations !== null) {
      if (allowedLocations.length === 0) {
        return NextResponse.json({ orders: [] });
      }
      params.push(allowedLocations);
      locClause = " AND po.location_id = ANY($2::uuid[])";
    }

    const { rows } = await orgQuery(
      orgId,
      `SELECT
        po.*,
        s.name as supplier_name,
        l.name as location_name,
        COUNT(pol.id)::int as line_count,
        COALESCE(SUM(pol.quantity_ordered), 0)::int as total_units_ordered,
        COALESCE(SUM(pol.quantity_received), 0)::int as total_units_received,
        -- R32-M-PO-overflow: drop the numeric(12,2) cast. A single
        -- malicious PO line at max qty × max unit_cost = 10^13, which
        -- overflows NUMERIC(12,2) (top ~10^10) and crashes GET for
        -- the whole org. Keep an unbounded numeric aggregate; the UI
        -- formats it on the client.
        COALESCE(SUM(pol.quantity_ordered * pol.unit_cost), 0) as total_cost
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id AND s.organization_id = $1
      JOIN locations l ON po.location_id = l.id AND l.organization_id = $1
      LEFT JOIN purchase_order_lines pol ON po.id = pol.purchase_order_id
      WHERE po.organization_id = $1${locClause}
      GROUP BY po.id, s.name, l.name
      ORDER BY po.created_at DESC`,
      params,
    );

    return NextResponse.json({ orders: rows });
  } catch (error) {
    console.error('PO GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch purchase orders' }, { status: 500 });
  }
});

// R27-H2: PO creation is back-office work. A manager-PIN register
// session should not be able to place purchase orders. GET remains
// withDualAuth for clerk visibility.
export const POST = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId, employee, locationId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(purchaseOrderCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { supplier_id, notes, expected_at, lines } = v.data;

    // Verify supplier belongs to THIS org. Without this, an attacker
    // with inventory.adjust on org X who knows (or guesses) a supplier
    // UUID from org Y could create a PO referencing the foreign
    // supplier — poisoning every `JOIN suppliers` in reports and
    // corrupting supplier-payment reconciliation.
    const supplierCheck = await orgQuery(
      orgId,
      `SELECT 1 FROM suppliers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [supplier_id, orgId],
    );
    if (supplierCheck.rows.length === 0) {
      return NextResponse.json({ error: "supplier_id does not exist in this organization" }, { status: 400 });
    }

    // Generate PO number: BEL-PO-YYMMDD-NNN
    // Get location short code from location name
    const { rows: locRows } = await orgQuery(
      orgId,
      `SELECT name FROM locations WHERE id = $1 AND organization_id = $2`,
      [locationId, orgId],
    );
    const locName = locRows[0]?.name || 'STR';
    const locCode = locName.slice(0, 3).toUpperCase(); // e.g. "Bellflower" → "BEL"
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yy}${mm}${dd}`;
    // Create PO and lines in a transaction. Retry on po_number collision via
    // SAVEPOINT since two concurrent creates can observe the same COUNT.
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);

      let poResult: { rows: Array<Record<string, unknown>> } = { rows: [] };
      let poNumber = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const { rows: countRows } = await client.query(
          `SELECT COUNT(*)::int as cnt FROM purchase_orders
           WHERE organization_id = $1 AND po_number LIKE $2`,
          [orgId, `${locCode}-PO-${dateStr}-%`],
        );
        const seq = (countRows[0].cnt || 0) + 1 + attempt;
        poNumber = `${locCode}-PO-${dateStr}-${String(seq).padStart(3, '0')}`;
        await client.query('SAVEPOINT sp_po_insert');
        try {
          poResult = await client.query(
            `INSERT INTO purchase_orders (organization_id, supplier_id, location_id, po_number, status, notes, expected_at)
             VALUES ($1, $2, $3, $4, 'draft', $5, $6)
             RETURNING *`,
            [orgId, supplier_id, locationId, poNumber, notes || null, expected_at || null],
          );
          await client.query('RELEASE SAVEPOINT sp_po_insert');
          break;
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT sp_po_insert').catch(() => {});
          const err = e as { code?: string };
          if (err.code !== '23505') throw e;
          // else loop with a fresh sequence number
        }
      }
      if (poResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Failed to generate unique PO number' }, { status: 500 });
      }
      const poId = poResult.rows[0].id as string;

      // R16-L-4: verify every product_variant_id belongs to caller's org
      // before writing line rows. FK is tenant-agnostic; without this
      // check a write could reference foreign variants, polluting admin
      // list views. Same class as R14-H-4 / R16-H-1 FK checks.
      const variantIds = Array.from(new Set(lines.map((l: { product_variant_id: string }) => l.product_variant_id)));
      if (variantIds.length > 0) {
        const { rows: vCheck } = await client.query(
          `SELECT id FROM product_variants WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
          [variantIds, orgId],
        );
        if (vCheck.length !== variantIds.length) {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: "One or more product variants do not belong to this organization" }, { status: 400 });
        }
      }

      // Insert line items. poId + product_variant_ids were both
      // verified to belong to this org a few lines up; the line rows
      // inherit tenancy via FK to purchase_orders.
      // check-pool-org-filter: scoped-by-fk-to-verified-po
      for (const line of lines) {
        await client.query(
          `INSERT INTO purchase_order_lines (purchase_order_id, product_variant_id, quantity_ordered, unit_cost)
           VALUES ($1, $2, $3, $4)`,
          [poId, line.product_variant_id, line.quantity, line.unit_cost],
        );
      }

      await client.query('COMMIT');
      const newOrder = poResult.rows[0];
      await waitUntilOrAwait(pgInsertAuditEvent(
        orgId, null, employee.id,
        "purchase_order", String(newOrder.id), "purchase_order_created",
        { id: newOrder.id, po_number: poNumber, supplier_id, line_count: lines.length },
      ).catch((err) => console.error("[audit] Failed to insert audit event:", safeErr(err))));
      return NextResponse.json({ order: newOrder, po_number: poNumber });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('PO POST error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to create purchase order' }, { status: 500 });
  }
});

// R27-H2: admin-only (see POST above).
export const PUT = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(purchaseOrderUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id, status, notes, expected_at, ordered_at } = v.data;

    // Build dynamic update
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    if (status !== undefined) {
      sets.push(`status = $${idx}`);
      values.push(status);
      idx++;
      if (status === 'submitted' && ordered_at === undefined) {
        sets.push(`ordered_at = NOW()`);
      }
    }
    if (notes !== undefined) { sets.push(`notes = $${idx}`); values.push(notes); idx++; }
    if (expected_at !== undefined) { sets.push(`expected_at = $${idx}`); values.push(expected_at); idx++; }
    if (ordered_at !== undefined) { sets.push(`ordered_at = $${idx}`); values.push(ordered_at); idx++; }

    values.push(id);
    values.push(orgId);

    // R30-C2: explicit `AND organization_id = $N` on the UPDATE WHERE.
    // Previously only `id = $N` — the `postgres` role has BYPASSRLS so
    // RLS was cosmetic, and the UPDATE could land on ANY tenant's PO
    // matching the UUID. RETURNING * then exfiltrated the full foreign
    // row. Dynamic `${sets}` interpolation also hid the issue from the
    // guardrail.
    const { rows } = await orgQuery(
      orgId,
      `UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
      values,
    );

    if (rows.length === 0) return NextResponse.json({ error: 'PO not found' }, { status: 404 });

    return NextResponse.json({ order: rows[0] });
  } catch (error) {
    console.error('PO PUT error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to update purchase order' }, { status: 500 });
  }
});

/**
 * PATCH - Receive items on a PO.
 * Body: { id: poId, receives: [{ line_id, quantity_received }] }
 *
 * Updates purchase_order_lines.quantity_received, updates inventory_levels.on_hand,
 * and sets inventory_levels.received_at to NOW() for accurate aging.
 * If all lines are fully received, auto-sets PO status to 'received'.
 * If some lines are partially received, sets status to 'partial'.
 */
// R27-H2: admin-only (see POST above).
export const PATCH = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(purchaseOrderReceiveSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id, receives } = v.data;

    // Verify PO exists and is receivable.
    // R28-H1: explicit org predicate (was relying on RLS under BYPASSRLS).
    const { rows: poRows } = await orgQuery(
      orgId,
      `SELECT id, organization_id, location_id, supplier_id, status, notes, expected_at, ordered_at, received_at, created_at, updated_at
         FROM purchase_orders
        WHERE id = $1 AND organization_id = $2`,
      [id, orgId],
    );
    if (poRows.length === 0) return NextResponse.json({ error: 'PO not found' }, { status: 404 });

    const po = poRows[0];
    if (po.status === 'cancelled') return NextResponse.json({ error: 'Cannot receive on a cancelled PO' }, { status: 400 });
    if (po.status === 'received') return NextResponse.json({ error: 'PO is already fully received' }, { status: 400 });

    // The PO is tied to a specific delivery location — reject receives
    // from callers assigned elsewhere so stock never lands at the wrong
    // store. Owners bypass; RLS-scoping alone isn't enough because every
    // manager in the org has `inventory.adjust`.
    const employeeLocIds = ctx.employee.locationIds ?? [];
    const isOwner = ctx.employee.roleKey === "owner";
    if (!isOwner && !employeeLocIds.includes(po.location_id)) {
      return NextResponse.json(
        { error: "You are not assigned to this PO's destination location" },
        { status: 403 },
      );
    }

    const pool2 = await getPool();
    const client = await pool2.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);

      // Process each receive
      for (const recv of receives) {
        const { line_id, quantity_received } = recv;
        if (!line_id || !quantity_received || quantity_received <= 0) continue;

        // Get line item details — FOR UPDATE so two concurrent PATCH
        // requests serialize on the same PO line. Without the lock both
        // could observe the same `alreadyReceived` and both add their
        // full delta to inventory while only one committed the PO-line
        // counter update — phantom stock created on every concurrent
        // partial-receive race.
        // R26-F1: JOIN through purchase_orders to scope by org.
        // line_id + po id are both user-controlled via PATCH body.
        const lineResult = await client.query(
          `SELECT pol.*, pv.id as variant_id FROM purchase_order_lines pol
           JOIN product_variants pv ON pol.product_variant_id = pv.id
           JOIN purchase_orders po ON po.id = pol.purchase_order_id
           WHERE pol.id = $1 AND pol.purchase_order_id = $2
             AND po.organization_id = $3
           FOR UPDATE OF pol`,
          [line_id, id, orgId],
        );
        if (lineResult.rows.length === 0) continue;

        const line = lineResult.rows[0];
        // Clamp the PO-line quantity AND the inventory increment by the same
        // amount. Previously the line was clamped to quantity_ordered but the
        // inventory UPDATE used the un-clamped quantity_received, so
        // over-receives added phantom inventory the PO didn't record.
        const alreadyReceived = Number(line.quantity_received) || 0;
        const remaining = Math.max(0, Number(line.quantity_ordered) - alreadyReceived);
        const effectiveDelta = Math.max(0, Math.min(remaining, Number(quantity_received)));
        if (effectiveDelta === 0) continue;
        const newReceived = alreadyReceived + effectiveDelta;

        // Update line received quantity. line_id was verified in the
        // FOR UPDATE SELECT above to belong to this org's PO — the
        // UPDATE locks that specific row.
        // check-pool-org-filter: scoped-by-prior-fk-verified-select
        await client.query(
          `UPDATE purchase_order_lines SET quantity_received = $1 WHERE id = $2`,
          [newReceived, line_id],
        );

        // Upsert inventory for this (variant, location) in a single
        // statement so concurrent PO-receive calls on the same pair can't
        // lose deltas. The previous code did SELECT FOR UPDATE + UPDATE +
        // INSERT ON CONFLICT DO NOTHING; when the row didn't exist yet,
        // both callers' FOR UPDATE locked zero rows, both UPDATEs affected
        // zero rows, and the second INSERT hit ON CONFLICT DO NOTHING,
        // silently dropping its delta. Letting the conflict path do the
        // increment instead closes that race.
        await client.query(
          `INSERT INTO inventory_levels (organization_id, location_id, product_variant_id, on_hand, reserved, reorder_point, received_at, updated_at)
           VALUES ($1, $2, $3, $4, 0, 5, NOW(), NOW())
           ON CONFLICT (product_variant_id, location_id) DO UPDATE
             SET on_hand = inventory_levels.on_hand + EXCLUDED.on_hand,
                 received_at = NOW(),
                 updated_at = NOW()`,
          [orgId, po.location_id, line.variant_id, effectiveDelta],
        );
      }

      // Check if all lines are fully received. `id` is the PO id that
      // was org-verified via the poResult SELECT much earlier.
      // check-pool-org-filter: scoped-by-verified-po-id
      const allLinesResult = await client.query(
        `SELECT quantity_ordered, quantity_received FROM purchase_order_lines WHERE purchase_order_id = $1`,
        [id],
      );
      const allLines = allLinesResult.rows;

      // node-pg returns NUMERIC columns as strings; cast to Number before
      // comparing or "5" >= "10" is true lexically and the PO flips to
      // "received" prematurely.
      const allReceived = allLines.every((l) => Number(l.quantity_received) >= Number(l.quantity_ordered));
      const someReceived = allLines.some((l) => Number(l.quantity_received) > 0);

      let newStatus = po.status;
      if (allReceived) {
        newStatus = 'received';
      } else if (someReceived) {
        newStatus = 'partial';
      }

      // R26-F1: explicit org filter on PO update.
      await client.query(
        `UPDATE purchase_orders SET status = $1, received_at = $2, updated_at = NOW()
         WHERE id = $3 AND organization_id = $4`,
        [newStatus, allReceived ? new Date().toISOString() : null, id, orgId],
      );

      await client.query('COMMIT');
      invalidateInventoryCache(orgId);
      return NextResponse.json({ success: true, status: newStatus });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('PO PATCH error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to receive items' }, { status: 500 });
  }
});
