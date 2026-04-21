#!/usr/bin/env node
/**
 * R23-C-2 prevention: enforce that every `check:*` script in
 * package.json is invoked from `.github/workflows/guardrails.yml`.
 *
 * Motivation: R23 discovered that `npm run check:logs` existed but
 * was never wired into CI — it was only reachable through the manual
 * aggregate `npm run check:all`, which no hook or pipeline invoked.
 * The guardrail was a placebo for a full audit round.
 *
 * This script scans package.json for `check:*` scripts, scans
 * guardrails.yml for the corresponding `npm run check:X` invocations,
 * and fails if any script is orphaned.
 *
 * Aggregate scripts (`check:all`) are exempt — they compose the
 * individual checks, and their components are what we care about.
 *
 * Self-test: synthesizes a package.json + workflow pair with a known
 * orphan and asserts the detector flags it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/**
 * Extract `check:*` script names from a parsed package.json object.
 * Skips aggregates (scripts that just invoke other `check:*` scripts).
 */
function extractIndividualChecks(packageJsonObj) {
  const scripts = packageJsonObj.scripts ?? {};
  const checkNames = Object.keys(scripts).filter((name) => name.startsWith("check:"));
  // Aggregate: script body contains two or more `npm run check:*` invocations.
  const individual = [];
  for (const name of checkNames) {
    const body = scripts[name] ?? "";
    const invocations = body.match(/npm run check:[A-Za-z0-9_-]+/g) ?? [];
    if (invocations.length >= 2) continue; // aggregate
    individual.push(name);
  }
  return individual;
}

/**
 * Return which individual `check:*` scripts are referenced somewhere
 * in the workflow YAML (either as `npm run check:X` OR by running
 * `scripts/<file>.mjs` that the script maps to OR via an aggregate
 * `npm run check:all`-style composer that includes this script).
 */
function findWiredChecks(individualChecks, workflowYaml, packageJsonObj) {
  const scripts = packageJsonObj.scripts ?? {};

  // R24-M-1: identify aggregate scripts (ones whose body composes
  // multiple `npm run check:X` invocations) and their components. If
  // an aggregate is wired into YAML, every component counts as wired.
  const aggregateCovers = {}; // aggregateName -> Set<componentName>
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== "string") continue;
    const matches = [...body.matchAll(/npm run (check:[A-Za-z0-9_-]+)/g)];
    if (matches.length >= 2) {
      aggregateCovers[name] = new Set(matches.map((m) => m[1]));
    }
  }

  const wired = new Set();
  for (const name of individualChecks) {
    // Direct invocation: `npm run <name>`
    if (new RegExp(`npm\\s+run\\s+${escapeRegex(name)}\\b`).test(workflowYaml)) {
      wired.add(name);
      continue;
    }
    // Aggregate invocation: any aggregate that composes `name` AND is
    // itself invoked from YAML.
    for (const [aggName, components] of Object.entries(aggregateCovers)) {
      if (!components.has(name)) continue;
      if (new RegExp(`npm\\s+run\\s+${escapeRegex(aggName)}\\b`).test(workflowYaml)) {
        wired.add(name);
        break;
      }
    }
    if (wired.has(name)) continue;
    // Fallback: match any direct `node scripts/<file>.mjs` path used
    // in the script body against the YAML. R24-M-1 fixed `.match()` →
    // `.matchAll()` so composed scripts (selftest && main) both count.
    const body = scripts[name] ?? "";
    for (const m of body.matchAll(/node\s+(scripts\/\S+\.m?js)/g)) {
      if (workflowYaml.includes(m[1])) {
        wired.add(name);
        break;
      }
    }
  }
  return wired;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runOrphanScan(packageJsonObj, workflowYaml) {
  const individual = extractIndividualChecks(packageJsonObj);
  const wired = findWiredChecks(individual, workflowYaml, packageJsonObj);
  return individual.filter((name) => !wired.has(name));
}

// ─────────────────────────────────────────────────────────────────────
// Self-test: synthesize a package.json + workflow with a known orphan
// and assert the detector catches it.
// ─────────────────────────────────────────────────────────────────────
function selfTest() {
  const fakePkg = {
    scripts: {
      "check:alpha": "node scripts/check-alpha.mjs",
      "check:beta": "node scripts/check-beta.mjs",
      "check:gamma": "node scripts/check-gamma.mjs",
      "check:all": "npm run check:alpha && npm run check:beta && npm run check:gamma",
    },
  };
  const fakeYaml = `
    steps:
      - name: Alpha check
        run: npm run check:alpha
      - name: Beta check (by path)
        run: node scripts/check-beta.mjs
      # gamma is NOT wired — this is the orphan we should catch.
  `;
  const orphans = runOrphanScan(fakePkg, fakeYaml);
  if (orphans.length !== 1 || orphans[0] !== "check:gamma") {
    console.error(
      `\n✗ check-ci-wiring self-test FAILED — expected ["check:gamma"], got ${JSON.stringify(orphans)}\n`,
    );
    process.exit(2);
  }

  // Inverse test: every script wired → zero orphans.
  const fakeYamlAllWired = `
    steps:
      - run: npm run check:alpha
      - run: npm run check:beta
      - run: npm run check:gamma
  `;
  const noOrphans = runOrphanScan(fakePkg, fakeYamlAllWired);
  if (noOrphans.length !== 0) {
    console.error(
      `\n✗ check-ci-wiring self-test FAILED — expected [], got ${JSON.stringify(noOrphans)}\n`,
    );
    process.exit(2);
  }
}

selfTest();

// ─────────────────────────────────────────────────────────────────────
// Real scan
// ─────────────────────────────────────────────────────────────────────
const pkgPath = path.join(ROOT, "package.json");
// R25-ops-C-1: workflows live at the REPO ROOT (`../.github/workflows/`
// relative to this script), not inside the `code/` subdirectory.
// GitHub Actions only reads workflows from the repo root; placing
// them under `code/.github/workflows/` silently disabled every
// guardrail for 4 audit rounds.
const workflowPath = path.join(ROOT, "..", ".github/workflows/guardrails.yml");
if (!fs.existsSync(pkgPath)) {
  console.error(`✗ package.json not found at ${pkgPath}`);
  process.exit(2);
}
if (!fs.existsSync(workflowPath)) {
  console.error(`✗ guardrails.yml not found at ${workflowPath}`);
  process.exit(2);
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const yaml = fs.readFileSync(workflowPath, "utf8");

const orphans = runOrphanScan(pkg, yaml);

if (orphans.length > 0) {
  console.error(
    `\n✗ Found ${orphans.length} check:* script(s) not wired into guardrails.yml:\n`,
  );
  for (const name of orphans) {
    console.error(`  ${name}  (add "- run: npm run ${name}" to .github/workflows/guardrails.yml)`);
  }
  console.error(
    `\nAn orphan check is a placebo guardrail — the script exists but CI never runs it.\n`,
  );
  process.exit(1);
}

console.log(`✓ all ${extractIndividualChecks(pkg).length} check:* scripts wired into CI`);
