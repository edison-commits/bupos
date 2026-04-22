#!/usr/bin/env node
/**
 * R18-proposed 5th guardrail: flag any `pool.query` / `pool.connect()` call
 * inside src/app/{api,admin,register} (.ts files) unless the site is on
 * the explicit allowlist below. All existing legitimate uses are
 * allowlisted with a short rationale so any NEW unapproved site fails CI.
 *
 * Why this exists: `pool.query` runs on the `postgres` role which has
 * BYPASSRLS. `app.current_org_id` is NOT set, so RLS policies are inert.
 * Tenant isolation then depends entirely on the caller remembering to
 * scope by `organization_id` in every WHERE clause — one forgotten
 * filter = cross-tenant data exposure. `orgTx` / `orgQuery` set
 * `app.current_org_id` and force RLS evaluation, so they're the default
 * for anything touching tenanted data.
 *
 * This script rejects raw pool usage outside the allowlist. Add to the
 * allowlist with a SHORT rationale (one-liner) when intentional.
 *
 * Exits non-zero on any unlisted site.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
// R24-M-5: previously SCOPES only covered app/api, app/admin, app/
// register — the guardrail never scanned `src/lib/persistence/**`
// which contains ~40 raw `pool.query` sites. Any new pg* helper
// that skipped its `organization_id` filter slipped past. Now
// includes the persistence directory; existing helpers are
// allowlisted below with rationale.
const SCOPES = [
  "src/app/api",
  "src/app/admin",
  "src/app/register",
  "src/lib/persistence",
];

// Existing legitimate pool.query / pool.connect sites. Adding to this list
// is a CODE REVIEW moment: is this site actually safe? It's safe if
//   • the query is intrinsically tenant-free (e.g. session lookup by id,
//     auth lookup before org is known), OR
//   • it's inside a transaction that ALSO sets app.current_org_id via
//     `SET LOCAL` / `set_config`, OR
//   • it's a health / infra query with no tenanted tables.
//
// Format: "<relative-path>:<rationale>". One entry per file; the whole
// file is allowlisted if listed here (the rationale covers every raw
// pool usage within it).
const ALLOWLIST = {
  // Auth routes operate BEFORE the caller's org is known — they look up
  // the employee by email/PIN and derive the org from the match. RLS
  // can't help here because we need to scan across orgs.
  "src/app/api/auth/login/route.ts":
    "pre-login email lookup; caller's org is the LOOKUP RESULT, not input",
  "src/app/api/auth/register-login/route.ts":
    "pre-login PIN lookup via register_pin_candidates RPC; SECURITY DEFINER scopes by location",
  // Signup email verification (R8-M-12). Atomically consumes a
  // pending_signups row + creates org/location/employee/credential.
  // The lookup is keyed on a cryptographic token that ONLY the recipient
  // of the verification email has, so no tenant-enumeration surface.
  "src/app/api/auth/verify/route.ts":
    "pending-signup token consumption + new-org provisioning; no tenant exists yet",
  // R27-M3: password rotation / reset / session-revocation routes.
  // password-change: gated by admin session cookie; filters by the
  //   caller's own employee_id (cookie-proven).
  // password-reset-initiate: pre-auth email lookup (same shape as login);
  //   caller's org is the LOOKUP RESULT, not input.
  // password-reset-confirm: redeems a 256-bit token; query filters on
  //   the token itself which is globally-unique cryptographic proof.
  // revoke-all-sessions: gated by admin session; filters by caller's
  //   own employee_id.
  "src/app/api/auth/password-change/route.ts":
    "authenticated password rotation; queries filter by cookie-proven employee_id",
  "src/app/api/auth/password-reset-initiate/route.ts":
    "pre-auth reset token mint; email lookup across orgs, token insert scoped to found employee",
  "src/app/api/auth/password-reset-confirm/route.ts":
    "token redemption; filters by globally-unique 256-bit token",
  "src/app/api/auth/revoke-all-sessions/route.ts":
    "authenticated session wipe; filters by cookie-proven employee_id",
  // R27-M6: pre-login register page. Replaced anon RPC with direct
  // server-side pool lookup to stop externally exposing a live
  // locationId. Query is a one-shot "pick a default location to
  // show the PIN form" — no tenant scoping needed (caller is
  // pre-authenticated).
  "src/app/register/page.tsx":
    "pre-login location-picker; no tenant known yet, one-shot pick",
  // Health check is intentionally unscoped.
  "src/app/api/health/route.ts":
    "infra health probe; no tenanted data",
  // R33-C1: internal cleanup entry point, gated by OPS_CLEANUP_SECRET
  // Bearer token (R38-C-H9 added optional HMAC-signed replay protection).
  // Calls `run_nightly_cleanup()` SECURITY DEFINER — tenanted-data
  // cleanup is scoped INSIDE the function, not the caller.
  "src/app/api/internal/run-cleanup/route.ts":
    "ops cleanup endpoint; SECDEF fn scopes tenanted deletes internally",
  // R23-L-3: admin-gated variant. Same shape as /api/health; gated by
  // `audit.view` permission and only executes a `SELECT 1 + now() +
  // version()` probe with no tenant scope.
  "src/app/api/admin/health/route.ts":
    "infra health probe (admin-gated); no tenanted data",
  // Employees POST/PATCH scan auth_credentials across the org for PIN
  // collision detection. They explicitly filter `e.organization_id = $N`
  // in the query; `orgQuery` here would pass a per-request client but
  // the query is ALREADY org-scoped via WHERE clause.
  "src/app/api/employees/route.ts":
    "PIN-collision scan; queries explicitly filter by organization_id",
  // Customer-display GET accepts either cookie auth OR an HMAC display
  // token (R8-H-4). The token path needs to resolve org_id from
  // register_session_id BEFORE orgQuery can run — the lookup is scoped
  // by a specific id the token has proven possession of, so no tenant
  // enumeration surface.
  "src/app/api/customer-display/route.ts":
    "HMAC-token display auth resolves org from a specific register_session_id",
  // Products POST/PUT/PATCH/DELETE use a shared orgTx client across
  // multi-step writes (audit event + invalidation). The raw pool.connect
  // is wrapped by a `SELECT set_config('app.current_org_id', ...)` at
  // the top of each transaction — verified by reading each usage.
  "src/app/api/products/route.ts":
    "pool.connect wrapped in set_config(app.current_org_id) within each tx",
  // Purchase-orders + receiving use the same pattern: pool.connect +
  // BEGIN + set_config + ... + COMMIT. Verified.
  "src/app/api/purchase-orders/route.ts":
    "pool.connect wrapped in set_config(app.current_org_id) per R8 pattern",
  "src/app/api/receiving/route.ts":
    "pool.connect wrapped in set_config(app.current_org_id) per R8 pattern",
  // Admin login-audit lookup. Uses per-request facade (getPool) + queries
  // explicitly filter by employee.id (caller's own). No tenant risk.
  "src/app/admin/actions.ts":
    "failed-login audit; queries filter by specific employee.id (caller-derived)",
  // Register actions use `getPool()` (per-request facade) for a mix of
  // SECURITY DEFINER RPC invocations AND raw SELECTs that explicitly
  // filter by `organization_id = $N` in the WHERE (e.g., the
  // adminOpenShiftAction employee/location/shift lookups). R19-INFO-1
  // clarified the mixed usage since "RPC only" was inaccurate.
  "src/app/register/actions.ts":
    "SECURITY DEFINER RPC calls + raw SELECTs that explicitly filter by organization_id",
  // Checkout + return actions read customer/transaction lookups with
  // explicit `organization_id = $N` filters before writing.
  "src/app/register/checkout-action.ts":
    "pre-read customer tax_exempt + related lookups; queries filter by organization_id",
  "src/app/register/return-action.ts":
    "original-txn lookup; queries filter by organization_id",
  // R19-INFO-1: event-action.ts + approval-action.ts have NO raw
  // pool.query today (only comments referencing the historical pattern).
  // Left unlisted — if a future edit reintroduces raw pool use, CI flags
  // it for review rather than pre-authorizing it.

  // R24-M-5: persistence helpers are allowlisted as a group. Every
  // `pg*` function in these files explicitly filters by
  // organization_id in its WHERE clause (or accepts organizationId
  // as a required parameter per the `local/pg-helpers-require-org`
  // ESLint rule in eslint-rules/index.mjs). The rule enforces the
  // parameter signature; this allowlist acknowledges the files.
  //
  // If a future helper is added here without an organizationId
  // param, the ESLint rule fails first. If that rule is bypassed
  // (e.g., via disable-comment), the query should still be auditable
  // because every pg* helper here does org-scoping in SQL. If BOTH
  // protections fail, cross-tenant exposure is possible — so the
  // defense-in-depth recommendation is to periodically spot-check
  // the files for `pool.query(...)` without any `organization_id`
  // reference.
  "src/lib/persistence/postgres-store.ts":
    "pg* helpers — all filter by organization_id per pg-helpers-require-org ESLint rule",
  "src/lib/persistence/postgres-phase3.ts":
    "pg* helpers — same pattern as postgres-store.ts",
  "src/lib/persistence/postgres-read-store.ts":
    "get_full_store + read helpers — all scoped to organization_id",
};

// Strip // line comments and /* block comments */ so the regex doesn't
// match references inside JSDoc / explanatory comments.
function stripComments(src) {
  // Block comments first (greedy but non-nested is fine for JS).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Then line comments.
  out = out.replace(/(^|[^:\\])\/\/[^\n]*$/gm, "$1");
  return out;
}

function countRawPoolUsagesInText(src) {
  const stripped = stripComments(src);
  // Allow whitespace (incl. newlines) around the `.` so
  //     pool
  //       .query(...)
  // is caught. Prior `\bpool\.query\b` missed this and the self-test
  // revealed the gap when R23's prevention push added the fixture.
  return (
    (stripped.match(/\bpool\s*\.\s*query\b/g)?.length ?? 0) +
    (stripped.match(/\bpool\s*\.\s*connect\s*\(/g)?.length ?? 0)
  );
}

// Walk one file and count raw-pool usages.
function countRawPoolUsages(abs) {
  return countRawPoolUsagesInText(fs.readFileSync(abs, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────
// Self-test: prove the detector catches representative patterns
// (and ignores the ones it should ignore) BEFORE the real scan. If
// the detector regresses, we exit 2 (distinct from exit 1 = real
// offenders).
// ─────────────────────────────────────────────────────────────────────
function selfTest() {
  const cases = [
    // [expected count, label, snippet]
    [1, "bare pool.query", `pool.query('SELECT 1');`],
    [1, "bare pool.connect", `const c = await pool.connect();`],
    [2, "both in same file", `pool.query('x'); const c = await pool.connect();`],
    [0, "commented-out pool.query", `// pool.query('x');`],
    [0, "pool.query in /* block */", `/* pool.query('x') */`],
    [0, "orgTx is fine", `const c = await orgTx(orgId);`],
    [0, "pool as name but not call", `const poolSize = 10; usePool(pool);`],
    [1, "pool.query across newline", `pool\n  .query('x');`],
  ];
  const fails = [];
  for (const [expected, label, snippet] of cases) {
    const got = countRawPoolUsagesInText(snippet);
    if (got !== expected) {
      fails.push(`expected ${expected} for "${label}": got ${got}`);
    }
  }
  if (fails.length > 0) {
    console.error(`\n✗ check-no-raw-pool-query self-test FAILED — detector is broken:\n`);
    for (const f of fails) console.error(`  ${f}`);
    console.error(`\nThis means the raw-pool guardrail is a placebo. Fix the detector before merging.\n`);
    process.exit(2);
  }
}

selfTest();

const findings = [];

function walk(abs) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      const rel = path.relative(ROOT, full);
      const count = countRawPoolUsages(full);
      if (count > 0 && !ALLOWLIST[rel]) {
        findings.push({ rel, count });
      }
    }
  }
}

for (const scope of SCOPES) {
  const abs = path.join(ROOT, scope);
  if (fs.existsSync(abs)) walk(abs);
}

if (findings.length === 0) {
  console.log(
    `\u2713 No-raw-pool-query check passed (${Object.keys(ALLOWLIST).length} files allowlisted)`,
  );
  process.exit(0);
}

console.log(`\u2717 ${findings.length} file(s) use raw pool.query / pool.connect without allowlist entry:`);
for (const f of findings) {
  console.log(`  ${f.rel}  (${f.count} usage${f.count > 1 ? "s" : ""})`);
}
console.log(`
Raw pool access runs on the 'postgres' role with BYPASSRLS — RLS policies
are inert. Prefer 'orgTx' / 'orgQuery' from @/lib/supabase-rest (they set
app.current_org_id so WITH CHECK + USING fire).

If this usage IS safe (e.g., pre-login auth lookup, infra probe, query
that explicitly filters by organization_id in its WHERE clause), add the
file to ALLOWLIST in scripts/check-no-raw-pool-query.mjs with a one-line
rationale.`);
process.exit(1);
