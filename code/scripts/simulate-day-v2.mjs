#!/usr/bin/env node
/**
 * Simulate a full retail day against the live site — v2.
 *
 * Usage:
 *   MAYA_COOKIE=$(cat /tmp/sim-cookies-maya.txt | grep ...)
 *   MAYA_RSID=60e2c0ed-e7bc-4f44-9e60-8898bf3999ac
 *   node scripts/simulate-day-v2.mjs [count]
 */

import crypto from "node:crypto";
import fs from "node:fs";

const COUNT = Number(process.argv[2] ?? 60);
const BASE = "https://basicuniformpos.com";
const ORIGIN = BASE;
const LOCATION_ID = "c57268b3-cb14-4c1a-bda6-55e49ddc6313";
const TAX_RATE = 0.1025;

const VARIANTS = [
  { id: "3fcfb7b8-856c-4ed7-8cd2-cbb1666f2e18", sku: "DEN-HR-28-BLU", price: 54, name: "High Rise Straight Jean", variant: "28 / Blue" },
  { id: "13b7dd62-e5d6-4a1b-bf90-0fbaefb56032", sku: "DEN-HR-30-BLU", price: 54, name: "High Rise Straight Jean", variant: "30 / Blue" },
  { id: "20e5e39c-fa01-41ed-9a48-fe9886b0dc75", sku: "TOP-OS-L-WHT",  price: 22, name: "Oversized Essential Tee", variant: "Large / White" },
  { id: "021e7e4d-88c3-42bd-8b47-d8e8d97f84b7", sku: "TOP-OS-M-BLK",  price: 22, name: "Oversized Essential Tee", variant: "Medium / Black" },
];

// ─── Inputs ─────────────────────────────────────────────────────────────────

function readCookie(path) {
  const raw = fs.readFileSync(path, "utf8");
  // R41-2: dual-read during rollover. Prefer new short name; fall back
  // to legacy until the migration window closes.
  const line =
    raw.split("\n").find((l) => l.includes("\tbupos_r\t")) ??
    raw.split("\n").find((l) => l.includes("basicuniformpos_register_session"));
  if (!line) throw new Error(`No register-session cookie in ${path}`);
  const fields = line.split(/\s+/);
  return fields[fields.length - 1];
}

const MAYA = {
  name: "Maya M.",
  cookieValue: readCookie("/tmp/sim-cookies-maya.txt"),
  registerSessionId: process.env.MAYA_RSID || "60e2c0ed-e7bc-4f44-9e60-8898bf3999ac",
};

// ─── Util ───────────────────────────────────────────────────────────────────

const rand = (min, max) => Math.random() * (max - min) + min;
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Cart builder ───────────────────────────────────────────────────────────

function buildCart(session) {
  const lineCount = Math.floor(rand(1, 5));
  const chosen = new Set();
  const items = [];
  for (let i = 0; i < lineCount; i++) {
    const v = choice(VARIANTS);
    if (chosen.has(v.id)) continue;
    chosen.add(v.id);
    const quantity = Math.floor(rand(1, 3));
    const hasLineDiscount = Math.random() < 0.12;
    const lineDiscount = hasLineDiscount
      ? { mode: Math.random() < 0.5 ? "percent" : "fixed", value: Math.random() < 0.5 ? Math.floor(rand(5, 15)) : round2(rand(1, 4)) }
      : undefined;

    items.push({
      id: crypto.randomUUID(),
      productVariantId: v.id,
      sku: v.sku,
      productName: v.name,
      variantName: v.variant,
      unitPrice: v.price,
      quantity,
      modifierIds: [],
      modifierTotal: 0,
      ...(lineDiscount ? { lineDiscount } : {}),
    });
  }

  let subtotal = 0, lineDiscountTotal = 0;
  for (const it of items) {
    const base = it.unitPrice * it.quantity;
    subtotal = round2(subtotal + base);
    if (it.lineDiscount) {
      const disc = it.lineDiscount.mode === "percent"
        ? round2(base * Math.min(100, it.lineDiscount.value) / 100)
        : Math.min(it.lineDiscount.value, base);
      lineDiscountTotal = round2(lineDiscountTotal + disc);
    }
  }

  const discountTotal = lineDiscountTotal;
  const taxable = Math.max(0, subtotal - discountTotal);
  const taxTotal = round2(taxable * TAX_RATE);
  const grandTotal = round2(taxable + taxTotal);

  const cart = {
    id: crypto.randomUUID(),
    items,
    status: "checked_out",
    taxRate: TAX_RATE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    locationId: LOCATION_ID,
    discountMode: "fixed",
    discountAmount: 0,
    registerSessionId: session.registerSessionId,
  };

  const r = Math.random();
  let tenders;
  if (r < 0.7) {
    const paid = round2(grandTotal + (Math.random() < 0.3 ? rand(0, 20) : 0));
    tenders = [{ type: "cash", amount: paid }];
  } else if (r < 0.9) {
    tenders = [{ type: "card", amount: grandTotal }];
  } else {
    const cashPart = round2(grandTotal * rand(0.3, 0.7));
    tenders = [
      { type: "cash", amount: cashPart },
      { type: "card", amount: round2(grandTotal - cashPart) },
    ];
  }

  return { cart, tenders, totals: { subtotal, discountTotal, taxTotal, grandTotal } };
}

// ─── One transaction (with retry) ──────────────────────────────────────────

async function submitTxn(session, index) {
  const { cart, tenders, totals } = buildCart(session);
  const payload = {
    id: cart.id,
    cart,
    tenders,
    timestamp: new Date().toISOString(),
    registerSessionId: session.registerSessionId,
    approvedExceptions: [],
  };
  const headers = {
    "Content-Type": "application/json",
    Origin: ORIGIN,
    Cookie: `bupos_r=${session.cookieValue}`,
  };

  for (let attempt = 0; attempt < 6; attempt++) {
    const start = Date.now();
    let res;
    try {
      res = await fetch(`${BASE}/api/offline-sync`, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (e) {
      if (attempt < 5) { await sleep(2000 * (attempt + 1)); continue; }
      return { ok: false, index, error: `network: ${e.message}`, duration: Date.now() - start };
    }
    const duration = Date.now() - start;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }

    if (res.ok) {
      return {
        ok: true,
        index,
        cartId: cart.id,
        txnId: json?.transactionId ?? null,
        items: cart.items.length,
        totals,
        tenders,
        duration,
      };
    }

    // 5xx: back off exponentially and retry up to 5 times; 4xx: don't retry
    if (res.status >= 500 && attempt < 5) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    return { ok: false, index, status: res.status, error: json?.error ?? text.slice(0, 200), duration };
  }
  return { ok: false, index, error: "exhausted retries" };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`→ Simulating ${COUNT} transactions as ${MAYA.name} at ${BASE}`);
  console.log(`  cookie:    ${MAYA.cookieValue.slice(0, 8)}...`);
  console.log(`  register:  ${MAYA.registerSessionId}\n`);

  const results = [];
  const startAll = Date.now();

  for (let i = 0; i < COUNT; i++) {
    const r = await submitTxn(MAYA, i + 1);
    results.push(r);
    if (r.ok) {
      const money = r.totals.grandTotal.toFixed(2);
      const tender = r.tenders.map(t => `${t.type}:$${t.amount.toFixed(2)}`).join("+");
      console.log(
        `  ✓ #${String(i + 1).padStart(2)}  ${String(r.items)} items  $${money.padStart(7)}  ${tender.padEnd(28)}  ${String(r.duration).padStart(4)}ms  txn=${r.txnId?.slice(0,8) ?? "?"}`
      );
    } else {
      console.log(`  ✗ #${String(i + 1).padStart(2)}  ${r.status ?? ""} ${r.error}  (${r.duration ?? "?"}ms)`);
    }
    // Throttle: the offline-sync path opens ~6 Neon pools per call; rapid-
    // fire back-to-back requests intermittently trip Cloudflare's 503 edge
    // protection. 1.5-2.5s spacing keeps each Worker invocation isolated.
    await sleep(1500 + Math.floor(rand(0, 1000)));
  }

  const elapsed = Date.now() - startAll;
  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);

  console.log("\n──────────────── Summary ────────────────");
  console.log(`Attempted:  ${results.length}`);
  console.log(`Succeeded:  ${ok.length}`);
  console.log(`Failed:     ${fail.length}`);
  console.log(`Elapsed:    ${(elapsed / 1000).toFixed(1)}s  (${(elapsed / results.length).toFixed(0)}ms/txn avg incl. sleep)`);

  if (ok.length > 0) {
    const sum = ok.reduce((s, r) => s + r.totals.grandTotal, 0);
    const subtotalSum = ok.reduce((s, r) => s + r.totals.subtotal, 0);
    const taxSum = ok.reduce((s, r) => s + r.totals.taxTotal, 0);
    const cashTotal = ok.reduce((s, r) => s + (r.tenders.filter(t => t.type === "cash").reduce((a, t) => a + t.amount, 0)), 0);
    const cardTotal = ok.reduce((s, r) => s + (r.tenders.filter(t => t.type === "card").reduce((a, t) => a + t.amount, 0)), 0);
    console.log(`\nRevenue (grand_total):  $${sum.toFixed(2)}`);
    console.log(`  Subtotal:             $${subtotalSum.toFixed(2)}`);
    console.log(`  Tax:                  $${taxSum.toFixed(2)}`);
    console.log(`Tender received:`);
    console.log(`  Cash (incl. change):  $${cashTotal.toFixed(2)}`);
    console.log(`  Card:                 $${cardTotal.toFixed(2)}`);

    const latencies = ok.map(r => r.duration);
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    console.log(`\nLatency: p50=${p50}ms, p95=${p95}ms, max=${Math.max(...latencies)}ms`);
  }

  if (fail.length > 0) {
    console.log("\nFailures:");
    for (const r of fail.slice(0, 10)) console.log(`  #${r.index}: ${r.status ?? ""} ${r.error}`);
  }

  // Emit JSON on the last line for reconciliation
  console.log("\n__SIM_JSON__" + JSON.stringify({
    attempted: results.length,
    succeeded: ok.length,
    failed: fail.length,
    revenue: ok.reduce((s, r) => s + r.totals.grandTotal, 0),
    subtotal: ok.reduce((s, r) => s + r.totals.subtotal, 0),
    tax: ok.reduce((s, r) => s + r.totals.taxTotal, 0),
    cash: ok.reduce((s, r) => s + r.tenders.filter(t => t.type === "cash").reduce((a, t) => a + t.amount, 0), 0),
    card: ok.reduce((s, r) => s + r.tenders.filter(t => t.type === "card").reduce((a, t) => a + t.amount, 0), 0),
    cartIds: ok.map(r => r.cartId),
    txnIds: ok.map(r => r.txnId).filter(Boolean),
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
