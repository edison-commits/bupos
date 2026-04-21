#!/usr/bin/env node
/**
 * Role × endpoint permission matrix.
 *
 * Statically extracts every `withAdminAuth(PERM, ...)` / `withDualAuth(PERM, ...)`
 * declaration in src/app/api, crosses it with the 5 role definitions, and
 * asserts the expected access (from permissions.ts) matches the expected
 * business rule.
 *
 * Layered on top:
 *   - Dynamic role checks inside handlers (e.g. R6-C-3's gift-card owner/
 *     manager-only gate on activate/reload/disable) are verified by reading
 *     the handler source and checking the guard is present.
 *
 * This is a STATIC test — it doesn't fire HTTP requests. Its value is
 * catching cases where a new endpoint ships with the wrong permission gate
 * (e.g. `catalog.manage` instead of `employee.manage` — the R6-H-4/R8-L-10
 * shape). Fast + reproducible.
 *
 * Run: node scripts/test-role-permission-matrix.mjs
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/edison/Desktop/bupos/code";

// ─── Load permissions from source ───────────────────────────────────────

const permsSrc = fs.readFileSync(path.join(ROOT, "src/lib/domain/permissions.ts"), "utf8");

// Extract role → permissions map via regex. The file's shape is stable.
function parseRoles() {
  const roles = {};
  // managerApprovals spread
  const mgrApp = ["approval.discount", "approval.void_item", "approval.void_transaction",
                  "approval.store_credit", "approval.price_override", "approval.cash_payout"];
  const rxRole = /{\s*key:\s*"(\w+)"[\s\S]*?permissions:\s*\[([\s\S]*?)\],/g;
  let m;
  while ((m = rxRole.exec(permsSrc)) !== null) {
    const [, key, permsBlock] = m;
    const perms = [];
    const permRx = /"([a-z_.]+)"/g;
    let pm;
    while ((pm = permRx.exec(permsBlock)) !== null) {
      perms.push(pm[1]);
    }
    if (permsBlock.includes("managerApprovals")) {
      perms.push(...mgrApp);
    }
    roles[key] = perms;
  }
  return roles;
}

const roleDefs = parseRoles();
const ROLES = Object.keys(roleDefs);
console.log("Roles loaded:", ROLES.join(", "));
console.log();

function has(role, perm) {
  return roleDefs[role]?.includes(perm) ?? false;
}

// ─── Enumerate endpoints ────────────────────────────────────────────────

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

const routes = [];
for (const file of walk(path.join(ROOT, "src/app/api"))) {
  const src = fs.readFileSync(file, "utf8");
  // Match: export const <METHOD> = withXxxAuth("perm.key", async ...)
  const rx = /export const (GET|POST|PUT|PATCH|DELETE) = with(Admin|Dual)Auth\(\s*["']([a-z_.]+)["']/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    routes.push({
      file: path.relative(ROOT, file),
      method: m[1],
      wrapper: m[2] === "Admin" ? "withAdminAuth" : "withDualAuth",
      permission: m[3],
    });
  }
  // Also match: export const <METHOD> = withAuth("perm.key", async ...)
  const rx2 = /export const (GET|POST|PUT|PATCH|DELETE) = withAuth\(\s*["']([a-z_.]+)["']/g;
  while ((m = rx2.exec(src)) !== null) {
    routes.push({
      file: path.relative(ROOT, file),
      method: m[1],
      wrapper: "withAdminAuth (alias)",
      permission: m[2],
    });
  }
}

console.log(`Endpoints discovered: ${routes.length}`);

// ─── Rule table (what SHOULD each role see) ─────────────────────────────
//
// Encodes the business-intent constraints discovered in audits R6–R9:
//   - Money-minting endpoints (gift cards, store credit, loyalty adjust,
//     expenses) must require employee.manage OR an in-handler owner/manager
//     role check on top of a broader permission.
//   - Write paths to inventory should be gated on inventory.adjust OR
//     catalog.manage.
//   - Reports (audit.view) are intentionally broad but must not expose
//     PII across location scope (R7-H-2, R8-M-8, R8-M-9 handled this in
//     handlers, not in the permission gate).

// Classify each endpoint by risk category. These are the audit-documented
// intents; a mismatch means an audit intent regressed.
const EXPECTED = {
  // Money mutation — must reject inventory_clerk and cashier
  "api/gift-cards/route.ts:POST":      { disallow: ["inventory_clerk", "cashier", "support"], note: "R6-C-3 / R7-H-1 — mint gate" },
  "api/gift-cards/route.ts:GET":       { disallow: ["cashier"], note: "card balance read" },
  "api/loyalty/route.ts:POST":         { disallow: ["inventory_clerk", "cashier", "support"], note: "R6-M-5 rate-limit + gate" },
  "api/expenses/route.ts:POST":        { disallow: ["inventory_clerk", "cashier", "support"], note: "R6-H-4 permission tightened" },
  "api/expenses/route.ts:DELETE":      { disallow: ["inventory_clerk", "cashier", "support"] },
  "api/store-credit/route.ts:POST":    { disallow: ["inventory_clerk", "cashier", "support"], note: "money issuance" },
  "api/tax-config/route.ts:PUT":       { disallow: ["inventory_clerk", "cashier", "support"] },
  "api/settings/route.ts:PUT":         { disallow: ["inventory_clerk", "cashier", "support"] },

  // Inventory mutation — must allow inventory_clerk, reject cashier+support
  "api/purchase-orders/route.ts:POST":   { allow: ["owner", "manager", "inventory_clerk"], disallow: ["cashier", "support"] },
  "api/purchase-orders/route.ts:PUT":    { allow: ["owner", "manager", "inventory_clerk"], disallow: ["cashier", "support"] },
  "api/purchase-orders/route.ts:PATCH":  { allow: ["owner", "manager", "inventory_clerk"], disallow: ["cashier", "support"] },
  "api/transfers/route.ts:POST":         { disallow: ["cashier", "support"] },
  "api/receiving/route.ts:POST":         { allow: ["owner", "manager", "inventory_clerk"], disallow: ["cashier", "support"] },
  "api/products/route.ts:POST":          { allow: ["owner", "manager", "inventory_clerk"], disallow: ["cashier", "support"] },
  "api/products/route.ts:PUT":           { allow: ["owner", "manager", "inventory_clerk"], disallow: ["cashier", "support"] },
  "api/products/route.ts:DELETE":        { allow: ["owner", "manager", "inventory_clerk"], disallow: ["cashier", "support"] },
  "api/products/route.ts:PATCH":         { allow: ["owner", "manager", "inventory_clerk"], disallow: ["cashier", "support"] },

  // Employee management — owner/manager only
  "api/employees/route.ts:POST":   { disallow: ["inventory_clerk", "cashier", "support"] },
  "api/employees/route.ts:PUT":    { disallow: ["inventory_clerk", "cashier", "support"] },
  "api/employees/route.ts:PATCH":  { disallow: ["inventory_clerk", "cashier", "support"] },
  // Customers carry PII (email, phone, address, notes with fraud flags —
  // see R5-H-4). Intentionally on employee.manage so inventory_clerk,
  // who only needs SKU-level access, can't read/write customer records.
  "api/customers/route.ts:POST":   { disallow: ["inventory_clerk", "cashier", "support"] },
  "api/customers/route.ts:PUT":    { disallow: ["inventory_clerk", "cashier", "support"] },
};

// ─── Run the matrix ─────────────────────────────────────────────────────

const failures = [];
const passes = [];
function check(label, passed, detail) {
  (passed ? passes : failures).push({ label, detail });
}

for (const r of routes) {
  const key = `${r.file.replace("src/app/", "")}:${r.method}`;
  const expected = EXPECTED[key];
  if (!expected) continue; // only enforce for audit-tagged endpoints

  for (const role of ROLES) {
    const canAccess = has(role, r.permission);
    const shouldAllow = expected.allow ? expected.allow.includes(role) : !expected.disallow?.includes(role);

    if (canAccess !== shouldAllow) {
      // A handler-level role check may still reject — that's fine, but the
      // permission gate is the first line. We only flag if the permission
      // gate misaligns AND there's no in-handler role check string in the
      // file.
      const handlerSrc = fs.readFileSync(path.join(ROOT, "src/app", r.file.replace("src/app/", "")), "utf8");
      const hasHandlerGate = new RegExp(`roleKey === "${role}"|\\["owner", "manager"\\]|requireGiftCardAuthority|Only owners or managers|requires owner or manager`).test(handlerSrc);

      const label = `${r.wrapper}("${r.permission}") on ${key} — role=${role}`;
      if (canAccess && !shouldAllow && !hasHandlerGate) {
        // Gate says "allow" but audit-intent says "deny" and no in-handler gate → BUG
        check(label, false, `permission "${r.permission}" grants ${role} access; audit intent says deny; no in-handler gate found`);
      } else if (canAccess && !shouldAllow && hasHandlerGate) {
        // Permission layer too broad but in-handler gate compensates — OK with annotation
        check(label, true, `broad permission, but handler enforces role check`);
      } else if (!canAccess && shouldAllow) {
        check(label, false, `permission "${r.permission}" denies ${role}; audit intent says allow`);
      } else {
        check(label, true);
      }
    } else {
      check(`${r.wrapper}("${r.permission}") on ${key} — role=${role}`, true);
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────

console.log("─── Role-permission matrix ────────────────────────────────");
console.log(`Endpoints in scope:       ${Object.keys(EXPECTED).length}`);
console.log(`Matrix cells checked:     ${passes.length + failures.length}`);
console.log(`Passed:                   ${passes.length}`);
console.log(`Failed:                   ${failures.length}`);

if (failures.length > 0) {
  console.log();
  console.log("Failures:");
  for (const f of failures.slice(0, 30)) {
    console.log(`  \u2717 ${f.label}`);
    if (f.detail) console.log(`       ${f.detail}`);
  }
  if (failures.length > 30) console.log(`  ... +${failures.length - 30} more`);
}

// Bonus check: list untagged endpoints so we're aware of what's not under
// audit-intent enforcement yet.
const untagged = routes.filter((r) => !EXPECTED[`${r.file.replace("src/app/", "")}:${r.method}`]);
if (untagged.length > 0) {
  console.log();
  console.log(`Untagged endpoints (not yet under audit-intent enforcement): ${untagged.length}`);
  for (const r of untagged.slice(0, 15)) {
    console.log(`  ${r.method.padEnd(6)}  ${r.permission.padEnd(18)}  ${r.file.replace("src/app/", "")}`);
  }
  if (untagged.length > 15) console.log(`  ... +${untagged.length - 15} more`);
}

process.exit(failures.length === 0 ? 0 : 1);
