#!/usr/bin/env node
/**
 * R19-INFO-2 codemod: replace `console.error("<label>", err)` with
 * `console.error("<label>", safeErr(err))` across API routes and server
 * actions, adding the shared `safeErr` import where missing.
 *
 * Matched patterns (second argument is a bare catch-variable name):
 *   console.error("...", err)     → console.error("...", safeErr(err))
 *   console.error('...', error)   → console.error('...', safeErr(error))
 *   console.error(`...`, e)       → console.error(`...`, safeErr(e))
 *
 * Skips:
 *   - Sites that already wrap with safeErr(...) or any other call expression
 *   - Arguments that are object literals / template-expressions (not a bare
 *     identifier)
 *   - Test / script files (outside src/app)
 *
 * The regex is anchored on `console.error(…, IDENT)` with IDENT ∈ {err,
 * error, e}. Those are the idiomatic catch variable names in this repo;
 * a broader match would risk false positives on legitimate non-catch
 * second arguments.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
// R21-H-2: widened from `src/app/{api,admin,register}` to include the
// shared auth wrapper, persistence helpers, config loaders, and offline
// sync. The R19 codemod only swept route handlers and missed the central
// `src/lib/api/with-auth.ts:166` + `:262` catch-alls, where ALL unhandled
// errors from `withAdminAuth`- and `withDualAuth`-wrapped routes
// converge.
const SCOPES = [
  "src/app/api",
  "src/app/admin",
  "src/app/register",
  "src/app/actions",
  "src/app/signup",
  "src/lib/api",
  "src/lib/auth",
  "src/lib/persistence",
  "src/lib/config",
  "src/lib/offline",
  "src/lib/email",
];

// Match `console.error(FIRST_ARG, IDENT)` where IDENT is a simple identifier.
// First arg can span multiple lines (template / concat), but we lock the
// match to second arg being a bare identifier followed by `)` or `);`.
// Use a non-greedy body match so we stop at the first `,IDENT)` shape.
const CONSOLE_ERR_RX = /console\.error\(([^)]+?),\s*(err|error|e)\s*\)/g;

let filesChanged = 0;
let sitesChanged = 0;

function walk(abs) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      processFile(full);
    }
  }
}

function processFile(abs) {
  const rel = path.relative(ROOT, abs);
  const src = fs.readFileSync(abs, "utf8");

  // Skip if no matches.
  if (!CONSOLE_ERR_RX.test(src)) return;
  CONSOLE_ERR_RX.lastIndex = 0;

  let out = src;
  let localCount = 0;
  out = out.replace(CONSOLE_ERR_RX, (_, firstArg, ident) => {
    // Skip sites where firstArg itself already wraps with safeErr (unlikely,
    // but defensive — they'd have a `safeErr(...)` substring).
    if (/\bsafeErr\s*\(/.test(firstArg)) return `console.error(${firstArg}, ${ident})`;
    localCount++;
    return `console.error(${firstArg}, safeErr(${ident}))`;
  });

  if (localCount === 0) return;

  // Ensure the safeErr import is present.
  if (!/from\s+["']@\/lib\/logging\/safe-err["']/.test(out)) {
    // Insert after the last existing `import ... from "..."` statement.
    const importRx = /^import[^;]+from\s+["'][^"']+["'];?\s*$/gm;
    let lastImportEnd = 0;
    let m;
    while ((m = importRx.exec(out)) !== null) {
      lastImportEnd = m.index + m[0].length;
    }
    const importLine = `\nimport { safeErr } from "@/lib/logging/safe-err";`;
    if (lastImportEnd > 0) {
      out = out.slice(0, lastImportEnd) + importLine + out.slice(lastImportEnd);
    } else {
      // No imports at all — prepend.
      out = `${importLine.trimStart()}\n${out}`;
    }
  }

  fs.writeFileSync(abs, out, "utf8");
  filesChanged++;
  sitesChanged += localCount;
  console.log(`  ${rel}  (${localCount} site${localCount > 1 ? "s" : ""})`);
}

console.log("safeErr codemod — rewriting console.error(label, err) sites:");
for (const scope of SCOPES) {
  const abs = path.join(ROOT, scope);
  if (fs.existsSync(abs)) walk(abs);
}

console.log(`\nDone: ${sitesChanged} site${sitesChanged === 1 ? "" : "s"} rewritten across ${filesChanged} file${filesChanged === 1 ? "" : "s"}.`);
