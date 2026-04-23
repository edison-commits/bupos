/**
 * R74 regression tests. Pins audit round 19 — 9 findings
 * (0 CRITICAL + 0 HIGH + 4 MEDIUM + 5 LOW):
 *
 * Highlights:
 *   MED A: shipTransferAction + receiveTransferAction idempotent
 *          status short-circuit runs BEFORE requireStepUp so
 *          retries don't exhaust the per-actor bucket. Mirror of
 *          R72-C REST fix, applied to the Server Action path.
 *   MED B: makeLayawayPaymentAction with tenderType='store_credit'
 *          now FOR UPDATEs the customer, verifies balance, debits
 *          store_credit_balance, and inserts a store_credit_ledger
 *          redemption row — all in-tx. Prior shape let a manager
 *          clear a layaway from store credit without consuming any.
 *   MED C: 23505 slug-conflict handlers on customer POST/PUT,
 *          employee POST, createEmployeeAction — friendly 409 /
 *          redirect message instead of generic 500. pgCreateCustomer
 *          throws a typed error (R74-I).
 *   MED H: audit_events in-tx for customer POST, PO PUT, PO PATCH.
 *
 *   LOW D: loyalty-tiers duplicate aria-label + legend — dropped
 *          the sr-only legend (aria-label remains the single
 *          accessible name; AT double-announce fixed).
 *   LOW E: customer-receipt-lookup Email button disabled +
 *          labeled "coming soon" (was firing alert() only).
 *   LOW F: transfer-manager + stocktake-manager Cancel buttons
 *          wrapped in try/catch with window.alert so server
 *          errors aren't swallowed.
 *   LOW G: /api/transfers RECEIVE idempotency short-circuit now
 *          also matches idempotency_key (parity with SHIP).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R74 audit fixes — round 19", () => {
  describe("R74-A MEDIUM: Server Action ship/receive idempotent status pre-check BEFORE step-up", () => {
    const src = read("src/app/admin/transfer-actions.ts");
    it("shipTransferAction short-circuits already-shipped BEFORE requireStepUp", () => {
      const block = src.slice(src.indexOf("export async function shipTransferAction"));
      const preCheckIdx = block.indexOf('probe[0].status !== "requested"');
      const stepUpIdx = block.indexOf("transfer-ship-stepup");
      expect(preCheckIdx).toBeGreaterThan(-1);
      expect(stepUpIdx).toBeGreaterThan(-1);
      expect(preCheckIdx).toBeLessThan(stepUpIdx);
    });
    it("receiveTransferAction short-circuits already-received BEFORE requireStepUp", () => {
      const block = src.slice(src.indexOf("export async function receiveTransferAction"));
      const preCheckIdx = block.indexOf('probe[0].status === "received"');
      const stepUpIdx = block.indexOf("transfer-receive-stepup");
      expect(preCheckIdx).toBeGreaterThan(-1);
      expect(stepUpIdx).toBeGreaterThan(-1);
      expect(preCheckIdx).toBeLessThan(stepUpIdx);
    });
  });

  describe("R74-B MEDIUM: makeLayawayPaymentAction store_credit debit + ledger", () => {
    const src = read("src/app/admin/layaway-actions.ts");
    const block = src.slice(src.indexOf("export async function makeLayawayPaymentAction"));
    it("SELECTs customer_id on the layaway row", () => {
      expect(block).toMatch(/SELECT id, status, balance_due, location_id, customer_id FROM layaways/);
    });
    it("store_credit tender FOR UPDATEs the customer and debits balance", () => {
      expect(block).toMatch(/if \(tenderType === "store_credit"\)[\s\S]{0,800}SELECT store_credit_balance FROM customers[\s\S]{0,200}FOR UPDATE/);
    });
    it("writes a store_credit_ledger redemption row with negative amount", () => {
      expect(block).toMatch(/INSERT INTO store_credit_ledger[\s\S]{0,400}'redemption'[\s\S]{0,400}-amount/);
    });
    it("rejects when layaway has no customer attached", () => {
      expect(block).toMatch(/Store-credit layaway payment requires a customer attached/);
    });
  });

  describe("R74-C MEDIUM: 23505 handlers on customers + employees create/update", () => {
    it("/api/customers POST returns 409 + friendly message on 23505", () => {
      const src = read("src/app/api/customers/route.ts");
      expect(src).toMatch(/err\?\.code === '23505'[\s\S]{0,300}A customer with this email already exists/);
    });
    it("/api/customers PUT returns 409 on 23505", () => {
      const src = read("src/app/api/customers/route.ts");
      // Two occurrences (POST + PUT) — check for a second instance.
      const matches = src.match(/A customer with this email already exists/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
    it("/api/employees POST returns 409 on 23505", () => {
      const src = read("src/app/api/employees/route.ts");
      expect(src).toMatch(/err\?\.code === '23505'[\s\S]{0,300}An employee with this email already exists/);
    });
    it("createEmployeeAction redirects with friendly 23505 message", () => {
      const src = read("src/app/admin/actions.ts");
      const block = src.slice(src.indexOf("export async function createEmployeeAction"));
      expect(block).toMatch(/err\?\.code === "23505"[\s\S]{0,400}An\+employee\+with\+this\+email\+already\+exists/);
    });
  });

  describe("R74-D LOW: loyalty-tiers drops duplicate sr-only legend", () => {
    const src = read("src/components/admin/loyalty-tiers.tsx");
    it("fieldset aria-label remains the single accessible name", () => {
      expect(src).toMatch(/<fieldset disabled className="grid gap-4 opacity-75" aria-label="Tier Configuration \(Preview/);
    });
    it("sr-only legend duplicating the aria-label text is gone", () => {
      expect(src).not.toMatch(/<legend className="sr-only">Tier Configuration \(Preview/);
    });
  });

  describe("R74-E LOW: customer-receipt-lookup Email button disabled with coming-soon hint", () => {
    const src = read("src/components/admin/customer-receipt-lookup.tsx");
    it("Email button is disabled with aria-disabled and title='coming soon'", () => {
      expect(src).toMatch(/type="button"\s+disabled\s+aria-disabled="true"\s+title="Email receipts coming soon"/);
    });
    it("button label signals unavailable state", () => {
      expect(src).toMatch(/Email \(soon\)/);
    });
    it("prior dead alert() path is gone", () => {
      expect(src).not.toMatch(/alert\(`Email receipt to \$\{customer\.email/);
    });
  });

  describe("R74-F LOW: cancel UI surfaces server errors via window.alert", () => {
    it("transfer-manager Cancel button wraps cancelTransferAction in try/catch", () => {
      const src = read("src/components/admin/transfer-manager.tsx");
      expect(src).toMatch(/try \{\s*await cancelTransferAction\(tr\.id\);\s*\} catch \(e\) \{[\s\S]{0,200}window\.alert\(`Cancel failed:/);
    });
    it("stocktake-manager Cancel button wraps cancelStocktakeAction in try/catch", () => {
      const src = read("src/components/admin/stocktake-manager.tsx");
      expect(src).toMatch(/try \{\s*await cancelStocktakeAction\(st\.id\);\s*\} catch \(e\) \{[\s\S]{0,200}window\.alert\(`Cancel failed:/);
    });
  });

  describe("R74-G LOW: /api/transfers RECEIVE idempotency matches key + status", () => {
    const src = read("src/app/api/transfers/route.ts");
    it("RECEIVE short-circuit compares both status = 'received' AND idempotency_key = key", () => {
      const block = src.slice(src.indexOf('action === "receive"'));
      expect(block.slice(0, 4000)).toMatch(/existing\.rows\[0\]\.status === 'received'[\s\S]{0,300}existing\.rows\[0\]\.idempotency_key === idempotencyKey/);
    });
  });

  describe("R74-H MEDIUM: audit events in-tx for customer POST + PO PUT/PATCH", () => {
    it("/api/customers POST writes customer_created audit in-tx", () => {
      const src = read("src/app/api/customers/route.ts");
      expect(src).toMatch(/'customer_created'/);
    });
    it("/api/purchase-orders PUT writes purchase_order_updated audit in-tx", () => {
      const src = read("src/app/api/purchase-orders/route.ts");
      expect(src).toMatch(/'purchase_order_updated'/);
    });
    it("/api/purchase-orders PATCH writes purchase_order_received audit in-tx", () => {
      const src = read("src/app/api/purchase-orders/route.ts");
      expect(src).toMatch(/'purchase_order_received'/);
    });
  });

  describe("R74-I LOW: pgCreateCustomer throws typed 23505 error", () => {
    const src = read("src/lib/persistence/postgres-store.ts");
    it("wraps the INSERT in try/catch and rethrows friendly error on 23505", () => {
      const block = src.slice(src.indexOf("export async function pgCreateCustomer"));
      expect(block.slice(0, 3000)).toMatch(/err\?\.code === "23505"[\s\S]{0,500}A customer with this email already exists/);
    });
  });
});
