import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { requireAdminPermission } from '@/lib/authz';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';

const ORG_ID = '33262270-7100-4b46-b2fb-8b50ad872bbb';
const LOCATION_ID = 'c57268b3-cb14-4c1a-bda6-55e49ddc6313';

export async function GET(request: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  if (!adminCtx && !registerCtx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const month = request.nextUrl.searchParams.get('month') || ''; // YYYY-MM
  const category = request.nextUrl.searchParams.get('category') || '';

  try {
    let where = 'WHERE e.organization_id = $1';
    const values: unknown[] = [ORG_ID];
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

    const { rows } = await pool.query(
      `SELECT e.*, l.name as location_name FROM expenses e
       JOIN locations l ON e.location_id = l.id
       ${where} ORDER BY e.expense_date DESC, e.created_at DESC`,
      values,
    );

    // Summary by category
    const { rows: summary } = await pool.query(
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
}

export async function POST(request: NextRequest) {
  await requireAdminPermission('catalog.manage');
  try {
    const { category, description, amount, expense_date, is_recurring, recurrence_period, notes } = await request.json();
    if (!category || !description || !amount) {
      return NextResponse.json({ error: 'Category, description, and amount are required' }, { status: 400 });
    }

    const { rows } = await pool.query(
      `INSERT INTO expenses (organization_id, location_id, category, description, amount, expense_date, is_recurring, recurrence_period, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [ORG_ID, LOCATION_ID, category, description, amount, expense_date || new Date().toISOString().slice(0, 10), is_recurring || false, recurrence_period || null, notes || null],
    );
    return NextResponse.json({ expense: rows[0] });
  } catch (error) {
    console.error('Expenses POST error:', error);
    return NextResponse.json({ error: 'Failed to create expense' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  await requireAdminPermission('catalog.manage');
  try {
    const { id } = await request.json();
    if (!id) return NextResponse.json({ error: 'Expense ID required' }, { status: 400 });

    await pool.query('DELETE FROM expenses WHERE id = $1 AND organization_id = $2', [id, ORG_ID]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Expenses DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete expense' }, { status: 500 });
  }
}
