#!/usr/bin/env node
/**
 * Month-of-activity HTTP simulation for basicuniformpos.com (or any
 * BuPOS instance reachable over HTTP).
 *
 * Goal: surface user-visible bugs by hammering the production HTTP
 * API with a realistic mix of:
 *   - Owner login / logout cycles
 *   - PIN-based register login (cashier flow)
 *   - Shift open / close
 *   - Read-side dashboard / reports / customers / transactions /
 *     audit / inventory / promo-codes / shifts
 *   - Health probes interspersed
 *
 * Every request records {endpoint, method, status, day, scenario,
 * elapsedMs, body-snippet-on-error}. At the end we print a per-
 * endpoint summary so failure clusters are obvious.
 *
 * Usage:
 *   BUPOS_URL=https://basicuniformpos.com \
 *   ADMIN_EMAIL=admin@bupos.com \
 *   ADMIN_PASSWORD=Bupos2026! \
 *   DAYS=30 \
 *   node scripts/simulate-month-http.mjs
 *
 * Defaults:
 *   BUPOS_URL    = https://basicuniformpos.com
 *   DAYS         = 30
 *   PIN          = 1111  (owner) — fallback to demo PINs
 *
 * SAFETY: this script runs against whatever URL you point it at.
 * It WILL create real shifts on the target. Don't run against a
 * customer-facing tenant. The target here is the dev/test
 * basicuniformpos.com instance.
 */

const BUPOS_URL = process.env.BUPOS_URL ?? 'https://basicuniformpos.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@bupos.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Bupos2026!';
const DAYS = Number(process.env.DAYS ?? 30);
const PIN = process.env.PIN ?? '1111';
const DELAY_MS = Number(process.env.DELAY_MS ?? 50);

// TST-AUDIT4-1: prod-host guard. The simulation creates real shifts,
// transactions, and audit rows on the target tenant — pointing at a
// customer-facing host would corrupt their data. Refuse to run unless
// the URL is `localhost`, the dev `basicuniformpos.com` (our test
// host), or an explicit SIMULATE_FORCE=1 override is set. The DB-
// level _safe-db.mjs guards mutating SQL scripts; this is the HTTP
// equivalent for the simulation script that hits a live deployment.
{
  const url = (() => {
    try { return new URL(BUPOS_URL); }
    catch { throw new Error(`[simulate-month-http] BUPOS_URL is not a valid URL: ${BUPOS_URL}`); }
  })();
  const host = url.hostname.toLowerCase();
  const ALLOWED_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    'basicuniformpos.com',
    'www.basicuniformpos.com',
  ]);
  if (!ALLOWED_HOSTS.has(host)) {
    if (process.env.SIMULATE_FORCE !== '1') {
      throw new Error(
        `[simulate-month-http] refusing to simulate against host '${host}' ` +
        `(not in known-test allowlist). Set SIMULATE_FORCE=1 to override; ` +
        `this script creates real shifts/transactions on the target tenant.`,
      );
    }
    console.warn(`[simulate-month-http] SIMULATE_FORCE=1 — simulating against unknown host '${host}'.`);
  }
}

// ─── Small fetch helper that tracks cookies (per-session jar) ────────

function makeJar() {
  const jar = new Map();
  return {
    setFromHeaders(headers) {
      // Workers/Next can send multiple Set-Cookie headers; fetch's
      // standard Headers iterator concatenates them. We split on
      // ", " which is a *fragile* heuristic (cookie values can
      // contain commas) but works for HttpOnly session cookies
      // which are URL-safe Base64. Improve only if we see drift.
      const raw = headers.getSetCookie?.() ?? [];
      for (const line of raw) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    cookieHeader() {
      return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(name) { return jar.get(name); },
    clear() { jar.clear(); },
  };
}

const errors = [];
const stats = new Map(); // key: "METHOD path" → { count, ok, fail, codes: Map<status, n> }

function record(method, path, res, elapsedMs, scenario, day) {
  const key = `${method} ${path}`;
  let s = stats.get(key);
  if (!s) {
    s = { count: 0, ok: 0, fail: 0, codes: new Map(), totalMs: 0 };
    stats.set(key, s);
  }
  s.count += 1;
  s.totalMs += elapsedMs;
  s.codes.set(res.status, (s.codes.get(res.status) ?? 0) + 1);
  if (res.status >= 200 && res.status < 400) s.ok += 1;
  else s.fail += 1;
}

async function req(jar, method, path, opts = {}, scenario = '?', day = 0) {
  const url = `${BUPOS_URL}${path}`;
  const headers = new Headers(opts.headers ?? {});
  if (jar.cookieHeader()) headers.set('cookie', jar.cookieHeader());
  if (opts.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  // Origin/Referer for the CSRF gate. The /api/* routes reject
  // POST/PUT/PATCH/DELETE when the Origin header is missing or
  // doesn't match the allowlist — protects against cross-site
  // form-submission CSRF. We're a same-origin caller; spoof the
  // Origin to the target so the gate accepts us.
  if (!headers.has('origin')) headers.set('origin', BUPOS_URL);
  if (!headers.has('referer')) headers.set('referer', `${BUPOS_URL}/admin`);

  const start = Date.now();
  let res, body, errMsg;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body,
      redirect: 'manual',
      // 15s per request — well above worker p99 latency.
      signal: AbortSignal.timeout(15_000),
    });
    jar.setFromHeaders(res.headers);
    if (!res.ok && res.status !== 302 && res.status !== 303 && res.status !== 307 && res.status !== 308) {
      // Slurp a snippet for diagnostics. Limit to 400 chars so prod
      // server pages don't blow up the log.
      try {
        body = (await res.text()).slice(0, 400);
      } catch {
        body = '';
      }
    }
  } catch (e) {
    errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    res = { status: 0, headers: new Headers() };
  }
  const elapsedMs = Date.now() - start;
  record(method, path, res, elapsedMs, scenario, day);
  if (res.status >= 400 || res.status === 0) {
    errors.push({
      day, scenario, method, path,
      status: res.status, elapsedMs,
      body: body ?? null,
      err: errMsg ?? null,
    });
  }
  return { res, body };
}

// ─── Scenarios ────────────────────────────────────────────────────────

async function ownerLogin(jar, day) {
  jar.clear();
  return req(jar, 'POST', '/api/auth/login', {
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }, 'owner-login', day);
}

async function ownerLogout(jar, day) {
  // Logout goes through a server action via /admin form; not a
  // direct API. We just clear the jar for the simulation.
  jar.clear();
  await new Promise((r) => setTimeout(r, 10));
}

async function pinLogin(jar, day, locationId) {
  // Only attempt PIN login if locationId is known.
  if (!locationId) return null;
  jar.clear();
  return req(jar, 'POST', '/api/auth/register-login', {
    body: JSON.stringify({ pin: PIN, locationId, deviceId: 'sim-month-device' }),
  }, 'pin-login', day);
}

async function readDashboard(jar, day) {
  await req(jar, 'GET', '/api/dashboard?range=today', {}, 'dashboard', day);
  await req(jar, 'GET', '/api/dashboard?range=week', {}, 'dashboard', day);
}

async function readReports(jar, day) {
  const dayStr = new Date(Date.now() - day * 86400000).toISOString().slice(0, 10);
  await req(jar, 'GET', `/api/reports?type=summary&from=${dayStr}&to=${dayStr}`, {}, 'reports', day);
  await req(jar, 'GET', `/api/reports?type=tender&from=${dayStr}&to=${dayStr}`, {}, 'reports', day);
}

async function readCommonAdmin(jar, day) {
  await req(jar, 'GET', '/api/customers?page=1&pageSize=20', {}, 'customers', day);
  await req(jar, 'GET', '/api/employees', {}, 'employees', day);
  await req(jar, 'GET', '/api/inventory?page=1&pageSize=20', {}, 'inventory', day);
  await req(jar, 'GET', '/api/promo-codes', {}, 'promos', day);
  await req(jar, 'GET', '/api/transactions?page=1&pageSize=10', {}, 'transactions', day);
  await req(jar, 'GET', '/api/audit?page=1&pageSize=10', {}, 'audit', day);
}

async function getDefaultLocation(jar, day) {
  // Use the same `req()` helper so cookies + Origin are applied.
  const r = await fetch(`${BUPOS_URL}/api/clock-in-data`, {
    headers: { cookie: jar.cookieHeader(), origin: BUPOS_URL, referer: `${BUPOS_URL}/admin` },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  try {
    const obj = await r.json();
    // Prefer a non-empty-name location (R3-fix: legacy blank-name
    // location sorts first; pick a real one with a name).
    const named = (obj.locations ?? []).find((l) => l.name && l.name.trim());
    return (named ?? obj.locations?.[0])?.id ?? null;
  } catch {
    return null;
  }
}

async function getSomeEmployeeId(jar, day) {
  const r = await fetch(`${BUPOS_URL}/api/employees`, {
    headers: { cookie: jar.cookieHeader(), origin: BUPOS_URL, referer: `${BUPOS_URL}/admin` },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  try {
    const obj = await r.json();
    // Pick a cashier or manager — admin/owner can also work.
    const list = obj.employees ?? [];
    return (list.find((e) => e.roleKey === 'cashier' || e.role_key === 'cashier') ?? list[0])?.id ?? null;
  } catch {
    return null;
  }
}

async function openAdminShift(jar, day, employeeId, locationId) {
  if (!employeeId || !locationId) return null;
  return req(jar, 'POST', '/api/shifts', {
    headers: { 'Idempotency-Key': `sim-${day}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    body: JSON.stringify({ employeeId, locationId, openingFloat: 200 }),
  }, 'open-shift', day);
}

// Close every open shift at the given location, by querying the
// shifts list and POSTing /api/shift-close with the actorPassword.
// Used at the start of the simulation so subsequent open-shift
// attempts don't all hit the "already has an open shift" 409.
async function closeAllOpenShifts(jar, day) {
  const r = await fetch(`${BUPOS_URL}/api/shifts?status=open&page=1&pageSize=20`, {
    headers: { cookie: jar.cookieHeader(), origin: BUPOS_URL, referer: `${BUPOS_URL}/admin` },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!r || !r.ok) return;
  let body;
  try { body = await r.json(); } catch { return; }
  const open = body.shifts ?? [];
  for (const s of open) {
    await req(jar, 'POST', '/api/shift-close', {
      body: JSON.stringify({
        shiftId: s.id,
        declaredCash: s.openingFloat ?? 200,
        actorPassword: ADMIN_PASSWORD,
      }),
    }, 'close-shift', day);
    await sleep(50);
  }
}

// ─── Main loop ────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log(`→ BuPOS month-simulator: ${BUPOS_URL} for ${DAYS} simulated days\n`);

  const jar = makeJar();

  // Realistic: owner logs in ONCE per work-period and reuses the
  // session for the day's reads. Hitting /api/auth/login on every
  // simulated day burns the per-IP rate-limit (designed for
  // brute-force resistance, not script automation). We re-login
  // every RELOGIN_EVERY days to simulate a session expiry / explicit
  // sign-out cycle.
  const RELOGIN_EVERY = 7;

  // Initial login + discovery
  await ownerLogin(jar, -1);
  const employeeId = await getSomeEmployeeId(jar, -1);
  const locationId = await getDefaultLocation(jar, -1);
  console.log(`  discovery: employeeId=${employeeId?.slice(0, 8) ?? '(none)'}, locationId=${locationId?.slice(0, 8) ?? '(none)'}`);
  console.log(`  jar after login: ${jar.cookieHeader().slice(0, 80)}${jar.cookieHeader().length > 80 ? '…' : ''}\n`);

  // Close out any leftover open shifts so the per-day open-shift
  // calls aren't all 409 against the previous day's open shift.
  console.log(`  closing leftover open shifts…`);
  await closeAllOpenShifts(jar, -1);

  for (let d = 0; d < DAYS; d++) {
    process.stdout.write(`  day ${d + 1}/${DAYS} `);

    // Periodic re-login simulating session expiry / morning sign-in
    if (d > 0 && d % RELOGIN_EVERY === 0) {
      await ownerLogin(jar, d);
    }

    // Owner morning dashboard + reports scan
    await readDashboard(jar, d);
    await readReports(jar, d);
    await readCommonAdmin(jar, d);
    await sleep(DELAY_MS);

    // Open 1-2 admin shifts per day
    const shifts = 1 + (d % 2);
    for (let s = 0; s < shifts; s++) {
      await openAdminShift(jar, d, employeeId, locationId);
      await sleep(DELAY_MS);
    }

    // Mid-day: dashboard re-check (no fresh login — same session)
    await readDashboard(jar, d);
    await sleep(DELAY_MS);

    process.stdout.write('· ');
    if ((d + 1) % 10 === 0) process.stdout.write('\n  ');
  }
  console.log('\n');

  // ─── Report ────────────────────────────────────────────────────
  console.log('=== Per-endpoint summary ===');
  const rows = Array.from(stats.entries()).map(([key, s]) => ({
    endpoint: key,
    count: s.count,
    ok: s.ok,
    fail: s.fail,
    p_avg: Math.round(s.totalMs / s.count),
    codes: Array.from(s.codes.entries()).sort().map(([c, n]) => `${c}:${n}`).join(' '),
  }));
  rows.sort((a, b) => b.fail - a.fail || b.count - a.count);
  for (const r of rows) {
    console.log(`  ${r.fail > 0 ? '✗' : '✓'} ${r.endpoint.padEnd(46)} count=${String(r.count).padEnd(4)} ok=${String(r.ok).padEnd(4)} fail=${String(r.fail).padEnd(4)} avg=${String(r.p_avg).padEnd(5)}ms  [${r.codes}]`);
  }

  console.log(`\n=== ${errors.length} non-2xx responses ===`);
  // Group errors by (path, status) for triage
  const groups = new Map();
  for (const e of errors) {
    const key = `${e.method} ${e.path} → ${e.status}`;
    let g = groups.get(key);
    if (!g) { g = { count: 0, sample: e }; groups.set(key, g); }
    g.count += 1;
  }
  const sorted = Array.from(groups.entries()).sort((a, b) => b[1].count - a[1].count);
  for (const [key, g] of sorted) {
    console.log(`\n  [×${g.count}] ${key}`);
    if (g.sample.body) {
      console.log(`    body: ${g.sample.body.slice(0, 200)}`);
    }
    if (g.sample.err) {
      console.log(`    err:  ${g.sample.err}`);
    }
  }

  // Exit non-zero if we saw any 5xx — useful for CI
  const hasServerError = errors.some((e) => e.status >= 500 || e.status === 0);
  process.exit(hasServerError ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
