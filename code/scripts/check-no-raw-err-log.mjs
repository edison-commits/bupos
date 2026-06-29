#!/usr/bin/env node
/**
 * R21-H-2 / R22-L-1 / R23-C-1 / R23-L-1 guardrail: fail CI if any
 * `console.error(label, err)` / `console.warn(label, err)` /
 * `logger.error(label, err)` / `log.warn(label, err)` site slips in
 * without `safeErr(err)`.
 *
 * Logs that include raw pg errors leak query text, bound parameters
 * (customer emails, session IDs, password_hash fragments on orm
 * round-trips), and full stack traces into Worker log retention.
 *
 * Allowed patterns:
 *   console.error("label", safeErr(err))
 *   console.error("label", { ..., error: safeErr(err) })
 *   logger.warn("label", safeErr(err))
 *
 * Disallowed patterns:
 *   console.error("label", err)
 *   logger.error("label", error)
 *   log.error("label", e)
 *   console.error(`label ${fn(x)}`, err)
 *   console.error("label", { error: err })
 *   console.error("label", err as Error)           ← R23-L-1: type assertion
 *   console.error("label", err!)                    ← R23-L-1: non-null assertion
 *   console.error("label", (err))                   ← R23-L-1: parenthesized
 *   console.error("label", { err })                 ← R23-L-1: shorthand
 *
 * Implementation (R22-L-1): regex-based scanning breaks on first-args
 * containing parens (template literals with embedded calls). We scan
 * with a minimal balanced-paren walker instead.
 *
 * R23-C-1: the walker originally started at `i = start` pointing AT
 * the `(`, which double-counted the opening paren and caused the
 * function to return null for every call. The parser flagged ZERO
 * sites until this fix landed. A self-test at the top of the script
 * now asserts the parser behaves correctly BEFORE the real check
 * runs — this protects against future silent regressions.
 *
 * Exemptions: this script itself, and anything in `src/__tests__`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const SCOPES = ["src/app", "src/lib", "src/components"];
const SKIP_DIRS = new Set(["__tests__", "node_modules", ".next"]);

// Call sites we want to check. R22-L-1: broadened past `console.*` so
// a future structured logger (pino / winston / custom `@/lib/logger`)
// is covered out of the gate.
const CALL_PREFIXES = [
  "console.error",
  "console.warn",
  "logger.error",
  "logger.warn",
  "log.error",
  "log.warn",
];

// R24-L-2: single source of truth for catch-binding names so the
// full-ident regex and the object-shorthand regex can't drift out of
// sync. Add new names here, both regexes pick them up automatically.
// Also includes a generic `[a-z]+(?:Err|Error)$` fallback so a
// future `transferErr`, `verifyErr`, etc. is caught without an edit.
const CATCH_IDENT_NAMES = [
  "err", "error", "e", "cause",
  // Repo-specific conventions observed across audit rounds R19-R24.
  "auditErr", "preReadError", "emailErr", "insertErr", "regErr",
  "dbErr", "kvErr", "resErr", "cleanupErr", "credErr", "sessionErr",
  "txErr", "emailError",
];
const CATCH_IDENT_NAMES_ALT = CATCH_IDENT_NAMES.map((n) =>
  n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
).join("|");
// Full-ident match: ENTIRE string must be one of our names OR match
// the generic `somethingErr` / `somethingError` trailing pattern.
const CATCH_IDENT_RX = new RegExp(
  `^(?:${CATCH_IDENT_NAMES_ALT}|[a-zA-Z][a-zA-Z0-9_$]*(?:Err|Error))$`,
);

/**
 * Walk forward from `start` (pointing at the `(` of a call) and return
 * the index of the matching `)` along with the text of the last
 * argument (split on the top-level comma preceding the `)`).
 *
 * Returns `null` if the source is truncated mid-call (unterminated
 * string / paren).
 *
 * R23-C-1: loop starts at `i = start + 1` to skip the outer `(`. The
 * original `i = start` double-counted it, so `depth` never reached 0
 * at the matching `)` and the function returned null for every call.
 */
function parseCall(src, start) {
  if (src[start] !== "(") return null;
  let depth = 0;
  let inStr = null; // '"' | "'" | '`' | null
  let escape = false;
  let templateDepth = 0; // for ${...} inside template literals
  const argStarts = [start + 1];
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (inStr === "`" && ch === "$" && src[i + 1] === "{") {
        templateDepth++;
        i++;
        continue;
      }
      if (templateDepth > 0 && ch === "}") {
        templateDepth--;
        continue;
      }
      if (ch === inStr && templateDepth === 0) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      // line comment — skip to EOL
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    // R23-C-1 follow-up: track brace + bracket depth too, so commas
    // inside `{...}` or `[...]` don't register as top-level arg
    // separators. Without this, `console.error("x", { a:1, b:2 })`
    // parses as a three-arg call and the last-arg extraction yields
    // "b:2" instead of the full object literal.
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) {
        argStarts.push(i);
        return { endIdx: i, argStarts };
      }
      depth--;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (depth > 0) depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      argStarts.push(i + 1);
      continue;
    }
  }
  return null;
}

/**
 * R23-L-1: normalize a TS/JS expression to check whether it's a bare
 * catch-identifier underneath. Strips:
 *   - surrounding whitespace
 *   - trailing commas
 *   - surrounding parentheses (unwrap recursively)
 *   - trailing `!` non-null assertion
 *   - ` as TypeExpression` (type assertion)
 *   - ` satisfies TypeExpression`
 * Returns the normalized text (still possibly not a plain ident, but
 * ready for regex test).
 */
function normalizeExprForIdent(text) {
  let s = text.trim().replace(/,+\s*$/, "").trim();
  // Unwrap parens: `(err)` → `err`. Repeat for `((err))`.
  while (s.startsWith("(") && s.endsWith(")")) {
    const inner = s.slice(1, -1).trim();
    // Only unwrap if parens are balanced within inner.
    let depth = 0;
    let ok = true;
    for (const ch of inner) {
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth < 0) { ok = false; break; } }
    }
    if (!ok || depth !== 0) break;
    s = inner;
  }
  // Strip trailing !
  while (s.endsWith("!")) s = s.slice(0, -1).trim();
  // Strip ` as Type` — Type can contain spaces, generics, or `|`.
  s = s.replace(/\s+as\s+[A-Za-z_$][\w$<>|&.[\]\s"',]*$/, "").trim();
  s = s.replace(/\s+satisfies\s+[A-Za-z_$][\w$<>|&.[\]\s"',]*$/, "").trim();
  // One more unwrap in case `(err as Error)` → strip `as Error` → `(err)` → unwrap.
  while (s.startsWith("(") && s.endsWith(")")) {
    const inner = s.slice(1, -1).trim();
    let depth = 0;
    let ok = true;
    for (const ch of inner) {
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth < 0) { ok = false; break; } }
    }
    if (!ok || depth !== 0) break;
    s = inner;
  }
  return s;
}

function isCatchIdent(text) {
  const normalized = normalizeExprForIdent(text);
  return CATCH_IDENT_RX.test(normalized);
}

function objectHasRawErrorField(argText) {
  // Detect `{ error: err }` or `{ error: err, ... }` or `{ cause: err }`
  // where the value is a bare catch-ident, NOT wrapped in safeErr/ etc.
  const rxColon = /\b(error|cause|err):\s*([^,}]+?)(\s*[,}])/g;
  let m;
  while ((m = rxColon.exec(argText)) !== null) {
    const rhs = m[2].trim();
    if (/\bsafeErr\s*\(/.test(rhs)) continue;
    if (isCatchIdent(rhs)) return true;
  }
  // R23-L-1 + R24-L-2: shorthand property `{ err }` / `{ err, more }`.
  // Built from the same CATCH_IDENT_NAMES + trailing-Err/Error fallback
  // as CATCH_IDENT_RX so we can't drift.
  const rxShort = new RegExp(
    `[{,]\\s*(?:${CATCH_IDENT_NAMES_ALT}|[a-zA-Z][a-zA-Z0-9_$]*(?:Err|Error))\\s*[,}]`,
    "g",
  );
  while (rxShort.exec(argText) !== null) {
    return true;
  }
  return false;
}

/**
 * R23-C-1 follow-up: scanning for call prefixes via `indexOf` also
 * matches text inside comments ("// future console.error(err) edits
 * could …") and strings. A proper scan needs to skip those ranges.
 * One-pass walker that tracks string / template / comment state and
 * only emits match candidates in executable code.
 */
function collectOffendersFromText(src, rel) {
  const offenders = [];
  const lines = src.split("\n");
  let inStr = null;
  let escape = false;
  let templateDepth = 0;
  for (let i = 0; i < src.length; i++) {
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
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i + 1 < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    // At this point we're in executable code. Check for any call prefix.
    for (const prefix of CALL_PREFIXES) {
      if (!src.startsWith(prefix, i)) continue;
      // Require word boundary before the prefix.
      const charBefore = i > 0 ? src[i - 1] : "";
      if (/[A-Za-z0-9_$]/.test(charBefore)) continue;
      // Require an opening `(` immediately after, allowing for whitespace.
      let p = i + prefix.length;
      while (p < src.length && /\s/.test(src[p])) p++;
      if (src[p] !== "(") continue;

      const parsed = parseCall(src, p);
      if (!parsed) break;
      // parseCall's argStarts has `[afterOpenParen, afterEachComma..., atCloseParen]`.
      // A single-arg call has length 2 (empty call has none — but an
      // empty call couldn't reach here either). We want to detect
      // BOTH single-arg (bare `console.error(err)`) and multi-arg
      // (`console.error("label", err)`) so any length >= 2 is in-scope.
      if (parsed.argStarts.length < 2) break;

      const lastStart = parsed.argStarts[parsed.argStarts.length - 2];
      const lastEnd = parsed.argStarts[parsed.argStarts.length - 1];
      const lastArg = src.slice(lastStart, lastEnd).trim().replace(/\s+/g, " ");

      const normalized = normalizeExprForIdent(lastArg);
      if (normalized.startsWith("safeErr(") || normalized.startsWith("safeErr (")) {
        i = parsed.endIdx;
        break;
      }

      let flagged = false;
      if (isCatchIdent(lastArg)) flagged = true;
      else if (lastArg.startsWith("{") && lastArg.endsWith("}") && objectHasRawErrorField(lastArg)) flagged = true;

      if (flagged) {
        const lineNo = src.slice(0, i).split("\n").length;
        offenders.push({
          file: rel,
          line: lineNo,
          match: lines[lineNo - 1]?.trim?.() ?? `${prefix}(...)`,
        });
      }
      // Skip forward past this call to avoid re-detection.
      i = parsed.endIdx;
      break;
    }
  }
  return offenders;
}

// ─────────────────────────────────────────────────────────────────────
// R23-C-1 self-test: assert the parser catches representative bad
// patterns and skips representative good ones, BEFORE the real check
// runs. If these assertions fail, the guardrail is broken and exits 2
// (distinct from 1, which means "real offenders found") so CI can
// distinguish the two cases.
// ─────────────────────────────────────────────────────────────────────
function selfTest() {
  const MUST_FLAG = [
    `console.error("x", err);`,
    `console.error('x', error);`,
    `console.warn("x", e);`,
    `logger.error("x", err);`,
    `log.error("x", auditErr);`,
    // Template literal first-arg containing call (R22-L-1 motivating case):
    "console.error(`failed ${String(1)}`, err);",
    // TS patterns (R23-L-1):
    `console.error("x", err as Error);`,
    `console.error("x", err!);`,
    `console.error("x", (err));`,
    `console.error("x", ((err as Error)));`,
    `console.error("x", err satisfies Error);`,
    // Object literal field:
    `console.error("x", { error: err });`,
    `console.error("x", { cause: err, extra: 1 });`,
    `console.error("x", { err });`,
    // Multi-arg object:
    `console.error("ctx", { op: "foo", error: err });`,
  ];
  const MUST_NOT_FLAG = [
    `console.error("x", safeErr(err));`,
    `console.error("x", { error: safeErr(err) });`,
    `console.error("x", "plain string");`,
    `console.error("x", err.message);`,
    `console.error("x", String(err));`,
    `console.error("x");`,  // single-arg: no error slot
    // Properly wrapped type-cast:
    `console.error("x", safeErr(err as Error));`,
  ];
  const fails = [];
  for (const good of MUST_NOT_FLAG) {
    const offenders = collectOffendersFromText(good + "\n", "selftest");
    if (offenders.length > 0) {
      fails.push(`FALSE POSITIVE on: ${good}`);
    }
  }
  for (const bad of MUST_FLAG) {
    const offenders = collectOffendersFromText(bad + "\n", "selftest");
    if (offenders.length === 0) {
      fails.push(`MISSED: ${bad}`);
    }
  }
  if (fails.length > 0) {
    console.error(`\n✗ check-no-raw-err-log self-test FAILED — guardrail is broken:\n`);
    for (const f of fails) console.error(`  ${f}`);
    console.error(`\nThis means the log-leak guardrail is a no-op. Fix the parser before merging.\n`);
    process.exit(2);
  }
}

function walk(abs) {
  const collected = [];
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (
        entry.isFile() &&
        (full.endsWith(".ts") ||
          full.endsWith(".tsx") ||
          full.endsWith(".mjs") ||
          full.endsWith(".js"))
      ) {
        const rel = path.relative(ROOT, full);
        const src = fs.readFileSync(full, "utf8");
        collected.push(...collectOffendersFromText(src, rel));
      }
    }
  }
  return collected;
}

// Self-test always runs first. If it fails, the script exits 2.
selfTest();

const offenders = [];
for (const scope of SCOPES) {
  const abs = path.join(ROOT, scope);
  if (fs.existsSync(abs)) offenders.push(...walk(abs));
}

if (offenders.length > 0) {
  console.error(
    `\n✗ Found ${offenders.length} raw-err log site(s). Wrap with safeErr():\n`,
  );
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.match}`);
  }
  console.error(
    `\nFix by importing safeErr from "@/lib/logging/safe-err" and wrapping the error argument. Or run:\n  node scripts/codemod-safe-err.mjs\n`,
  );
  process.exit(1);
}

console.log("✓ no raw-err log sites (self-test + scan)");
