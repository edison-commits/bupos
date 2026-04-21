#!/usr/bin/env node
/**
 * R23-prevention self-test for `check-rls-force-matching.mjs`.
 *
 * Exits 2 if the detector fails to catch representative drift.
 * Runs before the real scan via the composed `check:rls` npm script.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const DETECTOR = path.join(ROOT, "scripts/check-rls-force-matching.mjs");

function mktmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bupos-${prefix}-`));
}
function write(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body);
}
function runDetector(migDir) {
  const res = spawnSync("node", [DETECTOR], {
    env: { ...process.env, BUPOS_SELFTEST_MIG_DIR: migDir },
    encoding: "utf8",
  });
  return { status: res.status ?? -1, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

// ─── Case 1: ENABLE + FORCE + POLICY all present → clean ───────────────
{
  const dir = mktmp("rls-clean");
  write(
    dir,
    "001_clean.sql",
    `CREATE TABLE widgets (id UUID, organization_id UUID);
     ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
     ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
     CREATE POLICY widget_isolation ON widgets USING (organization_id = current_setting('app.current_org_id')::uuid);`,
  );
  const { status, out } = runDetector(dir);
  if (status !== 0) {
    console.error(`\n✗ rls-force selftest FAILED — clean fixture should exit 0, got ${status}\n${out}`);
    fs.rmSync(dir, { recursive: true });
    process.exit(2);
  }
  fs.rmSync(dir, { recursive: true });
}

// ─── Case 2: ENABLE but no FORCE → should FAIL with non-zero exit ──────
{
  const dir = mktmp("rls-missing-force");
  write(
    dir,
    "001_missing_force.sql",
    `CREATE TABLE widgets (id UUID, organization_id UUID);
     ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
     CREATE POLICY widget_isolation ON widgets USING (organization_id = current_setting('app.current_org_id')::uuid);`,
  );
  const { status, out } = runDetector(dir);
  if (status === 0) {
    console.error(`\n✗ rls-force selftest FAILED — missing FORCE should exit non-zero\n${out}`);
    fs.rmSync(dir, { recursive: true });
    process.exit(2);
  }
  // Extra: assert the output mentions the offending table.
  if (!/widgets/.test(out)) {
    console.error(`\n✗ rls-force selftest FAILED — missing-force output should name the table 'widgets'\n${out}`);
    fs.rmSync(dir, { recursive: true });
    process.exit(2);
  }
  fs.rmSync(dir, { recursive: true });
}

console.log("✓ check-rls-force detector self-test passed (clean + missing-FORCE fixtures)");
