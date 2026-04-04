import { NextRequest, NextResponse } from 'next/server';
import { pool, orgTx, orgQuery } from '@/lib/db';
import { requireRegisterPermission } from '@/lib/authz';

const ORG_ID = '33262270-7100-4b46-b2fb-8b50ad872bbb';
const LOCATION_ID = 'c57268b3-cb14-4c1a-bda6-55e49ddc6313';

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
  // Acquire a transaction-scoped client with org context set
  const client = await orgTx(ORG_ID);

  try {
    // Auth guard — require an active register session with register.open permission
    const authCtx = await requireRegisterPermission('register.open');
    const employeeId = authCtx.employee.id;
    const body: ProcessReturnRequest = await request.json();

    const {
      transaction_id,
      customer_name,
      reason,
      notes,
      refund_method,
      items,
      refund_amount,
    } = body;

    if (!transaction_id || !items || items.length === 0) {
      return NextResponse.json(
        { error: 'Transaction ID and items are required' },
        { status: 400 }
      );
    }

    // Validate transaction exists and get its grand_total
    const txnResult = await client.query(
      `SELECT id, grand_total FROM transactions WHERE id = $1`,
      [transaction_id]
    );

    if (txnResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    const originalTotal = Number(txnResult.rows[0].grand_total) || 0;
    if (refund_amount > originalTotal) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: `Refund amount ${refund_amount} exceeds original transaction total ${originalTotal}` },
        { status: 400 }
      );
    }

    // Generate return number: RET-BEL-YYMMDD-NNN
    const locResult = await client.query(
      'SELECT name FROM locations WHERE id = $1',
      [LOCATION_ID]
    );
    const locCode = (locResult.rows[0]?.name || 'STR').slice(0, 3).toUpperCase();
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    const countResult = await client.query(
      `SELECT COUNT(*)::int as cnt FROM returns WHERE organization_id = $1 AND return_number LIKE $2`,
      [ORG_ID, `RET-${locCode}-${dateStr}-%`]
    );
    const seq = (countResult.rows[0]?.cnt || 0) + 1;
    const returnNumber = `RET-${locCode}-${dateStr}-${String(seq).padStart(3, '0')}`;

    // Create return record
    const retResult = await client.query(
      `INSERT INTO returns (
        organization_id, location_id, transaction_id, return_number,
        customer_name, reason, notes, refund_method, refund_amount, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        ORG_ID,
        LOCATION_ID,
        transaction_id,
        returnNumber,
        customer_name || null,
        reason || 'other',
        notes || null,
        refund_method || 'store_credit',
        refund_amount,
        'completed',
      ]
    );

    const returnId = retResult.rows[0].id;

    // Pre-resolve all variant IDs before mutating state
    const variantIds = await Promise.all(
      items.map(async (item) => {
        if (!item.quantity || item.quantity <= 0) return null;
        const variantResult = await client.query(
          `SELECT pv.id FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE p.id = $1 OR pv.sku = $2
           LIMIT 1`,
          [item.product_id, item.sku]
        );
        return variantResult.rows[0]?.id || item.product_id;
      })
    );

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
        [returnId, variantId, item.quantity, item.unit_price]
      );

      // Adjust inventory (restock) — use upsert to handle missing row
      const invResult = await client.query(
        `UPDATE inventory_levels
         SET on_hand = on_hand + $1, received_at = NOW(), updated_at = NOW()
         WHERE product_variant_id = $2 AND location_id = $3
         RETURNING id`,
        [item.quantity, variantId, LOCATION_ID]
      );

      // If no row existed, insert a new inventory_levels row
      if (invResult.rowCount === 0) {
        await client.query(
          `INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, on_hand, received_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())`,
          [ORG_ID, variantId, LOCATION_ID, item.quantity]
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
        `SELECT id, store_credit_balance FROM customers WHERE first_name || ' ' || last_name = $1 LIMIT 1`,
        [customer_name || '']
      );
      if (custResult.rows.length > 0) {
        const customer = custResult.rows[0];
        const newBalance = (customer.store_credit_balance || 0) + refund_amount;
        // Update customer store credit balance
        await client.query(
          `UPDATE customers SET store_credit_balance = $1, updated_at = NOW() WHERE id = $2`,
          [newBalance, customer.id]
        );
        // Insert ledger record if store_credit_ledger table exists
        try {
          await client.query(
            `INSERT INTO store_credit_ledger (customer_id, amount, balance_after, reason, created_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [customer.id, refund_amount, newBalance, `Return: ${reason}`, employeeId]
          );
        } catch {
          // Ledger table may not exist — balance update above is the critical part
        }
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
      { error: 'Failed to process return: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
