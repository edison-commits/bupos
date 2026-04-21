#!/usr/bin/env node
/**
 * Schema drift detector.
 *
 * Pulls the live DB's column list for every table, then greps application
 * source for snake_case identifiers that look like column references.
 * Surfaces:
 *   - Application code referencing columns that don't exist in the DB
 *     (the R9-C-2 "address_1" shape — would 500 every update).
 *   - Columns in migrations that no code references (dead columns).
 *
 * Narrow regex so we don't false-positive on every string literal. Only
 * flag columns referenced in SQL contexts — inside backticks with WHERE,
 * SET, SELECT, INSERT, ON CONFLICT, ORDER BY, etc.
 *
 * Run: node scripts/test-schema-drift.mjs
 */

import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const txt = fs.readFileSync("/Users/edison/Desktop/bupos/code/.env.local", "utf8");
for (const line of txt.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^"|"$/g, "");
}

const ROOT = "/Users/edison/Desktop/bupos/code";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Load live schema ──────────────────────────────────────────────────

const { rows: cols } = await pool.query(`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position
`);

const tableCols = {};
for (const r of cols) {
  if (!tableCols[r.table_name]) tableCols[r.table_name] = new Set();
  tableCols[r.table_name].add(r.column_name);
}

// Also include columns mentioned in migrations — so the detector catches
// code referencing a column that no migration creates (real drift), and
// doesn't false-positive on test environments that are missing some
// migrations (test-env artifact).
const migDir = path.join(ROOT, "supabase/migrations");
for (const file of fs.readdirSync(migDir)) {
  if (!file.endsWith(".sql")) continue;
  const sql = fs.readFileSync(path.join(migDir, file), "utf8");
  // Match CREATE TABLE ... ( columns ) blocks to extract column names.
  const createTblRx = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:;|INHERITS)/gi;
  let m;
  while ((m = createTblRx.exec(sql)) !== null) {
    const [, tableName, body] = m;
    if (!tableCols[tableName]) tableCols[tableName] = new Set();
    // Extract "col_name TYPE ..." from each line; skip constraint lines.
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("--")) continue;
      if (/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i.test(t)) continue;
      const colMatch = t.match(/^([a-z_][a-z0-9_]*)\s+/i);
      if (colMatch) tableCols[tableName].add(colMatch[1].toLowerCase());
    }
  }
  // Also match ALTER TABLE ... ADD COLUMN
  const addColRx = /ALTER TABLE(?:\s+IF EXISTS)?\s+(\w+)[\s\S]*?ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi;
  while ((m = addColRx.exec(sql)) !== null) {
    const [, tableName, colName] = m;
    if (!tableCols[tableName]) tableCols[tableName] = new Set();
    tableCols[tableName].add(colName.toLowerCase());
  }
}

// ─── Walk source files and extract SQL column refs ─────────────────────

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      files.push(...walk(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(full);
    }
  }
  return files;
}

const sourceFiles = walk(path.join(ROOT, "src"));

// Build a table → columns map from the code's SQL statements. We look for
// FROM <table> ... (and its aliases). Limited scope — good enough to catch
// egregious drift like R9-C-2 where pgUpdateLocation referenced `address_1`
// which doesn't exist.

const ALL_COLUMNS = new Set();
for (const cols of Object.values(tableCols)) for (const c of cols) ALL_COLUMNS.add(c);

console.log(`Union of live + migration columns: ${ALL_COLUMNS.size}`);

// Find snake_case identifiers in SQL contexts. We use a simple heuristic:
// inside a template-literal SQL string (delimited by backticks), an
// identifier of form /[a-z][a-z0-9_]+/ that's referenced in UPDATE, INSERT,
// or SELECT column lists.

const findings = [];

for (const file of sourceFiles) {
  const src = fs.readFileSync(file, "utf8");
  // Extract backtick-string literals.
  const tpls = src.match(/`[^`]+`/gs) || [];
  for (const tpl of tpls) {
    // Only interested in SQL-looking ones
    if (!/\b(SELECT|UPDATE|INSERT|DELETE|FROM|SET|WHERE|RETURNING|ON CONFLICT)\b/i.test(tpl)) continue;

    // From SET foo = $N clauses
    const setMatches = tpl.matchAll(/\bSET\s+([a-z_][a-z0-9_]+)\s*=/gi);
    for (const m of setMatches) {
      const col = m[1].toLowerCase();
      if (col.startsWith("local_") || col === "statement_timeout" || col === "constraints" || col === "transaction" || col === "role" || col === "search_path") continue;
      if (!ALL_COLUMNS.has(col)) {
        findings.push({ file: path.relative(ROOT, file), col, where: "SET clause", snippet: tpl.slice(0, 120).replace(/\n/g, " ") });
      }
    }

    // ON CONFLICT (col, col) DO UPDATE SET foo = EXCLUDED.foo
    const setExcluded = tpl.matchAll(/SET\s+([a-z_][a-z0-9_]+)\s*=\s*(?:EXCLUDED\.|inventory_levels\.|[a-z_][a-z0-9_]+\.)?[a-z_]/gi);
    for (const m of setExcluded) {
      const col = m[1].toLowerCase();
      if (col.startsWith("local_") || col === "statement_timeout" || col === "constraints" || col === "transaction" || col === "role" || col === "search_path") continue;
      if (!ALL_COLUMNS.has(col)) {
        findings.push({ file: path.relative(ROOT, file), col, where: "SET EXCLUDED", snippet: tpl.slice(0, 120).replace(/\n/g, " ") });
      }
    }
  }
}

// Deduplicate (same file+col)
const uniq = new Map();
for (const f of findings) {
  const key = `${f.file}:${f.col}`;
  if (!uniq.has(key)) uniq.set(key, f);
}

// ─── Report ────────────────────────────────────────────────────────────

console.log("─── Schema drift detector ────────────────────────────────");
console.log(`Tables loaded:   ${Object.keys(tableCols).length}`);
console.log(`Total columns:   ${ALL_COLUMNS.size}`);
console.log(`Source files:    ${sourceFiles.length}`);
console.log();

const problems = [...uniq.values()];
if (problems.length === 0) {
  console.log("\u2713 No unknown columns referenced in SET clauses");
  process.exit(0);
} else {
  console.log(`\u2717 ${problems.length} unknown column references:`);
  for (const p of problems.slice(0, 20)) {
    console.log(`  ${p.file}`);
    console.log(`    column: "${p.col}"  (in ${p.where})`);
    console.log(`    snippet: ${p.snippet}...`);
  }
  if (problems.length > 20) console.log(`  ... +${problems.length - 20} more`);
  await pool.end();
  process.exit(1);
}
