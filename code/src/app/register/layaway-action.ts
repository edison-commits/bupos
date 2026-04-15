"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
import { requireRegisterPermission } from "@/lib/authz";
import { mutateStore } from "@/lib/persistence/store";
import { orgTx, getPool } from "@/lib/supabase-rest";
import type { Cart } from "@/lib/cart/types";
import { computeTotals } from "@/lib/cart/cart";

const isPg = () => !!process.env.USE_POSTGRES;

/**
 * Create a layaway from the current cart.
 * Reserves inventory and creates a layaway record with an initial deposit.
 */
export async function createLayawayAction(
  cart: Cart,
  depositAmount: number,
  dueDate: string | undefined,
  notes: string | undefined,
): Promise<{ layawayId: string }> {
  const context = await requireRegisterPermission("register.open");

  if (cart.status !== "open" || cart.items.length === 0) {
    throw new Error("Cart is empty or already checked out");
  }

  if (!cart.customerId) {
    throw new Error("A customer must be attached for layaway");
  }

  const totals = computeTotals(cart);
  const minimumDeposit = Math.max(1, totals.grandTotal * 0.1); // 10% minimum deposit

  if (depositAmount < minimumDeposit - 0.005) {
    throw new Error(`Minimum deposit is $${minimumDeposit.toFixed(2)} (10% of total)`);
  }

  if (depositAmount > totals.grandTotal) {
    throw new Error("Deposit cannot exceed total");
  }

  const layawayId = randomUUID();

  if (isPg()) {
    const client = await orgTx(context.employee.organizationId);
    try {
      const status = depositAmount >= totals.grandTotal - 0.005
        ? "paid_in_full"
        : depositAmount > 0 ? "partially_paid" : "active";
      const balanceDue = Number((totals.grandTotal - depositAmount).toFixed(2));

      // 1. Create layaway record
      await client.query(
        `INSERT INTO layaways (id, organization_id, location_id, customer_id, employee_id, status,
         cart_snapshot, subtotal, discount_total, tax_total, grand_total,
         deposit_paid, balance_due, minimum_deposit, due_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          layawayId, context.employee.organizationId, context.location.id,
          cart.customerId!, context.employee.id, status,
          JSON.stringify({ items: cart.items, discountAmount: cart.discountAmount, taxRate: cart.taxRate }),
          totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal,
          depositAmount, balanceDue, minimumDeposit,
          dueDate || null, notes || null,
        ],
      );

      // 2. Record the initial deposit payment
      if (depositAmount > 0) {
        await client.query(
          `INSERT INTO layaway_payments (id, layaway_id, tender_type, amount, employee_id, metadata)
           VALUES ($1, $2, 'cash', $3, $4, $5)`,
          [randomUUID(), layawayId, depositAmount, context.employee.id, JSON.stringify({ note: "Initial deposit" })],
        );
      }

      // 3. Reserve inventory (decrement on_hand, batched)
      if (cart.items.length > 0) {
        const variantIds = cart.items.map((i) => i.productVariantId);
        const quantities = cart.items.map((i) => -i.quantity);
        await client.query(
          `UPDATE inventory_levels il
           SET on_hand = GREATEST(0, il.on_hand + delta.qty), updated_at = now()
           FROM (SELECT unnest($1::uuid[]) as variant_id, unnest($2::int[]) as qty) AS delta
           WHERE il.product_variant_id = delta.variant_id AND il.location_id = $3`,
          [variantIds, quantities, context.location.id],
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // Audit event — outside transaction so audit failure doesn't rollback the layaway
    try {
      await (await getPool()).query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'layaway', $5, 'layaway_created', $6, now())`,
        [
          randomUUID(), context.employee.organizationId, context.location.id,
          context.employee.id, layawayId,
          JSON.stringify({
            customer_id: cart.customerId!,
            grand_total: totals.grandTotal.toFixed(2),
            deposit: depositAmount.toFixed(2),
            item_count: String(cart.items.length),
          }),
        ],
      );
    } catch (err) {
      console.error("[layawayAction] audit event failed:", err);
    }

    revalidatePath("/register");
    return { layawayId };
  }

  await mutateStore((store) => {
    const timestamp = new Date().toISOString();

    // Create layaway record
    store.layaways.unshift({
      id: layawayId,
      organizationId: context.employee.organizationId,
      locationId: context.location.id,
      customerId: cart.customerId!,
      employeeId: context.employee.id,
      status: depositAmount >= totals.grandTotal - 0.005 ? "paid_in_full" : depositAmount > 0 ? "partially_paid" : "active",
      cartSnapshot: {
        items: cart.items,
        discountAmount: cart.discountAmount,
        taxRate: cart.taxRate,
      },
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      depositPaid: depositAmount,
      balanceDue: Number((totals.grandTotal - depositAmount).toFixed(2)),
      minimumDeposit,
      dueDate,
      notes,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // Record the initial deposit payment
    if (depositAmount > 0) {
      store.layawayPayments.push({
        id: randomUUID(),
        layawayId,
        tenderType: "cash",
        amount: depositAmount,
        employeeId: context.employee.id,
        metadata: { note: "Initial deposit" },
        createdAt: timestamp,
      });
    }

    // Reserve inventory (decrement on_hand, leaving it reserved conceptually)
    for (const item of cart.items) {
      const inv = store.inventory.find(
        (i) => i.productVariantId === item.productVariantId && i.locationId === context.location.id,
      );
      if (inv) {
        inv.onHand = Math.max(0, inv.onHand - item.quantity);
        inv.updatedAt = timestamp;
      }
    }

    // Log event
    store.transactionEventPlaceholders.unshift({
      id: randomUUID(),
      transactionId: layawayId,
      eventKind: "layaway_created",
      actorEmployeeId: context.employee.id,
      notes: `Layaway created for ${cart.customerName ?? "customer"} — deposit $${depositAmount.toFixed(2)}`,
      payload: {
        location_id: context.location.id,
        customer_id: cart.customerId!,
        grand_total: totals.grandTotal.toFixed(2),
        deposit: depositAmount.toFixed(2),
        item_count: String(cart.items.length),
      },
      createdAt: timestamp,
    });
  });

  revalidatePath("/register");
  return { layawayId };
}
