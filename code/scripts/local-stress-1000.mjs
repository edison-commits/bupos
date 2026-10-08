#!/usr/bin/env node
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import { request } from "playwright";

const { Pool } = pg;
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3101";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/bupos_test";
const TOTAL = Number(process.env.TOTAL_TXNS ?? 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 24);
const ORG = "e2e11111-1111-4111-8111-111111111111";
const LOCATION = "e2e22222-2222-4222-8222-222222222222";
const OWNER = "e2e44444-4444-4444-8444-444444444444";
const CASHIER = "e2e55555-5555-4555-8555-555555555555";
const VARIANTS = [
  { id: "e2e99999-9999-4999-8999-999999999981", price: 34 },
  { id: "e2e99999-9999-4999-8999-999999999982", price: 58 },
  { id: "e2e99999-9999-4999-8999-999999999983", price: 18 },
  { id: "e2e99999-9999-4999-8999-999999999984", price: 86 },
];
const RUN = `local-stress-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
const pool = new Pool({ connectionString: DATABASE_URL, max: CONCURRENCY + 4 });
const round2 = (n) => Math.round(n * 100) / 100;
const uuid = () => crypto.randomUUID();

async function sql(text, params = []) { return pool.query(text, params); }

async function prepareFixtures() {
  await sql(`
    INSERT INTO employees (id, organization_id, role_key, first_name, last_name, display_name, email, pin_hint, is_active, location_ids)
    VALUES ($1, $2, 'cashier', 'Stress', 'Cashier', 'Stress Cashier', 'stress.cashier@fixture.test', '', true, ARRAY[$3]::uuid[])
    ON CONFLICT (id) DO UPDATE SET is_active = true, location_ids = EXCLUDED.location_ids`, [CASHIER, ORG, LOCATION]);
  for (const v of VARIANTS) {
    await sql(`
      INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, reserved, reorder_point)
      VALUES ($1, $2, $3, $4, 0, 10)
      ON CONFLICT (product_variant_id, location_id) DO UPDATE SET on_hand = GREATEST(inventory_levels.on_hand, $4), reserved = 0`,
      [ORG, v.id, LOCATION, TOTAL + 100]);
  }
}

async function exerciseLoginAndShift() {
  const ctx = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const login = await ctx.post("/api/auth/login", { data: { email: "e2e-admin@bupos.test", password: "P4ssword!e2e" } });
  const loginBody = await login.json().catch(() => ({}));
  if (!login.ok()) throw new Error(`admin login failed: ${login.status()} ${JSON.stringify(loginBody)}`);
  const key = `stress-shift-${RUN}`;
  const open = await ctx.post("/api/shifts", {
    headers: { "Idempotency-Key": key },
    data: { employeeId: CASHIER, locationId: LOCATION, openingFloat: 0, openedNote: RUN },
  });
  const openBody = await open.json().catch(() => ({}));
  if (!open.ok()) throw new Error(`shift open failed: ${open.status()} ${JSON.stringify(openBody)}`);
  const shiftId = openBody.shift?.id;
  if (!shiftId) throw new Error(`shift open returned no id: ${JSON.stringify(openBody)}`);
  await sql(`UPDATE shifts SET closed_at = now(), status = 'closed', closing_expected_cash = 0, closing_declared_cash = 0, closing_variance = 0 WHERE id = $1 AND organization_id = $2`, [shiftId, ORG]);
  await ctx.dispose();
  return { loginStatus: login.status(), shiftOpenStatus: open.status(), shiftId };
}

async function writeOne(i, registerSessionId) {
  const client = await pool.connect();
  const started = performance.now();
  const txnId = uuid();
  const v = VARIANTS[i % VARIANTS.length];
  const quantity = 1;
  const subtotal = round2(v.price * quantity);
  const tax = 0;
  const total = subtotal;
  const now = new Date().toISOString();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [ORG]);
    await client.query(`SELECT product_variant_id FROM inventory_levels WHERE organization_id=$1 AND product_variant_id=$2 AND location_id=$3 FOR UPDATE`, [ORG, v.id, LOCATION]);
    const inv = await client.query(`UPDATE inventory_levels SET on_hand = on_hand - $1, updated_at = now() WHERE organization_id=$2 AND product_variant_id=$3 AND location_id=$4 AND on_hand >= $1 RETURNING on_hand`, [quantity, ORG, v.id, LOCATION]);
    if (inv.rowCount !== 1) throw new Error("inventory exhausted or missing");
    const snapshot = { _stressRun: RUN, source: "local-e2e-stress", items: [{ productVariantId: v.id, quantity, unitPrice: v.price }] };
    await client.query(`INSERT INTO transactions (id, organization_id, location_id, register_session_id, employee_id, cart_snapshot, subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered, change_due, status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,'card',$9,0,'completed',$10,$10)`, [txnId, ORG, LOCATION, registerSessionId, OWNER, JSON.stringify(snapshot), subtotal, tax, total, now]);
    await client.query(`INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata, created_at) VALUES ($1,$2,'card',$3,'{}',$4)`, [uuid(), txnId, total, now]);
    await client.query("COMMIT");
    return { ok: true, ms: performance.now() - started };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, ms: performance.now() - started, error: String(error?.message ?? error).slice(0, 240) };
  } finally { client.release(); }
}

async function main() {
  const started = new Date().toISOString();
  await prepareFixtures();
  const auth = await exerciseLoginAndShift();
  const { rows: sessionRows } = await sql(`SELECT id FROM register_sessions WHERE organization_id=$1 AND status IN ('active','open') ORDER BY created_at DESC NULLS LAST LIMIT 1`, [ORG]);
  const registerSessionId = sessionRows[0]?.id ?? "e2e66666-6666-4666-8666-666666666661";
  const results = [];
  let next = 0;
  async function worker() { while (true) { const i = next++; if (i >= TOTAL) return; results[i] = await writeOne(i, registerSessionId); } }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const lat = ok.map(r => r.ms).sort((a,b) => a-b);
  const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : null;
  const { rows: counts } = await sql(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='completed')::int AS completed, COALESCE(SUM(grand_total),0)::numeric AS gross FROM transactions WHERE organization_id=$1 AND cart_snapshot->>'_stressRun'=$2`, [ORG, RUN]);
  const { rows: badInventory } = await sql(`SELECT product_variant_id, on_hand FROM inventory_levels WHERE organization_id=$1 AND location_id=$2 AND on_hand < 0`, [ORG, LOCATION]);
  const { rows: badTenders } = await sql(`SELECT t.id FROM transactions t LEFT JOIN (SELECT transaction_id, SUM(amount) AS tender_sum FROM transaction_tenders GROUP BY transaction_id) x ON x.transaction_id=t.id WHERE t.organization_id=$1 AND t.cart_snapshot->>'_stressRun'=$2 AND ABS(COALESCE(x.tender_sum,0)-t.grand_total)>0.01 LIMIT 20`, [ORG, RUN]);
  const report = { run: RUN, started, finished: new Date().toISOString(), target: { baseUrl: BASE_URL, database: "localhost:54329/bupos_test", total: TOTAL, concurrency: CONCURRENCY }, auth, writes: { attempted: TOTAL, succeeded: ok.length, failed: failed.length, errors: failed.slice(0, 20), latencyMs: { p50: pct(.50), p95: pct(.95), p99: pct(.99), max: lat.at(-1) ?? null } }, invariants: { persisted: counts[0], negativeInventoryRows: badInventory, tenderMismatches: badTenders }, pass: failed.length === 0 && Number(counts[0].total) === TOTAL && badInventory.length === 0 && badTenders.length === 0 };
  fs.writeFileSync(`/tmp/${RUN}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
  if (!report.pass) process.exitCode = 1;
}
main().catch(async (e) => { console.error(e); await pool.end(); process.exitCode = 1; });
