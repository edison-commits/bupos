#!/usr/bin/env node
/**
 * R23-prevention self-test for `check-schema-drift-ci.mjs`.
 *
 * Rationale: the drift detector is load-bearing (it's caught C-level
 * bugs in rounds 9, 11, 12, 13) but had no mechanical proof that it
 * actually flags drift. R23 showed that a guardrail can silently stop
 * working (see R23-C-1). We now require every guardrail to prove it
 * catches its own failure mode before CI trusts its clean output.
 *
 * This runner:
 *   1. Creates two tmpdirs with synthetic migrations + source files.
 *   2. Runs `check-schema-drift-ci.mjs` against each via env-var
 *      overrides (BUPOS_SELFTEST_MIG_DIR / BUPOS_SELFTEST_SRC_DIR).
 *   3. Asserts the detector exits 0 on the clean fixture and exits 1
 *      on the drifted fixture with a matching error message.
 *
 * If either assertion fails, exit 2 ("guardrail broken"). The top-
 * level `check:schema` wrapper runs this selftest before the real
 * scan so a broken detector is visible before any real check runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const DETECTOR = path.join(ROOT, "scripts/check-schema-drift-ci.mjs");

function mktmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bupos-${prefix}-`));
}

function writeFixture(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Run the detector with the given override env and return {status, stdout}. */
function runDetector(migDir, srcDir) {
  const res = spawnSync("node", [DETECTOR], {
    env: {
      ...process.env,
      BUPOS_SELFTEST_MIG_DIR: migDir,
      BUPOS_SELFTEST_SRC_DIR: srcDir,
    },
    encoding: "utf8",
  });
  return {
    status: res.status ?? -1,
    stdout: (res.stdout ?? "") + (res.stderr ?? ""),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Case 1: clean fixture → exit 0
// ─────────────────────────────────────────────────────────────────────
{
  const migDir = mktmp("mig-clean");
  const srcDir = mktmp("src-clean");
  writeFixture(
    migDir,
    "001_init.sql",
    `CREATE TABLE products (
       id UUID PRIMARY KEY,
       organization_id UUID NOT NULL,
       name TEXT NOT NULL,
       slug TEXT NOT NULL
     );`,
  );
  writeFixture(
    srcDir,
    "clean.ts",
    `export async function fn(pool: unknown) {
       await (pool as {query: (q: string) => Promise<void>}).query(\`
         INSERT INTO products (id, organization_id, name, slug)
         VALUES ($1, $2, $3, $4)
       \`);
     }`,
  );
  const { status, stdout } = runDetector(migDir, srcDir);
  if (status !== 0) {
    console.error(`\n✗ check-schema-drift selftest FAILED — clean fixture should exit 0, got ${status}\n`);
    console.error(stdout);
    fs.rmSync(migDir, { recursive: true });
    fs.rmSync(srcDir, { recursive: true });
    process.exit(2);
  }
  fs.rmSync(migDir, { recursive: true });
  fs.rmSync(srcDir, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────
// Case 2: drifted fixture (INSERT references a column no migration
// declared) → exit 1 with "unknown column references" in output
// ─────────────────────────────────────────────────────────────────────
{
  const migDir = mktmp("mig-drift");
  const srcDir = mktmp("src-drift");
  writeFixture(
    migDir,
    "001_init.sql",
    `CREATE TABLE products (
       id UUID PRIMARY KEY,
       organization_id UUID NOT NULL,
       name TEXT NOT NULL
     );`,
  );
  writeFixture(
    srcDir,
    "drifted.ts",
    `export async function fn(pool: unknown) {
       await (pool as {query: (q: string) => Promise<void>}).query(\`
         INSERT INTO products (id, organization_id, name, nonexistent_column)
         VALUES ($1, $2, $3, $4)
       \`);
     }`,
  );
  const { status, stdout } = runDetector(migDir, srcDir);
  const looksLikeDriftFlag =
    status === 1 && /unknown column references/i.test(stdout) && /nonexistent_column/.test(stdout);
  if (!looksLikeDriftFlag) {
    console.error(`\n✗ check-schema-drift selftest FAILED — drifted fixture should exit 1 with unknown-column message\n`);
    console.error(`  status: ${status}`);
    console.error(`  stdout: ${stdout.slice(0, 800)}`);
    fs.rmSync(migDir, { recursive: true });
    fs.rmSync(srcDir, { recursive: true });
    process.exit(2);
  }
  fs.rmSync(migDir, { recursive: true });
  fs.rmSync(srcDir, { recursive: true });
}

console.log("✓ check-schema-drift detector self-test passed (clean + drift fixtures)");
