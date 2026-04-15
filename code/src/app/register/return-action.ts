"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
import { requireRegisterPermission } from "@/lib/authz";
import { mutateStore } from "@/lib/persistence/store";
import { orgTx, getPool } from "@/lib/supabase-rest";
import type { TenderType } from "@/lib/domain/types";
import { registerConfiguration } from "@/lib/data/mock-data";

export interface ReturnLineItem {
  productVariantId: string;
  productName: string;
  variantName: string;
  sku: string;
  unitPrice: number;
  quantity: number;
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

  // Enforce return threshold — cashier-level returns above threshold require manager role
  const returnThreshold = registerConfiguration.approvalThresholds.returnWithoutManagerOver;
  const estimatedRefund = input.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  if (estimatedRefund > returnThreshold && context.employee.roleKey === "cashier") {
    throw new Error(`Return of $${estimatedRefund.toFixed(2)} exceeds $${returnThreshold.toFixed(2)} cashier threshold. Manager must process.`);
  }

  const refundTotal = Number(
    input.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0).toFixed(2),
  );
  // Add tax back — read from location
  const taxRate = context.location.taxRate ?? 0.1025;
  const refundTax = Number((refundTotal * taxRate).toFixed(2));
  const refundGrandTotal = Number((refundTotal + refundTax).toFixed(2));

  const returnTransactionId = randomUUID();

  if (isPg()) {
    const client = await orgTx(context.employee.organizationId);
    try {
      // 1. Create return transaction (negative amounts)
      const cartSnapshot = {
        items: input.items.map((i) => ({
          productVariantId: i.productVariantId,
          productName: i.productName,
          variantName: i.variantName,
          sku: i.sku,
          unitPrice: i.unitPrice,
          quantity: i.quantity,
        })),
        isReturn: true,
        originalTransactionId: input.originalTransactionId,
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
      await client.query(
        `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload)
         VALUES ($1, $2, $3, 'return_processed', $4, $5)`,
        [
          randomUUID(), returnTransactionId, context.employee.id,
          `Return processed by ${context.employee.displayName}: ${input.items.length} item(s), -$${refundGrandTotal.toFixed(2)} via ${input.refundMethod}`,
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
          }),
        ],
      );

      // 4. Restore inventory (batched)
      if (input.items.length > 0) {
        const variantIds = input.items.map((i) => i.productVariantId);
        const quantities = input.items.map((i) => i.quantity);
        await client.query(
          `UPDATE inventory_levels il
           SET on_hand = il.on_hand + delta.qty, updated_at = now()
           FROM (SELECT unnest($1::uuid[]) as variant_id, unnest($2::int[]) as qty) AS delta
           WHERE il.product_variant_id = delta.variant_id AND il.location_id = $3`,
          [variantIds, quantities, context.location.id],
        );
      }

      // 5. Update register session
      await client.query(
        `UPDATE register_sessions SET last_transaction_id = $1, updated_at = now() WHERE id = $2`,
        [returnTransactionId, context.registerSession.id],
      );

      // 6. If refund is to store credit, update customer balance
      if (input.refundMethod === "store_credit") {
        // Find original transaction's customer
        const { rows: origRows } = await client.query(
          `SELECT customer_id FROM transactions WHERE id = $1`,
          [input.originalTransactionId],
        );
        const customerId = origRows[0]?.customer_id;
        if (customerId) {
          const { rows: balRows } = await client.query(
            `UPDATE customers SET store_credit_balance = store_credit_balance + $1, updated_at = now() WHERE id = $2 RETURNING store_credit_balance`,
            [refundGrandTotal, customerId],
          );
          await client.query(
            `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, transaction_id, reason)
             VALUES ($1, $2, $3, 'refund', $4, $5, $6, $7, $8)`,
            [
              randomUUID(), context.employee.organizationId, customerId,
              refundGrandTotal, balRows[0]?.store_credit_balance ?? 0,
              context.employee.id, returnTransactionId, input.reason,
            ],
          );
        }
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // Audit event — outside transaction so audit failure doesn't rollback the return
    try {
      await (await getPool()).query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'transaction', $5, 'return_processed', $6, now())`,
        [
          randomUUID(), context.employee.organizationId, context.location.id,
          context.employee.id, returnTransactionId,
          JSON.stringify({
            original_transaction_id: input.originalTransactionId,
            item_count: input.items.length,
            refund_grand_total: refundGrandTotal.toFixed(2),
            refund_method: input.refundMethod,
          }),
        ],
      );
    } catch (err) {
      console.error("[returnAction] audit event failed:", err);
    }

    revalidatePath("/register");
    return { returnTransactionId, refundTotal: refundGrandTotal, refundMethod: input.refundMethod };
  }

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
      notes: `Return processed by ${context.employee.displayName}: ${input.items.length} item(s), -$${refundGrandTotal.toFixed(2)} via ${input.refundMethod}`,
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
