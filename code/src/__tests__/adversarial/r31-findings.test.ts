/**
 * R31 regression tests. Pins the round-31 findings landed after the
 * R30 sweep + the two R30 regressions the R31 audit uncovered.
 *
 * Notation: "REG-R30" flags a fix that pins a regression of a prior
 * R30 fix; "R31-*" flags a new R31 finding.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R31 findings", () => {
  describe("REG-R30-H3: PUT handler self-mgmt + owner-on-owner", () => {
    const src = read("src/app/api/employees/route.ts");
    it("PUT blocks self-edit of role/email/locationIds/isActive", () => {
      expect(src).toMatch(/You cannot change your own role, email, locations, or activation/);
    });
    it("PUT blocks owner-on-owner mutations", () => {
      const hits = src.match(/actor\.roleKey === 'owner' && targetRole === 'owner'/g) ?? [];
      expect(hits.length).toBeGreaterThanOrEqual(2); // PATCH + PUT
    });
  });

  describe("REG-R30-M3: resolve_register_session defers last_seen_at", () => {
    const mig = read("supabase/migrations/060_r31_c2_defer_last_seen_bump.sql");
    it("migration removes the in-RPC last_seen_at UPDATE", () => {
      expect(mig).toMatch(/DO NOT bump last_seen_at here/);
      // Explicitly: no UPDATE sessions SET last_seen_at inside the RPC.
      const body = mig.slice(mig.indexOf("CREATE OR REPLACE FUNCTION resolve_register_session"));
      expect(body).not.toMatch(/UPDATE sessions SET last_seen_at/);
    });
  });

  describe("R31-C3/C4/C5/M3/M10 schema hardening", () => {
    const mig = read("supabase/migrations/061_r31_schema_hardening.sql");
    it("returns.organization_id FK added", () => {
      expect(mig).toMatch(/ADD CONSTRAINT returns_organization_id_fkey/);
    });
    it("returns.return_number unique scoped per-org", () => {
      expect(mig).toMatch(/uniq_returns_org_return_number/);
      expect(mig).toMatch(/DROP CONSTRAINT returns_return_number_key/);
    });
    it("audit_events tamper trigger installed", () => {
      expect(mig).toMatch(/audit_events_prevent_tamper/);
      expect(mig).toMatch(/BEFORE UPDATE ON audit_events/);
      expect(mig).toMatch(/BEFORE DELETE ON audit_events/);
    });
    it("promo_redemptions unique (promo_code_id, transaction_id)", () => {
      expect(mig).toMatch(/uniq_promo_redemptions_promo_txn/);
    });
    it("products.slug + categories.slug per-org unique", () => {
      expect(mig).toMatch(/uniq_products_org_slug/);
      expect(mig).toMatch(/uniq_categories_org_slug/);
    });
  });

  describe("R31-H1: stocktake location gate", () => {
    const src = read("src/app/admin/stocktake-actions.ts");
    it("helper `requireStocktakeLocationAccess` defined", () => {
      expect(src).toMatch(/requireStocktakeLocationAccess/);
    });
    it("recordCount rejects foreign-location + finalized stocktakes", () => {
      expect(src).toMatch(/Cannot record count on \$\{stocktakeStatus\} stocktake/);
    });
    it("acceptStocktakeAction gates on location", () => {
      const hits = src.match(/employee\.locationIds \?\? \[\]\)\.includes\(stocktakeLocationId\)/g) ?? [];
      expect(hits.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("R31-H2/H3: inventory adjust cross-location + rate limit", () => {
    const src = read("src/app/admin/actions.ts");
    it("per-employee rate limit on adjustInventoryAction", () => {
      expect(src).toMatch(/inventory-adjust:\$\{employee\.organizationId\}:\$\{employee\.id\}/);
    });
    it("cross-location gate checks employee.locationIds", () => {
      expect(src).toMatch(/employee\.locationIds \?\? \[\]\)\.includes\(invLocationId\)/);
    });
  });

  describe("R31-H4: barcode-lookup image_url https-only", () => {
    const src = read("src/app/api/barcode-lookup/route.ts");
    it("refuses non-https schemes", () => {
      expect(src).toMatch(/image_url must be an https URL/);
      expect(src).toMatch(/javascript\|data\|vbscript\|file/);
    });
  });

  describe("R31-H5: admin refund paths use shared advisory lock", () => {
    it("/api/returns/process acquires pg_advisory_xact_lock on return:<txn>", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/pg_advisory_xact_lock/);
      expect(src).toMatch(/`return:\$\{transaction_id\}`/);
    });
    it("/api/returns POST also acquires it", () => {
      const src = read("src/app/api/returns/route.ts");
      expect(src).toMatch(/pg_advisory_xact_lock/);
      expect(src).toMatch(/`return:\$\{transaction_id\}`/);
    });
  });

  describe("R31-H6: receiving PO line FOR UPDATE", () => {
    const src = read("src/app/api/receiving/route.ts");
    it("FOR UPDATE OF pol locks the PO line before clamp", () => {
      expect(src).toMatch(/FOR UPDATE OF pol/);
    });
  });

  describe("R31-H7: checkout double-click guards", () => {
    it("client has ref-based re-entry guard", () => {
      const src = read("src/components/register/usePOSTerminal.ts");
      expect(src).toMatch(/checkoutInFlightRef/);
      expect(src).toMatch(/if \(checkoutInFlightRef\.current\) return;/);
    });
    it("server derives deterministic idempotency key when caller omits one", () => {
      const src = read("src/app/register/checkout-action.ts");
      expect(src).toMatch(/effectiveIdempotencyKey/);
      expect(src).toMatch(/`cart:\$\{context\.employee\.organizationId\}:\$\{cart\.id\}`/);
    });
  });

  describe("R31-H8/H9: /api/returns POST paidQuantity + weighted-avg", () => {
    it("returns/route.ts POST tracks paidQuantity", () => {
      const src = read("src/app/api/returns/route.ts");
      expect(src).toMatch(/paidQuantity/);
      expect(src).toMatch(/paidShare = Math\.min\(line\.quantity, paidRemaining\)/);
    });
    it("returns/process.ts uses weighted paidSubtotal / paidQuantity", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/paidSubtotal/);
      expect(src).toMatch(/weightedPaidUnit = orig\.paidQuantity > 0 \? orig\.paidSubtotal \/ orig\.paidQuantity/);
    });
  });

  describe("R31-H10: loyalty audit-insert atomic with UPDATE", () => {
    const src = read("src/app/api/loyalty/route.ts");
    it("orgTx wraps the cap check + UPDATE + audit INSERT", () => {
      expect(src).toMatch(/cap counter can never lag the real[\s\S]*?mint/);
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'loyalty_adjusted'/);
    });
    it("no longer relies on waitUntilOrAwait(pgInsertAuditEvent)", () => {
      expect(src).not.toMatch(/waitUntilOrAwait\(pgInsertAuditEvent/);
    });
  });

  describe("R31-H11: admin returns/process location gate", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("non-manager blocked when origLocationId not in locationIds", () => {
      expect(src).toMatch(/Return must be processed at the originating location, or by a manager/);
    });
  });

  describe("R31-M1: pinHint requires at least one letter", () => {
    const src = read("src/lib/validation/schemas.ts");
    it("unicode-aware letter check", () => {
      expect(src).toMatch(/\/\\p\{L\}\/u/);
      expect(src).toMatch(/PIN hint must contain at least one letter/);
    });
  });

  describe("R31-M2: overridePrice clamp", () => {
    it("cart.ts setPriceOverride clamps at 0", () => {
      const src = read("src/lib/cart/cart.ts");
      expect(src).toMatch(/const clamped = overridePrice === undefined \? undefined : Math\.max\(0, overridePrice\)/);
    });
    it("checkout-action rejects negative overridePrice", () => {
      const src = read("src/app/register/checkout-action.ts");
      expect(src).toMatch(/Invalid\+price\+override/);
    });
    it("offline-sync rejects negative overridePrice", () => {
      const src = read("src/app/api/offline-sync/route.ts");
      expect(src).toMatch(/Invalid price override/);
    });
  });

  describe("R31-M3: service worker skips authenticated pages (R44-FE4 shifted to allowlist)", () => {
    const src = read("public/sw.js");
    it("allowlist-based: only public pages (/, /login, /signup, /forgot-password) are cached", () => {
      // R44-FE4 migrated from a blocklist (enumerate auth routes) to
      // an allowlist (only known public routes). Safer for new routes
      // that get added without a matching SW update.
      expect(src).toMatch(/const publicPaths = \["\/", "\/login", "\/signup", "\/forgot-password"\]/);
      expect(src).toMatch(/isAuthenticatedPage = !isPublicPage/);
    });
    it("offline fallback for auth pages returns bare Offline page, not cached", () => {
      expect(src).toMatch(/<h1>Offline<\/h1>/);
    });
  });

  describe("R31-M4: gift-cards + store-credit 24h cap inside tx", () => {
    it("store-credit uses advisory lock + in-tx re-check", () => {
      const src = read("src/app/api/store-credit/route.ts");
      expect(src).toMatch(/store-credit-actor:/);
    });
    it("gift-cards activation uses advisory lock + in-tx re-check", () => {
      const src = read("src/app/api/gift-cards/route.ts");
      const hits = src.match(/gift-card-actor:/g) ?? [];
      expect(hits.length).toBeGreaterThanOrEqual(2); // activation + reload
    });
  });

  describe("R31-M5: transfers create ON CONFLICT idempotency", () => {
    const src = read("src/app/api/transfers/route.ts");
    it("catches 23505 on idempotency_key + returns winner's id", () => {
      expect(src).toMatch(/idempotentWinnerId/);
      expect(src).toMatch(/_idempotent: true/);
    });
  });

  describe("R31-M6: expenses DELETE location gate + audit", () => {
    const src = read("src/app/api/expenses/route.ts");
    it("SELECTs location + amount BEFORE delete", () => {
      expect(src).toMatch(/FROM expenses WHERE id = \$1 AND organization_id = \$2 LIMIT 1/);
    });
    it("writes expense_deleted audit event", () => {
      expect(src).toMatch(/expense_deleted/);
    });
  });

  describe("R31-M9: reports date range cap", () => {
    const src = read("src/app/api/reports/route.ts");
    it("caps date range at 400 days", () => {
      expect(src).toMatch(/MAX_REPORT_DAYS = 400/);
    });
  });

  describe("R31-M12: /api/auth/verify generic error", () => {
    const src = read("src/app/api/auth/verify/route.ts");
    it("no longer exposes 'email already registered'", () => {
      expect(src).not.toMatch(/error=That\+email\+is\+already\+registered/);
      expect(src).toMatch(/Verification\+failed\.\+Request\+a\+new\+link/);
    });
  });
});
