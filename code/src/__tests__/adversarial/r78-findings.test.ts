/**
 * R78 regression tests. Pins audit round 22 — 17 findings
 * (5 HIGH + 7 MED + 5 LOW). R78-DB-H2 and R78-SEC-H3 were the
 * same finding reported by two tracks; deduped to one.
 *
 * HIGH
 *   SEC-H1: shipTransferAction (Server Action) aggregates
 *     per-variant before stock check + single delta-join UPDATE.
 *     Twin-path of R76-SEC-H1 (REST) — admin surface was missed.
 *   SEC-H2: register/return-action.ts now SELECTs register_sessions
 *     FOR UPDATE + shifts FOR UPDATE SKIP LOCKED on cashRefund.
 *     Prior shape never locked the shift row, so a concurrent
 *     closeShiftEnhancedAction (R76-DB-H2) could commit a
 *     closed-status snapshot while this returned a -N cash
 *     refund against the same session — invisible to the closed
 *     shift AND any later shift.
 *   DB-H1: /api/returns PUT restock aggregates duplicate return
 *     lines via SUM + GROUP BY. Prior shape let duplicate-variant
 *     return_lines trigger SQLSTATE 21000 ("cannot affect row a
 *     second time") in the unnest delta-join, permanently
 *     stucking the return in 'approved' with money undispersed.
 *   DB-H2: /api/returns PUT state-machine. allowedByFrom table
 *     blocks pending → completed → rejected / completed → pending
 *     cycles (double-dispense refunds) and treats completed /
 *     rejected / cancelled as terminal. Final UPDATE includes
 *     `AND status = $retRow.status` predicate.
 *   FE-H1: shift-close-modal accepts `processing` prop; disables
 *     Back + Close-shift buttons when parent's closeShift call is
 *     in flight. Prior shape let a double-tap fire the Server
 *     Action twice, burning audit + rate-limit budget.
 *
 * MEDIUM
 *   DB-M1: /api/receiving default reorder_point=5 (parity with
 *     PO PATCH + transfers RECEIVE R76-DB-M).
 *   FE-M-json: customer-database, supplier-manager, expense-tracker
 *     res.json() on error response has .catch() fallback so
 *     non-JSON bodies surface as "HTTP N" instead of throwing
 *     to generic "Failed to save".
 *   FE-M-aria: inventory-browser Clear-search icon button has
 *     aria-label.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R78 audit fixes — round 22", () => {
  describe("R78-SEC-H1 HIGH: shipTransferAction Server Action aggregates per-variant", () => {
    const src = read("src/app/admin/transfer-actions.ts");
    const block = src.slice(src.indexOf("export async function shipTransferAction"));
    it("builds requestedByVariant Map before stock check", () => {
      expect(block).toMatch(/const requestedByVariant = new Map<string, number>\(\);/);
    });
    it("stock check iterates Map entries (not raw lines)", () => {
      expect(block).toMatch(/for \(const \[vid, totalRequested\] of requestedByVariant\)/);
    });
    it("single UPDATE uses unnest delta-join with GREATEST(0,...) clamp", () => {
      expect(block).toMatch(/UPDATE inventory_levels il\s+SET on_hand = GREATEST\(0, il\.on_hand - delta\.qty\)[\s\S]{0,400}unnest\(\$1::uuid\[\]\)/);
    });
  });

  describe("R78-SEC-H2 HIGH: register/return-action locks register_session + open shift", () => {
    const src = read("src/app/register/return-action.ts");
    it("FOR UPDATEs register_sessions row unconditionally", () => {
      expect(src).toMatch(/SELECT id FROM register_sessions WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/);
    });
    it("cashRefund path FOR UPDATE SKIP LOCKED the open shift", () => {
      expect(src).toMatch(/if \(cashRefund\)[\s\S]{0,600}SELECT id FROM shifts[\s\S]{0,400}status = 'open'[\s\S]{0,200}FOR UPDATE SKIP LOCKED/);
    });
    it("rejects with actionable message when shift is being closed", () => {
      expect(src).toMatch(/Cash refund requires an open shift at this location[\s\S]{0,200}shift is being closed/);
    });
  });

  describe("R78-DB-H1 HIGH: /api/returns PUT restock aggregates by variant", () => {
    const src = read("src/app/api/returns/route.ts");
    it("SELECT groups by product_variant_id with SUM", () => {
      expect(src).toMatch(/SELECT rl\.product_variant_id, SUM\(rl\.quantity\)::int AS quantity[\s\S]{0,400}GROUP BY rl\.product_variant_id/);
    });
  });

  describe("R78-DB-H2 HIGH: /api/returns PUT state-machine", () => {
    const src = read("src/app/api/returns/route.ts");
    it("allowedByFrom table has terminal pending/approved/completed/rejected/cancelled", () => {
      expect(src).toMatch(/const allowedByFrom: Record<string, string\[\]> = \{[\s\S]{0,500}pending:\s*\[[\s\S]{0,400}completed:\s*\[\][\s\S]{0,200}rejected:\s*\[\][\s\S]{0,200}cancelled:\s*\[\]/);
    });
    it("returns 409 with 'cannot transition' on forbidden", () => {
      expect(src).toMatch(/Return cannot transition from '\$\{retRow\.status\}' to '\$\{status\}'/);
    });
    it("final UPDATE predicate includes status = $5 guard", () => {
      expect(src).toMatch(/UPDATE returns SET status = \$1[\s\S]{0,300}AND status = \$5/);
    });
  });

  describe("R78-FE-H1 HIGH: shift-close-modal accepts processing prop", () => {
    const modal = read("src/components/register/shift-close-modal.tsx");
    const console = read("src/components/register/register-console-client.tsx");
    it("modal interface declares `processing` prop", () => {
      expect(modal).toMatch(/processing\?:\s*boolean;/);
    });
    it("Close-shift button disables on processing + shows 'Closing…'", () => {
      expect(modal).toMatch(/disabled=\{processing\}[\s\S]{0,400}processing \? "Closing…" : "Close shift"/);
    });
    it("register-console-client passes processing={closing} to both modal mount sites", () => {
      const matches = console.match(/processing=\{closing\}/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("R78-DB-M1 MED: /api/receiving default reorder_point=5", () => {
    const src = read("src/app/api/receiving/route.ts");
    it("INSERT inventory_levels uses reorder_point=5", () => {
      expect(src).toMatch(/INSERT INTO inventory_levels[\s\S]{0,300}VALUES \(\$1, \$2, \$3, 0, 0, 5\)/);
    });
  });

  describe("R78-FE-M MED: res.json().catch fallback on error paths", () => {
    it("customer-database handleSave has .catch fallback", () => {
      const src = read("src/components/admin/customer-database.tsx");
      expect(src).toMatch(/const err = await res\.json\(\)\.catch\(\(\) => \(\{ error:/);
    });
    it("supplier-manager handleSave has .catch fallback", () => {
      const src = read("src/components/admin/supplier-manager.tsx");
      expect(src).toMatch(/const err = await res\.json\(\)\.catch\(\(\) => \(\{ error:/);
    });
    it("expense-tracker handleSave has .catch fallback", () => {
      const src = read("src/components/admin/expense-tracker.tsx");
      expect(src).toMatch(/const err = await res\.json\(\)\.catch\(\(\) => \(\{ error:/);
    });
  });

  describe("R78-FE-M MED: inventory-browser Clear-search icon has aria-label", () => {
    const src = read("src/components/admin/inventory-browser.tsx");
    it("Clear-search button carries aria-label", () => {
      expect(src).toMatch(/onClick=\{\(\) => setSearch\(''\)\}[\s\S]{0,200}aria-label="Clear search"/);
    });
  });
});
