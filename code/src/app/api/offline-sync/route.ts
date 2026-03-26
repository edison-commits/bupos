import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import pool, { orgTx } from "@/lib/db";

const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const LOCATION_ID = "c57268b3-cb14-4c1a-bda6-55e49ddc6313";

/**
 * POST /api/offline-sync
 *
 * Receives a transaction that was completed offline and persists it to Postgres.
 * This mirrors the logic in checkout-action.ts but works from a serialized payload
 * rather than requiring a live session.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, cart, tenders, timestamp } = body;

    if (!cart || !tenders || !Array.isArray(tenders) || tenders.length === 0) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    // Recalculate totals from the cart snapshot
    const items = cart.items || [];
    const taxRate = cart.taxRate || 0.1025;

    let subtotal = 0;
    let discountTotal = 0;
    let modifiersTotal = 0;

    for (const item of items) {
      const effectivePrice = item.overridePrice ?? item.unitPrice;
      const lineBase = effectivePrice * item.quantity;
      const lineMods = (item.modifierTotal || 0) * item.quantity;
      let lineDiscount = 0;

      if (item.lineDiscount) {
        if (item.lineDiscount.mode === "percent") {
          lineDiscount = lineBase * Math.min(100, item.lineDiscount.value) / 100;
        } else {
          lineDiscount = Math.min(item.lineDiscount.value, lineBase);
        }
      }

      subtotal += lineBase;
      modifiersTotal += lineMods;
      discountTotal += lineDiscount;
    }

    // Cart-level discount
    const cartDiscount = cart.discountMode === "percent"
      ? subtotal * Math.min(100, cart.discountAmount || 0) / 100
      : (cart.discountAmount || 0);
    discountTotal += cartDiscount;

    const taxableAmount = Math.max(0, subtotal + modifiersTotal - discountTotal);
    const taxTotal = Number((taxableAmount * taxRate).toFixed(2));
    const grandTotal = Number((taxableAmount + taxTotal).toFixed(2));

    const totalTendered = tenders.reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    const cashTendered = tenders.filter((t: { type: string }) => t.type === "cash").reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    const nonCashTendered = tenders.filter((t: { type: string }) => t.type !== "cash" && t.type !== "loyalty").reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    const cashPortion = Math.max(0, grandTotal - nonCashTendered);
    const changeDue = cashTendered > cashPortion ? Number((cashTendered - cashPortion).toFixed(2)) : 0;
    const primaryTenderType = tenders.length === 1 ? tenders[0].type : "split";

    const transactionId = id || randomUUID();
    const employeeId = cart.employeeId || null;
    const registerSessionId = cart.registerSessionId || null;

    const client = await orgTx(ORG_ID);
    try {
      // 1. Transaction record
      await client.query(
        `INSERT INTO transactions (id, organization_id, location_id, register_session_id, employee_id, cart_snapshot, subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered, change_due, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'completed', $14)
         ON CONFLICT (id) DO NOTHING`,
        [
          transactionId, ORG_ID, LOCATION_ID, registerSessionId, employeeId,
          JSON.stringify(cart), subtotal, discountTotal, taxTotal, grandTotal,
          primaryTenderType, totalTendered, changeDue,
          timestamp || new Date().toISOString(),
        ],
      );

      // 2. Tender lines
      for (const tender of tenders) {
        const isLastCash = tender.type === "cash" && tender === tenders.filter((t: { type: string }) => t.type === "cash").at(-1);
        await client.query(
          `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [randomUUID(), transactionId, tender.type, tender.amount,
           JSON.stringify(isLastCash ? { change_due: changeDue.toFixed(2) } : {})],
        );
      }

      // 3. Completion event
      await client.query(
        `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload)
         VALUES ($1, $2, $3, 'transaction_placeholder', $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(), transactionId, employeeId,
          `Offline checkout synced`,
          JSON.stringify({
            location_id: LOCATION_ID,
            register_session_id: registerSessionId,
            item_count: items.length,
            grand_total: grandTotal.toFixed(2),
            offline_timestamp: timestamp,
            synced_at: new Date().toISOString(),
          }),
        ],
      );

      // 4. Decrement inventory
      for (const item of items) {
        await client.query(
          `UPDATE inventory_levels SET on_hand = GREATEST(0, on_hand - $1), updated_at = now()
           WHERE product_variant_id = $2 AND location_id = $3`,
          [item.quantity, item.productVariantId, LOCATION_ID],
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    return NextResponse.json({ success: true, transactionId });
  } catch (error) {
    console.error("Offline sync error:", error);
    return NextResponse.json(
      { error: "Failed to sync transaction" },
      { status: 500 },
    );
  }
}
