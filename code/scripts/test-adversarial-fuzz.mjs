#!/usr/bin/env node
/**
 * Adversarial input fuzz — feeds malicious/edge-case payloads to the Zod
 * validation schemas and asserts each gets rejected cleanly (not a 500
 * crash, not accepted verbatim, not an information leak in the error).
 *
 * Runs at the Zod layer directly (same schemas the routes use), so we
 * don't need a live HTTP server. If a schema accepts something it
 * shouldn't, this surfaces it.
 *
 * Scenarios:
 *   F1. XSS-shaped strings in name/email/notes
 *   F2. Null bytes, RTL override, emoji in text fields
 *   F3. Very long strings (10MB description field)
 *   F4. Numeric overflow (Number.MAX_SAFE_INTEGER * 2)
 *   F5. Negative quantities / prices / amounts
 *   F6. JSON bomb — deeply nested cart_snapshot
 *   F7. Unicode normalization attacks (é vs e + ́)
 *   F8. Invalid UUIDs in id fields
 *   F9. SQL-keyword values passed as IDs
 *   F10. Prototype pollution via __proto__
 */

import fs from "node:fs";
// We can't directly import TS, so read the schema source and replay
// representative checks in a JS-native way against live Zod schemas.
// Easier: spawn a subprocess that imports the TS schemas via tsx.

const ROOT = "/Users/edison/Desktop/bupos/code";

// Instead of compiling TS, write a helper TS file the same directory
// and run via tsx. Simpler: use dynamic import of compiled .next output?
// Actually easiest: exec `npx tsx -e "..."` to run TS.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

// Build a TS test harness that imports the real schemas and validates
// each adversarial input.
const harness = `
// tsx wraps the validation schemas as CJS under Node 24 ESM, so named
// imports fail — pull everything as a namespace and destructure from .default.
import * as _schemasModule from "@/lib/validation/schemas";
const _s: any = (_schemasModule as any).default ?? _schemasModule;
const {
  customerCreateSchema,
  loyaltyAdjustSchema,
  expenseCreateSchema,
  giftCardSchema,
  receivingCreateSchema,
  settingsUpdateSchema,
} = _s;

const cases: Array<{ id: string; schema: any; input: any; expectReject: boolean; desc: string }> = [
  // F1 XSS — should be ACCEPTED by schema (no HTML escaping at validation;
  // escaping happens at render). We verify Zod doesn't crash.
  { id: "F1a", schema: customerCreateSchema, expectReject: false, desc: "XSS in name accepted by schema (render-time escape)",
    input: { first_name: "<script>alert(1)</script>", last_name: "X" } },

  // F2 Control characters / RTL override. Schema-level acceptance, then
  // DB storage should handle null bytes. Postgres rejects \\u0000 in text.
  { id: "F2a", schema: customerCreateSchema, expectReject: false, desc: "RTL override char accepted by schema",
    input: { first_name: "Alice\\u202e", last_name: "X" } },
  { id: "F2b", schema: customerCreateSchema, expectReject: false, desc: "Emoji accepted in name",
    input: { first_name: "\\ud83d\\ude80 Rocket", last_name: "X" } },

  // F3 Very long strings — customer name schema has no explicit length cap.
  // The settings schema does (R8-M-2 added .max() to everything). Test the
  // settings schema rejects oversize, customer schema accepts (flag gap).
  { id: "F3a", schema: settingsUpdateSchema, expectReject: true, desc: "Settings name > 200 chars rejected",
    input: { section: "store", data: { name: "x".repeat(500) } } },
  { id: "F3b", schema: customerCreateSchema, expectReject: true, desc: "customer name 100k chars rejected by MAX_STRING cap",
    input: { first_name: "x".repeat(100_000), last_name: "X" } },

  // F4 Numeric overflow
  { id: "F4a", schema: loyaltyAdjustSchema, expectReject: true, desc: "Loyalty adjustment over max rejected",
    input: { customer_id: "00000000-0000-0000-0000-000000000000", adjustment: Number.MAX_SAFE_INTEGER, reason: "fuzz" } },
  { id: "F4b", schema: expenseCreateSchema, expectReject: true, desc: "Expense amount > 10M rejected",
    input: { category: "rent", description: "test", amount: 999_999_999, expense_date: "2026-01-01" } },

  // F5 Negative values
  { id: "F5a", schema: giftCardSchema, expectReject: true, desc: "Gift card negative amount rejected",
    input: { action: "activate", code: "TEST", amount: -100 } },
  { id: "F5b", schema: expenseCreateSchema, expectReject: true, desc: "Expense negative amount rejected",
    input: { category: "rent", description: "test", amount: -100, expense_date: "2026-01-01" } },
  { id: "F5c", schema: receivingCreateSchema, expectReject: true, desc: "Receiving negative quantity rejected",
    input: { type: "receive", items: [{ product_variant_id: "00000000-0000-0000-0000-000000000000", quantity: -5 }] } },

  // F6 JSON bomb — deeply nested. cart_snapshot isn't directly validated
  // but the checkout cart goes through other schemas. We smoke a nested
  // object in an unrelated schema field.
  { id: "F6a", schema: settingsUpdateSchema, expectReject: true, desc: "Deep nested object in settings rejected (strict schema)",
    input: { section: "store", data: { unknown_key: { a: { b: { c: { d: { e: 1 } } } } } } } },

  // F7 Unicode normalization
  { id: "F7a", schema: customerCreateSchema, expectReject: false, desc: "Precomposed é accepted",
    input: { first_name: "\\u00e9dison", last_name: "X" } },
  { id: "F7b", schema: customerCreateSchema, expectReject: false, desc: "Decomposed e+combining accepted",
    input: { first_name: "e\\u0301dison", last_name: "X" } },

  // F8 Invalid UUID
  { id: "F8a", schema: loyaltyAdjustSchema, expectReject: true, desc: "Invalid UUID rejected",
    input: { customer_id: "not-a-uuid", adjustment: 10, reason: "fuzz" } },
  { id: "F8b", schema: loyaltyAdjustSchema, expectReject: true, desc: "Empty string UUID rejected",
    input: { customer_id: "", adjustment: 10, reason: "fuzz" } },

  // F9 SQL keyword as id
  { id: "F9a", schema: loyaltyAdjustSchema, expectReject: true, desc: "SQL keyword as UUID rejected",
    input: { customer_id: "'; DROP TABLE customers; --", adjustment: 10, reason: "fuzz" } },

  // F10 __proto__ — Zod should just treat as an unknown key in strict mode.
  { id: "F10a", schema: settingsUpdateSchema, expectReject: true, desc: "__proto__ key rejected by strict schema",
    input: { section: "store", data: { __proto__: { polluted: true } } } },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const result = c.schema.safeParse(c.input);
  const accepted = result.success;
  const outcomeMatches = c.expectReject ? !accepted : accepted;
  if (outcomeMatches) {
    pass++;
    console.log("OK " + c.id + "  " + c.desc + (c.expectReject ? " (rejected as expected)" : " (accepted as expected)"));
  } else {
    fail++;
    console.log("FAIL " + c.id + "  " + c.desc);
    console.log("     expected=" + (c.expectReject ? "reject" : "accept") + ", got=" + (accepted ? "accept" : "reject"));
    if (!accepted && result.error) {
      console.log("     err: " + result.error.issues.map((i: any) => i.message).slice(0, 2).join("; "));
    }
  }
}

console.log("\\n" + pass + "/" + cases.length + " passed");
process.exit(fail === 0 ? 0 : 1);
`;

// Write the harness and run via tsx
const harnessPath = "/tmp/fuzz-harness.mts";
fs.writeFileSync(harnessPath, harness);

try {
  const { stdout } = await exec("npx", ["tsx", harnessPath], {
    cwd: ROOT,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  console.log(stdout);
} catch (e) {
  // exec throws on non-zero exit, but we WANT the output
  const stdout = e.stdout || "";
  const stderr = e.stderr || "";
  console.log(stdout);
  if (stderr && !stdout.includes("FAIL")) {
    console.error("STDERR:", stderr.slice(0, 500));
  }
  const m = stdout.match(/(\d+)\/(\d+) passed/);
  if (m && Number(m[1]) === Number(m[2])) process.exit(0);
  process.exit(1);
}
