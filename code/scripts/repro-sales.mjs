#!/usr/bin/env node
// Focused repro to characterize the offline-sync 500 + returns/process 500
// surfaced by the month sim. Fires many sales (varied shape) + returns
// against a single open shift and reports which SHAPES fail — to tell a
// deterministic code bug from infra/load flakiness.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const B = 'https://basicuniformpos.com';
const PW = 'Bupos2026!';
const DB = (() => { const m = readFileSync(new URL('../.env.local', import.meta.url), 'utf8').match(/^DATABASE_URL=(.+)$/m); return m[1].trim(); })();
const MGR = '4dcad700-6335-4e69-b4c3-c15e39e3e583';
const LOC = 'c57268b3-cb14-4c1a-bda6-55e49ddc6313';
const VARIANTS = [{ id: '3fcfb7b8', p: 54 }, { id: '13b7dd62', p: 54 }, { id: '20e5e39c', p: 22 }, { id: '021e7e4d', p: 22 }];
const TAX = 0.1025;
const r2 = (n) => Math.round(n * 100) / 100;
const withTax = (s) => r2(s + r2(s * TAX));
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const db = (sql) => execFileSync('psql', [DB, '-tAc', sql], { encoding: 'utf8' }).trim();

const jar = new Map();
const setJar = (h) => { for (const l of h.getSetCookie?.() ?? []) { const [p] = l.split(';'); const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
const ck = () => Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
async function call(method, path, body) {
  const h = new Headers({ origin: B, referer: `${B}/register`, 'content-type': 'application/json' });
  if (ck()) h.set('cookie', ck());
  const res = await fetch(`${B}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  setJar(res.headers);
  let j = null; const t = await res.text().catch(() => ''); try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t };
}

// resolve full variant uuids + create a customer (for store_credit returns)
let CUSTOMER_ID = null;
async function fullVariants() {
  await call('POST', '/api/auth/login', { email: 'admin@bupos.com', password: PW });
  const r = await call('GET', '/api/products');
  const out = [];
  for (const p of (r.json?.products ?? [])) for (const v of (p.variants ?? [])) if (v.id) out.push({ id: v.id, p: Number(v.price ?? p.price) });
  const c = await call('POST', '/api/customers', { first_name: 'Repro', last_name: `Cust${Math.floor(Math.random() * 99999)}`, email: `repro${Math.floor(Math.random() * 99999)}@example.com` });
  CUSTOMER_ID = c.json?.customer?.id ?? c.json?.id ?? null;
  console.log(`customer=${CUSTOMER_ID?.slice(0, 8)}`);
  jar.clear();
  return out;
}

const main = async () => {
  const variants = await fullVariants();
  console.log(`variants: ${variants.length}`);
  await call('POST', '/api/auth/register-login', { pin: '2222', locationId: LOC, deviceId: 'repro-dev' });
  const rsid = db(`SELECT id FROM register_sessions WHERE auth_session_id='${jar.get('bupos_r')}' AND status='active' ORDER BY started_at DESC LIMIT 1`);
  console.log(`register_session=${rsid?.slice(0, 8)}`);
  const open = await call('POST', '/api/cash-drawer', { action: 'open_shift', opening_float: 200, note: 'repro' });
  const shiftId = open.json?.shift?.id;
  console.log(`open_shift=${open.status} shift=${shiftId?.slice(0, 8)}\n`);

  const byShape = {}; const txns = [];
  const N = 50;
  for (let i = 0; i < N; i++) {
    const mode = pick(['cash', 'cash', 'card', 'split']);
    const nLines = ri(1, 3); const hasCust = false;
    const lines = []; for (let L = 0; L < nLines; L++) { const v = pick(variants); lines.push({ productVariantId: v.id, quantity: ri(1, 3), unitPrice: v.p }); }
    const sub = r2(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0)); const total = withTax(sub);
    let tenders;
    if (mode === 'cash') tenders = [{ type: 'cash', amount: total }];
    else if (mode === 'card') tenders = [{ type: 'card', amount: total }];
    else { const c = r2(total / 2); tenders = [{ type: 'cash', amount: c }, { type: 'card', amount: r2(total - c) }]; }
    const shape = `${mode}/${nLines}L`;
    const r = await call('POST', '/api/offline-sync', { id: randomUUID(), cart: { employeeId: MGR, registerSessionId: rsid, customerId: CUSTOMER_ID, items: lines }, tenders, registerSessionId: rsid, timestamp: new Date().toISOString() });
    byShape[shape] = byShape[shape] || { ok: 0, fail: 0, codes: {} };
    if (r.status === 200) { byShape[shape].ok++; txns.push({ id: r.json.transactionId, lines }); }
    else { byShape[shape].fail++; byShape[shape].codes[r.status] = (byShape[shape].codes[r.status] || 0) + 1; byShape[shape].sample = `${r.status} ${r.text.slice(0, 80)}`; }
    await new Promise((res) => setTimeout(res, 8));
  }
  console.log('=== sales by shape ===');
  for (const [s, v] of Object.entries(byShape)) console.log(`  ${s.padEnd(10)} ok=${v.ok} fail=${v.fail} ${v.fail ? JSON.stringify(v.codes) + ' ' + (v.sample || '') : ''}`);
  const tot = Object.values(byShape).reduce((a, v) => ({ ok: a.ok + v.ok, fail: a.fail + v.fail }), { ok: 0, fail: 0 });
  console.log(`  TOTAL ok=${tot.ok} fail=${tot.fail} (${(100 * tot.fail / N).toFixed(0)}% fail)\n`);

  // returns: VERY slow (3.5s, fully avoid the rate-limiter) + customer-backed
  // store_credit so the full ledger path runs. Print EXACT response per return.
  console.log('=== returns/process (3.5s apart, customer store_credit) ===');
  let rok = 0, rfail = 0; const rcodes = {};
  const uniqTxns = [...new Map(txns.map((t) => [t.id, t])).values()]; // distinct txns, avoid prior-refund cap
  for (let i = 0; i < 5 && i < uniqTxns.length; i++) {
    const txn = uniqTxns[i]; const line = txn.lines.find((l) => l.unitPrice <= 30) ?? txn.lines[0];
    const r = await call('POST', '/api/returns/process', { transaction_id: txn.id, customer_name: 'Repro', reason: 'defective', refund_method: 'store_credit', items: [{ variantId: line.productVariantId, quantity: 1, unitPrice: line.unitPrice, restock: true }], refund_amount: withTax(line.unitPrice), actorPassword: PW });
    console.log(`  return ${i + 1}: ${r.status} ${r.text.slice(0, 140)}`);
    if (r.status === 200 || r.status === 201) rok++; else { rfail++; rcodes[r.status] = (rcodes[r.status] || 0) + 1; }
    await new Promise((res) => setTimeout(res, 3500));
  }
  console.log(`  returns ok=${rok} fail=${rfail} ${JSON.stringify(rcodes)}`);

  if (shiftId) await call('POST', '/api/cash-drawer', { action: 'close_shift', shift_id: shiftId, declared_cash: 200, note: 'repro', actorPassword: PW });
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
