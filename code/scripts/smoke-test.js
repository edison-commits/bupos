#!/usr/bin/env node
/**
 * Smoke test for bupos — verifies admin login + register tap-your-name clock-in
 * Run: node scripts/smoke-test.js
 * 
 * Exits 0 on success, 1 on failure.
 */
const { chromium } = require('playwright');

// Read all secrets from env. Hardcoding live admin credentials in the repo
// is a password-rotation trigger — anyone with clone access can take over.
const BASE = process.env.BASE_URL || 'https://basicuniformpos.com';
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD;
// SMOKE_EMPLOYEE_PIN is no longer required: the register clock-in is now
// "tap your name" (cashiers need no PIN), so the end-to-end check uses the
// no-PIN cashier path. The var is kept optional for backward compatibility.
const EMPLOYEE_PIN = process.env.SMOKE_EMPLOYEE_PIN; // optional, unused

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Missing required env vars: SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD');
  process.exit(2);
}
void EMPLOYEE_PIN;

let failures = 0;

function log(emoji, msg) {
  console.log(`${emoji} ${msg}`);
}

async function testAdminLogin(page) {
  log('📋', 'Testing admin login...');
  
  // Go to home/login page
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1000);

  // Fill login form
  await page.fill('input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);

  const url = page.url();
  if (!url.includes('/admin')) {
    log('❌', `Admin login failed — redirected to: ${url}`);
    failures++;
    return;
  }

  // Check admin page loaded
  const body = await page.textContent('body');
  // Check for error boundary (full-page error, not a widget)
  const hasFullError = body.includes('Admin Error') && body.includes('Try again') && !body.includes('Overview');
  if (hasFullError) {
    log('❌', 'Admin page shows full error boundary');
    failures++;
    return;
  }

  log('✅', 'Admin login + page load OK');
}

async function testRegisterClockIn(page) {
  // The register now uses a "tap your name" clock-in (store picker →
  // roster), NOT a universal PIN pad. Cashiers clock in with no PIN;
  // owner/manager names are gated behind a per-employee PIN keypad. This
  // test verifies (1) the UI renders, (2) the manager/owner PIN gate
  // renders, and (3) a real no-PIN cashier clock-in completes end-to-end.
  // It degrades gracefully on data shape (e.g. a store with no cashier).
  log('📋', 'Testing register clock-in (tap-your-name)...');

  await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);

  const body0 = await page.textContent('body');
  if (page.url().includes('error') || body0.includes('Register Error')) {
    log('❌', 'Register page crashed on load');
    failures++;
    return;
  }
  log('✅', 'Register page loads OK');

  const onPicker = (b) => b.includes('Choose your store');
  const onRoster = (b) => b.includes("Who's working");
  if (!onPicker(body0) && !onRoster(body0)) {
    log('❌', 'Clock-in UI not found (no store picker or roster)');
    failures++;
    return;
  }
  log('✅', 'Clock-in UI renders');

  // Land on a roster — pick the first store if the picker is showing.
  async function ensureRoster() {
    if (onPicker(await page.textContent('body'))) {
      const card = await page.$('[data-testid="store-card"]');
      if (!card) return false;
      await card.click();
      await page.waitForTimeout(800);
    }
    return true;
  }
  await ensureRoster();

  // (2) Manager/owner PIN gate renders — click an elevated name and confirm
  // a keypad appears (the gate UI deployed), then back out. Non-failing.
  const mgr = await page.$('[data-testid="clock-in-name"][data-role="manager"], [data-testid="clock-in-name"][data-role="owner"]');
  if (mgr) {
    await mgr.click();
    await page.waitForTimeout(800);
    if (await page.$('[data-testid="pin-keypad"]')) {
      log('✅', 'Manager/owner PIN keypad gate renders');
      const back = await page.$('[data-testid="pin-back"]');
      if (back) { await back.click(); await page.waitForTimeout(500); }
    } else {
      log('⚠️', 'Elevated name did not open a PIN keypad');
    }
  }

  // (3) End-to-end no-PIN clock-in: find a cashier (searching stores if the
  // current roster has none) and clock in.
  async function clickCashierHere() {
    const c = await page.$('[data-testid="clock-in-name"][data-role="cashier"]');
    if (!c) return false;
    await c.click();
    await page.waitForTimeout(6000);
    return true;
  }

  let clocked = await clickCashierHere();
  if (!clocked && onRoster(await page.textContent('body'))) {
    const change = await page.$('[data-testid="change-store"]');
    if (change) { await change.click(); await page.waitForTimeout(600); }
    const total = (await page.$$('[data-testid="store-card"]')).length;
    for (let i = 0; i < total && !clocked; i++) {
      const cards = await page.$$('[data-testid="store-card"]');
      if (i >= cards.length) break;
      await cards[i].click();
      await page.waitForTimeout(800);
      clocked = await clickCashierHere();
      if (!clocked) {
        const back2 = await page.$('[data-testid="change-store"]');
        if (back2) { await back2.click(); await page.waitForTimeout(600); }
      }
    }
  }

  if (clocked) {
    const url = page.url();
    const body = await page.textContent('body');
    if (body.includes('Register Error')) {
      log('❌', `Clock-in failed — error on page. URL: ${url}`);
      failures++;
      return;
    }
    if (url.includes('notice=Clocked') || (!onPicker(body) && !onRoster(body))) {
      log('✅', 'Cashier clock-in OK');
    } else {
      log('❌', `Clock-in did not complete (still on roster/picker). URL: ${url}`);
      failures++;
    }
  } else {
    log('⚠️', 'No cashier on any roster — skipped end-to-end clock-in (UI verified healthy)');
  }
}

async function testHealthEndpoint() {
  log('📋', 'Testing health endpoint...');
  const resp = await fetch(`${BASE}/api/health`);
  const data = await resp.json();
  // R23-H-3: the PUBLIC /api/health response intentionally stopped
  // leaking subsystem detail (the old `database: 'connected'` field).
  // A `status: 'ok'` response IS the signal that the DB query under
  // the hood succeeded — a failed DB check returns `unhealthy` or
  // `degraded` with a non-200 status. Detailed diagnostics moved to
  // /api/admin/health behind admin auth (R23-L-3).
  if (!resp.ok || data.status !== 'ok') {
    log('❌', `Health check failed: ${JSON.stringify(data)}`);
    failures++;
    return;
  }
  log('✅', 'Health endpoint OK');
}

(async () => {
  console.log(`\n🧪 bupos smoke test — ${BASE}\n`);
  
  const browser = await chromium.launch({ headless: true });
  
  try {
    // Health check
    await testHealthEndpoint();

    // Admin flow
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    adminPage.on('pageerror', err => {
      log('⚠️', `Client error: ${err.message.split('\n')[0]}`);
    });
    await testAdminLogin(adminPage);
    await adminContext.close();

    // Register flow
    const regContext = await browser.newContext();
    const regPage = await regContext.newPage();
    regPage.on('pageerror', err => {
      log('⚠️', `Client error: ${err.message.split('\n')[0]}`);
    });
    await testRegisterClockIn(regPage);
    await regContext.close();

  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? '🎉 All tests passed!' : `💥 ${failures} test(s) failed`}\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
