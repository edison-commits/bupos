"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
import { requireRegisterPermission } from "@/lib/authz";
import { mutateStore } from "@/lib/persistence/store";
import { orgTx } from "@/lib/supabase-rest";
import type { TenderType } from "@/lib/domain/types";
import { getRegisterConfig, readRegisterConfigWith } from "@/lib/config/register-config";
import { formatCurrency } from "@/lib/format";

export interface ReturnLineItem {
  productVariantId: string;
  productName: string;
  variantName: string;
  sku: string;
  unitPrice: number;
  quantity: number;
  /**
   * Present iff this line is a bundle. Carried through verbatim from the
   * original transaction's cart_snapshot so the server can expand it back
   * into component variants for inventory restore. Client-supplied values
   * are re-checked against `bundle_items` in the DB — never trusted.
   */
  bundleId?: string;
  bundleComponents?: { productVariantId: string; quantity: number }[];
  /**
   * Present iff this line was a free-with-purchase promo redemption on the
   * original transaction. Server zeroes the refund amount for this line
   * (customer paid $0; refunding $22 would be a real money loss) and
   * reverses the promo_redemption so the code's max_redemptions counter
   * isn't permanently burned.
   */
  promoCodeId?: string;
}

export interface ReturnInput {
  originalTransactionId: string;
  items: ReturnLineItem[];
  refundMethod: TenderType;
  reason: string;
  note: string;
}

export interface ReturnResult {
  returnTransactionId: string;
  refundTotal: number;
  refundMethod: TenderType;
}

const isPg = () => !!process.env.USE_POSTGRES;

export async function processReturnAction(input: ReturnInput): Promise<ReturnResult> {
  const context = await requireRegisterPermission("register.open");

  if (input.items.length === 0) {
    throw new Error("No items selected for return");
  }

  // R33-H9: if the PG path is active, originalTransactionId is
  // REQUIRED so origItems can be populated. Prior shape permitted
  // isPg() true + empty originalTransactionId which left origItems
  // empty, and the refund reducer's `origFromSnapshot === undefined`
  // short-circuit fell through to `item.unitPrice * …` — the exact
  // R32-H6 exploit vector. Refuse the refund up front rather than
  // relying on the reducer's fallback behavior.
  if (isPg() && !input.originalTransactionId) {
    throw new Error("Original transaction id is required for refunds on the PG path");
  }

  // Estimated refund — used for the threshold check (before we know the
  // exact DB-derived figures). The authoritative refund amount is
  // computed inside the tx against origItems + origDiscountFactor below.
  const estimatedRefund = input.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const isManager = context.employee.roleKey === "manager" || context.employee.roleKey === "owner";

  const returnTransactionId = randomUUID();

  if (isPg()) {
    // R35-P2: open the tx client FIRST and do every pre-tx read on the
    // same connection. Before this round the return action spawned up
    // to 6 separate one-shot Neon pools (regConfig + origTxn +
    // priorTxn + priorTable + cashTender + priorCashRefund) — each a
    // 50-150ms WebSocket handshake. The advisory lock now sits at the
    // top of the tx, so the single consolidated read is already
    // post-lock — we can delete the redundant post-lock re-read that
    // previously lived below.
    const cashRefund = input.refundMethod === "cash" && !!input.originalTransactionId;

    const client = await orgTx(context.employee.organizationId);
    try {
      // R30-C5 (moved up): serialize concurrent refunds for the same
      // original transaction via pg_advisory_xact_lock. Taking the lock
      // BEFORE the reads below means those reads reflect the
      // authoritative (post-lock) state — no TOCTOU gap between the
      // prior-return counts and the inserts.
      if (input.originalTransactionId) {
        await client.query(
          `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
          [`return:${input.originalTransactionId}`],
        );
      }

      // R78-SEC-H2 (HIGH): serialize against closeShiftEnhancedAction.
      // register-side return-action.ts never locked the shift/register
      // session row — and closeShiftEnhancedAction (R76-DB-H2) took
      // FOR UPDATE + advisory lock, so this path didn't wait on it.
      // Interleaving: close takes locks + snapshots cashSales + flips
      // status='closed' + commits; return commits a -N cash refund
      // on the same register_session AFTER the close's snapshot;
      // the refund is invisible to the closed shift AND any later
      // shift (the negative tender's t.created_at falls before any
      // later shift's opened_at). Physical cash leaves the drawer
      // with zero reconciliation evidence. Mirror the checkout-
      // action.ts lock pattern: FOR UPDATE the register_session
      // row for every return, AND FOR UPDATE SKIP LOCKED the open
      // shift when the refund is cash (matches /api/returns +
      // /api/returns/process SKIP LOCKED pattern from R77-DB-H1).
      await client.query(
        `SELECT id FROM register_sessions WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [context.registerSession.id, context.employee.organizationId],
      );
      if (cashRefund) {
        const { rows: shiftLock } = await client.query(
          `SELECT id FROM shifts
             WHERE organization_id = $1 AND location_id = $2 AND status = 'open'
             ORDER BY opened_at DESC LIMIT 1
             FOR UPDATE SKIP LOCKED`,
          [context.employee.organizationId, context.location.id],
        );
        if (shiftLock.length === 0) {
          throw new Error(
            "Cash refund requires an open shift at this location (or shift is being closed — retry).",
          );
        }
      }

      // R35-P2: consolidated reads.
      const [
        regConfig,
        origRes,
        priorTxnRes,
        priorTableRes,
        cashTenderRes,
        priorCashRefRes,
      ] = await Promise.all([
        readRegisterConfigWith(client, context.employee.organizationId),
        input.originalTransactionId
          ? client.query(
              `SELECT cart_snapshot, subtotal, discount_total, tax_total, location_id, customer_id, points_earned, grand_total
                 FROM transactions
                WHERE id = $1 AND organization_id = $2 AND status = 'completed'`,
              [input.originalTransactionId, context.employee.organizationId],
            )
          : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
        input.originalTransactionId
          ? client.query(
              // Aggregate prior returns — check BOTH (a) return-action rows
              // (stored as transactions with cart_snapshot.originalTransactionId)
              // and (b) admin /api/returns/process rows (checked via
              // priorTableRes below). Without the cross-table check a
              // customer can return via admin then again via register for
              // double-refund up to the original quantity.
              `SELECT cart_snapshot FROM transactions
                 WHERE organization_id = $1
                   AND status = 'completed'
                   AND cart_snapshot->>'originalTransactionId' = $2`,
              [context.employee.organizationId, input.originalTransactionId],
            )
          : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
        input.originalTransactionId
          ? client.query(
              // Include PENDING returns too — otherwise an admin-created
              // pending return plus a register-side return can both pass
              // their per-path caps and double-restock / double-refund
              // the same units.
              `SELECT rl.product_variant_id, rl.quantity
                 FROM return_lines rl
                 JOIN returns r ON r.id = rl.return_id
                WHERE r.organization_id = $1 AND r.transaction_id = $2
                  AND r.status IN ('pending', 'completed')`,
              [context.employee.organizationId, input.originalTransactionId],
            )
          : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
        // Cash-refund cap reads: only needed when refunding to cash.
        // Gift-card and store-credit tenders do NOT contribute to
        // cash-refundable headroom — mirror the admin rule.
        cashRefund
          ? client.query(
              // R26-F1: JOIN to transactions for explicit org scoping.
              // originalTransactionId is client-supplied.
              `SELECT COALESCE(SUM(tt.amount), 0)::numeric AS cash_tendered
                 FROM transaction_tenders tt
                 JOIN transactions t ON t.id = tt.transaction_id
                WHERE tt.transaction_id = $1 AND tt.amount > 0
                  AND tt.tender_type NOT IN ('gift_card', 'store_credit', 'loyalty')
                  AND t.organization_id = $2`,
              [input.originalTransactionId, context.employee.organizationId],
            )
          : Promise.resolve({ rows: [{ cash_tendered: "0" }] as Record<string, unknown>[] }),
        cashRefund
          ? client.query(
              `SELECT COALESCE(SUM(ABS(tt.amount)), 0)::numeric AS prior_cash_refunded
                 FROM transaction_tenders tt
                 JOIN transactions t ON t.id = tt.transaction_id
                WHERE tt.transaction_id = $1 AND tt.amount < 0
                  AND tt.tender_type NOT IN ('gift_card', 'store_credit', 'loyalty')
                  AND t.organization_id = $2`,
              [input.originalTransactionId, context.employee.organizationId],
            )
          : Promise.resolve({ rows: [{ prior_cash_refunded: "0" }] as Record<string, unknown>[] }),
      ]);

      // Enforce return threshold — cashier-level returns above threshold
      // require manager role. Managers and owners can process any amount;
      // all other roles (cashier, clerk, etc.) are gated.
      const returnThreshold = regConfig.approvalThresholds.returnWithoutManagerOver;
      if (estimatedRefund > returnThreshold && !isManager) {
        throw new Error(
          `Return of ${formatCurrency(estimatedRefund)} exceeds ${formatCurrency(returnThreshold)} threshold. Manager must process.`,
        );
      }

      // --- Process original-transaction read ---
      if (input.originalTransactionId && origRes.rows.length === 0) {
        throw new Error("Original transaction not found");
      }
      const origRow = (origRes.rows[0] ?? {}) as Record<string, unknown>;

      // Cross-location return guard. Inventory is restocked at the REGISTER's
      // location (context.location.id), not the original sale's. A customer
      // returning at Location A for a sale made at Location B would: (a)
      // restock at A (stock they never had), (b) not decrement B's records,
      // (c) still be returnable at B since prior-returns are aggregated
      // org-wide but physical units stay in the customer's hands — a free
      // double-refund. Require the return be processed at the originating
      // location unless the cashier is a manager who can justify the
      // exception. Managers accept the responsibility for the accounting
      // skew; the cart_snapshot below records original_location_id for
      // future reconciliation.
      const origLocationId = (origRow.location_id as string | undefined) ?? null;
      const origCustomerId = (origRow.customer_id as string | null | undefined) ?? null;
      const origPointsEarned = Number(origRow.points_earned ?? 0) || 0;
      const origGrandTotal = Number(origRow.grand_total ?? 0) || 0;

      if (origLocationId && origLocationId !== context.location.id && !isManager) {
        throw new Error(
          "This item was sold at a different location. Return it at the original location or ask a manager to process.",
        );
      }

      const origSnapshot = typeof origRow.cart_snapshot === 'string'
        ? JSON.parse(origRow.cart_snapshot)
        : origRow.cart_snapshot;
      const origItems = (origSnapshot?.items ?? []) as Array<{
        productVariantId: string;
        unitPrice: number;
        overridePrice?: number;
        quantity: number;
        bundleId?: string;
        bundleComponents?: { productVariantId: string; quantity: number }[];
        promoCodeId?: string;
      }>;

      const origSubtotal = Number(origRow.subtotal ?? 0);
      const origDiscountTotal = Number(origRow.discount_total ?? 0) || 0;
      const origTaxTotal = Number(origRow.tax_total ?? 0);

      // R36-H3: compute the FULL sale base the customer was taxed/
      // discounted against: `subtotal + modifiers`. computeTotals applies
      // cart discount against `(subtotal + modifiers - lineDiscounts)`,
      // so deriving tax/discount ratios from `subtotal` alone (old code)
      // under-counts modifier upcharges — any cart with modifiers saw
      // `origTaxRate` inflated (because denominator is smaller) and
      // `origDiscountFactor` skewed. The refund denominator now tracks
      // the real taxable/discounted base; customers who paid for
      // modifier upcharges now get them refunded.
      const origModifiersTotal = origItems.reduce(
        (s, it) => s + (Number(it.quantity) || 0) * (Number((it as { modifierTotal?: number }).modifierTotal ?? 0) || 0),
        0,
      );
      const origTaxableBase = origSubtotal + origModifiersTotal;

      let origTaxRate: number | null = null;
      let origDiscountFactor = 1;
      if (origTaxableBase > 0) {
        // R28-M9: cap derived tax rate at 0.5 (50%). Defense-in-depth
        // for a hypothetical future path that might forge `tax_total`
        // on the original transaction — without the cap, the attacker's
        // refund = origUnitPrice × qty × discountFactor × (1 + forgedRate)
        // could inflate arbitrarily. Real jurisdictions top out around
        // 20%; 50% is a sanity ceiling that can't hide a real tax
        // rate but blocks absurd forgeries. Mirrors the admin path.
        const rawRate = origTaxTotal / origTaxableBase;
        origTaxRate = Number(Math.min(0.5, Math.max(0, rawRate)).toFixed(6));
        // R30-C4 + R36-H3: clamp to [0, 1]. Denominator is the full
        // taxable base (subtotal + modifiers), matching computeTotals.
        // Prior shape used `subtotal` alone, so a sale with modifier
        // upcharges + cart discount produced factor < 0 (bounds-clamped
        // to 0 → no refund at all) even when the customer had legitimately
        // paid for the modifiers after the discount.
        origDiscountFactor = Math.min(1, Math.max(0, 1 - origDiscountTotal / origTaxableBase));
      } else if (input.originalTransactionId) {
        origTaxRate = 0;
      }

      // Partition prior returns by line kind.
      const priorReturnedByVariant: Record<string, number> = {};
      const priorReturnedByBundle: Record<string, number> = {};
      const priorReturnedByFreePromo: Record<string, number> = {};
      for (const r of priorTxnRes.rows as Record<string, unknown>[]) {
        const snap = typeof r.cart_snapshot === 'string' ? JSON.parse(r.cart_snapshot as string) : r.cart_snapshot;
        const items = ((snap as { items?: unknown })?.items ?? []) as Array<{
          productVariantId: string; quantity: number;
          bundleId?: string; promoCodeId?: string;
        }>;
        for (const it of items) {
          if (it.bundleId) {
            priorReturnedByBundle[it.bundleId] = (priorReturnedByBundle[it.bundleId] ?? 0) + (it.quantity ?? 0);
          } else if (it.promoCodeId) {
            priorReturnedByFreePromo[it.promoCodeId] = (priorReturnedByFreePromo[it.promoCodeId] ?? 0) + (it.quantity ?? 0);
          } else {
            priorReturnedByVariant[it.productVariantId] = (priorReturnedByVariant[it.productVariantId] ?? 0) + (it.quantity ?? 0);
          }
        }
      }
      // Admin `/api/returns/process` rows lack the bundleId/promoCodeId
      // signal, so duplicate each row into all three maps. A real collision
      // between a variantId and a bundleId/promoCodeId is prevented by
      // gen_random_uuid(). Per-line code reads only ONE map per line type.
      for (const r of priorTableRes.rows as Array<{ product_variant_id: string; quantity: number }>) {
        const qty = Number(r.quantity) ?? 0;
        priorReturnedByVariant[r.product_variant_id] = (priorReturnedByVariant[r.product_variant_id] ?? 0) + qty;
        priorReturnedByBundle[r.product_variant_id] = (priorReturnedByBundle[r.product_variant_id] ?? 0) + qty;
        priorReturnedByFreePromo[r.product_variant_id] = (priorReturnedByFreePromo[r.product_variant_id] ?? 0) + qty;
      }

      // Per-item validation
      for (const item of input.items) {
        // Bundle line: match on bundleId rather than productVariantId (the
        // latter is a sentinel set to bundleId in checkout — see
        // src/lib/cart/types.ts). Verify the ORIGINAL line was a bundle line,
        // prices match, and quantity is available. `bundleComponents` on the
        // return input is re-derived from the DB below; we do NOT trust
        // anything the client sent under that key.
        if (item.bundleId) {
          const origBundleLine = origItems.find((o) => o.bundleId === item.bundleId);
          if (!origBundleLine) {
            throw new Error(`Bundle ${item.productName} was not in the original transaction`);
          }
          if (Math.abs(origBundleLine.unitPrice - item.unitPrice) > 0.01) {
            throw new Error(`Bundle price mismatch for ${item.productName}: expected ${formatCurrency(origBundleLine.unitPrice)}`);
          }
          const alreadyReturned = priorReturnedByBundle[item.bundleId] ?? 0;
          const remaining = origBundleLine.quantity - alreadyReturned;
          if (item.quantity > remaining) {
            throw new Error(`Only ${Math.max(0, remaining)} of ${item.productName} remain available to return`);
          }
          continue;
        }

        // Free-item promo line: match on (productVariantId, promoCodeId) in
        // the original snapshot AND require overridePrice=0 there. Refund
        // amount for this line is forced to $0 further below. Otherwise a
        // customer who got a "free" tee could return it for the variant's
        // list price — a direct cash-out exploit.
        if (item.promoCodeId) {
          const origFreeLine = origItems.find(
            (o) => o.promoCodeId === item.promoCodeId
              && o.productVariantId === item.productVariantId
              && o.overridePrice === 0,
          );
          if (!origFreeLine) {
            throw new Error(`Free-item line ${item.productName} was not in the original transaction`);
          }
          const alreadyReturned = priorReturnedByFreePromo[item.promoCodeId] ?? 0;
          const remaining = origFreeLine.quantity - alreadyReturned;
          if (item.quantity > remaining) {
            throw new Error(`Only ${Math.max(0, remaining)} of ${item.productName} remain available to return`);
          }
          continue;
        }

        const origItem = origItems.find((o) => o.productVariantId === item.productVariantId && !o.bundleId && !o.promoCodeId);
        if (!origItem) {
          throw new Error(`Item ${item.productName} was not in the original transaction`);
        }
        if (Math.abs(origItem.unitPrice - item.unitPrice) > 0.01) {
          throw new Error(`Price mismatch for ${item.productName}: expected ${formatCurrency(origItem.unitPrice)}`);
        }
        const alreadyReturned = priorReturnedByVariant[item.productVariantId] ?? 0;
        const remaining = origItem.quantity - alreadyReturned;
        if (item.quantity > remaining) {
          throw new Error(`Only ${Math.max(0, remaining)} of ${item.productName} remain available to return`);
        }
      }

      // Apply discountFactor so the refund matches what the customer actually
      // paid for the returned items (pre-tax). Full list price would over-refund.
      //
      // Free-item promo lines contribute $0 — the customer paid nothing for
      // them at sale time. Refunding unitPrice × quantity would be a direct
      // cash-out ($22 back on a $0 tee). The line's unitPrice stays in the
      // snapshot for auditability; the refund math just ignores it.
      //
      // R32-H6: ALSO skip lines whose original cart had overridePrice=0
      // even when promoCodeId was absent. A manager can legitimately comp
      // a non-promo line to $0 via the price-override approval path. The
      // admin refund paths `/api/returns/process` and `/api/returns` POST
      // already track this via `isFree: !!i.promoCodeId || Number(i.overridePrice ?? i.unitPrice) === 0`
      // (R30-H11 + R31-H8). The register-side was not updated in those
      // rounds — closing the sibling gap here. `origFromSnapshot` below
      // re-finds the original snapshot entry so we can read overridePrice
      // authoritatively; the reducer trusts origFromSnapshot, not the
      // client's item.
      const refundTotal = Number(
        input.items.reduce((sum, item) => {
          if (item.promoCodeId) return sum; // free-item line → $0 refund
          // Match bundle lines by bundleId (the origLine's productVariantId
          // is a sentinel pointing at the bundle id in bundle lines).
          const origFromSnapshot = item.bundleId
            ? origItems.find((o) => o.bundleId === item.bundleId)
            : origItems.find(
                (o) => o.productVariantId === item.productVariantId && !o.bundleId && !o.promoCodeId,
              );
          if (origFromSnapshot && Number(origFromSnapshot.overridePrice ?? origFromSnapshot.unitPrice) === 0) {
            return sum; // $0 override at sale time → $0 refund.
          }
          // R36-H3: include modifier upcharges so customers who paid
          // `unitPrice + modifierTotal` per unit get refunded that full
          // per-unit amount (prorated by origDiscountFactor). Prior
          // shape only refunded `unitPrice × qty × factor`, leaving
          // modifier cash with the shop even though the customer paid
          // for them. Bundle lines don't have modifiers (bundle price
          // is package-priced) so the fallback is 0.
          const origModifierTotal = origFromSnapshot
            ? Number((origFromSnapshot as { modifierTotal?: number }).modifierTotal ?? 0) || 0
            : 0;
          return sum + (item.unitPrice + origModifierTotal) * item.quantity * origDiscountFactor;
        }, 0).toFixed(2),
      );
      // Refund tax: use the ORIGINAL transaction's effective rate (tax_total/subtotal)
      // so the refund matches the tax collected at sale. Fall back to current
      // location tax rate if the original can't be resolved (cross-org, etc.).
      // Fallback default 0 (not 0.1025) so a tax-free sale stays tax-free on refund.
      const taxRate = origTaxRate ?? (context.location.taxRate ?? 0);
      const refundTax = Number((refundTotal * taxRate).toFixed(2));
      const refundGrandTotal = Number((refundTotal + refundTax).toFixed(2));

      // Cash refund cap. Without this, a customer who paid entirely in gift
      // card / store credit can "return" for cash and walk out of the drawer.
      // Mirror the admin /api/returns/process rule: cash refund cannot exceed
      // original cash+card tender minus prior cash+card refunds. Gift-card and
      // store-credit tenders do NOT contribute to cash-refundable headroom.
      if (cashRefund) {
        const cashTendered = Number((cashTenderRes.rows[0] as { cash_tendered: string | number }).cash_tendered);
        const priorCashRefunded = Number((priorCashRefRes.rows[0] as { prior_cash_refunded: string | number }).prior_cash_refunded);
        const maxCashRefundable = Number((cashTendered - priorCashRefunded).toFixed(2));
        if (refundGrandTotal > maxCashRefundable) {
          throw new Error(
            `Cash refund of ${formatCurrency(refundGrandTotal)} exceeds original cash/card tender available (${formatCurrency(maxCashRefundable)}). Use store credit or original tender.`,
          );
        }
      }

      // 1. Create return transaction (negative amounts)
      //    Preserve bundleId / bundleComponents / promoCodeId when present
      //    so the "already returned" cross-tally logic can detect these
      //    line types correctly on future requests.
      const cartSnapshot = {
        items: input.items.map((i) => ({
          productVariantId: i.productVariantId,
          productName: i.productName,
          variantName: i.variantName,
          sku: i.sku,
          unitPrice: i.unitPrice,
          quantity: i.quantity,
          ...(i.bundleId ? { bundleId: i.bundleId } : {}),
          ...(i.bundleComponents ? { bundleComponents: i.bundleComponents } : {}),
          ...(i.promoCodeId ? { promoCodeId: i.promoCodeId, overridePrice: 0 } : {}),
        })),
        isReturn: true,
        originalTransactionId: input.originalTransactionId,
        // Record the original sale's location so reconciliation audits can
        // tell this was a manager-approved cross-location return (register's
        // location_id on the negative txn is the DESTINATION of the restock,
        // not the originating store).
        ...(origLocationId && origLocationId !== context.location.id
          ? { originalLocationId: origLocationId }
          : {}),
        reason: input.reason,
      };

      await client.query(
        `INSERT INTO transactions (id, organization_id, location_id, register_session_id, employee_id,
         cart_snapshot, subtotal, discount_total, tax_total, grand_total,
         tender_type, amount_tendered, change_due, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, 0, 'completed')`,
        [
          returnTransactionId, context.employee.organizationId, context.location.id,
          context.registerSession.id, context.employee.id,
          JSON.stringify(cartSnapshot),
          -refundTotal, -refundTax, -refundGrandTotal,
          input.refundMethod, -refundGrandTotal,
        ],
      );

      // 2. Refund tender line
      await client.query(
        `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          randomUUID(), returnTransactionId, input.refundMethod, -refundGrandTotal,
          JSON.stringify({
            original_transaction_id: input.originalTransactionId,
            is_return: "true",
            reason: input.reason,
          }),
        ],
      );

      // 3. Return event
      // R83-DB-H1 (HIGH): emit as `event_kind='transaction_placeholder'`
      // with `is_return: "true"` in the payload so client-side admin
      // widgets hydrating from `get_full_store` (dashboard-kpis,
      // sales-reports, tax-report, daily-manager-report, etc.)
      // correctly identify this as a return event. Prior shape used
      // `event_kind='return_processed'` without an is_return flag —
      // every widget filtering on
      // `eventKind === 'transaction_placeholder' && payload.is_return === 'true'`
      // missed register-side refunds entirely → Tax Report understated
      // totalReturns, DashboardKPIs' todayNet equaled todayGross,
      // DailyManagerReport's dayReturns was always empty. The JSON
      // fallback path at line ~948 already uses the correct shape;
      // this PG path just needed to match.
      await client.query(
        `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload)
         VALUES ($1, $2, $3, 'transaction_placeholder', $4, $5)`,
        [
          randomUUID(), returnTransactionId, context.employee.id,
          `Return processed by ${context.employee.displayName}: ${input.items.length} item(s), -${formatCurrency(refundGrandTotal)} via ${input.refundMethod}`,
          JSON.stringify({
            location_id: context.location.id,
            register_session_id: context.registerSession.id,
            original_transaction_id: input.originalTransactionId,
            item_count: String(input.items.length),
            refund_subtotal: refundTotal.toFixed(2),
            refund_tax: refundTax.toFixed(2),
            grand_total: (-refundGrandTotal).toFixed(2),
            refund_method: input.refundMethod,
            reason: input.reason,
            note: input.note,
            is_return: "true",
          }),
        ],
      );

      // 4. Restore inventory (batched UPSERT). A bare UPDATE silently no-ops
      //    if the variant has no inventory row at this location. INSERT ...
      //    ON CONFLICT DO UPDATE handles both cases. Do NOT touch received_at
      //    (FIFO aging semantic).
      //
      //    Bundle lines: expand into component variants using the
      //    authoritative `bundle_items` rows (NOT client-supplied). Returning
      //    1 bundle with 2 hats + 1 shirt restocks 2 hats + 1 shirt. If the
      //    bundle itself was deleted (rare — admins should deactivate, not
      //    delete) we fall back to the components the client sent, which are
      //    themselves sourced from the original transaction's cart_snapshot
      //    (server-authoritative at sale time).
      if (input.items.length > 0) {
        const returnBundleIds = input.items
          .map((i) => i.bundleId)
          .filter((b): b is string => typeof b === "string");

        const dbComponentsByBundle = new Map<string, { variantId: string; qty: number }[]>();
        if (returnBundleIds.length > 0) {
          // R26-F1: JOIN to product_bundles for explicit org scoping.
          // bundleIds are client-supplied; bundle_items has no direct
          // organization_id column so we gate via the parent bundle.
          const { rows: biRows } = await client.query(
            `SELECT bi.bundle_id, bi.product_variant_id, bi.quantity
             FROM bundle_items bi
             JOIN product_bundles pb ON pb.id = bi.bundle_id
             WHERE bi.bundle_id = ANY($1::uuid[])
               AND pb.organization_id = $2`,
            [returnBundleIds, context.employee.organizationId],
          );
          for (const row of biRows as { bundle_id: string; product_variant_id: string; quantity: number }[]) {
            const arr = dbComponentsByBundle.get(row.bundle_id) ?? [];
            arr.push({ variantId: row.product_variant_id, qty: Number(row.quantity) });
            dbComponentsByBundle.set(row.bundle_id, arr);
          }
        }

        // Aggregate the final per-variant restore quantities — bundle lines
        // contribute `component_qty × return_qty` per component, regular
        // lines contribute `return_qty` directly.
        const restoreByVariant = new Map<string, number>();
        for (const line of input.items) {
          if (line.bundleId) {
            const comps = dbComponentsByBundle.get(line.bundleId)
              ?? line.bundleComponents?.map((c) => ({ variantId: c.productVariantId, qty: c.quantity }))
              ?? [];
            for (const c of comps) {
              restoreByVariant.set(
                c.variantId,
                (restoreByVariant.get(c.variantId) ?? 0) + c.qty * line.quantity,
              );
            }
          } else {
            restoreByVariant.set(
              line.productVariantId,
              (restoreByVariant.get(line.productVariantId) ?? 0) + line.quantity,
            );
          }
        }
        const allVariantIds = Array.from(restoreByVariant.keys());
        // DEFENSE: filter out variants that no longer exist in
        // product_variants. Normally bundle_items RESTRICT + inventory_levels
        // FK (migration 001) make this impossible, but a bundle could be
        // deleted (cascading bundle_items) and then its component variants
        // hard-deleted separately. The client-supplied `bundleComponents`
        // fallback (which sources from cart_snapshot) might point at such a
        // ghost variant. UPSERTing against a non-existent FK target would
        // 23503 and roll back the entire return. Skip the ghosts instead
        // and emit an audit row so operators can investigate later.
        // R26-F1: explicit org filter. variantIds are derived from
        // either cart_snapshot (server-authoritative at sale time) or
        // bundle_items, but we still defense-in-depth scope by org so
        // a cross-tenant variant_id can never sneak through.
        const liveVariants = allVariantIds.length > 0
          ? await client.query(
              `SELECT id FROM product_variants
               WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
              [allVariantIds, context.employee.organizationId],
            )
          : { rows: [] as { id: string }[] };
        const liveIds = new Set((liveVariants.rows as { id: string }[]).map((r) => r.id));
        const droppedIds = allVariantIds.filter((id) => !liveIds.has(id));
        const variantIds = allVariantIds.filter((id) => liveIds.has(id));
        const quantities = variantIds.map((v) => restoreByVariant.get(v) ?? 0);

        // R28-C5: restock at the ORIGINAL sale's location, not the
        // register terminal's location. A manager processing a cross-
        // location return (allowed via the bypass above) would otherwise
        // create phantom stock at Location A that never physically
        // existed, while Location B's records show the original sale
        // still consuming stock. Customer physically hands the item
        // back at A, but the CHAIN's inventory ledger should credit B
        // (where the sale came from).
        //
        // When origLocationId is null (fallback path with no original
        // txn), fall back to context.location.id.
        const restockLocationId = origLocationId ?? context.location.id;
        if (variantIds.length > 0) {
          await client.query(
            `INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, received_at, updated_at)
             SELECT $1, delta.variant_id, $2, delta.qty, NOW(), NOW()
             FROM (SELECT unnest($3::uuid[]) as variant_id, unnest($4::int[]) as qty) AS delta
             ON CONFLICT (product_variant_id, location_id)
             DO UPDATE SET on_hand = inventory_levels.on_hand + EXCLUDED.on_hand, updated_at = NOW()`,
            [context.employee.organizationId, restockLocationId, variantIds, quantities],
          );
        }
        if (droppedIds.length > 0) {
          // Non-fatal audit so the refund still goes through. This happens
          // rarely enough that a human should reconcile the stock by hand.
          await client.query(
            `INSERT INTO audit_events
               (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
             VALUES ($1, $2, $3, $4, 'transaction', $5, 'return_restock_dropped_variants', $6, now())`,
            [
              randomUUID(), context.employee.organizationId, context.location.id,
              context.employee.id, returnTransactionId,
              JSON.stringify({
                dropped_variant_ids: droppedIds,
                reason: "variant_no_longer_exists",
                note: "Inventory was NOT restocked for these variants — manual reconciliation needed",
              }),
            ],
          );
        }
      }

      // 5. Update register session
      await client.query(
        `UPDATE register_sessions SET last_transaction_id = $1, updated_at = now() WHERE id = $2`,
        [returnTransactionId, context.registerSession.id],
      );

      // 5b. Reverse free-item promo redemptions for any returned free
      // lines. We delete the redemption row and decrement
      // current_redemptions so a max_redemptions=100 promo isn't
      // permanently burned by a buy→return cycle. If the promo was in
      // 'depleted' status because of this redemption, re-open it to
      // 'active'. GREATEST guards against underflow if we're already at 0.
      const returnedFreePromoIds = input.items
        .filter((it) => it.promoCodeId)
        .map((it) => it.promoCodeId as string);
      if (returnedFreePromoIds.length > 0) {
        // Delete the specific redemption rows tied to the ORIGINAL transaction
        // for these promo codes. Unique index on (promo_code_id, transaction_id)
        // means at most one row per (promo, original txn).
        //
        // R26-F1: scope promo_redemptions delete via JOIN to promo_codes
        // so a crafted promo_code_id from another tenant can't land.
        const { rows: deleted } = await client.query(
          `DELETE FROM promo_redemptions pr
           USING promo_codes pc
           WHERE pr.promo_code_id = pc.id
             AND pr.transaction_id = $1
             AND pr.promo_code_id = ANY($2::uuid[])
             AND pc.organization_id = $3
           RETURNING pr.promo_code_id`,
          [input.originalTransactionId, returnedFreePromoIds, context.employee.organizationId],
        );
        // Decrement current_redemptions for each promo actually deleted.
        // Looping per-row (rather than a single UPDATE ... WHERE id = ANY)
        // so the GREATEST clamp applies per-row. Also writes a paired
        // audit_events row so the trail shows both the original
        // `promo_redeemed` event AND this `promo_reversed` event against
        // the same promo_code_id.
        for (const row of deleted as { promo_code_id: string }[]) {
          // R26-F1: explicit org filter (defense-in-depth — the
          // DELETE above already gated by org via JOIN).
          await client.query(
            `UPDATE promo_codes
               SET current_redemptions = GREATEST(0, current_redemptions - 1),
                   status = CASE WHEN status = 'depleted' THEN 'active' ELSE status END,
                   updated_at = now()
             WHERE id = $1 AND organization_id = $2`,
            [row.promo_code_id, context.employee.organizationId],
          );
          await client.query(
            `INSERT INTO audit_events
               (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
             VALUES ($1, $2, $3, $4, 'promo_code', $5, 'promo_reversed', $6, now())`,
            [
              randomUUID(), context.employee.organizationId, context.location.id,
              context.employee.id, row.promo_code_id,
              JSON.stringify({
                original_transaction_id: input.originalTransactionId,
                return_transaction_id: returnTransactionId,
                reason: input.reason,
              }),
            ],
          );
        }
      }

      // 6. If refund is to store credit, update customer balance.
      // Scope every transactions/customers touch by org — register has
      // already checked customer membership, but this is the refund path
      // where crossed-org data would land in the wrong ledger.
      // R30-H2: if refundMethod is 'store_credit' but the original sale
      // has no customer_id attached, REFUSE the return. The prior shape
      // wrote the negative tender row + restocked inventory but silently
      // skipped the store_credit/ledger writes — the customer got their
      // merchandise back without any store-credit liability on the
      // books. This is the register-path mirror of R29-L1's admin-side
      // fix. The cart_snapshot still records the attempted refund
      // method for audit.
      if (input.refundMethod === "store_credit") {
        if (!origCustomerId) {
          throw new Error(
            "Store-credit refund requires a customer on the original transaction. Use original tender or cash refund instead.",
          );
        }
        // R75-M: `AND is_active = true` — anonymized customers
        // (GDPR erasure) carry is_active=false + zeroed balance.
        // Without this filter, a refund on a late return would
        // write credit onto the [deleted] record (invisible
        // liability) + mutate erased PII.
        const { rows: balRows } = await client.query(
          `UPDATE customers SET store_credit_balance = store_credit_balance + $1, updated_at = now()
           WHERE id = $2 AND organization_id = $3 AND is_active = true RETURNING store_credit_balance`,
          [refundGrandTotal, origCustomerId, context.employee.organizationId],
        );
        if (balRows.length === 0) {
          // Customer was deleted / deactivated between the prior lookup
          // and this UPDATE. Refuse rather than orphan the refund.
          throw new Error(
            "Customer on original transaction no longer exists or has been anonymized. Use original tender or cash refund instead.",
          );
        }
        await client.query(
          `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, transaction_id, reason)
           VALUES ($1, $2, $3, 'refund', $4, $5, $6, $7, $8)`,
          [
            randomUUID(), context.employee.organizationId, origCustomerId,
            refundGrandTotal, balRows[0]?.store_credit_balance ?? 0,
            context.employee.id, returnTransactionId, input.reason,
          ],
        );
      }

      // R28-C4: reverse loyalty points earned on the original sale.
      // Without this, a cashier + customer accomplice can farm points
      // via buy → refund → buy → refund: each round earns points that
      // don't decrement on refund, and `tender: loyalty` converts the
      // accumulated points to store credit at next purchase.
      //
      // R29-H1: reverse points PRORATED from persisted `points_earned`
      // (the exact value credited at sale), not a recompute against the
      // live earn rate. If an admin bumps earnRatePerDollar between sale
      // and refund, the prior formula over-reversed; if they cut it, it
      // under-reversed — both strictly wrong. Math: reverse the share of
      // the credit that matches refund_amount / orig_grand_total. Full
      // refund reverses the full credit; partial refund reverses its
      // pro-rata piece. Fallback to zero when origGrandTotal is 0
      // (divide-by-zero guard; legitimate when an entire sale was paid
      // in redeemed loyalty, producing origGrandTotal=0 and no points
      // to reverse anyway).
      if (origCustomerId && origPointsEarned > 0 && origGrandTotal > 0) {
        // R40-2: use the CUMULATIVE refund share, not the per-refund
        // share, so the total points reversed across all refunds of
        // this sale stays bounded by `round(origPointsEarned × 1.0)
        // = origPointsEarned`. Prior per-refund `round()` allowed the
        // sum of rounded chunks to drift from the true proportional
        // total — up to 3 points kept by the customer on a fully-
        // refunded sale that earned 3 points (10 × round(3×0.1) = 0).
        const { rows: priorRefundRows } = await client.query(
          `SELECT COALESCE(SUM(grand_total), 0)::numeric AS prior_refund
             FROM transactions
            WHERE organization_id = $1
              AND status = 'completed'
              AND cart_snapshot->>'originalTransactionId' = $2
              AND id <> $3`,
          [context.employee.organizationId, input.originalTransactionId, returnTransactionId],
        );
        const priorRefundAbs = Math.abs(Number(priorRefundRows[0]?.prior_refund ?? 0)) || 0;
        const priorShare = Math.min(1, Math.max(0, priorRefundAbs / origGrandTotal));
        const priorExpectedReverse = Math.round(origPointsEarned * priorShare);
        const newCumulativeAbs = priorRefundAbs + refundGrandTotal;
        const newCumulativeShare = Math.min(1, Math.max(0, newCumulativeAbs / origGrandTotal));
        const newExpectedReverse = Math.round(origPointsEarned * newCumulativeShare);
        const pointsToReverse = Math.max(0, Math.min(
          origPointsEarned - priorExpectedReverse,
          newExpectedReverse - priorExpectedReverse,
        ));
        if (pointsToReverse > 0) {
          await client.query(
            `UPDATE customers
                SET loyalty_points = GREATEST(0, loyalty_points - $1),
                    updated_at = now()
              WHERE id = $2 AND organization_id = $3`,
            [pointsToReverse, origCustomerId, context.employee.organizationId],
          );
        }
      }

      // R82-DB-H1 (HIGH): reverse denormalized customers.total_spend
      // + visit_count on refund. Prior shape reversed loyalty_points
      // only — gross-lifetime `total_spend` column drifted from real
      // net spend after every refund, and visit_count never
      // decremented. /api/customers LIST endpoint reads total_spend
      // directly; /api/customers DETAIL overrides with live SUM.
      // Net effect: list + detail disagreed for every customer with
      // refunds. Only decrement visit_count on a FULL refund
      // (cumulative-refund >= original grand total) so partial
      // refunds don't spuriously reduce lifetime-visit counts —
      // matches the cumulative-share semantic used for loyalty.
      if (origCustomerId && origGrandTotal > 0) {
        const { rows: priorRefundRows2 } = await client.query(
          `SELECT COALESCE(SUM(grand_total), 0)::numeric AS prior_refund
             FROM transactions
            WHERE organization_id = $1
              AND status = 'completed'
              AND cart_snapshot->>'originalTransactionId' = $2
              AND id <> $3`,
          [context.employee.organizationId, input.originalTransactionId, returnTransactionId],
        );
        const priorRefundAbs2 = Math.abs(Number(priorRefundRows2[0]?.prior_refund ?? 0)) || 0;
        const newCumulativeAbs2 = priorRefundAbs2 + refundGrandTotal;
        const wasPriorFullyRefunded = priorRefundAbs2 >= origGrandTotal - 0.005;
        const isNowFullyRefunded = newCumulativeAbs2 >= origGrandTotal - 0.005;
        // visit_count flips from 1→0 only on the refund that CROSSES
        // the full-refund boundary (prior was not-yet-full, now-is-full).
        const visitCountDelta = !wasPriorFullyRefunded && isNowFullyRefunded ? 1 : 0;
        await client.query(
          `UPDATE customers
              SET total_spend = GREATEST(0, total_spend - $1),
                  visit_count = GREATEST(0, visit_count - $2),
                  updated_at = now()
            WHERE id = $3 AND organization_id = $4`,
          [refundGrandTotal, visitCountDelta, origCustomerId, context.employee.organizationId],
        );
      }

      // R49: audit INSIDE the tx. Returns dispense money (cash / store
      // credit / gift-card reversal) AND restock inventory; a post-
      // commit audit that fails is exactly the evidence-destruction
      // scenario a compromised cashier session would want. Matches the
      // canonical R44+ shape.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'transaction', $5, 'return_processed', $6, now())`,
        [
          randomUUID(), context.employee.organizationId, context.location.id, context.employee.id, returnTransactionId,
          JSON.stringify({
            original_transaction_id: input.originalTransactionId,
            item_count: input.items.length,
            refund_grand_total: refundGrandTotal.toFixed(2),
            refund_method: input.refundMethod,
          }),
        ],
      );

      await client.query("COMMIT");

      // R82-DB-M4: invalidate /api/inventory cache so the POS grid
      // sees the restocked on_hand immediately.
      const { invalidateInventoryCache } = await import("@/lib/cache/inventory-cache");
      invalidateInventoryCache(context.employee.organizationId);
      // R84-hand: invalidate admin-side store cache so dashboards
      // + sales-reports + tax-report + daily-manager-report see
      // the refund event within the next admin read. Paired with
      // R83-DB-H1 event-shape fix (register refunds now carry
      // is_return flag) — otherwise admin widgets still serve
      // stale data post-refund for up to 30s TTL.
      const { invalidateStoreCache } = await import("@/lib/persistence/postgres-read-store");
      invalidateStoreCache(context.employee.organizationId);
      revalidatePath("/register");
      return { returnTransactionId, refundTotal: refundGrandTotal, refundMethod: input.refundMethod };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // --- Non-isPg / JSON fallback path ---
  const regConfig = await getRegisterConfig(context.employee.organizationId);
  const returnThreshold = regConfig.approvalThresholds.returnWithoutManagerOver;
  if (estimatedRefund > returnThreshold && !isManager) {
    throw new Error(`Return of ${formatCurrency(estimatedRefund)} exceeds ${formatCurrency(returnThreshold)} threshold. Manager must process.`);
  }

  // JSON path has no original-transaction context — refund the client-claimed
  // amounts at list price without discount factoring. This path is dev-only.
  const refundTotal = Number(
    input.items.reduce((sum, item) => {
      if (item.promoCodeId) return sum;
      return sum + item.unitPrice * item.quantity;
    }, 0).toFixed(2),
  );
  const taxRate = context.location.taxRate ?? 0;
  const refundTax = Number((refundTotal * taxRate).toFixed(2));
  const refundGrandTotal = Number((refundTotal + refundTax).toFixed(2));

  await mutateStore((store) => {
    const timestamp = new Date().toISOString();

    // Record the return as a negative tender
    store.transactionTenderPlaceholders.unshift({
      id: randomUUID(),
      transactionId: returnTransactionId,
      tenderType: input.refundMethod,
      amount: -refundGrandTotal,
      metadata: {
        original_transaction_id: input.originalTransactionId,
        is_return: "true",
        reason: input.reason,
      },
    });

    // Record return event
    store.transactionEventPlaceholders.unshift({
      id: randomUUID(),
      transactionId: returnTransactionId,
      eventKind: "transaction_placeholder",
      actorEmployeeId: context.employee.id,
      notes: `Return processed by ${context.employee.displayName}: ${input.items.length} item(s), -${formatCurrency(refundGrandTotal)} via ${input.refundMethod}`,
      payload: {
        location_id: context.location.id,
        register_session_id: context.registerSession.id,
        original_transaction_id: input.originalTransactionId,
        item_count: String(input.items.length),
        refund_subtotal: refundTotal.toFixed(2),
        refund_tax: refundTax.toFixed(2),
        grand_total: (-refundGrandTotal).toFixed(2),
        refund_method: input.refundMethod,
        reason: input.reason,
        note: input.note,
        is_return: "true",
      },
      createdAt: timestamp,
    });

    // Mark original transaction as returned (add a return marker event)
    const originalEvent = store.transactionEventPlaceholders.find(
      (e) => e.transactionId === input.originalTransactionId && e.eventKind === "transaction_placeholder" && !e.payload?.is_return,
    );
    if (originalEvent) {
      originalEvent.payload = {
        ...originalEvent.payload,
        has_return: "true",
        return_transaction_id: returnTransactionId,
        returned_at: timestamp,
      } as Record<string, string>;
    }

    // Restore inventory
    for (const item of input.items) {
      const inv = store.inventory.find(
        (i) => i.productVariantId === item.productVariantId && i.locationId === context.location.id,
      );
      if (inv) {
        inv.onHand += item.quantity;
        inv.updatedAt = timestamp;
      }
    }

    // Update register session
    const regSession = store.registerSessions.find((s) => s.id === context.registerSession.id);
    if (regSession) {
      regSession.lastTransactionId = returnTransactionId;
    }
  });

  revalidatePath("/register");
  return { returnTransactionId, refundTotal: refundGrandTotal, refundMethod: input.refundMethod };
}
