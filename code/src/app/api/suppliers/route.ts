import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { requireAdminPermission } from '@/lib/authz';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';


/**
 * GET /api/suppliers - List all suppliers
 * POST /api/suppliers - Create a new supplier
 * PUT /api/suppliers - Update an existing supplier
 */
export async function GET() {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM suppliers WHERE organization_id = $1 ORDER BY name ASC`,
      [orgId],
    );
    return NextResponse.json({ suppliers: rows });
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
    const { name, contact_name, email, phone, address, notes } = await request.json();

    if (!name?.trim()) {
      return NextResponse.json({ error: 'Supplier name is required' }, { status: 400 });
    }

    const { rows } = await pool.query(
      `INSERT INTO suppliers (organization_id, name, contact_name, email, phone, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [orgId, name.trim(), contact_name || null, email || null, phone || null, address || null, notes || null],
    );

    return NextResponse.json({ supplier: rows[0] }, { status: 201 });
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
    const { id, name, contact_name, email, phone, address, notes, is_active } = await request.json();

    if (!id) return NextResponse.json({ error: 'Supplier ID is required' }, { status: 400 });
    if (!name?.trim()) return NextResponse.json({ error: 'Supplier name is required' }, { status: 400 });

    const { rows } = await pool.query(
      `UPDATE suppliers
       SET name = $2, contact_name = $3, email = $4, phone = $5, address = $6, notes = $7, is_active = $8, updated_at = NOW()
       WHERE id = $1 AND organization_id = $9
       RETURNING *`,
      [id, name.trim(), contact_name || null, email || null, phone || null, address || null, notes || null, is_active ?? true, orgId],
    );

    if (rows.length === 0) return NextResponse.json({ error: 'Supplier not found' }, { status: 404 });

    return NextResponse.json({ supplier: rows[0] });
  } catch (error) {
    console.error('Suppliers PUT error:', error);
    return NextResponse.json({ error: 'Failed to update supplier' }, { status: 500 });
  }
}
