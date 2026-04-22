/**
 * BuPOS Customer Management API
 * @tags customers
 */
import { NextResponse } from 'next/server';
import { orgQuery } from '@/lib/supabase-rest';
import { withAdminAuth } from '@/lib/api/with-auth';
import { pgInsertAuditEvent } from '@/lib/persistence/postgres-store';
import { validateBody, customerCreateSchema, customerUpdateSchema } from '@/lib/validation/schemas';
import { checkRateLimit } from '@/lib/auth/rate-limit';

import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
export const GET = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId } = ctx;

  // Escape SQL LIKE wildcards in search so % and _ are treated as literal characters
  const rawSearch = request.nextUrl.searchParams.get('search')?.trim() || '';
  const search = rawSearch.replace(/[%_\\]/g, '\\$&');
  const id = request.nextUrl.searchParams.get('id')?.trim() || '';
  const statsOnly = request.nextUrl.searchParams.get('stats')?.trim() === 'true';
  const pageSizeRaw = parseInt(request.nextUrl.searchParams.get('pageSize') || '50', 10);
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(100, pageSizeRaw) : 50;
  const cursorParam = request.nextUrl.searchParams.get('cursor')?.trim() || null;
  let cursorUpdatedAt: string | null = null;
  let cursorId: string | null = null;
  if (cursorParam) {
    try {
      const decoded = JSON.parse(Buffer.from(cursorParam, 'base64').toString('utf-8'));
      cursorUpdatedAt = decoded.updated_at ?? null;
      cursorId = decoded.id ?? null;
    } catch {
      // Invalid cursor — ignore
    }
  }

  // Stats-only mode: return aggregate stats without fetching customer rows
  if (statsOnly) {
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      // R13-H-6: the `$3` placeholder for monthStart hard-coded $3 whether
      // or not `search` was bound. When the admin customers page loads
      // without a search term it passes only [orgId, monthStart] (2
      // params), but the SQL reaches for $3 — every stats load 500s and
      // the client's if-!res.ok swallows it, rendering zero cards. Use a
      // dynamic placeholder so the bind-count matches the SQL.
      const searchWhere = search
        ? ` AND (first_name ILIKE $2 OR last_name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)`
        : '';
      const searchVal = search ? [`%${search}%`] : [];
      const monthStartIdx = searchVal.length + 2;

      const [statsRes] = await Promise.all([
        orgQuery(
          orgId,
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE created_at >= $${monthStartIdx})::int AS new_this_month,
             COALESCE(AVG(total_spend) FILTER (WHERE total_spend IS NOT NULL), 0)::numeric AS avg_spend,
             COALESCE(SUM(loyalty_points), 0)::bigint AS total_points
           FROM customers
           WHERE organization_id = $1${searchWhere}`,
          [orgId, ...searchVal, monthStart]
        ),
      ]);
      const s = statsRes.rows[0];
      return NextResponse.json({
        total: s.total,
        newThisMonth: s.new_this_month,
        avgSpend: Number(s.avg_spend) || 0,
        totalPointsOutstanding: Number(s.total_points) || 0,
      });
    } catch (error) {
      console.error('Customers stats error:', safeErr(error));
      return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
    }
  }

  try {
    // Single customer detail with purchase history
    if (id) {
      const [customerRes, transactionsRes, statsRes] = await Promise.all([
        orgQuery(
          orgId,
          `SELECT id, first_name, last_name, email, phone, address, notes, loyalty_points, total_spend, visit_count, store_credit_balance, is_active, created_at, updated_at FROM customers WHERE id = $1 AND organization_id = $2`,
          [id, orgId]
        ),
        orgQuery(
          orgId,
          `SELECT id, created_at, grand_total, customer_id, employee_id
           FROM transactions
           WHERE customer_id = $1 AND organization_id = $2
           ORDER BY created_at DESC LIMIT 20`,
          [id, orgId]
        ),
        orgQuery(
          orgId,
          `SELECT
             COUNT(*)::int as visit_count,
             COALESCE(SUM(grand_total), 0)::numeric as total_spend
           FROM transactions
           WHERE customer_id = $1 AND organization_id = $2`,
          [id, orgId]
        ),
      ]);

      if (customerRes.rows.length === 0) {
        return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
      }

      const customer = customerRes.rows[0];
      const stats = statsRes.rows[0];

      return NextResponse.json({
        customer: {
          ...customer,
          visit_count: stats.visit_count,
          total_spend: stats.total_spend,
        },
        transactions: transactionsRes.rows,
      });
    }

    // List customers with cursor-based pagination
    // R30-C1: the organization scope is STATIC in the base SQL — the
    // dynamic `${andClause}` only adds extra AND-predicates. The
    // guardrail cannot see into dynamic interpolation, so the static
    // predicate must be present regardless of what `andClause`
    // contains. Prior shape built the whole WHERE from `conditions`,
    // which silently returned every tenant's customers when `conditions`
    // was empty (no search, no cursor). Active cross-tenant PII leak.
    const extra: string[] = [];
    const values: unknown[] = [orgId];
    let idx = 2;

    if (search) {
      extra.push(`(c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR c.email ILIKE $${idx} OR c.phone ILIKE $${idx})`);
      values.push(`%${search}%`);
      idx++;
    }

    // Cursor: (updated_at, id) < (cursor_updated_at, cursor_id) for descending order
    if (cursorUpdatedAt !== null && cursorId !== null) {
      extra.push(`(c.updated_at, c.id) < ($${idx}, $${idx + 1})`);
      values.push(cursorUpdatedAt, cursorId);
      idx += 2;
    }

    const andClause = extra.length > 0 ? ` AND ${extra.join(" AND ")}` : "";

    // Fetch pageSize + 1 to determine if there's a next page
    const dataRes = await orgQuery(
      orgId,
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.address,
        c.loyalty_points, c.total_spend, c.visit_count, c.store_credit_balance,
        c.is_active, c.created_at, c.updated_at
        FROM customers c
        WHERE c.organization_id = $1${andClause}
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT $${idx}`,
      [...values, pageSize + 1],
    );

    const hasMore = dataRes.rows.length > pageSize;
    const customers = hasMore ? dataRes.rows.slice(0, pageSize) : dataRes.rows;

    let nextCursor: string | null = null;
    if (hasMore && customers.length > 0) {
      const last = customers[customers.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ id: last.id, updated_at: last.updated_at })).toString("base64");
    }

    return NextResponse.json({
      customers,
      nextCursor,
      hasMore,
    });
  } catch (error) {
    console.error('Customers GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch customers' }, { status: 500 });
  }
});

export const POST = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId, employee: _employee } = ctx;
  const rl = checkRateLimit(`customers:post:${orgId}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  try {
    const body = await request.json();
    const v = validateBody(customerCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { first_name, last_name, email, phone, address, notes } = v.data;

    // Explicit column list instead of `RETURNING *` so internal fields
    // (staff notes with fraud flags, future PII columns added by
    // migrations, etc.) never leak through the create response.
    const { rows } = await orgQuery(
      orgId,
      `INSERT INTO customers (organization_id, first_name, last_name, email, phone, address, notes, loyalty_points, total_spend, visit_count, store_credit_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0)
       RETURNING id, first_name, last_name, email, phone, address, loyalty_points, total_spend, visit_count, store_credit_balance, is_active, created_at, updated_at`,
      [orgId, first_name.trim(), last_name.trim(), email?.trim() || null, phone?.trim() || null, address?.trim() || null, notes?.trim() || null, 0],
    );
    return NextResponse.json({ customer: rows[0] }, { status: 201 });
  } catch (error) {
    console.error('Customers POST error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to create customer' }, { status: 500 });
  }
});

export const PUT = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId, employee } = ctx;
  const rl = checkRateLimit(`customers:put:${orgId}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  try {
    const body = await request.json();
    const v = validateBody(customerUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id, first_name, last_name, email, phone, address, notes, is_active } = v.data;

    // R37-H1: require step-up ONLY when the update actually CHANGES a
    // sensitive field. Prior R36-M8 shape fired on mere presence of
    // `notes` / `is_active` in the body — but every admin UI sends the
    // whole form (including unchanged `notes`), so any email-typo fix
    // 400'd with "Your password is required." Read the current row
    // first and diff; only gate when the sensitive fields actually move.
    //
    // Security intent unchanged:
    //   (a) can't flip is_active = false without step-up;
    //   (b) can't change `notes` (fraud flags / ban markers) without
    //       step-up.
    // Name/email/phone/address remain frictionless.
    const normNotes = (s: string | null | undefined) => (s?.trim() || null);
    let touchesSensitive = false;
    if (is_active !== undefined || notes !== undefined) {
      const { rows: currentRows } = await orgQuery(
        orgId,
        `SELECT is_active, notes FROM customers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [id, orgId],
      );
      if (currentRows.length === 0) {
        return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
      }
      const current = currentRows[0] as { is_active: boolean; notes: string | null };
      if (is_active !== undefined && Boolean(is_active) !== Boolean(current.is_active)) {
        touchesSensitive = true;
      }
      if (notes !== undefined && normNotes(notes) !== normNotes(current.notes)) {
        touchesSensitive = true;
      }
    }
    if (touchesSensitive) {
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const actorPassword = (body && typeof body === 'object')
        ? (body as { actorPassword?: string }).actorPassword
        : undefined;
      const stepUp = await requireStepUp({
        actorId: employee.id,
        orgId,
        actorPassword: typeof actorPassword === 'string' ? actorPassword : undefined,
        bucketKey: 'customer-update-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }
    }

    // Build dynamic UPDATE — only set fields that were provided, preserve others
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (first_name !== undefined) { sets.push(`first_name = $${i++}`); vals.push(first_name.trim()); }
    if (last_name !== undefined) { sets.push(`last_name = $${i++}`); vals.push(last_name.trim()); }
    if (email !== undefined) { sets.push(`email = $${i++}`); vals.push(email?.trim() || null); }
    if (phone !== undefined) { sets.push(`phone = $${i++}`); vals.push(phone?.trim() || null); }
    if (address !== undefined) { sets.push(`address = $${i++}`); vals.push(address?.trim() || null); }
    if (notes !== undefined) { sets.push(`notes = $${i++}`); vals.push(notes?.trim() || null); }
    if (is_active !== undefined) { sets.push(`is_active = $${i++}`); vals.push(is_active); }
    if (sets.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }
    sets.push(`updated_at = NOW()`);
    vals.push(id, orgId);
    // Explicit column list (see POST) — keeps `notes` server-side.
    const { rows } = await orgQuery(
      orgId,
      `UPDATE customers SET ${sets.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1}
       RETURNING id, first_name, last_name, email, phone, address, loyalty_points, total_spend, visit_count, store_credit_balance, is_active, created_at, updated_at`,
      vals,
    );
    if (rows.length === 0) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    const customer = rows[0];
    await waitUntilOrAwait(pgInsertAuditEvent(
      orgId, null, employee.id,
      "customer", id, "customer_updated",
      { id, first_name: customer.first_name, last_name: customer.last_name },
    ).catch((err) => console.error("[audit] Failed to insert audit event:", safeErr(err))));
    return NextResponse.json({ customer }, { status: 200 });
  } catch (error) {
    console.error('Customers PUT error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to update customer' }, { status: 500 });
  }
});

// R39-A1-1: right-to-be-forgotten. We do NOT hard-delete — that would
// wipe financial history (transactions, store_credit_ledger, layaways)
// that retail tax law requires for 7 years and that chargeback
// disputes need. Instead we null-anonymize PII IN PLACE:
//   • first_name → "[deleted]"
//   • last_name  → ""
//   • email      → NULL
//   • phone      → NULL
//   • address    → NULL
//   • notes      → NULL
//   • is_active  → false
// The row retains `id`, `loyalty_points=0`, `store_credit_balance=0`
// (both zeroed), `total_spend`, `visit_count`, `created_at`. Linked
// transactions keep their `customer_id` (RESTRICT FK per mig 068
// prevents accidental DELETE). Gated on step-up so a stolen cookie
// can't mass-anonymize customers. `employee.manage` permission +
// owner/manager role required.
export const DELETE = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId, employee } = ctx;
  if (employee.roleKey !== 'owner' && employee.roleKey !== 'manager') {
    return NextResponse.json({ error: 'Manager authority required' }, { status: 403 });
  }
  const rl = checkRateLimit(`customers:delete:${orgId}`, { maxAttempts: 10, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    const id = (body as { id?: string }).id;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid customer id' }, { status: 400 });
    }
    // Mandatory step-up — hard-scoped destructive action.
    const { requireStepUp } = await import('@/lib/auth/step-up');
    const actorPassword = (body as { actorPassword?: string }).actorPassword;
    const stepUp = await requireStepUp({
      actorId: employee.id,
      orgId,
      actorPassword: typeof actorPassword === 'string' ? actorPassword : undefined,
      bucketKey: 'customer-delete-stepup',
    });
    if (!stepUp.ok) {
      return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
    }
    // Check the customer isn't blocking: outstanding layaway, store
    // credit balance, or gift card balance. If so, require the
    // manager to unwind first (the FK RESTRICT would fail anyway on
    // a real hard-delete attempt; we enforce at the app layer too so
    // the error message is actionable).
    const { rows: blockerRows } = await orgQuery(
      orgId,
      `SELECT
         COALESCE((SELECT COUNT(*) FROM layaways WHERE customer_id = $1 AND status IN ('active', 'partially_paid')), 0)::int AS open_layaways,
         COALESCE((SELECT store_credit_balance FROM customers WHERE id = $1 AND organization_id = $2), 0)::numeric AS store_credit,
         COALESCE((SELECT SUM(balance) FROM gift_cards WHERE customer_id = $1 AND status = 'active'), 0)::numeric AS gift_cards`,
      [id, orgId],
    );
    const blocker = (blockerRows[0] ?? {}) as { open_layaways: number; store_credit: string; gift_cards: string };
    if (Number(blocker.open_layaways) > 0) {
      return NextResponse.json({
        error: `Customer has ${blocker.open_layaways} open layaway(s). Close or forfeit first.`,
      }, { status: 409 });
    }
    if (Number(blocker.store_credit) > 0.005) {
      return NextResponse.json({
        error: `Customer has ${blocker.store_credit} outstanding store credit. Redeem or zero out first.`,
      }, { status: 409 });
    }
    if (Number(blocker.gift_cards) > 0.005) {
      return NextResponse.json({
        error: `Customer holds ${blocker.gift_cards} in active gift card balances. Transfer or disable first.`,
      }, { status: 409 });
    }

    const { rows: updated } = await orgQuery(
      orgId,
      `UPDATE customers
          SET first_name = '[deleted]',
              last_name  = '',
              email      = NULL,
              phone      = NULL,
              address    = NULL,
              notes      = NULL,
              is_active  = false,
              loyalty_points = 0,
              store_credit_balance = 0,
              updated_at = NOW()
        WHERE id = $1 AND organization_id = $2
        RETURNING id`,
      [id, orgId],
    );
    if (updated.length === 0) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    }
    await waitUntilOrAwait(pgInsertAuditEvent(
      orgId, null, employee.id,
      "customer", id, "customer_anonymized",
      { id, right_to_be_forgotten: true },
    ).catch((err) => console.error("[audit] customer_anonymized failed:", safeErr(err))));
    return NextResponse.json({ success: true, anonymized: true });
  } catch (error) {
    console.error('Customers DELETE error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to anonymize customer' }, { status: 500 });
  }
});
