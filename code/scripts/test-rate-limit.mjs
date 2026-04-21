#!/usr/bin/env node
/**
 * Rate-limit correctness test.
 *
 * Verifies the in-memory limiter in src/lib/auth/rate-limit.ts:
 *   1. N-th attempt succeeds; (N+1)-th rejects with retryAfterMs > 0
 *   2. Distinct keys get independent budgets (no cross-user interference)
 *   3. After a window, counter resets (simulated via sub-second window)
 *   4. Option overrides (`maxAttempts`, `windowMs`) are honored
 *   5. retryAfterMs is >= 1000ms (sanity clamp)
 */

import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const ROOT = "/Users/edison/Desktop/bupos/code";

const harness = `
import * as _rlMod from "@/lib/auth/rate-limit";
const _rl: any = (_rlMod as any).default ?? _rlMod;
const { checkRateLimit } = _rl;

const results: Array<{ id: string; passed: boolean; detail?: string }> = [];
function check(id: string, passed: boolean, detail = "") {
  results.push({ id, passed, detail });
}

// 1. N attempts allowed, N+1 rejected
(() => {
  const key = "rl-test-1-" + Math.random();
  const opts = { maxAttempts: 5, windowMs: 10_000 };
  let allowed = 0, rejected = 0;
  for (let i = 0; i < 7; i++) {
    const r = checkRateLimit(key, opts);
    if (r.allowed) allowed++; else rejected++;
  }
  check("1.1", allowed === 5 && rejected === 2, "attempts=" + allowed + " rejected=" + rejected);
})();

// 2. Distinct keys — independent budgets
(() => {
  const keyA = "rl-test-2a-" + Math.random();
  const keyB = "rl-test-2b-" + Math.random();
  const opts = { maxAttempts: 3, windowMs: 10_000 };
  for (let i = 0; i < 3; i++) checkRateLimit(keyA, opts); // burn keyA
  // keyB should still have full budget
  const r = checkRateLimit(keyB, opts);
  check("2.1", r.allowed, "keyB allowed=" + r.allowed + " after keyA exhausted");
})();

// 3. After window expiry, counter resets (tight window)
(async () => {
  const key = "rl-test-3-" + Math.random();
  const opts = { maxAttempts: 2, windowMs: 1000 };
  checkRateLimit(key, opts);
  checkRateLimit(key, opts);
  const blocked = checkRateLimit(key, opts);
  check("3.1", !blocked.allowed, "blocked after 2 attempts: allowed=" + blocked.allowed);
  await new Promise((r) => setTimeout(r, 1100));
  const afterWait = checkRateLimit(key, opts);
  check("3.2", afterWait.allowed, "allowed again after window expired: allowed=" + afterWait.allowed);
})().then(async () => {
  // 4. maxAttempts override honored
  (() => {
    const key = "rl-test-4-" + Math.random();
    checkRateLimit(key, { maxAttempts: 1, windowMs: 10_000 });
    const second = checkRateLimit(key, { maxAttempts: 1, windowMs: 10_000 });
    check("4.1", !second.allowed, "maxAttempts=1 blocks 2nd: allowed=" + second.allowed);
  })();

  // 5. retryAfterMs clamped to >= 1000ms
  (() => {
    const key = "rl-test-5-" + Math.random();
    const opts = { maxAttempts: 1, windowMs: 500 }; // small window
    checkRateLimit(key, opts);
    const blocked = checkRateLimit(key, opts);
    const retryMs = blocked.allowed ? -1 : blocked.retryAfterMs;
    check("5.1", !blocked.allowed && retryMs >= 1000, "retryAfterMs=" + retryMs + " (should >= 1000)");
  })();

  // 6. Default limits (5 per 5min — from the file's own MAX_ATTEMPTS=3, WINDOW_MS=300s)
  (() => {
    const key = "rl-test-6-" + Math.random();
    let firstBlock = -1;
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit(key); // use defaults
      if (!r.allowed && firstBlock === -1) { firstBlock = i; break; }
    }
    check("6.1 default maxAttempts=3 — first block on 4th attempt", firstBlock === 3, "firstBlock=" + firstBlock);
  })();

  // Report
  const pass = results.filter((r) => r.passed).length;
  const fail = results.filter((r) => !r.passed).length;
  for (const r of results) {
    console.log((r.passed ? "OK " : "FAIL ") + r.id + "  " + r.detail);
  }
  console.log("\\n" + pass + "/" + results.length + " passed");
  process.exit(fail === 0 ? 0 : 1);
});
`;

const harnessPath = "/tmp/rl-harness.mts";
fs.writeFileSync(harnessPath, harness);

try {
  const { stdout } = await exec("npx", ["tsx", harnessPath], {
    cwd: ROOT,
    env: process.env,
  });
  console.log(stdout);
} catch (e) {
  console.log(e.stdout || "");
  if (e.stderr) console.error(e.stderr.slice(0, 500));
  process.exit(e.code || 1);
}
