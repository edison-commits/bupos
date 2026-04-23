/**
 * R80 regression tests. Pins audit round 24 — 3 HIGH + 5 MED + 5 LOW.
 *
 * HIGH
 *   FE-H1 (R79 regression): keyboard-shortcuts.tsx global Esc →
 *     voidCart was firing on the same keydown as R79's modal Esc
 *     handlers. A cashier pressing Esc to dismiss e.g. pay-in-out
 *     closed the modal AND voided the cart. Global handler now
 *     checks for any open [role="dialog"][aria-modal="true"] and
 *     lets the modal's own handler take priority.
 *   DB-H1 / SEC-H1: /api/offline-sync now SELECTs the open shift
 *     FOR UPDATE SKIP LOCKED + register_sessions FOR UPDATE inside
 *     the syncClient tx. Final holdout in the R76-R79 shift-lock
 *     pattern sweep — offline-sync replays cart tenders on the
 *     currently-open shift and previously had no lock, so a
 *     concurrent shift close could finalize expectedCash before
 *     this path's tender committed.
 *   FE-H2: sweep 8 register modals with role="dialog" +
 *     aria-modal="true" + Esc→onCancel handler (gated on
 *     submitting/processing where applicable).
 *
 * MEDIUM
 *   SEC-M: EODWizard accepts Esc + has Cancel-disabled when
 *     loading||processing + re-entry guard in handleCloseShiftClick.
 *   FE-M-json: admin/employees/page.tsx three res.json() calls
 *     now have .catch() fallback for non-JSON gateway bodies.
 *   FE-M-submit: exchange-modal Continue button gets synchronous
 *     continuing guard + layaway-modal local submitting flag
 *     belts-and-braces the parent's processing prop.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R80 audit fixes — round 24", () => {
  describe("R80-FE-H1 HIGH (regression): keyboard-shortcuts Esc yields to open modals", () => {
    const src = read("src/components/register/keyboard-shortcuts.tsx");
    it("Esc handler checks for open [role=dialog][aria-modal=true]", () => {
      expect(src).toMatch(/document\.querySelector\('\[role="dialog"\]\[aria-modal="true"\]'\)/);
    });
  });

  describe("R80-DB-H1 / SEC-H1 HIGH: /api/offline-sync locks shift + register_session", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    it("SELECT open shift FOR UPDATE SKIP LOCKED inside syncClient tx", () => {
      expect(src).toMatch(/SELECT id FROM shifts[\s\S]{0,300}status = 'open'[\s\S]{0,200}FOR UPDATE SKIP LOCKED/);
    });
    it("rejects sync with retriable=true when no open shift", () => {
      expect(src).toMatch(/No open shift at this location[\s\S]{0,200}retriable: true/);
    });
    it("also FOR UPDATEs the register_sessions row when sessionId present", () => {
      expect(src).toMatch(/SELECT id FROM register_sessions WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/);
    });
  });

  describe("R80-FE-H2 HIGH: 8 register modals get role=dialog + Esc handler", () => {
    const modals: Array<[string, string]> = [
      ["src/components/register/exchange-modal.tsx", "Exchange"],
      ["src/components/register/layaway-modal.tsx", "Create layaway"],
      ["src/components/register/line-discount-modal.tsx", "Line discount"],
      ["src/components/register/price-override-modal.tsx", "Price override"],
      ["src/components/register/void-reason-modal.tsx", "Void reason"],
      ["src/components/register/promo-code-modal.tsx", "Promo code"],
      ["src/components/register/customer-search-modal.tsx", "Customer search"],
      ["src/components/register/eod-wizard.tsx", "End of day"],
    ];
    for (const [rel, label] of modals) {
      it(`${label} modal has role=dialog + aria-modal + Esc handler`, () => {
        const src = read(rel);
        expect(src).toContain(`role="dialog" aria-modal="true" aria-label="${label}"`);
        expect(src).toMatch(/e\.key === "Escape"[\s\S]{0,80}onCancel\(\)/);
      });
    }
  });

  describe("R80-SEC-M MED: EODWizard Cancel disabled on loading||processing + sync re-entry guard", () => {
    const src = read("src/components/register/eod-wizard.tsx");
    it("Cancel button disabled={loading || processing}", () => {
      expect(src).toMatch(/onClick=\{onCancel\}[\s\S]{0,80}disabled=\{loading \|\| processing\}/);
    });
    it("handleCloseShiftClick has sync re-entry guard `if (loading) return`", () => {
      expect(src).toMatch(/const handleCloseShiftClick = async[\s\S]{0,400}if \(loading\) return;\s*setLoading\(true\)/);
    });
  });

  describe("R80-FE-M MED: admin/employees/page.tsx res.json() fallbacks", () => {
    const src = read("src/app/admin/employees/page.tsx");
    it("all 3 non-ok response.json() calls have .catch fallback", () => {
      const matches = src.match(/const err = await response\.json\(\)\.catch\(\(\) => \(\{ error: `HTTP \$\{response\.status\}`/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("R80-FE-M MED: exchange-modal Continue + layaway-modal submitting guards", () => {
    it("exchange-modal Continue button checks continuing state sync", () => {
      const src = read("src/components/register/exchange-modal.tsx");
      expect(src).toMatch(/const \[continuing, setContinuing\] = useState\(false\)/);
      expect(src).toMatch(/if \(continuing\) return;\s*setContinuing\(true\)/);
    });
    it("layaway-modal handleConfirm checks submitting + processing", () => {
      const src = read("src/components/register/layaway-modal.tsx");
      expect(src).toMatch(/const \[submitting, setSubmitting\] = useState\(false\)/);
      expect(src).toMatch(/if \(!valid \|\| submitting \|\| processing\) return;\s*setSubmitting\(true\)/);
    });
  });
});
