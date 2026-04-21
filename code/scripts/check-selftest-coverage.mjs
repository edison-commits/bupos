#!/usr/bin/env node
/**
 * Meta-meta guardrail: every `scripts/check-*.mjs` file must have a
 * `selfTest` block OR a sibling `-selftest.mjs` runner.
 *
 * This prevents the R22-L-1 / R23-C-1 shape where a guardrail silently
 * stops detecting its target pattern. A guardrail without a self-test
 * is indistinguishable from a no-op: it still exits 0 even if its
 * detection regex / parser / ast walk is broken.
 *
 * Exempts:
 *   - check-ci-wiring.mjs (has inline selfTest)
 *   - check-no-raw-pool-query.mjs (has inline selfTest)
 *   - check-no-raw-err-log.mjs (has inline selfTest)
 *   - check-selftest-coverage.mjs (this file — meta)
 *   - any `-selftest.mjs` file itself
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const SCRIPTS_DIR = path.join(ROOT, "scripts");

const EXEMPT = new Set([
  "check-selftest-coverage.mjs", // this file — cannot self-test its own self-test requirement
  // One-off ad-hoc helpers not invoked from CI. Rule of thumb: if the
  // script is NOT in package.json's check:* pipeline, it's not a
  // guardrail — don't require a self-test.
  "check-test-fixtures.mjs",
]);

function hasInlineSelfTest(abs) {
  const src = fs.readFileSync(abs, "utf8");
  return /function\s+selfTest\s*\(/.test(src) || /\bselfTest\s*\(\)/.test(src);
}

function hasSidecarSelfTest(name) {
  // R24-M-2: produce both "shortened" (check-foo-selftest.mjs where
  // name is check-foo-ci.mjs) AND "same-name" (check-foo-selftest.mjs
  // where name is check-foo.mjs) candidates. Prior second entry was
  // a no-op `.replace(/^check-/, "check-")`.
  const stem = name.replace(/\.(mjs|ts|js)$/, "");
  const stemNoCi = stem.replace(/-ci$/, "");
  const sidecars = new Set([
    `${stem}-selftest.mjs`,
    `${stemNoCi}-selftest.mjs`,
  ]);
  return [...sidecars].some((s) => fs.existsSync(path.join(SCRIPTS_DIR, s)));
}

function packageJsonInvokesSelftest(scriptName, pkg) {
  // Check if any `check:*` script in package.json references a
  // selftest sidecar for this scriptName. E.g., check:schema composes
  // `check-schema-drift-selftest.mjs && check-schema-drift-ci.mjs`.
  const base = scriptName.replace(/\.mjs$/, "").replace(/-ci$/, "");
  const scripts = pkg.scripts ?? {};
  for (const body of Object.values(scripts)) {
    if (typeof body !== "string") continue;
    if (body.includes(`${base}-selftest.mjs`) && body.includes(scriptName)) {
      return true;
    }
  }
  return false;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const missing = [];
const wrongExt = [];
for (const name of fs.readdirSync(SCRIPTS_DIR)) {
  if (!name.startsWith("check-")) continue;
  // R24-M-2: widen extension filter from `.mjs` only to any JS/TS
  // script. Emit a warning on non-.mjs extensions since our npm
  // scripts + CI steps invoke via `node scripts/*.mjs`; running a
  // `.ts` guardrail would need tsx/ts-node wiring that doesn't
  // exist today. A `.js` guardrail is fine but unusual.
  if (name.endsWith("-selftest.mjs")) continue;
  if (EXEMPT.has(name)) continue;
  if (!/\.(mjs|ts|js)$/.test(name)) continue;
  if (name.endsWith(".ts") || name.endsWith(".js")) {
    wrongExt.push(name);
    continue;
  }

  const abs = path.join(SCRIPTS_DIR, name);
  if (hasInlineSelfTest(abs)) continue;
  if (hasSidecarSelfTest(name) && packageJsonInvokesSelftest(name, pkg)) continue;
  missing.push(name);
}

if (wrongExt.length > 0) {
  console.error(
    `\n✗ ${wrongExt.length} check-* script(s) use non-.mjs extension:`,
  );
  for (const n of wrongExt) console.error(`  scripts/${n}`);
  console.error(
    `\nCI invokes guardrails via \`node scripts/*.mjs\`. Rename to .mjs or\nwire a tsx-based runner before shipping.\n`,
  );
  process.exit(1);
}

if (missing.length > 0) {
  console.error(
    `\n✗ ${missing.length} guardrail script(s) lack a self-test:\n`,
  );
  for (const name of missing) {
    console.error(`  scripts/${name}`);
  }
  console.error(
    `\nAdd an inline \`function selfTest() { ... }\` OR create a sibling \`${path.basename("check-foo", ".mjs")}-selftest.mjs\` and compose the two into the npm script. A guardrail without a self-test is indistinguishable from a no-op.\n`,
  );
  process.exit(1);
}

console.log("✓ all check-* guardrails have a self-test");
