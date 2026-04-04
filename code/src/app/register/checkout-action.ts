"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRegisterPermission } from "@/lib/authz";
import { mutateStore } from "@/lib/persistence/store";
import pool, { orgTx, orgQuery } from "@/lib/db";
import type { Cart, CheckoutResult, TenderLine } from "@/lib/cart/types";
import { computeTotals, checkOutCart } from "@/lib/cart/cart";
import { registerConfiguration } from "@/lib/data/mock-data";

const isPg = () => !!process.env.USE_POSTGRES;

/**
 * Complete a checkout with one or more tender lines.
 * Each tender line is persisted as a normalized transaction_tenders record.
 * Change is calculated from the cash portion only.
 *
 * @param approvedExceptions - list of exception codes that have been approved by a manager
 */
export async function checkoutAction(
  cart: Cart,
  tenders: TenderLine[],
  approvedExceptions: string[] = [],
): Promise<CheckoutResult> {
  const context = await requireRegisterPermission("register.open");

  if (cart.items.length === 0) {
    redirect("/register?error=Cart+is+empty");
  }

  if (tenders.length === 0) {
    redirect("/register?error=No+payment+method+provided");
  }

  // ── Bug 1 fix: lock register session row before checking status to prevent
  //    double-submit race. Two concurrent checkout calls must not both succeed.
  if (isPg()) {
    const lockClient = await orgTx(context.employee.organizationId);
    try {
      const { rows: locked } = await lockClient.query(
        `SELECT id, status FROM register_sessions WHERE id = $1 FOR UPDATE`,
        [context.registerSession.id],
      );
      if (locked.length === 0 || locked[0].status !== "active") {
        await lockClient.query("ROLLBACK");
        redirect("/register?error=Cart+already+checked+out");
      }
      await lockClient.query("COMMIT");
    } finally {
      lockClient.release();
    }
  } else {
    // JSON fallback: coarse check only (no row lock available)
    if (cart.status !== "open") {
      redirect("/register?error=Cart+already+checked+out");
    }
  }

  const totals = computeTotals(cart);
  const thresholds = registerConfiguration.approvalThresholds;

  // Look up pending exceptions for threshold enforcement (discount / store credit).
  // Price-integrity verification (DB price vs cart unitPrice / overridePrice)
  // is done inside the isPg() block below using the same exception query to avoid
  // an extra round-trip.
  let pendingExceptions: string[] = [];
  if (isPg()) {
    const variantIds = cart.items.map((i) => i.productVariantId);

    // Fetch variant prices and pending exceptions in a single query batch
    const [{ rows: variantRows }, { rows: excRows }] = await Promise.all([
      orgQuery(
        context.employee.organizationId,
        `SELECT id, price FROM product_variants WHERE id = ANY($1::uuid[])`,
        [variantIds],
      ),
      orgQuery(
        context.employee.organizationId,
        `SELECT exception_code FROM register_session_exceptions
         WHERE register_session_id = $1 AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > now())`,
        [context.registerSession.id],
      ),
    ]);

    pendingExceptions = excRows.map((r: { exception_code: string }) => r.exception_code);

    // ── Price-integrity: the server MUST NOT trust unitPrice or overridePrice
    //    supplied by the client cart. Compare against DB canonical prices and require
    //    a manager-approved price_override exception for any override that changes
    //    the price. This closes the cart-price-manipulation attack surface.
    const dbPriceByVariant: Record<string, number> = {};
    for (const row of variantRows) {
      dbPriceByVariant[row.id] = Number(row.price);
    }

    for (const item of cart.items) {
      const dbPrice = dbPriceByVariant[item.productVariantId];
      if (dbPrice === undefined) {
        redirect(`/register?error=Unknown+product+variant`);
      }
      if (item.unitPrice !== dbPrice) {
        redirect(`/register?error=Price+tampering+detected`);
      }
      if (item.overridePrice !== undefined && item.overridePrice !== dbPrice) {
        if (!pendingExceptions.includes("price_override")) {
          redirect(`/register?error=Price+override+requires+manager+approval`);
        }
      }
    }
  }

  // Server-side approval enforcement — compute effective cart discount for threshold check
  const cartDiscountEffective = cart.discountMode === 'percent'
    ? Number((totals.subtotal * Math.min(100, cart.discountAmount) / 100).toFixed(2))
    : cart.discountAmount;
  if (cartDiscountEffective > thresholds.discountOver && !pendingExceptions.includes("discount_threshold")) {
    redirect("/register?error=Discount+exceeds+threshold+without+manager+approval");
  }
  const storeCreditTendered = tenders.filter((t) => t.type === "store_credit").reduce((s, t) => s + t.amount, 0);
  if (storeCreditTendered > thresholds.storeCreditIssuanceOver && !pendingExceptions.includes("store_credit_threshold")) {
    redirect("/register?error=Store+credit+exceeds+threshold+without+manager+approval");
  }
  const totalTendered = tenders.reduce((sum, t) => sum + t.amount, 0);

  // Lower bound: must cover the total (within half-cent tolerance for float drift)
  if (totalTendered < totals.grandTotal - 0.005) {
    redirect("/register?error=Insufficient+tender+amount");
  }
  // Upper bound: reject absurd over-tendering (e.g. $10k cash on a $20 transaction).
  // Allow up to 10× the total as the sane ceiling — change will be given back.
  if (totalTendered > totals.grandTotal * 10) {
    redirect("/register?error=Tender+amount+exceeds+reasonable+limit");
  }

  // Change due comes only from cash overage
  const cashTendered = tenders.filter((t) => t.type === "cash").reduce((sum, t) => sum + t.amount, 0);
  const nonCashTendered = tenders.filter((t) => t.type !== "cash" && t.type !== "loyalty").reduce((sum, t) => sum + t.amount, 0);
  const loyaltyTendered = tenders.filter((t) => t.type === "loyalty").reduce((sum, t) => sum + t.amount, 0);
  const giftCardTendered = tenders.filter((t) => t.type === "gift_card").reduce((sum, t) => sum + t.amount, 0);
  const storeCreditTenderedTotal = tenders.filter((t) => t.type === "store_credit").reduce((sum, t) => sum + t.amount, 0);
  const cashPortion = Math.max(0, totals.grandTotal - nonCashTendered - loyaltyTendered);
  const changeDue = cashTendered > cashPortion ? Number((cashTendered - cashPortion).toFixed(2)) : 0;

  // Loyalty calculations
  const loyaltyConfig = registerConfiguration.loyalty;
  // Earning: round-then-floor pattern cancels binary float drift
  // (e.g. 10.00*0.1 = 0.9999999 → round=1 → floor=1 → 1 point).
  // Because Math.round on an integer is a no-op, this is equivalent to Math.round
  // for all non-float-drifted values (2.4→2, 2.6→3, 2.5→3). Result is always integer.
  const loyaltyPointsEarned = cart.customerId
    ? Math.floor(Math.round(totals.grandTotal * loyaltyConfig.earnRatePerDollar))
    : 0;
  // Redemption: simple rounding (partial points not allowed — round to nearest whole point).
  // NOTE: redemption uses plain Math.round while earning uses Math.floor(Math.round(...)).
  // This means exactly-2.5-point redemptions round UP (to 3) while exactly-2.5-point
  // earnings round DOWN (to 2). This asymmetry is not documented anywhere.
  const loyaltyPointsRedeemed = loyaltyTendered > 0 && cart.customerId
    ? Math.round(loyaltyTendered / loyaltyConfig.redemptionValuePerPoint)
    : 0;

  const transactionId = randomUUID();
  const primaryTenderType = tenders.length === 1 ? tenders[0].type : "split";

  if (isPg()) {
    const client = await orgTx(context.employee.organizationId);
    try {

      // 1. Transaction record
      await client.query(
        `INSERT INTO transactions (id, organization_id, location_id, register_session_id, employee_id, cart_snapshot, subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered, change_due, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'completed')`,
        [
          transactionId, context.employee.organizationId, context.location.id,
          context.registerSession.id, context.employee.id,
          JSON.stringify(checkOutCart(cart)),
          totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal,
          primaryTenderType, totalTendered, changeDue,
        ],
      );

      // 2. Normalized tender lines — one row per tender
      for (const tender of tenders) {
        const isLastCash = tender.type === "cash" && tender === tenders.filter((t) => t.type === "cash").at(-1);
        await client.query(
          `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            randomUUID(), transactionId, tender.type, tender.amount,
            JSON.stringify(isLastCash ? { change_due: changeDue.toFixed(2) } : {}),
          ],
        );
      }

      // 3. Completion event
      await client.query(
        `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload)
         VALUES ($1, $2, $3, 'transaction_placeholder', $4, $5)`,
        [
          randomUUID(), transactionId, context.employee.id,
          `Checkout completed by ${context.employee.displayName}`,
          JSON.stringify({
            location_id: context.location.id,
            register_session_id: context.registerSession.id,
            item_count: totals.itemCount,
            grand_total: totals.grandTotal.toFixed(2),
            tender_count: tenders.length,
            primary_tender_type: primaryTenderType,
            change_due: changeDue.toFixed(2),
          }),
        ],
      );

      // 4. Decrement inventory (batched) — with row lock + stock check to prevent oversell
      if (cart.items.length > 0) {
        const variantIds = cart.items.map((i) => i.productVariantId);
        const quantities = cart.items.map((i) => -i.quantity);

        // Lock rows in product_variant order to avoid deadlocks
        const { rows: locked } = await client.query(
          `SELECT il.product_variant_id, il.on_hand
           FROM inventory_levels il
           WHERE il.product_variant_id = ANY($1::uuid[]) AND il.location_id = $2
           ORDER BY il.product_variant_id
           FOR UPDATE`,
          [variantIds, context.location.id],
        );

        const onHandByVariant: Record<string, number> = {};
        for (const row of locked) {
          onHandByVariant[row.product_variant_id] = Number(row.on_hand);
        }

        // Check stock before applying any deltas — fail fast with a clear message
        for (const item of cart.items) {
          const onHand = onHandByVariant[item.productVariantId] ?? 0;
          if (onHand < item.quantity) {
            // Fetch SKU for the error message
            const { rows: skuRows } = await client.query(
              `SELECT sku FROM product_variants WHERE id = $1`,
              [item.productVariantId],
            );
            const sku = skuRows[0]?.sku ?? item.productVariantId;
            await client.query("ROLLBACK");
            redirect(`/register?error=Insufficient+inventory+for+SKU+${sku}`);
          }
        }

        await client.query(
          `UPDATE inventory_levels il
           SET on_hand = GREATEST(0, il.on_hand + delta.qty), updated_at = now()
           FROM (SELECT unnest($1::uuid[]) as variant_id, unnest($2::int[]) as qty) AS delta
           WHERE il.product_variant_id = delta.variant_id AND il.location_id = $3`,
          [variantIds, quantities, context.location.id],
        );
      }

      // 5. Update register session
      await client.query(
        `UPDATE register_sessions SET last_transaction_id = $1, last_cart_id = $2, updated_at = now() WHERE id = $3`,
        [transactionId, cart.id, context.registerSession.id],
      );

      // 6. Audit event — fire-and-forget (uses tx client, non-fatal)
      client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'transaction', $5, 'transaction_completed', $6, now())`,
        [
          randomUUID(), context.employee.organizationId, context.location.id,
          context.employee.id, transactionId,
          JSON.stringify({
            register_session_id: context.registerSession.id,
            item_count: totals.itemCount,
            grand_total: totals.grandTotal.toFixed(2),
            tender_count: tenders.length,
            primary_tender_type: primaryTenderType,
          }),
        ],
      ).catch((err) => console.error("[checkoutAction] audit event failed:", err));

      // 7. Update customer loyalty, spend, visits — lock row first to prevent double-awarding
      // if two concurrent checkouts award points for the same customer (e.g. same
      // offline+online txn syncing, or a retry). Step 7b (store credit) also locks this
      // row; Postgres queues the locks so both updates are serialised correctly.
      if (cart.customerId) {
        await client.query(
          `SELECT id FROM customers WHERE id = $1 FOR UPDATE`,
          [cart.customerId],
        );
        await client.query(
          `UPDATE customers SET
            loyalty_points = GREATEST(0, loyalty_points - $1 + $2),
            total_spend = total_spend + $3,
            visit_count = visit_count + 1,
            updated_at = now()
          WHERE id = $4`,
          [loyaltyPointsRedeemed, loyaltyPointsEarned, totals.grandTotal, cart.customerId],
        );

        // 7b. Deduct store credit if used — verify sufficient balance before deducting
        if (storeCreditTenderedTotal > 0) {
          const { rows: balRows } = await client.query(
            `SELECT store_credit_balance FROM customers WHERE id = $1 FOR UPDATE`,
            [cart.customerId],
          );
          const currentBalance = Number(balRows[0]?.store_credit_balance ?? 0);
          if (currentBalance < storeCreditTenderedTotal) {
            await client.query('ROLLBACK');
            redirect(`/register?error=Insufficient+store+credit+balance`);
          }
          const newBalance = currentBalance - storeCreditTenderedTotal;
          await client.query(
            `UPDATE customers SET store_credit_balance = $1, updated_at = now() WHERE id = $2`,
            [newBalance, cart.customerId],
          );
          await client.query(
            `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, transaction_id, reason, created_at)
             VALUES ($1, $2, $3, 'redemption', $4, $5, $6, $7, 'Checkout redemption', now())`,
            [randomUUID(), context.employee.organizationId, cart.customerId, -storeCreditTenderedTotal, newBalance, context.employee.id, transactionId],
          );
        }
      }

      // 8. Deduct gift card balance if used — with balance check to prevent over-redemption
      if (giftCardTendered > 0) {
        for (const tender of tenders) {
          if (tender.type !== "gift_card" || !tender.metadata?.gift_card_id) continue;
          // Lock row and verify sufficient balance before deducting
          const { rows: gcRows } = await client.query(
            `SELECT balance, status FROM gift_cards WHERE id = $1 FOR UPDATE`,
            [tender.metadata.gift_card_id],
          );
          const card = gcRows[0];
          if (!card || card.status !== 'active' || Number(card.balance) < tender.amount) {
            await client.query('ROLLBACK');
            redirect(`/register?error=Gift+card+insufficient+balance`);
          }
          const newBalance = Number(card.balance) - tender.amount;
          await client.query(
            `UPDATE gift_cards SET balance = $1, status = CASE WHEN $1 <= 0 THEN 'depleted' ELSE 'active' END, updated_at = now() WHERE id = $2`,
            [newBalance, tender.metadata.gift_card_id],
          );
          await client.query(
            `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, transaction_id, reason, created_at)
             VALUES ($1, $2, 'redemption', $3, $4, $5, $6, 'Checkout redemption', now())`,
            [randomUUID(), tender.metadata.gift_card_id, -tender.amount, newBalance, context.employee.id, transactionId],
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
  } else {
    await mutateStore((store) => {
      const timestamp = new Date().toISOString();

      // Normalized tender lines
      for (const tender of tenders) {
        const isLastCash = tender.type === "cash" && tender === tenders.filter((t) => t.type === "cash").at(-1);
        store.transactionTenderPlaceholders.unshift({
          id: randomUUID(), transactionId, tenderType: tender.type, amount: tender.amount,
          metadata: isLastCash ? { change_due: changeDue.toFixed(2) } : {},
        });
      }

      // Completion event
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(), transactionId,
        eventKind: "transaction_placeholder",
        actorEmployeeId: context.employee.id,
        notes: `Checkout completed by ${context.employee.displayName}`,
        payload: {
          location_id: context.location.id,
          register_session_id: context.registerSession.id,
          item_count: String(totals.itemCount),
          grand_total: totals.grandTotal.toFixed(2),
          tender_count: String(tenders.length),
          primary_tender_type: primaryTenderType,
          change_due: changeDue.toFixed(2),
          ...(cart.customerId ? {
            customer_id: cart.customerId,
            loyalty_earned: String(loyaltyPointsEarned),
            loyalty_redeemed: String(loyaltyPointsRedeemed),
          } : {}),
        },
        createdAt: timestamp,
      });

      // Decrement inventory
      for (const item of cart.items) {
        const inv = store.inventory.find(
          (i) => i.productVariantId === item.productVariantId && i.locationId === context.location.id,
        );
        if (inv) {
          inv.onHand = Math.max(0, inv.onHand - item.quantity);
          inv.updatedAt = timestamp;
        }
      }

      // Update register session
      const regSession = store.registerSessions.find((s) => s.id === context.registerSession.id);
      if (regSession) {
        regSession.lastTransactionId = transactionId;
        regSession.lastCartId = cart.id;
      }

      // Update customer loyalty points, spend, and visits
      if (cart.customerId) {
        const customer = store.customers.find((c) => c.id === cart.customerId);
        if (customer) {
          customer.loyaltyPoints = customer.loyaltyPoints - loyaltyPointsRedeemed + loyaltyPointsEarned;
          customer.totalSpend += totals.grandTotal;
          customer.visitCount += 1;
          customer.updatedAt = timestamp;

          // Deduct store credit balance if used
          if (storeCreditTenderedTotal > 0) {
            customer.storeCreditBalance = Math.max(0, customer.storeCreditBalance - storeCreditTenderedTotal);
            store.storeCreditLedger.unshift({
              id: randomUUID(),
              organizationId: context.employee.organizationId,
              customerId: cart.customerId,
              transactionType: "redemption",
              amount: -storeCreditTenderedTotal,
              balanceAfter: customer.storeCreditBalance,
              employeeId: context.employee.id,
              transactionId,
              reason: "Checkout redemption",
              createdAt: timestamp,
            });
          }
        }
      }

      // Deduct gift card balance if used
      if (giftCardTendered > 0) {
        for (const tender of tenders) {
          if (tender.type !== "gift_card" || !tender.metadata?.gift_card_id) continue;
          const gc = store.giftCards.find((g) => g.id === tender.metadata!.gift_card_id);
          if (gc) {
            gc.balance = Math.max(0, gc.balance - tender.amount);
            if (gc.balance <= 0) gc.status = "depleted";
            gc.updatedAt = timestamp;
            store.giftCardTransactions.unshift({
              id: randomUUID(),
              giftCardId: gc.id,
              transactionType: "redemption",
              amount: -tender.amount,
              balanceAfter: gc.balance,
              employeeId: context.employee.id,
              transactionId,
              reason: "Checkout redemption",
              createdAt: timestamp,
            });
          }
        }
      }
    });
  }

  revalidatePath("/register");
  return {
    transactionId,
    cartId: cart.id,
    grandTotal: totals.grandTotal,
    tenders,
    changeDue,
    loyaltyPointsEarned,
    loyaltyPointsRedeemed,
  };
}
