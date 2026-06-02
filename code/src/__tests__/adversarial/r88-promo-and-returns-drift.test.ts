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
