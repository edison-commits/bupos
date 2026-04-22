 
import { NextResponse } from 'next/server';
import { randomUUID } from '@/lib/uuid';
import { orgQuery, orgTx } from '@/lib/supabase-rest';
import { withDualAuth, withAdminAuth } from '@/lib/api/with-auth';
import { validateBody, returnCreateSchema, returnUpdateSchema } from '@/lib/validation/schemas';
import { invalidateInventoryCache } from "@/lib/cache/inventory-cache";

import { safeErr } from "@/lib/logging/safe-err";
/**
 * Returns API
 * GET  - List all returns (paginated)
 * POST - Create a new return with line items
 * PUT  - Update status (approve/complete/reject). On complete with restock, updates inventory.
 */
export const GET = withDualAuth("audit.view", async (request, ctx) => {
  const { orgId } = ctx;
  const pageRaw = parseInt(request.nextUrl.searchParams.get('page') ?? '1', 10);
  const pageSizeRaw = parseInt(request.nextUrl.searchParams.get('pageSize') ?? '20', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(100, pageSizeRaw) : 20;
  const offset = (page - 1) * pageSize;
  try {
    // R12-H-3: location-scope filter. `audit.view` is granted to roles
    // beyond owner/manager (inventory_clerk, support) — without this filter
    // they'd see every return org-wide including customer names + refund
    // amounts for stores they don't work at.
    let locClause = "";
    const params: unknown[] = [orgId];
    if (ctx.allowedLocations !== null) {
      if (ctx.allowedLocations.length === 0) {
        return NextResponse.json({ returns: [], total: 0, page });
      }
      params.push(ctx.allowedLocations);
      locClause = ` AND r.location_id = ANY($2::uuid[])`;
    }
    // Same filter but on the count query (no join alias — count references
    // the table directly). Mirror the logic.
    const countParams: unknown[] = [orgId];
    let countLocClause = "";
    if (ctx.allowedLocations !== null) {
      countParams.push(ctx.allowedLocations);
      countLocClause = ` AND location_id = ANY($2::uuid[])`;
    }

    const pageSizeIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const [countResult, { rows }] = await Promise.all([
      orgQuery(
        orgId,
        `SELECT COUNT(*)::int as total FROM returns WHERE organization_id = $1${countLocClause}`,
        countParams,
      ),
      orgQuery(
        orgId,
        `SELECT r.*,
        l.name as location_name,
        COUNT(rl.id)::int as line_count,
        COALESCE(SUM(rl.quantity), 0)::int as total_items
      FROM returns r
      JOIN locations l ON r.location_id = l.id
      LEFT JOIN return_lines rl ON r.id = rl.return_id
      WHERE r.organization_id = $1${locClause}
      GROUP BY r.id, l.name
      ORDER BY r.created_at DESC
      LIMIT $${pageSizeIdx} OFFSET $${offsetIdx}`,
        [...params, pageSize, offset],
      ),
    ]);
    const total = countResult.rows[0]?.total ?? 0;
    return NextResponse.json({ returns: rows, total, page });
  } catch (error) {
    console.error('Returns GET error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch returns' }, { status: 500 });
  }
});

export const POST = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId } = ctx;
  // R32-H8: honor Idempotency-Key header. Without it, a double-click
  // or network retry creates TWO `pending` returns for the same
  // original transaction. The sibling `/api/returns/process` already
  // uses this pattern (R13-M-5-derived); R32-H8 closes the gap here.
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (idempotencyKey) {
    try {
      const { rows: existing } = await (await import('@/lib/supabase-rest')).orgQuery(
        orgId,
        // R33-H8: return the FULL `returns` row on idempotent replay
        // so the response shape matches a fresh create. Prior shape
        // returned only {return_id, return_number, refund_amount},
        // but the fresh-create path returns the row object — admin
        // UIs that read result.return.status / .refund_method /
        // .notes silently got `undefined` on replays.
        `SELECT id, organization_id, location_id, transaction_id, return_number,
                customer_name, reason, notes, refund_method, refund_amount,
                status, idempotency_key, created_at, updated_at
           FROM returns
          WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [orgId, idempotencyKey],
      );
      if (existing[0]) {
        return NextResponse.json({
          return: existing[0],
          return_id: existing[0].id,
          return_number: existing[0].return_number,
          refund_amount: Number(existing[0].refund_amount),
          success: true,
          _idempotent: true,
        });
      }
    } catch {
      // R33-M-returns-idem: fall through to the main tx path on any
      // lookup error (DB hiccup etc.). The unique (org, idempotency_
      // key) index catches a second create attempt cleanly.
    }
  }
  try {
    const body = await request.json();
    const v = validateBody(returnCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { transaction_id, customer_name, reason, notes, refund_method, lines } = v.data;

    // Open the transaction up-front so the "original txn" read, the
    // prior-returned aggregation, and the new return INSERT all share one
    // client — and so we can FOR UPDATE the parent transactions row to
    // prevent two concurrent /api/returns POSTs from both passing the
    // remaining-qty check before either persists.
    const client = await orgTx(orgId);
    let origTxnRows: Array<Record<string, unknown>>;
    let priorTable: Array<{ product_variant_id: string; qty: number }>;
    let priorTxn: Array<Record<string, unknown>>;
    try {
      // R31-H5: align with the register-side advisory lock so THIS
      // endpoint, `/api/returns/process`, AND `src/app/register/
      // return-action.ts` all serialize on the same lock scope for the
      // same original transaction. Without this, an admin + register
      // refund can race and both commit.
      await client.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [`return:${transaction_id}`],
      );
      // R13-M-1: SELECT the original txn's location_id so the return row
      // attributes to the RIGHT store's Z-report + inventory restock, not
      // the manager's first-assigned location. Previously used
      // `ctx.employee.locationIds?.[0]`, which meant a manager at Cerritos
      // processing a Bellflower sale's return would land the return on
      // Cerritos' ledger — corrupting cross-location reconciliation.
      const r1 = await client.query(
        `SELECT id, cart_snapshot, subtotal, discount_total, tax_total, grand_total, location_id
         FROM transactions
         WHERE id = $1 AND organization_id = $2 AND status = 'completed'
         FOR UPDATE`,
        [transaction_id, orgId],
      );
      origTxnRows = r1.rows as Array<Record<string, unknown>>;
      if (origTxnRows.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: 'Original transaction not found' }, { status: 404 });
      }
      const r2 = await client.query(
        `SELECT rl.product_variant_id, COALESCE(SUM(rl.quantity), 0)::int AS qty
         FROM return_lines rl
         JOIN returns r ON r.id = rl.return_id
         WHERE r.organization_id = $1 AND r.transaction_id = $2
           AND r.status IN ('pending', 'completed')
         GROUP BY rl.product_variant_id`,
        [orgId, transaction_id],
      );
      priorTable = r2.rows as Array<{ product_variant_id: string; qty: number }>;
      const r3 = await client.query(
        `SELECT cart_snapshot FROM transactions
         WHERE organization_id = $1
           AND status = 'completed'
           AND cart_snapshot->>'originalTransactionId' = $2`,
        [orgId, transaction_id],
      );
      priorTxn = r3.rows as Array<Record<string, unknown>>;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw e;
    }

    // Use the ORIGINAL transaction's location for the return row. Non-managers
    // must be assigned to that location (owner/manager bypass). This blocks
    // a cashier at Store A from processing a return for a Store B sale just
    // because they happen to also be assigned to B — return attribution
    // follows the sale, not the return-processing cashier.
    const originalLocationId = origTxnRows[0].location_id as string;
    const isManager = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
    if (!isManager) {
      const employeeLocs = ctx.employee.locationIds ?? [];
      if (!employeeLocs.includes(originalLocationId)) {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
        return NextResponse.json(
          { error: "Cannot process a return for a transaction at a location you're not assigned to" },
          { status: 403 },
        );
      }
    }
    const locationId = originalLocationId;

    // R31-H8 / R30-H11: track `paidQuantity` separately so free-item
    // promo lines (promoCodeId set, or explicit $0 overridePrice) and
    // explicit $0 overrides refund at $0, not at the listed unitPrice.
    // The prior shape on this endpoint summed `quantity` only and used
    // `unitPrice` for every returned unit — the exact exploit vector
    // /api/returns/process closed in R30-H11. Also: R31-H9 — when the
    // same variant appears on both paid and free lines, paid-line
    // pricing wins (Math.max of paid prices so an override-up line
    // doesn't downgrade the paid price, but never use the free $0).
    const origSnapshot = typeof origTxnRows[0].cart_snapshot === 'string'
      ? JSON.parse(origTxnRows[0].cart_snapshot as string) : origTxnRows[0].cart_snapshot;
    const origItems: Array<{ productVariantId: string; unitPrice: number; quantity: number; isFree: boolean }> =
      ((origSnapshot as { items?: Array<{ productVariantId?: string; variantId?: string; unitPrice: number; quantity: number; promoCodeId?: string; overridePrice?: number }> })?.items ?? []).map((i) => ({
        productVariantId: i.productVariantId ?? (i as { variantId?: string }).variantId ?? '',
        unitPrice: Number(i.unitPrice) || 0,
        quantity: Number(i.quantity) || 0,
        isFree: !!i.promoCodeId || Number(i.overridePrice ?? i.unitPrice) === 0,
      }));
    // Aggregate original quantities by variant. The same variant may appear on
    // MULTIPLE cart_snapshot lines (different modifiers); summing quantities
    // and keeping unit price gives the correct "how many were purchased".
    // R37-H2: track `paidModifierTotal` per variant so refunds include
    // modifier upcharges the customer paid (mirrors the register-side
    // R36-H3 fix and /api/returns/process R37-H2).
    const origByVariant = new Map<string, {
      unitPrice: number;
      quantity: number;
      paidQuantity: number;
      paidModifierTotal: number;
    }>();
    for (const it of origItems) {
      const prev = origByVariant.get(it.productVariantId);
      const lineModifierTotal = Number((it as { modifierTotal?: number }).modifierTotal ?? 0) || 0;
      origByVariant.set(it.productVariantId, {
        unitPrice: Math.max(prev?.unitPrice ?? 0, it.isFree ? 0 : it.unitPrice),
        quantity: (prev?.quantity ?? 0) + it.quantity,
        paidQuantity: (prev?.paidQuantity ?? 0) + (it.isFree ? 0 : it.quantity),
        paidModifierTotal: (prev?.paidModifierTotal ?? 0) + (it.isFree ? 0 : it.quantity * lineModifierTotal),
      });
    }
    const priorReturnedByVariant: Record<string, number> = {};
    for (const r of priorTable as Array<{ product_variant_id: string; qty: number }>) {
      priorReturnedByVariant[r.product_variant_id] = (priorReturnedByVariant[r.product_variant_id] ?? 0) + Number(r.qty);
    }
    for (const r of priorTxn) {
      const snap = typeof r.cart_snapshot === 'string' ? JSON.parse(r.cart_snapshot) : r.cart_snapshot;
      const items = (snap?.items ?? []) as Array<{ productVariantId: string; quantity: number }>;
      for (const it of items) {
        priorReturnedByVariant[it.productVariantId] = (priorReturnedByVariant[it.productVariantId] ?? 0) + Number(it.quantity ?? 0);
      }
    }

    // Proration factors — refund should reflect what the customer ACTUALLY
    // paid per item (after discounts) PLUS the tax charged on it. Without
    // this, a 20%-off sale refunds at the full list price, and the tax
    // component is either omitted (prior bug) or applied at the current
    // location rate (also wrong).
    const origSubtotal = Number(origTxnRows[0].subtotal) || 0;
    const origDiscount = Number(origTxnRows[0].discount_total) || 0;
    const origTax = Number(origTxnRows[0].tax_total) || 0;
    // R37-H2: denominator is now (subtotal + modifiers) — matches
    // computeTotals' cart-discount base. Prior shape used subtotal
    // alone, inflating the tax rate on any modifier-heavy sale and
    // clamping discountFactor to 0 when cart discount exceeded
    // subtotal-but-not-(subtotal+modifiers).
    const origModifiersTotal = origItems.reduce(
      (s, it) => s + (Number(it.quantity) || 0) * (Number((it as { modifierTotal?: number }).modifierTotal ?? 0) || 0),
      0,
    );
    const origTaxableBase = origSubtotal + origModifiersTotal;
    // R30-C4: clamp to [0, 1]. A negative stored origDiscount (from
    // legacy rows created before the clamp in cart.ts) would otherwise
    // produce a factor > 1, inflating the refund beyond what the
    // customer paid.
    const discountFactor = origTaxableBase > 0
      ? Math.min(1, Math.max(0, 1 - origDiscount / origTaxableBase))
      : 1;
    // R32-H8-tax: cap derived tax rate at 0.5 to match the admin
    // `/api/returns/process` path (R28-M9) and the register-side
    // return-action. Without the cap, a malformed original txn (huge
    // forged tax_total on a small subtotal) inflates the refund.
    const taxRateEffective = origTaxableBase > 0
      ? Math.min(0.5, Math.max(0, origTax / origTaxableBase))
      : 0;

    // Validate each line against (original qty - already returned) AND
    // recompute refundAmount server-side using original discount + tax rate.
    // Client unit_price is ignored.
    //
    // IMPORTANT: the client/tx is ALREADY open from the FOR UPDATE above.
    // Early-return paths must ROLLBACK + release before returning so we
    // don't leak a transaction or connection.
    let refundAmount = 0;
    const abort = async (status: number, error: string) => {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      return NextResponse.json({ error }, { status });
    };

    for (const line of lines) {
      if (!line.quantity || line.quantity <= 0) {
        return abort(400, 'Invalid line quantity');
      }
      const orig = origByVariant.get(line.product_variant_id);
      if (!orig) {
        return abort(400, `Variant ${line.product_variant_id} was not in the original transaction`);
      }
      const alreadyReturned = priorReturnedByVariant[line.product_variant_id] ?? 0;
      const remaining = orig.quantity - alreadyReturned;
      if (line.quantity > remaining) {
        return abort(400, `Only ${Math.max(0, remaining)} of this item remain available to return`);
      }
      // R31-H8 / R30-H11: only the PAID share of this line contributes
      // to the refund subtotal. Units beyond paidQuantity were free
      // (promo or $0 override) and refund at $0.
      // R37-H2: include modifier upcharges — customers who paid for
      // modifiers (add-ons, size bumps) get those dollars back too.
      const paidRemaining = Math.max(0, orig.paidQuantity - alreadyReturned);
      const paidShare = Math.min(line.quantity, paidRemaining);
      const weightedModifierUnit = orig.paidQuantity > 0
        ? orig.paidModifierTotal / orig.paidQuantity
        : 0;
      // Effective price paid = (listPrice + modifiers) * (1 - discount/base) * (1 + tax/base)
      refundAmount += (orig.unitPrice + weightedModifierUnit) * paidShare * discountFactor * (1 + taxRateEffective);
    }
    refundAmount = Number(refundAmount.toFixed(2));

    // Generate return number: RET-BEL-YYMMDD-NNN — retry loop handles concurrent collision.
    // Reuse the same client so we're still inside the FOR UPDATE lock.
    // R30-C3: belt+suspenders org filter.
    const { rows: locRows } = await client.query('SELECT name FROM locations WHERE id = $1 AND organization_id = $2', [locationId, orgId]);
    const locCode = ((locRows[0] as { name?: string })?.name || 'STR').slice(0, 3).toUpperCase();
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    const returnId = randomUUID();
    let returnNumber = '';

    // Atomic: header + all lines in one transaction so a line-insert failure
    // doesn't leave an orphan return record. Use SAVEPOINT around the INSERT
    // so a 23505 collision can be rolled back without aborting the whole tx.
    let retRowsTx: Array<Record<string, unknown>> = [];
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { rows: countRows } = await client.query(
          `SELECT COUNT(*)::int as cnt FROM returns WHERE organization_id = $1 AND return_number LIKE $2`,
          [orgId, `RET-${locCode}-${dateStr}-%`],
        );
        const seq = (countRows[0].cnt || 0) + 1;
        returnNumber = `RET-${locCode}-${dateStr}-${String(seq).padStart(3, '0')}`;
        await client.query('SAVEPOINT sp_ret_insert');
        try {
          const r = await client.query(
            `INSERT INTO returns (id, organization_id, location_id, transaction_id, return_number, customer_name, reason, notes, refund_method, refund_amount, status, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
             RETURNING *`,
            [returnId, orgId, locationId, transaction_id, returnNumber, customer_name || null, reason || 'other', notes || null, refund_method || 'store_credit', refundAmount, idempotencyKey || null],
          );
          await client.query('RELEASE SAVEPOINT sp_ret_insert');
          retRowsTx = r.rows;
          break;
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT sp_ret_insert').catch(() => {});
          const err = e as { code?: string; message?: string };
          if (err.code === '23505' || (err.message && err.message.includes('duplicate key'))) continue;
          throw e;
        }
      }
      if (retRowsTx.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Failed to generate unique return number' }, { status: 500 });
      }

      for (const line of lines) {
        // R27-M12: overwrite client-supplied unit_price with the
        // server-authoritative price from the original transaction.
        // Dollar-level refund math (refundAmount above) already uses
        // `orig.unitPrice`, so money is safe; but the prior code
        // persisted the raw client value into return_lines.unit_price,
        // which pollutes reports and misleads managers during
        // dispute investigations.
        const origUnitPrice = origByVariant.get(line.product_variant_id)?.unitPrice ?? 0;
        await client.query(
          `INSERT INTO return_lines (return_id, product_variant_id, quantity, unit_price, restock)
           VALUES ($1, $2, $3, $4, $5)`,
          [returnId, line.product_variant_id, line.quantity, origUnitPrice, line.restock !== false],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    invalidateInventoryCache(orgId);
    return NextResponse.json({ return: retRowsTx[0], return_number: returnNumber }, { status: 201 });
  } catch (error) {
    console.error('Returns POST error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to create return' }, { status: 500 });
  }
});

export const PUT = withAdminAuth('employee.manage', async (request, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await request.json();
    const v = validateBody(returnUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { id, status } = v.data;
    // processed_by is always the authenticated admin — never from the body.
    // Otherwise an admin could blame a return on a coworker in the audit trail.
    const processed_by = ctx.employee.id;

    const client = await orgTx(orgId);
    try {
      // R27-C10: explicit organization_id filter. Without it, a PUT
      // with a foreign tenant's return id landed as "completed" and
      // UPSERTed into THIS tenant's inventory_levels at the victim's
      // location_id — polluting both sides' ledgers.
      const { rows: ret } = await client.query(
        `SELECT id, status, location_id FROM returns WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [id, orgId],
      );
      if (ret.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: 'Return not found' }, { status: 404 });
      }
      if (status === 'completed' && ret[0].status === 'completed') {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: 'Return already completed' }, { status: 409 });
      }

      if (status === 'completed' && ret[0].status !== 'completed') {
        // R27-C10: JOIN through returns to enforce org on the lines.
        const { rows: lines } = await client.query(
          `SELECT rl.product_variant_id, rl.quantity
           FROM return_lines rl
           JOIN returns r ON r.id = rl.return_id AND r.organization_id = $2
           WHERE rl.return_id = $1 AND rl.restock = true`,
          [id, orgId],
        );

        if (lines.length > 0) {
          // Batched UPSERT via unnest — restocks to existing rows AND creates
          // the row if no inventory_level exists yet (matches returns/process
          // behavior). Without the INSERT fallback, restocks silently no-op
          // for variants that have never been stocked at this location.
          const variantIds = lines.map((l: { product_variant_id: string }) => l.product_variant_id);
          const quantities = lines.map((l: { quantity: number }) => l.quantity);
          // Restocks from refunds must NOT touch received_at (supplier-receipt
          // semantic; used by FIFO aging). First-time rows get received_at = NOW()
          // at creation (unavoidable — it's a new shelf-unit), but subsequent
          // restocks only bump on_hand + updated_at.
          await client.query(
            `INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, received_at, updated_at)
             SELECT $1, delta.variant_id, $2, delta.qty, NOW(), NOW()
             FROM (SELECT unnest($3::uuid[]) as variant_id, unnest($4::int[]) as qty) AS delta
             ON CONFLICT (product_variant_id, location_id)
             DO UPDATE SET
               on_hand = inventory_levels.on_hand + EXCLUDED.on_hand,
               updated_at = NOW()`,
            [orgId, ret[0].location_id, variantIds, quantities],
          );
        }
      }

      // R27-C10: explicit org filter on the status UPDATE.
      const { rows } = await client.query(
        `UPDATE returns SET status = $1, processed_by = $2, updated_at = NOW() WHERE id = $3 AND organization_id = $4 RETURNING *`,
        [status, processed_by || null, id, orgId],
      );
      await client.query("COMMIT");
      invalidateInventoryCache(orgId);
      return NextResponse.json({ return: rows[0] }, { status: 200 });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Returns PUT error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to update return' }, { status: 500 });
  }
});
