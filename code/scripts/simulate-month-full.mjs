#!/usr/bin/env node
/**
 * COMPREHENSIVE month-of-usage simulation for basicuniformpos.com.
 *
 * Unlike simulate-month-http.mjs (read-heavy: logins + shifts + reads),
 * this drives the full WRITE surface end-to-end against a live instance:
 *
 *   Owner/admin session (email+password)
 *     - reads: dashboard, reports, customers, employees, inventory,
 *       transactions, audit, eod-report, reorder-suggestions, promos,
 *       suppliers, expenses, loyalty, tax-config, settings, locations
 *     - writes: create customer, create promo, gift-card activate/reload,
 *       store-credit issue, PO create + receive, transfer create/ship/
 *       receive, blind receiving, expense create
 *   Cashier register session (PIN clock-in)
 *     - cash-drawer open_shift / pay_in / pay_out / close_shift
 *     - real SALES via /api/offline-sync (cash / card / split tenders)
 *     - RETURNS via /api/returns/process
 *   Manager register session (PIN) — exercises the manager role at a register
 *
 * THE SALES PROBLEM: /api/offline-sync needs the register_sessions.id, and
 * the API deliberately never returns it ("Never expose internal IDs"). The
 * real POS client gets it from server-rendered context. On this AUTHORIZED
 * TEST INSTANCE we look it up from the SAME database the site uses
 * (DATABASE_URL, from .env.local), keyed by the register cookie's session
 * id (register_sessions.auth_session_id = the bupos_r cookie value). If
 * DATABASE_URL is absent/unreachable, sales + returns are skipped and the
 * rest still runs.
 *
 * Usage:
 *   DATABASE_URL=... \   (defaults to the one in .env.local)
 *   BUPOS_URL=https://basicuniformpos.com \
 *   ADMIN_EMAIL=admin@bupos.com ADMIN_PASSWORD=Bupos2026! \
 *   CASHIER_PIN=3333 MANAGER_PIN=2222 \
 *   DAYS=26 SALES_MIN=5 SALES_MAX=11 \
 *   node scripts/simulate-month-full.mjs
 *
 * SAFETY: creates REAL shifts/sales/returns/customers/POs/etc. on the
 * target tenant. Prod-host allowlist guard below refuses unknown hosts.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ─── Config ─────────────────────────────────────────────────────────────
const BUPOS_URL = process.env.BUPOS_URL ?? 'https://basicuniformpos.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@bupos.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Bupos2026!';
const CASHIER_PIN = process.env.CASHIER_PIN ?? '3333';
const MANAGER_PIN = process.env.MANAGER_PIN ?? '2222';
const DAYS = Number(process.env.DAYS ?? 26);
const SALES_MIN = Number(process.env.SALES_MIN ?? 5);
const SALES_MAX = Number(process.env.SALES_MAX ?? 11);
const DELAY_MS = Number(process.env.DELAY_MS ?? 35);
const RELOGIN_ADMIN = 7;     // owner re-login cadence (rate-limit friendly)
const RELOGIN_REGISTER = 10; // cashier re-login cadence

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
const DATABASE_URL = resolveDatabaseUrl();

const REGISTER_COOKIE = 'bupos_r';

// ─── Prod-host guard ────────────────────────────────────────────────────
{
  const host = new URL(BUPOS_URL).hostname.toLowerCase();
  const ALLOWED = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'basicuniformpos.com', 'www.basicuniformpos.com']);
  if (!ALLOWED.has(host) && process.env.SIMULATE_FORCE !== '1') {
    throw new Error(`[sim] refusing to run against '${host}' — set SIMULATE_FORCE=1 to override.`);
  }
}

// ─── tiny RNG helpers (plain node — Math.random OK here) ────────────────
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const r2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// offline-sync computes grandTotal = round(taxable + round(taxable*rate,2), 2)
const TAX_RATE = Number(process.env.TAX_RATE ?? 0.1025);
const withTax = (subtotal) => r2(subtotal + r2(subtotal * TAX_RATE));

// ─── DB helper (registerSessionId lookup + discovery anchors) ───────────
function dbQuery(sql) {
  if (!DATABASE_URL) return null;
  try {
    return execFileSync('psql', [DATABASE_URL, '-tAc', sql], { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (e) {
    console.warn(`  [db] query failed: ${String(e.message || e).slice(0, 120)}`);
    return null;
  }
}
function lookupRegisterSessionId(sessionCookieValue) {
  if (!sessionCookieValue) return null;
  const safe = sessionCookieValue.replace(/'/g, "''");
  const id = dbQuery(`SELECT id FROM register_sessions WHERE auth_session_id='${safe}' AND status='active' ORDER BY started_at DESC LIMIT 1`);
  return id || null;
}

// ─── cookie jar + request helper (from simulate-month-http.mjs) ─────────
function makeJar() {
  const jar = new Map();
  return {
    setFromHeaders(headers) {
      for (const line of headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    cookieHeader() { return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; '); },
    get(name) { return jar.get(name); },
    clear() { jar.clear(); },
  };
}

const errors = [];
const stats = new Map();
function record(method, path, status, ms) {
  const key = `${method} ${path}`;
  let s = stats.get(key);
  if (!s) { s = { count: 0, ok: 0, fail: 0, codes: new Map(), totalMs: 0 }; stats.set(key, s); }
  s.count++; s.totalMs += ms;
  s.codes.set(status, (s.codes.get(status) ?? 0) + 1);
  if (status >= 200 && status < 400) s.ok++; else s.fail++;
}

// normalize path for stats (strip query + ids) so buckets aggregate
function statKey(path) {
  return path.split('?')[0].replace(/\/[0-9a-f-]{36}/gi, '/:id');
}

async function req(jar, method, path, { body, headers = {}, capture = false, scenario = '?', day = 0 } = {}) {
  const url = `${BUPOS_URL}${path}`;
  const h = new Headers(headers);
  if (jar.cookieHeader()) h.set('cookie', jar.cookieHeader());
  if (body && !h.has('content-type')) h.set('content-type', 'application/json');
  if (!h.has('origin')) h.set('origin', BUPOS_URL);
  if (!h.has('referer')) h.set('referer', `${BUPOS_URL}/admin`);
  const start = Date.now();
  let status = 0, text = null, json = null, errMsg = null;
  try {
    const res = await fetch(url, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    status = res.status;
    jar.setFromHeaders(res.headers);
    const redirect = [301, 302, 303, 307, 308].includes(status);
    if (capture || (status >= 400 && !redirect)) {
      try { text = await res.text(); } catch { text = ''; }
      if (capture && text) { try { json = JSON.parse(text); } catch { /* non-json */ } }
    }
  } catch (e) {
    errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const ms = Date.now() - start;
  record(method, statKey(path), status, ms);
  if (status === 0 || status >= 400) {
    errors.push({ day, scenario, method, path: statKey(path), status, body: (text || '').slice(0, 300), err: errMsg });
  }
  return { status, json, text };
}

// ─── Scenario building blocks ───────────────────────────────────────────
async function ownerLogin(jar, day) {
  jar.clear();
  return req(jar, 'POST', '/api/auth/login', { body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }), scenario: 'owner-login', day });
}
async function registerLogin(jar, pin, locationId, day, who) {
  jar.clear();
  const deviceId = `sim-${who}-device`;
  const r = await req(jar, 'POST', '/api/auth/register-login', { body: JSON.stringify({ pin, locationId, deviceId }), scenario: `${who}-pin-login`, day });
  return r.status === 200;
}

const ADMIN_READS = [
  '/api/dashboard?range=today', '/api/dashboard?range=week',
  '/api/customers?page=1&pageSize=20', '/api/employees',
  '/api/inventory?page=1&pageSize=20', '/api/transactions?page=1&pageSize=10',
  '/api/audit?page=1&pageSize=10', '/api/promo-codes', '/api/suppliers',
  '/api/expenses', '/api/loyalty', '/api/tax-config', '/api/settings',
  '/api/locations', '/api/reorder-suggestions', '/api/eod-report', '/api/bundles',
];
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH_AGO = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
async function ownerReads(jar, day) {
  // hit ~half the read surface each day, rotating
  const shuffled = [...ADMIN_READS].sort(() => Math.random() - 0.5).slice(0, ri(8, ADMIN_READS.length));
  for (const p of shuffled) { await req(jar, 'GET', p, { scenario: 'admin-read', day }); }
  // reports need type+from+to
  for (const t of ['summary', 'tender']) {
    await req(jar, 'GET', `/api/reports?type=${t}&from=${MONTH_AGO}&to=${TODAY}`, { scenario: 'admin-read', day });
  }
}

// ─── main ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`→ BuPOS FULL month simulator: ${BUPOS_URL} · ${DAYS} days · sales/day ${SALES_MIN}-${SALES_MAX}`);
  console.log(`  DB lookup for register sessions: ${DATABASE_URL ? 'enabled' : 'DISABLED (no DATABASE_URL — sales/returns skipped)'}\n`);

  const adminJar = makeJar();
  const regJar = makeJar();

  // ── Discovery ──
  await ownerLogin(adminJar, -1);
  const g = async (p) => { const r = await req(adminJar, 'GET', p, { capture: true, scenario: 'discover', day: -1 }); return r.json; };

  // products → sellable variants with prices
  const prodResp = await g('/api/products');
  const variants = [];
  for (const p of (prodResp?.products ?? [])) {
    const vs = p.variants?.length ? p.variants : (p.variant_id ? [{ id: p.variant_id, price: p.price }] : []);
    for (const v of vs) if (v.id != null) variants.push({ id: v.id, price: Number(v.price ?? p.price ?? 0), name: p.name });
  }
  const supResp = await g('/api/suppliers');
  const suppliers = (supResp?.suppliers ?? supResp ?? []).filter?.((s) => s?.id) ?? [];
  const locResp = await g('/api/locations');
  const locations = (locResp?.locations ?? []).filter((l) => l?.id);

  // anchors from DB (cashier id+location, manager id+location, org)
  let cashierId = null, cashierLoc = null, managerId = null, managerLoc = null, org = null;
  if (DATABASE_URL) {
    org = dbQuery(`SELECT id FROM organizations WHERE id::text LIKE '33262270%' LIMIT 1`);
    const row = dbQuery(`SELECT role_key||'|'||id||'|'||COALESCE(location_ids[1]::text,'') FROM employees WHERE organization_id='${org}' AND is_active AND role_key IN ('cashier','manager') ORDER BY role_key`);
    for (const line of (row || '').split('\n')) {
      const [role, id, loc] = line.split('|');
      if (role === 'cashier') { cashierId = id; cashierLoc = loc; }
      if (role === 'manager') { managerId = id; managerLoc = loc; }
    }
  }
  console.log(`  discovered: ${variants.length} variants, ${suppliers.length} suppliers, ${locations.length} locations`);
  console.log(`  cashier=${cashierId?.slice(0, 8) ?? '?'}@${cashierLoc?.slice(0, 8) ?? '?'}  manager=${managerId?.slice(0, 8) ?? '?'}@${managerLoc?.slice(0, 8) ?? '?'}\n`);

  // Register operator: the cashier PIN (3333, per stale docs) no longer
  // matches its hash on this instance, so drive register ops as the MANAGER
  // (2222) — who has register.pin_login + all locations. Operate at the
  // cashier's big-stock location (c57268b3) so sales never hit a stock wall.
  const regPin = MANAGER_PIN;
  const regEmpId = managerId;
  const regLoc = cashierLoc || managerLoc;
  const regWho = 'manager-reg';
  const canSell = !!(DATABASE_URL && regEmpId && regLoc && variants.length);

  // close leftover open shifts (admin)
  const openShifts = await g('/api/shifts?status=open&page=1&pageSize=50');
  for (const s of (openShifts?.shifts ?? [])) {
    await req(adminJar, 'POST', '/api/shift-close', { body: JSON.stringify({ shiftId: s.id, declaredCash: s.openingFloat ?? 200, actorPassword: ADMIN_PASSWORD }), scenario: 'close-leftover', day: -1 });
  }

  // register-login the operator once up front
  let regSessionId = null;
  if (canSell) {
    const ok = await registerLogin(regJar, regPin, regLoc, -1, regWho);
    if (ok) { regSessionId = lookupRegisterSessionId(regJar.get(REGISTER_COOKIE)); }
    console.log(`  register session (manager@${regLoc?.slice(0, 8)}): ${ok ? (regSessionId ? regSessionId.slice(0, 8) : 'login-ok-but-no-session-id') : 'LOGIN FAILED'}\n`);
  }

  const capturedTxns = [];   // {id, lines:[{variantId,qty,price}]}
  const customers = [];      // ids
  const giftCards = [];      // {id, code}
  let salesOk = 0, salesFail = 0, returnsOk = 0, shiftsOpened = 0;

  for (let d = 0; d < DAYS; d++) {
    process.stdout.write(`  day ${String(d + 1).padStart(2)}/${DAYS} `);

    if (d > 0 && d % RELOGIN_ADMIN === 0) await ownerLogin(adminJar, d);

    // ── owner morning admin reads ──
    await ownerReads(adminJar, d);
    await sleep(DELAY_MS);

    // ── cashier shift + sales + returns ──
    if (canSell) {
      if (d > 0 && d % RELOGIN_REGISTER === 0) {
        const ok = await registerLogin(regJar, regPin, regLoc, d, regWho);
        if (ok) regSessionId = lookupRegisterSessionId(regJar.get(REGISTER_COOKIE));
      }
      if (regSessionId) {
        // open shift (capture shift id for pay-in/out/close)
        const openR = await req(regJar, 'POST', '/api/cash-drawer', { body: JSON.stringify({ action: 'open_shift', opening_float: 200, note: `day ${d + 1}` }), capture: true, scenario: 'open-shift', day: d });
        let shiftId = openR.json?.shift?.id ?? null;
        if (shiftId) shiftsOpened++;

        // sales
        const nSales = ri(SALES_MIN, SALES_MAX);
        let cashCollected = 0;
        for (let i = 0; i < nSales; i++) {
          const nLines = ri(1, 3);
          const lines = [];
          for (let L = 0; L < nLines; L++) {
            const v = pick(variants); const qty = ri(1, 3);
            lines.push({ productVariantId: v.id, quantity: qty, unitPrice: v.price });
          }
          const subtotal = r2(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
          const total = withTax(subtotal); // tenders must cover total incl. tax
          // tender mix: cash | card | split (only cash may overpay -> change)
          const mode = pick(['cash', 'cash', 'card', 'split']);
          let tenders;
          if (mode === 'cash') { const pay = chance(0.3) ? r2(total + ri(1, 5)) : total; tenders = [{ type: 'cash', amount: pay }]; cashCollected += pay; }
          else if (mode === 'card') { tenders = [{ type: 'card', amount: total }]; }
          else { const c = r2(total / 2); tenders = [{ type: 'cash', amount: c }, { type: 'card', amount: r2(total - c) }]; cashCollected += c; }
          const cart = { employeeId: regEmpId, registerSessionId: regSessionId, items: lines };
          if (customers.length && chance(0.3)) cart.customerId = pick(customers);
          const sale = await req(regJar, 'POST', '/api/offline-sync', {
            headers: { 'Idempotency-Key': `sim-${d}-${i}-${randomUUID()}` },
            body: JSON.stringify({ id: randomUUID(), cart, tenders, registerSessionId: regSessionId, timestamp: new Date().toISOString() }),
            capture: true, scenario: 'sale', day: d,
          });
          if (sale.status === 200 && sale.json?.transactionId) { salesOk++; capturedTxns.push({ id: sale.json.transactionId, lines }); }
          else salesFail++;
          await sleep(8);
        }

        // returns — a couple small ones against recent sales (under manager threshold)
        const nReturns = ri(0, 2);
        for (let i = 0; i < nReturns && capturedTxns.length; i++) {
          const txn = pick(capturedTxns.slice(-15));
          const line = txn.lines.find((l) => l.unitPrice <= 30) ?? txn.lines[0];
          const refund = r2(Math.min(line.unitPrice, 25));
          await req(regJar, 'POST', '/api/returns/process', {
            headers: { 'Idempotency-Key': `simret-${d}-${i}-${randomUUID()}` },
            body: JSON.stringify({ transaction_id: txn.id, reason: pick(['damaged', 'wrong_item', 'other']), refund_method: pick(['store_credit', 'cash']), items: [{ variantId: line.productVariantId, quantity: 1, unitPrice: line.unitPrice, restock: chance(0.7) }], refund_amount: refund }),
            capture: true, scenario: 'return', day: d,
          }).then((r) => { if (r.status === 200 || r.status === 201) returnsOk++; });
        }

        // pay-in / pay-out (under $50 to avoid approval), then close
        if (shiftId && chance(0.5)) await req(regJar, 'POST', '/api/cash-drawer', { body: JSON.stringify({ action: 'pay_in', shift_id: shiftId, amount: ri(10, 40), reason: 'change order', note: 'sim' }), scenario: 'pay-in', day: d });
        if (shiftId && chance(0.5)) await req(regJar, 'POST', '/api/cash-drawer', { body: JSON.stringify({ action: 'pay_out', shift_id: shiftId, amount: ri(10, 40), reason: 'supplies', note: 'sim' }), scenario: 'pay-out', day: d });
        // close shift
        if (shiftId) {
          await req(regJar, 'POST', '/api/cash-drawer', { body: JSON.stringify({ action: 'close_shift', shift_id: shiftId, declared_cash: r2(200 + cashCollected), note: 'EOD sim' }), scenario: 'close-shift', day: d });
        }
      }
      await sleep(DELAY_MS);
    }

    // ── admin writes (rotate; not every day) ──
    if (d % 3 === 0) {
      // create customer
      const cr = await req(adminJar, 'POST', '/api/customers', { body: JSON.stringify({ first_name: `Sim${d}`, last_name: `Cust${ri(1, 999)}`, email: `sim${d}.${ri(1, 99999)}@example.com`, phone: `555${ri(1000000, 9999999)}` }), capture: true, scenario: 'create-customer', day: d });
      const cid = cr.json?.customer?.id ?? cr.json?.id;
      if (cid) customers.push(cid);
    }
    if (d % 4 === 1) {
      // create promo
      const t = pick(['fixed', 'percent']);
      await req(adminJar, 'POST', '/api/promo-codes', { body: JSON.stringify({ action: 'create', code: `SIM${d}${ri(100, 999)}`, description: 'sim promo', type: t, value: t === 'percent' ? ri(5, 20) : ri(2, 8), minimumPurchase: 0, actorPassword: ADMIN_PASSWORD }), scenario: 'create-promo', day: d });
    }
    if (d % 5 === 2 && customers.length) {
      // store credit issue
      await req(adminJar, 'POST', '/api/store-credit', { body: JSON.stringify({ customerId: pick(customers), amount: ri(5, 30), reason: 'sim goodwill', actorPassword: ADMIN_PASSWORD }), scenario: 'store-credit', day: d });
    }
    if (d % 5 === 3) {
      // gift card activate (+ occasional reload)
      const code = `SIMGC${d}${ri(1000, 9999)}`;
      const gc = await req(adminJar, 'POST', '/api/gift-cards', { body: JSON.stringify({ action: 'activate', code, amount: pick([25, 50, 100]), actorPassword: ADMIN_PASSWORD }), capture: true, scenario: 'gift-activate', day: d });
      const gid = gc.json?.giftCard?.id ?? gc.json?.id;
      if (gid) { giftCards.push({ id: gid, code }); }
      if (gid && chance(0.5)) await req(adminJar, 'POST', '/api/gift-cards', { body: JSON.stringify({ action: 'reload', giftCardId: gid, amount: 20, actorPassword: ADMIN_PASSWORD }), scenario: 'gift-reload', day: d });
    }
    if (d % 6 === 4 && suppliers.length && variants.length) {
      // PO create → receive
      const lines = variants.slice(0, ri(1, Math.min(3, variants.length))).map((v) => ({ product_variant_id: v.id, quantity: ri(5, 20), unit_cost: r2(v.price * 0.4) }));
      const po = await req(adminJar, 'POST', '/api/purchase-orders', { body: JSON.stringify({ supplier_id: pick(suppliers).id, notes: 'sim PO', lines }), capture: true, scenario: 'po-create', day: d });
      const poObj = po.json?.purchaseOrder ?? po.json?.po ?? po.json;
      const poId = poObj?.id; const poLines = poObj?.lines ?? [];
      if (poId && poLines.length) {
        await req(adminJar, 'PATCH', '/api/purchase-orders', { body: JSON.stringify({ id: poId, receives: poLines.map((l) => ({ line_id: l.id, quantity_received: l.quantity ?? l.quantity_ordered ?? 1 })) }), scenario: 'po-receive', day: d });
      }
    }
    if (d % 7 === 5 && locations.length >= 2 && variants.length) {
      // transfer create → ship → receive (from big-stock blank loc to a named one)
      const src = locations.find((l) => !l.name || !l.name.trim()) ?? locations[0];
      const dst = locations.find((l) => l.id !== src.id) ?? locations[1];
      const tr = await req(adminJar, 'POST', '/api/transfers', { body: JSON.stringify({ action: 'create', sourceLocationId: src.id, destinationLocationId: dst.id, notes: 'sim transfer', lines: [{ productVariantId: pick(variants).id, quantity: ri(1, 5) }], actorPassword: ADMIN_PASSWORD }), capture: true, scenario: 'transfer-create', day: d });
      const trId = (tr.json?.transfer ?? tr.json)?.id;
      if (trId) {
        await req(adminJar, 'POST', '/api/transfers', { body: JSON.stringify({ action: 'ship', id: trId, actorPassword: ADMIN_PASSWORD }), scenario: 'transfer-ship', day: d });
        await req(adminJar, 'POST', '/api/transfers', { body: JSON.stringify({ action: 'receive', id: trId, actorPassword: ADMIN_PASSWORD }), scenario: 'transfer-receive', day: d });
      }
    }
    if (d % 8 === 6 && variants.length) {
      // blind receiving
      await req(adminJar, 'POST', '/api/receiving', { body: JSON.stringify({ type: 'receive', items: [{ product_variant_id: pick(variants).id, quantity: ri(1, 10) }] }), scenario: 'receiving', day: d });
    }
    if (d % 4 === 2) {
      // expense
      await req(adminJar, 'POST', '/api/expenses', { body: JSON.stringify({ category: pick(['utilities', 'supplies', 'rent', 'payroll']), description: `sim expense d${d}`, amount: ri(20, 500) }), scenario: 'expense', day: d });
    }

    process.stdout.write('· ');
    if ((d + 1) % 13 === 0) process.stdout.write('\n         ');
    await sleep(DELAY_MS);
  }
  console.log('\n');

  // ─── Report ──────────────────────────────────────────────────────────
  console.log('=== Activity totals ===');
  console.log(`  sales ok=${salesOk} fail=${salesFail} · returns ok=${returnsOk} · shifts opened=${shiftsOpened} · customers=${customers.length} · giftcards=${giftCards.length}\n`);

  console.log('=== Per-endpoint summary (sorted by failures) ===');
  const rows = Array.from(stats.entries()).map(([key, s]) => ({ key, ...s, avg: Math.round(s.totalMs / s.count), codes: Array.from(s.codes.entries()).sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c}:${n}`).join(' ') }));
  rows.sort((a, b) => b.fail - a.fail || b.count - a.count);
  for (const r of rows) {
    console.log(`  ${r.fail > 0 ? '✗' : '✓'} ${r.key.padEnd(42)} n=${String(r.count).padEnd(4)} ok=${String(r.ok).padEnd(4)} fail=${String(r.fail).padEnd(4)} avg=${String(r.avg).padEnd(5)}ms  [${r.codes}]`);
  }

  console.log(`\n=== ${errors.length} non-2xx responses (grouped) ===`);
  const groups = new Map();
  for (const e of errors) {
    const key = `${e.method} ${e.path} → ${e.status}`;
    let gg = groups.get(key);
    if (!gg) { gg = { count: 0, sample: e }; groups.set(key, gg); }
    gg.count++;
  }
  for (const [key, gg] of Array.from(groups.entries()).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`\n  [×${gg.count}] ${key}`);
    if (gg.sample.body) console.log(`    body: ${gg.sample.body.slice(0, 220)}`);
    if (gg.sample.err) console.log(`    err:  ${gg.sample.err}`);
  }

  const has5xx = errors.some((e) => e.status >= 500 || e.status === 0);
  console.log(`\n${has5xx ? '⚠️  5xx/network errors present — see above' : '✓ no 5xx/network errors'}`);
  process.exit(has5xx ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
