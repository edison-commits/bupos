/**
 * R72 regression tests. Pins audit round 18 — 11 findings
 * (0 CRITICAL + 0 HIGH + 6 MEDIUM + 5 LOW out of 13; 2 LOW deferred
 * as UX-only with non-trivial refactor cost).
 *
 * Highlights:
 *   MED A1-A6: 23505 slug-conflict handlers rolled out across
 *           editCategoryAction, editProductAction, createProductAction,
 *           REST POST category-create + product-create, REST PUT
 *           product-update, activateGiftCardAction.
 *   LOW B1: cancelTransferAction (REST + Server Action) + audit
 *           event in-tx.
 *   LOW B2: cancelStocktakeAction audit event in-tx.
 *   LOW C1: /api/transfers SHIP idempotency-key short-circuit moved
 *           ABOVE step-up so retries don't exhaust the bucket.
 *   LOW C2: receiveTransferAction + REST receive step-up (mirror of
 *           ship — destination inventory crediting).
 *   LOW D:  loyalty-tiers fieldset gets aria-label + sr-only legend.
 *   DEFERRED: returns input NaN snap-to-1 UX (requires string-state
 *             refactor; functional behavior is correct).
 *   DEFERRED: loyalty-tiers expander keyboard accessibility (pre-
 *             existing, not R70-introduced).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R72 audit fixes — round 18", () => {
  describe("R72-A MEDIUM: 23505 slug-conflict handlers", () => {
    it("editCategoryAction catches 23505 + redirects with friendly message", () => {
      const src = read("src/app/admin/actions.ts");
      const block = src.slice(src.indexOf("export async function editCategoryAction"));
      expect(block.slice(0, 4000)).toMatch(/code === "23505"/);
      expect(block.slice(0, 4000)).toMatch(/A category with slug/);
    });
    it("editProductAction catches 23505", () => {
      const src = read("src/app/admin/actions.ts");
      const block = src.slice(src.indexOf("export async function editProductAction"));
      expect(block.slice(0, 4000)).toMatch(/code === "23505"/);
      expect(block.slice(0, 4000)).toMatch(/A product with slug/);
    });
    it("createProductAction catches 23505 on pgCreateProduct", () => {
      const src = read("src/app/admin/actions.ts");
      const block = src.slice(src.indexOf("export async function createProductAction"));
      expect(block.slice(0, 8000)).toMatch(/pgCreateProduct\(\{[\s\S]{0,1500}\}\);[\s\S]{0,300}e\.code === "23505"/);
    });
    it("/api/products POST category-create returns 409 on 23505", () => {
      const src = read("src/app/api/products/route.ts");
      const idx = src.indexOf("Handle category creation");
      const block = src.slice(idx, idx + 4000);
      expect(block).toMatch(/if \(e\.code === '23505'\)[\s\S]{0,300}A category with slug/);
      expect(block).toMatch(/\{ status: 409 \}/);
    });
    it("/api/products POST product-create returns 409 on 23505", () => {
      const src = read("src/app/api/products/route.ts");
      // product-create branch: the INSERT INTO products happens
      // after variant/category branches.
      expect(src).toMatch(/INSERT INTO products \(id, organization_id, category_id, name, slug[\s\S]{0,1000}A product with slug/);
    });
    it("/api/products PUT product-update returns 409 on 23505", () => {
      const src = read("src/app/api/products/route.ts");
      // PUT UPDATE block: the UPDATE has `fields.join(', ')` interpolation.
      expect(src).toMatch(/UPDATE products SET[\s\S]{0,200}fields\.join[\s\S]{0,1500}if \(e\.code === '23505'\)/);
    });
    it("activateGiftCardAction catches 23505 on gift_cards INSERT", () => {
      const src = read("src/app/admin/gift-card-actions.ts");
      // The try/catch wraps the INSERT call. Match the distinctive
      // 23505 handler with the "already exists" message.
      expect(src).toMatch(/Gift card code.*already exists/);
      expect(src).toMatch(/e\.code === "23505"/);
    });
  });

  describe("R72-B LOW: cancel emits audit events", () => {
    it("cancelTransferAction audit in-tx", () => {
      const src = read("src/app/admin/transfer-actions.ts");
      const block = src.slice(src.indexOf("export async function cancelTransferAction"));
      expect(block.slice(0, 5000)).toMatch(/'transfer_cancelled'/);
    });
    it("REST /api/transfers cancel audit in-tx", () => {
      const src = read("src/app/api/transfers/route.ts");
      expect(src).toMatch(/'transfer_cancelled'/);
    });
    it("cancelStocktakeAction emits stocktake_cancelled audit", () => {
      const src = read("src/app/admin/stocktake-actions.ts");
      expect(src).toMatch(/'stocktake_cancelled'/);
    });
  });

  describe("R72-C LOW: receive step-up + idempotency order", () => {
    it("REST /api/transfers ship: idempotency short-circuit runs BEFORE step-up", () => {
      const src = read("src/app/api/transfers/route.ts");
      const shipBlock = src.slice(src.indexOf('action === "ship"'));
      // The idempotency `if (idempotencyKey)` block must come
      // before the `requireStepUp` call in the ship branch.
      const idempIdx = shipBlock.indexOf("if (idempotencyKey)");
      const stepUpIdx = shipBlock.indexOf("transfer-ship-stepup");
      expect(idempIdx).toBeGreaterThan(-1);
      expect(stepUpIdx).toBeGreaterThan(-1);
      expect(idempIdx).toBeLessThan(stepUpIdx);
    });
    it("receiveTransferAction accepts actorPassword + requires step-up", () => {
      const src = read("src/app/admin/transfer-actions.ts");
      expect(src).toMatch(/export async function receiveTransferAction\(transferId: string, actorPassword\?: string\)/);
      expect(src).toMatch(/bucketKey:\s*["']transfer-receive-stepup["']/);
    });
    it("REST receive branch calls requireStepUp with transfer-receive-stepup bucket", () => {
      const src = read("src/app/api/transfers/route.ts");
      const block = src.slice(src.indexOf('action === "receive"'));
      expect(block.slice(0, 3000)).toMatch(/bucketKey:\s*["']transfer-receive-stepup["']/);
    });
    it("transfer-manager UI prompts before Mark Received", () => {
      const src = read("src/components/admin/transfer-manager.tsx");
      expect(src).toMatch(/receiveTransferAction\(tr\.id, pwd\)/);
    });
  });

  describe("R72-D LOW: loyalty-tiers fieldset has aria-label + sr-only legend", () => {
    const src = read("src/components/admin/loyalty-tiers.tsx");
    it("fieldset has aria-label describing preview state", () => {
      expect(src).toMatch(/<fieldset disabled className="grid gap-4 opacity-75" aria-label="Tier Configuration \(Preview/);
    });
    it("sr-only legend provides additional context", () => {
      expect(src).toMatch(/<legend className="sr-only">Tier Configuration \(Preview/);
    });
  });
});
