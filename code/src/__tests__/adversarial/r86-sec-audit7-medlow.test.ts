/**
 * R86 / SEC-AUDIT7 — the deferred MEDIUM/LOW audit fixes.
 *
 *   MED1: cash-drawer calculateExpectedCash double-counted a cross-shift
 *         cash refund (scoped cash by tender date, not transaction date).
 *   MED2: shift-report close scoped expected cash by location_id, not
 *         register_session_id → concurrent registers cross-contaminate.
 *   MED3: invalidateInventoryCache fire-and-forgot the readStore cascade,
 *         so on a cold isolate ctx.waitUntil lost the race → 30s stale
 *         on_hand on transfers/receiving/PO/returns/barcode.
 *   LOW5: register_login_create_session lacked a cross-row org-consistency
 *         check (mig 077 parity).
 *   LOW6: gift-cards POST destructured schema fields from the raw body, not
 *         the validated v.data.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("SEC-AUDIT7-MED1: cash-drawer expected-cash scopes by transaction date", () => {
  const src = read("src/app/api/cash-drawer/route.ts");
  it("cash_net no longer scopes by the tender date (tt.created_at)", () => {
    expect(src).not.toMatch(/tt\.created_at >= s\.opened_at/);
    // The cash_net SUM(tt.amount) subquery now scopes by t.created_at.
    expect(src).toMatch(/SELECT SUM\(tt\.amount\) FROM transaction_tenders tt[\s\S]*?AND t\.created_at >= s\.opened_at/);
  });
});

describe("SEC-AUDIT7-MED2: shift-report close scopes expected cash by register session", () => {
  const src = read("src/app/api/shift-report/route.ts");
  it("cash_in + change_due use t.register_session_id, not t.location_id", () => {
    expect(src).toMatch(/cash_in[\s\S]*?WHERE t\.register_session_id = \$1/);
    expect(src).toMatch(/total_change[\s\S]*?WHERE t\.register_session_id = \$1/);
    expect(src).toMatch(/\[s\.register_session_id, s\.opened_at, orgId\]/);
  });
});

describe("SEC-AUDIT7-MED3: inventory-cache cascade is awaitable + awaited by reliant routes", () => {
  it("invalidateInventoryCache returns the adoption Promise", () => {
    const src = read("src/lib/cache/inventory-cache.ts");
    expect(src).toMatch(/export function invalidateInventoryCache\(orgId\?: string\): Promise<void>/);
    expect(src).toMatch(/return waitUntilOrAwait\(cascade\)/);
  });
  it("the 5 backstop-less routes await the cascade before responding", () => {
    for (const rel of [
      "src/app/api/purchase-orders/route.ts",
      "src/app/api/transfers/route.ts",
      "src/app/api/barcode-lookup/route.ts",
      "src/app/api/receiving/route.ts",
      "src/app/api/returns/route.ts",
    ]) {
      const src = read(rel);
      expect(src, `${rel} should await invalidateInventoryCache`).toMatch(/await invalidateInventoryCache\(orgId\)/);
      // and not leave a bare (un-awaited) call
      expect(src, `${rel} should have no un-awaited invalidateInventoryCache`).not.toMatch(/[^.\w]\n?\s*(?<!await )invalidateInventoryCache\(orgId\);/);
    }
  });
});

describe("SEC-AUDIT7-LOW5: register_login_create_session org-consistency guard", () => {
  const src = read("supabase/migrations/081_register_login_org_consistency.sql");
  it("CREATE OR REPLACE adds the cross-row org checks", () => {
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION public\.register_login_create_session/);
    expect(src).toMatch(/RAISE EXCEPTION 'Cross-tenant employee in register login'/);
    expect(src).toMatch(/RAISE EXCEPTION 'Cross-tenant location in register login'/);
  });
});

describe("SEC-AUDIT7-LOW5b: migration 082 re-pins search_path after 081's CREATE OR REPLACE", () => {
  // 081's CREATE OR REPLACE wiped the search_path proconfig that mig 052
  // had ALTER'd onto this SECURITY DEFINER fn (CREATE OR REPLACE resets
  // proconfig). 082 re-pins it the way 052 did, so the R21-H-3 integration
  // gate (no SECDEF fn in public.* may lack search_path) stays green.
  const src = read("supabase/migrations/082_register_login_create_session_search_path.sql");
  it("ALTERs register_login_create_session to SET search_path = public", () => {
    expect(src).toMatch(/ALTER FUNCTION public\.register_login_create_session\(text, text, text, text, text, text, timestamptz, timestamptz\)/);
    expect(src).toMatch(/SET search_path = public/);
  });
});

describe("SEC-AUDIT7-LOW6: gift-cards reads schema fields from validated v.data", () => {
  const src = read("src/app/api/gift-cards/route.ts");
  it("activate/reload/disable destructure from v.data (not raw body)", () => {
    expect(src).toMatch(/const \{ code, amount, customerId \} = v\.data/);
    expect(src).toMatch(/const \{ giftCardId, amount \} = v\.data/);
    expect(src).toMatch(/const \{ giftCardId \} = v\.data/);
  });
});
