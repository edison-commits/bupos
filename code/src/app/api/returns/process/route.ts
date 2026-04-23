import { NextResponse } from 'next/server';
import { randomUUID } from "@/lib/uuid";
import { orgTx } from '@/lib/supabase-rest';
import { withDualAuth } from '@/lib/api/with-auth';
import { checkRateLimit } from '@/lib/auth/rate-limit';
import { validateBody, returnProcessSchema } from '@/lib/validation/schemas';

import { safeErr } from "@/lib/logging/safe-err";
interface ReturnLineItem {
  product_id: string;
  product_name: string;
  sku: string;
  quantity: number;
  unit_price: number;
}

interface _ProcessReturnRequest {
  transaction_id: string;
  customer_name: string | null;
  reason: string;
  notes: string;
  refund_method: 'original_tender' | 'store_credit' | 'cash';
  items: ReturnLineItem[];
  refund_amount: number;
  processed_by?: string;
}

/**
 * POST /api/returns/process
 *
 * Process a return from an original transaction:
 * 1. Create a return record
 * 2. Create return line items
 * 3. If restocking, adjust inventory
 * 4. Record refund tender/transaction
 */
export const POST = withDualAuth('register.open', async (request, ctx) => {
  const idempotencyKey = request.headers.get('Idempotency-Key');
  const { orgId, employee, registerSession: _registerSession, locationId } = ctx;
  const employeeId = employee.id;

  const rl = checkRateLimit(`returns:${employeeId}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const client = await orgTx(orgId);

  // Idempotency check: if key provided, look for an already-succeeded return.
  // MUST release the client on early return to prevent connection pool leak.
  if (idempotencyKey) {
    try {
      const existing = await client.query(
        `SELECT id, return_number, refund_amount FROM returns
         WHERE organization_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [orgId, idempotencyKey],
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        const row = existing.rows[0];
        client.release();
        return NextResponse.json({
          return_id: row.id,
          return_number: row.return_number,
          refund_amount: Number(row.refund_amount),
          success: true,
          _idempotent: true,
        });
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw e;
    }
  }

  try {
    const raw = await request.json();
    const v = validateBody(returnProcessSchema, raw);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const {
      transaction_id,
      customer_name,
      reason,
      notes,
      refund_method,
      items,
      refund_amount,
    } = v.data;

    if (refund_amount < 0) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: `Refund amount cannot be negative: ${refund_amount}` },
        { status: 400 }
      );
    }

    // R38-A-F3: register-side `return-action.ts` enforces a
    // `returnWithoutManagerOver` threshold — refunds above it require
    // the cashier to be owner/manager. The admin `/api/returns/process`
    // sibling had NO such gate, so a cashier with `register.open` (via
    // dual-auth) could POST any `refund_amount` and drain the refund
    // without manager role. Mirror the register-side gate here.
    const { getRegisterConfig } = await import("@/lib/config/register-config");
    const returnCfg = await getRegisterConfig(orgId);
    const returnThreshold = returnCfg.approvalThresholds.returnWithoutManagerOver;
    const isManagerRole = employee.roleKey === 'owner' || employee.roleKey === 'manager';
    if (refund_amount >= returnThreshold && !isManagerRole) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: `Refund of ${refund_amount.toFixed(2)} exceeds ${returnThreshold.toFixed(2)} threshold. Manager must process.` },
        { status: 403 },
      );
    }

    // R33-H5: require step-up for cash refunds OR large refunds. A
    // stolen cashier cookie otherwise opens the drawer for up to
    // grand_total in cash on ANY completed transaction. R32-H10
    // gated the corresponding mint paths (store-credit, gift-card,
    // loyalty) with step-up; the cash-out counterpart went un-
    // gated. `original_tender` + `cash` both open the drawer when
    // the original sale was cash-tendered, so both paths need the
    // gate. `store_credit` refunds don't need step-up because the
    // store credit balance already requires the customer to redeem
    // via a future sale (which is itself gated).
    const CASH_REFUND_STEP_UP_THRESHOLD = 100;
    const needsStepUp =
      refund_method === 'cash' ||
      refund_method === 'original_tender' ||
      refund_amount > CASH_REFUND_STEP_UP_THRESHOLD;
    if (needsStepUp) {
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: employeeId,
        orgId,
        actorPassword: (raw as { actorPassword?: string }).actorPassword,
        bucketKey: 'returns-process-stepup',
      });
      if (!stepUp.ok) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }
    }

    // Validate that at least one item has a valid quantity before creating the return record
    const validItems = items.filter((item) => item.quantity > 0);
    if (validItems.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: 'At least one return item must have a positive quantity' },
        { status: 400 }
      );
    }

    // Validate transaction exists and load authoritative cart_snapshot so we
    // can recompute refund_amount from server-side unit prices instead of
    // trusting client-supplied values.
    // Defense in depth: scope by org explicitly even inside orgTx. Without
    // the org filter, a guessed foreign transaction id would pass through to
    // RLS (which rejects it) but reveal existence via error timing, and if
    // RLS is ever disabled during maintenance this would cross tenants.
    // R31-H5: ALSO take the same advisory lock the register-side path
    // uses. Prior shape relied only on FOR UPDATE of the transactions
    // row, but the register path uses `pg_advisory_xact_lock` keyed
    // on `return:<transaction_id>`. Two refund paths grabbing
    // DIFFERENT lock scopes don't serialize against each other —
    // concurrent admin + register refunds for the same sale could
    // both commit refund rows + restock inventory. Acquiring the
    // advisory lock here before the FOR UPDATE makes both paths
    // mutually exclusive.
    await client.query(
      `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
      [`return:${transaction_id}`],
    );

    // R30-H10: also require status = 'completed'. Register-side
    // return-action.ts has this filter; admin path was missing it. If
    // any future code path flips status to 'voided' or 'refunded',
    // this filter prevents double-refund against the same sale.
    // R30-H1: also pull `location_id` so the inventory restock lands
    // at the ORIGINAL sale's location, not the caller's. Prior shape
    // restocked at `ctx.locationId` (the admin's active location),
    // inflating stock at the admin's store and leaving the original
    // store's ledger inconsistent — a manager could process a foreign
    // store's return and credit their own stock. REGRESSION of
    // R28-C5 (which fixed this on the register path only).
    const txnResult = await client.query(
      `SELECT id, grand_total, subtotal, discount_total, tax_total, cart_snapshot, location_id
       FROM transactions WHERE id = $1 AND organization_id = $2 AND status = 'completed' FOR UPDATE`,
      [transaction_id, orgId]
    );

    if (txnResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    const _originalTotal = Number(txnResult.rows[0].grand_total) || 0;
    void _originalTotal;
    const origLocationId = (txnResult.rows[0].location_id as string | null) ?? null;
    // R31-H11: cross-location permission gate. Mirror the register-
    // side `return-action.ts` check — non-managers can only process
    // returns at locations they're assigned to; managers/owners can
    // cross locations (accepting the accounting reconciliation burden).
    // Prior shape had NO check: a cashier with `returns.process` could
    // refund a transaction from ANY other location in the org, with
    // inventory restocking at the (now-correct, post-R30-H1) origin
    // store they don't work at. Regression-adjacent to R28-C5.
    if (origLocationId) {
      const isManagerOrOwner = employee.roleKey === "owner" || employee.roleKey === "manager";
      const callerLocs = employee.locationIds ?? [];
      if (!isManagerOrOwner && !callerLocs.includes(origLocationId)) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: 'Return must be processed at the originating location, or by a manager.' },
          { status: 403 },
        );
      }
    }
    const restockLocationId = origLocationId ?? locationId;

    // Build a lookup of the original line items so the client can't claim a
    // different price/variant than the original sale. Bundle lines are
    // merged into the same map keyed by their sentinel productVariantId
    // (which equals bundleId — see src/lib/cart/types.ts); the `isBundle`
    // flag lets the inventory restore loop below pick the right path.
    const origSnapshot = typeof txnResult.rows[0].cart_snapshot === 'string'
      ? JSON.parse(txnResult.rows[0].cart_snapshot)
      : txnResult.rows[0].cart_snapshot;
    // R30-H11: free-item promo lines must contribute $0 to the
    // refund, not their listed `unitPrice`. The customer paid nothing
    // for them at sale time (overridePrice=0 on the cart). Prior
    // shape honored unitPrice and — when paired with finding R30-C4
    // negative-discount-inflation — let an accomplice convert free
    // promo units into paid-equivalent cash refunds. Mirrors the
    // register-side handling (return-action.ts:277 skips promoCodeId
    // lines). We preserve unitPrice in the map for audit but zero the
    // EFFECTIVE price used in the refund math below when this line
    // was paid at $0 originally (promoCodeId present OR overridePrice
    // exactly 0).
    const origItems: Array<{
      productVariantId: string; unitPrice: number; quantity: number;
      bundleId?: string; isFree: boolean;
    }> = (origSnapshot?.items ?? []).map((i: {
      productVariantId?: string; variantId?: string; unitPrice: number; quantity: number;
      bundleId?: string; promoCodeId?: string; overridePrice?: number;
    }) => ({
      productVariantId: i.productVariantId ?? (i as { variantId?: string }).variantId ?? '',
      unitPrice: Number(i.unitPrice) || 0,
      quantity: Number(i.quantity) || 0,
      bundleId: i.bundleId,
      isFree: !!i.promoCodeId || Number(i.overridePrice ?? i.unitPrice) === 0,
    }));
    // SUM quantities when the same variant appears on multiple cart_snapshot
    // lines (e.g. same variant with different modifiers). Previously the Map
    // overwrote earlier entries, undercounting available return quantity.
    // R30-H11 / R31-H9: paidQuantity + paidSubtotal track the exact
    // $ the customer paid per variant. Prior R30-H11 shape used
    // `Math.max(unitPrice)` which OVER-refunded when the same variant
    // appeared on two paid lines with different prices (e.g., 2 @ $5
    // + 2 @ $15 override): max=$15, return 4 units → $60 refund vs.
    // $40 actually paid. NEW shape sums the line-level paid dollars
    // (paidQuantity × line unitPrice) and divides at refund time so
    // the effective per-unit is the actual weighted average.
    // R37-H2: also track `paidModifierTotal` — the dollars the customer
    // actually paid for modifier upcharges on each variant. The register-
    // side refund (return-action.ts R36-H3) already includes these in
    // the refund; this admin path was still using unitPrice only, so any
    // admin-processed return of a modifier-heavy line (e.g. burger +
    // cheese + bacon) under-refunded by the modifier sum. Track per-
    // variant so `weightedPaidUnit + weightedModifierUnit` gives the true
    // per-unit amount the customer paid.
    const origByVariant = new Map<string, {
      quantity: number;
      paidQuantity: number;
      paidSubtotal: number;
      paidModifierTotal: number;
      bundleId?: string;
    }>();
    for (const it of origItems) {
      const prev = origByVariant.get(it.productVariantId);
      const lineIsPaid = !it.isFree;
      const lineModifierTotal = Number((it as { modifierTotal?: number }).modifierTotal ?? 0) || 0;
      origByVariant.set(it.productVariantId, {
        quantity: (prev?.quantity ?? 0) + it.quantity,
        paidQuantity: (prev?.paidQuantity ?? 0) + (lineIsPaid ? it.quantity : 0),
        paidSubtotal: (prev?.paidSubtotal ?? 0) + (lineIsPaid ? it.quantity * it.unitPrice : 0),
        paidModifierTotal: (prev?.paidModifierTotal ?? 0) + (lineIsPaid ? it.quantity * lineModifierTotal : 0),
        bundleId: it.bundleId ?? prev?.bundleId,
      });
    }

    // For any bundle lines in the original transaction, fetch their
    // AUTHORITATIVE component breakdown from `bundle_items`. Used later to
    // expand bundle restocks into per-component-variant inventory writes.
    // Falls through gracefully if a bundle was deleted after the sale (rare;
    // admins should deactivate not delete) — then no inventory is restored
    // for that bundle line and an audit event records the skip.
    const origBundleIds = Array.from(
      new Set(origItems.map((o) => o.bundleId).filter((b): b is string => !!b)),
    );
    const dbBundleComponents = new Map<string, { variantId: string; qty: number }[]>();
    if (origBundleIds.length > 0) {
      // Gate by org: bundleIds come from the org-verified transaction's
      // cart_snapshot, but we still filter explicitly so a crafted snapshot
      // with another tenant's bundle id can't pull foreign components.
      const { rows: biRows } = await client.query(
        `SELECT bundle_id, product_variant_id, quantity
         FROM bundle_items
         WHERE bundle_id = ANY($1::uuid[]) AND organization_id = $2`,
        [origBundleIds, orgId],
      );
      for (const row of biRows as { bundle_id: string; product_variant_id: string; quantity: number }[]) {
        const arr = dbBundleComponents.get(row.bundle_id) ?? [];
        arr.push({ variantId: row.product_variant_id, qty: Number(row.quantity) });
        dbBundleComponents.set(row.bundle_id, arr);
      }
    }

    // Per-variant prior-return aggregation — summed across THIS endpoint
    // (returns table) and register-side return-action (transactions with
    // cart_snapshot.originalTransactionId). Previous code only capped by
    // dollars (cashTendered - priorRefunds) which let the same variant be
    // restocked infinitely.
    const { rows: priorTable } = await client.query(
      `SELECT rl.product_variant_id, COALESCE(SUM(rl.quantity), 0)::int AS qty
       FROM return_lines rl
       JOIN returns r ON r.id = rl.return_id
       WHERE r.organization_id = $1 AND r.transaction_id = $2
         AND r.status IN ('pending', 'completed')
       GROUP BY rl.product_variant_id`,
      [orgId, transaction_id],
    );
    const { rows: priorTxn } = await client.query(
      `SELECT cart_snapshot FROM transactions
       WHERE organization_id = $1
         AND status = 'completed'
         AND cart_snapshot->>'originalTransactionId' = $2`,
      [orgId, transaction_id],
    );
    const priorReturnedByVariant: Record<string, number> = {};
    for (const r of priorTable as Array<{ product_variant_id: string; qty: number }>) {
      priorReturnedByVariant[r.product_variant_id] = (priorReturnedByVariant[r.product_variant_id] ?? 0) + Number(r.qty);
    }
    for (const r of priorTxn) {
      const snap = typeof r.cart_snapshot === 'string' ? JSON.parse(r.cart_snapshot) : r.cart_snapshot;
      const ritems = (snap?.items ?? []) as Array<{ productVariantId: string; quantity: number }>;
      for (const it of ritems) {
        priorReturnedByVariant[it.productVariantId] = (priorReturnedByVariant[it.productVariantId] ?? 0) + Number(it.quantity ?? 0);
      }
    }

    // Recompute refund_amount server-side from original-transaction unit prices.
    // R30-H11: only up to `paidQuantity` units contribute to the
    // refund subtotal. Any return quantity beyond that count was a
    // free-item promo unit and contributes $0. Total return quantity
    // is still capped by `orig.quantity` (the physical units sold).
    let computedRefundSubtotal = 0;
    for (const item of items) {
      const orig = origByVariant.get(item.variantId);
      if (!orig) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: `Item ${item.variantId} was not in the original transaction` }, { status: 400 });
      }
      const alreadyReturned = priorReturnedByVariant[item.variantId] ?? 0;
      const remaining = orig.quantity - alreadyReturned;
      if (item.quantity > remaining) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: `Only ${Math.max(0, remaining)} of this item remain available to return` }, { status: 400 });
      }
      // Paid share of this return line. If the sale had N paid units
      // + M free units and `alreadyReturned` < N, the current return
      // converts up to `(N - alreadyReturned)` paid units. After that
      // only free units remain — $0 refund on the tail.
      // R31-H9: use weighted-average paid price (paidSubtotal /
      // paidQuantity) so mixed-price paid lines (some at list, some
      // at override-up / override-down) refund at their TRUE paid
      // rate, not a max-of-prices inflation.
      // R37-H2: also add weighted modifier upcharges per paid unit so
      // customers who paid for modifiers get them refunded. Mirrors
      // the register path's R36-H3 fix.
      const paidRemaining = Math.max(0, orig.paidQuantity - alreadyReturned);
      const paidShare = Math.min(item.quantity, paidRemaining);
      const weightedPaidUnit = orig.paidQuantity > 0 ? orig.paidSubtotal / orig.paidQuantity : 0;
      const weightedModifierUnit = orig.paidQuantity > 0 ? orig.paidModifierTotal / orig.paidQuantity : 0;
      computedRefundSubtotal += (weightedPaidUnit + weightedModifierUnit) * paidShare;
    }

    // Refund proration. We need to refund what the customer ACTUALLY paid
    // per line, which = (listPrice + modifiers) × (1 - discount_rate) × (1 + tax_rate).
    //   discountFactor = 1 - discount_total / (subtotal + modifiers)   (0..1)
    //   taxRate        = tax_total / (subtotal + modifiers)
    //
    // R37-H2: denominator is now `subtotal + modifiers`, matching
    // computeTotals() which applies cart-level discount against
    // `(subtotal + modifiers - lineDiscounts)`. The previous shape used
    // `subtotal` alone, inflating tax rate and producing a
    // discountFactor below zero (clamped to 0, zero refund) on any
    // heavily-modified sale with a cart discount.
    const origSubtotal = Number(txnResult.rows[0].subtotal) || 0;
    const origDiscount = Number(txnResult.rows[0].discount_total) || 0;
    const origTaxTotal = Number(txnResult.rows[0].tax_total) || 0;
    // Aggregate modifier total across the original cart_snapshot.
    const origModifiersTotal = origItems.reduce(
      (s, it) => s + (Number(it.quantity) || 0) * (Number((it as { modifierTotal?: number }).modifierTotal ?? 0) || 0),
      0,
    );
    const origTaxableBase = origSubtotal + origModifiersTotal;
    // R30-C4: clamp at [0, 1] — see src/app/api/returns/route.ts for
    // the rationale. Negative stored discounts can't inflate factors.
    const discountFactor = origTaxableBase > 0
      ? Math.min(1, Math.max(0, 1 - origDiscount / origTaxableBase))
      : 1;
    // Cap the effective tax rate. A malformed original transaction
    // (bundle-only line with zero subtotal contribution but non-zero
    // tax_total, or a stale snapshot with a fractional issue) could yield
    // a ratio > 1 and over-refund tax. No legitimate jurisdiction exceeds
    // 50%; the cap is a belt-and-braces sanity guard.
    const effectiveTaxRate = origTaxableBase > 0
      ? Math.min(0.5, origTaxTotal / origTaxableBase)
      : 0;
    const computedRefundTotal = Number(
      (computedRefundSubtotal * discountFactor * (1 + effectiveTaxRate)).toFixed(2),
    );

    // If the client-supplied refund_amount differs by more than 1 cent, reject.
    if (Math.abs(refund_amount - computedRefundTotal) > 0.01) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: `Refund amount mismatch: computed ${computedRefundTotal.toFixed(2)}` },
        { status: 400 }
      );
    }

    // Sum all prior refunds for this transaction so we don't over-refund.
    // Convention: refund tender rows are stored with negative amount (matching
    // register/return-action.ts). Prior refunds = sum of negative tender amounts.
    // Join through transactions to enforce org scoping on tender aggregates
    // too — without this, a query on transaction_tenders keyed by a foreign
    // transaction_id could, if RLS is ever disabled, sum up another tenant's
    // refund totals and skew the cap calculation.
    const priorRefResult = await client.query(
      `SELECT COALESCE(SUM(ABS(tt.amount)), 0)::numeric AS prior_refunds
       FROM transaction_tenders tt
       JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $2
       WHERE tt.transaction_id = $1 AND tt.amount < 0`,
      [transaction_id, orgId],
    );
    const priorRefunds = Number(priorRefResult.rows[0]?.prior_refunds) || 0;

    // Cap refund at what was actually tendered (cash/card) in the original transaction,
    // not the grand_total — grand_total includes gift card redemptions which reduce
    // the actual cash outlay. Refunding must not exceed actual cash/card received.
    // R43-M6: exclude loyalty-tendered rows too. Loyalty value reverses
    // via points, not cash. Including it inflates the cash/card refund
    // cap by the loyalty-tender portion of the original sale.
    const tenderResult = await client.query(
      `SELECT COALESCE(SUM(tt.amount), 0)::numeric AS cash_tendered
       FROM transaction_tenders tt
       JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $2
       WHERE tt.transaction_id = $1 AND tt.amount > 0 AND tt.tender_type NOT IN ('gift_card', 'store_credit', 'loyalty')`,
      [transaction_id, orgId],
    );
    const cashTendered = Number(tenderResult.rows[0]?.cash_tendered) || 0;
    const maxRefundable = cashTendered - priorRefunds;

    if (refund_amount > maxRefundable) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: `Refund amount ${refund_amount} exceeds remaining refundable amount ${Number(maxRefundable.toFixed(2))}` },
        { status: 400 }
      );
    }

    // Generate return number: RET-BEL-YYMMDD-NNN
    // R30-C3: add explicit org filter even though locationId is from
    // the verified withDualAuth ctx — the guardrail now scans single-
    // quoted SQL too, and a belt+suspenders filter is cheaper than a
    // suppression comment.
    const locResult = await client.query(
      'SELECT name FROM locations WHERE id = $1 AND organization_id = $2',
      [locationId, orgId]
    );
    const locCode = (locResult.rows[0]?.name || 'STR').slice(0, 3).toUpperCase();
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    const countResult = await client.query(
      `SELECT COUNT(*)::int as cnt FROM returns WHERE organization_id = $1 AND return_number LIKE $2`,
      [orgId, `RET-${locCode}-${dateStr}-%`]
    );

    // Create return record — retry loop handles concurrent collision on return_number.
    // We distinguish between (a) return_number collision (regenerate and retry) and
    // (b) idempotency_key collision (replay: return the already-created return).
    let returnId: string | null = null;
    let returnNumber = '';
    let idempotentReplay: { id: string; return_number: string; refund_amount: number } | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const seqCountResult = attempt === 0
        ? countResult
        : await client.query(
            `SELECT COUNT(*)::int as cnt FROM returns WHERE organization_id = $1 AND return_number LIKE $2`,
            [orgId, `RET-${locCode}-${dateStr}-%`]
          );
      const seq = (seqCountResult.rows[0]?.cnt || 0) + 1;
      returnNumber = `RET-${locCode}-${dateStr}-${String(seq).padStart(3, '0')}`;

      await client.query('SAVEPOINT sp_rp_insert');
      try {
        const retResult = await client.query(
          `INSERT INTO returns (
            organization_id, location_id, transaction_id, return_number,
            customer_name, reason, notes, refund_method, refund_amount, status,
            idempotency_key
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            orgId,
            locationId,
            transaction_id,
            returnNumber,
            customer_name || null,
            reason || 'other',
            notes || null,
            refund_method || 'store_credit',
            refund_amount,
            'completed',
            idempotencyKey || null,
          ],
        );
        await client.query('RELEASE SAVEPOINT sp_rp_insert');
        returnId = retResult.rows[0]?.id ?? null;
        break; // success
      } catch (e) {
        // Roll back only the failed INSERT, keeping the outer tx alive.
        await client.query('ROLLBACK TO SAVEPOINT sp_rp_insert').catch(() => {});
        const err = e as { code?: string; constraint?: string; message?: string };
        const isUniqueViolation =
          err.code === '23505' ||
          (typeof err.message === 'string' && err.message.includes('duplicate key'));
        if (!isUniqueViolation) throw e;

        // Detect which constraint hit: idempotency_key ⇒ idempotent replay, don't retry.
        if (idempotencyKey && err.constraint && err.constraint.includes('idempotency_key')) {
          const { rows: existing } = await client.query(
            `SELECT id, return_number, refund_amount FROM returns
             WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
            [orgId, idempotencyKey],
          );
          if (existing[0]) {
            idempotentReplay = {
              id: existing[0].id,
              return_number: existing[0].return_number,
              refund_amount: Number(existing[0].refund_amount),
            };
            break;
          }
        }
        // Otherwise it was a return_number collision — next iteration regenerates.
      }
    }

    if (idempotentReplay) {
      await client.query('ROLLBACK');
      return NextResponse.json({
        return_id: idempotentReplay.id,
        return_number: idempotentReplay.return_number,
        refund_amount: idempotentReplay.refund_amount,
        success: true,
        _idempotent: true,
      });
    }

    if (!returnId) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Failed to generate unique return number' }, { status: 500 });
    }
    // Pre-resolve all variant IDs before mutating state
    const variantIds = items.map((item) => {
      if (!item.quantity || item.quantity <= 0) return null;
      return item.variantId;
    });

    // Build the final per-variant inventory restore map. Bundle lines
    // contribute `component_qty × return_qty` for each component; regular
    // lines contribute `return_qty` against their own variant. Without this
    // pass the naive UPSERT below would write a phantom inventory_levels
    // row keyed on the bundle's sentinel productVariantId (which equals
    // bundleId, NOT a real variant) and fail to restock any component —
    // silently losing stock on every admin-processed bundle return.
    const restockByVariant = new Map<string, number>();

    // Create return line items (respect DB schema: bundle sentinels go
    // straight in, regular variants too). Inventory writes happen in the
    // aggregated pass below.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const variantId = variantIds[i];

      if (!variantId || !item.quantity || item.quantity <= 0) {
        console.warn(`Skipping return line item with invalid quantity ${item.quantity} for variant ${variantId}`);
        continue;
      }

      // Insert return line. For bundle lines, `variantId` is the bundle
      // sentinel — harmless in `return_lines` since nothing FKs it against
      // `product_variants` (return_lines.product_variant_id has no FK per
      // migration 002_returns_tables.sql).
      await client.query(
        `INSERT INTO return_lines (return_id, product_variant_id, quantity, unit_price, restock)
         VALUES ($1, $2, $3, $4, true)`,
        [returnId, variantId, item.quantity, item.unitPrice]
      );

      // Determine if this line corresponds to a bundle in the original
      // transaction and expand components accordingly.
      const orig = origByVariant.get(variantId);
      if (orig?.bundleId) {
        const comps = dbBundleComponents.get(orig.bundleId) ?? [];
        if (comps.length === 0) {
          console.warn(`[returns/process] bundle ${orig.bundleId} has no live components; inventory for its components won't be restocked`);
        }
        for (const c of comps) {
          restockByVariant.set(c.variantId, (restockByVariant.get(c.variantId) ?? 0) + c.qty * item.quantity);
        }
      } else {
        restockByVariant.set(variantId, (restockByVariant.get(variantId) ?? 0) + item.quantity);
      }
    }

    // Adjust inventory (batched UPSERT). Do NOT touch received_at — refund
    // restocks aren't supplier receipts and bumping that column breaks FIFO
    // aging. Skipping the fallback INSERT if the variant row doesn't exist
    // in product_variants would require an extra lookup — use UPSERT and
    // accept that a deleted variant produces an orphan row (same risk the
    // pre-bundle code carried).
    // R77-DB-M2: UPSERT instead of UPDATE-then-INSERT. Prior shape
    // hit R31-H6 race: two concurrent refund-restocks on a variant
    // with no inventory_levels row at restockLocationId → both
    // UPDATEs affect 0 rows → both INSERTs race → one wins, the
    // other hits 23505 and rolls back the entire tx. ON CONFLICT
    // DO UPDATE makes this safe under concurrency AND lets the
    // entire restock run in a single round-trip. Mirror of
    // /api/purchase-orders PATCH (R31-H6) and register/return-
    // action.ts (R30-C7).
    for (const [variantId, qty] of restockByVariant) {
      if (qty <= 0) continue;
      // R30-H1: restock at the ORIGINAL sale's location, not the
      // caller's. See txnResult SELECT above for rationale.
      await client.query(
        `INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, received_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (product_variant_id, location_id)
         DO UPDATE SET on_hand = inventory_levels.on_hand + EXCLUDED.on_hand,
                       updated_at = NOW()`,
        [orgId, variantId, restockLocationId, qty]
      );
    }

    // Reject refund methods the schema permits but the handler doesn't
    // implement. `exchange` is in refundMethodEnum but has no code path here
    // — previously a client passing refund_method='exchange' would create the
    // return row and restock inventory but write no refund tender, handing
    // the customer the merchandise back for free. The enum MUST stay in sync
    // with the implemented branches.
    if (refund_method !== 'original_tender' && refund_method !== 'cash' && refund_method !== 'store_credit') {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: `Unsupported refund method: ${refund_method}` },
        { status: 400 },
      );
    }

    // R47-M4: for original_tender, resolve the ACTUAL dominant tender
    // on the original sale instead of defaulting to 'card'. Prior
    // shape labeled every original_tender refund as 'card' — a
    // cash-origin sale refunded via original_tender produced a
    // negative 'card' tender row that shift-close's cashSales
    // (filtered on tender_type='cash') didn't see. Net: cash left
    // the drawer with no cash-side reconciliation ledger entry.
    let effectiveTenderType: string = refund_method === 'cash' ? 'cash' : 'card';
    let effectiveMethod: string = refund_method;
    if (refund_method === 'original_tender') {
      // JOIN through transactions for explicit org scoping — mirrors
      // the cash-tendered cap query earlier in this file.
      const { rows: origTenderRows } = await client.query(
        `SELECT tt.tender_type, SUM(tt.amount)::numeric AS total
           FROM transaction_tenders tt
           JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $2
          WHERE tt.transaction_id = $1 AND tt.amount > 0
            AND tt.tender_type NOT IN ('gift_card', 'store_credit', 'loyalty')
          GROUP BY tt.tender_type
          ORDER BY total DESC
          LIMIT 1`,
        [transaction_id, orgId],
      );
      const dominantTender = origTenderRows[0]?.tender_type as string | undefined;
      if (dominantTender === 'cash') {
        effectiveTenderType = 'cash';
        effectiveMethod = 'cash'; // drives the cash-specific paths below
      } else {
        effectiveTenderType = dominantTender ?? 'card';
      }
    }

    // Create refund record based on method
    if (refund_method === 'original_tender' || refund_method === 'cash') {
      await client.query(
        `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [
          transaction_id,
          effectiveTenderType,
          -refund_amount,
          JSON.stringify({ is_return: 'true', reason: reason || 'other', resolved_from: refund_method }),
        ]
      );
      // R47-M4: the cross-shift pay_out + open-shift-required path
      // now keys on `effectiveMethod` (which resolves 'original_tender'
      // on a cash-origin sale to 'cash') so those refunds also get
      // the physical-cash-leaves-drawer gate + cross-shift pay_out.
      // R44-C1 / R45-C1: conditional pay_out for cross-shift cash
      // refunds. See /api/returns/route.ts PUT for the full rationale.
      // R45-C1 extension: also check the original txn's created_at
      // against openShift.opened_at — a single register_session can
      // span MULTIPLE shifts, so session-equality alone is insufficient.
      // shift-close filters transactions by both session AND time-
      // window; the negative tender is invisible if the original txn
      // is same-session but predates the open shift's start.
      if (effectiveMethod === 'cash') {
        const { rows: origSessRows } = await client.query(
          `SELECT register_session_id, created_at FROM transactions
            WHERE id = $1 AND organization_id = $2`,
          [transaction_id, orgId],
        );
        const origRow = origSessRows[0] as { register_session_id: string | null; created_at: string } | undefined;
        const origSessionId = origRow?.register_session_id ?? null;
        const origCreatedAt = origRow?.created_at ? new Date(origRow.created_at).getTime() : 0;
        // R77-DB-H1: FOR UPDATE SKIP LOCKED (parity with
        // /api/returns PUT + admin/layaway-actions.ts). Prior shape
        // plain SELECT did not wait on closeShiftEnhancedAction's
        // FOR UPDATE, so a concurrent shift close could commit
        // between this SELECT and the pay_in_outs INSERT below,
        // orphaning the pay_out against a just-closed shift.
        const { rows: openShiftRows } = await client.query(
          `SELECT id, register_session_id, opened_at FROM shifts
            WHERE organization_id = $1 AND location_id = $2 AND status = 'open'
            ORDER BY opened_at DESC LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          [orgId, restockLocationId],
        );
        const openShift = openShiftRows[0] as { id: string; register_session_id: string; opened_at: string } | undefined;
        const sameSession = !!openShift && !!origSessionId && origSessionId === openShift.register_session_id;
        const openShiftOpenedAt = openShift ? new Date(openShift.opened_at).getTime() : 0;
        const inShiftWindow = sameSession && origCreatedAt >= openShiftOpenedAt;
        // R46-M1: reject a cash refund when no open shift at the
        // location exists. Prior shape silently committed the negative
        // tender + skipped the pay_out — shift-close's cashSales
        // filter excluded the historical transaction (created_at is in
        // the past), so the cash left the drawer with zero reconciliation
        // ledger entry. Mirror the /api/returns PUT behavior which
        // rejects with 409 in this case.
        if (!openShift) {
          await client.query('ROLLBACK');
          return NextResponse.json(
            { error: 'Cash refund requires an open shift at the return location.' },
            { status: 409 },
          );
        }
        if (openShift && !inShiftWindow) {
          await client.query(
            `INSERT INTO pay_in_outs (id, organization_id, shift_id, location_id, employee_id, direction, amount, reason, note, created_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pay_out', $5, $6, $7, now())`,
            [
              orgId,
              openShift.id,
              restockLocationId,
              employeeId,
              refund_amount,
              'refund',
              `Return ${returnNumber} (cross-shift cash refund)`,
            ],
          );
        }
      }
    } else if (refund_method === 'store_credit') {
      // Look up customer — prefer the customer_id on the original transaction
      // (set at checkout), otherwise fall back to first_name+last_name match.
      // Empty-name refund to store credit is rejected because first_name||' '||last_name
      // would equal a single space and could match imported rows with blank names.
      const txnCust = await client.query(
        `SELECT customer_id FROM transactions WHERE id = $1 AND organization_id = $2`,
        [transaction_id, orgId],
      );
      // R75-M: `AND is_active = true` — anonymized customers
      // (right-to-be-forgotten DELETE) have is_active=false +
      // balance=0. A late refund targeting such a record would
      // write store credit onto the [deleted] row; customer can
      // never redeem (checkout filters is_active), balance is
      // phantom liability + GDPR compliance break. Applies to
      // both lookup branches below.
      let custResult: { rows: { id: string; store_credit_balance: number }[] };
      if (txnCust.rows[0]?.customer_id) {
        custResult = await client.query(
          // Lock the customer row so concurrent refunds don't read-compute-write
          // the same starting balance and lose one of the credits.
          `SELECT id, store_credit_balance FROM customers
           WHERE id = $1 AND organization_id = $2 AND is_active = true LIMIT 1 FOR UPDATE`,
          [txnCust.rows[0].customer_id, orgId],
        );
      } else if (customer_name && customer_name.trim().length > 0) {
        custResult = await client.query(
          `SELECT id, store_credit_balance FROM customers
           WHERE first_name || ' ' || last_name = $1 AND organization_id = $2 AND is_active = true
           LIMIT 1 FOR UPDATE`,
          [customer_name.trim(), orgId],
        );
      } else {
        custResult = { rows: [] };
      }
      // R29-L1: if we can't resolve a customer but the caller asked for
      // store_credit, REFUSE the return. The prior shape silently
      // succeeded with `success: true, refund_amount: N` while writing
      // no store_credit rows + no ledger entry — the money evaporated.
      // Inventory was still restocked, so the cashier + accomplice
      // customer walked out with merchandise + no liability on the
      // books. This is the admin-path mirror of the register-side
      // return-action.ts which already rejects cleanly when customer is
      // unresolved.
      if (custResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: 'Store-credit refund requires a customer on the original transaction (or a matching customer name)' },
          { status: 400 },
        );
      }
      const customer = custResult.rows[0];
      // store_credit_balance is NUMERIC; node-pg returns it as a string.
      // Coerce to Number or "10.00" + 5 becomes the string "10.005".
      // Round to 2 decimals so IEEE-754 drift (e.g. 10.00 + 0.1 + 0.2) can't
      // accumulate into the NUMERIC column across successive refunds.
      const newBalance = Number(
        ((Number(customer.store_credit_balance) || 0) + refund_amount).toFixed(2)
      );
      // Update customer store credit balance. customer.id came from an
      // org-gated SELECT above, but gate again explicitly — defense in
      // depth so a future refactor that reorders or caches the SELECT
      // can't silently write across tenants.
      await client.query(
        `UPDATE customers SET store_credit_balance = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3`,
        [newBalance, customer.id, orgId]
      );
      // Insert ledger record
      await client.query(
        `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, transaction_id, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
        [randomUUID(), orgId, customer.id, 'refund', refund_amount, newBalance, employeeId, transaction_id, `Return: ${reason}`]
      );
    }

    // R28-C4: reverse loyalty points earned on the original sale.
    // Mirror the register-side fix (src/app/register/return-action.ts).
    // Without this, a cashier/manager + customer-accomplice loop can
    // farm loyalty points via buy→refund→buy→refund and cash out via
    // the loyalty tender at next purchase.
    //
    // R29-H1: reverse prorated from persisted points_earned instead of
    // recomputing against the live earn rate — matches the register-side
    // math so admin and register refunds produce identical reversals.
    //
    // R43-H3: wrap in SAVEPOINT. Same rationale as /api/returns PUT —
    // a query error inside the loyalty block aborts the whole Postgres
    // transaction (SQLSTATE 25P02) and silently reverses the refund
    // dispensation. SAVEPOINT/RELEASE/ROLLBACK TO SAVEPOINT isolates
    // the sub-block so the outer try/catch genuinely keeps money
    // movement committed.
    await client.query('SAVEPOINT sp_loyalty');
    try {
      const { rows: origCustRows } = await client.query(
        `SELECT customer_id, points_earned, grand_total FROM transactions
          WHERE id = $1 AND organization_id = $2`,
        [transaction_id, orgId],
      );
      const origCustomerId = origCustRows[0]?.customer_id as string | null;
      const origPointsEarned = Number(origCustRows[0]?.points_earned ?? 0) || 0;
      const origGrandTotal = Number(origCustRows[0]?.grand_total ?? 0) || 0;
      if (origCustomerId && origPointsEarned > 0 && origGrandTotal > 0) {
        // R40-2: cumulative-share loyalty reversal — see
        // src/app/register/return-action.ts for the full rationale.
        // Query prior refunds (both the admin `returns` table AND the
        // register-side negative-transaction path) and compute the
        // delta expected total minus what prior refunds already
        // reversed, so the sum across all refunds stays bounded by
        // `origPointsEarned`.
        // R43-M4: exclude the just-created return row (self) so the
        // cumulative-share math doesn't double-count. This route
        // INSERTs the new return at line ~511 BEFORE the loyalty block
        // runs, so a naive SUM includes self. The admin `/api/returns`
        // PUT path already does this correctly via `AND id <> $3`.
        // Without this fix, the N-th refund against the same sale
        // reads priorRefundTotal = sum(including self), pushes
        // newCumulativeShare past 1.0 (clamped), computes
        // pointsToReverse=0, and under-reverses loyalty — enabling
        // loyalty-farming via partial-refund cycles.
        const { rows: priorReturnRows } = await client.query(
          `SELECT COALESCE(SUM(refund_amount), 0)::numeric AS admin_prior
             FROM returns
            WHERE organization_id = $1
              AND transaction_id = $2
              AND status IN ('pending', 'completed')
              AND id <> $3`,
          [orgId, transaction_id, returnId],
        );
        const { rows: priorRegRows } = await client.query(
          `SELECT COALESCE(SUM(grand_total), 0)::numeric AS reg_prior
             FROM transactions
            WHERE organization_id = $1
              AND status = 'completed'
              AND cart_snapshot->>'originalTransactionId' = $2`,
          [orgId, transaction_id],
        );
        const adminPrior = Number(priorReturnRows[0]?.admin_prior ?? 0) || 0;
        const regPriorAbs = Math.abs(Number(priorRegRows[0]?.reg_prior ?? 0)) || 0;
        const priorRefundTotal = adminPrior + regPriorAbs;
        const priorShare = Math.min(1, Math.max(0, priorRefundTotal / origGrandTotal));
        const priorExpectedReverse = Math.round(origPointsEarned * priorShare);
        const newCumulative = priorRefundTotal + refund_amount;
        const newCumulativeShare = Math.min(1, Math.max(0, newCumulative / origGrandTotal));
        const newExpectedReverse = Math.round(origPointsEarned * newCumulativeShare);
        const pointsToReverse = Math.max(0, Math.min(
          origPointsEarned - priorExpectedReverse,
          newExpectedReverse - priorExpectedReverse,
        ));
        if (pointsToReverse > 0) {
          await client.query(
            `UPDATE customers
                SET loyalty_points = GREATEST(0, loyalty_points - $1),
                    updated_at = NOW()
              WHERE id = $2 AND organization_id = $3`,
            [pointsToReverse, origCustomerId, orgId],
          );
        }

        // R82-DB-H1 (HIGH): reverse denormalized total_spend +
        // visit_count on refund. Prior shape reversed loyalty only —
        // list-view total_spend drifted from live-SUM detail view.
        // visit_count decrements only on the refund that crosses the
        // full-refund boundary (partial refunds don't reduce visits).
        const wasPriorFullyRefunded = priorRefundTotal >= origGrandTotal - 0.005;
        const isNowFullyRefunded = newCumulative >= origGrandTotal - 0.005;
        const visitCountDelta = !wasPriorFullyRefunded && isNowFullyRefunded ? 1 : 0;
        await client.query(
          `UPDATE customers
              SET total_spend = GREATEST(0, total_spend - $1),
                  visit_count = GREATEST(0, visit_count - $2),
                  updated_at = NOW()
            WHERE id = $3 AND organization_id = $4`,
          [refund_amount, visitCountDelta, origCustomerId, orgId],
        );
      }
      await client.query('RELEASE SAVEPOINT sp_loyalty');
    } catch (err) {
      // Non-fatal — reversing loyalty failing shouldn't roll back the
      // refund money movement. Roll back the SAVEPOINT so the outer
      // transaction stays valid; log via safeErr so the discrepancy is
      // visible in logs for manual reconciliation.
      await client.query('ROLLBACK TO SAVEPOINT sp_loyalty').catch(() => {});
      console.error("[returns/process] loyalty reversal failed:", safeErr(err));
    }

    // R44-MED: audit the money-movement transition INSIDE the tx so
    // the audit row lives or dies with the refund. Prior shape had no
    // audit_events at all for this path — R43-H5 added it to the
    // sibling `/api/returns` PUT but missed this route.
    await client.query(
      `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
       VALUES ($1, $2, $3, $4, 'return', $5, 'return_completed', $6, now())`,
      [
        randomUUID(),
        orgId,
        restockLocationId,
        employeeId,
        returnId,
        JSON.stringify({
          transaction_id,
          refund_method,
          refund_amount,
          return_number: returnNumber,
        }),
      ],
    );

    await client.query('COMMIT');
    return NextResponse.json({
      return_id: returnId,
      return_number: returnNumber,
      refund_amount,
      success: true,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('POST /api/returns/process error:', safeErr(error));
    return NextResponse.json(
      { error: 'Failed to process return' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
});
