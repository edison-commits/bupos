"use server";

import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import { orgTx, orgQuery } from "@/lib/supabase-rest";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";
import type { GiftCard, GiftCardTransaction } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";
import { randomUUID } from "@/lib/uuid";

const isPg = () => !!process.env.USE_POSTGRES;

export async function activateGiftCardAction(formData: FormData) {
  const code = formData.get("code") as string;
  const amount = Number(formData.get("amount"));
  const customerId = (formData.get("customerId") as string) || undefined;

  if (!code || !amount || amount <= 0) {
    throw new Error("Code and positive amount are required");
  }

  const ctx = await requireAdminPermission("register.open");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;

    // Check duplicate
    const existing = await orgQuery(orgId, `SELECT id FROM gift_cards WHERE LOWER(code) = LOWER($1)`, [code]);
    if (existing.rows.length > 0) throw new Error(`Gift card code "${code}" already exists`);

    const client = await orgTx(orgId);
    try {
      const gcId = randomUUID();
      await client.query(
        `INSERT INTO gift_cards (id, organization_id, code, balance, initial_balance, status, customer_id, activated_by, activated_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, 'active', $5, $6, now(), now(), now())`,
        [gcId, orgId, code, amount, customerId || null, ctx.employee.id],
      );
      await client.query(
        `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
         VALUES ($1, $2, 'activation', $3, $3, $4, 'New gift card activated', now())`,
        [randomUUID(), gcId, amount, ctx.employee.id],
      );
      await client.query("COMMIT");
      // Audit event (non-fatal — committed regardless)
      pgInsertAuditEvent(
        orgId, null, ctx.employee.id,
        "gift_card", gcId, "gift_card_activated",
        { code: `****${code.slice(-4)}`, amount, customer_id: customerId || null },
      ).catch((err) => console.error("[activateGiftCardAction] audit failed:", err));
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      if (store.giftCards.some((gc) => gc.code === code)) {
        throw new Error(`Gift card code "${code}" already exists`);
      }
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const gc: GiftCard = {
        id, organizationId: store.organization.id, code, balance: amount,
        initialBalance: amount, status: "active", customerId,
        activatedBy: ctx.employee.id, activatedAt: now, createdAt: now, updatedAt: now,
      };
      const txn: GiftCardTransaction = {
        id: crypto.randomUUID(), giftCardId: id, transactionType: "activation",
        amount, balanceAfter: amount, employeeId: ctx.employee.id, createdAt: now,
      };
      store.giftCards.push(gc);
      store.giftCardTransactions.push(txn);
    });
  }

  revalidatePath("/admin");
}

export async function reloadGiftCardAction(formData: FormData) {
  const giftCardId = formData.get("giftCardId") as string;
  const amount = Number(formData.get("amount"));

  if (!giftCardId || !amount || amount <= 0) {
    throw new Error("Gift card ID and positive amount required");
  }

  const ctx = await requireAdminPermission("register.open");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      const gc = await client.query(`SELECT * FROM gift_cards WHERE id = $1 FOR UPDATE`, [giftCardId]);
      if (gc.rows.length === 0) { await client.query("ROLLBACK"); throw new Error("Gift card not found"); }
      const card = gc.rows[0];
      if (card.status === "disabled" || card.status === "expired") {
        await client.query("ROLLBACK");
        throw new Error(`Cannot reload ${card.status} gift card`);
      }
      const newBal = Number(card.balance) + amount;
      await client.query(
        `UPDATE gift_cards SET balance = $1, status = 'active', updated_at = now() WHERE id = $2`,
        [newBal, giftCardId],
      );
      await client.query(
        `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
         VALUES ($1, $2, 'reload', $3, $4, $5, 'Gift card reloaded', now())`,
        [randomUUID(), giftCardId, amount, newBal, ctx.employee.id],
      );
      await client.query("COMMIT");
      // Audit event (non-fatal — committed regardless)
      pgInsertAuditEvent(
        orgId, null, ctx.employee.id,
        "gift_card", giftCardId, "gift_card_reloaded",
        { amount, new_balance: newBal },
      ).catch((err) => console.error("[reloadGiftCardAction] audit failed:", err));
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      const gc = store.giftCards.find((g) => g.id === giftCardId);
      if (!gc) throw new Error("Gift card not found");
      if (gc.status === "disabled" || gc.status === "expired") {
        throw new Error(`Cannot reload ${gc.status} gift card`);
      }
      const now = new Date().toISOString();
      gc.balance += amount;
      gc.status = "active";
      gc.updatedAt = now;
      store.giftCardTransactions.push({
        id: crypto.randomUUID(), giftCardId: gc.id, transactionType: "reload",
        amount, balanceAfter: gc.balance, employeeId: ctx.employee.id, createdAt: now,
      });
    });
  }

  revalidatePath("/admin");
}

export async function disableGiftCardAction(giftCardId: string) {
  const ctx = await requireAdminPermission("register.open");
  if (isPg()) {
    await orgQuery(
      ctx.employee.organizationId,
      `UPDATE gift_cards SET status = 'disabled', updated_at = now() WHERE id = $1`,
      [giftCardId],
    );
    // Audit event (non-fatal)
    pgInsertAuditEvent(
      ctx.employee.organizationId, null, ctx.employee.id,
      "gift_card", giftCardId, "gift_card_disabled",
      {},
    ).catch((err) => console.error("[disableGiftCardAction] audit failed:", err));
  } else {
    await mutateStore((store) => {
      const gc = store.giftCards.find((g) => g.id === giftCardId);
      if (!gc) throw new Error("Gift card not found");
      gc.status = "disabled";
      gc.updatedAt = new Date().toISOString();
    });
  }
  revalidatePath("/admin");
}
