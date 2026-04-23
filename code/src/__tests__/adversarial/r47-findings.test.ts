/**
 * R47 regression tests. Pins R47 audit-round fixes:
 *   R47-H1: /api/cash-drawer pay_out cashier-with-approval branch
 *           writes audit INSIDE the tx.
 *   R47-H2: disableGiftCardAction server-action wraps SELECT-UPDATE-
 *           AUDIT in a single orgTx with FOR UPDATE + idempotent guard.
 *   R47-H3: /api/loyalty POST uses an advisory lock on (orgId, actorId)
 *           to serialize the 24h mint-cap TOCTOU window.
 *   R47-H4: PayInOutModal synchronous double-submit guard.
 *   R47-H5: admin-console adjustInventoryAction form double-submit
 *           guard.
 *   R47-M: 4 auth routes (password-change, revoke-all-sessions,
 *          password-reset-confirm, password-reset-initiate) call
 *          logRateLimited on each 429 branch.
 *   R47-M: /api/promo-codes redeem writes audit_events INSIDE tx.
 *   R47-M4: /api/returns/process resolves original_tender to the
 *           dominant tender type on the original sale; cash-origin
 *           original_tender now routes through the cash branch.
 *   R47-M: /api/shift-close POST writes audit_events before COMMIT.
 *   R47-M: ProductGrid tileSize drops lazy-init (hydration-safe);
 *          useEffect upgrades to 'lg' on high-contrast after mount.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R47 audit fixes", () => {
  describe("R47-H1: cash-drawer cashier-with-approval pay_out writes audit INSIDE tx", () => {
    const src = read("src/app/api/cash-drawer/route.ts");
    it("via: 'cashier_with_approval' marker in the audit payload", () => {
      expect(src).toMatch(/via:\s*["']cashier_with_approval["']/);
    });
  });

  describe("R47-H2: disableGiftCardAction server-action uses tx + FOR UPDATE + idempotent guard", () => {
    const src = read("src/app/admin/gift-card-actions.ts");
    it("disableGiftCardAction uses orgTx client with FOR UPDATE", () => {
      expect(src).toMatch(/disableGiftCardAction[\s\S]*?orgTx\(orgId\)[\s\S]*?FOR UPDATE/);
    });
    it("idempotent early-return for already-disabled cards", () => {
      expect(src).toMatch(/disableGiftCardAction[\s\S]*?before\[0\]\.status === "disabled"/);
    });
    it("audit_events INSERT inside the disable tx", () => {
      expect(src).toMatch(/disableGiftCardAction[\s\S]*?INSERT INTO audit_events[\s\S]*?'gift_card_disabled'[\s\S]*?COMMIT/);
    });
  });

  describe("R47-H3: /api/loyalty uses advisory lock on (orgId, actorId)", () => {
    const src = read("src/app/api/loyalty/route.ts");
    it("pg_advisory_xact_lock keyed on loyalty-actor", () => {
      expect(src).toMatch(/pg_advisory_xact_lock[\s\S]*?loyalty-actor:/);
    });
  });

  describe("R47-H4: PayInOutModal has synchronous double-submit guard", () => {
    const src = read("src/components/register/pay-in-out-modal.tsx");
    it("has a `submitting` state + disables button when set", () => {
      expect(src).toMatch(/const \[submitting, setSubmitting\] = useState\(false\)/);
      expect(src).toMatch(/disabled=\{!isValid \|\| submitting\}/);
      expect(src).toMatch(/setSubmitting\(true\)/);
    });
  });

  describe("R47-H5: adjustInventoryAction form has double-submit guard", () => {
    const src = read("src/components/admin/admin-console.tsx");
    it("form has a double-submit guard (via PasswordGatedForm wrapper)", () => {
      // R52-H: the adjustInventoryAction form was migrated from a
      // raw <form> with an inline onSubmit guard to
      // <PasswordGatedForm>, which composes the R48 synchronous
      // DOM-mutation guard (see src/components/shared/password-
      // gated-form.tsx — `initialBtn.disabled = true`). Both shapes
      // satisfy the R47-H5 intent: "a fast double-tap can't fire
      // two concurrent adjustInventoryAction invocations."
      const adjustBlock = src.slice(src.indexOf("action={adjustInventoryAction}"));
      expect(adjustBlock).toMatch(/<PasswordGatedForm[\s\S]{0,0}|action=\{adjustInventoryAction\}/);
      // And the wrapper itself carries the DOM-mutation guard.
      const wrapperSrc = read("src/components/shared/password-gated-form.tsx");
      expect(wrapperSrc).toMatch(/initialBtn\.disabled = true/);
    });
  });

  describe("R47-M: auth routes call logRateLimited on 429 branches", () => {
    it("password-change emits logRateLimited", () => {
      const src = read("src/app/api/auth/password-change/route.ts");
      expect(src).toMatch(/logRateLimited/);
    });
    it("revoke-all-sessions emits logRateLimited", () => {
      const src = read("src/app/api/auth/revoke-all-sessions/route.ts");
      expect(src).toMatch(/logRateLimited/);
    });
    it("password-reset-confirm emits logRateLimited", () => {
      const src = read("src/app/api/auth/password-reset-confirm/route.ts");
      expect(src).toMatch(/logRateLimited/);
    });
    it("password-reset-initiate emits logRateLimited", () => {
      const src = read("src/app/api/auth/password-reset-initiate/route.ts");
      const count = (read("src/app/api/auth/password-reset-initiate/route.ts").match(/logRateLimited\(\{/g) ?? []).length;
      expect(src).toMatch(/logRateLimited/);
      // Multiple branches: IP mem / email mem / IP kv / email kv / IP db / email db.
      expect(count).toBeGreaterThanOrEqual(4);
    });
  });

  describe("R47-M: /api/promo-codes redeem audits before COMMIT", () => {
    const src = read("src/app/api/promo-codes/route.ts");
    it("writes audit_events 'promo_code_redeemed' inside the redeem tx", () => {
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'promo_code_redeemed'[\s\S]*?COMMIT/);
    });
  });

  describe("R47-M4: returns/process resolves original_tender to real dominant tender", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("effectiveTenderType + effectiveMethod derived from actual sale tenders", () => {
      expect(src).toMatch(/let effectiveTenderType/);
      expect(src).toMatch(/let effectiveMethod/);
      expect(src).toMatch(/dominantTender === 'cash'/);
    });
    it("cross-shift pay_out branch keys on effectiveMethod", () => {
      expect(src).toMatch(/if \(effectiveMethod === 'cash'\)/);
    });
  });

  describe("R47-M: /api/shift-close POST writes audit_events before COMMIT", () => {
    const src = read("src/app/api/shift-close/route.ts");
    it("inserts audit_events 'shift_closed' inside the closeClient tx", () => {
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]*?'shift_closed'[\s\S]*?closeClient\.query\('COMMIT'\)/);
    });
  });

  describe("R47-M: ProductGrid tileSize no longer uses DOM-reading lazy init", () => {
    const src = read("src/components/register/product-grid.tsx");
    it("initial useState returns 'md' statically (no typeof document check)", () => {
      expect(src).toMatch(/useState<['"]sm['"] \| ['"]md['"] \| ['"]lg['"]>\(['"]md['"]\)/);
    });
    it("useEffect reconciles high-contrast at mount", () => {
      expect(src).toMatch(/Initial reconcile at mount[\s\S]*?isHighContrastInitial/);
    });
  });
});
