/**
 * R38 regression tests. Pins the findings from three parallel audits:
 *   A — cashier-as-attacker exploit surface
 *   B — DB migration archaeology
 *   C — edge / CDN / Worker runtime
 * Plus the interop between them (amount-scoped approvals, tamper-
 * proof triggers with explicit carve-outs, etc.).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R38 findings", () => {
  describe("R38-A-F1: line-level discounts now gated by the manager threshold", () => {
    it("checkout-action sums cart + line discount for the gate", () => {
      const src = read("src/app/register/checkout-action.ts");
      expect(src).toMatch(/totalDiscountEffective = Number\(\(baseCartDiscountEffective \+ lineDiscountsTotal\)\.toFixed\(2\)\)/);
      expect(src).toMatch(/totalDiscountEffective >= thresholds\.discountOver/);
    });
    it("offline-sync gates on the combined discountTotal (line + cart)", () => {
      const src = read("src/app/api/offline-sync/route.ts");
      expect(src).toMatch(/discountTotal >= thresholds\.discountOver/);
      expect(src).toMatch(/storeCreditTendered >= thresholds\.storeCreditIssuanceOver/);
    });
  });

  describe("R38-A-F2: approval exceptions are amount-scoped", () => {
    const action = read("src/app/register/approval-action.ts");
    const checkout = read("src/app/register/checkout-action.ts");
    const mig = read("supabase/migrations/067_r38_hardening.sql");
    it("migration adds approved_amount column", () => {
      expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS approved_amount NUMERIC\(12,2\)/);
    });
    it("approval-action persists approved_amount for amount-scoped action types", () => {
      expect(action).toMatch(/approved_amount/);
      expect(action).toMatch(/amountScoped =\s*\n[\s\S]+?"discount_threshold"/);
    });
    it("checkout reads approved_amount + verifies applied <= approved", () => {
      expect(checkout).toMatch(/SELECT exception_code, approved_amount FROM register_session_exceptions/);
      expect(checkout).toMatch(/amountApprovedFor/);
      expect(checkout).toMatch(/approvedAmountByCode/);
    });
    it("gate uses amountApprovedFor for discount, store_credit, price_override", () => {
      expect(checkout).toMatch(/amountApprovedFor\("discount_threshold", totalDiscountEffective\)/);
      expect(checkout).toMatch(/amountApprovedFor\("store_credit_threshold", baseStoreCreditTendered\)/);
      expect(checkout).toMatch(/amountApprovedFor\("price_override", overrideDollarImpact\)/);
    });
  });

  describe("R38-A-F3: /api/returns/process enforces return threshold", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("reads returnWithoutManagerOver + checks role", () => {
      expect(src).toMatch(/returnWithoutManagerOver/);
      expect(src).toMatch(/refund_amount >= returnThreshold && !isManagerRole/);
    });
  });

  describe("R38-A-F4: layaway store_credit tender actually debits balance", () => {
    const src = read("src/app/register/layaway-action.ts");
    it("SELECTs FOR UPDATE + UPDATE customers + store_credit_ledger INSERT when tender=store_credit", () => {
      expect(src).toMatch(/tenderType === "store_credit"/);
      expect(src).toMatch(/UPDATE customers SET store_credit_balance/);
      expect(src).toMatch(/INSERT INTO store_credit_ledger[\s\S]+?'redemption'/);
    });
  });

  describe("R38-A-F5: receiving quantity capped per line", () => {
    const src = read("src/lib/validation/schemas.ts");
    it("receiving uses a tighter 10,000-unit per-line cap", () => {
      expect(src).toMatch(/receivingQuantity = z\.number\(\)\.int\(\)\.positive\(\)\.max\(10_000\)/);
    });
  });

  describe("R38-A-F6: pay_in has an approval gate, pay_out/pay_in use >=", () => {
    const src = read("src/app/api/cash-drawer/route.ts");
    it("pay_out uses >= threshold", () => {
      expect(src).toMatch(/!isManager && numericAmount >= payoutThreshold/);
    });
    it("handlePayIn takes actorRoleKey + gates non-manager >= threshold with approval consume", () => {
      expect(src).toMatch(/async function handlePayIn\([\s\S]+?actorRoleKey: import/);
      expect(src).toMatch(/!isManager && numericAmount >= payinThreshold/);
      expect(src).toMatch(/UPDATE register_session_exceptions[\s\S]+?exception_code = 'cash_payout'/);
    });
  });

  describe("R38-A-F9: stocktake accept caps per-line applied delta", () => {
    const src = read("src/app/admin/stocktake-actions.ts");
    it("enforces perLineDeltaCap based on role", () => {
      expect(src).toMatch(/perLineDeltaCap = isManagerOrOwner2 \? 5_000 : 500/);
      expect(src).toMatch(/exceeds per-line cap/);
    });
  });

  describe("R38-A-F11: regular lines reject deactivated variants", () => {
    const src = read("src/app/register/checkout-action.ts");
    it("dbActiveByVariant check on regular lines before price match", () => {
      const block = src.slice(src.indexOf("Validate regular lines"));
      expect(block.slice(0, 1200)).toMatch(/dbActiveByVariant\[item\.productVariantId\] === false/);
      expect(block.slice(0, 1200)).toMatch(/Product\+is\+no\+longer\+available/);
    });
  });

  describe("R38-B-F1: REVOKE FROM anon on every customer-data table", () => {
    const mig = read("supabase/migrations/067_r38_hardening.sql");
    it("revokes anon + authenticated from the customer-data tables", () => {
      // Per-table REVOKE runs through a DO block with a quoted array so
      // missing tables just skip instead of aborting the migration.
      expect(mig).toMatch(/REVOKE ALL ON TABLE public\.%I FROM anon, authenticated/);
      expect(mig).toMatch(/'organizations'/);
      expect(mig).toMatch(/'audit_events'/);
      expect(mig).toMatch(/'rate_limit_buckets'/);
    });
    it("rate_limit_buckets policy now scoped to service_role", () => {
      expect(mig).toMatch(/CREATE POLICY rate_limit_buckets_all ON rate_limit_buckets[\s\S]+?FOR ALL TO service_role/);
    });
  });

  describe("R38-B-F2: pay_in_outs RLS pivots on organization_id", () => {
    const mig = read("supabase/migrations/067_r38_hardening.sql");
    it("drops the old location-JOIN policy + creates org-pivot one", () => {
      expect(mig).toMatch(/DROP POLICY parent_org_isolation ON pay_in_outs/);
      expect(mig).toMatch(/CREATE POLICY pay_in_outs_org_isolation ON pay_in_outs[\s\S]+?organization_id::text = current_setting\('app\.current_org_id', true\)/);
    });
  });

  describe("R38-B-F3: migration 033 idempotent", () => {
    const mig = read("supabase/migrations/033_promo_free_item.sql");
    it("idx_promo_codes_free_variant_id uses IF NOT EXISTS", () => {
      expect(mig).toMatch(/CREATE INDEX IF NOT EXISTS idx_promo_codes_free_variant_id/);
    });
  });

  describe("R38-B-F4/F6/F7/F10/F11: schema cleanup", () => {
    const mig = read("supabase/migrations/067_r38_hardening.sql");
    it("drops dead check_tender_sum_stmt()", () => {
      expect(mig).toMatch(/DROP FUNCTION IF EXISTS check_tender_sum_stmt\(\) CASCADE/);
    });
    it("drops duplicate idempotency indexes", () => {
      expect(mig).toMatch(/DROP INDEX IF EXISTS idx_returns_idempotency/);
      expect(mig).toMatch(/DROP INDEX IF EXISTS idx_transfers_idempotency/);
      expect(mig).toMatch(/DROP INDEX IF EXISTS idx_shifts_idempotency/);
    });
    it("drops redundant transaction indexes", () => {
      expect(mig).toMatch(/DROP INDEX IF EXISTS idx_transactions_status/);
      expect(mig).toMatch(/DROP INDEX IF EXISTS idx_transactions_location_status_created/);
    });
    it("moves pg_trgm out of public + drops unused uuid-ossp", () => {
      expect(mig).toMatch(/ALTER EXTENSION pg_trgm SET SCHEMA extensions/);
      expect(mig).toMatch(/DROP EXTENSION IF EXISTS "uuid-ossp"/);
    });
  });

  describe("R38-B-F9: tamper-proof triggers on write-once tables", () => {
    const mig = read("supabase/migrations/067_r38_hardening.sql");
    it("attaches audit_events_prevent_tamper to transaction_tenders / events / pay_in_outs / layaway_payments", () => {
      expect(mig).toMatch(/'transaction_tenders'/);
      expect(mig).toMatch(/'transaction_events'/);
      expect(mig).toMatch(/'pay_in_outs'/);
      expect(mig).toMatch(/'layaway_payments'/);
    });
    it("promo_redemptions gets UPDATE + TRUNCATE but NOT DELETE (refund legitimate)", () => {
      expect(mig).toMatch(/trg_promo_redemptions_no_update/);
      expect(mig).toMatch(/trg_promo_redemptions_no_truncate/);
      // DELETE trigger would break the register refund flow.
      expect(mig).not.toMatch(/trg_promo_redemptions_no_delete/);
    });
  });

  describe("R38-C-C1: CSP no longer falls back to wildcard Supabase", () => {
    const src = read("middleware.ts");
    it("throws in production when SUPABASE_URL is missing", () => {
      expect(src).toMatch(/function resolveSupabaseUrl\(\)/);
      expect(src).toMatch(/NODE_ENV === 'production'[\s\S]+?throw new Error/);
    });
    it("CSP uses the resolved supabase URL constant", () => {
      expect(src).toMatch(/SUPABASE_URL_FOR_CSP/);
    });
  });

  describe("R38-C-C2: workers_dev disabled", () => {
    const cfg = read("wrangler.jsonc");
    it("wrangler.jsonc sets workers_dev: false", () => {
      expect(cfg).toMatch(/"workers_dev":\s*false/);
    });
  });

  describe("R38-C-H3: CSP hardened with object/frame/worker/manifest/upgrade", () => {
    const src = read("middleware.ts");
    it("adds object-src 'none'", () => expect(src).toMatch(/object-src 'none'/));
    it("adds frame-src 'none'", () => expect(src).toMatch(/frame-src 'none'/));
    it("adds worker-src 'self'", () => expect(src).toMatch(/worker-src 'self'/));
    it("adds manifest-src 'self'", () => expect(src).toMatch(/manifest-src 'self'/));
    it("adds upgrade-insecure-requests", () => expect(src).toMatch(/upgrade-insecure-requests/));
  });

  describe("R38-C-H4: HSTS preload-ready", () => {
    const src = read("middleware.ts");
    it("2-year max-age + includeSubDomains + preload", () => {
      expect(src).toMatch(/max-age=63072000; includeSubDomains; preload/);
    });
  });

  describe("R38-C-H8: checkOrigin drops the hardcoded secondary host", () => {
    const src = read("src/lib/api/with-auth.ts");
    it("bupos.basicuniform.com no longer in the allowlist", () => {
      // The allowlist Set no longer pre-seeds the stale host.
      const fn = src.slice(src.indexOf("export function checkOrigin"), src.indexOf("export function checkOrigin") + 2000);
      expect(fn).not.toMatch(/"https:\/\/bupos\.basicuniform\.com"/);
    });
  });

  describe("R38-C-H9: /api/internal/run-cleanup replay protection", () => {
    const src = read("src/app/api/internal/run-cleanup/route.ts");
    it("accepts x-cleanup-ts + HMAC-signed bearer", () => {
      expect(src).toMatch(/x-cleanup-ts/);
      expect(src).toMatch(/Math\.abs\(Date\.now\(\) - ts\) > 60_000/);
      expect(src).toMatch(/constant-time compare/i);
    });
  });

  describe("R38-C-M11: OPTIONS preflight doesn't leak ACA headers for disallowed origins", () => {
    const src = read("middleware.ts");
    it("Methods/Headers/Max-Age only emitted when origin allowed", () => {
      // The OPTIONS branch wraps Access-Control-Allow-Methods inside the allowlist check.
      const options = src.slice(src.indexOf("request.method === 'OPTIONS'"));
      const block = options.slice(0, 1200);
      expect(block).toMatch(/allowedOrigins\.includes\(origin\)[\s\S]+?Access-Control-Allow-Methods/);
    });
  });

  describe("R38-C-M14: middleware matcher excludes /sw.js", () => {
    const src = read("middleware.ts");
    it("matcher exclusion list contains sw\\.js", () => {
      expect(src).toMatch(/sw\\\\\.js/);
    });
  });
});
