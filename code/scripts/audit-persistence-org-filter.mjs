#!/usr/bin/env node
/**
 * R24-M-5: complementary guardrail for the persistence layer.
 *
 * `check-no-raw-pool-query.mjs` allowlists `src/lib/persistence/**`
 * because every pg* helper there IS supposed to filter by
 * `organization_id`. This script double-checks that invariant: for
 * every `pool.query(...)` / `client.query(...)` inside a persistence
 * file, the SQL text must reference `organization_id` (or be one of
 * the documented exceptions below).
 *
 * Caught shape: someone adds a new `pgReadByIdUnsafe(id)` helper that
 * does `SELECT * FROM table WHERE id = $1` without org scope. The
 * ESLint `pg-helpers-require-org` rule catches this at the SIGNATURE
 * layer (function must take organizationId). This script catches it
 * at the SQL layer (query must filter by organization_id).
 *
 * Self-test: synthesize a persistence-like string with known-good and
 * known-bad queries, assert the detector flags the bad one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const PERSISTENCE_DIR = path.join(ROOT, "src/lib/persistence");

// Queries that intentionally don't filter by organization_id (e.g.,
// cross-org health checks, migration helpers, etc.). Keyed by
// normalized SQL text snippet — keep narrow.
const EXCEPTIONS = [
  // Health/identity probes.
  /^\s*SELECT\s+1\b/i,
  /^\s*SELECT\s+NOW\(\)/i,
  // JOIN-based queries where org scope lives on the joined table.
  // Each match here represents a deliberate SQL shape we've reviewed.
  // Add with a comment justifying the exception.
  // (Populated as real cases emerge.)
];

// Extract all .query(`SQL_TEMPLATE_LITERAL`, ...) calls and return
// their SQL text. We only care about template-literal queries; string
// concatenation or identifier-only arguments are too lax to audit.
function extractSqlQueries(src) {
  const queries = [];
  const rx = /\.query\s*\(\s*`([\s\S]*?)`/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    queries.push({ sql: m[1], index: m.index });
  }
  return queries;
}

function queryNeedsCheck(sql) {
  // Skip pure DDL and non-SELECT/INSERT/UPDATE/DELETE queries —
  // they're not runtime tenant-scoped at the row level.
  const trimmed = sql.trim();
  if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(trimmed)) return false;
  // Skip BEGIN/COMMIT/ROLLBACK style tx-control.
  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET)\b/i.test(trimmed)) return false;
  // Skip `set_config` style guards (the tenancy primitive itself).
  if (/\bset_config\s*\(/i.test(trimmed)) return false;
  return true;
}

function isExempt(sql) {
  return EXCEPTIONS.some((rx) => rx.test(sql));
}

function scanFile(abs, rel) {
  const src = fs.readFileSync(abs, "utf8");
  const queries = extractSqlQueries(src);
  const findings = [];
  for (const { sql, index } of queries) {
    if (!queryNeedsCheck(sql)) continue;
    if (isExempt(sql)) continue;
    const hasOrgScope =
      /\borganization_id\b/i.test(sql) ||
      /\borg_id\b/i.test(sql) ||
      /\bapp\.current_org_id\b/i.test(sql);
    if (!hasOrgScope) {
      const before = src.slice(0, index);
      const lineNo = before.split("\n").length;
      findings.push({
        file: rel,
        line: lineNo,
        sqlHead: sql.trim().slice(0, 120).replace(/\s+/g, " "),
      });
    }
  }
  return findings;
}

function selfTest() {
  const good = "\
    await pool.query(`SELECT id FROM customers WHERE organization_id = $1`);\
    await pool.query(`INSERT INTO products (organization_id, name) VALUES ($1, $2)`);\
    await pool.query(`SELECT 1`);\
  ";
  const bad = "\
    await pool.query(`SELECT * FROM customers WHERE id = $1`);\
  ";
  const goodFindings = scanText(good);
  if (goodFindings.length !== 0) {
    console.error(`\n✗ selftest FAILED — good fixture produced findings: ${JSON.stringify(goodFindings)}\n`);
    process.exit(2);
  }
  const badFindings = scanText(bad);
  if (badFindings.length !== 1) {
    console.error(`\n✗ selftest FAILED — bad fixture expected 1 finding, got ${badFindings.length}\n`);
    process.exit(2);
  }
}

function scanText(src) {
  const queries = extractSqlQueries(src);
  const findings = [];
  for (const { sql } of queries) {
    if (!queryNeedsCheck(sql)) continue;
    if (isExempt(sql)) continue;
    const hasOrgScope =
      /\borganization_id\b/i.test(sql) ||
      /\borg_id\b/i.test(sql) ||
      /\bapp\.current_org_id\b/i.test(sql);
    if (!hasOrgScope) findings.push(sql.trim().slice(0, 120));
  }
  return findings;
}

selfTest();

const allFindings = [];
if (fs.existsSync(PERSISTENCE_DIR)) {
  for (const entry of fs.readdirSync(PERSISTENCE_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    const abs = path.join(PERSISTENCE_DIR, entry.name);
    const rel = path.relative(ROOT, abs);
    allFindings.push(...scanFile(abs, rel));
  }
}

// R24-M-5: this is an ADVISORY report, not a hard CI gate. Many
// legitimate persistence queries look org-unscoped at SQL level but
// are safe by construction — the row ID was validated upstream, the
// query runs inside `orgTx` with `app.current_org_id` set, or the FK
// chain guarantees single-tenant access. Automated SQL inspection
// can't distinguish these from a real missing-filter bug.
//
// Intent: run this periodically (or on a PR that touches
// persistence) and SPOT-CHECK each reported site. If any genuinely
// lack org scope, add the organization_id filter. For hard gates,
// see `check-no-raw-pool-query.mjs` + the ESLint
// `pg-helpers-require-org` rule.
//
// Exit code is always 0 — this is a report, not a gate.
if (allFindings.length > 0) {
  console.log(
    `\n⚠  ${allFindings.length} persistence query / queries without an inline organization_id filter (ADVISORY ONLY):\n`,
  );
  for (const f of allFindings) {
    console.log(`  ${f.file}:${f.line}`);
    console.log(`    ${f.sqlHead}...`);
  }
  console.log(
    `\nThese may be legitimate (row-id scoped, orgTx-wrapped, FK-chained).\n` +
      `Spot-check each site; add the org filter if genuinely missing, or\n` +
      `an EXCEPTIONS regex here if the shape is intentional.\n`,
  );
  // Intentional exit 0 — advisory, not a gate.
  process.exit(0);
}

console.log(`✓ persistence org-filter advisory report (0 flagged)`);
