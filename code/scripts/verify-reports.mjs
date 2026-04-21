import pg from "pg";
import fs from "node:fs";

for (const line of fs.readFileSync("/Users/edison/Desktop/bupos/code/.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^"|"$/g, "");
}

const ORG = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();

// 1. Dashboard-like: revenue last 7 days, excluding returns from "sales"
console.log("=== Gross sales vs refunds per day (dashboard-style) ===");
const { rows: dash } = await c.query(`
  SELECT DATE(created_at) AS day,
    COUNT(*) FILTER (WHERE grand_total > 0)::int AS sales_count,
    ROUND(SUM(grand_total) FILTER (WHERE grand_total > 0)::numeric, 2)::text AS gross_sales,
    COUNT(*) FILTER (WHERE grand_total < 0)::int AS return_count,
    ROUND(SUM(-grand_total) FILTER (WHERE grand_total < 0)::numeric, 2)::text AS refunded,
    ROUND(SUM(grand_total)::numeric, 2)::text AS net_revenue
  FROM transactions
  WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '8 days' AND status = 'completed'
  GROUP BY DATE(created_at) ORDER BY day
`, [ORG]);
console.table(dash);

// 2. Employee performance: txns per employee
console.log("\n=== Per-employee totals (sim week) ===");
const { rows: emp } = await c.query(`
  SELECT e.display_name, COUNT(*)::int AS txns, ROUND(SUM(t.grand_total)::numeric, 2)::text AS revenue
  FROM transactions t
  JOIN employees e ON e.id = t.employee_id
  WHERE t.organization_id = $1 AND t.cart_snapshot->>'_sim' LIKE $2
  GROUP BY e.display_name ORDER BY revenue::numeric DESC
`, [ORG, "sim-week-%"]);
console.table(emp);

// 3. Top-selling variants
console.log("\n=== Top-selling variants (unit count) ===");
const { rows: top } = await c.query(`
  SELECT pv.sku, pv.name,
    -SUM(ia.delta) FILTER (WHERE ia.reason = 'sale') AS units_sold,
    SUM(ia.delta) FILTER (WHERE ia.reason = 'return') AS units_returned,
    (-SUM(ia.delta) FILTER (WHERE ia.reason = 'sale')) - COALESCE(SUM(ia.delta) FILTER (WHERE ia.reason = 'return'), 0) AS net
  FROM inventory_adjustments ia
  JOIN product_variants pv ON pv.id = ia.product_variant_id
  WHERE ia.created_at >= NOW() - INTERVAL '10 days' AND ia.location_id = $1
  GROUP BY pv.sku, pv.name ORDER BY units_sold DESC NULLS LAST
`, ["c57268b3-cb14-4c1a-bda6-55e49ddc6313"]);
console.table(top);

// 4. Returns summary
console.log("\n=== Returns summary (last 10 days) ===");
const { rows: ret } = await c.query(`
  SELECT
    COUNT(*)::int AS total_returns,
    COUNT(*) FILTER (WHERE grand_total = 0)::int AS free_only_returns,
    COUNT(*) FILTER (WHERE grand_total < 0)::int AS paid_returns,
    ROUND(SUM(-grand_total) FILTER (WHERE grand_total < 0)::numeric, 2)::text AS total_refunded
  FROM transactions
  WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '10 days'
    AND cart_snapshot->>'isReturn' = 'true'
`, [ORG]);
console.table(ret);

// 5. Bundle line check: are bundle cart_snapshot items decrementing component inventory?
console.log("\n=== Bundle sales: did component inventory track correctly? ===");
const { rows: bundleData } = await c.query(`
  SELECT
    (SELECT COUNT(*)::int FROM transactions WHERE cart_snapshot::text LIKE '%bundleId%' AND cart_snapshot->>'_sim' LIKE $1) AS bundle_txns,
    (SELECT -SUM(ia.delta)::int FROM inventory_adjustments ia WHERE ia.reason = 'sale' AND ia.product_variant_id = '3fcfb7b8-856c-4ed7-8cd2-cbb1666f2e18' AND ia.created_at >= NOW() - INTERVAL '10 days') AS jean_28_sold,
    (SELECT -SUM(ia.delta)::int FROM inventory_adjustments ia WHERE ia.reason = 'sale' AND ia.product_variant_id = '20e5e39c-fa01-41ed-9a48-fe9886b0dc75' AND ia.created_at >= NOW() - INTERVAL '10 days') AS tee_white_sold
`, ["sim-week-%"]);
console.table(bundleData);

c.release();
await pool.end();
