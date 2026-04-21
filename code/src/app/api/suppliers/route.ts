import { NextResponse } from 'next/server';
import { orgQuery } from '@/lib/supabase-rest';
import { withDualAuth, withAdminAuth } from '@/lib/api/with-auth';
import { pgInsertAuditEvent } from '@/lib/persistence/postgres-store';
import { validateBody, supplierCreateSchema, supplierUpdateSchema } from '@/lib/validation/schemas';


import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
/**
 * GET /api/suppliers - List all suppliers
 * POST /api/suppliers - Create a new supplier
 * PUT /api/suppliers - Update an existing supplier
 */
export const GET = withDualAuth("inventory.adjust", async (request, ctx) => {
  const { orgId } = ctx;
  const pageSize = Math.min(Math.max(1, Number(request.nextUrl.searchParams.get('pageSize')) || 100), 500);
  const cursor = request.nextUrl.searchParams.get('cursor') || null;

  try {
    // Cursor is "name|id" so pagination is stable even when multiple suppliers
    // share the same name (name is not unique).
    const values: unknown[] = [orgId];
    let cursorClause = '';
    if (cursor) {
      const [cName, cId] = cursor.split('|');
      if (cName && cId) {
        cursorClause = ' AND (name, id) > ($2, $3)';
        values.push(cName, cId);
      }
    }

    const { rows } = await orgQuery(
      orgId,
      `SELECT id, name, contact_name, email, phone, address, notes, is_active, created_at, updated_at
       FROM suppliers WHERE organization_id = $1${cursorClause}
       ORDER BY name ASC, id ASC
       LIMIT $${values.length + 1}`,
      [...values, pageSize + 1],
    );

    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? `${last.name}|${last.id}` : null;

    return NextResponse.json({ suppliers: items, nextCursor });
  } catch (error) {
    console.error('Suppliers GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch suppliers' }, { status: 500 });
  }
});

export const POST = withAdminAuth('catalog.manage', async (request, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(supplierCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { name, contact_name, email, phone, address, notes } = v.data;

    const { rows } = await orgQuery(
      orgId,
      `INSERT INTO suppliers (organization_id, name, contact_name, email, phone, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, contact_name, email, phone, address, notes, is_active, created_at, updated_at`,
      [orgId, name.trim(), contact_name || null, email || null, phone || null, address || null, notes || null],
    );

    const supplier = rows[0];
    await waitUntilOrAwait(pgInsertAuditEvent(
      orgId, null, ctx.employee.id,
      "supplier", supplier.id, "supplier_created",
      { id: supplier.id, name: supplier.name },
    ).catch((err) => console.error("[audit] Failed to insert audit event:", safeErr(err))));

    return NextResponse.json({ supplier }, { status: 201 });
  } catch (error) {
    console.error('Suppliers POST error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to create supplier' }, { status: 500 });
  }
});

export const PUT = withAdminAuth('catalog.manage', async (request, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(supplierUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id, name, contact_name, email, phone, address, notes, is_active } = v.data;

    // Dynamic SET: only update columns that were actually sent. Previously, a
    // client sending just `{ id, phone }` would wipe every other column to null
    // and reset is_active to true.
    const fieldMap: Record<string, unknown> = {
      name: name !== undefined ? name.trim() : undefined,
      contact_name,
      email,
      phone,
      address,
      notes,
      is_active,
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const [col, val] of Object.entries(fieldMap)) {
      if (val === undefined) continue;
      sets.push(`${col} = $${idx}`);
      params.push(val);
      idx++;
    }
    if (sets.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }
    sets.push(`updated_at = NOW()`);
    params.push(id, orgId);

    const { rows } = await orgQuery(
      orgId,
      `UPDATE suppliers
       SET ${sets.join(', ')}
       WHERE id = $${idx} AND organization_id = $${idx + 1}
       RETURNING id, name, contact_name, email, phone, address, notes, is_active, created_at, updated_at`,
      params,
    );

    if (rows.length === 0) return NextResponse.json({ error: 'Supplier not found' }, { status: 404 });

    // Audit every supplier change. POs join to suppliers for reporting and
    // payment info; a manager silently swapping a supplier's contact email
    // or name to point at fraudulent payment instructions could otherwise
    // redirect invoices with no trail. Record which fields changed so
    // investigators can reconstruct the before/after via the PG journal.
    await waitUntilOrAwait(pgInsertAuditEvent(
      orgId, null, ctx.employee.id,
      "supplier", rows[0].id, "supplier_updated",
      {
        id: rows[0].id,
        changed_fields: Object.entries(fieldMap)
          .filter(([, val]) => val !== undefined)
          .map(([col]) => col),
      },
    ).catch((err) => console.error("[supplier PUT] audit failed:", safeErr(err))));

    return NextResponse.json({ supplier: rows[0] });
  } catch (error) {
    console.error('Suppliers PUT error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to update supplier' }, { status: 500 });
  }
});
