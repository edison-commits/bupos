"use server";

import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import type { LayawayPayment } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";
import { randomUUID } from "@/lib/uuid";
import { orgTx } from "@/lib/supabase-rest";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";

import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
const isPg = () => !!process.env.USE_POSTGRES;

export async function makeLayawayPaymentAction(formData: FormData) {
  const layawayId = formData.get("layawayId") as string;
  const amount = Number(formData.get("amount"));
  const tenderType = formData.get("tenderType") as string;

  if (!layawayId || !Number.isFinite(amount) || amount <= 0 || !tenderType) {
    throw new Error("Layaway ID, positive amount, and tender type are required");
  }

  // R36-H1 (authz): `catalog.manage` is ALSO held by `inventory_clerk`
  // (see src/lib/domain/permissions.ts:55) — but an inventory clerk
  // should never be processing money. Previously a stolen/elevated
  // clerk session could POST any layawayId + amount + tenderType and
  // silently mark balance as paid without cash ever hitting the drawer.
  // Tighten to owner/manager, mirroring the forfeit_with_approval
  // gate in `cancelLayawayAction` below and the money-safe defaults on
  // `closeShiftAction` and refund endpoints.
  const ctx = await requireAdminPermission("catalog.manage");
  if (ctx.employee.roleKey !== "owner" && ctx.employee.roleKey !== "manager") {
    throw new Error("Layaway payment processing requires manager authority");
  }

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      const { rows: lay } = await client.query(
        `SELECT id, status, balance_due FROM layaways WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [layawayId, orgId],
      );
      if (lay.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Layaway not found");
      }
      const layaway = lay[0];
      if (layaway.status !== "active" && layaway.status !== "partially_paid") {
        await client.query("ROLLBACK");
        throw new Error(`Cannot make payment on ${layaway.status} layaway`);
      }
      const balanceDue = Number(layaway.balance_due);
      if (amount > balanceDue + 0.005) {
        await client.query("ROLLBACK");
        throw new Error("Payment exceeds balance due");
      }

      const paymentId = randomUUID();
      await client.query(
        `INSERT INTO layaway_payments (id, layaway_id, tender_type, amount, employee_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [paymentId, layawayId, tenderType, amount, ctx.employee.id, "{}"],
      );

      // R42-P: cash layaway payments must record a pay_in on the open
      // shift so shift-close's expectedCash formula sees the inflow.
      // Prior shape silently left cash layaways invisible to the
      // drawer-reconciliation math — the cashier's actual count came
      // in $N "over" expected every time, burning trust in the system.
      // If no open shift exists at the layaway's location, the cash
      // can't legitimately be in a drawer; reject the payment (mirrors
      // the cash-refund pattern in return-action).
      if (tenderType === "cash") {
        const { rows: layRows } = await client.query(
          `SELECT location_id FROM layaways WHERE id = $1 AND organization_id = $2`,
          [layawayId, orgId],
        );
        const loc = layRows[0]?.location_id as string | undefined;
        if (!loc) {
          await client.query("ROLLBACK");
          throw new Error("Layaway missing location");
        }
        const { rows: shiftRows } = await client.query(
          `SELECT id FROM shifts
            WHERE organization_id = $1 AND location_id = $2 AND status = 'open'
            ORDER BY opened_at DESC LIMIT 1`,
          [orgId, loc],
        );
        if (shiftRows.length === 0) {
          await client.query("ROLLBACK");
          throw new Error("Cash layaway payment requires an open shift at the layaway location");
        }
        // R43-C2: literal must be `'pay_in'` (the CHECK constraint on
        // pay_in_outs.direction at migration 001:351 is `IN ('pay_in',
        // 'pay_out')`). The shorter `'in'` form R42-P shipped with
        // violated SQLSTATE 23514 and bricked every cash layaway
        // payment. Regression test at r42-findings.test.ts encoded the
        // broken literal too — updated alongside this fix.
        await client.query(
          `INSERT INTO pay_in_outs (id, organization_id, shift_id, location_id, employee_id, direction, amount, reason, note, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pay_in', $5, $6, $7, now())`,
          [orgId, shiftRows[0].id, loc, ctx.employee.id, amount, "layaway_payment", `Layaway ${layawayId} cash payment`],
        );
      }

      const newBalance = Number((balanceDue - amount).toFixed(2));
      const newStatus = newBalance <= 0.005 ? "paid_in_full" : "partially_paid";
      await client.query(
        `UPDATE layaways
           SET deposit_paid = deposit_paid + $1,
               balance_due = $2,
               status = $3,
               updated_at = NOW()
         WHERE id = $4 AND organization_id = $5`,
        [amount, newBalance, newStatus, layawayId, orgId],
      );
      await client.query("COMMIT");

      await waitUntilOrAwait(pgInsertAuditEvent(
        orgId, null, ctx.employee.id,
        "layaway", layawayId, "layaway_payment",
        { payment_id: paymentId, amount, new_balance: newBalance, tender_type: tenderType },
      ).catch((err) => console.error("[makeLayawayPaymentAction] audit failed:", safeErr(err))));
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      const layaway = store.layaways.find((l) => l.id === layawayId);
      if (!layaway) throw new Error("Layaway not found");
      if (layaway.status !== "active" && layaway.status !== "partially_paid") {
        throw new Error(`Cannot make payment on ${layaway.status} layaway`);
      }
      if (amount > layaway.balanceDue) {
        throw new Error("Payment exceeds balance due");
      }

      const now = new Date().toISOString();
      const payment: LayawayPayment = {
        id: crypto.randomUUID(),
        layawayId,
        tenderType: tenderType as LayawayPayment["tenderType"],
        amount,
        employeeId: ctx.employee.id,
        metadata: {},
        createdAt: now,
      };
      layaway.depositPaid += amount;
      layaway.balanceDue -= amount;
      layaway.status = layaway.balanceDue <= 0 ? "paid_in_full" : "partially_paid";
      layaway.updatedAt = now;
      store.layawayPayments.push(payment);
    });
  }

  revalidatePath("/admin");
}

// R10-M-1 → R11-M-1 closed: layaway cancel now takes a required
// `disposition` arg and atomically routes the deposit to the matching
// ledger. Previously the deposit was silently retained with only a
// `retained_deposit` note in the audit payload, leaving ops to
// reconcile manually.
export type LayawayCancelDisposition =
  | "refund_cash"            // → pay_in_outs (pay_out) tied to an open shift at the layaway's location
  | "refund_store_credit"    // → store_credit_ledger credit on the layaway's customer
  | "forfeit_with_approval"; // → owner-only; audit payload records the forfeit reason

export async function cancelLayawayAction(
  layawayId: string,
  reason: string,
  disposition: LayawayCancelDisposition,
) {
  const ctx = await requireAdminPermission("catalog.manage");
  if (!ctx) throw new Error("Not authenticated");

  // `forfeit_with_approval` mints no refund — the shop keeps the
  // customer's deposit. Restrict to owner so a compromised manager
  // session can't quietly pocket deposits without approval trail.
  if (disposition === "forfeit_with_approval" && ctx.employee.roleKey !== "owner") {
    throw new Error("Forfeiting a layaway deposit requires owner role");
  }

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      // R32-H7: serialize concurrent cancels on the same layaway.
      // FOR UPDATE below locks the row, but a classic TOCTOU with a
      // separate `customers FOR UPDATE` on the same customer (from
      // a DIFFERENT layaway cancel) would previously pass both
      // layaway-status guards and both INSERT refund ledger rows +
      // bump store_credit_balance TWICE. The advisory lock below
      // forces strict serialization per layaway id regardless of
      // which customer path each one takes. Mirrors the R30-C5 +
      // R31-H5 refund-path lock.
      await client.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [`layaway-cancel:${layawayId}`],
      );
      const { rows: lay } = await client.query(
        `SELECT id, status, location_id, cart_snapshot, deposit_paid, customer_id
         FROM layaways WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [layawayId, orgId],
      );
      if (lay.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Layaway not found");
      }
      const layaway = lay[0];
      if (layaway.status !== "active" && layaway.status !== "partially_paid") {
        await client.query("ROLLBACK");
        throw new Error(`Cannot cancel ${layaway.status} layaway`);
      }

      const depositPaid = Number(layaway.deposit_paid ?? 0);

      // Disposition routing — all inserts are in the SAME transaction as
      // the status flip, so partial states are impossible.
      if (disposition === "refund_cash" && depositPaid > 0) {
        // Need an open shift at the layaway's location to debit the drawer.
        // R33-H11: FOR UPDATE the picked shift row so a concurrent
        // shift-close race can't compute variance before our pay_out
        // lands. Also SKIP LOCKED so if THIS shift is being closed
        // right now, we move to the next-most-recent open shift (or
        // fail loudly rather than deadlock).
        const { rows: shiftRows } = await client.query(
          `SELECT id FROM shifts
            WHERE organization_id = $1 AND location_id = $2 AND status = 'open'
            ORDER BY opened_at DESC LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          [orgId, layaway.location_id],
        );
        if (shiftRows.length === 0) {
          await client.query("ROLLBACK");
          throw new Error("Cannot refund cash: no open shift at the layaway's location");
        }
        const shiftId = shiftRows[0].id;
        await client.query(
          `INSERT INTO pay_in_outs
             (shift_id, location_id, employee_id, direction, amount, reason, note, organization_id)
           VALUES ($1, $2, $3, 'pay_out', $4, 'layaway_refund', $5, $6)`,
          [shiftId, layaway.location_id, ctx.employee.id, depositPaid, reason || "Layaway cancelled — cash refund", orgId],
        );
      } else if (disposition === "refund_store_credit" && depositPaid > 0) {
        if (!layaway.customer_id) {
          await client.query("ROLLBACK");
          throw new Error("Cannot refund to store credit: layaway has no customer attached");
        }
        // R21-M-1: previously the `SELECT ... FROM customers` could
        // return zero rows (if the customer row was deleted between
        // layaway creation and cancellation), and we'd silently proceed
        // with `prevBalance = 0` → INSERT a store_credit_ledger row
        // pointing at a dangling customer_id. The subsequent UPDATE
        // matched zero rows. Result: ledger entry exists claiming a
        // refund was issued, but the customer has nothing to redeem.
        // Now we bail out loudly and push the operator toward
        // `refund_cash` instead.
        const { rows: balRows } = await client.query(
          `SELECT COALESCE(store_credit_balance, 0) AS balance FROM customers
            WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [layaway.customer_id, orgId],
        );
        if (balRows.length === 0) {
          await client.query("ROLLBACK");
          throw new Error(
            "Cannot refund to store credit: the layaway's customer has been removed. Use refund_cash instead, or restore the customer record first.",
          );
        }
        const prevBalance = Number(balRows[0].balance ?? 0);
        const newBalance = Number((prevBalance + depositPaid).toFixed(2));
        await client.query(
          `INSERT INTO store_credit_ledger
             (organization_id, customer_id, transaction_type, amount, balance_after, employee_id, reason)
           VALUES ($1, $2, 'refund', $3, $4, $5, $6)`,
          [orgId, layaway.customer_id, depositPaid, newBalance, ctx.employee.id, reason || "Layaway cancelled — store credit refund"],
        );
        const upd = await client.query(
          `UPDATE customers SET store_credit_balance = $1, updated_at = NOW()
            WHERE id = $2 AND organization_id = $3`,
          [newBalance, layaway.customer_id, orgId],
        );
        // Defensive invariant — the FOR UPDATE row lock above should
        // guarantee the row still exists here, but a concurrent DELETE
        // on a non-locked connection would otherwise leave this silent.
        if ((upd.rowCount ?? 0) === 0) {
          await client.query("ROLLBACK");
          throw new Error(
            "Customer row disappeared mid-transaction; refund aborted. Retry the cancel with disposition=refund_cash.",
          );
        }
      }
      // `forfeit_with_approval` — no ledger write; deposit stays with the shop.

      await client.query(
        `UPDATE layaways
           SET status = 'cancelled',
               cancelled_by = $1,
               cancelled_at = NOW(),
               cancellation_reason = $2,
               updated_at = NOW()
         WHERE id = $3 AND organization_id = $4`,
        [ctx.employee.id, reason || "Manager cancelled", layawayId, orgId],
      );

      // Restore reserved inventory — createLayawayAction decremented on_hand to
      // reserve stock. Cancelling without restoring permanently destroys
      // inventory equal to the line quantities.
      const snapshot = typeof layaway.cart_snapshot === "string"
        ? JSON.parse(layaway.cart_snapshot)
        : layaway.cart_snapshot;
      const items = (snapshot?.items ?? []) as Array<{ productVariantId?: string; variantId?: string; quantity: number }>;
      if (Array.isArray(items) && items.length > 0) {
        // Build aligned (variant_id, qty) pairs in one pass so the
        // unnest($1::uuid[], $2::int[]) positional join doesn't pair a
        // filtered variantIds[i] with an unfiltered quantities[i]. A cart
        // snapshot missing a variantId on any line would otherwise shift
        // subsequent quantities onto the wrong variant.
        const valid = items
          .map((i) => ({ vid: i.productVariantId ?? i.variantId ?? "", qty: Number(i.quantity) || 0 }))
          .filter((x) => x.vid && x.qty > 0);
        if (valid.length > 0) {
          const variantIds = valid.map((x) => x.vid);
          const quantities = valid.map((x) => x.qty);
          await client.query(
            `UPDATE inventory_levels il
             SET on_hand = il.on_hand + delta.qty, updated_at = NOW()
             FROM (SELECT unnest($1::uuid[]) AS variant_id, unnest($2::int[]) AS qty) AS delta
             WHERE il.product_variant_id = delta.variant_id AND il.location_id = $3 AND il.organization_id = $4`,
            [variantIds, quantities, layaway.location_id, orgId],
          );
        }
      }

      // Audit INSIDE the transaction so the cancelled layaway + refund
      // ledger entry + audit trail either ALL commit or NONE.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'layaway', $4, 'layaway_cancelled', $5, NOW())`,
        [
          orgId, layaway.location_id, ctx.employee.id, layawayId,
          JSON.stringify({
            reason: reason || "Manager cancelled",
            deposit_paid: depositPaid.toFixed(2),
            customer_id: layaway.customer_id ?? null,
            disposition,
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      const layaway = store.layaways.find((l) => l.id === layawayId);
      if (!layaway) throw new Error("Layaway not found");
      if (layaway.status !== "active" && layaway.status !== "partially_paid") {
        throw new Error(`Cannot cancel ${layaway.status} layaway`);
      }

      const now = new Date().toISOString();
      layaway.status = "cancelled";
      layaway.cancelledBy = ctx.employee.id;
      layaway.cancelledAt = now;
      layaway.cancellationReason = reason || "Manager cancelled";
      layaway.updatedAt = now;

      // Restore reserved inventory (JSON fallback — mirror PG path).
      const items = (layaway.cartSnapshot?.items ?? []) as Array<{ productVariantId: string; quantity: number }>;
      for (const item of items) {
        const inv = store.inventory.find(
          (i) => i.productVariantId === item.productVariantId && i.locationId === layaway.locationId,
        );
        if (inv) {
          inv.onHand += Number(item.quantity) || 0;
          inv.updatedAt = now;
        }
      }
    });
  }

  revalidatePath("/admin");
}

export async function collectLayawayAction(layawayId: string) {
  const ctx = await requireAdminPermission("catalog.manage");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      const { rows } = await client.query(
        `UPDATE layaways
           SET status = 'collected', updated_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND status = 'paid_in_full'
         RETURNING id`,
        [layawayId, orgId],
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Layaway must be paid in full before collection");
      }
      await client.query("COMMIT");
      await waitUntilOrAwait(pgInsertAuditEvent(
        orgId, null, ctx.employee.id,
        "layaway", layawayId, "layaway_collected",
        {},
      ).catch((err) => console.error("[collectLayawayAction] audit failed:", safeErr(err))));
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      const layaway = store.layaways.find((l) => l.id === layawayId);
      if (!layaway) throw new Error("Layaway not found");
      if (layaway.status !== "paid_in_full") {
        throw new Error("Layaway must be paid in full before collection");
      }
      layaway.status = "collected";
      layaway.updatedAt = new Date().toISOString();
    });
  }

  revalidatePath("/admin");
}
