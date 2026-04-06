import { NextRequest, NextResponse } from 'next/server';
import { orgQuery } from '@/lib/db';
import { requireAdminPermission } from '@/lib/authz';


/**
 * GET /api/returns/search
 *
 * Query params:
 *   search    — transaction ID or customer name
 *   dateRange — 'today', 'week', 'month', 'all'
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAdminPermission('audit.view');
  const orgId = ctx.employee.organizationId;

  try {
    const sp = req.nextUrl.searchParams;
    const searchQuery = sp.get('search');
    const dateRange = sp.get('dateRange') || 'all';

    if (!searchQuery) {
      return NextResponse.json({ error: 'Search query required' }, { status: 400 });
    }

    // Build date filter
    let dateCondition = '';
    const now = new Date();
    const dateParams: unknown[] = [searchQuery, orgId];

    if (dateRange === 'today') {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      dateCondition = ' AND t.created_at >= $3 AND t.created_at < $4';
      dateParams.push(startOfDay.toISOString(), now.toISOString());
    } else if (dateRange === 'week') {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      dateCondition = ' AND t.created_at >= $3';
      dateParams.push(weekAgo.toISOString());
    } else if (dateRange === 'month') {
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      dateCondition = ' AND t.created_at >= $3';
      dateParams.push(monthAgo.toISOString());
    }

    // Find transaction by ID or customer name
    const txnResult = await orgQuery(
      orgId,
      `SELECT t.*,
              e.display_name AS employee_name,
              c.first_name || ' ' || c.last_name AS customer_name
       FROM transactions t
       LEFT JOIN employees e ON e.id = t.employee_id
       LEFT JOIN customers c ON c.id = t.customer_id
       WHERE (t.id::text ILIKE $1 OR e.display_name ILIKE $1 OR COALESCE(c.first_name || ' ' || c.last_name, '') ILIKE $1)
       AND t.organization_id = $2
       ${dateCondition}
       ORDER BY t.created_at DESC
       LIMIT 1`,
      dateParams
    );

    if (txnResult.rows.length === 0) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    const transaction = txnResult.rows[0];
    const transactionId = transaction.id;

    // Get tenders
    const tendersResult = await orgQuery(
      orgId,
      `SELECT * FROM transaction_tenders WHERE transaction_id = $1 ORDER BY created_at`,
      [transactionId]
    );

    // Parse items from cart_snapshot
    let items: unknown[] = [];
    if (transaction.cart_snapshot) {
      try {
        const snapshot = JSON.parse(transaction.cart_snapshot as string);
        items = snapshot.items || [];
      } catch (e) {
        console.error('Failed to parse cart_snapshot:', e);
      }
    }

    return NextResponse.json({
      transaction,
      tenders: tendersResult.rows,
      items,
    });
  } catch (error) {
    console.error('GET /api/returns/search error:', error);
    return NextResponse.json({ error: 'Failed to search transaction' }, { status: 500 });
  }
}
