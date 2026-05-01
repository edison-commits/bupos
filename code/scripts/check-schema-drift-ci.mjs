#!/usr/bin/env node
/**
 * CI-friendly schema drift detector — migrations-only, no live DB required.
 *
 * Walks `supabase/migrations/*.sql` to build the set of known columns,
 * then greps `src/` for SET clauses referencing columns that are not in
 * ANY migration. Catches the shape that broke R9-C-2 (`address_1`) and
 * R11-C-1 / R11-C-2 (`organization_id` / `quantity_delta` / `reason_code`
 * on `inventory_adjustments`) — where code writes to columns no migration
 * ever created, causing a 500 at runtime.
 *
 * Exits non-zero on drift. Intended to run in CI + pre-commit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
// R23-prevention: allow the self-test runner to point the scanner at
// fixture directories instead of the real tree. Default to the real
// dirs so ordinary CI invocations are unchanged.
const MIG_DIR = process.env.BUPOS_SELFTEST_MIG_DIR
  ? path.resolve(process.env.BUPOS_SELFTEST_MIG_DIR)
  : path.join(ROOT, "supabase/migrations");
const SRC_DIR = process.env.BUPOS_SELFTEST_SRC_DIR
  ? path.resolve(process.env.BUPOS_SELFTEST_SRC_DIR)
  : path.join(ROOT, "src");

// ─── Build the union of all columns from migrations ────────────────────

const tableCols = {};
// RPC / function NAMES defined across all migrations. Stored as a Set
// keyed on the bare fn name. R12-M-4 shape: the 9 register/session auth
// RPCs were REVOKEd in migrations 027/028 but had NO
// `CREATE OR REPLACE FUNCTION` anywhere — fresh-DB bootstrap broke.
const migratedFunctions = new Set();

// RPC SIGNATURES — map bare name → Set of "type1,type2,..." argument type
// sequences. R13-C-1 shape: `register_quick_switch` was called with
// `$1::uuid, $2::uuid, ...` but the function is declared
// `(text, text, text, text)` — Postgres resolves overloads by type, so
// the call threw "function does not exist" and the try/catch silently
// fell through to raw UPDATEs. We extract the declared types from
// CREATE FUNCTION and compare against the `::type` casts in every call
// site.
const migratedFunctionSigs = {};
function addFunctionSig(name, argTypes) {
  const key = name.toLowerCase();
  if (!migratedFunctionSigs[key]) migratedFunctionSigs[key] = new Set();
  migratedFunctionSigs[key].add(argTypes.map((t) => normalizeType(t)).join(","));
}

// Normalize a Postgres type token for comparison: lowercase, strip
// parameter modifiers like `numeric(12,2)`, alias `timestamptz` ↔
// `timestamp with time zone`, etc.
function normalizeType(t) {
  if (!t) return "";
  let x = t.trim().toLowerCase();
  // Strip DEFAULT <expr> tails
  x = x.replace(/\s+default\s+[^,]+$/i, "");
  // Strip parameter modifiers `numeric(12,2)` → `numeric`
  x = x.replace(/\([^)]*\)/g, "");
  // Aliases
  const aliases = {
    "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp",
    "character varying": "varchar",
    "double precision": "float8",
  };
  if (aliases[x]) x = aliases[x];
  x = x.trim();
  return x;
}

function addColumn(table, column) {
  const t = table.toLowerCase();
  const c = column.toLowerCase();
  if (!tableCols[t]) tableCols[t] = new Set();
  tableCols[t].add(c);
}

for (const file of fs.readdirSync(MIG_DIR).sort()) {
  if (!file.endsWith(".sql")) continue;
  const sql = fs.readFileSync(path.join(MIG_DIR, file), "utf8");

  const createTblRx = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:;|INHERITS)/gi;
  let m;
  while ((m = createTblRx.exec(sql)) !== null) {
    const [, tableName, body] = m;
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("--")) continue;
      if (/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i.test(t)) continue;
      const colMatch = t.match(/^([a-z_][a-z0-9_]*)\s+/i);
      if (colMatch) addColumn(tableName, colMatch[1]);
    }
  }

  // Multi-column ALTER TABLE ... ADD COLUMN a, ADD COLUMN b. Parse each
  // statement separately so we capture every added column, not just the
  // first. Also handles the `ADD COLUMN IF NOT EXISTS` form.
  const alterStmts = sql.match(/ALTER TABLE(?:\s+IF EXISTS)?\s+\w+[\s\S]*?;/gi) || [];
  for (const stmt of alterStmts) {
    const tblMatch = stmt.match(/ALTER TABLE(?:\s+IF EXISTS)?\s+(\w+)/i);
    if (!tblMatch) continue;
    const table = tblMatch[1];
    const addColRx2 = /ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi;
    let am;
    while ((am = addColRx2.exec(stmt)) !== null) {
      addColumn(table, am[1]);
    }
    // R36-drift: also understand RENAME COLUMN — the old name goes out
    // of scope and the new name becomes valid. Before this, migration
    // 062 (which RENAMEd `pending_signups.verification_token` →
    // `verification_token_hash` and `password_resets.token` →
    // `token_hash`) was invisible to the checker, flagging every
    // correct reference to the new column name as drift.
    const renameRx = /RENAME COLUMN\s+([a-z_][a-z0-9_]*)\s+TO\s+([a-z_][a-z0-9_]*)/gi;
    let rm;
    while ((rm = renameRx.exec(stmt)) !== null) {
      addColumn(table, rm[2]);
    }
  }

  // R36-drift: RENAME COLUMN also appears inside `DO $$ ... $$` PL/pgSQL
  // blocks (migration 062's idempotent guard uses this). The outer
  // ALTER-statement regex only catches bare `ALTER TABLE ... ;` — inside
  // a DO block the statement ends with `;` too but the OUTER DO ends
  // with `END$$;` so the parent regex DOES match; however, our statement-
  // split above already grabbed the whole DO block as one "stmt". The
  // embedded RENAME rx above then runs inside that block text and picks
  // the rename up. This comment is here so a future reader doesn't try
  // to "fix" the apparent gap.

  // CREATE [OR REPLACE] FUNCTION [schema.]name(arg1 type1, arg2 type2, ...)
  // Capture both the function name AND its declared argument type signature
  // so we can catch signature drift (R13-C-1 shape: callsite casts to uuid
  // but function declared with text params).
  //
  // The regex is conservative — we match the `(` opening paren and then
  // greedily balance until the matching `)`. Since function args can
  // contain `DEFAULT ...` expressions with parens/commas, we do a simple
  // depth counter instead of a regex alone.
  let pos = 0;
  const createFnHead = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:[a-z_][a-z0-9_]*\s*\.\s*)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let fm;
  while ((fm = createFnHead.exec(sql)) !== null) {
    const name = fm[1];
    migratedFunctions.add(name.toLowerCase());

    // Parse the argument list by tracking paren depth from the open `(`.
    let depth = 1;
    let i = fm.index + fm[0].length;
    const start = i;
    while (i < sql.length && depth > 0) {
      const c = sql[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth === 0) break;
      i++;
    }
    if (depth !== 0) continue; // unmatched — skip
    const argList = sql.slice(start, i);

    // Split by top-level commas (not commas inside parens for numeric(12,2)).
    const args = [];
    let cur = "";
    let d = 0;
    for (const ch of argList) {
      if (ch === "(") d++;
      else if (ch === ")") d--;
      if (ch === "," && d === 0) { args.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());

    // For each arg, extract the TYPE. Form: [mode] name type [DEFAULT expr].
    // mode is IN / OUT / INOUT / VARIADIC (ignored). Name is first identifier,
    // type is the rest (before DEFAULT if any).
    const argTypes = args
      .filter(Boolean)
      .map((arg) => {
        // Strip mode prefix
        const noMode = arg.replace(/^\s*(in|out|inout|variadic)\s+/i, "");
        // Split on first whitespace: `name  type...`
        const m = noMode.match(/^[a-z_][a-z0-9_]*\s+(.+)$/i);
        if (!m) return "";
        let rest = m[1].trim();
        // Strip DEFAULT clause if present
        rest = rest.replace(/\s+default\s+.+$/i, "");
        return rest;
      });
    // Skip functions with no args (nothing to match against).
    if (argTypes.length > 0) addFunctionSig(name, argTypes);
    pos = i;
  }
  void pos;
}

const ALL_COLUMNS = new Set();
for (const cols of Object.values(tableCols)) for (const c of cols) ALL_COLUMNS.add(c);

// ─── Walk source and flag SET refs to unknown columns ──────────────────

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) out.push(full);
  }
  return out;
}

// Session/transaction context names we shouldn't flag as columns.
const PG_CONTEXT_IDENTS = new Set([
  "local_", "statement_timeout", "constraints", "transaction",
  "role", "search_path", "timezone", "lock_timeout",
  "idle_in_transaction_session_timeout", "session_replication_role",
]);

const findings = [];
const rpcFindings = [];

// PostgreSQL built-ins and trigger helpers we don't treat as "undefined
// RPC" — they're provided by the DB itself.
const PG_BUILTINS = new Set([
  "now", "gen_random_uuid", "uuid_generate_v4", "coalesce", "count",
  "sum", "max", "min", "avg", "current_setting", "set_config",
  "pg_advisory_lock", "pg_advisory_unlock", "pg_advisory_xact_lock",
  "jsonb_build_object", "to_jsonb", "jsonb_array_elements", "jsonb_each",
  "string_agg", "array_agg", "unnest", "length", "lower", "upper",
  "trim", "substring", "position", "split_part", "regexp_replace",
  "extract", "date_trunc", "age", "round", "floor", "ceil", "abs",
  // OPS-AUDIT5-HIGH2 sibling: to_char is a built-in (date/number ↔
  // string formatter), not a project RPC. Used by lib/reports/day-
  // range.ts:getOrgToday to format the org-TZ day as YYYY-MM-DD.
  "to_char", "to_date", "to_timestamp", "to_number",
  "greatest", "least", "nullif", "encode", "decode", "md5", "digest",
  "hmac", "crypt", "gen_salt", "to_tsvector", "to_tsquery",
  "plainto_tsquery", "ts_rank", "similarity", "pg_typeof",
  "row_to_json", "json_build_object", "jsonb_set", "jsonb_strip_nulls",
  "jsonb_agg", "json_agg", "generate_series", "random",
]);

// RPCs that are expected to exist in production Supabase but have no
// CREATE FUNCTION migration in the repo. When found here, the drift
// detector WARNs (not FAILs) so CI keeps passing. When empty (the
// desired state), any callsite to an undefined RPC fails CI outright.
//
// As of migration 040, the 9 auth + register RPCs previously on this
// list are codified. Keep the Set in place — future drift of this
// shape should land here only temporarily while a follow-up migration
// is written.
const RPC_KNOWN_GAPS = new Set([]);

// The Set of known table names from migrations. If code references a
// table NOT in migrations, skip drift check for that table entirely —
// some tables (suppliers, purchase_order_lines, etc.) were created out
// of the migration system. We ONLY catch missing-column drift on tables
// we actually have a declaration for. That's the R9-C-2/R11-C-* shape:
// table exists AND in migrations, but code references a column no
// migration created. Any novel new-table drift is picked up when the
// code first runs against the live DB in dev.
const KNOWN_TABLES = new Set(Object.keys(tableCols));

for (const file of walk(SRC_DIR)) {
  const src = fs.readFileSync(file, "utf8");
  const tpls = src.match(/`[^`]+`/gs) || [];
  for (const tpl of tpls) {
    if (!/\b(SELECT|UPDATE|INSERT|DELETE|FROM|SET|WHERE|RETURNING|ON CONFLICT)\b/i.test(tpl)) continue;

    // RPC callsite detection: `SELECT <fn>(...)` or `SELECT * FROM <fn>(...)`.
    // Two reliable shapes:
    //   `SELECT fn(...)`           — scalar RPC
    //   `SELECT * FROM fn(...)`    — set-returning RPC
    //
    // For each callsite we also try to extract the `::type` cast on each
    // argument so we can compare against the declared signature
    // (R13-C-1 shape: callsite `$1::uuid` but function declared as `text`).
    const rpcScanRx = /\bSELECT\s+(?:\*\s+FROM\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
    let rm;
    while ((rm = rpcScanRx.exec(tpl)) !== null) {
      const fn = rm[1].toLowerCase();
      if (PG_BUILTINS.has(fn)) continue;
      if (["exists", "not", "case", "cast", "values"].includes(fn)) continue;

      const expected = RPC_KNOWN_GAPS.has(fn);

      if (!migratedFunctions.has(fn)) {
        rpcFindings.push({
          file: path.relative(ROOT, file),
          fn,
          kind: "missing",
          snippet: tpl.replace(/\n/g, " ").slice(0, 160),
          expected,
        });
        continue;
      }

      // Signature match: parse args from the call site by balancing parens,
      // then grab the `::type` cast on each positional placeholder.
      let depth = 1;
      let i = rm.index + rm[0].length;
      const argStart = i;
      while (i < tpl.length && depth > 0) {
        const c = tpl[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        if (depth === 0) break;
        i++;
      }
      if (depth !== 0) continue;
      const argsRaw = tpl.slice(argStart, i);

      // Split top-level commas, grab each arg's last ::type cast.
      const parts = [];
      let cur = "";
      let d = 0;
      for (const ch of argsRaw) {
        if (ch === "(") d++;
        else if (ch === ")") d--;
        if (ch === "," && d === 0) { parts.push(cur); cur = ""; continue; }
        cur += ch;
      }
      if (cur.trim()) parts.push(cur);

      // R14-H-7: accept both Postgres cast forms, plus strip named-arg
      // prefix (`p_foo => $1::text`). Previously only matched trailing
      // `::type` — a call site using `CAST($1 AS uuid)` would have been
      // treated as a wildcard, masking the exact R13-C-1 shape.
      const callTypes = parts.map((p) => {
        // Strip named-arg prefix: `p_foo => ...`
        const stripped = p.replace(/^\s*[a-z_][a-z0-9_]*\s*=>\s*/i, "");
        // Prefer trailing `::type` (most common).
        const postfix = stripped.match(/::\s*([a-z_][a-z0-9_ ]*(?:\[\])?)\s*$/i);
        if (postfix) return normalizeType(postfix[1]);
        // Otherwise try `CAST(... AS type)`.
        const castForm = stripped.match(/CAST\s*\([^()]*AS\s+([a-z_][a-z0-9_ ]*(?:\[\])?)\s*\)/i);
        if (castForm) return normalizeType(castForm[1]);
        return null;
      });

      // If no casts at all, we can't prove signature — skip (most call sites
      // in TS use casts because pg needs the hint for uuid/jsonb).
      if (callTypes.every((t) => t === null)) continue;

      // Compare against declared signatures for this function. We accept
      // the call if ANY declared signature matches: same arity AND every
      // position where the call has a cast matches the declared type.
      // (Positions without a cast are wildcards.)
      const declaredSigs = migratedFunctionSigs[fn] ?? new Set();
      let matched = false;
      for (const sig of declaredSigs) {
        const declaredTypes = sig.split(",");
        if (declaredTypes.length < callTypes.length) continue; // declared DEFAULTs absorb missing
        let ok = true;
        for (let k = 0; k < callTypes.length; k++) {
          if (callTypes[k] === null) continue; // wildcard
          if (normalizeType(callTypes[k]) !== declaredTypes[k]) { ok = false; break; }
        }
        if (ok) { matched = true; break; }
      }

      if (!matched && declaredSigs.size > 0) {
        rpcFindings.push({
          file: path.relative(ROOT, file),
          fn,
          kind: "sig-mismatch",
          callSig: callTypes.map((t) => t ?? "?").join(","),
          declared: [...declaredSigs].join(" | "),
          snippet: tpl.replace(/\n/g, " ").slice(0, 160),
          expected: false,
        });
      }
    }

    // Match INSERT INTO <table> (col, col, col). Only flag columns for
    // tables we have a declaration for.
    const insertRx = /\bINSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/gi;
    let im;
    while ((im = insertRx.exec(tpl)) !== null) {
      const [, table, body] = im;
      if (!KNOWN_TABLES.has(table.toLowerCase())) continue;
      const cols = body.split(",").map((s) => s.trim().replace(/["`]/g, ""));
      for (const col of cols) {
        const lower = col.toLowerCase();
        if (!lower || PG_CONTEXT_IDENTS.has(lower)) continue;
        if (!tableCols[table.toLowerCase()].has(lower)) {
          findings.push({
            file: path.relative(ROOT, file),
            table: table.toLowerCase(),
            col: lower,
            snippet: tpl.replace(/\n/g, " ").slice(0, 160),
          });
        }
      }
    }

    // Match UPDATE <table> SET col = ... — flag only on known tables.
    const updateRx = /\bUPDATE\s+(\w+)(?:\s+\w+)?\s+SET\s+([a-z_][a-z0-9_]+)\s*=/gi;
    let um;
    while ((um = updateRx.exec(tpl)) !== null) {
      const [, table, col] = um;
      if (!KNOWN_TABLES.has(table.toLowerCase())) continue;
      const lower = col.toLowerCase();
      if (PG_CONTEXT_IDENTS.has(lower)) continue;
      if (!tableCols[table.toLowerCase()].has(lower)) {
        findings.push({
          file: path.relative(ROOT, file),
          table: table.toLowerCase(),
          col: lower,
          snippet: tpl.replace(/\n/g, " ").slice(0, 160),
        });
      }
    }
  }
}

// Deduplicate
const uniq = new Map();
for (const f of findings) {
  const key = `${f.file}:${f.col}`;
  if (!uniq.has(key)) uniq.set(key, f);
}
const problems = [...uniq.values()];

// Deduplicate RPC findings by (fn name, kind) so a missing RPC and a
// signature mismatch on the same fn both surface. One entry per kind
// per fn — if the same kind fires from multiple files we report the
// first seen location.
const rpcUniq = new Map();
for (const f of rpcFindings) {
  const key = `${f.fn}:${f.kind ?? "missing"}`;
  if (!rpcUniq.has(key)) rpcUniq.set(key, f);
}
const rpcProblems = [...rpcUniq.values()];
const rpcGaps = rpcProblems.filter((p) => p.expected);
const rpcFails = rpcProblems.filter((p) => !p.expected);

// ─── Report ────────────────────────────────────────────────────────────

// RPC gaps we already know about → WARN only. New unexpected RPC drift → FAIL.
if (rpcGaps.length > 0) {
  console.log(`\u26A0  ${rpcGaps.length} RPCs referenced in code but NOT defined in any migration (known gap — tracked in docs/KNOWN_ISSUES.md):`);
  for (const p of rpcGaps) {
    console.log(`     ${p.fn}()  (first seen in ${p.file})`);
  }
  console.log(`   Fresh-DB bootstrap requires these to be codified as migrations.`);
  console.log("");
}

if (rpcFails.length > 0) {
  const missing = rpcFails.filter((p) => (p.kind ?? "missing") === "missing");
  const sigMismatch = rpcFails.filter((p) => p.kind === "sig-mismatch");

  if (missing.length > 0) {
    console.log(`\u2717 ${missing.length} RPCs referenced but NOT defined and NOT on the known-gap list:`);
    for (const p of missing) {
      console.log(`  ${p.file}`);
      console.log(`    ${p.fn}()`);
      console.log(`    snippet: ${p.snippet}...`);
    }
    console.log(`\nAdd a migration that defines these RPCs, or add to RPC_KNOWN_GAPS in scripts/check-schema-drift-ci.mjs.`);
  }

  if (sigMismatch.length > 0) {
    console.log(`\u2717 ${sigMismatch.length} RPC call sites whose argument casts do NOT match any declared signature (R13-C-1 shape):`);
    for (const p of sigMismatch) {
      console.log(`  ${p.file}`);
      console.log(`    ${p.fn}(${p.callSig})`);
      console.log(`    declared: ${p.declared}`);
      console.log(`    snippet:  ${p.snippet}...`);
    }
    console.log(`\nEither change the cast types to match the declared signature, or add a new overload in a migration.`);
  }
}

if (problems.length === 0 && rpcFails.length === 0) {
  console.log(`\u2713 Schema drift check passed (${ALL_COLUMNS.size} columns across ${Object.keys(tableCols).length} tables, ${migratedFunctions.size} functions, ${walk(SRC_DIR).length} source files)`);
  process.exit(0);
}

if (problems.length > 0) {
  console.log(`\u2717 ${problems.length} unknown column references:`);
  for (const p of problems) {
    console.log(`  ${p.file}`);
    console.log(`    ${p.table}.${p.col}  (not in any migration)`);
    console.log(`    snippet: ${p.snippet}...`);
  }
  console.log(`\nAdd a migration that creates the missing columns, or fix the code to match the schema.`);
}
process.exit(1);
