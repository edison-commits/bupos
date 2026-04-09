import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { orgTx } from '@/lib/db';
import { requireRegisterPermission } from '@/lib/authz';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';
import { checkRateLimit } from '@/lib/auth/rate-limit';
import { validateBody, returnProcessSchema } from '@/lib/validation/schemas';

interface ReturnLineItem {
  product_id: string;
  product_name: string;
  sku: string;
  quantity: number;
  unit_price: number;
}

interface ProcessReturnRequest {
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
export async function POST(request: NextRequest) {
  const idempotencyKey = request.headers.get('Idempotency-Key');

  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const authCtx = await requireRegisterPermission('register.open');
  const employeeId = authCtx.employee.id;

  const rl = checkRateLimit(`returns:${employeeId}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const client = await orgTx(orgId);

  // Idempotency check: if key provided, look for an already-succeeded return
  if (idempotencyKey) {
    const existing = await client.query(
      `SELECT id, return_number, refund_amount FROM returns
       WHERE organization_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [orgId, idempotencyKey],
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      const row = existing.rows[0];
      return NextResponse.json({
        return_id: row.id,
        return_number: row.return_number,
        refund_amount: Number(row.refund_amount),
        success: true,
        _idempotent: true,
      });
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

    // Validate that at least one item has a valid quantity before creating the return record
    const validItems = items.filter((item) => item.quantity > 0);
    if (validItems.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: 'At least one return item must have a positive quantity' },
        { status: 400 }
      );
    }

    // Validate transaction exists and get its grand_total
    const txnResult = await client.query(
      `SELECT id, grand_total FROM transactions WHERE id = $1 FOR UPDATE`,
      [transaction_id]
    );

    if (txnResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    const originalTotal = Number(txnResult.rows[0].grand_total) || 0;

    // Sum all prior refunds for this transaction so we don't over-refund
    const priorRefResult = await client.query(
      `SELECT COALESCE(SUM(ABS(amount)), 0)::numeric AS prior_refunds
       FROM transaction_tenders
       WHERE transaction_id = $1 AND is_refund = true`,
      [transaction_id],
    );
    const priorRefunds = Number(priorRefResult.rows[0]?.prior_refunds) || 0;

    // Cap refund at what was actually tendered (cash/card) in the original transaction,
    // not the grand_total — grand_total includes gift card redemptions which reduce
    // the actual cash outlay. Refunding must not exceed actual cash/card received.
    const tenderResult = await client.query(
      `SELECT COALESCE(SUM(ABS(amount)), 0)::numeric AS cash_tendered
       FROM transaction_tenders
       WHERE transaction_id = $1 AND is_refund = false AND tender_type NOT IN ('gift_card_redemption', 'store_credit')`,
      [transaction_id],
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
    const locResult = await client.query(
      'SELECT name FROM locations WHERE id = $1',
      [authCtx.location.id]
    );
    const locCode = (locResult.rows[0]?.name || 'STR').slice(0, 3).toUpperCase();
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    const countResult = await client.query(
      `SELECT COUNT(*)::int as cnt FROM returns WHERE organization_id = $1 AND return_number LIKE $2`,
      [orgId, `RET-${locCode}-${dateStr}-%`]
    );

    // Create return record — retry loop handles concurrent collision on return_number
    let returnId: string | null = null;
    let returnNumber = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      // Re-fetch count on retry to get a fresh sequence number
      const seqCountResult = attempt === 0
        ? countResult
        : await client.query(
            `SELECT COUNT(*)::int as cnt FROM returns WHERE organization_id = $1 AND return_number LIKE $2`,
            [orgId, `RET-${locCode}-${dateStr}-%`]
          );
      const seq = (seqCountResult.rows[0]?.cnt || 0) + 1;
      returnNumber = `RET-${locCode}-${dateStr}-${String(seq).padStart(3, '0')}`;

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
            authCtx.location.id,
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
        returnId = retResult.rows[0]?.id ?? null;
        break; // success
      } catch (e) {
        // If unique constraint violation, retry with new number; otherwise propagate
        if (e instanceof Error && !e.message.includes('duplicate key') && !e.message.includes('23505')) throw e;
      }
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

    // Create return line items and handle inventory (sequential to respect FK ordering)
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const variantId = variantIds[i];

      if (!variantId || !item.quantity || item.quantity <= 0) {
        console.warn(`Skipping return line item with invalid quantity ${item.quantity} for variant ${variantId}`);
        continue;
      }

      // Insert return line
      await client.query(
        `INSERT INTO return_lines (return_id, product_variant_id, quantity, unit_price, restock)
         VALUES ($1, $2, $3, $4, true)`,
        [returnId, variantId, item.quantity, item.unitPrice]
      );

      // Adjust inventory (restock) — use upsert to handle missing row
      const invResult = await client.query(
        `UPDATE inventory_levels
         SET on_hand = on_hand + $1, received_at = NOW(), updated_at = NOW()
         WHERE product_variant_id = $2 AND location_id = $3
         RETURNING id`,
        [item.quantity, variantId, authCtx.location.id]
      );

      // If no row existed, insert a new inventory_levels row
      if (invResult.rowCount === 0) {
        await client.query(
          `INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, received_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())`,
          [orgId, variantId, authCtx.location.id, item.quantity]
        );
      }
    }

    // Create refund record based on method
    if (refund_method === 'original_tender' || refund_method === 'cash') {
      // Record as transaction tender (refund)
      await client.query(
        `INSERT INTO transaction_tenders (transaction_id, tender_type, amount, is_refund)
         VALUES ($1, $2, $3, true)`,
        [transaction_id, refund_method === 'cash' ? 'cash' : 'credit_card', refund_amount]
      );
    } else if (refund_method === 'store_credit') {
      // Look up customer by name
      const custResult = await client.query(
        `SELECT id, store_credit_balance FROM customers WHERE first_name || ' ' || last_name = $1 AND organization_id = $2 LIMIT 1`,
        [customer_name || '', orgId]
      );
      if (custResult.rows.length > 0) {
        const customer = custResult.rows[0];
        const newBalance = (customer.store_credit_balance || 0) + refund_amount;
        // Update customer store credit balance
        await client.query(
          `UPDATE customers SET store_credit_balance = $1, updated_at = NOW() WHERE id = $2`,
          [newBalance, customer.id]
        );
        // Insert ledger record
        await client.query(
          `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, transaction_id, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
          [randomUUID(), orgId, customer.id, 'refund', refund_amount, newBalance, employeeId, transaction_id, `Return: ${reason}`]
        );
      }
    }

    await client.query('COMMIT');
    return NextResponse.json({
      return_id: returnId,
      return_number: returnNumber,
      refund_amount,
      success: true,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('POST /api/returns/process error:', error);
    return NextResponse.json(
      { error: 'Failed to process return' },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
