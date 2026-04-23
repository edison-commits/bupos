"use server";

import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import { orgTx } from "@/lib/supabase-rest";
import type { StoreCreditEntry } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";
import { randomUUID } from "@/lib/uuid";
// R84-final: bust readStore cache so customer-detail + dashboards
// don't serve stale store-credit balances for 30s after issuance.
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { formatCurrency } from "@/lib/format";
const isPg = () => !!process.env.USE_POSTGRES;

// R44-FE3: cap aligned with REST mirror /api/store-credit (5k not 10k)
// so a compromised manager cookie can't mint larger amounts via the
// server-action path than via the REST path. Prior $10k was a loose
// upper bound that pre-dated the REST cap tightening.
const MAX_STORE_CREDIT_ISSUANCE = 5_000;
// R70-H2: 24h rolling per-actor aggregate cap. REST mirror enforces
// the same limit — the Server Action was the bypass path. Attacker
// with valid password (step-up passes) could otherwise mint 5×
// $5000 per tick via this action, exceeding the intended daily
// ceiling the REST surface prevented.
const MAX_DAILY_STORE_CREDIT_PER_ACTOR = 25_000;

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

  // R44-FE3: require step-up re-auth. The REST mirror
  // `/api/store-credit/route.ts` requires `actorPassword` via
  // `requireStepUp` — the server action was the looser path. A
  // compromised manager cookie could previously mint up to $5k per
  // rate-limit tick on any admin UI form that action={issueStoreCreditAction}
  // without any password re-entry. The gate bucket matches the REST
  // path so both share the same aggregate cap.
  const actorPassword = String(formData.get("actorPassword") ?? "");
  const { requireStepUp } = await import("@/lib/auth/step-up");
  const stepUp = await requireStepUp({
    actorId: ctx.employee.id,
    orgId: ctx.employee.organizationId,
    actorPassword,
    bucketKey: "store-credit-stepup",
  });
  if (!stepUp.ok) {
    throw new Error(stepUp.error);
  }

  const rl = checkRateLimit(`store-credit-action:${ctx.employee.id}`);
  if (!rl.allowed) {
    throw new Error("Too many requests");
  }

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      // R70-H2: advisory lock on `store-credit-actor:${orgId}:${employeeId}`
      // + 24h aggregate check, SAME shape + SAME bucket as REST
      // `/api/store-credit` (line ~218). The advisory lock key must
      // be identical so concurrent issuances cross-coordinate
      // between the two surfaces — otherwise an attacker could
      // alternate between REST and Server Action to defeat
      // serialization on each side.
      await client.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [`store-credit-actor:${orgId}:${ctx.employee.id}`],
      );
      const { rows: dailyRows } = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS minted
           FROM store_credit_ledger
          WHERE organization_id = $1
            AND employee_id = $2
            AND transaction_type = 'issuance'
            AND created_at >= now() - interval '24 hours'`,
        [orgId, ctx.employee.id],
      );
      const minted24h = Number(dailyRows[0]?.minted ?? 0) || 0;
      if (minted24h + amount > MAX_DAILY_STORE_CREDIT_PER_ACTOR) {
        await client.query("ROLLBACK");
        throw new Error(
          `24-hour store-credit issuance cap of ${formatCurrency(MAX_DAILY_STORE_CREDIT_PER_ACTOR)} exceeded (already ${formatCurrency(minted24h)} in the last 24h).`,
        );
      }

      // Defense in depth: even inside orgTx (which sets app.current_org_id
      // for RLS), add AND organization_id = $3 so any RLS regression, policy
      // drift, or future BYPASSRLS role change can't let a manager in org A
      // credit a customer in org B via a guessed/leaked UUID.
      // R75-M: `AND is_active = true` — anonymized customers (GDPR
      // right-to-be-forgotten DELETE) carry is_active=false + zeroed
      // balance. Without this filter, manual issuance writes credit
      // back onto a [deleted] record that can never be redeemed,
      // leaving a permanent phantom liability and mutating an
      // erased PII record post-erasure.
      const updated = await client.query(
        `UPDATE customers SET store_credit_balance = store_credit_balance + $1, updated_at = now()
         WHERE id = $2 AND organization_id = $3 AND is_active = true RETURNING store_credit_balance`,
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
      // R45-M: audit INSIDE the transaction. Prior shape used
      // waitUntilOrAwait(pgInsertAuditEvent(...)) AFTER COMMIT; if the
      // audit write failed (DB hiccup, RLS drift, isolate freeze),
      // money movement committed without an audit row. Mirrors the
      // R44-MED layaway-actions fix.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'customer', $5, 'store_credit_issued', $6, now())`,
        [
          randomUUID(), orgId, null, ctx.employee.id, customerId,
          JSON.stringify({ amount, new_balance: newBalance, reason }),
        ],
      );
      await client.query("COMMIT");
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

  invalidateStoreCache(ctx.employee.organizationId);
  revalidatePath("/admin");
}
