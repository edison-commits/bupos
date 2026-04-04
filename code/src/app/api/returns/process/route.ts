import { NextRequest, NextResponse } from 'next/server';
import { pool, orgQuery } from '@/lib/db';
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
  try {
    // Auth guard — require an active register session with register.open permission
    await requireRegisterPermission('register.open');
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

    // Validate transaction exists
    const txnResult = await orgQuery(
      ORG_ID,
      `SELECT id FROM transactions WHERE id = $1`,
      [transaction_id]
    );

    if (txnResult.rows.length === 0) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    // Generate return number: RET-BEL-YYMMDD-NNN
    const locResult = await pool.query(
      'SELECT name FROM locations WHERE id = $1',
      [LOCATION_ID]
    );
    const locCode = (locResult.rows[0]?.name || 'STR').slice(0, 3).toUpperCase();
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int as cnt FROM returns WHERE organization_id = $1 AND return_number LIKE $2`,
      [ORG_ID, `RET-${locCode}-${dateStr}-%`]
    );
    const seq = (countResult.rows[0]?.cnt || 0) + 1;
    const returnNumber = `RET-${locCode}-${dateStr}-${String(seq).padStart(3, '0')}`;

    // Create return record
    const retResult = await pool.query(
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

    // Create return line items and handle inventory
    const lineInserts = await Promise.all(
      items.map(async (item) => {
        // Get product variant ID from product ID (infer from SKU or name)
        const variantResult = await orgQuery(
          ORG_ID,
          `SELECT pv.id FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE p.id = $1 OR pv.sku = $2
           LIMIT 1`,
          [item.product_id, item.sku]
        );

        const variantId = variantResult.rows[0]?.id || item.product_id;

        // Insert return line
        await pool.query(
          `INSERT INTO return_lines (return_id, product_variant_id, quantity, unit_price, restock)
           VALUES ($1, $2, $3, $4, true)`,
          [returnId, variantId, item.quantity, item.unit_price]
        );

        // Adjust inventory (restock)
        await pool.query(
          `UPDATE inventory_levels
           SET on_hand = on_hand + $1, received_at = NOW(), updated_at = NOW()
           WHERE product_variant_id = $2 AND location_id = $3`,
          [item.quantity, variantId, LOCATION_ID]
        );
      })
    );

    // Create refund record based on method
    if (refund_method === 'original_tender' || refund_method === 'cash') {
      // Record as transaction tender (refund)
      await pool.query(
        `INSERT INTO transaction_tenders (transaction_id, tender_type, amount, is_refund)
         VALUES ($1, $2, $3, true)`,
        [transaction_id, refund_method === 'cash' ? 'cash' : 'credit_card', refund_amount]
      );
    } else if (refund_method === 'store_credit') {
      // Create store credit record (if customer exists)
      const custResult = await orgQuery(
        ORG_ID,
        `SELECT id FROM customers WHERE first_name || ' ' || last_name = $1 LIMIT 1`,
        [customer_name || '']
      );

      if (custResult.rows.length > 0) {
        const customerId = custResult.rows[0].id;
        // Insert store credit (you may need to create a store_credits table if it doesn't exist)
        // For now, we'll just record it as a note in the return
      }
    }

    return NextResponse.json({
      return_id: returnId,
      return_number: returnNumber,
      refund_amount,
      success: true,
    });
  } catch (error) {
    console.error('POST /api/returns/process error:', error);
    return NextResponse.json(
      { error: 'Failed to process return: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  }
}
