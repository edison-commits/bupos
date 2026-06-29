import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withAdminAuth } from "@/lib/api/with-auth";
import { safeErr } from "@/lib/logging/safe-err";

const MAX_PAGE_SIZE = 200;
const LARGE_NEGATIVE_THRESHOLD = -10;

type QueryValue = string | number | string[];

function addParam(values: QueryValue[], value: QueryValue): string {
  values.push(value);
  return `$${values.length}`;
}

export const GET = withAdminAuth("inventory.adjust", async (request, ctx) => {
  const { orgId } = ctx;
  const searchParams = request.nextUrl.searchParams;

  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(10, Number.parseInt(searchParams.get("pageSize") ?? "50", 10) || 50),
  );
  const offset = (page - 1) * pageSize;

  const reason = searchParams.get("reason")?.trim() || "";
  const employeeId = searchParams.get("employeeId")?.trim() || "";
  const locationId = searchParams.get("locationId")?.trim() || "";
  const risk = searchParams.get("risk")?.trim() || "all";
  const from = searchParams.get("from")?.trim() || "";
  const to = searchParams.get("to")?.trim() || "";
  const search = searchParams.get("search")?.trim().toLowerCase() || "";

  try {
    const conditions: string[] = ["ia.organization_id = $1"];
    const values: QueryValue[] = [orgId];

    if (ctx.allowedLocations !== null) {
      const allowedLocations = ctx.allowedLocations;
      if (allowedLocations.length === 0) {
        return NextResponse.json({ adjustments: [], summary: emptySummary(), pagination: { page, pageSize, total: 0, totalPages: 0 } });
      }
      conditions.push(`ia.location_id = ANY(${addParam(values, allowedLocations)}::uuid[])`);
    }

    if (locationId) {
      if (ctx.allowedLocations !== null && !ctx.allowedLocations.includes(locationId)) {
        return NextResponse.json({ adjustments: [], summary: emptySummary(), pagination: { page, pageSize, total: 0, totalPages: 0 } });
      }
      conditions.push(`ia.location_id = ${addParam(values, locationId)}::uuid`);
    }

    if (reason) conditions.push(`ia.reason = ${addParam(values, reason)}`);
    if (employeeId) conditions.push(`ia.employee_id = ${addParam(values, employeeId)}::uuid`);
    if (from) conditions.push(`ia.created_at >= ${addParam(values, from)}::timestamptz`);
    if (to) conditions.push(`ia.created_at < ${addParam(values, to)}::timestamptz`);
    if (risk === "large_negative") conditions.push(`ia.delta <= ${LARGE_NEGATIVE_THRESHOLD}`);
    if (risk === "after_hours") conditions.push(`(EXTRACT(HOUR FROM ia.created_at) < 7 OR EXTRACT(HOUR FROM ia.created_at) >= 21)`);
    if (search) {
      const escaped = search.replace(/[%_\\]/g, "\\$&");
      conditions.push(`(LOWER(p.name) ILIKE ${addParam(values, `%${escaped}%`)} OR LOWER(pv.sku) ILIKE $${values.length})`);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const countResult = await orgQuery(
      orgId,
      `SELECT COUNT(*)::int AS total
       FROM inventory_adjustments ia
       JOIN product_variants pv ON pv.id = ia.product_variant_id AND pv.organization_id = $1
       JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
       JOIN locations l ON l.id = ia.location_id AND l.organization_id = $1
       JOIN employees e ON e.id = ia.employee_id AND e.organization_id = $1
       ${whereClause}`,
      values,
    );

    const summaryResult = await orgQuery(
      orgId,
      `SELECT
         COUNT(*)::int AS total_adjustments,
         COALESCE(SUM(CASE WHEN ia.delta < 0 THEN ABS(ia.delta) ELSE 0 END), 0)::int AS units_removed,
         COALESCE(SUM(CASE WHEN ia.delta > 0 THEN ia.delta ELSE 0 END), 0)::int AS units_added,
         COUNT(*) FILTER (WHERE ia.delta <= ${LARGE_NEGATIVE_THRESHOLD})::int AS large_negative_count,
         COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM ia.created_at) < 7 OR EXTRACT(HOUR FROM ia.created_at) >= 21)::int AS after_hours_count
       FROM inventory_adjustments ia
       JOIN product_variants pv ON pv.id = ia.product_variant_id AND pv.organization_id = $1
       JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
       JOIN locations l ON l.id = ia.location_id AND l.organization_id = $1
       JOIN employees e ON e.id = ia.employee_id AND e.organization_id = $1
       ${whereClause}`,
      values,
    );

    const patternsResult = await orgQuery(
      orgId,
      `WITH base AS (
         SELECT ia.employee_id, ia.product_variant_id, ia.delta, ia.created_at,
                e.display_name AS employee_name, pv.sku, p.name AS product_name
         FROM inventory_adjustments ia
         JOIN product_variants pv ON pv.id = ia.product_variant_id AND pv.organization_id = $1
         JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
         JOIN locations l ON l.id = ia.location_id AND l.organization_id = $1
         JOIN employees e ON e.id = ia.employee_id AND e.organization_id = $1
         ${whereClause}
           AND ia.delta < 0
       ), employee_patterns AS (
         SELECT employee_id, employee_name, COUNT(*)::int AS adjustment_count,
                SUM(ABS(delta))::int AS units_removed, MAX(created_at) AS latest_at
         FROM base
         GROUP BY employee_id, employee_name
         HAVING COUNT(*) >= 3
         ORDER BY units_removed DESC, adjustment_count DESC
         LIMIT 5
       ), sku_patterns AS (
         SELECT product_variant_id, sku, product_name, COUNT(*)::int AS adjustment_count,
                SUM(ABS(delta))::int AS units_removed, MAX(created_at) AS latest_at
         FROM base
         GROUP BY product_variant_id, sku, product_name
         HAVING COUNT(*) >= 3
         ORDER BY units_removed DESC, adjustment_count DESC
         LIMIT 5
       ), repeated_pairs AS (
         SELECT employee_id, product_variant_id
         FROM base
         GROUP BY employee_id, product_variant_id
         HAVING COUNT(*) >= 3
       )
       SELECT
         COALESCE((SELECT JSON_AGG(employee_patterns) FROM employee_patterns), '[]'::json) AS employee_patterns,
         COALESCE((SELECT JSON_AGG(sku_patterns) FROM sku_patterns), '[]'::json) AS sku_patterns,
         (SELECT COUNT(*)::int FROM repeated_pairs) AS repeated_negative_count`,
      values,
    );

    const dataValues = [...values, pageSize, offset];
    const limitParam = `$${dataValues.length - 1}`;
    const offsetParam = `$${dataValues.length}`;
    const adjustmentsResult = await orgQuery(
      orgId,
      `SELECT
         ia.id,
         ia.inventory_level_id,
         ia.product_variant_id,
         ia.location_id,
         ia.employee_id,
         ia.reason,
         ia.delta,
         ia.resulting_on_hand,
         ia.created_at,
         pv.sku,
         pv.name AS variant_name,
         p.name AS product_name,
         l.name AS location_name,
         e.display_name AS employee_name,
         (ia.resulting_on_hand - ia.delta) AS previous_on_hand,
         (ia.delta <= ${LARGE_NEGATIVE_THRESHOLD}) AS is_large_negative,
         (EXTRACT(HOUR FROM ia.created_at) < 7 OR EXTRACT(HOUR FROM ia.created_at) >= 21) AS is_after_hours,
         (ia.delta < 0 AND COUNT(*) FILTER (WHERE ia.delta < 0) OVER (PARTITION BY ia.employee_id, ia.product_variant_id) >= 3) AS is_repeat_pattern
       FROM inventory_adjustments ia
       JOIN product_variants pv ON pv.id = ia.product_variant_id AND pv.organization_id = $1
       JOIN products p ON p.id = pv.product_id AND p.organization_id = $1
       JOIN locations l ON l.id = ia.location_id AND l.organization_id = $1
       JOIN employees e ON e.id = ia.employee_id AND e.organization_id = $1
       ${whereClause}
       ORDER BY ia.created_at DESC, ia.id DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      dataValues,
    );

    const total = Number(countResult.rows[0]?.total ?? 0);
    const patterns = patternsResult.rows[0] ?? { employee_patterns: [], sku_patterns: [], repeated_negative_count: 0 };
    return NextResponse.json({
      adjustments: adjustmentsResult.rows,
      summary: {
        ...(summaryResult.rows[0] ?? emptySummary()),
        repeated_negative_count: Number(patterns.repeated_negative_count ?? 0),
      },
      employeePatterns: patterns.employee_patterns ?? [],
      skuPatterns: patterns.sku_patterns ?? [],
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error("Inventory adjustments GET error:", safeErr(error));
    return NextResponse.json({ error: "Failed to fetch inventory adjustments" }, { status: 500 });
  }
});

function emptySummary() {
  return {
    total_adjustments: 0,
    units_removed: 0,
    units_added: 0,
    large_negative_count: 0,
    after_hours_count: 0,
    repeated_negative_count: 0,
  };
}
