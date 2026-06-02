#!/usr/bin/env node
/**
 * R40-6: pin the custom ESLint rules' levels so a PR can't silently
 * downgrade them to "warn" or "off" via a one-line edit to
 * `eslint.config.mjs`.
 *
 * Each custom rule from `eslint-rules/index.mjs` MUST appear in
 * `eslint.config.mjs` set to the level `REQUIRED_LEVEL` (currently
 * "error"). If any is missing or set to a weaker level, this script
 * exits non-zero and the pre-commit hook + CI step fail.
 *
 * To add a NEW custom rule, update the `REQUIRED_RULES` array below.
 *
 * Exits 0 on pass, 1 on policy violation, 2 on configuration parse
 * error. Intended for pre-commit + `npm run check:all`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const CONFIG_PATH = path.join(ROOT, "eslint.config.mjs");

const REQUIRED_LEVEL = "error";
const REQUIRED_RULES = [
  "local/no-hand-rolled-currency",
  "local/no-workers-hazards",
  "local/pg-helpers-require-org",
];

// Core detection — shared by the live check AND selfTest(). Returns the
// list of `rules` NOT pinned to `level` in `src`. A rule must appear as a
// quoted key with `level` as the value; any "warn"/"off"/0/1/omission fails
// (pattern: "rule": "level").
function findUnpinnedRules(configSrc, rules, level) {
  const failures = [];
  for (const rule of rules) {
    const pattern = new RegExp(
      `"${rule.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}"\\s*:\\s*"${level}"`,
    );
    if (!pattern.test(configSrc)) failures.push(rule);
  }
  return failures;
}

// Self-test (required by check:selftest-coverage — a guardrail without one
// is indistinguishable from a no-op). Proves the detector PASSES a fully
// pinned config and CATCHES a downgraded ("warn") or omitted rule.
function selfTest() {
  const rules = ["local/a", "local/b"];
  const cases = [
    { name: "all pinned", src: `{ "local/a": "error", "local/b": "error" }`, expect: [] },
    { name: "one downgraded", src: `{ "local/a": "error", "local/b": "warn" }`, expect: ["local/b"] },
    { name: "one missing", src: `{ "local/a": "error" }`, expect: ["local/b"] },
  ];
  for (const c of cases) {
    const got = findUnpinnedRules(c.src, rules, "error");
    if (JSON.stringify(got) !== JSON.stringify(c.expect)) {
      console.error(
        `\n✗ eslint-config-guard self-test FAILED (${c.name}) — expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}\n`,
      );
      process.exit(2);
    }
  }
}

selfTest();

let src;
try {
  src = fs.readFileSync(CONFIG_PATH, "utf8");
} catch (err) {
  console.error(`✗ could not read ${CONFIG_PATH}: ${err.message}`);
  process.exit(2);
}

const failures = findUnpinnedRules(src, REQUIRED_RULES, REQUIRED_LEVEL);

if (failures.length > 0) {
  console.error("✗ ESLint-config guardrail failed:");
  for (const rule of failures) {
    console.error(`    - ${rule} must be set to "${REQUIRED_LEVEL}" in eslint.config.mjs`);
  }
  console.error(
    "\nThese rules exist for a reason — money math precision, Workers",
    "runtime compatibility, and RLS org-filter coverage. If you need to",
    "temporarily disable one for a specific file, use an eslint-disable",
    "comment on that line instead of weakening the global level.",
  );
  process.exit(1);
}

console.log(`✓ ESLint-config guardrail passed (${REQUIRED_RULES.length} custom rules pinned at "${REQUIRED_LEVEL}")`);
process.exit(0);
