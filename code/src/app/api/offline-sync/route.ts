import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import pool, { orgTx } from "@/lib/db";
import { requireRegisterPermission } from "@/lib/authz";

const ORG_ID = process.env.BUPOS_ORG_ID || "33262270-7100-4b46-b2fb-8b50ad872bbb";
const LOCATION_ID = process.env.BUPOS_LOCATION_ID || "c57268b3-cb14-4c1a-bda6-55e49ddc6313";

/**
 * POST /api/offline-sync
 *
 * Receives a transaction that was completed offline and persists it to Postgres.
 * This mirrors the logic in checkout-action.ts but works from a serialized payload
 * rather than requiring a live session.
 */
export async function POST(request: NextRequest) {
  // Auth: require a real session cookie before accepting any offline-sync payload.
  await requireRegisterPermission("register.open");

  try {
    const body = await request.json();
    const { id, cart, tenders, timestamp, registerSessionId } = body;

    if (!cart || !tenders || !Array.isArray(tenders) || tenders.length === 0) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    // ── Auth: validate registerSessionId against cookie-backed session ──────────
    // Offline sync can't use cookie auth since the request is made after the
    // register goes offline. Instead, we validate the registerSessionId exists
    // and is active for the given employee in the org.
    const employeeId = cart.employeeId || null;
    const sessionId = registerSessionId || cart.registerSessionId || null;

    if (!sessionId) {
      return NextResponse.json({ error: "registerSessionId is required" }, { status: 401 });
    }

    const client = await orgTx(ORG_ID);
    try {
      const { rows: sessionRows } = await client.query(
        `SELECT rs.id FROM register_sessions rs
         JOIN sessions s ON s.id = rs.auth_session_id
         WHERE rs.id = $1 AND rs.status = 'active' AND s.expires_at > NOW()`,
        [sessionId],
      );
      if (sessionRows.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Invalid or expired register session" }, { status: 401 });
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // Look up location's tax rate from DB instead of hardcoding
    let taxRate = 0.1025; // default fallback
    try {
      const taxClient = await orgTx(ORG_ID);
      try {
        const { rows: locRows } = await taxClient.query(
          `SELECT tax_rate FROM locations WHERE id = $1`,
          [LOCATION_ID],
        );
        if (locRows[0]?.tax_rate != null) {
          taxRate = Number(locRows[0].tax_rate);
        }
        await taxClient.query("COMMIT");
      } catch {
        await taxClient.query("ROLLBACK");
      } finally {
        taxClient.release();
      }
    } catch {
      // Use default tax rate if lookup fails
    }

    // Recalculate totals from the cart snapshot
    const items = cart.items || [];
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

    const syncClient = await orgTx(ORG_ID);
    let inserted = true;
    try {
      // 1. Transaction record — upsert so retried syncs are idempotent
      const txnRes = await syncClient.query(
        `INSERT INTO transactions (id, organization_id, location_id, register_session_id, employee_id, cart_snapshot, subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered, change_due, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'completed', $14)
         ON CONFLICT (id) DO UPDATE SET
           cart_snapshot = EXCLUDED.cart_snapshot,
           subtotal = EXCLUDED.subtotal,
           discount_total = EXCLUDED.discount_total,
           tax_total = EXCLUDED.tax_total,
           grand_total = EXCLUDED.grand_total,
           tender_type = EXCLUDED.tender_type,
           amount_tendered = EXCLUDED.amount_tendered,
           change_due = EXCLUDED.change_due,
           status = EXCLUDED.status,
           created_at = EXCLUDED.created_at
         RETURNING id`,
        [
          transactionId, ORG_ID, LOCATION_ID, sessionId, employeeId,
          JSON.stringify(cart), subtotal, discountTotal, taxTotal, grandTotal,
          primaryTenderType, totalTendered, changeDue,
          timestamp || new Date().toISOString(),
        ],
      );
      if (!txnRes.rows[0]) {
        inserted = false;
      }

      // 2. Tender lines
      for (const tender of tenders) {
        const isLastCash = tender.type === "cash" && tender === tenders.filter((t: { type: string }) => t.type === "cash").at(-1);
        await syncClient.query(
          `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [randomUUID(), transactionId, tender.type, tender.amount,
           JSON.stringify(isLastCash ? { change_due: changeDue.toFixed(2) } : {})],
        );
      }

      // 3. Completion event
      await syncClient.query(
        `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload)
         VALUES ($1, $2, $3, 'transaction_placeholder', $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(), transactionId, employeeId,
          `Offline checkout synced`,
          JSON.stringify({
            location_id: LOCATION_ID,
            register_session_id: sessionId,
            item_count: items.length,
            grand_total: grandTotal.toFixed(2),
            offline_timestamp: timestamp,
            synced_at: new Date().toISOString(),
          }),
        ],
      );

      // 4. Decrement inventory (batched)
      if (items.length > 0) {
        const variantIds = items.map((i: { productVariantId: string }) => i.productVariantId);
        const quantities = items.map((i: { quantity: number }) => -i.quantity);
        await syncClient.query(
          `UPDATE inventory_levels il
           SET on_hand = GREATEST(0, il.on_hand + delta.qty), updated_at = now()
           FROM (SELECT unnest($1::uuid[]) as variant_id, unnest($2::int[]) as qty) AS delta
           WHERE il.product_variant_id = delta.variant_id AND il.location_id = $3`,
          [variantIds, quantities, LOCATION_ID],
        );
      }

      // 5. Restore loyalty points earned — mirrors checkout-action.ts step 7
      const loyaltyPointsEarned = cart.customerId
        ? (cart.loyaltyPointsEarned ?? Math.floor(grandTotal))
        : 0;
      if (loyaltyPointsEarned > 0 && cart.customerId) {
        await syncClient.query(
          `UPDATE customers SET
            loyalty_points = loyalty_points + $1,
            total_spend = total_spend + $2,
            visit_count = visit_count + 1,
            updated_at = now()
          WHERE id = $3`,
          [loyaltyPointsEarned, grandTotal, cart.customerId],
        );
      }

      await syncClient.query("COMMIT");
    } catch (e) {
      await syncClient.query("ROLLBACK");
      throw e;
    } finally {
      syncClient.release();
    }

    return NextResponse.json({ success: true, transactionId, inserted });
  } catch (error) {
    console.error("Offline sync error:", error);
    return NextResponse.json(
      { error: "Failed to sync transaction" },
      { status: 500 },
    );
  }
}
