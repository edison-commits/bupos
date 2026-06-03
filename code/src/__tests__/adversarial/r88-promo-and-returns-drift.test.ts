/**
 * R88 / SIM-AUDIT8 — two NOT-NULL / schema-drift 500s found by the month sim.
 *
 *  (A) promo-codes create 500: the INSERT passed `maxRedemptions ?? null`
 *      into the NOT-NULL max_redemptions column and a possibly-undefined
 *      startsAt into NOT-NULL starts_at. Both are schema-OPTIONAL, so the
 *      common "unlimited, starts now" promo 500'd. Fixed: default to 0
 *      (0 = unlimited) and now().
 *
 *  (B) returns 500 (the whole feature): prod's `returns` table is missing
 *      transaction_id + updated_at (migration 002 used CREATE TABLE IF NOT
 *      EXISTS against a pre-existing table, so the columns never applied).
 *      Migration 083 repairs the drift idempotently.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("SIM-AUDIT8-A: promo create defaults max_redemptions + starts_at", () => {
  const src = read("src/app/api/promo-codes/route.ts");
  it("max_redemptions defaults to 0 (unlimited), not null, in the create INSERT", () => {
    expect(src).toMatch(/maxRedemptions \?\? 0/);
    // must NOT pass null into the NOT-NULL column
    expect(src).not.toMatch(/minimumPurchase \|\| 0, maxRedemptions \?\? null/);
  });
  it("starts_at defaults to now() when omitted", () => {
    expect(src).toMatch(/startsAt \?\? new Date\(\)\.toISOString\(\)/);
  });
});

describe("SIM-AUDIT8-B: migration 083 repairs returns-table drift", () => {
  const src = read("supabase/migrations/083_returns_drift_repair.sql");
  it("adds transaction_id + updated_at idempotently", () => {
    expect(src).toMatch(/ALTER TABLE returns ADD COLUMN IF NOT EXISTS transaction_id uuid/);
    expect(src).toMatch(/ALTER TABLE returns ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now\(\)/);
  });
  it("indexes transaction_id for the /api/returns PUT lookup", () => {
    expect(src).toMatch(/CREATE INDEX IF NOT EXISTS idx_returns_transaction_id ON returns\(transaction_id\)/);
  });
});

describe("SIM-AUDIT8-C: migration 084 repairs the remaining prod schema drift", () => {
  // A prod-vs-migrations column diff found 4 more columns prod was missing:
  // organizations.{approval_thresholds,loyalty_config} (register-config
  // SELECTs them; missing -> per-org config silently inactive), auth_
  // credentials.pin_hash_prefix (PIN pre-filter), transaction_tenders.
  // is_refund. 084 re-adds them idempotently, mirroring migs 011/017/001.
  const src = read("supabase/migrations/084_prod_schema_drift_repair.sql");
  it("re-adds the four drifted columns idempotently", () => {
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS approval_thresholds jsonb NOT NULL DEFAULT/);
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS loyalty_config jsonb NOT NULL DEFAULT/);
    expect(src).toMatch(/ALTER TABLE auth_credentials ADD COLUMN IF NOT EXISTS pin_hash_prefix TEXT/);
    expect(src).toMatch(/ALTER TABLE transaction_tenders ADD COLUMN IF NOT EXISTS is_refund BOOLEAN NOT NULL DEFAULT false/);
  });
});

describe("SIM-AUDIT8-D: migration 085 re-creates the missing customer_display_state table", () => {
  // The prod-drift guardrail (check:prod-drift) found customer_display_state
  // — read/written by /api/customer-display — entirely absent in prod, 500ing
  // the customer display feature. 085 re-creates it idempotently.
  const src = read("supabase/migrations/085_customer_display_state_drift_repair.sql");
  it("creates the table idempotently with its 010 columns", () => {
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS customer_display_state/);
    expect(src).toMatch(/register_session_id UUID PRIMARY KEY/);
    expect(src).toMatch(/payment_status TEXT CHECK/);
  });
});

describe("SIM-AUDIT8-F: return reason is enum-validated (clean 400, not a DB-CHECK 500)", () => {
  it("rejects a reason outside the DB CHECK set and accepts a valid one", async () => {
    const { returnProcessSchema } = await import("@/lib/validation/schemas");
    const base = {
      transaction_id: "11111111-1111-4111-8111-111111111111",
      items: [{ variantId: "22222222-2222-4222-8222-222222222222", quantity: 1, unitPrice: 10 }],
      refund_amount: 10,
    };
    // 'damaged' was the admin UI's value — not in the DB CHECK -> must 400 now
    expect(returnProcessSchema.safeParse({ ...base, reason: "damaged" }).success).toBe(false);
    expect(returnProcessSchema.safeParse({ ...base, reason: "defective" }).success).toBe(true);
    expect(returnProcessSchema.safeParse({ ...base, reason: "changed_mind" }).success).toBe(true);
    // reason is still optional (handler defaults to 'other')
    expect(returnProcessSchema.safeParse(base).success).toBe(true);
  });

  it("admin/returns page no longer offers invalid reason values", () => {
    const src = read("src/app/admin/returns/page.tsx");
    for (const bad of ['value="damaged"', 'value="not_as_described"', 'value="customer_request"', 'value="sizing"']) {
      expect(src, `stale option ${bad} must be gone`).not.toContain(bad);
    }
    expect(src).toContain('value="defective"');
  });
});

describe("SIM-AUDIT8-G: returns/process refund cap + rate-limit calibration", () => {
  const src = read("src/app/api/returns/process/route.ts");
  it("caps the refund at the server-computed amount instead of hard-rejecting on mismatch", () => {
    expect(src).toMatch(/refund_amount = Math\.min\(refund_amount, computedRefundTotal\)/);
    // the brittle exact-match reject is gone
    expect(src).not.toMatch(/Refund amount mismatch: computed/);
  });
  it("uses a return-appropriate rate limit, not the PIN-brute-force default", () => {
    expect(src).toMatch(/checkRateLimit\(`returns:\$\{employeeId\}`, \{ maxAttempts: 20, windowMs: 300_000 \}\)/);
  });
});

describe("SIM-AUDIT8-E: the prod-drift guardrail itself", () => {
  it("findDrift separates missing columns from missing tables and is clean on parity", async () => {
    const { findDrift } = await import("../../../scripts/check-prod-drift.mjs");
    const ref = new Set(["t.a", "t.b", "gone_table.x"]);
    const prod = new Set(["t.a"]);
    const prodTables = new Set(["t"]);
    const { missingColumns, missingTables } = findDrift(ref, prod, prodTables);
    expect(missingColumns).toEqual(["t.b"]);          // column missing on an existing table
    expect(missingTables).toEqual(["gone_table"]);    // whole table absent
    const clean = findDrift(new Set(["t.a"]), new Set(["t.a"]), new Set(["t"]));
    expect(clean.missingColumns).toEqual([]);
    expect(clean.missingTables).toEqual([]);
  });
});
