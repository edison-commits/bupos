import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

const ORG_ID = '33262270-7100-4b46-b2fb-8b50ad872bbb';

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams.get('search')?.trim() || '';
  const id = request.nextUrl.searchParams.get('id')?.trim() || '';
  const page = Math.max(1, parseInt(request.nextUrl.searchParams.get('page') || '1'));
  const pageSize = Math.min(100, parseInt(request.nextUrl.searchParams.get('pageSize') || '50'));

  try {
    // Single customer detail with purchase history
    if (id) {
      const [customerRes, transactionsRes, statsRes] = await Promise.all([
        pool.query(
          `SELECT * FROM customers WHERE id = $1 AND organization_id = $2`,
          [id, ORG_ID]
        ),
        pool.query(
          `SELECT id, created_at, total_due, total_paid, customer_id, employee_id
           FROM transactions
           WHERE customer_id = $1 AND organization_id = $2
           ORDER BY created_at DESC LIMIT 20`,
          [id, ORG_ID]
        ),
        pool.query(
          `SELECT
             COUNT(*)::int as visit_count,
             COALESCE(SUM(total_paid), 0)::numeric as total_spend
           FROM transactions
           WHERE customer_id = $1 AND organization_id = $2`,
          [id, ORG_ID]
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

    // List customers with pagination
    let whereExtra = '';
    const values: unknown[] = [ORG_ID];
    let idx = 2;

    if (search) {
      whereExtra = ` AND (c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR c.email ILIKE $${idx} OR c.phone ILIKE $${idx})`;
      values.push(`%${search}%`);
      idx++;
    }

    const countQ = `SELECT COUNT(*)::int as total FROM customers c WHERE c.organization_id = $1${whereExtra}`;
    const dataQ = `SELECT * FROM customers c WHERE c.organization_id = $1${whereExtra}
      ORDER BY c.updated_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;

    values.push(pageSize, (page - 1) * pageSize);

    const [countRes, dataRes] = await Promise.all([
      pool.query(countQ, values.slice(0, idx - 1)),
      pool.query(dataQ, values),
    ]);

    return NextResponse.json({
      customers: dataRes.rows,
      pagination: { page, pageSize, total: countRes.rows[0].total, totalPages: Math.ceil(countRes.rows[0].total / pageSize) },
    });
  } catch (error) {
    console.error('Customers GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch customers' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { first_name, last_name, email, phone, address, notes } = await request.json();
    if (!first_name?.trim() || !last_name?.trim()) {
      return NextResponse.json({ error: 'First and last name are required' }, { status: 400 });
    }

    const { rows } = await pool.query(
      `INSERT INTO customers (organization_id, first_name, last_name, email, phone, address, notes, loyalty_points, total_spend, visit_count, store_credit_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0)
       RETURNING *`,
      [ORG_ID, first_name.trim(), last_name.trim(), email?.trim() || null, phone?.trim() || null, address?.trim() || null, notes?.trim() || null],
    );
    return NextResponse.json({ customer: rows[0] });
  } catch (error) {
    console.error('Customers POST error:', error);
    return NextResponse.json({ error: 'Failed to create customer' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { id, first_name, last_name, email, phone, address, notes, is_active } = await request.json();
    if (!id) return NextResponse.json({ error: 'Customer ID required' }, { status: 400 });

    const { rows } = await pool.query(
      `UPDATE customers
       SET first_name = $2, last_name = $3, email = $4, phone = $5, address = $6, notes = $7, is_active = $8, updated_at = NOW()
       WHERE id = $1 AND organization_id = $9
       RETURNING *`,
      [id, first_name?.trim() || null, last_name?.trim() || null, email?.trim() || null, phone?.trim() || null, address?.trim() || null, notes?.trim() || null, is_active ?? true, ORG_ID],
    );
    if (rows.length === 0) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    return NextResponse.json({ customer: rows[0] });
  } catch (error) {
    console.error('Customers PUT error:', error);
    return NextResponse.json({ error: 'Failed to update customer' }, { status: 500 });
  }
}
