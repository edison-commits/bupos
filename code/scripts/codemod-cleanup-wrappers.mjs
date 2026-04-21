#!/usr/bin/env node
/**
 * Follow-up cleanup — remove redundant backtick wrappers left by the main
 * codemod: `${formatCurrency(x)}` as a whole template string is just
 * `formatCurrency(x)`.
 *
 *   `${formatCurrency(x)}` → formatCurrency(x)
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/edison/Desktop/bupos/code";
const TARGETS = ["src/app/admin", "src/components/admin"];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && (full.endsWith(".tsx") || full.endsWith(".ts"))) out.push(full);
  }
  return out;
}

const files = TARGETS.flatMap((d) => walk(path.join(ROOT, d)));
let total = 0;
const changed = [];
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  // Match `${formatCurrency(expr)}` (entire template has exactly one interpolation)
  // Use a lazy expression match to avoid nested braces. formatCurrency calls
  // can have a second arg — so allow arg list with optional nested parens.
  let c = 0;
  const out = src.replace(
    /`\$\{formatCurrency\(([^`]+?)\)\}`/g,
    (_m, args) => { c++; return `formatCurrency(${args})`; },
  );
  if (c > 0) {
    fs.writeFileSync(file, out);
    total += c;
    changed.push({ file: path.relative(ROOT, file), c });
  }
}
console.log(`${total} redundant wrappers removed across ${changed.length} files`);
for (const f of changed) console.log(`  ${f.c}x  ${f.file}`);
