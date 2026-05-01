/**
 * R30 regression tests. Pins the round-30 fixes:
 *   C1 customers GET list carries a STATIC org predicate
 *   C2 /api/purchase-orders PUT has explicit org filter on UPDATE
 *   C3 guardrail matches single-quoted SQL + $${expr} param slots +
 *      no longer auto-passes dynamic interpolation shapes
 *   C4 cart.ts + offline-sync + refund paths clamp negative lineDiscount
 *   C5 register-side return-action acquires pg_advisory_xact_lock on
 *      originalTransactionId + re-reads prior returns inside the lock
 *   H1 admin returns/process restocks at origLocation not ctx.locationId
 *   H2 register-side store_credit refund rejects on missing customer
 *   H3 employees PATCH blocks self-deactivate + owner-on-owner
 *   H4 store-credit POST has per-request + rolling 24h caps
 *   H5 loyalty POST has rolling 24h cap + KV layer
 *   H6 revoke-all-sessions RL aligned with password-change (3+4)
 *   H7 device-mismatch deletes sessions row (not just ends register_sessions)
 *   H8 device-cookie secret throws on any Workers runtime
 *   H9 employees step-up RL aligned with password-change
 *   H10 admin returns/process filters by status='completed'
 *   H11 admin returns/process zero free-item refund via paidQuantity
 *   M1 pinHint schema rejects digit-only values
 *   M3 last_seen_at bump moved AFTER register device verification
 *   M4/M5 settings PUT + promo-codes POST + export GET are rate-limited
 *   L1 transfers POST `create` destructures from v.data (not raw body)
 *   L3 shifts `date` param format-validated
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R30 findings", () => {
  describe("C1 customers GET list static org predicate", () => {
    const src = read("src/app/api/customers/route.ts");
    it("base SQL has WHERE c.organization_id = $1 literally", () => {
      expect(src).toMatch(/FROM customers c\s+WHERE c\.organization_id = \$1/);
    });
    it("no longer uses empty `conditions` that yields bare SELECT", () => {
      expect(src).not.toMatch(/conditions: string\[\] = \[\];/);
    });
  });

  describe("C2 purchase-orders PUT has org filter", () => {
    const src = read("src/app/api/purchase-orders/route.ts");
    it("UPDATE WHERE includes `AND organization_id = $${idx + 1}`", () => {
      expect(src).toMatch(/UPDATE purchase_orders.*AND organization_id = \$\$\{idx \+ 1\}/);
    });
  });

  describe("C3 guardrail hardening", () => {
    const src = read("scripts/check-pool-query-org-filter.mjs");
    it("extractor matches backtick AND single-quote AND double-quote literals", () => {
      // Corresponds to the updated rx1 pattern covering all three quote styles.
      expect(src).toMatch(/`\[\^`\]\+`\|'\[\^'\\n\]\+'\|"\[\^"\\n\]\+"/);
    });
    it("ORG_PREDICATE_RX accepts $${expr} template-expression slots", () => {
      expect(src).toMatch(/\\\$\\\$\\\{\[\^\}\]\+\\\}/);
    });
    it("no longer auto-passes on dynamic ${whereClause} alone", () => {
      expect(src).not.toMatch(/return \{ ok: true, dynamic: true \};/);
    });
  });

  describe("C4 clamp negative lineDiscount", () => {
    it("cart.ts clamps lineDiscount.value at 0", () => {
      const src = read("src/lib/cart/cart.ts");
      expect(src).toMatch(/Math\.max\(0, item\.lineDiscount\.value\)/);
    });
    it("cart.ts clamps cart.discountAmount at 0", () => {
      // R34-D4 extended the clamp to also reject Infinity/NaN via
      // Number.isFinite, so the exact regex shape changed. Pin on
      // the behavior: `rawCartDiscount` exists and feeds into
      // `Math.max(0, ...)`.
      const src = read("src/lib/cart/cart.ts");
      expect(src).toMatch(/Math\.max\(0, rawCartDiscount\)/);
    });
    it("offline-sync clamps per-line lineDiscount", () => {
      const src = read("src/app/api/offline-sync/route.ts");
      expect(src).toMatch(/Math\.max\(0, Number\(item\.lineDiscount\.value\) \|\| 0\)/);
    });
    it("offline-sync clamps cart-level discountAmount", () => {
      const src = read("src/app/api/offline-sync/route.ts");
      expect(src).toMatch(/clampedCartDiscountAmount/);
    });
    it("refund paths clamp discountFactor at [0, 1]", () => {
      const a = read("src/app/api/returns/process/route.ts");
      const b = read("src/app/api/returns/route.ts");
      const c = read("src/app/register/return-action.ts");
      // R37-H2 ported the register-side R36-H3 denominator upgrade to
      // the two admin paths: denominator is now `origTaxableBase =
      // subtotal + modifiers` (matching computeTotals) instead of
      // `origSubtotal` alone. All three paths still clamp at [0, 1]
      // (the R30-C4 invariant this test was originally about).
      expect(a).toMatch(/Math\.min\(1, Math\.max\(0, 1 - origDiscount \/ origTaxableBase\)\)/);
      expect(b).toMatch(/Math\.min\(1, Math\.max\(0, 1 - origDiscount \/ origTaxableBase\)\)/);
      expect(c).toMatch(/Math\.min\(1, Math\.max\(0, 1 - origDiscountTotal \/ origTaxableBase\)\)/);
    });
  });

  describe("C5 register-side advisory lock on refund", () => {
    const src = read("src/app/register/return-action.ts");
    it("acquires pg_advisory_xact_lock keyed on `return:<originalTransactionId>`", () => {
      expect(src).toMatch(/pg_advisory_xact_lock/);
      expect(src).toMatch(/`return:\$\{input\.originalTransactionId\}`/);
    });
    it("lock is acquired BEFORE the prior-return reads (R35-P2)", () => {
      // R35-P2 reordered the flow: advisory lock → consolidated
      // Promise.all reads. With the lock held first, the single read
      // IS the post-lock state — no drift check required. Previously
      // the pool-based pre-read ran outside the tx and a priorAfterLock*
      // re-check ran inside; the consolidated shape removes both the
      // pre-read and the re-check without loss of serialization.
      const lockIdx = src.indexOf("pg_advisory_xact_lock");
      const readsIdx = src.indexOf("Promise.all");
      expect(lockIdx).toBeGreaterThan(0);
      expect(readsIdx).toBeGreaterThan(lockIdx);
      // Old priorAfterLock* variables must not re-appear.
      expect(src).not.toMatch(/priorAfterLockTxn|priorAfterLockTable/);
    });
  });

  describe("H1 admin returns/process restocks at origLocation", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("pulls location_id from the original transaction", () => {
      expect(src).toMatch(/cart_snapshot, location_id/);
    });
    it("uses restockLocationId (not ctx.locationId) in inventory writes", () => {
      expect(src).toMatch(/restockLocationId = origLocationId \?\? locationId/);
      // INT-AUDIT5-HIGH3 refactored the per-variant serial loop into
      // a SINGLE batched UPSERT via unnest (deterministic lock-order
      // to eliminate the deadlock window). Parameter shape moved from
      // `[orgId, variantId, restockLocationId, qty]` (per-iteration)
      // to `[orgId, restockLocationId, variantIds, quantities]` (one
      // call). Assert the new shape — restockLocationId is still the
      // anchor (not ctx.locationId), which is the original intent.
      expect(src).toMatch(/\[orgId, restockLocationId, variantIds, quantities\]/);
    });
  });

  describe("H2 register-side rejects store_credit without customer", () => {
    const src = read("src/app/register/return-action.ts");
    it("throws when origCustomerId is null AND refundMethod is store_credit", () => {
      expect(src).toMatch(/Store-credit refund requires a customer on the original transaction/);
    });
  });

  describe("H3 employees PATCH self-management checks", () => {
    const src = read("src/app/api/employees/route.ts");
    it("blocks self-deactivate/activate", () => {
      expect(src).toMatch(/You cannot change your own activation status/);
    });
    it("blocks owner-on-owner mutations", () => {
      expect(src).toMatch(/actor\.roleKey === 'owner' && targetRole === 'owner'/);
    });
  });

  describe("H4 store-credit POST rolling 24h + per-request caps", () => {
    const src = read("src/app/api/store-credit/route.ts");
    it("per-request cap of $5000", () => {
      expect(src).toMatch(/MAX_STORE_CREDIT_PER_REQUEST = 5_000/);
    });
    it("rolling 24h cap of $25000", () => {
      expect(src).toMatch(/MAX_DAILY_STORE_CREDIT_PER_ACTOR = 25_000/);
    });
    it("aggregates from store_credit_ledger with rolling 24h window", () => {
      expect(src).toMatch(/FROM store_credit_ledger[\s\S]*now\(\) - interval '24 hours'/);
    });
  });

  describe("H5 loyalty POST caps + KV layer", () => {
    const src = read("src/app/api/loyalty/route.ts");
    it("adds checkKvRateLimit layer", () => {
      expect(src).toMatch(/checkKvRateLimit\(`loyalty-adjust/);
    });
    it("adds MAX_DAILY_LOYALTY_MINT_PER_ACTOR", () => {
      expect(src).toMatch(/MAX_DAILY_LOYALTY_MINT_PER_ACTOR = 50_000/);
    });
  });

  describe("H6 revoke-all-sessions RL tightening", () => {
    const src = read("src/app/api/auth/revoke-all-sessions/route.ts");
    it("in-memory cap 3/5min (aligned with password-change)", () => {
      expect(src).toMatch(/maxAttempts: 3, windowMs: 300_000/);
    });
    it("KV layer cap 4/5min", () => {
      expect(src).toMatch(/checkKvRateLimit\(`pwd-change:\$\{ctx\.employee\.id\}`, \{\s*maxAttempts: 4/);
    });
  });

  describe("H7 device-mismatch deletes sessions row", () => {
    const src = read("src/lib/auth/session.ts");
    it("DELETEs the sessions row on device mismatch", () => {
      expect(src).toMatch(/DELETE FROM sessions WHERE id = \$1/);
    });
  });

  describe("H8 device-cookie secret hardening", () => {
    it("device-cookie throws on Workers runtime AND production", () => {
      const src = read("src/lib/auth/device-cookie.ts");
      expect(src).toMatch(/isWorkersRuntime\(\)/);
      expect(src).toMatch(/process\.env\.NODE_ENV === "production" \|\| isWorkersRuntime\(\)/);
    });
    it("display-token also hardened", () => {
      const src = read("src/lib/auth/display-token.ts");
      expect(src).toMatch(/process\.env\.NODE_ENV === "production" \|\| isWorkersRuntime\(\)/);
    });
  });

  describe("H9 employees step-up RL alignment (now via shared requireStepUp)", () => {
    // R44-MED: the inline `pin-reset-stepup` rate-limit was replaced
    // by the shared `requireStepUp` helper (src/lib/auth/step-up.ts),
    // which carries its own 3/5min mem + 4/5min KV caps plus an
    // aggregate per-actor cap. H9's alignment goal (match password-
    // change) is preserved by the shared helper's caps.
    const stepUpSrc = read("src/lib/auth/step-up.ts");
    it("shared requireStepUp helper enforces 3/5min in-mem cap", () => {
      expect(stepUpSrc).toMatch(/maxAttempts:\s*3,\s*windowMs:\s*300_000/);
    });
    it("shared requireStepUp helper enforces 4/5min KV cap", () => {
      expect(stepUpSrc).toMatch(/maxAttempts:\s*4,\s*windowMs:\s*300_000/);
    });
  });

  describe("H10 admin returns/process filters by status='completed'", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("transaction SELECT requires status = 'completed'", () => {
      expect(src).toMatch(/WHERE id = \$1 AND organization_id = \$2 AND status = 'completed'/);
    });
  });

  describe("H11 admin returns/process zero free-item refund", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("tracks paidQuantity separately from quantity", () => {
      expect(src).toMatch(/paidQuantity:/);
    });
    it("refund math uses paidShare = min(requested, paidRemaining)", () => {
      expect(src).toMatch(/paidRemaining = Math\.max\(0, orig\.paidQuantity - alreadyReturned\)/);
      expect(src).toMatch(/paidShare = Math\.min\(item\.quantity, paidRemaining\)/);
    });
  });

  describe("M1 pinHint schema rejects digit-only values", () => {
    const src = read("src/lib/validation/schemas.ts");
    it("declares a pinHintField with a letter-required refine", () => {
      // R31-M1 tightened the regex — the R30 message was
      // "cannot be only digits", the R31 message is
      // "must contain at least one letter". Either is acceptable;
      // pin on the field name + the "PIN hint" fragment.
      expect(src).toMatch(/pinHintField/);
      expect(src).toMatch(/PIN hint/);
    });
    it("employeeCreate + update + patch use pinHintField", () => {
      // After the replace_all, `optionalString` still appears for OTHER fields.
      // The pinHint rows specifically must NOT use optionalString anymore.
      expect(src).not.toMatch(/pinHint: optionalString/);
    });
  });

  describe("M3 last_seen_at reorder", () => {
    const src = read("src/lib/auth/session.ts");
    it("admin scope bumps inline; register waits until device verify", () => {
      expect(src).toMatch(/scope === "admin" && isPg\(\) && pgClient/);
    });
    it("a second UPDATE sessions ... last_seen_at call lives after the device check", () => {
      // Match two distinct inline UPDATE sessions SET last_seen_at calls.
      const hits = src.match(/UPDATE sessions SET last_seen_at = NOW\(\)/g) ?? [];
      expect(hits.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("M4/M5 rate-limit on mutation endpoints", () => {
    it("settings PUT rate-limits per employee", () => {
      const src = read("src/app/api/settings/route.ts");
      expect(src).toMatch(/checkRateLimit\(`settings-put:/);
    });
    it("promo-codes POST rate-limits per employee", () => {
      const src = read("src/app/api/promo-codes/route.ts");
      expect(src).toMatch(/checkRateLimit\(`promo-codes:/);
    });
    it("export GET rate-limits per employee", () => {
      const src = read("src/app/api/export/route.ts");
      expect(src).toMatch(/checkRateLimit\(`export:/);
    });
  });

  describe("L1 transfers POST uses validated data", () => {
    const src = read("src/app/api/transfers/route.ts");
    it("destructures from v.data not body", () => {
      expect(src).toMatch(/const \{ sourceLocationId, destinationLocationId, notes, lines \} = v\.data/);
    });
  });

  describe("L3 shifts date format validated", () => {
    const src = read("src/app/api/shifts/route.ts");
    it("rejects malformed date with 400", () => {
      expect(src).toMatch(/Invalid date format\. Use YYYY-MM-DD\./);
    });
  });
});
