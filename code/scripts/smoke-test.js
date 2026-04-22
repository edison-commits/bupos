#!/usr/bin/env node
/**
 * Smoke test for bupos — verifies admin login + register PIN login
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
const EMPLOYEE_PIN = process.env.SMOKE_EMPLOYEE_PIN;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !EMPLOYEE_PIN) {
  console.error('Missing required env vars: SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD, SMOKE_EMPLOYEE_PIN');
  process.exit(2);
}

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

async function testRegisterPIN(page, context) {
  log('📋', 'Testing register PIN login...');

  // Go to register
  await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);

  if (page.url().includes('error') || (await page.textContent('body')).includes('Register Error')) {
    log('❌', 'Register page crashed on load');
    failures++;
    return;
  }

  log('✅', 'Register page loads OK');

  // Find PIN input and submit
  const pinInput = await page.$('input[type="password"], input[name="pin"]');
  if (!pinInput) {
    log('❌', 'No PIN input found');
    failures++;
    return;
  }

  await pinInput.fill(EMPLOYEE_PIN);
  const submitBtn = await page.$('button[type="submit"]');
  if (!submitBtn) {
    log('❌', 'No submit button found');
    failures++;
    return;
  }

  await submitBtn.click();
  await page.waitForTimeout(5000);

  const body = await page.textContent('body');
  if (body.includes('Register Error')) {
    log('❌', `Register PIN login failed — error on page. URL: ${page.url()}`);
    failures++;
    return;
  }

  log('✅', 'Register PIN login OK');
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
    await testRegisterPIN(regPage, regContext);
    await regContext.close();

  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? '🎉 All tests passed!' : `💥 ${failures} test(s) failed`}\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
