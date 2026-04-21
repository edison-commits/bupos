#!/usr/bin/env node
/**
 * Sweep admin pages + components, replace hand-rolled `$X.toFixed(2)` with
 * `formatCurrency(X)`. Preserves CSV contexts (where commas would break
 * cell parsing).
 *
 * Handles three patterns:
 *
 *   1. Template literal with escaped $:  `$${x.toFixed(2)}`  →  `${formatCurrency(x)}`
 *   2. JSX text + JS expression:         >${x.toFixed(2)}<   →  >{formatCurrency(x)}<
 *   3. Same for .toFixed(0)              →  formatCurrency(x, 'USD', { fractionDigits: 0 })
 *
 * Skips:
 *   - Lines containing `csv +=` or `csv:` or inside a .csv-building context
 *   - .toFixed(N) where N is not 0 or 2 (those are hours/percentages/etc.)
 *   - Lines containing `toFixed(2)}%` or `toFixed(1)}%` or `toFixed(0)}%`
 *
 * Also ensures `import { formatCurrency } from '@/lib/format';` is present
 * in every file it edits.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/edison/Desktop/bupos/code";
const TARGETS = [
  "src/app/admin",
  "src/components/admin",
  "src/app/register",
  "src/components/register",
  "src/components/layout",
  "src/components/ui",
  "src/components/system",
  "src/lib/cart",
  "src/lib/offline",
];
const SKIP_SUBPATHS = [
  "src/lib/receipt/",   // thermal receipts intentionally plain
  "/email-receipt/",    // receipt email formatter
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && (full.endsWith(".tsx") || full.endsWith(".ts"))) {
      out.push(full);
    }
  }
  return out;
}

function ensureImport(src) {
  if (src.includes("formatCurrency")) return src; // already referenced
  return src; // no-op; we'll add import only if we actually change code
}

function addImport(src) {
  if (/import\s+\{[^}]*\bformatCurrency\b[^}]*\}\s+from\s+["']@\/lib\/format["']/.test(src)) {
    return src;
  }
  // Find the last `import ... from ...;` line and append after it.
  const importRx = /^import\s[^;]*;$/gm;
  const matches = [...src.matchAll(importRx)];
  if (matches.length === 0) {
    return `import { formatCurrency } from "@/lib/format";\n\n${src}`;
  }
  const last = matches[matches.length - 1];
  const insertPos = (last.index ?? 0) + last[0].length;
  return src.slice(0, insertPos) + `\nimport { formatCurrency } from "@/lib/format";` + src.slice(insertPos);
}

function codemod(filePath, src) {
  let changed = 0;
  let out = src;

  // Split on lines so we can cheaply skip CSV-building lines.
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/csv\s*\+?=/.test(line)) continue;                         // CSV construction
    if (/`\s*["']?\w[^`]*\$\{[^}]+\.toFixed\([12]\)\}[^`]*["']?\s*`\.split\(/.test(line)) continue;
    if (/writeHeadCell|escapeCsv|CSV_/.test(line)) continue;
    let newLine = line;

    // Pattern A: `$${EXPR.toFixed(2)}` inside a backtick template
    newLine = newLine.replace(
      /\$\$\{([^{}]+?)\.toFixed\(2\)\}/g,
      (_m, expr) => { changed++; return `\${formatCurrency(${expr.trim()})}`; },
    );
    newLine = newLine.replace(
      /\$\$\{([^{}]+?)\.toFixed\(0\)\}/g,
      (_m, expr) => { changed++; return `\${formatCurrency(${expr.trim()}, 'USD', { fractionDigits: 0 })}`; },
    );

    // Pattern B: JSX text `$` literal adjacent to a JS expression
    //   e.g.   <span>${x.toFixed(2)}</span>
    //          >${x.toFixed(2)}<
    //          ) ${x.toFixed(2)}<
    // Match only when the `$` is NOT preceded by another `$` (that'd be
    // case A) and NOT inside a JavaScript context like `foo$.bar`. We
    // approximate by requiring the `$` to be preceded by `>` or `(` or
    // whitespace, and immediately followed by `{EXPR.toFixed(N)}`.
    newLine = newLine.replace(
      /([>\s(])\$\{([^{}]+?)\.toFixed\(2\)\}/g,
      (_m, prefix, expr) => { changed++; return `${prefix}{formatCurrency(${expr.trim()})}`; },
    );
    newLine = newLine.replace(
      /([>\s(])\$\{([^{}]+?)\.toFixed\(0\)\}/g,
      (_m, prefix, expr) => { changed++; return `${prefix}{formatCurrency(${expr.trim()}, 'USD', { fractionDigits: 0 })}`; },
    );

    lines[i] = newLine;
  }
  out = lines.join("\n");
  return { out, changed };
}

const files = TARGETS
  .flatMap((d) => {
    try { return walk(path.join(ROOT, d)); }
    catch { return []; } // directory missing (e.g. if components/layout absent) — skip
  })
  .filter((f) => !SKIP_SUBPATHS.some((s) => f.includes(s)));
console.log(`scanning ${files.length} files`);

let totalChanged = 0;
let totalFiles = 0;
const changedFiles = [];

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const { out, changed } = codemod(file, src);
  if (changed > 0) {
    // Add import if missing
    const withImport = addImport(out);
    fs.writeFileSync(file, withImport);
    totalChanged += changed;
    totalFiles++;
    changedFiles.push({ file: path.relative(ROOT, file), changed });
  }
}

console.log(`\n${totalFiles} files modified, ${totalChanged} total replacements`);
for (const { file, changed } of changedFiles) {
  console.log(`  ${changed}x  ${file}`);
}
void ensureImport;
