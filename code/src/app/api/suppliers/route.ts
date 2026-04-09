import { NextRequest, NextResponse } from 'next/server';
import { orgQuery } from '@/lib/db';
import { requireAdminPermission } from '@/lib/authz';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';
import { pgInsertAuditEvent } from '@/lib/persistence/postgres-store';
import { validateBody, supplierCreateSchema, supplierUpdateSchema } from '@/lib/validation/schemas';


/**
 * GET /api/suppliers - List all suppliers
 * POST /api/suppliers - Create a new supplier
 * PUT /api/suppliers - Update an existing supplier
 */
export async function GET(request: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pageSize = Math.min(Math.max(1, Number(request.nextUrl.searchParams.get('pageSize')) || 100), 500);
  const cursor = request.nextUrl.searchParams.get('cursor') || null;

  try {
    const values: unknown[] = [orgId];
    let cursorClause = '';
    if (cursor) {
      cursorClause = ' AND name > $2';
      values.push(cursor);
    }

    const { rows } = await orgQuery(
      orgId,
      `SELECT id, name, contact_name, email, phone, address, notes, is_active, created_at, updated_at FROM suppliers WHERE organization_id = $1${cursorClause} ORDER BY name ASC LIMIT $${values.length + 1}`,
      [...values, pageSize + 1],
    );

    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore ? items[items.length - 1].name : null;

    return NextResponse.json({ suppliers: items, nextCursor });
  } catch (error) {
    console.error('Suppliers GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch suppliers' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAdminPermission('catalog.manage');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
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
    pgInsertAuditEvent(
      orgId, null, ctx.employee.id,
      "supplier", supplier.id, "supplier_created",
      { id: supplier.id, name: supplier.name },
    ).catch((err) => console.error("[audit] Failed to insert audit event:", err));

    return NextResponse.json({ supplier }, { status: 201 });
  } catch (error) {
    console.error('Suppliers POST error:', error);
    return NextResponse.json({ error: 'Failed to create supplier' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const ctx = await requireAdminPermission('catalog.manage');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json();
    const v = validateBody(supplierUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id, name, contact_name, email, phone, address, notes, is_active } = v.data;

    const { rows } = await orgQuery(
      orgId,
      `UPDATE suppliers
       SET name = $2, contact_name = $3, email = $4, phone = $5, address = $6, notes = $7, is_active = $8, updated_at = NOW()
       WHERE id = $1 AND organization_id = $9
       RETURNING id, name, contact_name, email, phone, address, notes, is_active, created_at, updated_at`,
      [id, name?.trim() || null, contact_name || null, email || null, phone || null, address || null, notes || null, is_active ?? true, orgId],
    );

    if (rows.length === 0) return NextResponse.json({ error: 'Supplier not found' }, { status: 404 });

    return NextResponse.json({ supplier: rows[0] });
  } catch (error) {
    console.error('Suppliers PUT error:', error);
    return NextResponse.json({ error: 'Failed to update supplier' }, { status: 500 });
  }
}
