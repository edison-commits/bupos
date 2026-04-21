#!/usr/bin/env node
/**
 * R26-F1 + R27: multi-tenant isolation depends ENTIRELY on every raw
 * SQL site including an explicit `WHERE organization_id = $N`
 * predicate (or joining through an already-tenant-scoped table).
 *
 * Background: the `postgres` role on Supabase is BYPASSRLS.
 * RLS + FORCE RLS are cosmetic at the app's real connection layer.
 * The only thing between tenant A and tenant B is the WHERE clause
 * the app writes.
 *
 * R27 widened the coverage from `pool.query` / `client.query` to
 * ALSO include `orgQuery(orgId, \`...\`, ...)` — the supabase-rest
 * helper wraps a per-call Neon pool + `SET LOCAL app.current_org_id`,
 * which is equally cosmetic under BYPASSRLS. The R27 audit found 12
 * CRITICAL cross-tenant bugs in orgQuery-using routes that were
 * invisible to the previous allowlist-based guardrail.
 *
 * This guardrail now scans EVERY file under src/app/api/**,
 * src/app/admin/** (-*-actions.ts), src/app/register/** (-*-action.ts),
 * src/lib/persistence/**, and a handful of other touched sites,
 * looking for backtick-string SQL passed to:
 *   • `.query(` (pool / client)
 *   • `orgQuery(` (supabase-rest wrapper)
 *
 * It flags any SQL that:
 *   • queries an org-scoped table (products, customers, transactions, etc.),
 *   • AND does not reference `organization_id` in the query text,
 *   • AND does not invoke a SECDEF function (SECDEF functions
 *     enforce their own scoping internally).
 *
 * Heuristic, not a parser — false positives are possible and can be
 * suppressed with a `// check-pool-org-filter: scoped-by-<reason>`
 * comment on the query line or immediately above.
 *
 * Self-test: synthesizes a good/bad snippet and asserts the detector
 * flags the bad one, exits 2 if the detector is broken.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

// Tables that are org-scoped (have an organization_id column). If a
// SELECT/UPDATE/DELETE/INSERT references any of these, the query
// MUST include `organization_id` somewhere. Derived from migration
// 001 declarations.
const ORG_SCOPED_TABLES = new Set([
  "organizations", "locations", "employees", "categories", "modifier_groups",
  "modifiers", "products", "product_variants", "inventory_levels",
  "customers", "audit_events", "gift_cards", "store_credit_ledger",
  "behavior_flags", "layaways", "stocktakes", "transfers",
  "time_clock_entries", "promo_codes", "returns", "transactions",
  "pay_in_outs", "auth_credentials", "sessions", "register_sessions",
  "shifts", "product_bundles", "bundle_items", "pending_signups",
  "suppliers", "purchase_orders", "purchase_order_lines", "expenses",
  "scheduled_shifts", "time_off_requests", "customer_display_state",
]);

// Child tables whose tenancy derives from an FK — can satisfy the
// check by joining through the parent. For these tables, accept
// `WHERE parent_col IN/= ... organization_id = $N` patterns OR an
// explicit JOIN to an org-scoped table with `organization_id = $`.
const FK_SCOPED_TABLES = new Set([
  "transaction_tenders", "transaction_events", "transaction_exceptions",
  "transaction_lines", "return_lines", "transfer_lines",
  "layaway_payments", "gift_card_transactions", "inventory_adjustments",
  "promo_redemptions", "product_modifier_groups",
  "register_session_exceptions", "stocktake_lines",
]);

// SECDEF function names — if the SQL is `SELECT <fn>(...)` or
// `SELECT * FROM <fn>(...)`, scoping is internal and we skip.
const SECDEF_FN_RX =
  /\bSELECT\s+(?:\*\s+FROM\s+)?(?:find_session|get_full_store|admin_login_lookup|admin_login_create_session|register_pin_candidates|register_login_create_session|register_sign_out|register_open_shift|register_close_shift|register_insert_audit|register_quick_switch|register_check_open_shift|register_insert_exception|get_default_active_location|resolve_register_session|rate_limit_check|cleanup_stale_idempotency_keys|cleanup_stale_pending_signups|cleanup_stale_rate_limit_buckets|org_rest_query|org_rest_tx)\s*\(/i;

// Quick heuristic suppression marker.
const SUPPRESS_MARKER = /check-pool-org-filter:\s*scoped-by-/;

// Directories to scan. Any .ts file under these trees that contains
// a `.query(` or `orgQuery(` call will be checked. The ALLOWLIST
// shape was dropped in R27 — it let 12 CRITICAL cross-tenant bugs
// slip through because the affected files weren't on the list.
// R28-L7: include src/lib/auth so session.ts's pgClient.query sites
// are scanned. `session.ts` has `SELECT * FROM employees WHERE id = $1
// AND is_active = true` — the `id` came from a just-verified session
// cookie, so it's scope-bound, but the guardrail should either see
// a suppression comment OR an explicit org filter. Without this scan
// path, a future edit that adds a NEW query in session.ts with a
// missing org filter would ship silently.
const SCAN_DIRS = [
  "src/app/api",
  "src/app/admin",
  "src/app/register",
  "src/lib/persistence",
  "src/lib/auth",
];

// Additional explicit files (not under the scan dirs but still
// produce SQL).
const EXTRA_FILES = [
  "src/app/actions/auth.ts",
  "src/app/actions/register.ts",
  "src/lib/supabase-rest.ts",
  "src/lib/db/index.ts",
];

/**
 * Walk a directory recursively and return every .ts file path
 * relative to the repo root.
 */
function walkTs(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    const absD = path.join(ROOT, d);
    if (!fs.existsSync(absD)) continue;
    for (const entry of fs.readdirSync(absD, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = path.join(d, entry.name);
      if (entry.isDirectory()) {
        stack.push(rel);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
        out.push(rel);
      }
    }
  }
  return out;
}

/**
 * Extract every SQL-carrying call's body. Matches both:
 *   • `.query(` / `.connect(` — pool / client calls
 *   • `orgQuery(orgId, \`...\`, ...)` — supabase-rest wrapper
 *
 * Both forms use backtick-literal SQL in this codebase.
 */
function extractQueries(src) {
  const out = [];

  // .query( / .connect( — the SQL is the FIRST string-literal
  // argument. R30-C3: match ALL three quote styles (backtick,
  // single-quote, double-quote). The prior shape only matched
  // backticks, so any `.query('SELECT ... FROM <org-scoped-table>')`
  // was invisible to the guardrail — found 5 live sites in
  // src/lib/persistence/postgres-store.ts that relied on this blind
  // spot. Single/double-quoted strings don't support JS interpolation,
  // so no escape complexity for `${...}` is needed.
  const rx1 = /\.(query|connect)\s*\(\s*(`[^`]+`|'[^'\n]+'|"[^"\n]+")/g;
  let m;
  while ((m = rx1.exec(src)) !== null) {
    const before = src.slice(0, m.index);
    const line = before.split("\n").length;
    const sqlLit = m[2].slice(1, -1); // strip quote chars
    out.push({ line, sql: sqlLit, start: m.index, kind: "pool" });
  }

  // orgQuery(orgId, `...`) — SQL is the SECOND argument.
  // Permit anything (identifier or expression) as the orgId slot,
  // then a string-literal in any quote style. `orgQuery\b` to avoid
  // matching other identifiers ending in orgQuery.
  const rx2 = /\borgQuery\s*\(\s*[^,()`'"]+\s*,\s*(`[^`]+`|'[^'\n]+'|"[^"\n]+")/g;
  while ((m = rx2.exec(src)) !== null) {
    const before = src.slice(0, m.index);
    const line = before.split("\n").length;
    const sqlLit = m[1].slice(1, -1);
    out.push({ line, sql: sqlLit, start: m.index, kind: "orgQuery" });
  }

  return out;
}

function hasSuppressionNear(src, start) {
  // Look 400 chars back for the marker (same line or a comment just
  // above the query).
  const window = src.slice(Math.max(0, start - 400), start);
  return SUPPRESS_MARKER.test(window);
}

function tablesReferenced(sql) {
  const refs = new Set();
  const rx = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = rx.exec(sql)) !== null) {
    refs.add(m[1].toLowerCase());
  }
  return refs;
}

function checkQuery(sql) {
  // Empty / schema-only / constant queries pass.
  if (!sql.trim()) return { ok: true };
  if (/^\s*SELECT\s+(?:1|now\(\))\b/i.test(sql.trim())) return { ok: true };
  if (/^\s*BEGIN\b/i.test(sql.trim()) || /^\s*COMMIT\b/i.test(sql.trim()) || /^\s*ROLLBACK\b/i.test(sql.trim())) return { ok: true };
  if (/^\s*SET\s+LOCAL\b/i.test(sql.trim()) || /^\s*SELECT\s+set_config/i.test(sql.trim())) return { ok: true };
  if (/^\s*SELECT\s+pg_advisory/i.test(sql.trim())) return { ok: true };
  if (/^\s*SAVEPOINT\b/i.test(sql.trim()) || /^\s*RELEASE\s+SAVEPOINT\b/i.test(sql.trim())) return { ok: true };

  // SECDEF function call: scoping internal.
  if (SECDEF_FN_RX.test(sql)) return { ok: true };

  const tables = tablesReferenced(sql);
  const orgScoped = [...tables].filter((t) => ORG_SCOPED_TABLES.has(t) || FK_SCOPED_TABLES.has(t));
  if (orgScoped.length === 0) return { ok: true };

  // R28-H1: must reference organization_id in a PREDICATE position
  // (SELECT/UPDATE/DELETE) OR as a VALUES column (INSERT). The prior
  // check matched any `organization_id` anywhere in the SQL — a
  // SELECT that returns `organization_id` as a result column (for
  // display) trivially satisfied the check without actually filtering.
  // This is how `GET /api/bundles` escaped the R27 sweep despite
  // listing `organization_id` in the SELECT list.
  //
  // Accept predicates: `organization_id = $N`, `organization_id IN
  // (...)`, `organization_id = ANY(...)`. ON-clause mentions also
  // count. Allow both bare and alias-prefixed forms.
  // R30-C3: also accept `$${expr}` template-expression param slots
  // produced by code that dynamically allocates positional params
  // (e.g. `WHERE ... AND organization_id = $${idx + 1}`). Previously
  // these were rejected because `\$\d+` only matched `$5`-style
  // literal digits, not the template-expression form, which hid
  // legit org predicates in every dynamic-UPDATE handler.
  const ORG_PREDICATE_RX =
    /(?:\b(?:\w+\.)?organization_id\s*=\s*(?:\$\d+|\$\$\{[^}]+\}))|(?:\b(?:\w+\.)?organization_id\s+IN\s*\()|(?:\b(?:\w+\.)?organization_id\s*=\s*ANY\s*\()/i;
  if (ORG_PREDICATE_RX.test(sql)) return { ok: true };

  // INSERTs where `organization_id` is in the column list are
  // scoped-by-construction: the value comes from a param the caller
  // supplies (orgId from ctx). Accept `INSERT INTO <tbl> (..., organization_id, ...)`.
  if (
    /^\s*INSERT\s+INTO\s+\w+\s*\([^)]*\borganization_id\b[^)]*\)/i.test(sql.trim())
  ) {
    return { ok: true };
  }

  // Dynamic SQL assembly — `${whereClause}` / `${sets}` / `${fields}`
  // interpolation. We can't see the runtime content.
  // R30-C3: previously auto-passed these as "dynamic, trust the
  // builder" — a hole that actively hid two CRITICAL cross-tenant
  // leaks (customers GET list, purchase_orders PUT). Now requires
  // either an explicit suppression comment OR that the query itself
  // ALSO contains a static `organization_id` predicate outside the
  // interpolation slot (belt + suspenders — the static predicate is
  // always applied regardless of the dynamic clause contents).
  if (/\$\{(?:whereClause|conditions|fields|sets|where)\b/.test(sql)) {
    // Must have a STATIC organization_id predicate baked into the
    // SQL too — e.g. `WHERE organization_id = $1 AND ${whereClause}`
    // or `WHERE ... AND organization_id = $N AND ${sets}`. The
    // predicate regex above already ran and returned false, so
    // reaching this branch means no static predicate was found.
    // Fall through to the FAIL path; require explicit suppression
    // via `// check-pool-org-filter: …` if the query is genuinely
    // scope-safe by some other construction.
  }

  // INSERT INTO organizations — nothing to scope against (it's being
  // created). Similarly, INSERT INTO pending_signups (the pre-org row).
  if (/^\s*INSERT\s+INTO\s+(?:organizations|pending_signups)\b/i.test(sql.trim())) return { ok: true };

  // INSERT INTO child-table (FK_SCOPED) ... VALUES-form where the FK
  // column is immediately parameterized. Scoping is by-construction:
  // the parent id was verified to be in-tenant in a prior step of the
  // same transaction.
  //
  // These rely on the FK itself being a just-verified tenant
  // boundary. Accept when the table is FK_SCOPED and the INSERT
  // mentions its parent FK column.
  const fkMap = {
    transaction_tenders: /\btransaction_id\b/,
    transaction_events: /\btransaction_id\b/,
    transaction_exceptions: /\btransaction_id\b/,
    transaction_lines: /\btransaction_id\b/,
    return_lines: /\breturn_id\b/,
    promo_redemptions: /\btransaction_id\b/,
    gift_card_transactions: /\bgift_card_id\b/,
    layaway_payments: /\blayaway_id\b/,
    inventory_adjustments: /\binventory_level_id\b/,
    product_modifier_groups: /\bproduct_id\b/,
    register_session_exceptions: /\bregister_session_id\b/,
    stocktake_lines: /\bstocktake_id\b/,
    transfer_lines: /\btransfer_id\b/,
    bundle_items: /\bbundle_id\b/,
  };
  const insertMatch = sql.match(/^\s*INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/i);
  if (insertMatch) {
    const tbl = insertMatch[1].toLowerCase();
    const cols = insertMatch[2];
    if (FK_SCOPED_TABLES.has(tbl) && fkMap[tbl]?.test(cols)) return { ok: true };
  }

  // Exception: auth/session tables with id-only predicates that
  // identify a specific session/credential from cryptographic state
  // (a verification token, a session id a cookie proves possession
  // of, etc.). Those are safe because the id is the proof.
  if (
    /pending_signups/i.test(sql) &&
    // R32-D3: column renamed to `verification_token_hash` in
    // migration 062. Match either name so the guardrail still
    // recognises the token-proof-of-ownership scope.
    /verification_token(?:_hash)?\s*=/i.test(sql)
  ) return { ok: true };
  if (
    /\bsessions\b/i.test(sql) &&
    (/\b(id|session_id)\s*=\s*\$/i.test(sql) || /employee_id\s*=\s*\$/i.test(sql))
  ) return { ok: true };
  if (
    /register_sessions/i.test(sql) &&
    /\bid\s*=\s*\$/i.test(sql)
  ) return { ok: true };
  if (
    /auth_credentials/i.test(sql) &&
    (/employee_id\s*=\s*\$/i.test(sql) || /lower\(email\)\s*=\s*lower/i.test(sql) || /\bemail\s*=\s*\$/i.test(sql))
  ) return { ok: true };

  return { ok: false, tables: orgScoped };
}

// ─── Self-test ────────────────────────────────────────────────────────
function selfTest() {
  const good = "`SELECT id FROM products WHERE organization_id = $1`";
  const bad = "`SELECT id FROM products ORDER BY created_at DESC`";
  const goodBundles =
    "`SELECT * FROM bundle_items bi JOIN product_bundles pb ON pb.id = bi.bundle_id WHERE pb.organization_id = $1`";
  const badBundles = "`SELECT * FROM bundle_items ORDER BY created_at`";
  const secdefCall = "`SELECT get_full_store($1::uuid) AS result`";

  // R28-H1: the prior guardrail matched `organization_id` anywhere
  // in the SQL, so a SELECT that returned the column but didn't
  // filter on it trivially passed. Explicit negative case pins the
  // fix — a column-list-only mention must fail.
  const columnListOnly =
    "`SELECT id, organization_id, name FROM product_bundles ORDER BY created_at`";
  const inClause =
    "`SELECT id FROM products WHERE organization_id IN ($1, $2)`";
  const aliasedPredicate =
    "`SELECT p.id FROM products p WHERE p.organization_id = $1`";
  const anyPredicate =
    "`SELECT id FROM products WHERE organization_id = ANY($1::uuid[])`";

  const checks = [
    [good.slice(1, -1), true, "explicit org_id filter should pass"],
    [bad.slice(1, -1), false, "bare SELECT without org_id should fail"],
    [goodBundles.slice(1, -1), true, "JOIN to org-scoped parent with org_id should pass"],
    [badBundles.slice(1, -1), false, "bare bundle_items without org_id should fail"],
    [secdefCall.slice(1, -1), true, "SECDEF function call should pass"],
    [columnListOnly.slice(1, -1), false, "column-list mention of organization_id without predicate should FAIL"],
    [inClause.slice(1, -1), true, "IN (...) predicate should pass"],
    [aliasedPredicate.slice(1, -1), true, "aliased `p.organization_id = $1` predicate should pass"],
    [anyPredicate.slice(1, -1), true, "ANY() predicate should pass"],
  ];
  const fails = [];
  for (const [sql, expectOk, label] of checks) {
    const got = checkQuery(sql).ok;
    if (got !== expectOk) fails.push(`${label} (got ok=${got})`);
  }

  // R27 extension: confirm orgQuery extraction fires.
  const orgQuerySrc =
    "orgQuery(orgId, `SELECT * FROM products WHERE organization_id = $1`, [orgId])";
  const extracted = extractQueries(orgQuerySrc);
  if (extracted.length !== 1 || extracted[0].kind !== "orgQuery") {
    fails.push("orgQuery extractor should find exactly 1 orgQuery call");
  }
  const orgQueryBadSrc =
    "orgQuery(orgId, `SELECT * FROM products ORDER BY name`, [])";
  const extractedBad = extractQueries(orgQueryBadSrc);
  if (extractedBad.length !== 1 || checkQuery(extractedBad[0].sql).ok !== false) {
    fails.push("orgQuery extractor + checker should flag missing org filter");
  }

  if (fails.length > 0) {
    console.error("\n✗ check-pool-query-org-filter self-test FAILED:\n");
    for (const f of fails) console.error(`  ${f}`);
    console.error("\nThe detector is broken; fix before merging.\n");
    process.exit(2);
  }
}

selfTest();

// Build the scan set: walk every SCAN_DIR + add EXTRA_FILES.
const scanSet = new Set();
for (const dir of SCAN_DIRS) {
  for (const f of walkTs(dir)) scanSet.add(f);
}
for (const f of EXTRA_FILES) scanSet.add(f);

const findings = [];
for (const rel of scanSet) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, "utf8");
  for (const { line, sql, start, kind } of extractQueries(src)) {
    if (hasSuppressionNear(src, start)) continue;
    const result = checkQuery(sql);
    if (!result.ok) {
      findings.push({
        file: rel,
        line,
        kind,
        tables: result.tables.join(", "),
        preview: sql.replace(/\s+/g, " ").slice(0, 120),
      });
    }
  }
}

if (findings.length > 0) {
  console.error(
    `\n✗ ${findings.length} SQL site(s) touch org-scoped tables without an organization_id filter:\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.kind}]  (tables: ${f.tables})`);
    console.error(`    ${f.preview}`);
  }
  console.error(
    `\nPostgres's postgres role has BYPASSRLS — RLS + FORCE RLS are not\nthe tenant-isolation layer. Every raw SQL call MUST include an\nexplicit \`WHERE organization_id = $N\` (or join through an\norg-scoped parent).\n` +
    `If this query is genuinely scope-free (auth lookup, infra probe),\n` +
    `add a \`// check-pool-org-filter: scoped-by-<reason>\` comment just\n` +
    `above the query.\n`,
  );
  process.exit(1);
}

console.log(`✓ all ${scanSet.size} scanned files have org filters or SECDEF scoping`);
