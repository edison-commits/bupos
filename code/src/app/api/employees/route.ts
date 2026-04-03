import { NextRequest, NextResponse } from 'next/server';
import pool, { orgQuery } from '@/lib/db';
import { hashSecret, verifySecret } from '@/lib/auth/crypto';
import { randomUUID } from 'crypto';

const ORG_ID = '33262270-7100-4b46-b2fb-8b50ad872bbb';
const LOCATION_ID = 'c57268b3-cb14-4c1a-bda6-55e49ddc6313';

// GET: List all employees with their roles and location info
export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams.get('search')?.trim() || '';
  const page = Math.max(1, parseInt(request.nextUrl.searchParams.get('page') || '1'));
  const pageSize = Math.min(100, parseInt(request.nextUrl.searchParams.get('pageSize') || '50'));

  try {
    let whereExtra = '';
    const values: unknown[] = [ORG_ID];
    let idx = 2;

    if (search) {
      whereExtra = ` AND (e.first_name ILIKE $${idx} OR e.last_name ILIKE $${idx} OR e.display_name ILIKE $${idx} OR e.email ILIKE $${idx})`;
      values.push(`%${search}%`);
      idx++;
    }

    const countQ = `SELECT COUNT(*)::int as total FROM employees e WHERE e.organization_id = $1${whereExtra}`;
    const dataQ = `SELECT e.id, e.first_name, e.last_name, e.display_name, e.email, e.role_key, e.is_active, e.location_ids, e.pin_hint, e.created_at, e.updated_at
      FROM employees e
      WHERE e.organization_id = $1${whereExtra}
      ORDER BY e.last_name, e.first_name ASC
      LIMIT $${idx} OFFSET $${idx + 1}`;

    values.push(pageSize, (page - 1) * pageSize);

    const [countRes, dataRes] = await Promise.all([
      orgQuery(ORG_ID, countQ, values.slice(0, idx - 1)),
      orgQuery(ORG_ID, dataQ, values),
    ]);

    const employees = dataRes.rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: row.display_name,
      email: row.email,
      roleKey: row.role_key,
      isActive: row.is_active,
      locationIds: row.location_ids || [],
      pinHint: row.pin_hint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return NextResponse.json({
      employees,
      pagination: {
        page,
        pageSize,
        total: countRes.rows[0].total,
        totalPages: Math.ceil(countRes.rows[0].total / pageSize),
      },
    });
  } catch (error) {
    console.error('Employees GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch employees' }, { status: 500 });
  }
}

// POST: Create new employee with auth credential (PIN)
export async function POST(request: NextRequest) {
  try {
    const {
      firstName,
      lastName,
      displayName,
      email,
      phone,
      roleKey,
      pin,
      pinHint,
      locationIds,
    } = await request.json();

    // Validation
    if (!firstName?.trim() || !lastName?.trim() || !displayName?.trim()) {
      return NextResponse.json(
        { error: 'First name, last name, and display name are required' },
        { status: 400 }
      );
    }

    if (!pin || !/^\d{4,6}$/.test(pin)) {
      return NextResponse.json(
        { error: 'PIN must be 4-6 digits' },
        { status: 400 }
      );
    }

    if (!roleKey || !['owner', 'manager', 'cashier', 'inventory_clerk', 'support'].includes(roleKey)) {
      return NextResponse.json(
        { error: 'Invalid role' },
        { status: 400 }
      );
    }

    if (!Array.isArray(locationIds) || locationIds.length === 0) {
      return NextResponse.json(
        { error: 'At least one location must be assigned' },
        { status: 400 }
      );
    }

    const employeeId = randomUUID();
    const pinHash = hashSecret(pin);
    const now = new Date().toISOString();

    // Use orgQuery for RLS-scoped insertion
    const { rows } = await orgQuery(
      ORG_ID,
      `INSERT INTO employees (
        id, organization_id, role_key, first_name, last_name, display_name,
        email, phone, pin_hint, is_active, location_ids, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10::uuid[], $11, $11)
      RETURNING id, first_name, last_name, display_name, email, role_key, is_active, location_ids, pin_hint, created_at, updated_at`,
      [
        employeeId,
        ORG_ID,
        roleKey,
        firstName.trim(),
        lastName.trim(),
        displayName.trim(),
        email?.trim() || null,
        phone?.trim() || null,
        pinHint?.trim() || '',
        locationIds,
        now,
      ]
    );

    // Insert auth credentials (PIN only, no password)
    await pool.query(
      `INSERT INTO auth_credentials (
        employee_id, email, password_hash, pin_hash, pin_last_rotated_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $5, $5)`,
      [employeeId, email?.trim() || null, null, pinHash, now]
    );

    const employee = {
      id: rows[0].id,
      firstName: rows[0].first_name,
      lastName: rows[0].last_name,
      displayName: rows[0].display_name,
      email: rows[0].email,
      roleKey: rows[0].role_key,
      isActive: rows[0].is_active,
      locationIds: rows[0].location_ids || [],
      pinHint: rows[0].pin_hint,
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at,
    };

    return NextResponse.json({ employee }, { status: 201 });
  } catch (error) {
    console.error('Employees POST error:', error);
    return NextResponse.json({ error: 'Failed to create employee' }, { status: 500 });
  }
}

// PUT: Update employee details
export async function PUT(request: NextRequest) {
  try {
    const {
      id,
      firstName,
      lastName,
      displayName,
      email,
      phone,
      roleKey,
      pinHint,
      locationIds,
    } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'Employee ID required' }, { status: 400 });
    }

    // Build dynamic update query
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;

    if (firstName !== undefined) {
      sets.push(`first_name = $${idx++}`);
      vals.push(firstName);
    }
    if (lastName !== undefined) {
      sets.push(`last_name = $${idx++}`);
      vals.push(lastName);
    }
    if (displayName !== undefined) {
      sets.push(`display_name = $${idx++}`);
      vals.push(displayName);
    }
    if (email !== undefined) {
      sets.push(`email = $${idx++}`);
      vals.push(email || null);
    }
    if (phone !== undefined) {
      sets.push(`phone = $${idx++}`);
      vals.push(phone || null);
    }
    if (roleKey !== undefined) {
      sets.push(`role_key = $${idx++}`);
      vals.push(roleKey);
    }
    if (pinHint !== undefined) {
      sets.push(`pin_hint = $${idx++}`);
      vals.push(pinHint || '');
    }
    if (locationIds !== undefined) {
      sets.push(`location_ids = $${idx++}::uuid[]`);
      vals.push(locationIds);
    }

    if (sets.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    sets.push(`updated_at = $${idx++}`);
    vals.push(new Date().toISOString());
    vals.push(id);
    vals.push(ORG_ID);

    const { rows } = await pool.query(
      `UPDATE employees SET ${sets.join(', ')}
       WHERE id = $${idx} AND organization_id = $${idx + 1}
       RETURNING id, first_name, last_name, display_name, email, role_key, is_active, location_ids, pin_hint, created_at, updated_at`,
      vals
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const employee = {
      id: rows[0].id,
      firstName: rows[0].first_name,
      lastName: rows[0].last_name,
      displayName: rows[0].display_name,
      email: rows[0].email,
      roleKey: rows[0].role_key,
      isActive: rows[0].is_active,
      locationIds: rows[0].location_ids || [],
      pinHint: rows[0].pin_hint,
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at,
    };

    return NextResponse.json({ employee });
  } catch (error) {
    console.error('Employees PUT error:', error);
    return NextResponse.json({ error: 'Failed to update employee' }, { status: 500 });
  }
}

// PATCH: Toggle active status or reset PIN
export async function PATCH(request: NextRequest) {
  try {
    const { action, id, pin } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'Employee ID required' }, { status: 400 });
    }

    if (action === 'toggle-status') {
      // Toggle is_active status
      const { rows } = await pool.query(
        `UPDATE employees SET is_active = NOT is_active, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2
         RETURNING id, first_name, last_name, display_name, email, role_key, is_active, location_ids, pin_hint, created_at, updated_at`,
        [id, ORG_ID]
      );

      if (rows.length === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }

      const employee = {
        id: rows[0].id,
        firstName: rows[0].first_name,
        lastName: rows[0].last_name,
        displayName: rows[0].display_name,
        email: rows[0].email,
        roleKey: rows[0].role_key,
        isActive: rows[0].is_active,
        locationIds: rows[0].location_ids || [],
        pinHint: rows[0].pin_hint,
        createdAt: rows[0].created_at,
        updatedAt: rows[0].updated_at,
      };

      return NextResponse.json({ employee });
    } else if (action === 'reset-pin') {
      // Reset PIN
      if (!pin || !/^\d{4,6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be 4-6 digits' },
          { status: 400 }
        );
      }

      const pinHash = hashSecret(pin);
      const now = new Date().toISOString();

      const { rows } = await pool.query(
        `UPDATE auth_credentials SET pin_hash = $1, pin_last_rotated_at = $2, updated_at = $2
         WHERE employee_id = $3
         RETURNING employee_id`,
        [pinHash, now, id]
      );

      if (rows.length === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }

      return NextResponse.json({ success: true, message: 'PIN reset successfully' });
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Employees PATCH error:', error);
    return NextResponse.json({ error: 'Failed to update employee' }, { status: 500 });
  }
}
