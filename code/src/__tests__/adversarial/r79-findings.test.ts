/**
 * R79 regression tests. Pins audit round 23 — key findings
 * (2 HIGH + multiple MED/LOW). Focused on the actionable
 * HIGH + MED surface. LOW items (skip links, ops beacon,
 * parseInt UX) are tracked as follow-up.
 *
 * HIGH
 *   DB-H1: register/checkout-action.ts FOR UPDATE SKIP LOCKED
 *     on the open shift. Prior shape locked register_sessions
 *     but not shifts; a concurrent closeShiftEnhancedAction
 *     (R76-DB-H2) could flip shift to 'closed' + commit before
 *     the checkout committed its tender → cash invisible to
 *     every shift's variance. Twin-path of R77-DB-H1 +
 *     R78-SEC-H2.
 *   SEC-H1: /api/employees PUT now invalidates sessions on
 *     locationIds change (previously only role + email).
 *     Prior shape let an employee's live register session at
 *     Location A continue ringing sales after an owner removed
 *     them from A.
 *
 * MEDIUM
 *   DB-M1: admin transfer-actions receiveTransferAction now
 *     defaults reorder_point=5 on first-time inventory_levels
 *     row (parity with /api/transfers RECEIVE after R76-DB-M).
 *   SEC-M: EODWizard accepts `processing` prop; wired from
 *     register-console-client so cross-modal unmount/remount
 *     doesn't reset the disabled state mid-server-call.
 *   FE-M-submit: return-modal Process-return button double-
 *     submit guard (submitting state + disabled + sync check).
 *   FE-M-json: reorder-suggestions + purchase-order-manager
 *     (create) + returns-manager (create) + barcode-lookup
 *     now check !res.ok BEFORE parsing res.json(). Non-JSON
 *     gateway bodies would otherwise throw into generic
 *     "Failed to X" instead of surfacing HTTP status.
 *   FE-M-a11y: shift-close-modal, pay-in-out-modal, return-
 *     modal got role="dialog" + aria-modal="true" + Esc→onCancel
 *     on the top 3 money-moving modals.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R79 audit fixes — round 23", () => {
  describe("R79-DB-H1 HIGH: checkout-action FOR UPDATE SKIP LOCKED on open shift", () => {
    const src = read("src/app/register/checkout-action.ts");
    it("SELECTs the open shift with FOR UPDATE SKIP LOCKED inside the tx", () => {
      expect(src).toMatch(/SELECT id FROM shifts\s+WHERE organization_id = \$1 AND location_id = \$2 AND status = 'open'[\s\S]{0,200}FOR UPDATE SKIP LOCKED/);
    });
    it("rejects the checkout when no open shift is lockable", () => {
      expect(src).toMatch(/shiftLockRows\.length === 0[\s\S]{0,200}Shift\+is\+closed\+or\+being\+closed/);
    });
  });

  describe("R79-SEC-H1 HIGH: /api/employees PUT invalidates sessions on locationIds change", () => {
    const src = read("src/app/api/employees/route.ts");
    it("combined invalidation guard includes locationIds", () => {
      expect(src).toMatch(/roleKey !== undefined \|\| email !== undefined \|\| locationIds !== undefined[\s\S]{0,200}await invalidateEmployeeSessions/);
    });
  });

  describe("R79-DB-M1 MED: admin/transfer-actions receive default reorder_point=5", () => {
    const src = read("src/app/admin/transfer-actions.ts");
    it("INSERT inventory_levels uses reorder_point=5", () => {
      expect(src).toMatch(/INSERT INTO inventory_levels[\s\S]{0,400}VALUES \(\$1, \$2, \$3, \$4, \$5, 0, 5/);
    });
  });

  describe("R79-SEC-M MED: EODWizard accepts processing prop", () => {
    it("EODWizardProps declares processing?: boolean", () => {
      const src = read("src/components/register/eod-wizard.tsx");
      expect(src).toMatch(/processing\?:\s*boolean;/);
    });
    it("Close-shift button uses loading || processing", () => {
      const src = read("src/components/register/eod-wizard.tsx");
      expect(src).toMatch(/disabled=\{loading \|\| processing\}[\s\S]{0,400}loading \|\| processing \? "Closing…" : "Close shift"/);
    });
    it("register-console-client wires processing={closing}", () => {
      const src = read("src/components/register/register-console-client.tsx");
      const matches = src.match(/processing=\{closing\}/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("R79-FE-M MED: return-modal double-submit guard", () => {
    const src = read("src/components/register/return-modal.tsx");
    it("declares submitting state", () => {
      expect(src).toMatch(/const \[submitting, setSubmitting\] = useState\(false\)/);
    });
    it("Process-return button is disabled on submitting + flips flag sync", () => {
      expect(src).toMatch(/disabled=\{submitting\}[\s\S]{0,600}if \(submitting\) return;\s*setSubmitting\(true\)/);
    });
  });

  describe("R79-FE-M MED: res.json() race fixed across 4 admin managers", () => {
    it("reorder-suggestions checks !res.ok BEFORE res.json()", () => {
      const src = read("src/components/admin/reorder-suggestions.tsx");
      expect(src).toMatch(/if \(!res\.ok\) \{\s*const err = await res\.json\(\)\.catch\(\(\) => \(\{ error: `HTTP \$\{res\.status\}`/);
    });
    it("purchase-order-manager create checks !res.ok BEFORE res.json()", () => {
      const src = read("src/components/admin/purchase-order-manager.tsx");
      // PO create path now does: `if (!res.ok) { const err = await res.json().catch(...); ... return; } const data = await res.json();`
      expect(src).toMatch(/if \(!res\.ok\) \{\s*const err = await res\.json\(\)\.catch\(\(\) => \(\{ error: `HTTP \$\{res\.status\}`[\s\S]{0,400}Failed to create PO/);
    });
    it("returns-manager create checks !res.ok BEFORE res.json()", () => {
      const src = read("src/components/admin/returns-manager.tsx");
      expect(src).toMatch(/if \(!res\.ok\) \{\s*const err = await res\.json\(\)\.catch\(\(\) => \(\{ error: `HTTP \$\{res\.status\}`[\s\S]{0,400}Failed to create return/);
    });
    it("barcode-lookup handleSave checks !res.ok BEFORE res.json()", () => {
      const src = read("src/components/admin/barcode-lookup.tsx");
      expect(src).toMatch(/if \(!res\.ok\) \{\s*const err = await res\.json\(\)\.catch\(\(\) => \(\{ error: `HTTP \$\{res\.status\}`[\s\S]{0,400}Failed to save product/);
    });
  });

  describe("R79-FE-M MED: top 3 money-moving modals have role=dialog + Esc handler", () => {
    it("shift-close-modal has role=dialog + Esc handler", () => {
      const src = read("src/components/register/shift-close-modal.tsx");
      expect(src).toMatch(/role="dialog" aria-modal="true" aria-label="Close shift/);
      expect(src).toMatch(/e\.key === "Escape" && !processing[\s\S]{0,40}onCancel\(\)/);
    });
    it("pay-in-out-modal has role=dialog + Esc handler", () => {
      const src = read("src/components/register/pay-in-out-modal.tsx");
      expect(src).toMatch(/role="dialog" aria-modal="true"/);
      expect(src).toMatch(/e\.key === "Escape" && !submitting[\s\S]{0,40}onCancel\(\)/);
    });
    it("return-modal has role=dialog + Esc handler", () => {
      const src = read("src/components/register/return-modal.tsx");
      expect(src).toMatch(/role="dialog" aria-modal="true" aria-label="Process return"/);
      expect(src).toMatch(/e\.key === "Escape" && !submitting[\s\S]{0,40}onCancel\(\)/);
    });
  });
});
