#!/usr/bin/env node
/**
 * Runs every test script back-to-back and reports a consolidated summary.
 * Exits non-zero if any test fails.
 */

import { spawn } from "node:child_process";

const SCRIPTS = [
  { name: "Tier A-1  Role-permission matrix",          script: "scripts/test-role-permission-matrix.mjs" },
  { name: "Tier A-2  Concurrent same-entity ops",      script: "scripts/test-concurrent-same-entity.mjs" },
  { name: "Tier A-3  Offline-sync pathology",          script: "scripts/test-offline-sync-pathology.mjs" },
  { name: "Tier B-4  Historical invariants audit",     script: "scripts/test-historical-invariants.mjs" },
  { name: "Tier B-5  Adversarial input fuzz",          script: "scripts/test-adversarial-fuzz.mjs" },
  { name: "Tier B-6  Rate-limit correctness",          script: "scripts/test-rate-limit.mjs" },
  { name: "Tier C-7  CSRF/Origin enforcement",         script: "scripts/test-csrf-origin.mjs" },
  { name: "Tier C-8  Session edge cases",              script: "scripts/test-session-edge-cases.mjs" },
  { name: "Tier C-9  Schema drift detector",           script: "scripts/test-schema-drift.mjs" },
];

const results = [];
for (const s of SCRIPTS) {
  console.log(`\n━━━ ${s.name} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const p = spawn("node", [s.script], { stdio: "inherit", cwd: "/Users/edison/Desktop/bupos/code" });
    p.on("exit", (c) => resolve(c ?? 1));
  });
  const ms = Date.now() - t0;
  results.push({ name: s.name, passed: code === 0, ms });
}

console.log("\n\n━━━ Consolidated summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
for (const r of results) {
  const status = r.passed ? "✓" : "✗";
  const time = `${(r.ms / 1000).toFixed(1)}s`;
  console.log(`  ${status}  ${r.name.padEnd(45)}  ${time}`);
}
const passed = results.filter((r) => r.passed).length;
console.log(`\n  ${passed}/${results.length} suites passed`);
process.exit(passed === results.length ? 0 : 1);
