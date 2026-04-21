#!/usr/bin/env node
/**
 * R14-class guardrail: every `ENABLE ROW LEVEL SECURITY` statement across
 * `supabase/migrations/` must have a matching `FORCE ROW LEVEL SECURITY`
 * somewhere in the tree.
 *
 * ⚠️  R26-F1: FORCE RLS does NOT override the role-level BYPASSRLS
 *     privilege. Prod's `postgres` role has `rolbypassrls=true`
 *     (confirmed via pg_roles). Every `orgQuery`/`orgTx` / raw
 *     `pool.query` call in this app runs as postgres and BYPASSES
 *     RLS unconditionally. FORCE RLS only affects connections by
 *     the table owner WITHOUT BYPASSRLS — a shape we don't use.
 *     Verified: SELECT under postgres with bogus app.current_org_id
 *     returns every row across every org.
 *
 *     Therefore FORCE RLS is a DEV-MODE NET (when running tests as
 *     a non-BYPASSRLS role, e.g., `app_user` in the integration
 *     suite) and a DEFENSE-IN-DEPTH if BYPASSRLS is ever removed.
 *     It is NOT the active enforcement layer in prod — that's the
 *     app-level `WHERE organization_id = $N` filter on every query
 *     + the `pg-helpers-require-org` ESLint rule on write paths +
 *     the `check-no-raw-pool-query` allowlist with explicit rationale.
 *
 * Round 14 surfaced R14-C-1 (6 tables in migration 041 only ENABLE'd) and
 * R14-H-8 (customer_display_state since migration 010). Round 15 hardened
 * this script against R15-H-1. Round 26 clarified the model.
 *
 * Exits non-zero on mismatch.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
// R23-prevention: allow self-test to override. Same pattern as
// check-schema-drift-ci.mjs.
const MIG_DIR = process.env.BUPOS_SELFTEST_MIG_DIR
  ? path.resolve(process.env.BUPOS_SELFTEST_MIG_DIR)
  : path.join(ROOT, "supabase/migrations");

const enabled = new Set();
const forced = new Set();
// R20-LOW-1: also track `CREATE POLICY ... ON <table>` to catch the class
// where a policy exists but the table was never ENABLE'd (policy dormant).
const policied = new Set();

const ENABLE_RX = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?([a-z_][a-z0-9_]*)["']?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
const FORCE_RX  = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?([a-z_][a-z0-9_]*)["']?\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
// Match CREATE POLICY ... ON <table>. Ignore temp-DO-block creates; the
// static form is what we need to cover.
const POLICY_RX = /CREATE\s+POLICY\s+[a-z_][a-z0-9_]*\s+ON\s+(?:IF\s+EXISTS\s+)?["']?([a-z_][a-z0-9_]*)["']?/gi;

// Extract the list of table names from an ARRAY literal appearing in a
// FOREACH loop header. Handles both `FOREACH ... IN ARRAY ARRAY[...]`
// (literal) and `FOREACH ... IN ARRAY tbls_var` (variable, resolved from
// an earlier `<var> text[] := ARRAY[...]` declaration inside the block).
function tablesInArrayLiteral(arrayInner) {
  return arrayInner
    .split(",")
    .map((raw) => raw.replace(/::\s*text\[?\]?/g, "").replace(/['"]/g, "").trim())
    .filter(Boolean);
}

// Walk one DO $$ ... END $$ block and return {enable:Set, force:Set}.
// A FOREACH block whose BODY contains `ENABLE ROW LEVEL SECURITY` attributes
// every table in its IN-ARRAY to `enable`. Same for `FORCE`. A block can
// contain BOTH an enable statement and a force statement, in which case
// its tables are attributed to both.
function analyzeDoBlock(doBody) {
  const out = { enable: new Set(), force: new Set() };

  // First: pick out var-declared arrays like `tbls text[] := ARRAY['a','b']`
  // inside this block's DECLARE so we can resolve `IN ARRAY <var>` later.
  const varArrays = new Map();
  const varDeclRx = /([a-z_][a-z0-9_]*)\s+text\s*\[\]\s*(?::=\s*ARRAY\s*\[([^\]]+)\])?/gi;
  let vd;
  while ((vd = varDeclRx.exec(doBody)) !== null) {
    if (vd[2]) varArrays.set(vd[1], tablesInArrayLiteral(vd[2]));
  }

  // Now walk every FOREACH ... LOOP ... END LOOP nested block.
  const foreachRx = /FOREACH\s+(?:[a-z_][a-z0-9_]*)\s+IN\s+ARRAY\s+(ARRAY\s*\[([^\]]+)\]|([a-z_][a-z0-9_]*))\s*(?:::\s*text\s*\[\]\s*)?LOOP([\s\S]*?)END\s+LOOP/gi;
  let fe;
  while ((fe = foreachRx.exec(doBody)) !== null) {
    const literalInner = fe[2];
    const varName = fe[3];
    const body = fe[4];

    const tables = literalInner
      ? tablesInArrayLiteral(literalInner)
      : varArrays.get(varName) ?? [];

    if (tables.length === 0) continue;

    if (/EXECUTE\s+format\s*\(\s*'ALTER\s+TABLE\s+%I\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY'/i.test(body)) {
      for (const t of tables) out.enable.add(t.toLowerCase());
    }
    if (/EXECUTE\s+format\s*\(\s*'ALTER\s+TABLE\s+%I\s+FORCE\s+ROW\s+LEVEL\s+SECURITY'/i.test(body)) {
      for (const t of tables) out.force.add(t.toLowerCase());
    }
  }

  return out;
}

for (const file of fs.readdirSync(MIG_DIR).sort()) {
  if (!file.endsWith(".sql")) continue;
  const sql = fs.readFileSync(path.join(MIG_DIR, file), "utf8");

  // 1. Static `ALTER TABLE <name> ENABLE/FORCE ROW LEVEL SECURITY`
  let m;
  ENABLE_RX.lastIndex = 0;
  while ((m = ENABLE_RX.exec(sql)) !== null) enabled.add(m[1].toLowerCase());
  FORCE_RX.lastIndex = 0;
  while ((m = FORCE_RX.exec(sql)) !== null) forced.add(m[1].toLowerCase());
  POLICY_RX.lastIndex = 0;
  while ((m = POLICY_RX.exec(sql)) !== null) policied.add(m[1].toLowerCase());

  // 2. Per-DO-block FOREACH analysis. We match each `DO $$ ... END $$`
  //    (or `DO $outer$ ... $outer$` variant) independently so enable/force
  //    attribution doesn't leak across blocks.
  const doBlockRx = /DO\s+\$([a-z_]*)\$([\s\S]*?)\$\1\$\s*;/gi;
  let db;
  while ((db = doBlockRx.exec(sql)) !== null) {
    const body = db[2];
    const { enable, force } = analyzeDoBlock(body);
    for (const t of enable) enabled.add(t);
    for (const t of force) forced.add(t);
  }
}

const missingForce = [...enabled].filter((t) => !forced.has(t)).sort();
// R20-LOW-1: dormant-policy detection. If a migration CREATE POLICYs on a
// table but no migration ENABLE's RLS on it, the policy is inert on
// fresh-DB (and relies on ad-hoc enable in prod). Flag as a separate
// class so the error message is specific.
const missingEnable = [...policied].filter((t) => !enabled.has(t)).sort();

const hasIssue = missingForce.length > 0 || missingEnable.length > 0;

if (!hasIssue) {
  console.log(`\u2713 RLS force-matching check passed (${enabled.size} tables enabled, all also forced; ${policied.size} with policies)`);
  process.exit(0);
}

if (missingForce.length > 0) {
  console.log(`\u2717 ${missingForce.length} tables ENABLE ROW LEVEL SECURITY but NEVER FORCE:`);
  for (const t of missingForce) console.log(`  ${t}`);
  console.log("\nAdd `ALTER TABLE <name> FORCE ROW LEVEL SECURITY` in a migration. Without FORCE,");
  console.log("the Supabase `postgres` role skips RLS policies and every orgQuery/orgTx path on");
  console.log("that table crosses tenants silently.\n");
}

if (missingEnable.length > 0) {
  console.log(`\u2717 ${missingEnable.length} tables have CREATE POLICY but no matching ALTER TABLE ... ENABLE ROW LEVEL SECURITY:`);
  for (const t of missingEnable) console.log(`  ${t}`);
  console.log("\nThe policy is DORMANT without ENABLE. Add `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY`");
  console.log("(and FORCE) in a migration so the policy actually evaluates.");
}
process.exit(1);
