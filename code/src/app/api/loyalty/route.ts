import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withAdminAuth } from "@/lib/api/with-auth";
import { validateBody, loyaltyAdjustSchema } from "@/lib/validation/schemas";
import { checkRateLimit } from "@/lib/auth/rate-limit";
// R94-sweep: bust readStore cache so admin dashboards see
// freshly-adjusted loyalty_points immediately.
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";


import { safeErr } from "@/lib/logging/safe-err";
// R31-H10: pgInsertAuditEvent + waitUntilOrAwait are no longer used —
// the audit INSERT now runs inside the same orgTx as the loyalty
// UPDATE so the 24h cap can never lag the real mint.
/**
 * GET /api/loyalty
 */
export const GET = withAdminAuth("audit.view", async (req, ctx) => {
  const { orgId } = ctx;

  try {
    const sp = req.nextUrl.searchParams;

    const customerId = sp.get("customer_id");
    if (customerId) {
      // R34-D2: restrict PII (email, phone, store_credit_balance) to
      // owner/manager roles. `audit.view` is held by support and
      // inventory_clerk — those roles can legitimately look up a
      // customer's loyalty balance for a reconciliation question
      // but shouldn't harvest email + phone at scale. Managers keep
      // full visibility for legitimate CRM work.
      const isManager = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
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

      const customerFull = customerResult.rows[0] as Record<string, unknown>;
      // Strip PII fields for non-managers. Keep the loyalty-relevant
      // fields (points, total_spend, visit_count) so the support
      // role can still answer the "how many points do I have" ask.
      const customer = isManager ? customerFull : {
        id: customerFull.id,
        first_name: customerFull.first_name,
        last_name: customerFull.last_name,
        loyalty_points: customerFull.loyalty_points,
        total_spend: customerFull.total_spend,
        visit_count: customerFull.visit_count,
      };

      // R27-C2: explicit organization_id filter on the per-customer
      // transaction list. The customer_id is already verified to be in
      // the caller's org by the SELECT above, but adding the org filter
      // here is defense-in-depth in case a cross-tenant customer_id
      // somehow slipped through.
      const transactionResult = await orgQuery(
        orgId,
        `SELECT id, created_at, grand_total AS total_due, grand_total AS total_paid, status
         FROM transactions
         WHERE customer_id = $1 AND organization_id = $2
         ORDER BY created_at DESC
         LIMIT 20`,
        [customerId, orgId],
      );

      return NextResponse.json({
        customer,
        recentTransactions: transactionResult.rows,
      });
    }

    // Org-wide loyalty overview (top customers, stats, recent activity) is
    // a manager-only view. Non-managers (support / inventory_clerk, who hold
    // audit.view for different reasons) should use per-customer lookup via
    // `?customer_id=...` so they can't mine cross-location customer PII.
    // Customers in this schema belong to the org, not a specific location —
    // there's no clean location filter to apply to the aggregate, so this
    // endpoint gates instead of narrowing.
    const isManager = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
    if (!isManager) {
      return NextResponse.json(
        { error: "Org-wide loyalty overview requires owner or manager role. Pass ?customer_id to view a specific customer." },
        { status: 403 },
      );
    }

    // R27-C2: every CTE filtered on `loyalty_points > 0` with NO
    // organization_id — so an owner at any tenant saw every tenant's
    // top customers, emails, and combined totals. Add `organization_id
    // = $1` to every CTE. The transactions JOIN in `recent_activity`
    // additionally gates on `t.organization_id = $1` (defense in
    // depth, since customer_id is already org-scoped).
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
         WHERE organization_id = $1
           AND (loyalty_points > 0 OR visit_count > 0)
       ),
       top_customers AS (
         SELECT
           id, first_name, last_name, email, loyalty_points, total_spend, visit_count
         FROM customers
         WHERE organization_id = $1 AND loyalty_points > 0
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
           AND t.organization_id = $1
           AND t.created_at >= NOW() - INTERVAL '30 days'
         WHERE c.organization_id = $1
           AND (c.loyalty_points > 0 OR c.visit_count > 0)
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
         WHERE organization_id = $1 AND loyalty_points >= 0 AND loyalty_points < 100
         UNION ALL
         SELECT '100-500', COUNT(*)::int
         FROM customers
         WHERE organization_id = $1 AND loyalty_points >= 100 AND loyalty_points < 500
         UNION ALL
         SELECT '500-1000', COUNT(*)::int
         FROM customers
         WHERE organization_id = $1 AND loyalty_points >= 500 AND loyalty_points < 1000
         UNION ALL
         SELECT '1000+', COUNT(*)::int
         FROM customers
         WHERE organization_id = $1 AND loyalty_points >= 1000
       )
       SELECT
         (SELECT row_to_json(loyalty_stats.*) FROM loyalty_stats) AS overview,
         (SELECT coalesce(json_agg(row_to_json(top_customers.*)), '[]'::json)
          FROM top_customers) AS top_customers,
         (SELECT coalesce(json_agg(row_to_json(recent_activity.*)), '[]'::json)
          FROM recent_activity) AS recent_activity,
         (SELECT coalesce(json_agg(row_to_json(points_distribution.*)), '[]'::json)
          FROM points_distribution) AS points_distribution`,
      [orgId],
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
    console.error("Loyalty GET error:", safeErr(error));
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
  const { orgId, employee } = ctx;
  // R30-H5: triple-layer rate-limit: in-memory (per-isolate) + KV
  // (cross-isolate) + DB-level rolling 24h sum. The prior in-memory
  // cap of 30/5min lets a compromised session mint ~30 × 10k = 300k
  // points/5min per isolate; with ~32 Cloudflare Workers isolates
  // that's ~9.6M points every 5 min cross-isolate with zero daily
  // aggregate cap. Points redeem at 0.01 $/pt by default → $96k/5min
  // per compromised manager. Mirrors the gift-cards cap shape
  // (R29-M2).
  const rl = checkRateLimit(`loyalty-adjust:${orgId}:${employee.id}`, { maxAttempts: 30, windowMs: 300_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many loyalty adjustments. Try again shortly." }, { status: 429 });
  }
  try {
    const { checkKvRateLimit } = await import("@/lib/auth/kv-rate-limit");
    const kvRl = await checkKvRateLimit(`loyalty-adjust:${orgId}:${employee.id}`, {
      maxAttempts: 45, windowMs: 300_000,
    });
    if (!kvRl.allowed) {
      return NextResponse.json({ error: "Too many loyalty adjustments. Try again shortly." }, { status: 429 });
    }
  } catch {
    // Fail-open on KV error; the in-memory + DB caps still apply.
  }
  try {
    const body = await req.json();
    const v = validateBody(loyaltyAdjustSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { customer_id, adjustment, reason } = v.data;

    // R32-H10: step-up on positive (minting) adjustments. Negative
    // adjustments reduce liability and are acceptable with cookie
    // alone; positive adjustments print cash-equivalent at
    // redemption-time and need a password re-entry.
    if (adjustment > 0) {
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: employee.id,
        orgId,
        actorPassword: (body as { actorPassword?: string }).actorPassword,
        bucketKey: 'loyalty-adjust-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }
    }

    // Cap positive adjustments. Without a cap, any manager can manufacture
    // effectively-cash loyalty value (points redeem at checkout).
    // R30-H5: also apply a rolling 24-hour cumulative cap per actor so
    // a compromised session can't grind effectively-unlimited points
    // by staying under the per-request cap indefinitely.
    const MAX_ADJUSTMENT_PER_REQUEST = 10_000;
    const MAX_DAILY_LOYALTY_MINT_PER_ACTOR = 50_000;
    if (adjustment > MAX_ADJUSTMENT_PER_REQUEST) {
      return NextResponse.json(
        { error: `Adjustment exceeds per-request maximum of ${MAX_ADJUSTMENT_PER_REQUEST} points` },
        { status: 400 },
      );
    }
    // R31-H10: move the 24h-cap aggregation + UPDATE + audit INSERT
    // into a SINGLE orgTx so the cap counter can never lag the real
    // mint. Prior shape was:
    //   (1) SELECT audit_events minted  — committed
    //   (2) UPDATE customers            — committed separately
    //   (3) waitUntil(pgInsertAuditEvent) — non-blocking, may fail
    // If step (3) failed (connection blip, migration running, etc.),
    // step (1)'s future read missed the just-minted adjustment and
    // the cap was bypassable. NEW shape reads the cap INSIDE the
    // tx, INSERTs a `loyalty_audit` row (committed together with the
    // customer UPDATE) that the next request's cap read will see.
    // The row is also the source of truth for future cap reads, so
    // cap is monotonic even if a later audit-pipeline write drops.
    const { orgTx } = await import("@/lib/supabase-rest");
    const client = await orgTx(orgId);
    let newPoints: number;
    let previousPoints: number;
    try {
      // R47-H3: advisory lock on (orgId, actorId) to serialize the 24h
      // mint-cap TOCTOU window. Prior shape read `minted24h` under
      // READ COMMITTED, then UPDATE'd; two concurrent requests from
      // the same actor could both read `minted24h=N`, both pass
      // `N+X <= 50k`, both UPDATE, double-minting past the cap.
      // Mirrors the R31-M4 gift-cards/store-credit actor-lock pattern.
      await client.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [`loyalty-actor:${orgId}:${employee.id}`],
      );
      if (adjustment > 0) {
        // Aggregate committed loyalty_adjusted rows in the last 24h
        // for THIS actor. Reads within the same tx see committed
        // rows from other txs (READ COMMITTED default). The advisory
        // lock above serializes concurrent mints from the same actor
        // so the TOCTOU window the prior shape had is closed.
        const { rows: dailyRows } = await client.query(
          `SELECT COALESCE(SUM((payload->>'adjustment')::int), 0)::int AS minted
             FROM audit_events
            WHERE organization_id = $1
              AND actor_employee_id = $2
              AND event_kind = 'loyalty_adjusted'
              AND created_at >= now() - interval '24 hours'
              AND COALESCE((payload->>'adjustment')::int, 0) > 0`,
          [orgId, employee.id],
        );
        const minted24h = Number(dailyRows[0]?.minted ?? 0) || 0;
        if (minted24h + adjustment > MAX_DAILY_LOYALTY_MINT_PER_ACTOR) {
          await client.query("ROLLBACK");
          return NextResponse.json(
            { error: `24-hour loyalty mint cap of ${MAX_DAILY_LOYALTY_MINT_PER_ACTOR} pts exceeded (already ${minted24h} in the last 24h).` },
            { status: 429 },
          );
        }
      }

      // INT-LOW1: lock the customer row FIRST, then UPDATE — the SELECT
      // FOR UPDATE acquires the row lock so prev_points and the
      // subsequent UPDATE see the same committed value. Prior shape
      // used a CTE `previous` SELECT that ran on the start-of-statement
      // snapshot; under READ COMMITTED a concurrent committed mint
      // between snapshot and lock acquisition would re-read the new
      // value in the SET expression but leave the CTE's prev_points
      // stale — money math was correct (SET uses locked-row value)
      // but the audit log's previous_points could disagree with reality.
      // Note: cannot derive previous_points by `loyalty_points - $1`
      // post-UPDATE because GREATEST(0, ...) clamps a redeem-past-zero
      // adjustment, breaking the subtraction. Lock-then-update is the
      // correct shape.
      const { rows: lockRows } = await client.query(
        `SELECT COALESCE(loyalty_points, 0)::int AS prev_points
         FROM customers
         WHERE id = $1 AND organization_id = $2
         FOR UPDATE`,
        [customer_id, orgId],
      );
      if (lockRows.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }
      const lockedPrev = Number(lockRows[0].prev_points) || 0;
      const { rows: updRows } = await client.query(
        `UPDATE customers SET
           loyalty_points = GREATEST(0, COALESCE(loyalty_points, 0) + $1),
           updated_at = NOW()
         WHERE id = $2 AND organization_id = $3
         RETURNING id, loyalty_points, first_name, last_name`,
        [adjustment, customer_id, orgId],
      );
      // Synthesize the previous_points field expected downstream.
      if (updRows[0]) {
        updRows[0].previous_points = lockedPrev;
      }
      if (updRows.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }
      newPoints = Number(updRows[0].loyalty_points) || 0;
      previousPoints = Number(updRows[0].previous_points) || 0;

      // Atomic audit-insert inside the same tx. If this fails, the
      // customer UPDATE rolls back too — cap counter stays consistent
      // with liability.
      await client.query(
        // R36-drift: was `employee_id` — schema column is `actor_employee_id`
        // (per migration 001). Prior shape would have 42703'd on first mint;
        // caught by pre-commit schema-drift scanner before landing.
        `INSERT INTO audit_events (organization_id, actor_employee_id, entity_type, entity_id, event_kind, payload)
         VALUES ($1, $2, 'customer', $3, 'loyalty_adjusted', $4::jsonb)`,
        [
          orgId, employee.id, customer_id,
          JSON.stringify({ id: customer_id, adjustment, previous_points: previousPoints, new_points: newPoints, reason }),
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    invalidateStoreCache(orgId);
    const updateResult = { rows: [{ id: customer_id, loyalty_points: newPoints, previous_points: previousPoints }] };

    const currentPoints = previousPoints;

    return NextResponse.json({
      success: true,
      customer: updateResult.rows[0],
      adjustment,
      reason,
      previousPoints: currentPoints,
      newPoints,
    });
  } catch (error) {
    console.error("Loyalty POST error:", safeErr(error));
    return NextResponse.json(
      { error: "Failed to update loyalty points" },
      { status: 500 }
    );
  }
});
