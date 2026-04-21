/**
 * R28 MEDIUM + LOW cleanup regression tests.
 *
 * Pins: M1/M10 timing+rate-limit on password-reset-initiate,
 * M3 spoof-resistant IP, M5 shared escapeHtml, M6 per-customer promo
 * cap, M7 check_tender_sum trigger migration, M8 gift-card daily cap,
 * M9 refund tax-rate cap, M11 revoke re-auth, M12 structured resend-
 * missing log, L1 tighter pwd-change RL, L2 atomic counter CTE,
 * L3 barcode-lookup withAdminAuth, L4+L5 LEFT JOIN org-gates,
 * L6 hashSecret outside tx, L7 guardrail scans src/lib/auth,
 * L8 CORS headers only on allowed origin, L9 approval-burn code-set.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R28 MEDIUM+LOW cleanup", () => {
  describe("M1+M10 password-reset-initiate", () => {
    const src = read("src/app/api/auth/password-reset-initiate/route.ts");

    it("uses a finish() wrapper that pads to MIN_DURATION_MS", () => {
      expect(src).toMatch(/MIN_DURATION_MS = 500/);
      expect(src).toMatch(/setTimeout\(r, MIN_DURATION_MS - elapsed\)/);
    });

    it("layers KV rate-limit buckets", () => {
      expect(src).toMatch(/checkKvRateLimit\([^)]*pwd-reset-ip:/);
      expect(src).toMatch(/checkKvRateLimit\([^)]*pwd-reset-email:/);
    });

    it("layers DB rate-limit buckets", () => {
      expect(src).toMatch(/checkDbRateLimit\([^)]*pwd-reset-ip:/);
      expect(src).toMatch(/checkDbRateLimit\([^)]*pwd-reset-email:/);
    });

    it("every return goes through finish()", () => {
      // Count bare `return NextResponse.json({ ok: true })` — should be 0.
      const bare = src.match(/return NextResponse\.json\(\{ ok: true \}\)/g) ?? [];
      expect(bare.length).toBe(0);
      // And `return finish(ok())` should appear multiple times.
      const wrapped = src.match(/return finish\(ok\(\)\)/g) ?? [];
      expect(wrapped.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("M3 spoof-resistant client IP", () => {
    it("client-ip helper gates XFF behind TRUST_FORWARDED_FOR", () => {
      const src = read("src/lib/net/client-ip.ts");
      expect(src).toMatch(/TRUST_FORWARDED_FOR/);
      expect(src).toMatch(/const trustXff = process\.env\.TRUST_FORWARDED_FOR === "1"/);
    });

    it("every auth route uses the helper (no raw XFF fallbacks)", () => {
      for (const rel of [
        "src/app/api/auth/register-login/route.ts",
        "src/app/api/auth/password-reset-initiate/route.ts",
        "src/app/api/auth/password-reset-confirm/route.ts",
        "src/app/actions/auth.ts",
      ]) {
        const src = read(rel);
        expect(src).toMatch(/clientIpFrom/);
        // No raw `x-forwarded-for` reads in the code that aren't
        // comments (headers.get calls on the raw name).
        expect(src).not.toMatch(/\.headers\.get\("x-forwarded-for"\)/);
        expect(src).not.toMatch(/requestHeaders\.get\("x-forwarded-for"\)/);
      }
    });
  });

  describe("M5 shared escapeHtml covers quote chars", () => {
    const src = read("src/lib/format/html-escape.ts");
    it("covers & < > \" '", () => {
      expect(src).toMatch(/&amp;/);
      expect(src).toMatch(/&lt;/);
      expect(src).toMatch(/&gt;/);
      expect(src).toMatch(/&quot;/);
      expect(src).toMatch(/&#39;/);
    });
  });

  describe("M6 per-customer promo cap", () => {
    it("schema column added (migration 057)", () => {
      const mig = read("supabase/migrations/057_r28_m6_promo_per_customer_cap.sql");
      expect(mig).toMatch(/max_redemptions_per_customer/);
      expect(mig).toMatch(/promo_codes_max_per_customer_nonneg/);
    });

    it("checkout checks per-customer redemption count", () => {
      const src = read("src/app/register/checkout-action.ts");
      expect(src).toMatch(/promo\.max_redemptions_per_customer/);
      expect(src).toMatch(/FROM promo_redemptions pr[\s\S]*?JOIN transactions t/);
    });

    it("promo POST writes the new column", () => {
      const src = read("src/app/api/promo-codes/route.ts");
      expect(src).toMatch(/max_redemptions_per_customer/);
    });
  });

  describe("M7 check_tender_sum DB trigger", () => {
    const mig = read("supabase/migrations/058_r28_m7_check_tender_sum.sql");
    it("creates a deferred constraint trigger", () => {
      expect(mig).toMatch(/CREATE CONSTRAINT TRIGGER trg_check_tender_sum/);
      expect(mig).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
    });
    it("only enforces for status = 'completed'", () => {
      expect(mig).toMatch(/v_txn_status IS DISTINCT FROM 'completed'/);
    });
    it("tolerates 0.01 floating-point drift", () => {
      // R29-C1 renamed v_tender_sum to v_positive_tender_sum (refund
      // rows are now excluded so the invariant sums only positive
      // tenders against grand_total).
      expect(mig).toMatch(/ABS\(v_positive_tender_sum - v_grand_total\) > 0\.01/);
    });
  });

  describe("M8 gift-card per-actor daily cap", () => {
    const src = read("src/app/api/gift-cards/route.ts");
    it("activation branch applies MAX_DAILY_MINT_PER_ACTOR", () => {
      expect(src).toMatch(/MAX_DAILY_MINT_PER_ACTOR = 25_000/);
    });
    it("reload branch applies the same cap", () => {
      const matches = src.match(/MAX_DAILY_MINT_PER_ACTOR = 25_000/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
    it("cap query aggregates activations + reloads", () => {
      expect(src).toMatch(/transaction_type IN \('activation', 'reload'\)/);
    });
  });

  describe("M9 register-side refund tax-rate cap", () => {
    const src = read("src/app/register/return-action.ts");
    it("caps origTaxRate at 0.5", () => {
      expect(src).toMatch(/Math\.min\(0\.5, Math\.max\(0, rawRate\)\)/);
    });
  });

  describe("M11 revoke-all-sessions requires re-auth", () => {
    const src = read("src/app/api/auth/revoke-all-sessions/route.ts");
    it("validates currentPassword via Zod", () => {
      expect(src).toMatch(/revokeSchema = z\.object\(\{\s*currentPassword/);
    });
    it("verifies via verifySecret + decoy on miss", () => {
      expect(src).toMatch(/verifySecret\(currentPassword, currentHash\)/);
      expect(src).toMatch(/runDecoyVerify\(currentPassword\)/);
    });
  });

  describe("M12 structured log when RESEND_API_KEY missing", () => {
    const src = read("src/app/api/auth/password-reset-initiate/route.ts");
    it("logs a structured event instead of an opaque string", () => {
      expect(src).toMatch(/resend_api_key_missing/);
    });
  });

  describe("L1 password-change tighter RL", () => {
    const src = read("src/app/api/auth/password-change/route.ts");
    it("in-mem max 3 / 5min", () => {
      expect(src).toMatch(/maxAttempts: 3, windowMs: 300_000 \}/);
    });
    it("KV max 4 / 5min", () => {
      expect(src).toMatch(/maxAttempts: 4, windowMs: 300_000 \}/);
    });
  });

  describe("L2 atomic counter CTE", () => {
    const src = read("src/app/api/auth/register-login/route.ts");
    it("uses a CTE that atomically reads + decays", () => {
      expect(src).toMatch(/WITH snapshot AS/);
      expect(src).toMatch(/decayed AS \(\s*UPDATE auth_credentials/);
    });
    it("returns effective_attempts (not raw failed_pin_attempts)", () => {
      expect(src).toMatch(/effective_attempts/);
    });
  });

  describe("L3 barcode-lookup POST is admin-only", () => {
    const src = read("src/app/api/barcode-lookup/route.ts");
    it("POST uses withAdminAuth, GET stays withDualAuth", () => {
      expect(src).toMatch(/export const POST = withAdminAuth\("catalog\.manage"/);
      expect(src).toMatch(/export const GET = withDualAuth\("catalog\.manage"/);
    });
  });

  describe("L4+L5 LEFT JOIN org-gates", () => {
    it("export transactions LEFT JOIN employees/customers gated", () => {
      const src = read("src/app/api/export/route.ts");
      expect(src).toMatch(/LEFT JOIN employees e ON e\.id = t\.employee_id AND e\.organization_id/);
      expect(src).toMatch(/LEFT JOIN customers c ON c\.id = t\.customer_id AND c\.organization_id/);
    });
    it("store-credit per-customer ledger LEFT JOIN gated", () => {
      const src = read("src/app/api/store-credit/route.ts");
      expect(src).toMatch(/LEFT JOIN employees e ON e\.id = scl\.employee_id AND e\.organization_id/);
    });
  });

  describe("L6 hashSecret outside tx in password-reset-confirm", () => {
    const src = read("src/app/api/auth/password-reset-confirm/route.ts");
    it("computes newHash before opening the client transaction", () => {
      const hashIdx = src.indexOf("await hashSecret(newPassword)");
      const beginIdx = src.indexOf('client.query("BEGIN")');
      expect(hashIdx).toBeGreaterThan(-1);
      expect(beginIdx).toBeGreaterThan(-1);
      expect(hashIdx).toBeLessThan(beginIdx);
    });
  });

  describe("L7 guardrail scans src/lib/auth", () => {
    const src = read("scripts/check-pool-query-org-filter.mjs");
    it("SCAN_DIRS includes src/lib/auth", () => {
      expect(src).toMatch(/"src\/lib\/auth"/);
    });
  });

  describe("L8 CORS Methods/Headers only on allowed origins", () => {
    const src = read("middleware.ts");
    it("ACAM/ACAH/MaxAge live inside `if (originAllowed)`", () => {
      // The non-preflight block should have all four CORS header sets
      // inside one if-block. Find the originAllowed block and verify
      // all four are INSIDE it (before the closing brace).
      const idx = src.indexOf("const originAllowed = origin && allowedOrigins");
      expect(idx).toBeGreaterThan(-1);
      // Slice until the comment marker for the NEXT section
      // ("// Prevent MIME type sniffing").
      const endIdx = src.indexOf("// Prevent MIME type sniffing", idx);
      const window = src.slice(idx, endIdx);
      expect(window).toMatch(/Access-Control-Allow-Methods/);
      expect(window).toMatch(/Access-Control-Allow-Headers/);
      expect(window).toMatch(/Access-Control-Max-Age/);
    });
  });

  describe("L9 approval-burn verifies code set, not just length", () => {
    const src = read("src/app/register/checkout-action.ts");
    it("builds a Set of burned codes + checks each requested code is present", () => {
      expect(src).toMatch(/const burnedCodes = new Set/);
      expect(src).toMatch(/pendingExceptions\.find\(\(code\) => !burnedCodes\.has\(code\)\)/);
    });
  });
});
