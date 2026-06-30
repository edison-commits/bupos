import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/api/with-auth';
import { orgQuery, orgTx } from '@/lib/supabase-rest';
import { randomUUID } from '@/lib/uuid';
import { validateBody, specialOrderCreateSchema, specialOrderUpdateSchema } from '@/lib/validation/schemas';
import { safeErr } from '@/lib/logging/safe-err';

export const GET = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId } = ctx;
  const allowedLocations = ctx.allowedLocations;
  const status = request.nextUrl.searchParams.get('status')?.trim();

  try {
    const params: unknown[] = [orgId];
    const clauses = ["so.organization_id = $1"];
    let idx = 2;
    if (allowedLocations !== null) {
      if (allowedLocations.length === 0) return NextResponse.json({ orders: [] });
      clauses.push(`so.location_id = ANY($${idx}::uuid[])`);
      params.push(allowedLocations);
      idx++;
    }
    if (status) {
      clauses.push(`so.status = $${idx}`);
      params.push(status);
    }

    const { rows } = await orgQuery(
      orgId,
      `SELECT so.*, c.first_name, c.last_name, c.email, c.phone,
              s.name AS supplier_name, po.po_number,
              COUNT(sol.id)::int AS line_count,
              COALESCE(SUM(sol.quantity), 0)::int AS total_units,
              COALESCE(SUM(sol.quantity * sol.unit_price), 0)::numeric AS estimated_total
         FROM special_orders so
         JOIN customers c ON c.id = so.customer_id AND c.organization_id = $1
         LEFT JOIN suppliers s ON s.id = so.supplier_id AND s.organization_id = $1
         LEFT JOIN purchase_orders po ON po.id = so.purchase_order_id AND po.organization_id = $1
         LEFT JOIN special_order_lines sol ON sol.special_order_id = so.id AND sol.organization_id = $1
        WHERE ${clauses.join(' AND ')}
        GROUP BY so.id, c.first_name, c.last_name, c.email, c.phone, s.name, po.po_number
        ORDER BY so.created_at DESC
        LIMIT 200`,
      params,
    );

    const orderIds = rows.map((r) => r.id as string);
    const lines = orderIds.length === 0
      ? []
      : (await orgQuery(
          orgId,
          `SELECT sol.*, pv.sku, pv.name AS variant_name, pv.size_label, pv.color_label, p.name AS product_name
             FROM special_order_lines sol
             JOIN product_variants pv ON pv.id = sol.product_variant_id AND pv.organization_id = $1
             JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
            WHERE sol.organization_id = $1 AND sol.special_order_id = ANY($2::uuid[])
            ORDER BY p.name, pv.name`,
          [orgId, orderIds],
        )).rows;

    return NextResponse.json({ orders: rows, lines });
  } catch (error) {
    console.error('Special orders GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch special orders' }, { status: 500 });
  }
});

export const POST = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId, employee, locationId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(specialOrderCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const data = v.data;

    const client = await orgTx(orgId);
    try {
      const customer = await client.query(
        `SELECT id FROM customers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [data.customer_id, orgId],
      );
      if (customer.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'customer_id does not exist in this organization' }, { status: 400 });
      }

      if (data.supplier_id) {
        const supplier = await client.query(
          `SELECT id FROM suppliers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [data.supplier_id, orgId],
        );
        if (supplier.rows.length === 0) {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: 'supplier_id does not exist in this organization' }, { status: 400 });
        }
      }

      const variantIds = Array.from(new Set(data.lines.map((line) => line.product_variant_id)));
      const variantCheck = await client.query(
        `SELECT id FROM product_variants WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
        [variantIds, orgId],
      );
      if (variantCheck.rows.length !== variantIds.length) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'One or more product_variant_id values do not exist in this organization' }, { status: 400 });
      }

      const { rows } = await client.query(
        `INSERT INTO special_orders (
           id, organization_id, location_id, customer_id, supplier_id,
           request_notes, deposit_due, deposit_paid, needed_by, created_by_employee_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          randomUUID(), orgId, locationId, data.customer_id, data.supplier_id ?? null,
          data.request_notes ?? null, data.deposit_due ?? 0, data.deposit_paid ?? 0,
          data.needed_by ?? null, employee.id,
        ],
      );
      const order = rows[0];

      for (const line of data.lines) {
        await client.query(
          `INSERT INTO special_order_lines (
             id, organization_id, special_order_id, product_variant_id, quantity, unit_price, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [randomUUID(), orgId, order.id, line.product_variant_id, line.quantity, line.unit_price ?? 0, line.notes ?? null],
        );
      }

      await client.query('COMMIT');
      return NextResponse.json({ order }, { status: 201 });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Special orders POST error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to create special order' }, { status: 500 });
  }
});

export const PATCH = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId, employee, locationId } = ctx;
  const allowedLocations = ctx.allowedLocations;
  try {
    const body = await request.json();
    const v = validateBody(specialOrderUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id, action, status, supplier_id, expected_at } = v.data;

    const client = await orgTx(orgId);
    try {
      const orderRes = await client.query(
        `SELECT * FROM special_orders so WHERE so.id = $1 AND so.organization_id = $2 FOR UPDATE`,
        [id, orgId],
      );
      if (orderRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Special order not found' }, { status: 404 });
      }
      const order = orderRes.rows[0] as Record<string, unknown>;
      if (allowedLocations !== null && !allowedLocations.includes(order.location_id as string)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Special order not found' }, { status: 404 });
      }

      if (action === "generate_po") {
        const supplierId = supplier_id ?? (order.supplier_id as string | null);
        if (!supplierId) {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: 'supplier_id is required to generate a draft PO' }, { status: 400 });
        }
        const supplier = await client.query(
          `SELECT id FROM suppliers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [supplierId, orgId],
        );
        if (supplier.rows.length === 0) {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: 'supplier_id does not exist in this organization' }, { status: 400 });
        }

        const prefix = `SO-PO-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}`;
        const countRows = await client.query(
          `SELECT COUNT(*)::int AS cnt FROM purchase_orders WHERE organization_id = $1 AND po_number LIKE $2`,
          [orgId, `${prefix}-%`],
        );
        const poNumber = `${prefix}-${String(Number(countRows.rows[0]?.cnt ?? 0) + 1).padStart(3, '0')}`;
        const poRows = await client.query(
          `INSERT INTO purchase_orders (organization_id, supplier_id, location_id, po_number, status, notes, expected_at)
           VALUES ($1, $2, $3, $4, 'draft', $5, $6)
           RETURNING *`,
          [orgId, supplierId, order.location_id ?? locationId, poNumber, `Generated from special order ${id}`, expected_at ?? null],
        );
        const poId = poRows.rows[0].id as string;

        const lineRows = await client.query(
          `SELECT product_variant_id, quantity
             FROM special_order_lines
            WHERE organization_id = $1 AND special_order_id = $2`,
          [orgId, id],
        );
        for (const line of lineRows.rows as Array<{ product_variant_id: string; quantity: number }>) {
          // check-pool-org-filter: scoped-by-parent-special-order-and-po
          // `purchase_order_lines` inherits tenant scope from the draft PO we
          // just created for this org, and each inserted variant came from
          // special_order_lines filtered by `organization_id = $1` above.
          await client.query(
            `INSERT INTO purchase_order_lines (id, purchase_order_id, product_variant_id, quantity_ordered, unit_cost, quantity_received)
             VALUES ($1, $2, $3, $4, 0, 0)`,
            [randomUUID(), poId, line.product_variant_id, line.quantity],
          );
        }

        await client.query(
          `UPDATE special_orders
              SET purchase_order_id = $1, supplier_id = $2, status = 'ordered', updated_at = now()
            WHERE id = $3 AND organization_id = $4
            RETURNING *`,
          [poId, supplierId, id, orgId],
        );
        // Contract pin: purchase_order_id = poId, status = 'ordered'
        await client.query('COMMIT');
        return NextResponse.json({ ok: true, purchase_order_id: poId });
      }

      const nextStatus = status ?? 'requested';
      const { rows } = await client.query(
        `UPDATE special_orders
            SET status = $1, updated_at = now()
          WHERE id = $2 AND organization_id = $3
          RETURNING *`,
        [nextStatus, id, orgId],
      );
      await client.query('COMMIT');
      return NextResponse.json({ order: rows[0], updatedBy: employee.id });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Special orders PATCH error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to update special order' }, { status: 500 });
  }
});
