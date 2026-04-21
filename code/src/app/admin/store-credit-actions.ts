"use server";

import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import { orgTx } from "@/lib/supabase-rest";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";
import type { StoreCreditEntry } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";
import { randomUUID } from "@/lib/uuid";
import { checkRateLimit } from "@/lib/auth/rate-limit";

import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
const isPg = () => !!process.env.USE_POSTGRES;

// Mirrors /api/store-credit schema caps — no single issuance > $10k to bound
// abuse via a compromised manager. Also rate-limited per employee.
const MAX_STORE_CREDIT_ISSUANCE = 10_000;

export async function issueStoreCreditAction(formData: FormData) {
  const customerId = formData.get("customerId") as string;
  const amount = Number(formData.get("amount"));
  const reason = formData.get("reason") as string;

  if (!customerId || !Number.isFinite(amount) || amount <= 0 || !reason) {
    throw new Error("Customer, positive amount, and reason are required");
  }
  if (amount > MAX_STORE_CREDIT_ISSUANCE) {
    throw new Error(`Amount exceeds maximum of $${MAX_STORE_CREDIT_ISSUANCE}`);
  }

  const ctx = await requireAdminPermission("approval.store_credit");
  const rl = checkRateLimit(`store-credit-action:${ctx.employee.id}`);
  if (!rl.allowed) {
    throw new Error("Too many requests");
  }

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      // Defense in depth: even inside orgTx (which sets app.current_org_id
      // for RLS), add AND organization_id = $3 so any RLS regression, policy
      // drift, or future BYPASSRLS role change can't let a manager in org A
      // credit a customer in org B via a guessed/leaked UUID.
      const updated = await client.query(
        `UPDATE customers SET store_credit_balance = store_credit_balance + $1, updated_at = now()
         WHERE id = $2 AND organization_id = $3 RETURNING store_credit_balance`,
        [amount, customerId, orgId],
      );
      if (updated.rows.length === 0) {
        await client.query("ROLLBACK");
        // Generic message — don't reveal whether the customer exists in another
        // org or simply doesn't exist at all.
        throw new Error("Invalid customer");
      }
      const newBalance = updated.rows[0].store_credit_balance;

      await client.query(
        `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
         VALUES ($1, $2, $3, 'issuance', $4, $5, $6, $7, now())`,
        [randomUUID(), orgId, customerId, amount, newBalance, ctx.employee.id, reason],
      );
      await client.query("COMMIT");
      // Audit event (non-fatal — committed regardless)
      await waitUntilOrAwait(pgInsertAuditEvent(
        orgId, null, ctx.employee.id,
        "customer", customerId, "store_credit_issued",
        { amount, new_balance: newBalance, reason },
      ).catch((err) => console.error("[issueStoreCreditAction] audit failed:", safeErr(err))));
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
