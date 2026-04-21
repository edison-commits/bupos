import pg from "pg";
import fs from "node:fs";

for (const line of fs.readFileSync("/Users/edison/Desktop/bupos/code/.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^"|"$/g, "");
}

const ORG = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const LOC = "c57268b3-cb14-4c1a-bda6-55e49ddc6313";
const PROMO = "c0c1c2c3-eeee-ffff-aaaa-bbbbbbbbbbbb";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();

console.log("=== Inventory adjustments by reason (last 10 days) ===");
const { rows: adj } = await c.query(
  "SELECT reason, COUNT(*)::int AS n, SUM(delta)::int AS delta_sum FROM inventory_adjustments WHERE created_at >= NOW() - INTERVAL '10 days' AND location_id = $1 GROUP BY reason ORDER BY reason",
  [LOC],
);
console.table(adj);

console.log("\n=== Tender totals across sim week ===");
const { rows: td } = await c.query(
  "SELECT tt.tender_type, COUNT(*)::int AS n, ROUND(SUM(tt.amount)::numeric, 2)::text AS amt FROM transaction_tenders tt JOIN transactions t ON t.id = tt.transaction_id WHERE t.organization_id = $1 AND t.cart_snapshot->>'_sim' LIKE $2 GROUP BY tt.tender_type",
  [ORG, "sim-week-%"],
);
console.table(td);

console.log("\n=== Any shift with variance > $3 ===");
const { rows: bigVar } = await c.query(
  "SELECT opened_at::date AS day, ROUND(closing_variance::numeric, 2)::text AS variance FROM shifts WHERE opened_note LIKE $1 AND ABS(closing_variance) > 3 ORDER BY opened_at",
  ["Sim sim-week-%"],
);
console.log(bigVar.length === 0 ? "  ✓ None" : "");
if (bigVar.length > 0) console.table(bigVar);

console.log("\n=== Audit events from promo lifecycle ===");
const { rows: ae } = await c.query(
  "SELECT event_kind, COUNT(*)::int AS n FROM audit_events WHERE organization_id = $1 AND entity_type = 'promo_code' AND created_at >= NOW() - INTERVAL '10 days' GROUP BY event_kind",
  [ORG],
);
console.table(ae);

console.log("\n=== Free-line returns — refund_total should be $0 each ===");
const { rows: freeRet } = await c.query(
  "SELECT id, ROUND(grand_total::numeric, 2)::text AS grand FROM transactions WHERE organization_id = $1 AND cart_snapshot->>'_sim' LIKE $2 AND grand_total < 0 AND cart_snapshot::text LIKE '%promoCodeId%'",
  [ORG, "sim-week-%"],
);
console.log(`  ${freeRet.length} free-line return(s)`);
const nonZero = freeRet.filter((r) => parseFloat(r.grand) !== 0);
if (nonZero.length > 0) {
  console.log("  ⚠ Non-zero refund on free-line return:");
  console.table(nonZero);
} else {
  console.log("  ✓ All free-line returns refunded $0");
}

console.log("\n=== Total sim run revenue (net of returns) ===");
const { rows: net } = await c.query(
  "SELECT ROUND(SUM(grand_total)::numeric, 2)::text AS net_revenue, COUNT(*) FILTER (WHERE grand_total > 0) AS sales, COUNT(*) FILTER (WHERE grand_total < 0) AS returns FROM transactions WHERE organization_id = $1 AND cart_snapshot->>'_sim' LIKE $2",
  [ORG, "sim-week-%"],
);
console.table(net);

console.log("\n=== Promo reconciliation ===");
const { rows: pr } = await c.query(
  "SELECT p.code, p.current_redemptions, (SELECT COUNT(*)::int FROM promo_redemptions WHERE promo_code_id = p.id) AS rows, p.status FROM promo_codes p WHERE p.id = $1",
  [PROMO],
);
console.table(pr);

c.release();
await pool.end();
