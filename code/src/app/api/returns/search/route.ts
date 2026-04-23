import { NextResponse } from 'next/server';
import { orgQuery } from '@/lib/supabase-rest';
import { withAdminAuth } from '@/lib/api/with-auth';


import { safeErr } from "@/lib/logging/safe-err";
/**
 * GET /api/returns/search
 *
 * Query params:
 *   search    — transaction ID or customer name
 *   dateRange — 'today', 'week', 'month', 'all'
 */
export const GET = withAdminAuth('audit.view', async (req, ctx) => {
  const { orgId } = ctx;

  try {
    const sp = req.nextUrl.searchParams;
    const searchQuery = sp.get('search');
    const dateRange = sp.get('dateRange') || 'all';

    if (!searchQuery) {
      return NextResponse.json({ error: 'Search query required' }, { status: 400 });
    }

    // Build date filter — wrap search query with ILIKE wildcards (escape special chars)
    const escapedSearch = searchQuery.replace(/[%_\\]/g, '\\$&');
    let dateCondition = '';
    const now = new Date();
    const dateParams: unknown[] = [`%${escapedSearch}%`, orgId];

    // Location scope for non-managers. Without this, a support-role or
    // inventory_clerk session at Location A can search a customer's name
    // and see their purchase at Location B, including the full receipt
    // (items + tenders are fetched below by txn id). Owners/managers
    // see everything org-wide for customer-service workflows.
    const isManager = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
    const allowedLocations = ctx.employee.locationIds ?? [];
    if (!isManager && allowedLocations.length === 0) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    if (dateRange === 'today') {
      // R87-MED: use buildOrgDayRange for org-TZ-aware "today"
      // bounds. Prior shape used server-local `setHours(0,0,0,0)`
      // which on Cloudflare Workers is UTC midnight — a Pacific-
      // TZ store searching "today" at 9pm PT got yesterday-4pm PT
      // → now instead of today-00:00 PT → now. Sibling of
      // R83-SEC-H2 dashboard fix + R83-MED reports hourly + R83
      // /api/export sweep.
      const { buildOrgDayRange } = await import("@/lib/reports/day-range");
      const todayStr = now.toISOString().slice(0, 10);
      const { fromTs: startOfDay } = await buildOrgDayRange(ctx.orgId, todayStr, todayStr);
      dateCondition = ' AND t.created_at >= $3 AND t.created_at < $4';
      dateParams.push(startOfDay, now.toISOString());
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

    // Append the location filter AFTER the date params so its $N index lines
    // up with dateParams.length after all date pushes are done.
    let locationCondition = "";
    if (!isManager) {
      dateParams.push(allowedLocations);
      locationCondition = ` AND t.location_id = ANY($${dateParams.length}::uuid[])`;
    }

    // Find transaction by ID or customer name.
    // R34-D14: select only the fields the UI actually needs — the
    // prior `SELECT t.*` pulled `idempotency_key` (client-generated,
    // low-value but not meant to be re-exposed) and `cart_snapshot`
    // (attacker-controlled pricing metadata). Explicit column list
    // narrows the leak surface to the receipt-essential fields.
    // R34-D13: defense-in-depth org filters on employees + customers
    // JOINs so a crafted FK can't splice foreign names.
    const txnResult = await orgQuery(
      orgId,
      `SELECT t.id, t.status, t.tender_type, t.subtotal, t.discount_total,
              t.tax_total, t.grand_total, t.amount_tendered, t.change_due,
              t.created_at, t.location_id, t.customer_id, t.employee_id,
              t.register_session_id,
              e.display_name AS employee_name,
              c.first_name || ' ' || c.last_name AS customer_name
       FROM transactions t
       LEFT JOIN employees e ON e.id = t.employee_id AND e.organization_id = $2
       LEFT JOIN customers c ON c.id = t.customer_id AND c.organization_id = $2
       WHERE (t.id::text ILIKE $1 OR e.display_name ILIKE $1 OR COALESCE(c.first_name || ' ' || c.last_name, '') ILIKE $1)
       AND t.organization_id = $2
       ${dateCondition}${locationCondition}
       ORDER BY t.created_at DESC
       LIMIT 1`,
      dateParams
    );

    if (txnResult.rows.length === 0) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    const transaction = txnResult.rows[0];
    const transactionId = transaction.id;

    // Get tenders. Join through transactions so the tender aggregate is
    // also org-scoped — defense in depth; the transaction_id was already
    // verified to live in this org by the prior txnResult query, but
    // joining prevents a future refactor that reorders the calls from
    // silently crossing tenants.
    // check-pool-org-filter: scoped-by-prior-org-verified-transaction-id
    const tendersResult = await orgQuery(
      orgId,
      `SELECT tt.id, tt.transaction_id, tt.tender_type, tt.amount, tt.metadata, tt.created_at
       FROM transaction_tenders tt
       JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $2
       WHERE tt.transaction_id = $1
       ORDER BY tt.created_at`,
      [transactionId, orgId]
    );

    // Parse items from cart_snapshot
    let items: unknown[] = [];
    if (transaction.cart_snapshot) {
      try {
        const snapshot = JSON.parse(transaction.cart_snapshot as string);
        items = snapshot.items || [];
      } catch (e) {
        console.error('Failed to parse cart_snapshot:', safeErr(e));
      }
    }

    return NextResponse.json({
      transaction,
      tenders: tendersResult.rows,
      items,
    });
  } catch (error) {
    console.error('GET /api/returns/search error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to search transaction' }, { status: 500 });
  }
});
