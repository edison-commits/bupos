/**
 * BuPOS Employee Management API
 * @tags employees
 */
import { NextRequest, NextResponse } from 'next/server';
import pool, { orgQuery } from '@/lib/db';
import { hashSecret, verifySecret } from '@/lib/auth/crypto';
import { randomUUID } from 'crypto';
import { canManageEmployeeRole } from '@/lib/authz';
import { checkRateLimit } from '@/lib/auth/rate-limit';
import type { RoleKey } from '@/lib/domain/types';
import { withAdminAuth } from '@/lib/api/with-auth';
import { invalidateEmployeesCache, pgInsertAuditEvent } from '@/lib/persistence/postgres-store';
import { validateBody, employeeCreateSchema, employeeUpdateSchema, employeePatchSchema } from '@/lib/validation/schemas';

/**
 * Invalidate all active sessions for an employee — both admin and register scopes.
 * Call this when the employee's role changes or they are deactivated so that
 * permission changes take effect immediately rather than waiting for session expiry.
 */
async function invalidateEmployeeSessions(employeeId: string): Promise<void> {
  await pool.query(
    `DELETE FROM sessions WHERE employee_id = $1`,
    [employeeId],
  );
}

// GET: List all employees with their roles and location info
export const GET = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId } = ctx;
  // Escape SQL LIKE wildcards in search so % and _ are treated as literal characters
  const rawSearch = request.nextUrl.searchParams.get('search')?.trim() || '';
  const search = rawSearch.replace(/[%_\\]/g, '\\$&');
  const pageRaw = parseInt(request.nextUrl.searchParams.get('page') || '1', 10);
  const pageSizeRaw = parseInt(request.nextUrl.searchParams.get('pageSize') || '50', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(100, pageSizeRaw) : 50;

  try {
    let whereExtra = '';
    const values: unknown[] = [orgId];
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
      orgQuery(orgId, countQ, values.slice(0, idx - 1)),
      orgQuery(orgId, dataQ, values),
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
});

// POST: Create new employee with auth credential (PIN)
export const POST = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId, employee: actor } = ctx;
  const rl = checkRateLimit(`employees:post:${orgId}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  try {
    const body = await request.json();
    const v = validateBody(employeeCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
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
    } = v.data;

    if (!canManageEmployeeRole(actor.roleKey, roleKey as RoleKey)) {
      return NextResponse.json(
        { error: 'Forbidden: you cannot assign the requested role' },
        { status: 403 }
      );
    }

    const employeeId = randomUUID();
    const pinHash = hashSecret(pin);
    const now = new Date().toISOString();

    // Stored PIN hashes are salted, so detect collisions by verifying against each stored hash.
    const { rows: allCreds } = await pool.query(
      `SELECT employee_id, pin_hash FROM auth_credentials WHERE pin_hash IS NOT NULL`,
    );
    const dup = await Promise.all(
      allCreds.map(async (row) => {
        const valid = await verifySecret(pin, row.pin_hash as string);
        return valid ? row.employee_id : null;
      }),
    );
    if (dup.some(Boolean)) {
      return NextResponse.json(
        { error: 'This PIN is already in use by another employee. Choose a different PIN.' },
        { status: 409 },
      );
    }

    // Use orgQuery for RLS-scoped insertion
    const { rows } = await orgQuery(
      orgId,
      `INSERT INTO employees (
        id, organization_id, role_key, first_name, last_name, display_name,
        email, phone, pin_hint, is_active, location_ids, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10::uuid[], $11, $11)
      RETURNING id, first_name, last_name, display_name, email, role_key, is_active, location_ids, pin_hint, created_at, updated_at`,
      [
        employeeId,
        orgId,
        roleKey,
        firstName.trim(),
        lastName.trim(),
        displayName?.trim() || `${firstName.trim()} ${lastName.trim()}`,
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

    invalidateEmployeesCache(orgId);
    pgInsertAuditEvent(
      orgId, null, actor.id,
      "employee", employee.id, "employee_created",
      { id: employee.id, display_name: employee.displayName, role_key: employee.roleKey },
    ).catch((err) => console.error("[audit] Failed to insert audit event:", err));
    return NextResponse.json({ employee }, { status: 201 });
  } catch (error) {
    console.error('Employees POST error:', error);
    return NextResponse.json({ error: 'Failed to create employee' }, { status: 500 });
  }
});

// PUT: Update employee details
export const PUT = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId, employee: actor } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(employeeUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
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
    } = v.data;

    if (roleKey !== undefined && !canManageEmployeeRole(actor.roleKey, roleKey as RoleKey)) {
      return NextResponse.json(
        { error: 'Forbidden: you cannot assign the requested role' },
        { status: 403 }
      );
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
    vals.push(orgId);

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

    // If role changed, invalidate all of the target employee's sessions immediately
    // so that the new (possibly lower) permissions take effect without waiting for expiry.
    if (roleKey !== undefined) {
      await invalidateEmployeeSessions(id);
    }

    invalidateEmployeesCache(orgId);
    pgInsertAuditEvent(
      orgId, null, actor.id,
      "employee", id, "employee_updated",
      { id, display_name: employee.displayName, role_key: employee.roleKey },
    ).catch((err) => console.error("[audit] Failed to insert audit event:", err));
    return NextResponse.json({ employee });
  } catch (error) {
    console.error('Employees PUT error:', error);
    return NextResponse.json({ error: 'Failed to update employee' }, { status: 500 });
  }
});

// PATCH: Toggle active status or reset PIN
export const PATCH = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId, employee: actor } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(employeePatchSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { action, id, pin } = v.data;

    if (action === 'deactivate') {
      // Toggle is_active status
      const { rows } = await pool.query(
        `UPDATE employees SET is_active = NOT is_active, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2
         RETURNING id, first_name, last_name, display_name, email, role_key, is_active, location_ids, pin_hint, created_at, updated_at`,
        [id, orgId]
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

      // If the employee was just deactivated, kill all their sessions immediately
      // so they cannot continue to act with their old permissions.
      if (!rows[0].is_active) {
        await invalidateEmployeeSessions(id);
      }

      invalidateEmployeesCache(orgId);
      return NextResponse.json({ employee });
    } else if (action === 'reset_pin') {
      // Reset PIN
      if (!pin || !/^\d{4,6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be 4-6 digits' },
          { status: 400 }
        );
      }

      const pinHash = hashSecret(pin);
      const now = new Date().toISOString();

      // Stored PIN hashes are salted, so detect collisions by verifying against each stored hash.
      const { rows: allCreds } = await pool.query(
        `SELECT employee_id, pin_hash
         FROM auth_credentials
         WHERE pin_hash IS NOT NULL AND employee_id != $1`,
        [id],
      );
      const dup = await Promise.all(
        allCreds.map(async (row) => {
          const valid = await verifySecret(pin, row.pin_hash as string);
          return valid ? row.employee_id : null;
        }),
      );
      if (dup.some(Boolean)) {
        return NextResponse.json(
          { error: 'This PIN is already in use by another employee. Choose a different PIN.' },
          { status: 409 },
        );
      }

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
});
