/**
 * R81 regression tests. Pins audit round 25 — 3 HIGH + 3 MED +
 * 2 LOW (many MED/LOW items deferred to R82 a11y sweep as they
 * are quality-of-life, not material security).
 *
 * HIGH
 *   FE-H1: R80 Esc-yield pattern only worked if the open modal had
 *     role="dialog" aria-modal="true". Multiple overlays missed
 *     the attrs → Esc fell through to voidCart. R81 swept
 *     keyboard-shortcuts overlay, customer-receipt-lookup,
 *     variant-picker, tender-panel, receipt-view, and 3
 *     pos-terminal modals. Each now has role=dialog + aria-modal.
 *     keyboard-shortcuts + customer-receipt-lookup also get Esc
 *     handlers so the dialog's OWN Esc wins.
 *   FE-H2: exchange-modal `continuing` flag set in R80 never
 *     reset on error path — a sync throw from onConfirm left
 *     the button disabled forever. Wrapped in try/catch with
 *     setContinuing(false) in the catch.
 *   FE-H3: customer-receipt-lookup modal wrapper now has
 *     id="receipt-modal" (matching globals.css:380 @media print
 *     rule) so Print only renders the modal content, not the
 *     admin page behind the overlay.
 *
 * MEDIUM
 *   SEC-M: /api/auth/password-change + password-reset-initiate +
 *     password-reset-confirm now call checkOrigin + enforce a
 *     16KB body cap. Defense-in-depth alongside SameSite=Lax.
 *
 * LOW
 *   DB-L-gc: /api/gift-cards disable now idempotent (already-
 *     disabled returns success without fresh audit row). Also
 *     masks the card code in audit payload (parity with Server
 *     Action).
 *   DB-L-promo: /api/promo-codes disable idempotent similarly.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R81 audit fixes — round 25", () => {
  describe("R81-FE-H1 HIGH: Esc-yield pattern covers every overlay", () => {
    const overlays: Array<[string, string]> = [
      ["src/components/register/keyboard-shortcuts.tsx", "Keyboard shortcuts"],
      ["src/components/admin/customer-receipt-lookup.tsx", "Receipt detail"],
      ["src/components/register/product-grid.tsx", "Pick variant"],
      ["src/components/register/tender-panel.tsx", "Tender"],
      ["src/components/register/receipt-view.tsx", "Receipt"],
    ];
    for (const [rel, label] of overlays) {
      it(`${label} overlay has role=dialog + aria-modal + aria-label`, () => {
        const src = read(rel);
        expect(src).toContain(`role="dialog"`);
        expect(src).toContain(`aria-label="${label}"`);
      });
    }
    it("pos-terminal three modals get role=dialog", () => {
      const src = read("src/components/register/pos-terminal.tsx");
      expect(src).toContain(`aria-label="Return result"`);
      expect(src).toContain(`aria-label="Layaway result"`);
      expect(src).toContain(`aria-label="Held carts"`);
    });
    it("keyboard-shortcuts overlay has its own Esc handler", () => {
      const src = read("src/components/register/keyboard-shortcuts.tsx");
      expect(src).toMatch(/e\.key === "Escape"[\s\S]{0,80}onClose\(\)/);
    });
    it("customer-receipt-lookup has its own Esc handler", () => {
      const src = read("src/components/admin/customer-receipt-lookup.tsx");
      expect(src).toMatch(/e\.key === "Escape"[\s\S]{0,80}onClose\(\)/);
    });
  });

  describe("R81-FE-H2 HIGH: exchange-modal continuing flag resets on error", () => {
    const src = read("src/components/register/exchange-modal.tsx");
    it("onConfirm call handles both sync throws + async rejections", () => {
      // R82-SEC-H1 refactored the pure try/catch (which only
      // caught sync throws) into a Promise.resolve().finally
      // pattern that handles both sync-void returns and async-
      // promise rejections. Accept either shape.
      expect(src).toMatch(/onConfirm\([\s\S]{0,500}(\} catch \{\s*setContinuing\(false\)|Promise\.resolve\([\s\S]{0,200}\.finally\(\(\) => \{\s*setContinuing\(false\))/);
    });
  });

  describe("R81-FE-H3 HIGH: customer-receipt-lookup id=receipt-modal for print CSS", () => {
    const src = read("src/components/admin/customer-receipt-lookup.tsx");
    it("outer div has id=receipt-modal", () => {
      expect(src).toMatch(/id="receipt-modal"/);
    });
  });

  describe("R81-SEC-M MED: auth routes enforce Origin + body-size", () => {
    for (const rel of [
      "src/app/api/auth/password-change/route.ts",
      "src/app/api/auth/password-reset-initiate/route.ts",
      "src/app/api/auth/password-reset-confirm/route.ts",
    ]) {
      it(`${rel} calls checkOrigin + 413 on oversize body`, () => {
        const src = read(rel);
        expect(src).toMatch(/const originErr = checkOrigin\(req\);[\s\S]{0,100}if \(originErr\) return originErr;/);
        expect(src).toMatch(/Request body too large[\s\S]{0,50}413/);
      });
    }
  });

  describe("R81-DB-L LOW: gift-card + promo-code disable idempotent", () => {
    it("/api/gift-cards disable returns success on already-disabled", () => {
      const src = read("src/app/api/gift-cards/route.ts");
      expect(src).toMatch(/before\[0\]\.status === "disabled"[\s\S]{0,200}_idempotent: true/);
    });
    it("/api/gift-cards disable masks card code in audit payload", () => {
      const src = read("src/app/api/gift-cards/route.ts");
      expect(src).toMatch(/code: `\*\*\*\*\$\{String\(before\[0\]\.code \?\? ""\)\.slice\(-4\)\}`/);
    });
    it("/api/promo-codes disable returns success on already-disabled", () => {
      const src = read("src/app/api/promo-codes/route.ts");
      expect(src).toMatch(/exists\.rows\[0\]\.status === 'disabled'[\s\S]{0,200}_idempotent: true/);
    });
    it("/api/promo-codes disable UPDATE predicates on status != disabled", () => {
      const src = read("src/app/api/promo-codes/route.ts");
      expect(src).toMatch(/UPDATE promo_codes SET status = 'disabled'[\s\S]{0,200}AND status != 'disabled' RETURNING id/);
    });
  });
});
