import { NextResponse } from 'next/server';
import { orgQuery } from '@/lib/supabase-rest';
import { withAdminAuth } from '@/lib/api/with-auth';
import { safeErr } from '@/lib/logging/safe-err';

export const GET = withAdminAuth("inventory.adjust", async (_request, ctx) => {
  const { orgId } = ctx;
  const allowedLocations = ctx.allowedLocations;

  const params: unknown[] = [orgId];
  let locClause = '';
  if (allowedLocations !== null) {
    if (allowedLocations.length === 0) {
      return NextResponse.json({
        openPurchaseOrders: [],
        supplierPerformance: [],
        summary: emptySummary(),
      });
    }
    params.push(allowedLocations);
    locClause = ` AND po.location_id = ANY($2::uuid[])`;
  }

  try {
    const { rows: openPurchaseOrders } = await orgQuery(
      orgId,
      `WITH line_totals AS (
         SELECT purchase_order_id,
                COALESCE(SUM(quantity_ordered), 0)::int AS units_ordered,
                COALESCE(SUM(quantity_received), 0)::int AS units_received,
                COALESCE(SUM(quantity_ordered * unit_cost), 0) AS total_cost
         FROM purchase_order_lines
         GROUP BY purchase_order_id
       )
       SELECT po.id, po.po_number, po.status, po.expected_at, po.ordered_at, po.created_at,
              s.id AS supplier_id, s.name AS supplier_name,
              l.name AS location_name,
              COALESCE(lt.units_ordered, 0)::int AS units_ordered,
              COALESCE(lt.units_received, 0)::int AS units_received,
              COALESCE(lt.total_cost, 0) AS total_cost,
              GREATEST(0, CURRENT_DATE - po.expected_at::date)::int AS days_overdue,
              CASE WHEN po.expected_at IS NOT NULL AND po.expected_at::date < CURRENT_DATE THEN true ELSE false END AS is_overdue
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id AND s.organization_id = $1
       JOIN locations l ON l.id = po.location_id AND l.organization_id = $1
       LEFT JOIN line_totals lt ON lt.purchase_order_id = po.id
       WHERE po.organization_id = $1
         AND po.status IN ('submitted', 'partial')
         ${locClause}
       ORDER BY is_overdue DESC, days_overdue DESC, po.expected_at NULLS LAST, po.created_at DESC
       LIMIT 100`,
      params,
    );

    const { rows: supplierPerformance } = await orgQuery(
      orgId,
      `WITH po_totals AS (
         SELECT po.id, po.supplier_id, po.status, po.expected_at, po.ordered_at, po.received_at, po.created_at,
                COALESCE(SUM(pol.quantity_ordered), 0)::numeric AS units_ordered,
                COALESCE(SUM(pol.quantity_received), 0)::numeric AS units_received
         FROM purchase_orders po
         LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
         WHERE po.organization_id = $1${locClause}
         GROUP BY po.id
       )
       SELECT s.id AS supplier_id,
              s.name AS supplier_name,
              COUNT(pt.id)::int AS po_count,
              COUNT(*) FILTER (WHERE pt.status IN ('submitted', 'partial'))::int AS open_count,
              COUNT(*) FILTER (WHERE pt.status = 'partial')::int AS partial_count,
              COUNT(*) FILTER (
                WHERE pt.status IN ('submitted', 'partial')
                  AND pt.expected_at IS NOT NULL
                  AND pt.expected_at::date < CURRENT_DATE
              )::int AS overdue_count,
              COALESCE(ROUND((SUM(pt.units_received) / NULLIF(SUM(pt.units_ordered), 0)) * 100, 1), 0) AS fill_rate,
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (pt.received_at - COALESCE(pt.ordered_at, pt.created_at))) / 86400)
                FILTER (WHERE pt.status = 'received' AND pt.received_at IS NOT NULL), 1), 0) AS avg_days_to_receive,
              MAX(pt.received_at) AS last_received_at
       FROM suppliers s
       LEFT JOIN po_totals pt ON pt.supplier_id = s.id
       WHERE s.organization_id = $1
       GROUP BY s.id, s.name
       HAVING COUNT(pt.id) > 0
       ORDER BY overdue_count DESC, partial_count DESC, fill_rate ASC, s.name ASC
       LIMIT 100`,
      params,
    );

    const summary = {
      open_count: openPurchaseOrders.length,
      overdue_count: openPurchaseOrders.filter((po) => Boolean(po.is_overdue)).length,
      partial_count: openPurchaseOrders.filter((po) => po.status === 'partial').length,
      total_open_cost: openPurchaseOrders.reduce((sum, po) => sum + Number(po.total_cost ?? 0), 0),
    };

    return NextResponse.json({ openPurchaseOrders, supplierPerformance, summary });
  } catch (error) {
    console.error('Supplier performance GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch supplier performance' }, { status: 500 });
  }
});

function emptySummary() {
  return { open_count: 0, overdue_count: 0, partial_count: 0, total_open_cost: 0 };
}
