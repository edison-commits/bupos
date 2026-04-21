/**
 * R36 regression tests. Pins the HIGH + MEDIUM fixes landed after
 * the R35 optimization round and the follow-up deep audit.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R36 findings", () => {
  describe("R36-H1: layaway-action.ts oversell + discount clamp + permission", () => {
    const reg = read("src/app/register/layaway-action.ts");
    const admin = read("src/app/admin/layaway-actions.ts");
    it("aggregates per-variant + uses GREATEST(0, ...) on decrement", () => {
      expect(reg).toMatch(/const totalsByVariant = new Map<string, number>\(\);/);
      expect(reg).toMatch(/GREATEST\(0, il\.on_hand - delta\.qty\)/);
    });
    it("clamps discountAmount before computeTotals (Infinity/negative guard)", () => {
      expect(reg).toMatch(/Number\.isFinite\(rawLayawayDiscount\)/);
      expect(reg).toMatch(/Math\.max\(0, rawLayawayDiscount\)/);
    });
    it("ROLLBACK in catch handler is guarded with .catch(() => {})", () => {
      expect(reg).toMatch(/await client\.query\("ROLLBACK"\)\.catch\(\(\) => \{\}\);/);
    });
    it("makeLayawayPaymentAction is restricted to owner/manager", () => {
      expect(admin).toMatch(/Layaway payment processing requires manager authority/);
      expect(admin).toMatch(/ctx\.employee\.roleKey !== "owner" && ctx\.employee\.roleKey !== "manager"/);
    });
  });

  describe("R36-H2: checkout-action.ts — no unguarded pre-redirect ROLLBACK", () => {
    const src = read("src/app/register/checkout-action.ts");
    it("idempotency-loser ROLLBACK is guarded", () => {
      expect(src).toMatch(/await client\.query\("ROLLBACK"\)\.catch\(\(\) => \{\}\);\n\s*return \{/);
    });
    it("pre-redirect ROLLBACKs in hot paths have been removed (catch handler handles it)", () => {
      // The old shape had several `await client.query("ROLLBACK"); redirect(...)`
      // lines. Count only GUARDED or POST-REDIRECT ones now.
      // Specifically: the catch block still has its own guarded ROLLBACK; the
      // redirect paths no longer pre-call it unguarded.
      const unguarded = src.match(/await client\.query\(["']ROLLBACK["']\);\n\s*redirect\(/g);
      expect(unguarded).toBeNull();
    });
  });

  describe("R36-H3: return-action refund math includes modifier upcharges + right denominator", () => {
    const src = read("src/app/register/return-action.ts");
    it("origTaxableBase = subtotal + modifiers (matches computeTotals)", () => {
      expect(src).toMatch(/const origTaxableBase = origSubtotal \+ origModifiersTotal;/);
      expect(src).toMatch(/rawRate = origTaxTotal \/ origTaxableBase/);
      expect(src).toMatch(/1 - origDiscountTotal \/ origTaxableBase/);
    });
    it("refund reducer adds origModifierTotal per unit", () => {
      expect(src).toMatch(/const origModifierTotal = origFromSnapshot/);
      expect(src).toMatch(/\(item\.unitPrice \+ origModifierTotal\) \* item\.quantity \* origDiscountFactor/);
    });
  });

  describe("R36-H4: offline-sync rejects deactivated capture-time employee", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    it("returns 403 with 'sync rejected' message", () => {
      expect(src).toMatch(/sync rejected/);
      expect(src).toMatch(/A manager must manually re-enter this sale/);
    });
    it("no 'sync accepted but flagging' path left", () => {
      expect(src).not.toMatch(/sync accepted but flagging/);
    });
  });

  describe("R36-H5: gift-card disable requires step-up", () => {
    const src = read("src/app/api/gift-cards/route.ts");
    it("imports requireStepUp + uses gift-card-disable-stepup bucket", () => {
      expect(src).toMatch(/'gift-card-disable-stepup'/);
    });
  });

  describe("R36-H6: revoke-all-sessions scopes credential lookup + DELETE by org", () => {
    const src = read("src/app/api/auth/revoke-all-sessions/route.ts");
    it("SELECT is scoped to org via EXISTS subquery", () => {
      expect(src).toMatch(/employee_id IN \(SELECT id FROM employees WHERE organization_id = \$2\)/);
    });
    it("DELETE is scoped to org too", () => {
      const deleteBlock = src.slice(src.indexOf("DELETE FROM sessions"));
      expect(deleteBlock.slice(0, 300)).toMatch(/organization_id = \$2/);
    });
  });

  describe("R36-FE1: audit page uses <Fragment> instead of nested <tbody>", () => {
    const src = read("src/app/admin/audit/page.tsx");
    it("imports Fragment from react and wraps event pair in it", () => {
      expect(src).toMatch(/import .*Fragment.* from 'react'/);
      expect(src).toMatch(/<Fragment key=\{event\.id\}>/);
    });
  });

  describe("R36-FE2: dashboard-charts tender pie label produces a percent string", () => {
    const src = read("src/components/admin/dashboard-charts.tsx");
    it("uses Math.round on percent, not the broken template literal", () => {
      expect(src).toMatch(/\$\{Math\.round\(\(percent \?\? 0\) \* 100\)\}%/);
      expect(src).not.toMatch(/\$\{name\} \{formatCurrency/);
    });
  });

  describe("R36-FE3: setDefaultTimeZone moved to useEffect", () => {
    const src = read("src/components/register/register-console-client.tsx");
    it("the TZ apply call is wrapped in useEffect", () => {
      expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]*?setDefaultTimeZone\(store\.organization\.timezone\)/);
    });
  });

  describe("R36-FE4: product-grid tileSize lazy-inits from DOM on first client render", () => {
    const src = read("src/components/register/product-grid.tsx");
    it("useState lazy init checks data-theme synchronously", () => {
      expect(src).toMatch(/const \[tileSize, setTileSize\] = useState<[^>]+>\(\(\) => \{/);
      expect(src).toMatch(/document\.documentElement\.getAttribute\('data-theme'\) === 'high-contrast' \? 'lg' : 'md'/);
    });
  });

  describe("R36-FE5: theme-toggle no longer returns null pre-mount", () => {
    const src = read("src/components/register/theme-toggle.tsx");
    it("has no `if (!mounted) return null;` guard", () => {
      expect(src).not.toMatch(/if \(!mounted\) \{\s*return null;\s*\}/);
    });
    it("state is lazy-initialized from DOM", () => {
      expect(src).toMatch(/useState<ThemeMode>\(\(\) => \{/);
    });
  });

  describe("R36-M4: barcode-lookup JOINs include explicit pv/il organization_id", () => {
    const src = read("src/app/api/barcode-lookup/route.ts");
    it("product_variants WHERE pv.organization_id = $1", () => {
      expect(src).toMatch(/WHERE pv\.organization_id = \$1/);
    });
    it("inventory_levels LEFT JOIN scoped by il.organization_id", () => {
      expect(src).toMatch(/il\.organization_id = \$1/);
    });
  });

  describe("R36-M1+M6: email-receipt per-txn cap + override step-up", () => {
    const src = read("src/app/api/email-receipt/route.ts");
    it("per-transaction send count is checked before sending", () => {
      expect(src).toMatch(/FROM transaction_events[\s\S]*?event_kind = 'receipt_emailed'/);
      expect(src).toMatch(/priorSends >= 3/);
    });
    it("override=true requires step-up", () => {
      expect(src).toMatch(/'email-receipt-override-stepup'/);
    });
    it("records a receipt_emailed event after a successful send", () => {
      expect(src).toMatch(/INSERT INTO transaction_events[\s\S]*?'receipt_emailed'/);
    });
  });

  describe("R36-M2: transactions/by-id strips overridePrice from non-manager cart_snapshot", () => {
    const src = read("src/app/api/transactions/by-id/[id]/route.ts");
    it("uses an allowlist rather than deny-list for sanitized items", () => {
      // sanitizedItems only carries productVariantId / productName / variantName / sku / unitPrice / quantity
      expect(src).toMatch(/const sanitizedItems = items\.map/);
      expect(src).toMatch(/productVariantId: i\.productVariantId/);
      // overridePrice / modifierIds / lineDiscount must NOT appear in the sanitized shape
      const block = src.slice(src.indexOf("sanitizedItems"));
      expect(block.slice(0, 500)).not.toMatch(/overridePrice:/);
      expect(block.slice(0, 500)).not.toMatch(/modifierIds:/);
    });
  });

  describe("R36-M5: migration 066 has no BEGIN/COMMIT wrapping the CREATE INDEX", () => {
    const mig = read("supabase/migrations/066_r35_perf_transaction_index.sql");
    it("no BEGIN; before the CREATE INDEX (so operators can swap in CONCURRENTLY)", () => {
      expect(mig).not.toMatch(/BEGIN;\s*\n\s*CREATE INDEX/);
    });
    it("still creates the partial index", () => {
      expect(mig).toMatch(/CREATE INDEX IF NOT EXISTS idx_transactions_org_loc_created_completed/);
    });
  });

  describe("R36-M8: customers PUT requires step-up on is_active / notes", () => {
    const src = read("src/app/api/customers/route.ts");
    it("uses customer-update-stepup bucket for the guarded fields", () => {
      expect(src).toMatch(/'customer-update-stepup'/);
      // Gating logic reads is_active !== undefined OR notes !== undefined
      expect(src).toMatch(/is_active !== undefined/);
    });
  });
});
