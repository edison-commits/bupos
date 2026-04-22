/**
 * R28 regression: pins fixes for the R28 adversarial audit findings.
 *
 *   H1 — guardrail column-list false-positive (regex must require predicate)
 *   C1 — /api/audit broken: `transaction_events.organization_id` doesn't exist
 *   C2 — GET /api/bundles cross-tenant leak
 *   C3 — `modifierTotal` not re-priced server-side in online checkout
 *   C4 — returns don't reverse earned loyalty points
 *   C5 — cross-location return restocks at register's location, not sale's
 *   C6 — PIN-reset step-up rate limit never gated (unlimited guesses)
 *   C7 — `receipt` broadcast grandTotal rendered without recomputation +
 *        schema price fields accepted negative values
 *
 * Each test reads source code and asserts the fix is present. Integration-
 * level proof (real PG, two orgs, exploit attempt) is out of scope here —
 * this is the static-code gate that prevents refactor-reverts.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("R28 fixes", () => {
  describe("H1 — guardrail requires predicate, not column-list mention", () => {
    const src = read("scripts/check-pool-query-org-filter.mjs");

    it("rejects a SELECT that lists organization_id without WHERE", () => {
      // The prior regex `/\borganization_id\b/i` matched any mention,
      // including the column in a SELECT list — which is how
      // `GET /api/bundles` passed the R27 sweep. The new predicate-form
      // check is anchored to `= $N` / `$${expr}`, `IN (`, or `= ANY(`.
      // R30-C3 extended the $N literal to also accept $${expr}
      // template-expression slots, so the regex fragment changed.
      expect(src).toMatch(/ORG_PREDICATE_RX/);
      expect(src).toMatch(/organization_id\\s\*=\\s\*\(\?:\\\$\\d\+\|\\\$\\\$\\\{/);
    });

    it("self-test asserts column-list-only fails + IN() + ANY() pass", () => {
      expect(src).toMatch(/column-list mention of organization_id without predicate should FAIL/);
      expect(src).toMatch(/IN \(\.\.\.\) predicate should pass/);
      expect(src).toMatch(/ANY\(\) predicate should pass/);
    });

    it("INSERTs with organization_id in column list are accepted", () => {
      // `INSERT INTO <tbl> (..., organization_id, ...)` is scoped-by-
      // construction. The guardrail accepts this shape without a
      // WHERE clause.
      expect(src).toMatch(/INSERT\\s\+INTO\\s\+\\w\+\\s\*\\\(\[\^\)\]\*\\borganization_id\\b/);
    });
  });

  describe("C1 — /api/audit route transaction_events scoping", () => {
    const src = read("src/app/api/audit/route.ts");

    it("transaction_events branch scopes via subquery through transactions", () => {
      // Direct `x.organization_id = $N` would 500 because the column
      // doesn't exist. Must be a subquery on the parent transactions.
      expect(src).toMatch(
        /x\.transaction_id IN \(SELECT id FROM transactions WHERE organization_id/,
      );
    });

    it("audit_events branch uses direct x.organization_id predicate", () => {
      expect(src).toMatch(/x\.organization_id = \$\{orgIdParam\}/);
    });

    it("does NOT apply x.organization_id to the transaction_events branch", () => {
      // Pre-fix had `addCond("x.organization_id = $N", orgId)` which
      // applied to BOTH branches — the problem. Search for the old
      // shared-condition pattern and verify it's gone.
      expect(src).not.toMatch(/addCond\("x\.organization_id = \$N"/);
    });
  });

  describe("C2 — GET /api/bundles predicates + JOIN scoping", () => {
    const src = read("src/app/api/bundles/route.ts");

    it("product_bundles SELECT has WHERE organization_id = $1", () => {
      // Find the GET handler's bundles query.
      const idx = src.indexOf("FROM product_bundles\n         WHERE organization_id");
      expect(idx).toBeGreaterThan(-1);
    });

    it("bundle_items SELECT JOINs product_bundles + gates on pb.organization_id", () => {
      expect(src).toMatch(
        /FROM bundle_items bi[\s\S]*?JOIN product_bundles pb[\s\S]*?WHERE pb\.organization_id/,
      );
    });
  });

  describe("C3 — online checkout re-prices modifiers server-side", () => {
    const src = read("src/app/register/checkout-action.ts");

    it("collects modifierIds + queries modifiers with org filter", () => {
      expect(src).toMatch(
        /SELECT id, price FROM modifiers WHERE id = ANY\(\$1::uuid\[\]\) AND organization_id = \$2/,
      );
    });

    it("overwrites item.modifierTotal with server-computed sum", () => {
      expect(src).toMatch(/item\.modifierTotal = Number\(sum\.toFixed\(2\)\)/);
    });

    it("zeros client-supplied modifierTotal when no modifiers present", () => {
      expect(src).toMatch(/item\.modifierTotal = 0/);
    });
  });

  describe("C4 — loyalty points reversed on refund", () => {
    it("register-side return-action pulls customer_id + reverses points", () => {
      const src = read("src/app/register/return-action.ts");
      expect(src).toMatch(/origCustomerId/);
      expect(src).toMatch(
        /UPDATE customers[\s\S]*?loyalty_points = GREATEST\(0, loyalty_points - \$1\)/,
      );
      // R29-H1 replaced the old `refundGrandTotal * earnRate` recompute
      // with a prorated reversal of the persisted `points_earned`.
      // R40-2 upgraded the formula to a cumulative-share delta (prevents
      // per-refund rounding from summing > origPointsEarned). The
      // reversal still derives from origPointsEarned; just bounded by
      // the cumulative share across all refunds.
      expect(src).toMatch(/Math\.round\(origPointsEarned \* newCumulativeShare\)/);
    });

    it("admin /api/returns/process reverses points too", () => {
      const src = read("src/app/api/returns/process/route.ts");
      // R29-H1 + R40-2: prorated from origPointsEarned via cumulative share.
      expect(src).toMatch(/Math\.round\(origPointsEarned \* newCumulativeShare\)/);
      expect(src).toMatch(
        /UPDATE customers[\s\S]*?loyalty_points = GREATEST\(0, loyalty_points - \$1\)/,
      );
    });
  });

  describe("C5 — cross-location return restocks at origLocation", () => {
    const src = read("src/app/register/return-action.ts");

    it("restockLocationId prefers origLocationId over context.location.id", () => {
      expect(src).toMatch(/restockLocationId = origLocationId \?\? context\.location\.id/);
    });

    it("inventory UPSERT uses restockLocationId, not context.location.id", () => {
      // Find the INSERT INTO inventory_levels and verify the param
      // passed is restockLocationId.
      const insertIdx = src.indexOf("INSERT INTO inventory_levels");
      expect(insertIdx).toBeGreaterThan(-1);
      const window = src.slice(insertIdx, insertIdx + 800);
      expect(window).toMatch(/restockLocationId/);
    });
  });

  describe("C6 — PIN-reset step-up rate limit is GATED", () => {
    const src = read("src/app/api/employees/route.ts");

    it("evaluates the rate-limit result before PBKDF2", () => {
      // Pre-fix: `rl(...)` was called inside the verify-failed branch
      // and its return value discarded. Post-fix: the check happens
      // BEFORE verifySecret and branches on `stepupRl.allowed`.
      expect(src).toMatch(/const stepupRl = rl\(`pin-reset-stepup:/);
      expect(src).toMatch(/if \(!stepupRl\.allowed\)/);
    });

    it("layers KV rate-limit for cross-isolate coherence", () => {
      expect(src).toMatch(/checkKvRateLimit\([^)]*pin-reset-stepup:/);
    });

    it("does NOT discard the rate-limit result inside a verify-failed branch", () => {
      // Find the verifySecret call for the actor password. The block
      // handling !verifySecret must NOT contain the earlier buggy
      // pattern `rl(\`pin-reset-stepup:...\`)` without a gate.
      // Easier assertion: the fix moved the rate-limit BEFORE the
      // orgQuery that fetches the actor's hash — so verify the rl
      // call appears before the actor SELECT in the source.
      const rlIdx = src.indexOf("const stepupRl = rl(`pin-reset-stepup:");
      const actorSelectIdx = src.indexOf("SELECT password_hash FROM auth_credentials WHERE employee_id = $1");
      expect(rlIdx).toBeGreaterThan(-1);
      expect(actorSelectIdx).toBeGreaterThan(-1);
      expect(rlIdx).toBeLessThan(actorSelectIdx);
    });
  });

  describe("C7 — BroadcastChannel schema + receipt trust", () => {
    const schema = read("src/lib/validation/display-message.ts");
    const pageSrc = read("src/app/customer-display/page.tsx");

    it("schema requires nonnegative prices (`money` helper)", () => {
      expect(schema).toMatch(/const money = z\.number\(\)\.finite\(\)\.nonnegative\(\)\.max\(10_000_000\)/);
    });

    it("schema bounds taxRate as a fraction (≤ 1.0)", () => {
      expect(schema).toMatch(/taxRate: z\.number\(\)\.finite\(\)\.nonnegative\(\)\.max\(1\)/);
    });

    it("schema uses .strict() on outer cart / cartLineItem / cartTotals", () => {
      // Count the `}).strict()` closures — expect at least 3.
      const matches = schema.match(/\}\)\.strict\(\)/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(3);
    });

    it("customer-display page NO LONGER trusts message.totals on receipt", () => {
      // The old code did `setTotals(message.totals)` directly. The new
      // code is a no-op comment explaining the security rationale.
      const receiptIdx = pageSrc.indexOf('case "receipt"');
      expect(receiptIdx).toBeGreaterThan(-1);
      const window = pageSrc.slice(receiptIdx, receiptIdx + 500);
      expect(window).not.toMatch(/setTotals\(message\.totals\)/);
      expect(window).toMatch(/R28-C7/);
    });
  });
});
