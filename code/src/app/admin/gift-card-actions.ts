"use server";

import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import { orgTx, orgQuery } from "@/lib/supabase-rest";
import type { GiftCard, GiftCardTransaction } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";
import { randomUUID } from "@/lib/uuid";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { formatCurrency } from "@/lib/format";
const isPg = () => !!process.env.USE_POSTGRES;

// Cap gift card issuance/reload per request so a compromised manager can't
// mint arbitrary store-value cash. Matches the REST path in
// src/app/api/gift-cards/route.ts.
const MAX_GIFT_CARD_AMOUNT = 5_000;

// Only owner/manager roles may mint or disable gift cards. catalog.manage
// alone is too broad — inventory_clerk holds it for SKU upkeep but has no
// business creating cash-equivalent store value or wiping customer balances.
function requireGiftCardAuthority(roleKey: string | undefined | null): void {
  if (!roleKey || !["owner", "manager"].includes(roleKey)) {
    throw new Error("Gift card operations require owner or manager role");
  }
}

export async function activateGiftCardAction(formData: FormData) {
  const code = formData.get("code") as string;
  const amount = Number(formData.get("amount"));
  const customerId = (formData.get("customerId") as string) || undefined;

  if (!code || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("Code and positive amount are required");
  }
  if (amount > MAX_GIFT_CARD_AMOUNT) {
    throw new Error(`Amount exceeds maximum of $${MAX_GIFT_CARD_AMOUNT}`);
  }

  const ctx = await requireAdminPermission("catalog.manage");
  requireGiftCardAuthority(ctx.employee.roleKey);

  // R45-H: step-up re-auth matches the REST mirror
  // `/api/gift-cards` POST (bucket gift-card-activate-stepup).
  // Gift-card activation is cash-equivalent minting; a stolen manager
  // cookie without the password can otherwise mint up to $5k per call
  // via the server-action path. `disableGiftCardAction` already
  // requires step-up; parity gap closed.
  const actorPassword = String(formData.get("actorPassword") ?? "");
  const { requireStepUp } = await import("@/lib/auth/step-up");
  const stepUp = await requireStepUp({
    actorId: ctx.employee.id,
    orgId: ctx.employee.organizationId,
    actorPassword,
    bucketKey: "gift-card-activate-stepup",
  });
  if (!stepUp.ok) throw new Error(stepUp.error);

  const rl = checkRateLimit(`gc-activate:${ctx.employee.id}`);
  if (!rl.allowed) throw new Error("Too many requests");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;

    // Duplicate check scoped to org (after R8-C-3 the unique index is
    // per-org, and cross-org existence leaked via this lookup would let a
    // competitor enumerate the code space of any other tenant).
    const existing = await orgQuery(
      orgId,
      `SELECT id FROM gift_cards WHERE LOWER(code) = LOWER($1) AND organization_id = $2`,
      [code, orgId],
    );
    if (existing.rows.length > 0) throw new Error(`Gift card code "${code}" already exists`);

    const client = await orgTx(orgId);
    try {
      // R70-H2: advisory lock + 24h aggregate cap. SAME bucket key
      // (`gift-card-actor:${orgId}:${employeeId}`) and SAME 25k cap
      // as REST `/api/gift-cards` so concurrent activations
      // cross-coordinate. Prior shape let attacker with valid
      // password alternate between Server Action and REST to
      // defeat the REST-side daily cap.
      const MAX_DAILY_MINT_PER_ACTOR = 25_000;
      await client.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [`gift-card-actor:${orgId}:${ctx.employee.id}`],
      );
      const { rows: mintedRows } = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS minted
           FROM gift_card_transactions gct
           JOIN gift_cards gc ON gc.id = gct.gift_card_id
          WHERE gc.organization_id = $1
            AND gct.employee_id = $2
            AND gct.transaction_type IN ('activation', 'reload')
            AND gct.created_at >= now() - interval '24 hours'`,
        [orgId, ctx.employee.id],
      );
      const minted24h = Number(mintedRows[0]?.minted ?? 0) || 0;
      if (minted24h + amount > MAX_DAILY_MINT_PER_ACTOR) {
        await client.query("ROLLBACK");
        throw new Error(
          `24-hour gift-card mint cap of ${formatCurrency(MAX_DAILY_MINT_PER_ACTOR)} exceeded (${formatCurrency(minted24h)} minted in the last 24h). Owner must approve further activations.`,
        );
      }

      // R16-H-1: verify customerId belongs to caller's org. Same class as
      // R14-H-4 (the `/api/gift-cards` route equivalent). The FK
      // `gift_cards.customer_id → customers(id)` is tenant-agnostic; without
      // this gate a manager in org X can link an X-side gift card to a
      // foreign-tenant customer UUID, polluting cross-tenant JOIN reports.
      if (customerId) {
        const { rows: custRows } = await client.query(
          `SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [customerId, orgId],
        );
        if (custRows.length === 0) {
          await client.query("ROLLBACK");
          throw new Error("customer_id does not exist in this organization");
        }
      }

      const gcId = randomUUID();
      try {
        await client.query(
          `INSERT INTO gift_cards (id, organization_id, code, balance, initial_balance, status, customer_id, activated_by, activated_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4, 'active', $5, $6, now(), now(), now())`,
          [gcId, orgId, code, amount, customerId || null, ctx.employee.id],
        );
      } catch (err) {
        // R72-A: friendly handling of `uniq_gift_cards_active_code_per_org`
        // (partial unique index, migration 035). Pre-tx existence
        // check at line ~67 is racy; the advisory lock is per-
        // actor, not per-code, so a second activation of the same
        // code can slip past and hit 23505 here. Mirror the REST
        // path's friendly error.
        const e = err as { code?: string };
        if (e.code === "23505") {
          await client.query("ROLLBACK");
          throw new Error(`Gift card code "${code}" already exists`);
        }
        throw err;
      }
      await client.query(
        `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
         VALUES ($1, $2, 'activation', $3, $3, $4, 'New gift card activated', now())`,
        [randomUUID(), gcId, amount, ctx.employee.id],
      );
      // R45-M: audit INSIDE the transaction.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'gift_card', $5, 'gift_card_activated', $6, now())`,
        [
          randomUUID(), orgId, null, ctx.employee.id, gcId,
          JSON.stringify({ code: `****${code.slice(-4)}`, amount, customer_id: customerId || null }),
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

  if (!giftCardId || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("Gift card ID and positive amount required");
  }
  if (amount > MAX_GIFT_CARD_AMOUNT) {
    throw new Error(`Amount exceeds maximum of $${MAX_GIFT_CARD_AMOUNT}`);
  }

  const ctx = await requireAdminPermission("catalog.manage");
  requireGiftCardAuthority(ctx.employee.roleKey);

  // R45-H: step-up re-auth parity with REST mirror /api/gift-cards
  // reload action (bucket gift-card-reload-stepup).
  const actorPassword = String(formData.get("actorPassword") ?? "");
  const { requireStepUp } = await import("@/lib/auth/step-up");
  const stepUp = await requireStepUp({
    actorId: ctx.employee.id,
    orgId: ctx.employee.organizationId,
    actorPassword,
    bucketKey: "gift-card-reload-stepup",
  });
  if (!stepUp.ok) throw new Error(stepUp.error);

  const rl = checkRateLimit(`gc-reload:${ctx.employee.id}`);
  if (!rl.allowed) throw new Error("Too many requests");

  if (isPg()) {
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      // R70-H2: advisory lock + 24h aggregate cap parity with REST
      // reload (same pattern as activate above + same bucket key
      // so activate + reload share the daily ceiling).
      const MAX_DAILY_MINT_PER_ACTOR = 25_000;
      await client.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [`gift-card-actor:${orgId}:${ctx.employee.id}`],
      );
      const { rows: mintedRows } = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS minted
           FROM gift_card_transactions gct
           JOIN gift_cards gc ON gc.id = gct.gift_card_id
          WHERE gc.organization_id = $1
            AND gct.employee_id = $2
            AND gct.transaction_type IN ('activation', 'reload')
            AND gct.created_at >= now() - interval '24 hours'`,
        [orgId, ctx.employee.id],
      );
      const minted24h = Number(mintedRows[0]?.minted ?? 0) || 0;
      if (minted24h + amount > MAX_DAILY_MINT_PER_ACTOR) {
        await client.query("ROLLBACK");
        throw new Error(
          `24-hour gift-card mint cap of ${formatCurrency(MAX_DAILY_MINT_PER_ACTOR)} exceeded (${formatCurrency(minted24h)} minted in the last 24h). Owner must approve further mints.`,
        );
      }

      // Defense in depth: scope every gift_cards touch by org, not just RLS.
      // gift_cards.code collisions across tenants can leak IDs via the
      // activation conflict path (see R8-C-3), so a UUID could realistically
      // reach a foreign tenant's row — add a belt-and-braces filter.
      const gc = await client.query(
        `SELECT * FROM gift_cards WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [giftCardId, orgId],
      );
      if (gc.rows.length === 0) { await client.query("ROLLBACK"); throw new Error("Gift card not found"); }
      const card = gc.rows[0];
      if (card.status === "disabled" || card.status === "expired") {
        await client.query("ROLLBACK");
        throw new Error(`Cannot reload ${card.status} gift card`);
      }
      const newBal = Number(card.balance) + amount;
      await client.query(
        `UPDATE gift_cards SET balance = $1, status = 'active', updated_at = now() WHERE id = $2 AND organization_id = $3`,
        [newBal, giftCardId, orgId],
      );
      await client.query(
        `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
         VALUES ($1, $2, 'reload', $3, $4, $5, 'Gift card reloaded', now())`,
        [randomUUID(), giftCardId, amount, newBal, ctx.employee.id],
      );
      // R45-M: audit INSIDE the transaction.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'gift_card', $5, 'gift_card_reloaded', $6, now())`,
        [
          randomUUID(), orgId, null, ctx.employee.id, giftCardId,
          JSON.stringify({ amount, new_balance: newBal }),
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

export async function disableGiftCardAction(
  giftCardId: string,
  // R37-H3: actorPassword is required. Gift-card disable wipes live
  // customer-owned balance — same impact as the REST sibling at
  // `/api/gift-cards POST {action:'disable'}`, which already gates on
  // step-up (R36-H5). This action was the forgotten path; a stolen
  // manager cookie could previously call it directly via RSC form
  // submission and erase every card's balance without re-auth.
  actorPassword?: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const ctx = await requireAdminPermission("catalog.manage");
  requireGiftCardAuthority(ctx.employee.roleKey);
  const rl = checkRateLimit(`gc-disable:${ctx.employee.id}`);
  if (!rl.allowed) {
    return { success: false, error: "Too many requests. Try again shortly." };
  }
  // Step-up. Share the REST path's bucket so a flood against one surface
  // counts against the other (attacker can't dodge by switching paths).
  const { requireStepUp } = await import("@/lib/auth/step-up");
  const stepUp = await requireStepUp({
    actorId: ctx.employee.id,
    orgId: ctx.employee.organizationId,
    actorPassword,
    bucketKey: "gift-card-disable-stepup",
  });
  if (!stepUp.ok) {
    return { success: false, error: stepUp.error };
  }
  if (isPg()) {
    // R47-H2: wrap SELECT-before + UPDATE + audit in a single orgTx
    // with FOR UPDATE on the SELECT. Prior shape ran three separate
    // orgQuery calls (each its own short tx) + post-commit
    // waitUntilOrAwait audit. Two managers disabling the same card
    // concurrently could interleave SELECT/UPDATE; a failed audit
    // write left the liability wipe committed without an audit row.
    // Mirrors the REST path's R46-H2 fix.
    const orgId = ctx.employee.organizationId;
    const client = await orgTx(orgId);
    try {
      const { rows: before } = await client.query(
        `SELECT code, balance::text, status FROM gift_cards
          WHERE id = $1 AND organization_id = $2 LIMIT 1 FOR UPDATE`,
        [giftCardId, orgId],
      );
      if (before.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Gift card not found");
      }
      // R47-M (idempotent-audit guard): skip UPDATE + audit when the
      // card is already disabled. Prior shape wrote an audit row on
      // every repeat call — attacker could flood audit_events.
      if (before[0].status === "disabled") {
        await client.query("ROLLBACK");
        revalidatePath("/admin");
        return { success: true };
      }
      await client.query(
        `UPDATE gift_cards SET status = 'disabled', updated_at = now()
          WHERE id = $1 AND organization_id = $2`,
        [giftCardId, orgId],
      );
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'gift_card', $5, 'gift_card_disabled', $6, now())`,
        [
          randomUUID(),
          orgId,
          null,
          ctx.employee.id,
          giftCardId,
          JSON.stringify({
            code: `****${String(before[0].code ?? "").slice(-4)}`,
            balance_at_disable: before[0].balance,
            prior_status: before[0].status,
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
      const gc = store.giftCards.find((g) => g.id === giftCardId);
      if (!gc) throw new Error("Gift card not found");
      gc.status = "disabled";
      gc.updatedAt = new Date().toISOString();
    });
  }
  revalidatePath("/admin");
  return { success: true };
}
