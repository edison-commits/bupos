import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { orgTx, orgQuery } from "@/lib/db";
import { requireRegisterPermission } from "@/lib/authz";
import { registerConfiguration } from "@/lib/data/mock-data";

import { BUPOS_LOCATION_ID } from '@/lib/env';
interface CartPayload {
  employeeId?: string;
  registerSessionId?: string;
  customerId?: string;
  loyaltyPointsEarned?: number;
  discountMode?: 'percent' | 'fixed';
  discountAmount?: number;
  items?: CartLineItem[];
  [key: string]: unknown;
}

interface CartLineItem {
  productVariantId: string;
  quantity: number;
  overridePrice?: number;
  unitPrice?: number;
  modifierTotal?: number;
  lineDiscount?: {
    mode: 'percent' | 'fixed';
    value: number;
  };
  [key: string]: unknown;
}

/**
 * POST /api/offline-sync
 *
 * Receives a transaction that was completed offline and persists it to Postgres.
 * This mirrors the logic in checkout-action.ts but works from a serialized payload
 * rather than requiring a live session.
 */
export async function POST(request: NextRequest) {
  const authCtx = await requireRegisterPermission("register.open");
  const orgId = authCtx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { id, cart, tenders, timestamp, registerSessionId, approvedExceptions = [] } = body as {
      id: string;
      cart: CartPayload;
      tenders: Array<{ type: string; amount: number }>;
      timestamp?: string;
      registerSessionId?: string;
      approvedExceptions?: string[];
    };

    // cart is an object { items, employeeId, registerSessionId, discountMode, discountAmount, ... }
    // tenders is an array [{ tenderType, amount }, ...]
    if (!cart || typeof cart !== 'object' || Array.isArray(cart)) {
      return NextResponse.json({ error: 'Invalid sync payload: cart must be an object' }, { status: 400 });
    }
    if (!Array.isArray(tenders)) {
      return NextResponse.json({ error: 'Invalid sync payload: tenders must be an array' }, { status: 400 });
    }
    if (tenders.length === 0) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    // ── Auth: validate registerSessionId against cookie-backed session ──────────
    // Offline sync can't use cookie auth since the request is made after the
    // register goes offline. Instead, we validate the registerSessionId exists
    // and is active for the given employee in the org.
    const sessionId = registerSessionId || cart.registerSessionId || null;

    if (!sessionId) {
      return NextResponse.json({ error: "registerSessionId is required" }, { status: 401 });
    }

    const cookieSessionId = authCtx.session.id;
    let sessionEmployeeId: string;
    const client = await orgTx(orgId);
    try {
      const { rows: sessionRows } = await client.query(
        `SELECT rs.employee_id, rs.auth_session_id
         FROM register_sessions rs
         JOIN sessions s ON s.id = rs.auth_session_id
         WHERE rs.id = $1 AND rs.status = 'active' AND s.expires_at > NOW()`,
        [sessionId],
      );
      if (sessionRows.length === 0 || sessionRows[0].auth_session_id !== cookieSessionId) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Register session mismatch" }, { status: 403 });
      }
      const sessionEmployeeIdValue = sessionRows[0].employee_id as string | undefined;
      if (!sessionEmployeeIdValue) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Invalid session" }, { status: 401 });
      }
      sessionEmployeeId = sessionEmployeeIdValue;
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
      const { rows: locRows } = await orgQuery(
        orgId,
        `SELECT tax_rate FROM locations WHERE id = $1`,
        [BUPOS_LOCATION_ID],
      );
      if (locRows[0]?.tax_rate != null) {
        taxRate = Number(locRows[0].tax_rate);
      }
    } catch {
      // Use default tax rate if lookup fails — log for observability
      console.warn("[offline-sync] tax rate lookup failed, using default 0.1025");
    }

    // Recalculate totals from the cart snapshot
    const items = cart.items || [];
    let subtotal = 0;
    // Round each monetary operation to 2 decimal places to prevent float drift
    // (e.g. 19.99 * 3 can be 59.9699999 in IEEE 754)
    const m = (v: number) => Number(v.toFixed(2));

    let discountTotal = 0;
    let modifiersTotal = 0;

    for (const item of items) {
      const effectivePrice = item.overridePrice ?? item.unitPrice ?? 0;
      const lineBase = m(effectivePrice * item.quantity);
      const lineMods = m((item.modifierTotal || 0) * item.quantity);
      let lineDiscount = 0;

      if (item.lineDiscount) {
        if (item.lineDiscount.mode === "percent") {
          lineDiscount = m(lineBase * Math.min(100, item.lineDiscount.value) / 100);
        } else {
          lineDiscount = m(Math.min(item.lineDiscount.value, lineBase));
        }
      }

      subtotal = m(subtotal + lineBase);
      modifiersTotal = m(modifiersTotal + lineMods);
      discountTotal = m(discountTotal + lineDiscount);
    }

    // Cart-level discount
    const cartDiscount = cart.discountMode === "percent"
      ? m(subtotal * Math.min(100, cart.discountAmount || 0) / 100)
      : m(cart.discountAmount || 0);
    discountTotal = m(discountTotal + cartDiscount);

    const taxableAmount = Math.max(0, subtotal + modifiersTotal - discountTotal);
    const taxTotal = Number((taxableAmount * taxRate).toFixed(2));
    const grandTotal = Number((taxableAmount + taxTotal).toFixed(2));

    // ── Server-side approval enforcement — mirrors checkout-action.ts ──────────
    const thresholds = registerConfiguration.approvalThresholds;
    if (cartDiscount > thresholds.discountOver && !approvedExceptions.includes("discount_threshold")) {
      return NextResponse.json({ error: "Cart discount exceeds threshold without manager approval" }, { status: 403 });
    }
    const storeCreditTendered = tenders
      .filter((t: { type: string }) => t.type === "store_credit")
      .reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    if (storeCreditTendered > thresholds.storeCreditIssuanceOver && !approvedExceptions.includes("store_credit_threshold")) {
      return NextResponse.json({ error: "Store credit issuance exceeds threshold without manager approval" }, { status: 403 });
    }

    const totalTendered = tenders.reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    const cashTendered = tenders.filter((t: { type: string }) => t.type === "cash").reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    const loyaltyTendered = tenders.filter((t: { type: string }) => t.type === "loyalty").reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    const nonCashTendered = tenders.filter((t: { type: string }) => t.type !== "cash" && t.type !== "loyalty").reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    const cashPortion = Math.max(0, grandTotal - nonCashTendered);
    const changeDue = cashTendered > cashPortion ? Number((cashTendered - cashPortion).toFixed(2)) : 0;
    const primaryTenderType = tenders.length === 1 ? tenders[0].type : "split";
    const loyaltyPointsRedeemed = loyaltyTendered > 0 && cart.customerId
      ? Math.round(loyaltyTendered / registerConfiguration.loyalty.redemptionValuePerPoint)
      : 0;

    const transactionId = id || randomUUID();

    const syncClient = await orgTx(orgId);
    let inserted = true;
    try {
      // 1. Idempotency check first so retried syncs can safely no-op
      const { rows: existingEvents } = await syncClient.query(
        `SELECT id FROM transaction_events WHERE transaction_id = $1 AND payload->>'synced_at' IS NOT NULL LIMIT 1`,
        [transactionId],
      );
      const isAlreadySynced = existingEvents.length > 0;

      // 2. Transaction record and follow-on effects only run once per synced transaction
      if (!isAlreadySynced) {
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
            transactionId, orgId, BUPOS_LOCATION_ID, sessionId, sessionEmployeeId,
            JSON.stringify(cart), subtotal, discountTotal, taxTotal, grandTotal,
            primaryTenderType, totalTendered, changeDue,
            timestamp || new Date().toISOString(),
          ],
        );
        if (!txnRes.rows[0]) {
          inserted = false;
        }

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

        await syncClient.query(
          `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload)
           VALUES ($1, $2, $3, 'transaction_placeholder', $4, $5)
           ON CONFLICT DO NOTHING`,
          [
            randomUUID(), transactionId, sessionEmployeeId,
            `Offline checkout synced`,
            JSON.stringify({
              location_id: BUPOS_LOCATION_ID,
              register_session_id: sessionId,
              item_count: items.length,
              grand_total: grandTotal.toFixed(2),
              offline_timestamp: timestamp,
              synced_at: new Date().toISOString(),
            }),
          ],
        );

        // 3. Decrement inventory (batched) — lock rows + check stock before applying to prevent oversell
        if (items.length > 0) {
          const variantIds = items.map((i: { productVariantId: string }) => i.productVariantId);
          const quantities = items.map((i: { quantity: number }) => -i.quantity);

          // Lock rows in deterministic order to avoid deadlocks, then verify stock
          const { rows: locked } = await syncClient.query(
            `SELECT il.product_variant_id, il.on_hand
             FROM inventory_levels il
             WHERE il.product_variant_id = ANY($1::uuid[]) AND il.location_id = $2
             ORDER BY il.product_variant_id
             FOR UPDATE`,
            [variantIds, BUPOS_LOCATION_ID],
          );

          const onHandByVariant: Record<string, number> = {};
          for (const row of locked) {
            onHandByVariant[row.product_variant_id] = Number(row.on_hand);
          }

          // Check each line before applying any inventory changes — fail specifically per SKU
          for (const item of items) {
            const onHand = onHandByVariant[item.productVariantId] ?? 0;
            if (onHand < item.quantity) {
              const { rows: skuRows } = await syncClient.query(
                `SELECT sku FROM product_variants WHERE id = $1`,
                [item.productVariantId],
              );
              const sku = skuRows[0]?.sku ?? item.productVariantId;
              await syncClient.query("ROLLBACK");
              return NextResponse.json(
                { error: `Insufficient inventory for SKU ${sku}`, insufficientSku: sku },
                { status: 409 },
              );
            }
          }

          await syncClient.query(
            `UPDATE inventory_levels il
             SET on_hand = GREATEST(0, il.on_hand + delta.qty), updated_at = now()
             FROM (SELECT unnest($1::uuid[]) as variant_id, unnest($2::int[]) as qty) AS delta
             WHERE il.product_variant_id = delta.variant_id AND il.location_id = $3`,
            [variantIds, quantities, BUPOS_LOCATION_ID],
          );
        }

        // 4. Restore loyalty points earned — mirrors checkout-action.ts step 7
        const loyaltyPointsEarned = cart.customerId
          ? (cart.loyaltyPointsEarned ?? Math.floor(grandTotal))
          : 0;
        if ((loyaltyPointsEarned > 0 || loyaltyPointsRedeemed > 0) && cart.customerId) {
          const { rows: customerRows } = await syncClient.query(
            `SELECT loyalty_points FROM customers WHERE id = $1 FOR UPDATE`,
            [cart.customerId],
          );
          const currentPoints = Number(customerRows[0]?.loyalty_points ?? 0);
          if (loyaltyPointsRedeemed > currentPoints) {
            await syncClient.query("ROLLBACK");
            return NextResponse.json({ error: "Insufficient loyalty points" }, { status: 409 });
          }
          await syncClient.query(
            `UPDATE customers SET
              loyalty_points = loyalty_points - $1 + $2,
              total_spend = total_spend + $3,
              visit_count = visit_count + 1,
              updated_at = now()
            WHERE id = $4`,
            [loyaltyPointsRedeemed, loyaltyPointsEarned, grandTotal, cart.customerId],
          );
        }

        // 4b. Deduct store credit balance if used — mirrors checkout-action.ts step 7b
        if (storeCreditTendered > 0 && cart.customerId) {
          const { rows: balRows } = await syncClient.query(
            `UPDATE customers SET store_credit_balance = GREATEST(0, store_credit_balance - $1), updated_at = now() WHERE id = $2 RETURNING store_credit_balance`,
            [storeCreditTendered, cart.customerId],
          );
          await syncClient.query(
            `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, transaction_id, reason, created_at)
             VALUES ($1, $2, $3, 'redemption', $4, $5, $6, $7, 'Offline sync redemption', now())`,
            [randomUUID(), orgId, cart.customerId, -storeCreditTendered, balRows[0]?.store_credit_balance ?? 0, sessionEmployeeId, transactionId],
          );
        }
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
