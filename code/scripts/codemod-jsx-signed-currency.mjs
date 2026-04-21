#!/usr/bin/env node
/**
 * Follow-up sweep for JSX text patterns the main codemod left behind.
 * These are cases like `$...{variance.toFixed(2)}` inside JSX text where
 * the `$` is immediately followed by an expression container. The base
 * codemod's "prefix must be > or ( or whitespace" guard missed them.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/edison/Desktop/bupos/code";
const TARGETS = [
  "src/components/register",
  "src/components/admin",
  "src/components/layout",
  "src/app/register",
  "src/app/admin",
];

function walk(dir) {
  const out = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.isFile() && (full.endsWith(".tsx") || full.endsWith(".ts"))) out.push(full);
    }
  } catch {}
  return out;
}

function rewrite(line) {
  let changed = 0;
  // Match `$` immediately followed by `{EXPR.toFixed(N)}` in JSX text.
  // The preceding char is NOT already consumed — we accept any char AND
  // preserve it, unlike the "prefix in [>\s(]" rule used by the earlier
  // sweep.
  let out = line.replace(
    /\$\{([^{}]+?)\.toFixed\(2\)\}/g,
    (_m, expr) => { changed++; return `{formatCurrency(${expr.trim()})}`; },
  );
  out = out.replace(
    /\$\{([^{}]+?)\.toFixed\(0\)\}/g,
    (_m, expr) => { changed++; return `{formatCurrency(${expr.trim()}, 'USD', { fractionDigits: 0 })}`; },
  );
  return { out, changed };
}

const files = TARGETS.flatMap((t) => walk(path.join(ROOT, t)));
let total = 0;
const touched = [];
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  let fileChanges = 0;
  for (let i = 0; i < lines.length; i++) {
    // Only process lines that aren't inside a template literal (i.e.
    // don't have an open backtick before the `$`). A heuristic: skip
    // lines that contain backticks AT ALL.
    if (lines[i].includes("`")) continue;
    const r = rewrite(lines[i]);
    if (r.changed > 0) {
      lines[i] = r.out;
      fileChanges += r.changed;
    }
  }
  if (fileChanges > 0) {
    fs.writeFileSync(file, lines.join("\n"));
    total += fileChanges;
    touched.push({ file: path.relative(ROOT, file), count: fileChanges });
  }
}
console.log(`${total} replacements across ${touched.length} files`);
for (const t of touched) console.log(`  ${t.count}x  ${t.file}`);
