/**
 * R29 regression tests.
 *
 * Pins the R29 findings delivered after the R28 sweep:
 *   C1 check_tender_sum exempts refund rows
 *   C2 checkout-action requires identified customer for per-customer-capped promos
 *   C3 promo-codes POST redeem enforces per-customer cap
 *   H1 points_earned persisted + refunds prorate reversal from it
 *   H2 offline-sync enforces per-customer cap
 *   M1 employees PATCH/PUT return generic permission errors
 *   M2 gift-card daily cap uses rolling 24h window
 *   M3 device cookie is HMAC-signed
 *   L1 admin returns/process rejects store_credit refund without customer
 *   L2 /api/transactions?customer=<id> validates the id belongs to the org
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R29 findings", () => {
  describe("C1 check_tender_sum exempts refund rows", () => {
    const mig = read("supabase/migrations/058_r28_m7_check_tender_sum.sql");
    it("short-circuits on NEW.amount < 0", () => {
      expect(mig).toMatch(/IF NEW\.amount < 0 THEN\s+RETURN NEW;/);
    });
    it("sums only positive tender rows on the invariant check", () => {
      expect(mig).toMatch(/WHERE transaction_id = NEW\.transaction_id AND amount >= 0/);
    });
  });

  describe("C2 per-customer promo cap requires identified customer", () => {
    const src = read("src/app/register/checkout-action.ts");
    it("refuses the promo when customerId is absent", () => {
      expect(src).toMatch(/Promo\+requires\+an\+identified\+customer/);
    });
    it("cap check no longer short-circuits on missing customer", () => {
      // Old shape: `if (promo.max_redemptions_per_customer && cart.customerId)`
      expect(src).not.toMatch(/if \(promo\.max_redemptions_per_customer && cart\.customerId\)/);
    });
  });

  describe("C3 promo-codes POST redeem enforces per-customer cap", () => {
    const src = read("src/app/api/promo-codes/route.ts");
    it("selects max_redemptions_per_customer on the FOR UPDATE lock", () => {
      expect(src).toMatch(/max_redemptions_per_customer,\s*\n\s*status, starts_at, expires_at/);
    });
    it("rejects when txn has no customer_id but promo is capped", () => {
      expect(src).toMatch(/Promo requires an identified customer on the transaction/);
    });
    it("counts prior per-customer redemptions + rejects at cap", () => {
      expect(src).toMatch(/Customer has reached the per-customer limit for this promo/);
    });
  });

  describe("H1 points_earned persisted + prorated reversal", () => {
    it("migration adds points_earned column", () => {
      const mig = read("supabase/migrations/059_r29_h1_points_earned.sql");
      expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS points_earned integer/);
      expect(mig).toMatch(/CHECK \(points_earned >= 0\)/);
    });
    it("checkout-action writes points_earned on the INSERT", () => {
      const src = read("src/app/register/checkout-action.ts");
      expect(src).toMatch(/points_earned\)\s*\n\s*VALUES/);
      expect(src).toMatch(/loyaltyPointsEarned,\s*\n\s*\]/);
    });
    it("offline-sync writes points_earned on the INSERT", () => {
      const src = read("src/app/api/offline-sync/route.ts");
      expect(src).toMatch(/points_earned\)\s*\n\s*VALUES/);
      expect(src).toMatch(/insertLoyaltyPointsEarned/);
    });
    it("register return-action prorates from origPointsEarned", () => {
      const src = read("src/app/register/return-action.ts");
      expect(src).toMatch(/origPointsEarned/);
      // R40-2: per-refund `refundGrandTotal/origGrandTotal` → cumulative
      // `newCumulativeAbs / origGrandTotal` and `priorRefundAbs / origGrandTotal`.
      // Ratio still derives from refundGrandTotal over origGrandTotal,
      // just bounded across refunds.
      expect(src).toMatch(/newCumulativeAbs \/ origGrandTotal/);
    });
    it("admin returns/process prorates from points_earned", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/origPointsEarned/);
      // R40-2: cumulative-share clamp — priorRefundTotal includes both
      // admin-side (returns table) and register-side (transactions with
      // cart_snapshot.originalTransactionId) prior refunds, divided by
      // origGrandTotal to compute the new expected reversal.
      expect(src).toMatch(/newCumulative \/ origGrandTotal/);
    });
  });

  describe("H2 offline-sync enforces per-customer cap", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    it("FOR UPDATE lock selects max_redemptions_per_customer", () => {
      expect(src).toMatch(/max_redemptions_per_customer/);
    });
    it("raises PromoRevalidationError on cap miss", () => {
      expect(src).toMatch(/promo_per_customer_cap_reached/);
      expect(src).toMatch(/promo_requires_identified_customer/);
    });
    it("counts prior redemptions by the same customer in this org", () => {
      expect(src).toMatch(/FROM promo_redemptions pr\s+JOIN transactions t ON t\.id = pr\.transaction_id\s+WHERE pr\.promo_code_id = \$1\s+AND t\.customer_id = \$2\s+AND t\.organization_id = \$3\s+AND t\.id <> \$4/);
    });
  });

  describe("M1 employees PATCH/PUT generic permission error", () => {
    const src = read("src/app/api/employees/route.ts");
    it("PATCH returns 'Insufficient permissions to manage this employee'", () => {
      expect(src).toMatch(/Insufficient permissions to manage this employee/);
    });
    it("PUT returns 'Insufficient permissions to edit this employee'", () => {
      expect(src).toMatch(/Insufficient permissions to edit this employee/);
    });
    it("no longer leaks role in the error message", () => {
      expect(src).not.toMatch(/Cannot manage a \$\{targetRole\}/);
      expect(src).not.toMatch(/Cannot edit a \$\{targetRole\}/);
    });
  });

  describe("M2 gift-card cap rolling 24h window", () => {
    const src = read("src/app/api/gift-cards/route.ts");
    it("activation branch uses rolling 24h window", () => {
      // Both references must now be interval-based.
      expect(src).not.toMatch(/date_trunc\('day', now\(\) AT TIME ZONE 'UTC'\)/);
      const matches = src.match(/now\(\) - interval '24 hours'/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("M3 device cookie is HMAC-signed", () => {
    it("device-cookie helper exposes sign + verify", () => {
      const src = read("src/lib/auth/device-cookie.ts");
      expect(src).toMatch(/export async function signDeviceId/);
      expect(src).toMatch(/export async function verifyDeviceIdCookie/);
      expect(src).toMatch(/crypto\.subtle\.sign\("HMAC"/);
    });
    it("register-login emits the signed value", () => {
      const src = read("src/app/api/auth/register-login/route.ts");
      expect(src).toMatch(/signDeviceId\(deviceId\)/);
      expect(src).toMatch(/bupos_register_device=\$\{encodeURIComponent\(signedDevice\)\}/);
    });
    it("session.ts verifies signed cookie on read", () => {
      const src = read("src/lib/auth/session.ts");
      expect(src).toMatch(/verifyDeviceIdCookie\(decoded\)/);
    });
  });

  describe("L1 admin returns/process rejects store_credit without customer", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("refuses with 400 when no customer can be resolved", () => {
      expect(src).toMatch(/Store-credit refund requires a customer on the original transaction/);
    });
    it("no longer silently skips when custResult is empty", () => {
      // Prior pattern: `if (custResult.rows.length > 0)`
      expect(src).not.toMatch(/if \(custResult\.rows\.length > 0\)/);
    });
  });

  describe("L2 /api/transactions validates customer belongs to org", () => {
    const src = read("src/app/api/transactions/route.ts");
    it("looks up the customer in-org before appending the WHERE", () => {
      expect(src).toMatch(/FROM customers WHERE id = \$1 AND organization_id = \$2 LIMIT 1/);
    });
    it("returns 404 on unknown customer", () => {
      expect(src).toMatch(/error: "Customer not found"/);
    });
  });
});
