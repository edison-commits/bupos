"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
import { requireRegisterPermission } from "@/lib/authz";
import { mutateStore } from "@/lib/persistence/store";
import { orgTx, orgQuery } from "@/lib/supabase-rest";
import type { Cart } from "@/lib/cart/types";
import { computeTotals } from "@/lib/cart/cart";
import { formatCurrency } from "@/lib/format";

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
  tenderType: string = "cash",
): Promise<{ layawayId: string }> {
  const context = await requireRegisterPermission("register.open");

  if (cart.status !== "open" || cart.items.length === 0) {
    throw new Error("Cart is empty or already checked out");
  }

  if (!cart.customerId) {
    throw new Error("A customer must be attached for layaway");
  }

  // R18-LOW-1: guard against NaN / Infinity / negative depositAmount.
  // TS-typed `number` at the server-action boundary isn't enough —
  // NaN/Infinity propagate through `>=` comparisons as false (NOT as
  // throws), and would land in `layaways.deposit_paid` / `balance_due`
  // as Postgres NUMERIC NaN. Subsequent `makeLayawayPaymentAction`
  // treats NaN balance as "unlimited due" and silently corrupts the
  // layaway row permanently.
  if (!Number.isFinite(depositAmount) || depositAmount < 0) {
    throw new Error("Invalid deposit amount");
  }

  // Reject cart line types that don't make sense for layaway. Bundles
  // are priced as a package at checkout — splitting their components
  // across a layaway payment schedule is ambiguous (which component is
  // "paid for" at 50% balance?). Free-with-purchase promo lines require
  // an actual purchase to trigger the redemption — putting one on
  // layaway would either burn the promo early (before the customer
  // pays) or never at all (broken accounting). Both are rare enough
  // that refusing them with a clear message is better than threading
  // bundle/redemption logic through the layaway flow.
  for (const item of cart.items) {
    if (item.bundleId) {
      throw new Error("Bundles can't be placed on layaway — remove the bundle line or check out normally");
    }
    if (item.promoCodeId) {
      throw new Error("Free-with-purchase promo items can't be layaway'd — they require a completed sale");
    }
  }

  // Override client-supplied tax rate with server-side location rate
  // (prevents tax evasion). Drops to 0 when the attached customer is
  // flagged tax_exempt, same as checkout-action.ts.
  let resolvedTaxRate = context.location?.taxRate ?? 0;

  // Verify the customer exists in the actor's org. Without this, a tampered
  // cart could attach a foreign tenant's customer UUID to a layaway —
  // subsequent layaway payments + potential refund-to-store-credit flows
  // would then cross-credit that customer's balance in the foreign org.
  if (isPg() && cart.customerId) {
    const { rows: custRows } = await orgQuery(
      context.employee.organizationId,
      `SELECT tax_exempt FROM customers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [cart.customerId, context.employee.organizationId],
    );
    if (custRows.length === 0) {
      throw new Error("Customer not found in this organization");
    }
    if (custRows[0].tax_exempt === true) resolvedTaxRate = 0;
  }
  cart.taxRate = resolvedTaxRate;

  // Server-side price verification — clients cannot tamper unitPrice.
  // Fetch the real variant prices and reject if any line deviates.
  if (isPg() && cart.items.length > 0) {
    const variantIds = cart.items.map((i) => i.productVariantId);
    const { rows: variantRows } = await orgQuery(
      context.employee.organizationId,
      `SELECT id, price FROM product_variants WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
      [variantIds, context.employee.organizationId],
    );
    const dbPriceByVariant: Record<string, number> = {};
    for (const row of variantRows as { id: string; price: string }[]) {
      dbPriceByVariant[row.id] = Number(row.price);
    }
    for (const item of cart.items) {
      const dbPrice = dbPriceByVariant[item.productVariantId];
      if (dbPrice === undefined) throw new Error("Unknown product variant in cart");
      if (Math.abs(item.unitPrice - dbPrice) > 0.005) {
        throw new Error("Price tampering detected — refresh the cart and try again");
      }
    }
  }

  // R36-H2 (client-trust): mirror checkout-action.ts's discount clamp.
  // A tampered `cart.discountAmount = -500` or `Infinity` would otherwise
  // inflate the grand total through computeTotals' fallback math, and a
  // percent > 100 would reduce it below zero. Clamp BEFORE totals so the
  // deposit-min (10% of grand total) matches what the cart eventually
  // materializes into a transaction at checkout-collection time.
  const rawLayawayDiscount = Number(cart.discountAmount) || 0;
  const clampedLayawayDiscount = Number.isFinite(rawLayawayDiscount)
    ? Math.max(0, rawLayawayDiscount)
    : 0;
  cart.discountAmount = cart.discountMode === "percent"
    ? Math.min(100, clampedLayawayDiscount)
    : clampedLayawayDiscount;

  const totals = computeTotals(cart);
  const minimumDeposit = Math.max(1, totals.grandTotal * 0.1); // 10% minimum deposit

  if (depositAmount < minimumDeposit - 0.005) {
    throw new Error(`Minimum deposit is ${formatCurrency(minimumDeposit)} (10% of total)`);
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
          // `discountMode` matters — without it a `discountAmount: 10` is
          // ambiguous between "$10 off" and "10% off" when the layaway
          // later materializes into a transaction.
          JSON.stringify({ items: cart.items, discountAmount: cart.discountAmount, discountMode: cart.discountMode, taxRate: cart.taxRate }),
          totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal,
          depositAmount, balanceDue, minimumDeposit,
          dueDate || null, notes || null,
        ],
      );

      // 2. Record the initial deposit payment with the actual tender type.
      // R38-A-F4: when the tender is `store_credit`, ACTUALLY DEBIT the
      // customer's balance. Prior shape wrote a `layaway_payments` row
      // but never touched `customers.store_credit_balance` and never
      // wrote a `store_credit_ledger` entry. A later
      // `cancelLayawayAction` with `disposition: "refund_cash"` then
      // paid out real cash for a "deposit" that was never consumed —
      // phantom-credit → cash conversion. Also reject tenders that
      // require a customer (store_credit, loyalty) when the cart has
      // no customer attached.
      if (depositAmount > 0) {
        if (tenderType === "store_credit") {
          if (!cart.customerId) {
            throw new Error("Store-credit deposit requires a customer attached to the cart");
          }
          const { rows: balRows } = await client.query(
            `SELECT store_credit_balance FROM customers
              WHERE id = $1 AND organization_id = $2 AND is_active = true FOR UPDATE`,
            [cart.customerId, context.employee.organizationId],
          );
          if (balRows.length === 0) {
            throw new Error("Customer not found or inactive");
          }
          const currentBalance = Number(balRows[0].store_credit_balance ?? 0);
          if (currentBalance < depositAmount - 0.005) {
            throw new Error(`Insufficient store credit balance (have ${currentBalance.toFixed(2)}, need ${depositAmount.toFixed(2)})`);
          }
          const newBalance = Number((currentBalance - depositAmount).toFixed(2));
          await client.query(
            `UPDATE customers SET store_credit_balance = $1, updated_at = now()
              WHERE id = $2 AND organization_id = $3`,
            [newBalance, cart.customerId, context.employee.organizationId],
          );
          await client.query(
            `INSERT INTO store_credit_ledger
               (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
             VALUES ($1, $2, $3, 'redemption', $4, $5, $6, 'Layaway deposit', now())`,
            [randomUUID(), context.employee.organizationId, cart.customerId, -depositAmount, newBalance, context.employee.id],
          );
        }
        await client.query(
          `INSERT INTO layaway_payments (id, layaway_id, tender_type, amount, employee_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), layawayId, tenderType, depositAmount, context.employee.id, JSON.stringify({ note: "Initial deposit" })],
        );
      }

      // 3. Reserve inventory — lock rows first, verify stock, then decrement atomically.
      //
      // R36-H1 (CRITICAL): aggregate per-variant BEFORE the DB round-trip.
      // Two cart lines with the same `productVariantId` (same SKU, different
      // modifiers — addItem keeps them separate by modifier signature) both
      // pointed at the same inventory_levels row. PostgreSQL's UPDATE…FROM
      // delta join silently APPLIED ONLY ONE of the matching delta rows,
      // dropping the second → oversell. The stock-check loop also compared
      // each line independently against the single available quantity, so
      // two lines of qty=1 against on_hand=1 both passed. Mirrors the
      // checkout-action.ts fix (see checkout-action.ts:662-704).
      //
      // Also adds GREATEST(0, ...) as defense in depth so a future race
      // that slips past the stock check can't leave on_hand negative.
      if (cart.items.length > 0) {
        const totalsByVariant = new Map<string, number>();
        for (const line of cart.items) {
          totalsByVariant.set(
            line.productVariantId,
            (totalsByVariant.get(line.productVariantId) ?? 0) + Number(line.quantity),
          );
        }
        const aggVariantIds = Array.from(totalsByVariant.keys());
        const aggQuantities = aggVariantIds.map((id) => totalsByVariant.get(id) ?? 0);
        // Lock and verify AGGREGATE stock
        const { rows: stockRows } = await client.query(
          `SELECT product_variant_id, on_hand FROM inventory_levels
           WHERE product_variant_id = ANY($1::uuid[]) AND location_id = $2 AND organization_id = $3
           ORDER BY product_variant_id FOR UPDATE`,
          [aggVariantIds, context.location.id, context.employee.organizationId],
        );
        const stockByVariant = new Map<string, number>(
          stockRows.map((r: { product_variant_id: string; on_hand: number }) => [r.product_variant_id, Number(r.on_hand)]),
        );
        for (const [variantId, aggQty] of totalsByVariant) {
          const available = stockByVariant.get(variantId) ?? 0;
          if (available < aggQty) {
            // Look up a display name from the cart — any line with this
            // variant id has the same productName.
            const firstLine = cart.items.find((i) => i.productVariantId === variantId);
            throw new Error(
              `Insufficient stock for ${firstLine?.productName || variantId} (have ${available}, need ${aggQty})`,
            );
          }
        }
        // Atomic decrement with GREATEST(0, ...) clamp.
        await client.query(
          `UPDATE inventory_levels il
           SET on_hand = GREATEST(0, il.on_hand - delta.qty), updated_at = now()
           FROM (SELECT unnest($1::uuid[]) as variant_id, unnest($2::int[]) as qty) AS delta
           WHERE il.product_variant_id = delta.variant_id AND il.location_id = $3 AND il.organization_id = $4`,
          [aggVariantIds, aggQuantities, context.location.id, context.employee.organizationId],
        );
      }

      // R49: audit INSIDE the tx. Layaway creates hold inventory
      // (decrements on_hand) AND records a deposit payment —
      // money-moving action that should not lose its audit row on
      // post-commit failure. Matches the canonical R44+ shape.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'layaway', $5, 'layaway_created', $6, now())`,
        [
          randomUUID(), context.employee.organizationId, context.location.id, context.employee.id, layawayId,
          JSON.stringify({
            customer_id: cart.customerId!,
            grand_total: totals.grandTotal.toFixed(2),
            deposit: depositAmount.toFixed(2),
            item_count: String(cart.items.length),
          }),
        ],
      );

      await client.query("COMMIT");
    } catch (e) {
      // R36-DI-2: guard the ROLLBACK — an already-aborted tx or dropped
      // connection would otherwise throw a db error that replaces the
      // original exception, masking the real cause in monitoring.
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
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
      notes: `Layaway created for ${cart.customerName ?? "customer"} — deposit ${formatCurrency(depositAmount)}`,
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
