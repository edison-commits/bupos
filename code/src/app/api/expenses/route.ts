import { NextResponse } from 'next/server';
import { orgQuery } from '@/lib/supabase-rest';
import { withDualAuth, withAdminAuth } from '@/lib/api/with-auth';
import { validateBody, expenseCreateSchema, expenseDeleteSchema } from '@/lib/validation/schemas';

import { safeErr } from "@/lib/logging/safe-err";
export const GET = withDualAuth("audit.view", async (request, ctx) => {
  const { orgId } = ctx;

  const month = request.nextUrl.searchParams.get('month') || ''; // YYYY-MM
  const category = request.nextUrl.searchParams.get('category') || '';
  const pageSize = Math.min(Math.max(1, Number(request.nextUrl.searchParams.get('pageSize')) || 100), 500);

  try {
    // R30-C3: the `e.organization_id = $1` predicate is STATIC in
    // both SQL bodies below. Prior shape buried it in a variable
    // `where` that was interpolated via `${where}`, invisible to the
    // guardrail. `extra` now carries ONLY the additional AND-filters.
    const extra: string[] = [];
    const values: unknown[] = [orgId];
    let idx = 2;

    // R13-H-8: audit.view is held by inventory_clerk + support. Without this
    // filter they read every store's expense ledger — vendor names, amounts,
    // reimbursement descriptions. Same retrofit as R12's other lists.
    if (ctx.allowedLocations !== null) {
      if (ctx.allowedLocations.length === 0) {
        return NextResponse.json({ expenses: [], summary: [], grandTotal: 0 });
      }
      extra.push(`e.location_id = ANY($${idx}::uuid[])`);
      values.push(ctx.allowedLocations);
      idx++;
    }

    if (month) {
      extra.push(`TO_CHAR(e.expense_date, 'YYYY-MM') = $${idx}`);
      values.push(month);
      idx++;
    }
    if (category) {
      extra.push(`e.category = $${idx}`);
      values.push(category);
      idx++;
    }

    const andClause = extra.length > 0 ? ` AND ${extra.join(' AND ')}` : '';

    // R30-M2: JOIN defense-in-depth — gate locations by org too so a
    // cross-tenant location FK can't splice a foreign name in.
    const { rows } = await orgQuery(
      orgId,
      `SELECT e.id, e.category, e.description, e.amount, e.expense_date, e.is_recurring, e.recurrence_period, e.notes, e.location_id, e.receipt_url, e.created_at, l.name as location_name FROM expenses e
       JOIN locations l ON e.location_id = l.id AND l.organization_id = $1
       WHERE e.organization_id = $1${andClause} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT $${idx}`,
      [...values, pageSize],
    );

    // Summary by category (unaffected by pagination — covers full filtered set)
    const { rows: summary } = await orgQuery(
      orgId,
      `SELECT e.category, SUM(e.amount)::numeric(12,2) as total, COUNT(*)::int as count
       FROM expenses e WHERE e.organization_id = $1${andClause} GROUP BY e.category ORDER BY total DESC`,
      values,
    );

    const grandTotal = summary.reduce((s, r) => s + Number(r.total), 0);

    return NextResponse.json({ expenses: rows, summary, grandTotal });
  } catch (error) {
    console.error('Expenses GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch expenses' }, { status: 500 });
  }
});

// Expenses affect bookkeeping (EOD reports, exports, tax prep). Previously
// gated on catalog.manage which inventory_clerk holds — a SKU-management
// role shouldn't be able to record $10M expenses or delete finance records.
// employee.manage is owner/manager-only, consistent with tax-config,
// settings, and loyalty routes.
// R27-H2: expense entry is back-office; manager-PIN register sessions
// shouldn't be able to enter expenses. GET stays dual for visibility.
export const POST = withAdminAuth("employee.manage", async (request, ctx) => {
  const { orgId, locationId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(expenseCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { category, description, amount, expense_date, is_recurring, recurrence_period, notes } = v.data;

    // Per-expense hard cap. The generic nonnegativeNumber schema allows up to
    // $10M, which is far beyond any legitimate single entry. $1M catches
    // typos and limits the blast radius of a compromised manager session.
    const MAX_EXPENSE_AMOUNT = 1_000_000;
    if (amount > MAX_EXPENSE_AMOUNT) {
      const { formatCurrency } = await import('@/lib/format');
      return NextResponse.json(
        { error: `Expense exceeds per-entry cap of ${formatCurrency(MAX_EXPENSE_AMOUNT)}` },
        { status: 400 },
      );
    }

    // R49: step-up re-auth on expenses >= $500. Fake-expense entries
    // are the classic pairing with a drawer pay_out to launder a cash
    // short. $500 threshold keeps low-friction entry for small receipts
    // (coffee, supplies) while gating anything meaningful.
    if (amount >= 500) {
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: ctx.employee.id,
        orgId,
        actorPassword: (body as { actorPassword?: string }).actorPassword,
        bucketKey: 'expense-create-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }
    }

    // R49: wrap INSERT + audit in one orgTx. Prior shape ran INSERT via
    // orgQuery then audited post-commit via pgInsertAuditEvent — if the
    // post-commit audit failed, the expense existed with no audit row
    // (the cash-theft cover-up scenario the comment warns about).
    const { orgTx } = await import("@/lib/supabase-rest");
    const { randomUUID } = await import("@/lib/uuid");
    const client = await orgTx(orgId);
    let created: { id: string; category: string; description: string; amount: number; expense_date: string; is_recurring: boolean; recurrence_period: string | null; notes: string | null; location_id: string; created_at: string; updated_at: string };
    try {
      const { rows } = await client.query(
        `INSERT INTO expenses (organization_id, location_id, category, description, amount, expense_date, is_recurring, recurrence_period, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, category, description, amount, expense_date, is_recurring, recurrence_period, notes, location_id, created_at, updated_at`,
        [orgId, locationId, category, description, amount, expense_date || new Date().toISOString().slice(0, 10), is_recurring || false, recurrence_period || null, notes || null],
      );
      created = rows[0] as typeof created;
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'expense', $5, 'expense_created', $6, now())`,
        [
          randomUUID(), orgId, created.location_id ?? null, ctx.employee.id, created.id,
          JSON.stringify({
            id: created.id,
            category: created.category,
            amount: created.amount,
            expense_date: created.expense_date,
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
    return NextResponse.json({ expense: created });
  } catch (error) {
    console.error('Expenses POST error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to create expense' }, { status: 500 });
  }
});

// R27-H2: admin-only (see POST above).
// R31-M6: add location gate (non-managers limited to their assigned
// locations) + write an audit event. Prior shape let any
// employee.manage holder DELETE expenses in ANY location with zero
// audit trail — fraud-evidence-scrubbing vector.
export const DELETE = withAdminAuth("employee.manage", async (request, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(expenseDeleteSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id } = v.data;

    // R54-H1: step-up re-auth. DELETE is an evidence-destruction
    // vector — a stolen admin cookie can scrub the cash-short
    // cover-up trail the POST comment explicitly warned about.
    // POST gates on amount >= $500 with `expense-create-stepup`;
    // DELETE mirrors the same bucket (sharing the aggregate cap)
    // but gates unconditionally since the attacker can delete any
    // amount. The expense's own audit row remains in audit_events
    // after DELETE, but the source-of-truth row is gone.
    const { requireStepUp } = await import("@/lib/auth/step-up");
    const stepUp = await requireStepUp({
      actorId: ctx.employee.id,
      orgId,
      actorPassword: (body as { actorPassword?: string })?.actorPassword,
      bucketKey: 'expense-delete-stepup',
    });
    if (!stepUp.ok) {
      return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
    }

    // R49: wrap SELECT + DELETE + audit in one orgTx so the audit row
    // is atomic with the destructive mutation. An attacker-induced
    // post-commit audit failure would otherwise destroy the evidence
    // that the attacker wanted to destroy (the expense row) along
    // with the trail.
    const { orgTx } = await import("@/lib/supabase-rest");
    const { randomUUID } = await import("@/lib/uuid");
    const client = await orgTx(orgId);
    let target: { id: string; location_id: string; category: string; amount: number; expense_date: string };
    try {
      // Look up the expense's location + amount BEFORE delete so the
      // audit event captures what was removed and the location-gate
      // can compare against the actor's assignments. FOR UPDATE so a
      // concurrent DELETE doesn't race in between this SELECT and our
      // delete.
      const { rows: rowBefore } = await client.query(
        'SELECT id, location_id, category, amount, expense_date FROM expenses WHERE id = $1 AND organization_id = $2 LIMIT 1 FOR UPDATE',
        [id, orgId],
      );
      if (rowBefore.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
      }
      target = rowBefore[0] as typeof target;

      const isManagerOrOwner = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
      const callerLocs = ctx.employee.locationIds ?? [];
      if (!isManagerOrOwner && !callerLocs.includes(target.location_id)) {
        await client.query("ROLLBACK");
        // Generic 404 — don't disclose that the expense exists at a
        // location the caller can't see.
        return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
      }

      await client.query('DELETE FROM expenses WHERE id = $1 AND organization_id = $2', [id, orgId]);
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'expense', $5, 'expense_deleted', $6, now())`,
        [
          randomUUID(), orgId, target.location_id, ctx.employee.id, id,
          JSON.stringify({
            id,
            category: target.category,
            amount: target.amount,
            expense_date: target.expense_date,
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
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Expenses DELETE error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to delete expense' }, { status: 500 });
  }
});
