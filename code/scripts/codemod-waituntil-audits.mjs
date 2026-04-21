#!/usr/bin/env node
/**
 * R24-M-6 codemod: wrap fire-and-forget `pgInsertAuditEvent(...).catch(...)`
 * calls with `waitUntilOrAwait(...)` so the audit write isn't silently
 * cancelled by Workers' `no_handle_cross_request_promise_resolution`
 * compat flag when the handler returns.
 *
 * Transformation:
 *   pgInsertAuditEvent(...).catch((err) => console.error("...", safeErr(err)));
 * →
 *   await waitUntilOrAwait(pgInsertAuditEvent(...).catch((err) =>
 *     console.error("...", safeErr(err))));
 *
 * Safety:
 * - Matches only call sites with a chained `.catch(...)` — these are
 *   the fire-and-forget shape. `await pgInsertAuditEvent(...)` calls
 *   (no .catch) are left alone.
 * - Adds the waitUntilOrAwait import if missing.
 * - Idempotent: if the call is ALREADY wrapped in waitUntilOrAwait,
 *   the codemod skips it.
 *
 * Scope: `src/app/**` only (server actions + API routes). Keeps
 * pure-lib files out of scope since they don't live inside a Workers
 * request context.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const SCOPES = ["src/app"];

let filesChanged = 0;
let sitesChanged = 0;

function walk(abs) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
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
  if (!/pgInsertAuditEvent\s*\(/.test(src)) return;
  if (!/\.catch\s*\(/.test(src)) return;

  let out = src;
  let localCount = 0;

  // Balanced-paren walker: find each `pgInsertAuditEvent(` call,
  // extend past the chained `.catch(...)`, wrap the whole
  // `pgInsertAuditEvent(...).catch(...)` expression in
  // `await waitUntilOrAwait(` + `)`.
  //
  // We also handle the cases where the expression is on a statement
  // line (`pgInsertAuditEvent(...).catch(...);`) — indicated by
  // being prefixed by whitespace-only to the start of the line.
  let searchFrom = 0;
  while (true) {
    const idx = out.indexOf("pgInsertAuditEvent(", searchFrom);
    if (idx === -1) break;
    searchFrom = idx + 1;

    // Is this call already wrapped? Skip if preceded by
    // `waitUntilOrAwait(`.
    const before = out.slice(Math.max(0, idx - 30), idx);
    if (/waitUntilOrAwait\s*\(\s*$/.test(before)) continue;
    // Only match STATEMENT-position calls: the token preceding the
    // call must be whitespace or `;` or `{`. `await` prefix OR any
    // assignment / inline-expression context means the caller is
    // already handling the promise — leave it alone.
    if (!/(^|[\n\r;{])\s*$/.test(before)) continue;

    // Find the matching close paren for pgInsertAuditEvent(
    const openParen = idx + "pgInsertAuditEvent".length;
    const callEnd = findMatchingParen(out, openParen);
    if (callEnd === -1) continue;

    // Expect `.catch(` next, possibly with whitespace.
    let p = callEnd + 1;
    while (p < out.length && /\s/.test(out[p])) p++;
    if (!out.startsWith(".catch(", p)) continue;
    const catchOpen = p + ".catch".length;
    const catchEnd = findMatchingParen(out, catchOpen);
    if (catchEnd === -1) continue;

    // Swap:
    //   pgInsertAuditEvent(...).catch(...)
    // →
    //   await waitUntilOrAwait(pgInsertAuditEvent(...).catch(...))
    const original = out.slice(idx, catchEnd + 1);
    const replacement = `await waitUntilOrAwait(${original})`;
    out = out.slice(0, idx) + replacement + out.slice(catchEnd + 1);
    searchFrom = idx + replacement.length;
    localCount++;
  }

  if (localCount === 0) return;

  // Ensure waitUntilOrAwait import exists.
  if (!/from\s+["']@\/lib\/runtime\/wait-until["']/.test(out)) {
    const importRx = /^import[^;]+from\s+["'][^"']+["'];?\s*$/gm;
    let lastImportEnd = 0;
    let m;
    while ((m = importRx.exec(out)) !== null) {
      lastImportEnd = m.index + m[0].length;
    }
    const importLine = `\nimport { waitUntilOrAwait } from "@/lib/runtime/wait-until";`;
    if (lastImportEnd > 0) {
      out = out.slice(0, lastImportEnd) + importLine + out.slice(lastImportEnd);
    } else {
      out = `${importLine.trimStart()}\n${out}`;
    }
  }

  fs.writeFileSync(abs, out, "utf8");
  filesChanged++;
  sitesChanged += localCount;
  console.log(`  ${rel}  (${localCount} site${localCount > 1 ? "s" : ""})`);
}

function findMatchingParen(src, openIdx) {
  if (src[openIdx] !== "(") return -1;
  let depth = 0;
  let inStr = null;
  let escape = false;
  let templateDepth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === "\\") { escape = true; continue; }
      if (inStr === "`" && ch === "$" && src[i + 1] === "{") {
        templateDepth++; i++; continue;
      }
      if (templateDepth > 0 && ch === "}") { templateDepth--; continue; }
      if (ch === inStr && templateDepth === 0) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") { depth++; continue; }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && ch === ")") return i;
      continue;
    }
  }
  return -1;
}

console.log("R24-M-6 codemod — wrap fire-and-forget pgInsertAuditEvent with waitUntilOrAwait:");
for (const scope of SCOPES) {
  const abs = path.join(ROOT, scope);
  if (fs.existsSync(abs)) walk(abs);
}
console.log(
  `\nDone: ${sitesChanged} site${sitesChanged === 1 ? "" : "s"} rewritten across ${filesChanged} file${filesChanged === 1 ? "" : "s"}.`,
);
