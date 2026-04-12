import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";
import { withAdminAuth } from "@/lib/api/with-auth";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";
import { validateBody, loyaltyAdjustSchema } from "@/lib/validation/schemas";


/**
 * GET /api/loyalty
 */
export const GET = withAdminAuth("audit.view", async (req, ctx) => {
  const { orgId } = ctx;

  try {
    const sp = req.nextUrl.searchParams;

    const customerId = sp.get("customer_id");
    if (customerId) {
      const customerResult = await orgQuery(
        orgId,
        `SELECT id, first_name, last_name, email, phone, loyalty_points,
                total_spend, visit_count, store_credit_balance
         FROM customers
         WHERE id = $1 AND organization_id = $2`,
        [customerId, orgId],
      );

      if (customerResult.rows.length === 0) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }

      const customer = customerResult.rows[0];

      const transactionResult = await orgQuery(
        orgId,
        `SELECT id, created_at, grand_total AS total_due, grand_total AS total_paid, status
         FROM transactions
         WHERE customer_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [customerId],
      );

      return NextResponse.json({
        customer,
        recentTransactions: transactionResult.rows,
      });
    }

    const overviewResult = await orgQuery(
      orgId,
      `WITH loyalty_stats AS (
         SELECT
           COUNT(*)::int AS total_customers_enrolled,
           COUNT(*) FILTER (WHERE loyalty_points > 0)::int AS active_loyalty_customers,
           COALESCE(SUM(loyalty_points), 0)::bigint AS total_points_outstanding,
           COALESCE(AVG(loyalty_points), 0)::numeric AS avg_points_per_customer,
           COALESCE(AVG(total_spend), 0)::numeric AS avg_spend_per_customer
         FROM customers
         WHERE loyalty_points > 0 OR visit_count > 0
       ),
       top_customers AS (
         SELECT
           id, first_name, last_name, email, loyalty_points, total_spend, visit_count
         FROM customers
         WHERE loyalty_points > 0
         ORDER BY loyalty_points DESC
         LIMIT 10
       ),
       recent_activity AS (
         SELECT
           c.id, c.first_name, c.last_name, c.email, c.loyalty_points,
           MAX(t.created_at) AS last_transaction_date,
           COUNT(t.id)::int AS transaction_count_30d
         FROM customers c
         LEFT JOIN transactions t ON t.customer_id = c.id
           AND t.created_at >= NOW() - INTERVAL '30 days'
         WHERE c.loyalty_points > 0 OR c.visit_count > 0
         GROUP BY c.id, c.first_name, c.last_name, c.email, c.loyalty_points
         HAVING MAX(t.created_at) >= NOW() - INTERVAL '30 days' OR MAX(t.created_at) IS NULL
         ORDER BY MAX(t.created_at) DESC NULLS LAST
         LIMIT 15
       ),
       points_distribution AS (
         SELECT
           '0-100' AS range,
           COUNT(*)::int AS count
         FROM customers
         WHERE loyalty_points >= 0 AND loyalty_points < 100
         UNION ALL
         SELECT '100-500', COUNT(*)::int
         FROM customers
         WHERE loyalty_points >= 100 AND loyalty_points < 500
         UNION ALL
         SELECT '500-1000', COUNT(*)::int
         FROM customers
         WHERE loyalty_points >= 500 AND loyalty_points < 1000
         UNION ALL
         SELECT '1000+', COUNT(*)::int
         FROM customers
         WHERE loyalty_points >= 1000
       )
       SELECT
         (SELECT row_to_json(loyalty_stats.*) FROM loyalty_stats) AS overview,
         (SELECT coalesce(json_agg(row_to_json(top_customers.*)), '[]'::json)
          FROM top_customers) AS top_customers,
         (SELECT coalesce(json_agg(row_to_json(recent_activity.*)), '[]'::json)
          FROM recent_activity) AS recent_activity,
         (SELECT coalesce(json_agg(row_to_json(points_distribution.*)), '[]'::json)
          FROM points_distribution) AS points_distribution`,
      [],
    );

    if (overviewResult.rows.length === 0) {
      return NextResponse.json(
        {
          overview: {
            total_customers_enrolled: 0,
            active_loyalty_customers: 0,
            total_points_outstanding: 0,
            avg_points_per_customer: 0,
            avg_spend_per_customer: 0,
          },
          top_customers: [],
          recent_activity: [],
          points_distribution: [],
        }
      );
    }

    const data = overviewResult.rows[0];

    return NextResponse.json({
      overview: data.overview,
      top_customers: data.top_customers,
      recent_activity: data.recent_activity,
      points_distribution: data.points_distribution,
    });
  } catch (error) {
    console.error("Loyalty GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch loyalty data" },
      { status: 500 }
    );
  }
});

/**
 * POST /api/loyalty
 */
export const POST = withAdminAuth("employee.manage", async (req, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await req.json();
    const v = validateBody(loyaltyAdjustSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { customer_id, adjustment, reason } = v.data;

    const checkResult = await orgQuery(
      orgId,
      `SELECT id, loyalty_points FROM customers WHERE id = $1 AND organization_id = $2`,
      [customer_id, orgId],
    );

    if (checkResult.rows.length === 0) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    const currentPoints = checkResult.rows[0].loyalty_points || 0;
    const newPoints = Math.max(0, currentPoints + adjustment);

    const updateResult = await orgQuery(
      orgId,
      `UPDATE customers
       SET loyalty_points = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, loyalty_points, first_name, last_name`,
      [newPoints, customer_id],
    );

    pgInsertAuditEvent(
      orgId, null, ctx.employee.id,
      "customer", customer_id, "loyalty_adjusted",
      { id: customer_id, adjustment, previous_points: currentPoints, new_points: newPoints, reason },
    ).catch((err) => console.error("[audit] Failed to insert audit event:", err));

    return NextResponse.json({
      success: true,
      customer: updateResult.rows[0],
      adjustment,
      reason,
      previousPoints: currentPoints,
      newPoints,
    });
  } catch (error) {
    console.error("Loyalty POST error:", error);
    return NextResponse.json(
      { error: "Failed to update loyalty points" },
      { status: 500 }
    );
  }
});
