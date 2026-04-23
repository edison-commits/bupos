import { NextResponse } from "next/server";
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import { randomUUID } from "@/lib/uuid";
import { withAdminAuth } from "@/lib/api/with-auth";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { validateBody, giftCardSchema } from "@/lib/validation/schemas";
import { formatCurrency } from "@/lib/format";

import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
/**
 * GET /api/gift-cards
 *
 * Code / ID lookup is accessible to `audit.view` (register lookups + admin
 * detail page). The LIST view is managers-only because it exposes every
 * card's balance + customer linkage org-wide and gift cards aren't
 * location-scoped — R12-M-1.
 */
export const GET = withAdminAuth("audit.view", async (req, ctx) => {
  const { orgId } = ctx;

  try {
    const sp = req.nextUrl.searchParams;

    // ── Lookup by code (register) ──
    const code = sp.get("code");
    if (code) {
      // Scope by org explicitly. RLS filters already prevent reading foreign
      // tenants, but the old global unique on gift_cards.code meant a
      // collision-style lookup could still reach a different tenant's row on
      // environments where RLS is temporarily disabled. Migration 035
      // replaces the global unique with a per-org partial index.
      const result = await orgQuery(
        orgId,
        `SELECT gc.*, c.first_name || ' ' || c.last_name AS customer_name
         FROM gift_cards gc
         LEFT JOIN customers c ON c.id = gc.customer_id
         WHERE LOWER(gc.code) = LOWER($1) AND gc.organization_id = $2`,
        [code, orgId],
      );
      if (result.rows.length === 0) {
        return NextResponse.json({ error: "Gift card not found" }, { status: 404 });
      }
      return NextResponse.json({ giftCard: result.rows[0] });
    }

    // ── Lookup by ID (with history) ──
    const id = sp.get("id");
    if (id) {
      const card = await orgQuery(
        orgId,
        `SELECT gc.*, c.first_name || ' ' || c.last_name AS customer_name,
                e.display_name AS activated_by_name
         FROM gift_cards gc
         LEFT JOIN customers c ON c.id = gc.customer_id
         LEFT JOIN employees e ON e.id = gc.activated_by
         WHERE gc.id = $1 AND gc.organization_id = $2`,
        [id, orgId],
      );
      if (card.rows.length === 0) {
        return NextResponse.json({ error: "Gift card not found" }, { status: 404 });
      }

      // R27-C6: scope through the parent gift card. gct.gift_card_id
      // is FK-scoped but adding an explicit gate prevents a cross-tenant
      // gift_card_id (client-supplied) from leaking transaction history.
      // The JOIN above already verified `id` belongs to this org.
      const history = await orgQuery(
        orgId,
        `SELECT gct.*, e.display_name AS employee_name
         FROM gift_card_transactions gct
         JOIN gift_cards gc ON gc.id = gct.gift_card_id
         LEFT JOIN employees e ON e.id = gct.employee_id AND e.organization_id = $2
         WHERE gct.gift_card_id = $1 AND gc.organization_id = $2
         ORDER BY gct.created_at DESC`,
        [id, orgId],
      );

      return NextResponse.json({ giftCard: card.rows[0], history: history.rows });
    }

    // ── List all ──
    // R12-M-1: gate the list on owner/manager. `audit.view` grants visibility
    // of specific cards via code/id lookup above (needed at the register POS),
    // but the full list view exposes org-wide balances + customer-card
    // linkages that inventory_clerk / support shouldn't see.
    if (!["owner", "manager"].includes(ctx.employee.roleKey)) {
      return NextResponse.json(
        { error: "Gift card list view requires owner or manager role" },
        { status: 403 },
      );
    }
    // R27-C6: explicit organization_id filter on the list + stats.
    // Without it, an owner/manager at ANY tenant saw every tenant's
    // gift card codes, balances, and customer linkages. JOINs also
    // gated by org so cross-tenant customer_id/activated_by IDs
    // can't splice foreign names in.
    const status = sp.get("status");
    const where = status ? "AND gc.status = $2" : "";
    const params: unknown[] = status ? [orgId, status] : [orgId];

    const cards = await orgQuery(
      orgId,
      `SELECT gc.*, c.first_name || ' ' || c.last_name AS customer_name,
              e.display_name AS activated_by_name
       FROM gift_cards gc
       LEFT JOIN customers c ON c.id = gc.customer_id AND c.organization_id = $1
       LEFT JOIN employees e ON e.id = gc.activated_by AND e.organization_id = $1
       WHERE gc.organization_id = $1 ${where}
       ORDER BY gc.created_at DESC`,
      params,
    );

    const stats = await orgQuery(
      orgId,
      `SELECT
         COUNT(*)::int AS total_cards,
         COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
         COALESCE(SUM(balance) FILTER (WHERE status = 'active'), 0)::numeric AS outstanding_balance,
         COALESCE(SUM(initial_balance), 0)::numeric AS total_issued
       FROM gift_cards
       WHERE organization_id = $1`,
      [orgId],
    );

    return NextResponse.json({
      giftCards: cards.rows,
      summary: stats.rows[0],
    });
  } catch (err) {
    console.error("GET /api/gift-cards error:", safeErr(err));
    return NextResponse.json({ error: "Failed to fetch gift cards" }, { status: 500 });
  }
});

/**
 * POST /api/gift-cards
 */
export const POST = withAdminAuth('catalog.manage', async (req, ctx) => {
  const employeeId = ctx.employee.id;

  const rl = checkRateLimit(`gift-cards:${employeeId}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { orgId } = ctx;
  try {
    const body = await req.json();
    const v = validateBody(giftCardSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { action } = v.data;

    if (action === "activate") {
      // R33-M-stepup-order: step-up fires FIRST so failed attempts
      // burn the rate-limit bucket regardless of role. Prior shape
      // returned 403 ("requires owner or manager") BEFORE step-up —
      // an attacker with a stolen cashier cookie learned the role
      // mismatch without touching the password-guess budget. Step-up
      // runs first; if role is wrong we return the same generic
      // 403 post-step-up.
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: employeeId,
        orgId,
        actorPassword: (body as { actorPassword?: string }).actorPassword,
        bucketKey: 'gift-card-activate-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }
      // Gift card activation mints cash-equivalent value that redeems at
      // checkout. `catalog.manage` is held by inventory_clerk (for SKU
      // upkeep) — but they shouldn't be able to print money. Restrict mint
      // operations to owner/manager to match the `disable` branch.
      if (!ctx.employee.roleKey || !["owner", "manager"].includes(ctx.employee.roleKey)) {
        return NextResponse.json(
          { error: "Gift card activation requires owner or manager role" },
          { status: 403 },
        );
      }
      const { code, amount, customerId } = body;
      if (!code || !amount || amount <= 0) {
        return NextResponse.json({ error: "Code and positive amount required" }, { status: 400 });
      }
      // Per-activation hard cap. The schema allows up to $10M; at that size a
      // typo or a compromised manager session mints effectively-unlimited
      // cash. $5K is well above legitimate single-card use.
      const MAX_ACTIVATION_AMOUNT = 5_000;
      if (amount > MAX_ACTIVATION_AMOUNT) {
        return NextResponse.json(
          { error: `Gift card activation exceeds per-card cap of $${MAX_ACTIVATION_AMOUNT}` },
          { status: 400 },
        );
      }

      // R28-M8: per-actor daily aggregate cap on gift-card mint volume.
      // A compromised manager cookie can otherwise activate 100 × $5K
      // cards = $500K outstanding liability in one session, with every
      // individual activation audit-visible but no aggregate alarm.
      // $25K/24h per actor is well above the 99th-percentile legitimate
      // mint volume at a POS.
      // R29-M2: rolling 24-hour window (now() - interval '24 hours')
      // instead of since-UTC-midnight. The prior shape let an attacker
      // mint $25K at 23:59 UTC then another $25K at 00:01 UTC in a 2-
      // minute span — 2× the intended cap. A rolling window closes that
      // midnight-rollover bypass.
      const MAX_DAILY_MINT_PER_ACTOR = 25_000;
      const { rows: dailyRows } = await orgQuery(
        orgId,
        `SELECT COALESCE(SUM(gct.amount), 0)::numeric AS today_minted
           FROM gift_card_transactions gct
           JOIN gift_cards gc ON gc.id = gct.gift_card_id
          WHERE gc.organization_id = $1
            AND gct.employee_id = $2
            AND gct.transaction_type IN ('activation', 'reload')
            AND gct.created_at >= now() - interval '24 hours'`,
        [orgId, employeeId],
      );
      const todayMinted = Number(dailyRows[0]?.today_minted ?? 0);
      if (todayMinted + amount > MAX_DAILY_MINT_PER_ACTOR) {
        return NextResponse.json(
          { error: `24-hour mint cap of ${formatCurrency(MAX_DAILY_MINT_PER_ACTOR)} exceeded (${formatCurrency(todayMinted)} minted in the last 24h). Owner must approve further activations.` },
          { status: 429 },
        );
      }

      // R13-M-5: the existence check used to live OUTSIDE the transaction.
      // Two concurrent activates with the same code both passed the check
      // and raced to INSERT; the loser hit the partial unique (migration
      // 035) with 23505 and surfaced as a generic 500. Fix: rely on the
      // unique index as the authoritative gate and catch 23505 inside the
      // try block. The pre-check stays as a cheap fast-fail UX path.
      const existing = await orgQuery(
        orgId,
        `SELECT id FROM gift_cards WHERE LOWER(code) = LOWER($1) AND organization_id = $2`,
        [code, orgId],
      );
      if (existing.rows.length > 0) {
        return NextResponse.json({ error: `Gift card code "${code}" already exists` }, { status: 409 });
      }

      // R14-H-4: verify customerId belongs to this org. The FK
      // `gift_cards.customer_id REFERENCES customers(id)` is tenant-
      // agnostic — Postgres enforces referential integrity but doesn't
      // apply RLS to FK checks. Without this gate, an attacker with
      // catalog.manage in org A who knows a customer UUID from org B
      // can activate an A-side gift card that "points at" the foreign
      // customer, poisoning JOIN-based reports and creating a
      // cross-tenant cascade surface.
      if (customerId) {
        const { rows: custRows } = await orgQuery(
          orgId,
          `SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [customerId, orgId],
        );
        if (custRows.length === 0) {
          return NextResponse.json({ error: "customer_id does not exist in this organization" }, { status: 400 });
        }
      }

      const client = await orgTx(orgId);
      try {
        // R31-M4: serialize activations for the same actor so two
        // concurrent calls can't both pass the pre-tx 24h cap check.
        // Inside-tx re-check below enforces the cap authoritatively.
        await client.query(
          `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
          [`gift-card-actor:${orgId}:${employeeId}`],
        );
        const { rows: reCheckRows } = await client.query(
          `SELECT COALESCE(SUM(gct.amount), 0)::numeric AS today_minted
             FROM gift_card_transactions gct
             JOIN gift_cards gc ON gc.id = gct.gift_card_id
            WHERE gc.organization_id = $1
              AND gct.employee_id = $2
              AND gct.transaction_type IN ('activation', 'reload')
              AND gct.created_at >= now() - interval '24 hours'`,
          [orgId, employeeId],
        );
        const reCheckMinted = Number(reCheckRows[0]?.today_minted ?? 0);
        if (reCheckMinted + amount > MAX_DAILY_MINT_PER_ACTOR) {
          await client.query("ROLLBACK");
          return NextResponse.json(
            { error: `24-hour mint cap of ${formatCurrency(MAX_DAILY_MINT_PER_ACTOR)} exceeded (${formatCurrency(reCheckMinted)} minted in the last 24h). Owner must approve further activations.` },
            { status: 429 },
          );
        }
        const gcId = randomUUID();
        try {
          await client.query(
            `INSERT INTO gift_cards (id, organization_id, code, balance, initial_balance, status, customer_id, activated_by, activated_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $4, 'active', $5, $6, now(), now(), now())`,
            [gcId, orgId, code, amount, customerId || null, employeeId],
          );
        } catch (insertErr) {
          const err = insertErr as { code?: string };
          if (err.code === '23505') {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: `Gift card code "${code}" already exists` }, { status: 409 });
          }
          throw insertErr;
        }

        await client.query(
          `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
           VALUES ($1, $2, 'activation', $3, $3, $4, 'New gift card activated', now())`,
          [randomUUID(), gcId, amount, employeeId],
        );

        // R46-H1: audit INSIDE the tx (matches server-action sibling).
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'gift_card', $5, 'gift_card_created', $6, now())`,
          [
            randomUUID(), orgId, null, employeeId, gcId,
            JSON.stringify({ id: gcId, code: `****${code.slice(-4)}`, amount }),
          ],
        );
        await client.query("COMMIT");
        return NextResponse.json({ id: gcId, code, balance: amount, status: "active" }, { status: 201 });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }

    if (action === "reload") {
      // R33-M-stepup-order: step-up before role check (same as
      // activate branch above).
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: employeeId,
        orgId,
        actorPassword: (body as { actorPassword?: string }).actorPassword,
        bucketKey: 'gift-card-reload-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }
      // Reload also mints money onto an existing card — same blast radius
      // as activate. Gate on owner/manager and cap the per-reload amount.
      if (!ctx.employee.roleKey || !["owner", "manager"].includes(ctx.employee.roleKey)) {
        return NextResponse.json(
          { error: "Gift card reload requires owner or manager role" },
          { status: 403 },
        );
      }
      const { giftCardId, amount } = body;
      if (!giftCardId || !amount || amount <= 0) {
        return NextResponse.json({ error: "Gift card ID and positive amount required" }, { status: 400 });
      }
      const MAX_RELOAD_AMOUNT = 5_000;
      if (amount > MAX_RELOAD_AMOUNT) {
        return NextResponse.json(
          { error: `Gift card reload exceeds per-request cap of $${MAX_RELOAD_AMOUNT}` },
          { status: 400 },
        );
      }

      // R28-M8: per-actor daily cap — shared ceiling with activation.
      // R29-M2: rolling 24-hour window (not since-UTC-midnight). See the
      // activation branch above for the attack this closes.
      const MAX_DAILY_MINT_PER_ACTOR = 25_000;
      const { rows: dailyReloadRows } = await orgQuery(
        orgId,
        `SELECT COALESCE(SUM(gct.amount), 0)::numeric AS today_minted
           FROM gift_card_transactions gct
           JOIN gift_cards gc ON gc.id = gct.gift_card_id
          WHERE gc.organization_id = $1
            AND gct.employee_id = $2
            AND gct.transaction_type IN ('activation', 'reload')
            AND gct.created_at >= now() - interval '24 hours'`,
        [orgId, employeeId],
      );
      const todayMinted = Number(dailyReloadRows[0]?.today_minted ?? 0);
      if (todayMinted + amount > MAX_DAILY_MINT_PER_ACTOR) {
        return NextResponse.json(
          { error: `24-hour mint cap of ${formatCurrency(MAX_DAILY_MINT_PER_ACTOR)} exceeded (${formatCurrency(todayMinted)} minted in the last 24h). Owner must approve further mints.` },
          { status: 429 },
        );
      }

      const client = await orgTx(orgId);
      try {
        // R31-M4: per-actor advisory lock + in-tx 24h cap re-check.
        // See activation branch above for rationale.
        await client.query(
          `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
          [`gift-card-actor:${orgId}:${employeeId}`],
        );
        const { rows: reCheckRows } = await client.query(
          `SELECT COALESCE(SUM(gct.amount), 0)::numeric AS today_minted
             FROM gift_card_transactions gct
             JOIN gift_cards gc ON gc.id = gct.gift_card_id
            WHERE gc.organization_id = $1
              AND gct.employee_id = $2
              AND gct.transaction_type IN ('activation', 'reload')
              AND gct.created_at >= now() - interval '24 hours'`,
          [orgId, employeeId],
        );
        const reCheckMinted = Number(reCheckRows[0]?.today_minted ?? 0);
        if (reCheckMinted + amount > MAX_DAILY_MINT_PER_ACTOR) {
          await client.query("ROLLBACK");
          return NextResponse.json(
            { error: `24-hour mint cap of ${formatCurrency(MAX_DAILY_MINT_PER_ACTOR)} exceeded (${formatCurrency(reCheckMinted)} minted in the last 24h). Owner must approve further mints.` },
            { status: 429 },
          );
        }
        const gc = await client.query(
          `SELECT id, organization_id, code, initial_balance, balance, status, customer_id, activated_at, expires_at
           FROM gift_cards WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [giftCardId, orgId],
        );
        if (gc.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Gift card not found" }, { status: 404 });
        }
        const card = gc.rows[0];
        if (card.status === "disabled" || card.status === "expired") {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: `Cannot reload ${card.status} gift card` }, { status: 400 });
        }
        // Reload must also honor expires_at even when status is still
        // 'active' — there is no scheduled job to flip expired cards to
        // the 'expired' status, so lapsed-but-status=active cards would
        // otherwise be silently resurrected by setting status='active'
        // below (R10-M-2).
        if (card.expires_at && new Date(card.expires_at).getTime() < Date.now()) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Cannot reload expired gift card" }, { status: 400 });
        }

        const newBalance = Number(card.balance) + amount;
        await client.query(
          `UPDATE gift_cards SET balance = $1, status = 'active', updated_at = now() WHERE id = $2 AND organization_id = $3`,
          [newBalance, giftCardId, orgId],
        );

        await client.query(
          `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, reason, created_at)
           VALUES ($1, $2, 'reload', $3, $4, $5, 'Gift card reloaded', now())`,
          [randomUUID(), giftCardId, amount, newBalance, employeeId],
        );

        // R46-H1: reload had NO audit event at all prior to R46. Adds
        // up to $5k to a card balance with only the gift_card_transactions
        // row as evidence. Match the server-action sibling which
        // writes gift_card_reloaded inside its tx.
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'gift_card', $5, 'gift_card_reloaded', $6, now())`,
          [
            randomUUID(), orgId, null, employeeId, giftCardId,
            JSON.stringify({ amount, new_balance: newBalance }),
          ],
        );
        await client.query("COMMIT");
        return NextResponse.json({ id: giftCardId, balance: newBalance, status: "active" });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    if (action === "disable") {
      const { giftCardId, actorPassword } = body;
      if (!giftCardId) {
        return NextResponse.json({ error: "Gift card ID required" }, { status: 400 });
      }

      // Disabling a gift card zeroes out customer-owned balance — money.
      // Gate on pricing.manage (owner/manager) so inventory_clerks can't
      // mass-wipe balances. Also audit who did it + what the balance was
      // at the moment of disable so a dispute is reconstructable.
      if (!ctx.employee.roleKey || !["owner", "manager"].includes(ctx.employee.roleKey)) {
        return NextResponse.json(
          { error: "Disabling gift cards requires owner or manager role" },
          { status: 403 },
        );
      }

      // R36-H5: require step-up. Activate + reload (R33-M-stepup-order)
      // gate cash-in writes with step-up; disable wipes outstanding
      // customer-owned balance (a cash LIABILITY write-off + evidence
      // destruction) and must have the same bar. A stolen manager
      // cookie without password couldn't previously mass-disable every
      // active card, store-wide DoS + dispute record destruction.
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: ctx.employee.id,
        orgId,
        actorPassword: typeof actorPassword === 'string' ? actorPassword : undefined,
        bucketKey: 'gift-card-disable-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }
      // R46-H2: wrap SELECT-before + UPDATE + audit in a single tx with
      // FOR UPDATE on the SELECT. Prior shape had 3 separate queries
      // (each its own short tx), with the audit as a post-commit
      // waitUntilOrAwait. A concurrent disable / reload could race
      // between the SELECT and UPDATE; if the post-commit audit failed,
      // the balance wipe committed without evidence (zeroed a liability
      // worth up to $5k with only a transaction_events trigger-entry).
      const disableClient = await orgTx(orgId);
      let before: Array<{ id: string; code: string; balance: string; status: string }>;
      try {
        const selRes = await disableClient.query(
          `SELECT id, code, balance::text, status FROM gift_cards
            WHERE id = $1 AND organization_id = $2 LIMIT 1 FOR UPDATE`,
          [giftCardId, orgId],
        );
        before = selRes.rows as Array<{ id: string; code: string; balance: string; status: string }>;
        if (before.length === 0) {
          await disableClient.query("ROLLBACK");
          return NextResponse.json({ error: "Gift card not found" }, { status: 404 });
        }
        await disableClient.query(
          `UPDATE gift_cards SET status = 'disabled', updated_at = now()
            WHERE id = $1 AND organization_id = $2`,
          [giftCardId, orgId],
        );
        await disableClient.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'gift_card', $5, 'gift_card_disabled', $6, now())`,
          [
            randomUUID(), orgId, null, employeeId, giftCardId,
            JSON.stringify({
              code: before[0].code,
              balance_at_disable: before[0].balance,
              prior_status: before[0].status,
            }),
          ],
        );
        await disableClient.query("COMMIT");
      } catch (e) {
        await disableClient.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        disableClient.release();
      }
      // R46-H2: post-commit audit mirror removed — the in-tx INSERT
      // above is the canonical row.
      return NextResponse.json({ id: giftCardId, status: "disabled" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("POST /api/gift-cards error:", safeErr(err));
    return NextResponse.json({ error: "Failed to process gift card action" }, { status: 500 });
  }
});
