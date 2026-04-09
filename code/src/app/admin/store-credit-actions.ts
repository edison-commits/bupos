"use server";

import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import { orgTx, pool } from "@/lib/db";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";
import type { StoreCreditEntry } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";

const isPg = () => !!process.env.USE_POSTGRES;

export async function issueStoreCreditAction(formData: FormData) {
  const customerId = formData.get("customerId") as string;
  const amount = Number(formData.get("amount"));
  const reason = formData.get("reason") as string;

  if (!customerId || !amount || amount <= 0 || !reason) {
    throw new Error("Customer, positive amount, and reason are required");
  }

  const ctx = await requireAdminPermission("register.open");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      const updated = await client.query(
        `UPDATE customers SET store_credit_balance = store_credit_balance + $1, updated_at = now()
         WHERE id = $2 RETURNING store_credit_balance`,
        [amount, customerId],
      );
      if (updated.rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Customer not found");
      }
      const newBalance = updated.rows[0].store_credit_balance;

      await client.query(
        `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
         VALUES ($1, $2, $3, 'issuance', $4, $5, $6, $7, now())`,
        [randomUUID(), orgId, customerId, amount, newBalance, ctx.employee.id, reason],
      );
      await client.query("COMMIT");
      // Audit event (non-fatal — committed regardless)
      pgInsertAuditEvent(
        orgId, null, ctx.employee.id,
        "customer", customerId, "store_credit_issued",
        { amount, new_balance: newBalance, reason },
      ).catch((err) => console.error("[issueStoreCreditAction] audit failed:", err));
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    await mutateStore((store) => {
      const customer = store.customers.find((c) => c.id === customerId);
      if (!customer) throw new Error("Customer not found");

      const now = new Date().toISOString();
      customer.storeCreditBalance += amount;
      customer.updatedAt = now;

      const entry: StoreCreditEntry = {
        id: crypto.randomUUID(),
        organizationId: store.organization.id,
        customerId,
        transactionType: "issuance",
        amount,
        balanceAfter: customer.storeCreditBalance,
        employeeId: ctx.employee.id,
        reason,
        createdAt: now,
      };
      store.storeCreditLedger.push(entry);
    });
  }

  revalidatePath("/admin");
}
