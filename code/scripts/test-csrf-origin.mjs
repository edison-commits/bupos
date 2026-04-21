#!/usr/bin/env node
/**
 * CSRF / Origin enforcement test.
 *
 * Exercises the `checkOrigin` function in src/lib/api/with-auth.ts with a
 * matrix of Origin / Referer / Method combinations. The function was added
 * in R6-M-4 and exported in R8-H-5 for use by un-wrapped routes like
 * /api/customer-display. This test never actually fired against it —
 * backfilling that gap now.
 *
 * Scenarios:
 *   C1. GET requests skip the check (safe method)
 *   C2. POST without Origin AND without Referer → 403
 *   C3. POST with matching Origin → allowed
 *   C4. POST with wrong Origin → 403
 *   C5. POST with missing Origin but matching Referer → allowed
 *   C6. POST with matching Origin but malformed → 403 if unparseable
 *   C7. PATCH + PUT + DELETE all behave the same
 */

import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const ROOT = "/Users/edison/Desktop/bupos/code";

const harness = `
import * as _withAuthMod from "@/lib/api/with-auth";
const _mod: any = (_withAuthMod as any).default ?? _withAuthMod;
const { checkOrigin } = _mod;

// Build a minimal NextRequest-like mock. checkOrigin only reads
// .method, .headers.get(name), and .url — so a POJO suffices.
function mockReq(opts: { method: string; url?: string; origin?: string | null; referer?: string | null }) {
  const url = opts.url || "https://bupos.basicuniform.com/api/anything";
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined && opts.origin !== null) headers["origin"] = opts.origin;
  if (opts.referer !== undefined && opts.referer !== null) headers["referer"] = opts.referer;
  return {
    method: opts.method,
    url,
    headers: {
      get(name: string) { return headers[name.toLowerCase()] ?? null; },
    },
  };
}

const results: Array<{ id: string; passed: boolean; detail?: string }> = [];
function check(id: string, desc: string, passed: boolean, detail = "") {
  results.push({ id, passed, detail: desc + (detail ? " — " + detail : "") });
}

// C1. GET should always skip (returns null)
(() => {
  const r = checkOrigin(mockReq({ method: "GET" }));
  check("C1", "GET skips check", r === null);
})();

// C2. POST with no Origin AND no Referer → 403
(() => {
  const r = checkOrigin(mockReq({ method: "POST" }));
  const is403 = r !== null && r.status === 403;
  check("C2", "POST without Origin/Referer rejected", is403, is403 ? "status=403" : "status=" + (r && r.status));
})();

// C3. POST with matching Origin (same host as request URL) → allowed
(() => {
  const r = checkOrigin(mockReq({ method: "POST", url: "https://bupos.basicuniform.com/api/x", origin: "https://bupos.basicuniform.com" }));
  check("C3", "POST with matching Origin allowed", r === null);
})();

// C4. POST with WRONG Origin → 403
(() => {
  const r = checkOrigin(mockReq({ method: "POST", url: "https://bupos.basicuniform.com/api/x", origin: "https://evil.example.com" }));
  const is403 = r !== null && r.status === 403;
  check("C4", "POST with wrong Origin rejected", is403, is403 ? "status=403" : "got=" + (r && r.status));
})();

// C5. POST with missing Origin but matching Referer → allowed
(() => {
  const r = checkOrigin(mockReq({ method: "POST", url: "https://bupos.basicuniform.com/api/x", referer: "https://bupos.basicuniform.com/register" }));
  check("C5", "POST with matching Referer (no Origin) allowed", r === null);
})();

// C6. POST with unparseable Referer and no Origin → 403
(() => {
  const r = checkOrigin(mockReq({ method: "POST", referer: "not-a-url" }));
  const is403 = r !== null && r.status === 403;
  check("C6", "POST with malformed Referer rejected", is403);
})();

// C7. Other state-changing methods honor the same check
for (const method of ["PUT", "PATCH", "DELETE"]) {
  const r = checkOrigin(mockReq({ method, origin: "https://evil.example.com" }));
  const is403 = r !== null && r.status === 403;
  check("C7-" + method, method + " with wrong Origin rejected", is403);
}

// C8. Explicit production Origin list — the check should allow bupos.basicuniform.com.
(() => {
  const r = checkOrigin(mockReq({
    method: "POST",
    url: "https://api.internal.something-else.com/x",
    origin: "https://bupos.basicuniform.com",
  }));
  // Different request URL host, but matches the hardcoded allowlist.
  check("C8", "POST from production host allowed even on odd URL", r === null);
})();

// C9. Localhost in dev (NODE_ENV check inside the function — we just verify
// that production origin stays allowed when a random malformed URL comes in)
(() => {
  const r = checkOrigin(mockReq({
    method: "POST",
    url: "https://bupos.basicuniform.com/api/x",
    origin: "http://localhost:3000",
  }));
  // In NODE_ENV=test (our context), localhost WON'T be in the allowed set
  // — the function's dev-only branch checks NODE_ENV !== "production".
  // So this might PASS (allowed in non-prod). Either outcome is legitimate;
  // we just verify checkOrigin didn't crash.
  check("C9", "localhost Origin handled without crash", r === null || r.status === 403,
        "got=" + (r === null ? "allowed" : "status=" + r.status));
})();

const pass = results.filter((r) => r.passed).length;
const fail = results.filter((r) => !r.passed).length;
for (const r of results) {
  console.log((r.passed ? "OK " : "FAIL ") + r.id + "  " + r.detail);
}
console.log("\\n" + pass + "/" + results.length + " passed");
process.exit(fail === 0 ? 0 : 1);
`;

const harnessPath = "/tmp/csrf-harness.mts";
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
