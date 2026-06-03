#!/usr/bin/env node
/**
 * Guardrail: detect PRODUCTION schema drift — columns the migrations DEFINE
 * but the live prod DB is MISSING.
 *
 * Motivation: SIM-AUDIT8 found that prod's `returns` table was missing
 * transaction_id + updated_at, `organizations` was missing approval_thresholds
 * + loyalty_config, etc. — columns every migration file defines, but which
 * silently never applied to prod because early `CREATE TABLE IF NOT EXISTS` /
 * `ADD COLUMN IF NOT EXISTS` statements no-op'd against pre-existing objects.
 * Returns were 100% broken in prod for the app's entire life and NO guardrail
 * caught it: `check:schema` validates CODE-vs-MIGRATIONS, and both were
 * correct — only the LIVE DB diverged. This closes that gap.
 *
 * Two modes (the self-test ALWAYS runs first so the diff logic is CI-tested
 * even where no prod DB is reachable):
 *
 *   - Self-test only (guardrails CI, local): no PROD_DATABASE_URL set ->
 *     run selfTest(), print "skipped (no PROD_DATABASE_URL)", exit 0.
 *   - Real check (deploy CI, post-migration): REFERENCE_DATABASE_URL (a
 *     freshly-migrated DB = the source of truth) + PROD_DATABASE_URL ->
 *     diff prod's columns against the reference. Exit 1 on drift.
 *
 * Must run AFTER migrations apply to prod (deploy.yml), else a PR that adds a
 * new column legitimately shows the reference ahead of prod (not drift).
 *
 * Connection failure to prod is treated as a SKIP (exit 0 + warning), not a
 * failure — so a transient prod-connectivity blip can't red a build. Only an
 * actual confirmed missing column fails.
 */
import pg from "pg";

/**
 * Pure diff: given the reference column set (migrations), prod's column set,
 * and the set of tables that actually exist in prod, return the columns that
 * are MISSING from prod for tables prod has. (Tables prod lacks entirely are
 * reported separately as warnings — a missing table is usually an intentional
 * not-yet-deployed feature, whereas a missing column on an existing table is
 * the dangerous silent-drift case.)
 *
 * @param {Set<string>} refCols  "table.column" present in the reference
 * @param {Set<string>} prodCols "table.column" present in prod
 * @param {Set<string>} prodTables table names that exist in prod
 * @returns {{ missingColumns: string[], missingTables: string[] }}
 */
export function findDrift(refCols, prodCols, prodTables) {
  const missingColumns = [];
  const missingTablesSet = new Set();
  for (const col of refCols) {
    if (prodCols.has(col)) continue;
    const table = col.slice(0, col.indexOf("."));
    if (prodTables.has(table)) missingColumns.push(col);
    else missingTablesSet.add(table);
  }
  return {
    missingColumns: missingColumns.sort(),
    missingTables: [...missingTablesSet].sort(),
  };
}

function selfTest() {
  const ref = new Set(["returns.id", "returns.transaction_id", "returns.updated_at", "organizations.id", "future_feature.id"]);
  const prod = new Set(["returns.id", "organizations.id"]);
  const prodTables = new Set(["returns", "organizations"]);
  const { missingColumns, missingTables } = findDrift(ref, prod, prodTables);
  const expectCols = ["returns.transaction_id", "returns.updated_at"];
  const okCols = JSON.stringify(missingColumns) === JSON.stringify(expectCols);
  // future_feature table doesn't exist in prod -> reported as a missing table, not a column
  const okTables = JSON.stringify(missingTables) === JSON.stringify(["future_feature"]);
  // a clean comparison yields nothing
  const clean = findDrift(new Set(["a.b"]), new Set(["a.b"]), new Set(["a"]));
  const okClean = clean.missingColumns.length === 0 && clean.missingTables.length === 0;
  if (!okCols || !okTables || !okClean) {
    console.error("✗ check-prod-drift self-test FAILED", { missingColumns, missingTables, clean });
    process.exit(1);
  }
  console.log("✓ check-prod-drift self-test passed (detects missing columns + missing tables, clean is clean)");
}

async function dumpColumns(connectionString) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 20000, statement_timeout: 20000 });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> '_migrations'`,
    );
    const cols = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const tables = new Set(rows.map((r) => r.table_name));
    return { cols, tables };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  selfTest();

  const PROD = process.env.PROD_DATABASE_URL;
  const REF = process.env.REFERENCE_DATABASE_URL;
  if (!PROD) {
    console.log("→ check-prod-drift: skipped (no PROD_DATABASE_URL) — self-test only.");
    return;
  }
  if (!REF) {
    console.error("✗ PROD_DATABASE_URL set but REFERENCE_DATABASE_URL is missing — cannot diff.");
    process.exit(1);
  }

  let ref, prod;
  try {
    ref = await dumpColumns(REF);
  } catch (err) {
    console.error(`✗ could not read REFERENCE DB: ${err.message}`);
    process.exit(1);
  }
  try {
    prod = await dumpColumns(PROD);
  } catch (err) {
    // Connectivity blips must not red the build — only confirmed drift does.
    console.warn(`⚠️  check-prod-drift: could not reach prod (${err.message}); SKIPPING (not failing).`);
    return;
  }

  const { missingColumns, missingTables } = findDrift(ref.cols, prod.cols, prod.tables);
  // This check runs in deploy.yml AFTER migrations apply to prod, so every
  // table/column the migrations define MUST exist in prod by now. Both a
  // missing column (on an existing table) and a missing table are drift —
  // customer_display_state was a code-referenced table entirely absent from
  // prod, 500ing the whole customer-display feature (found by this guardrail).
  if (missingColumns.length === 0 && missingTables.length === 0) {
    console.log(`✓ no prod schema drift (${prod.cols.size} prod columns / ${prod.tables.size} tables checked against the migrated reference).`);
    return;
  }
  console.error(`\n✗ PRODUCTION SCHEMA DRIFT — the live DB is missing objects the migrations define:`);
  if (missingTables.length) {
    console.error(`  ${missingTables.length} TABLE(S) missing from prod:`);
    for (const t of missingTables) console.error(`    ${t}`);
  }
  if (missingColumns.length) {
    console.error(`  ${missingColumns.length} COLUMN(S) missing from prod:`);
    for (const c of missingColumns) console.error(`    ${c}`);
  }
  console.error(`\nThese silently no-op'd on prod (CREATE TABLE / ADD COLUMN IF NOT EXISTS against a pre-existing/snapshot DB).`);
  console.error(`Write an idempotent repair migration (ADD COLUMN / CREATE TABLE IF NOT EXISTS) — see migrations 083/084/085.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
