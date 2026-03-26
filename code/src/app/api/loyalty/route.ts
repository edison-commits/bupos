import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";

const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";

/**
 * GET /api/loyalty
 *
 * Loyalty program overview:
 * - Total customers enrolled
 * - Total points outstanding
 * - Top 10 customers by loyalty_points
 * - Recent loyalty activity (transactions in last 30 days)
 * - Points distribution histogram
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;

    // If customer_id is specified, get details for that customer
    const customerId = sp.get("customer_id");
    if (customerId) {
      const customerResult = await orgQuery(
        ORG_ID,
        `SELECT id, first_name, last_name, email, phone, loyalty_points, 
                total_spend, visit_count, store_credit_balance, last_visit_at
         FROM customers
         WHERE id = $1`,
        [customerId],
      );

      if (customerResult.rows.length === 0) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }

      const customer = customerResult.rows[0];

      // Get recent transactions for this customer
      const transactionResult = await orgQuery(
        ORG_ID,
        `SELECT id, created_at, total_due, total_paid, status
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

    // Get comprehensive loyalty overview using single consolidated query
    const overviewResult = await orgQuery(
      ORG_ID,
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
           id, first_name, last_name, email, loyalty_points, total_spend, visit_count, last_visit_at
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
}

/**
 * POST /api/loyalty
 *
 * Adjust loyalty points for a customer
 * body: { customer_id, adjustment (positive or negative int), reason }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { customer_id, adjustment, reason } = body;

    if (!customer_id || adjustment === undefined || !reason) {
      return NextResponse.json(
        { error: "Missing required fields: customer_id, adjustment, reason" },
        { status: 400 }
      );
    }

    if (typeof adjustment !== "number" || !Number.isInteger(adjustment)) {
      return NextResponse.json(
        { error: "adjustment must be an integer" },
        { status: 400 }
      );
    }

    // Check if customer exists
    const checkResult = await orgQuery(
      ORG_ID,
      `SELECT id, loyalty_points FROM customers WHERE id = $1`,
      [customer_id],
    );

    if (checkResult.rows.length === 0) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    const currentPoints = checkResult.rows[0].loyalty_points || 0;
    const newPoints = Math.max(0, currentPoints + adjustment); // Prevent negative points

    // Update customer loyalty points
    const updateResult = await orgQuery(
      ORG_ID,
      `UPDATE customers
       SET loyalty_points = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, loyalty_points, first_name, last_name`,
      [newPoints, customer_id],
    );

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
}
