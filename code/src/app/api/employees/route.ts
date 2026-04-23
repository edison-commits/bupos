/**
 * BuPOS Employee Management API
 * @tags employees
 */
import { NextResponse } from 'next/server';
import { orgQuery, getPool } from '@/lib/supabase-rest';
import { hashSecret, verifySecret } from '@/lib/auth/crypto';
import { randomUUID } from '@/lib/uuid';
import { canManageEmployeeRole } from '@/lib/authz';
import { checkRateLimit } from '@/lib/auth/rate-limit';
import type { RoleKey } from '@/lib/domain/types';
import { withAdminAuth } from '@/lib/api/with-auth';
import { invalidateEmployeesCache } from '@/lib/persistence/postgres-store';
import { validateBody, employeeCreateSchema, employeeUpdateSchema, employeePatchSchema } from '@/lib/validation/schemas';
import { waitUntilOrAwait } from '@/lib/runtime/wait-until';

import { safeErr } from "@/lib/logging/safe-err";
/**
 * Invalidate all active sessions for an employee — both admin and register scopes.
 * Call this when the employee's role changes or they are deactivated so that
 * permission changes take effect immediately rather than waiting for session expiry.
 */
async function invalidateEmployeeSessions(employeeId: string, orgId: string): Promise<void> {
  const pool = await getPool();
  // Scope by org defensively — if a future caller passes an id from the wrong
  // tenant, this won't wipe another org's sessions.
  await pool.query(
    `DELETE FROM sessions
     WHERE employee_id = $1
       AND employee_id IN (SELECT id FROM employees WHERE organization_id = $2)`,
    [employeeId, orgId],
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
    console.error('Employees GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch employees' }, { status: 500 });
  }
});

// POST: Create new employee with auth credential (PIN)
export const POST = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId, employee: actor } = ctx;
  // R66-M3: per-actor 60/60s bucket. Prior default (3/5min per-org)
  // shared the bucket across admins — two managers onboarding staff
  // simultaneously 429'd each other after 3 creates. Employee
  // creation is a legitimate bursty operation during onboarding.
  const rl = checkRateLimit(`employees:post:${orgId}:${actor.id}`, { maxAttempts: 60, windowMs: 60_000 });
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

    // R54-C1 (CRITICAL): step-up re-auth on employee provisioning.
    // Prior shape had only RBAC + rate-limit; a stolen admin cookie
    // could directly `fetch('/api/employees', {method:'POST', body:
    // {roleKey:'owner', pin:'000000', password:'x', ...}})` to mint
    // a SHADOW OWNER ACCOUNT without the password re-auth gate. The
    // parallel Server Action `createEmployeeAction` already gates
    // on bucketKey:'employees-create-stepup' (R49); that bucket is
    // reused here so the aggregate-per-actor cap covers both
    // surfaces. Comment at actions.ts:475-476 explicitly claimed
    // this gate existed on POST — it did not, until this fix.
    const { requireStepUp } = await import('@/lib/auth/step-up');
    const stepUp = await requireStepUp({
      actorId: actor.id,
      orgId,
      actorPassword: (body as { actorPassword?: string })?.actorPassword,
      bucketKey: 'employees-create-stepup',
    });
    if (!stepUp.ok) {
      return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
    }

    // R27-H1: privileged roles (owner/manager) unlock admin-level
    // endpoints via withDualAuth's role check, so their PIN needs
    // more bits than a cashier's 4-digit PIN. Require 6 digits —
    // raises the brute-force space from 10⁴ to 10⁶, extending the
    // per-IP-limited attack from hours to months.
    if ((roleKey === 'owner' || roleKey === 'manager') && pin.length < 6) {
      return NextResponse.json(
        { error: 'Owner and manager PINs must be at least 6 digits.' },
        { status: 400 }
      );
    }

    const employeeId = randomUUID();
    const pinHash = await hashSecret(pin);
    const now = new Date().toISOString();

    // Stored PIN hashes are salted, so detect collisions by verifying against each stored hash.
    // Scope to current org only to prevent cross-tenant side-channel and DoS.
    const pool = await getPool();
    const { rows: allCreds } = await pool.query(
      `SELECT ac.employee_id, ac.pin_hash FROM auth_credentials ac
       JOIN employees e ON e.id = ac.employee_id
       WHERE ac.pin_hash IS NOT NULL AND e.organization_id = $1`,
      [ctx.orgId],
    );
    // R16-M-2: serial-with-early-exit (same shape as R15-M-1 applied to
    // login paths). `Promise.all(map(verifySecret))` fanned N concurrent
    // PBKDF2 calls → CPU DoS on Workers. Break on first duplicate — any
    // further verifications are wasted work.
    let duplicate = false;
    for (const row of allCreds) {
      if (await verifySecret(pin, row.pin_hash as string)) { duplicate = true; break; }
    }
    if (duplicate) {
      return NextResponse.json(
        { error: 'This PIN is already in use by another employee. Choose a different PIN.' },
        { status: 409 },
      );
    }

    // Atomic insert: employee + credentials in a single transaction so a failure
    // can't leave an orphan employee row with no way to log in.
    const { orgTx } = await import('@/lib/supabase-rest');
    const client = await orgTx(orgId);
    interface EmployeeRow {
      id: string;
      first_name: string;
      last_name: string;
      display_name: string;
      email: string | null;
      role_key: string;
      is_active: boolean;
      location_ids: string[] | null;
      pin_hint: string;
      created_at: string;
      updated_at: string;
    }
    let rows: EmployeeRow[] = [];
    try {
      // R18-INFO-1: verify every locationIds[] element belongs to caller's
      // org. The column has no per-element FK and Zod only enforces uuid
      // shape, so foreign UUIDs silently landed in the array. Downstream
      // uses are RLS-scoped (non-exploitable), but foreign UUIDs pollute
      // the record.
      if (locationIds.length > 0) {
        const { rows: locCheck } = await client.query(
          `SELECT id FROM locations WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
          [locationIds, orgId],
        );
        if (locCheck.length !== new Set(locationIds).size) {
          await client.query('ROLLBACK');
          return NextResponse.json(
            { error: 'One or more location_ids do not belong to this organization' },
            { status: 400 },
          );
        }
      }

      const r = await client.query(
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
        ],
      );
      rows = r.rows;

      // check-pool-org-filter: scoped-by-just-created-employee (employeeId was
      // just INSERTed above into ctx.orgId's employees table; no foreign
      // tenant can reach this)
      await client.query(
        `INSERT INTO auth_credentials (
          employee_id, email, password_hash, pin_hash, pin_last_rotated_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $5, $5)`,
        [employeeId, email?.trim() || null, null, pinHash, now],
      );

      // R49: audit INSIDE the tx. employee_created is a privilege-
      // provisioning action — post-commit audit failures here hide
      // whoever added the shadow account. Moved from post-commit
      // pgInsertAuditEvent into the existing orgTx block.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'employee', $5, 'employee_created', $6, now())`,
        [
          randomUUID(), orgId, null, actor.id, employeeId,
          JSON.stringify({
            id: employeeId,
            display_name: rows[0].display_name,
            role_key: rows[0].role_key,
          }),
        ],
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      // R74-C: the auth_credentials email index (migration 051:55,
      // `uniq_auth_credentials_email_lower`) fires 23505 when two
      // employees share an email. Prior shape surfaced as a generic
      // 500 "Failed to create employee" — masking a resolvable
      // conflict. Return 409 with an actionable message.
      const err = e as { code?: string };
      if (err?.code === '23505') {
        return NextResponse.json(
          { error: 'An employee with this email already exists. Choose a different email.' },
          { status: 409 },
        );
      }
      throw e;
    } finally {
      client.release();
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

    invalidateEmployeesCache(orgId);
    return NextResponse.json({ employee }, { status: 201 });
  } catch (error) {
    console.error('Employees POST error:', safeErr(error));
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

    // R32-H10: step-up on role/email/locationIds changes. These are
    // the privilege-elevation vectors a compromised manager cookie
    // would use to escalate a cashier to manager (which, per
    // R32 permissions audit, ≈ owner in practice). Match the R28-H4
    // pattern the PATCH handler enforces. Non-privilege-affecting
    // edits (firstName, lastName, displayName, phone, pinHint) do
    // NOT require step-up since they're low-blast-radius.
    // R42-R: `isActive` added to the gate even though the current PUT
    // SET-builder silently drops it. Defense-in-depth — if a future
    // change wires isActive into the dynamic UPDATE (or the schema
    // drops it entirely), activation/deactivation MUST continue to
    // require step-up (mirroring PATCH). Without this, adding one
    // line to the SET builder creates a privilege-escalation hole
    // where a stolen cookie can deactivate peer owners.
    const privilegedEdit =
      roleKey !== undefined
      || email !== undefined
      || locationIds !== undefined
      || v.data.isActive !== undefined;
    if (privilegedEdit) {
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: actor.id,
        orgId,
        actorPassword: (body as { actorPassword?: string }).actorPassword,
        bucketKey: 'employees-put-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }
    }

    // Role-gate the target employee too, otherwise a manager could edit the
    // owner's email / locationIds / etc. without ever setting roleKey.
    {
      const pool = await getPool();
      const { rows: targetRows } = await pool.query(
        `SELECT role_key FROM employees WHERE id = $1 AND organization_id = $2`,
        [id, orgId],
      );
      if (targetRows.length === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }
      const targetRole = targetRows[0].role_key as string;
      if (!canManageEmployeeRole(actor.roleKey, targetRole as RoleKey)) {
        // R29-M1: generic message — see PATCH handler for rationale.
        // Interpolating the role into the response body is a cheap
        // discriminator attackers can use to probe employee_ids.
        void targetRole;
        return NextResponse.json(
          { error: 'Insufficient permissions to edit this employee' },
          { status: 403 }
        );
      }

      // R31-C1: apply the same self-management + owner-on-owner checks
      // the PATCH handler enforces (R30-H3). Prior shape was a
      // REGRESSION of R30-H3 — a compromised owner session could PUT
      // any other owner's email/locationIds (+ email-sync to
      // auth_credentials then login path), silently deactivate via
      // isActive: false, or flip locations for impersonation. Blocks
      // owner-on-owner edit AND all self-edits that would change
      // role/email/locationIds/isActive — fields that can lock the
      // actor out of their own account.
      const isSelfEdit = actor.id === id;
      if (isSelfEdit && (
        (roleKey !== undefined && roleKey !== actor.roleKey) ||
        email !== undefined ||
        locationIds !== undefined ||
        v.data.isActive !== undefined
      )) {
        return NextResponse.json(
          { error: 'You cannot change your own role, email, locations, or activation. Ask another manager.' },
          { status: 403 },
        );
      }
      if (!isSelfEdit && actor.roleKey === 'owner' && targetRole === 'owner') {
        return NextResponse.json(
          { error: 'Insufficient permissions to edit this employee' },
          { status: 403 },
        );
      }
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
      // R18-INFO-1: verify every locationIds[] element belongs to caller's
      // org. See POST handler for full rationale.
      if (locationIds.length > 0) {
        const { rows: locCheck } = await orgQuery(
          orgId,
          `SELECT id FROM locations WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
          [locationIds, orgId],
        );
        if (locCheck.length !== new Set(locationIds).size) {
          return NextResponse.json(
            { error: 'One or more location_ids do not belong to this organization' },
            { status: 400 },
          );
        }
      }
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

    // R49: wrap the employees UPDATE + auth_credentials email sync +
    // audit row into one orgTx. Prior shape ran each piece via orgQuery
    // and attempted a best-effort revert on the 23505 collision — the
    // comment explicitly flagged "Long-term this belongs inside a
    // single tx". Post-commit audit was also dropped on failure. Now
    // the whole thing is atomic: if either step fails, nothing lands.
    const { orgTx } = await import("@/lib/supabase-rest");
    const client = await orgTx(orgId);
    type EmployeeReturnRow = {
      id: string;
      first_name: string;
      last_name: string;
      display_name: string;
      email: string | null;
      role_key: string;
      is_active: boolean;
      location_ids: string[] | null;
      pin_hint: string;
      created_at: string;
      updated_at: string;
    };
    let rows: EmployeeReturnRow[] = [];
    try {
      const updRes = await client.query<EmployeeReturnRow>(
        `UPDATE employees SET ${sets.join(', ')}
         WHERE id = $${idx} AND organization_id = $${idx + 1}
         RETURNING id, first_name, last_name, display_name, email, role_key, is_active, location_ids, pin_hint, created_at, updated_at`,
        vals,
      );
      rows = updRes.rows;
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }

      // R27-M4: keep auth_credentials.email in sync with employees.email.
      // Running inside the same tx means a 23505 collision rolls back
      // the employees.email change cleanly.
      if (email !== undefined) {
        try {
          await client.query(
            `UPDATE auth_credentials
                SET email = $1, updated_at = NOW()
              WHERE employee_id = $2
                AND employee_id IN (SELECT id FROM employees WHERE organization_id = $3)`,
            [email || null, id, orgId],
          );
        } catch (err) {
          const e = err as { code?: string };
          if (e.code === '23505') {
            await client.query("ROLLBACK");
            return NextResponse.json(
              { error: 'That email is already registered to another account.' },
              { status: 409 },
            );
          }
          throw err;
        }
      }

      // R49: audit INSIDE the tx. Employee role / email / location
      // changes are privilege-escalation vectors (per the step-up
      // gate rationale above) — audit must not be lossy on failure.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'employee', $5, 'employee_updated', $6, now())`,
        [
          randomUUID(), orgId, null, actor.id, id,
          JSON.stringify({
            id,
            display_name: rows[0].display_name,
            role_key: rows[0].role_key,
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
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
      await invalidateEmployeeSessions(id, orgId);
    }
    // R27-M4: invalidate sessions on email change too so the old
    // email can't be used to re-authenticate with a stale cookie
    // after the login-email changes.
    if (email !== undefined) {
      await invalidateEmployeeSessions(id, orgId);
    }

    invalidateEmployeesCache(orgId);
    return NextResponse.json({ employee });
  } catch (error) {
    console.error('Employees PUT error:', safeErr(error));
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
    const { action, id, pin, actorPassword } = v.data;

    // R45-M: step-up gate hoisted ABOVE the role-lookup so every
    // probe — even ones that would fail the "target not found" or
    // "insufficient permissions" check — pays a rate-limit tick.
    // Prior ordering (role-lookup first) let an attacker without the
    // actor password enumerate employee_ids / role tiers / self-vs-
    // peer status at zero rate-limit cost: the 404 vs 403 difference
    // discriminates which UUIDs exist, and the 403 message shape
    // discriminates role tiers (per R29-M1 comment). Running step-up
    // FIRST makes every non-authorized probe burn a bucket attempt,
    // bounding enumeration by the step-up cap (3/5min in-mem + 4/5min
    // KV + aggregate-per-actor). Mirrors /api/gift-cards POST's
    // R33-M-stepup-order rationale.
    const { requireStepUp } = await import('@/lib/auth/step-up');
    const stepUp = await requireStepUp({
      actorId: actor.id,
      orgId,
      actorPassword,
      bucketKey: 'employees-patch-stepup',
    });
    if (!stepUp.ok) {
      return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
    }

    // Role-gate via orgQuery so RLS is evaluated even on the read.
    const { rows: targetRows } = await orgQuery(
      orgId,
      `SELECT role_key FROM employees WHERE id = $1 AND organization_id = $2`,
      [id, orgId],
    );
    if (targetRows.length === 0) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }
    const targetRole = targetRows[0].role_key as string;
    if (!canManageEmployeeRole(actor.roleKey, targetRole as RoleKey)) {
      // R29-M1: hide the target's role in the error message. The prior
      // shape interpolated targetRole into the response, letting an
      // attacker probing employee_ids discriminate roles by error
      // string (manager / owner / cashier were all distinguishable).
      // The audit trail still records the target role via
      // pgInsertAuditEvent below, but the client-visible message is now
      // uniform — denying the side channel without losing investigator
      // signal.
      return NextResponse.json({ error: 'Insufficient permissions to manage this employee' }, { status: 403 });
    }

    // R30-H3: block self-management for state-change actions.
    // canManageEmployeeRole("owner", "owner") unconditionally returns
    // true, which let a compromised owner session:
    //   (a) deactivate the real owner (is_active=false invalidates
    //       their login — full lockout of the rightful owner)
    //   (b) reset the real owner's OR another owner's PIN
    //   (c) perform owner-on-owner mutations without peer review
    // Self-deactivation via PATCH also accidentally-locks-out even
    // legitimate actors. Self-PIN-reset is allowed (owners can
    // rotate their own PIN via the admin UI) only for the `reset_pin`
    // action since that still requires re-entry of the actor's
    // current password via step-up.
    const isSelf = actor.id === id;
    if (isSelf && (v.data.action === 'activate' || v.data.action === 'deactivate')) {
      return NextResponse.json(
        { error: 'You cannot change your own activation status. Ask another manager to do it.' },
        { status: 403 },
      );
    }
    // Owner-on-owner mutations (peer actions) are refused regardless
    // of whether canManageEmployeeRole returned true. A multi-owner
    // shop needs a break-glass pathway that isn't "any owner can
    // silently disable any other". The error shape matches the
    // generic R29-M1 message so probers can't discriminate.
    if (!isSelf && actor.roleKey === 'owner' && targetRole === 'owner') {
      return NextResponse.json(
        { error: 'Insufficient permissions to manage this employee' },
        { status: 403 },
      );
    }

    // R45-M: step-up moved to TOP of handler (see above). The prior
    // duplicate call here was removed — running step-up twice burns
    // two rate-limit slots per request.

    if (action === 'activate' || action === 'deactivate') {
      // R28-H4: explicit state set — no more `is_active = NOT is_active`
      // toggle. Refuse no-op transitions so an attacker can't use the
      // toggle to disguise a deactivate-then-reactivate chain (which
      // would bypass the detected-DoS-was-reverted audit pattern).
      const targetActive = action === 'activate';

      // R49: wrap UPDATE + audit in one orgTx. Activation/deactivation
      // toggles privilege state — post-commit audit failures hide the
      // actor on deactivation attacks (locking out legitimate owners).
      const { orgTx } = await import("@/lib/supabase-rest");
      const client = await orgTx(orgId);
      type EmpRow = {
        id: string;
        first_name: string;
        last_name: string;
        display_name: string;
        email: string | null;
        role_key: string;
        is_active: boolean;
        location_ids: string[] | null;
        pin_hint: string;
        created_at: string;
        updated_at: string;
      };
      let rows: EmpRow[] = [];
      try {
        const upd = await client.query<EmpRow>(
          `UPDATE employees SET is_active = $1, updated_at = NOW()
           WHERE id = $2 AND organization_id = $3 AND is_active != $1
           RETURNING id, first_name, last_name, display_name, email, role_key, is_active, location_ids, pin_hint, created_at, updated_at`,
          [targetActive, id, orgId]
        );
        rows = upd.rows;

        if (rows.length === 0) {
          await client.query("ROLLBACK");
          // Either employee missing OR already in the target state. Pull
          // current state to disambiguate for the client.
          const { rows: currentRows } = await orgQuery(
            orgId,
            `SELECT is_active FROM employees WHERE id = $1 AND organization_id = $2`,
            [id, orgId],
          );
          if (currentRows.length === 0) {
            return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
          }
          return NextResponse.json(
            { error: `Employee is already ${targetActive ? 'active' : 'inactive'}` },
            { status: 409 }
          );
        }

        // Audit the status change INSIDE the tx. Previously this branch
        // was silent on post-commit audit failures — if a compromised
        // manager session was used to disable cashiers (DoS) or reactivate
        // a previously-fired employee, investigators had no reliable
        // record. The field update bumps updated_at but says nothing
        // about the actor or the prior state.
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'employee', $5, $6, $7, now())`,
          [
            randomUUID(), orgId, null, actor.id, id,
            rows[0].is_active ? "employee_activated" : "employee_deactivated",
            JSON.stringify({ target_role: targetRole, actor_email: actor.email ?? null }),
          ],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
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
        await invalidateEmployeeSessions(id, orgId);
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

      // R27-H1: enforce 6-digit PIN for owner/manager roles on PIN
      // reset too — otherwise a manager could reset their own PIN to
      // "1234" right after signup and defeat the stronger requirement
      // applied at employee creation.
      if ((targetRole === 'owner' || targetRole === 'manager') && pin.length < 6) {
        return NextResponse.json(
          { error: 'Owner and manager PINs must be at least 6 digits.' },
          { status: 400 }
        );
      }

      // R28-H4: step-up auth (password re-entry + rate limit + KV) is
      // now performed ONCE at the top of the handler for all three
      // actions. The per-branch step-up block that previously lived
      // here is consolidated there. Proceed with the PIN reset.

      const pinHash = await hashSecret(pin);
      const now = new Date().toISOString();

      // Stored PIN hashes are salted, so detect collisions by verifying against each stored hash.
      // Scope to current org only to prevent cross-tenant side-channel.
      const { rows: allCreds } = await orgQuery(
        orgId,
        `SELECT ac.employee_id, ac.pin_hash
         FROM auth_credentials ac
         JOIN employees e ON e.id = ac.employee_id
         WHERE ac.pin_hash IS NOT NULL AND ac.employee_id != $1 AND e.organization_id = $2`,
        [id, ctx.orgId],
      );
      // R16-M-2: serial-with-early-exit; see POST handler above.
      let duplicate = false;
      for (const row of allCreds) {
        if (await verifySecret(pin, row.pin_hash as string)) { duplicate = true; break; }
      }
      if (duplicate) {
        return NextResponse.json(
          { error: 'This PIN is already in use by another employee. Choose a different PIN.' },
          { status: 409 },
        );
      }

      // R49: wrap UPDATE + audit in one orgTx. pin_reset is the most
      // common impersonation-attack vector in a retail POS (reset
      // peer's PIN, log in as them, take the heat); audit must land
      // with the PIN change.
      const { orgTx } = await import("@/lib/supabase-rest");
      const pinClient = await orgTx(orgId);
      try {
        // Scope to current org — prevent cross-tenant PIN reset.
        // R27-H1: also reset failed_pin_attempts so an admin-driven PIN
        // rotation clears any prior brute-force lockout on that
        // credential. Semantically the credential is new.
        const { rows: pinRows } = await pinClient.query(
          `UPDATE auth_credentials
              SET pin_hash = $1,
                  pin_last_rotated_at = $2,
                  updated_at = $2,
                  failed_pin_attempts = 0,
                  last_failed_pin_at = NULL
           WHERE employee_id = $3
             AND employee_id IN (SELECT id FROM employees WHERE organization_id = $4)
           RETURNING employee_id`,
          [pinHash, now, id, ctx.orgId]
        );

        if (pinRows.length === 0) {
          await pinClient.query("ROLLBACK");
          return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
        }

        // Audit the PIN reset INSIDE the tx. pin_last_rotated_at shows
        // the timestamp but not who changed it — the audit row carries
        // the actor. Post-commit audit drop was a critical gap for
        // impersonation-after-PIN-change investigations.
        await pinClient.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'employee', $5, 'pin_reset', $6, now())`,
          [
            randomUUID(), orgId, null, actor.id, id,
            JSON.stringify({ target_role: targetRole, actor_email: actor.email ?? null }),
          ],
        );
        await pinClient.query("COMMIT");
      } catch (e) {
        await pinClient.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        pinClient.release();
      }

      // R76-SEC-H2 (HIGH): invalidate existing sessions for the target
      // employee. Prior shape committed the new pin_hash + audit +
      // notification email but left every live `sessions` row
      // untouched — the #1 reason a victim asks for a PIN reset
      // (suspected cookie compromise) was defeated silently because
      // the attacker's stolen cookie remained valid until natural
      // expiry. Matches the PUT email-change / role-change path
      // (line 596, 602) and deactivate path (line 795). Mirrors
      // password-change / password-reset-confirm session DELETE on
      // credential rotation.
      await invalidateEmployeeSessions(id, orgId);

      // R27-M7: notify the employee whose PIN was reset. Best-effort
      // email via Resend — the target's `email` may be missing or
      // unverified in some installations; in that case we skip silently
      // rather than failing the reset. Notification is the only way
      // a victim of session-theft-driven PIN reset can detect the
      // attack; the audit row is invisible to non-admins.
      try {
        const { rows: targetInfo } = await orgQuery(
          orgId,
          `SELECT email, first_name FROM employees WHERE id = $1 AND organization_id = $2`,
          [id, orgId],
        );
        const target = targetInfo[0] as { email?: string; first_name?: string } | undefined;
        const toEmail = target?.email ?? null;
        const apiKey = process.env.RESEND_API_KEY;
        // R36-drift: standardize on RESEND_FROM_EMAIL — see
        // password-reset-initiate/route.ts for rationale.
        const fromEmail = process.env.RESEND_FROM_EMAIL ?? "noreply@basicuniformpos.com";
        if (toEmail && apiKey) {
          const actorName = actor.displayName || actor.email || "a manager";
          // R28-M5: use the shared escapeHtml helper (covers `& < > " '`).
          // The previous inline helper only covered `& < >` — safe for
          // the current element-context usage but fragile for future
          // edits that might move a user field into an attribute.
          const { escapeHtml: esc } = await import("@/lib/format/html-escape");
          const notifyPromise = fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: fromEmail,
              to: [toEmail],
              subject: "Your BasicUniformPOS PIN was reset",
              html: `
                <p>Hi ${esc(target?.first_name ?? "")},</p>
                <p>Your register PIN was just reset by <strong>${esc(actorName)}</strong>.</p>
                <p>If this was expected (e.g., you asked a manager to reset it),
                   you can ignore this email. If NOT, reply to this message or
                   contact your store owner immediately — someone may be
                   using a compromised manager account to impersonate you.</p>
                <p>Time: ${new Date().toISOString()}</p>
              `,
            }),
            signal: AbortSignal.timeout(10_000),
          }).then(async (r) => {
            if (!r.ok) {
              const err = await r.text().catch(() => "");
              console.error("[pin-reset notify] Resend:", safeErr(err));
            }
          }).catch((err) => console.error("[pin-reset notify] fetch:", safeErr(err)));
          await waitUntilOrAwait(notifyPromise);
        }
      } catch (err) {
        console.error("[pin-reset notify] prep:", safeErr(err));
      }

      return NextResponse.json({ success: true, message: 'PIN reset successfully' });
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Employees PATCH error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to update employee' }, { status: 500 });
  }
});
