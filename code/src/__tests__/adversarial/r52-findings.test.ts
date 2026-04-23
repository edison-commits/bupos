/**
 * R52 regression tests. Pins audit round 9 — the large burn-down of
 * step-up UI gaps + auth-endpoint audit drift that R51's deep audit
 * uncovered.
 *
 *   R52-A: /api/products PUT variant-reprice branch gates on
 *          requireStepUp({bucketKey:'variant-price-stepup'}) with a
 *          snapshot-compare prior value (parity with server action
 *          editVariantAction).
 *   R52-B: /api/bundles POST + PATCH gate bundlePrice mutations on
 *          requireStepUp({bucketKey:'bundle-price-stepup'}).
 *   R52-C/D/E/F: four auth routes move audit INTO the tx:
 *          password-change, password-reset-confirm, revoke-all-
 *          sessions, auth/verify.
 *   R52-G: updateLocationAction snapshot-compares prior taxRate
 *          server-side (so non-tax saves don't trigger step-up) and
 *          admin-console wraps the form in <PasswordGatedForm>.
 *   R52-H: adjustInventoryAction form uses <PasswordGatedForm> with
 *          a gateCondition threshold.
 *   R52-I: gift-card-manager activate + reload forms prompt via
 *          usePasswordGate before POST.
 *   R52-J: layaway-manager make-payment + cancel-refund paths
 *          prompt via usePasswordGate; cancelLayawayAction takes
 *          actorPassword as 4th arg.
 *   R52-K: expense-tracker handleSave prompts when amount ≥ $500.
 *   R52-L: customer-database handleSave prompts when a sensitive
 *          field (email/phone/address/notes) changed from the
 *          editing snapshot.
 *   R52-M: supplier-manager handleSave + toggleActive prompt for
 *          password on PUT paths.
 *   R52-N: returns-manager handleStatus prompts when status goes to
 *          'completed' (the money-dispensing edge).
 *   R52-O: usePasswordGate handles re-entrant promptPassword by
 *          resolving the prior pending resolver with null.
 *   R52-P: PasswordGatedForm re-queries the submit button via
 *          findBtn() after each await (not a single captured Node
 *          reference) so React reconciliation can't strand a stale
 *          `.disabled = true`.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R52 audit fixes", () => {
  describe("R52-A: /api/products PUT variant-reprice gates on requireStepUp", () => {
    const src = read("src/app/api/products/route.ts");
    it("variant branch calls requireStepUp with bucketKey 'variant-price-stepup'", () => {
      expect(src).toMatch(/requireStepUp\(\{[\s\S]{0,300}bucketKey:\s*['"]variant-price-stepup['"]/);
    });
    it("snapshot-compares prior price/cost via SELECT FOR UPDATE", () => {
      expect(src).toMatch(/SELECT price, cost FROM product_variants[\s\S]{0,100}FOR UPDATE/);
      expect(src).toMatch(/priceChanged \|\| costChanged/);
    });
  });

  describe("R52-B: /api/bundles POST+PATCH gate bundlePrice on step-up", () => {
    const src = read("src/app/api/bundles/route.ts");
    it("bucket 'bundle-price-stepup' appears (once POST unconditional, once PATCH conditional)", () => {
      const matches = src.match(/bucketKey:\s*['"]bundle-price-stepup['"]/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
    it("PATCH gates only when bundlePrice is in the body", () => {
      expect(src).toMatch(/if \(bundlePrice !== undefined\)[\s\S]{0,400}bucket-price-stepup|if \(bundlePrice !== undefined\)[\s\S]{0,400}bundle-price-stepup/);
    });
  });

  describe("R52-C: /api/auth/password-change moves audit in-tx", () => {
    const src = read("src/app/api/auth/password-change/route.ts");
    it("uses orgTx and INSERT INTO audit_events before COMMIT", () => {
      expect(src).toMatch(/orgTx\(orgId\)/);
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]{0,500}'password_changed'[\s\S]{0,300}COMMIT/);
    });
    it("no longer imports pgInsertAuditEvent / waitUntilOrAwait for this path", () => {
      expect(src).not.toMatch(/waitUntilOrAwait\(\s*pgInsertAuditEvent/);
    });
  });

  describe("R52-D: /api/auth/password-reset-confirm moves audit in-tx", () => {
    const src = read("src/app/api/auth/password-reset-confirm/route.ts");
    it("INSERT INTO audit_events is before COMMIT, not after", () => {
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]{0,500}'password_reset_completed'[\s\S]{0,300}COMMIT/);
    });
    it("session wipe moved INSIDE the tx (no post-commit pool.query DELETE sessions)", () => {
      // The DELETE FROM sessions now uses the `client` (tx client),
      // not pool.query outside the tx block.
      expect(src).toMatch(/client\.query\([\s\S]{0,80}DELETE FROM sessions/);
    });
  });

  describe("R52-E: /api/auth/revoke-all-sessions moves audit in-tx", () => {
    const src = read("src/app/api/auth/revoke-all-sessions/route.ts");
    it("uses orgTx with in-tx INSERT INTO audit_events", () => {
      expect(src).toMatch(/orgTx\(orgId\)/);
      expect(src).toMatch(/INSERT INTO audit_events[\s\S]{0,500}'sessions_revoked'[\s\S]{0,300}COMMIT/);
    });
  });

  describe("R52-F: /api/auth/verify emits sign-up audit INSIDE the org-creation tx", () => {
    const src = read("src/app/api/auth/verify/route.ts");
    it("store_signup_verified audit INSERT appears before the client.query(\"COMMIT\")", () => {
      // The string order matters: INSERT audit must come before COMMIT
      // in the same tx block. Use a single regex with both markers.
      expect(src).toMatch(/'store_signup_verified'[\s\S]{0,400}await client\.query\("COMMIT"\)/);
    });
    it("no post-commit pool.query audit fallback remains", () => {
      // The old pattern wrote a post-commit audit via pool.query(INSERT audit_events)
      // wrapped in waitUntilOrAwait. That whole block is gone.
      expect(src).not.toMatch(/auditPromise\s*=\s*pool\.query/);
    });
  });

  describe("R52-G: updateLocationAction server snapshot-compares prior taxRate", () => {
    const src = read("src/app/admin/actions.ts");
    it("gate fires only when the new taxRate differs from DB prior with epsilon", () => {
      expect(src).toMatch(/Math\.abs\(priorTax - taxRate\) > 0\.00005/);
    });
    it("admin-console wraps updateLocationAction form in <PasswordGatedForm>", () => {
      const ui = read("src/components/admin/admin-console.tsx");
      expect(ui).toMatch(/<PasswordGatedForm[\s\S]{0,1200}action=\{updateLocationAction\}/);
    });
  });

  describe("R52-H: adjustInventoryAction wrapped in <PasswordGatedForm>", () => {
    const src = read("src/components/admin/admin-console.tsx");
    it("uses PasswordGatedForm and a delta-threshold gateCondition", () => {
      expect(src).toMatch(/<PasswordGatedForm[\s\S]{0,1200}action=\{adjustInventoryAction\}/);
      expect(src).toMatch(/Math\.abs\(delta\) > 500/);
    });
  });

  describe("R52-I: gift-card activate + reload forms prompt for password", () => {
    const src = read("src/components/admin/gift-card-manager.tsx");
    it("activate form sets actorPassword on FormData and calls activateGiftCardAction", () => {
      expect(src).toMatch(/fd\.set\(['"]actorPassword['"],\s*pwd\)[\s\S]{0,600}activateGiftCardAction\(fd\)/);
    });
    it("reload form sets actorPassword on FormData and calls reloadGiftCardAction", () => {
      expect(src).toMatch(/fd\.set\(['"]actorPassword['"],\s*pwd\)[\s\S]{0,600}reloadGiftCardAction\(fd\)/);
    });
  });

  describe("R52-J: layaway pay + cancel prompt for password on refund dispositions", () => {
    const src = read("src/components/admin/layaway-manager.tsx");
    it("makeLayawayPaymentAction path sets actorPassword", () => {
      expect(src).toMatch(/fd\.set\(['"]actorPassword['"],\s*pwd\)[\s\S]{0,400}makeLayawayPaymentAction\(fd\)/);
    });
    it("cancelLayawayAction path conditionally passes pwd on refund dispositions", () => {
      expect(src).toMatch(/cancelDisposition === "refund_cash" \|\| cancelDisposition === "refund_store_credit"/);
      expect(src).toMatch(/cancelLayawayAction\(lay\.id,\s*cancelReason,\s*cancelDisposition,\s*pwd\)/);
    });
  });

  describe("R52-K: expense-tracker prompts for amount ≥ $500", () => {
    const src = read("src/components/admin/expense-tracker.tsx");
    it("handleSave checks amount >= 500 and prompts", () => {
      expect(src).toMatch(/if \(amount >= 500\)[\s\S]{0,400}promptPassword\(/);
    });
    it("actorPassword included in /api/expenses POST body when set", () => {
      expect(src).toMatch(/\.\.\.\(actorPassword \? \{ actorPassword \} : \{\}\)/);
    });
  });

  describe("R52-L: customer-database prompts on sensitive-field change", () => {
    const src = read("src/components/admin/customer-database.tsx");
    it("diffs email/phone/address/notes vs editing snapshot", () => {
      expect(src).toMatch(/priorEmail !== form\.email/);
      expect(src).toMatch(/priorPhone !== form\.phone/);
      expect(src).toMatch(/priorAddress !== form\.address/);
      expect(src).toMatch(/priorNotes !== form\.notes/);
    });
    it("actorPassword included in PUT body when sensitive change detected", () => {
      expect(src).toMatch(/\.\.\.\(actorPassword \? \{ actorPassword \} : \{\}\)/);
    });
  });

  describe("R52-M: supplier-manager prompts on PUT paths", () => {
    const src = read("src/components/admin/supplier-manager.tsx");
    it("handleSave prompts only on edit (editing branch)", () => {
      expect(src).toMatch(/if \(editing\)[\s\S]{0,400}promptPassword\(/);
    });
    it("toggleActive always prompts", () => {
      expect(src).toMatch(/const toggleActive[\s\S]{0,600}promptPassword\(/);
    });
  });

  describe("R52-N: returns-manager prompts on status='completed'", () => {
    const src = read("src/components/admin/returns-manager.tsx");
    it("handleStatus prompts only when status === 'completed'", () => {
      expect(src).toMatch(/if \(status === ['"]completed['"]\)[\s\S]{0,400}promptPassword\(/);
    });
  });

  describe("R52-O: usePasswordGate resolves a re-entrant prompt's prior resolver", () => {
    const src = read("src/components/shared/password-gate.tsx");
    it("re-entrant prompt resolves prior resolver before taking over", () => {
      // R54-Framework-3: migrated from a side-effecting `setState((prev) =>
      // ...)` updater (impure under strict-mode double-invocation) to a
      // `pendingRef` that tracks the current resolver. The mechanism is
      // the same — a re-entrant promptPassword call resolves the prior
      // caller with null before installing its own resolver — but now
      // it's purity-safe.
      expect(src).toMatch(/const pendingRef = useRef<Resolver \| null>/);
      expect(src).toMatch(/const priorResolver = pendingRef\.current/);
      expect(src).toMatch(/if \(priorResolver\) priorResolver\(null\)/);
    });
  });

  describe("R52-P: PasswordGatedForm re-queries the submit button via findBtn() after awaits", () => {
    const src = read("src/components/shared/password-gated-form.tsx");
    it("uses const findBtn = () => form.querySelector(...)", () => {
      expect(src).toMatch(/const findBtn = \(\) =>[\s\S]{0,100}form\.querySelector/);
    });
    it("post-await re-query uses findBtn(), not the initial closure variable", () => {
      expect(src).toMatch(/const btnNow = findBtn\(\)/);
    });
  });
});
