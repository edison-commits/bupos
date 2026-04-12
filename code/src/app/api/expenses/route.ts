import { NextRequest, NextResponse } from 'next/server';
import { orgQuery } from '@/lib/db';
import { withDualAuth } from '@/lib/api/with-auth';
import { validateBody, expenseCreateSchema, expenseDeleteSchema } from '@/lib/validation/schemas';

export const GET = withDualAuth("audit.view", async (request, ctx) => {
  const { orgId } = ctx;

  const month = request.nextUrl.searchParams.get('month') || ''; // YYYY-MM
  const category = request.nextUrl.searchParams.get('category') || '';
  const pageSize = Math.min(Math.max(1, Number(request.nextUrl.searchParams.get('pageSize')) || 100), 500);

  try {
    let where = 'WHERE e.organization_id = $1';
    const values: unknown[] = [orgId];
    let idx = 2;

    if (month) {
      where += ` AND TO_CHAR(e.expense_date, 'YYYY-MM') = $${idx}`;
      values.push(month);
      idx++;
    }
    if (category) {
      where += ` AND e.category = $${idx}`;
      values.push(category);
      idx++;
    }

    const { rows } = await orgQuery(
      orgId,
      `SELECT e.id, e.category, e.description, e.amount, e.expense_date, e.is_recurring, e.recurrence_period, e.notes, e.location_id, e.created_at, e.updated_at, l.name as location_name FROM expenses e
       JOIN locations l ON e.location_id = l.id
       ${where} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT $${idx}`,
      [...values, pageSize],
    );

    // Summary by category (unaffected by pagination — covers full filtered set)
    const { rows: summary } = await orgQuery(
      orgId,
      `SELECT e.category, SUM(e.amount)::numeric(12,2) as total, COUNT(*)::int as count
       FROM expenses e ${where} GROUP BY e.category ORDER BY total DESC`,
      values,
    );

    const grandTotal = summary.reduce((s, r) => s + Number(r.total), 0);

    return NextResponse.json({ expenses: rows, summary, grandTotal });
  } catch (error) {
    console.error('Expenses GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch expenses' }, { status: 500 });
  }
});

export const POST = withDualAuth("audit.view", async (request, ctx) => {
  const { orgId, locationId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(expenseCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { category, description, amount, expense_date, is_recurring, recurrence_period, notes } = v.data;

    const { rows } = await orgQuery(
      orgId,
      `INSERT INTO expenses (organization_id, location_id, category, description, amount, expense_date, is_recurring, recurrence_period, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, category, description, amount, expense_date, is_recurring, recurrence_period, notes, location_id, created_at, updated_at`,
      [orgId, locationId, category, description, amount, expense_date || new Date().toISOString().slice(0, 10), is_recurring || false, recurrence_period || null, notes || null],
    );
    return NextResponse.json({ expense: rows[0] });
  } catch (error) {
    console.error('Expenses POST error:', error);
    return NextResponse.json({ error: 'Failed to create expense' }, { status: 500 });
  }
});

export const DELETE = withDualAuth("audit.view", async (request, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(expenseDeleteSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id } = v.data;

    await orgQuery(orgId, 'DELETE FROM expenses WHERE id = $1 AND organization_id = $2', [id, orgId]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Expenses DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete expense' }, { status: 500 });
  }
});
