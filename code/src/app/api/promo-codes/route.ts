import { NextResponse } from "next/server";
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import { withAdminAuth, withDualAuth } from "@/lib/api/with-auth";
import { randomUUID } from "@/lib/uuid";
import { validateBody, promoCodeSchema } from "@/lib/validation/schemas";
import { formatCurrency } from "@/lib/format";
import { checkRateLimit } from "@/lib/auth/rate-limit";
// R93-DB-M1: get_full_store hydrates `promo_codes`. Every
// mutation here must bust the 30s readStore cache.
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";


import { safeErr } from "@/lib/logging/safe-err";
/**
 * GET /api/promo-codes
 *
 * Query params:
 *   code     — validate a specific code (returns validity + discount calc)
 *   subtotal — cart subtotal for validation (used with code)
 *   status   — filter by status (active, expired, disabled)
 *   id       — lookup by ID with redemption history
 *
 * Without params returns all promo codes.
 */
export const GET = withDualAuth("catalog.manage", async (req, ctx) => {
  const { orgId } = ctx;
  try {

    const sp = req.nextUrl.searchParams;

    // ── Validate a code (for register use) ──
    const code = sp.get("code");
    if (code) {
      const result = await orgQuery(
        orgId,
        `SELECT id, organization_id, code, description, type, value, minimum_purchase, max_redemptions, current_redemptions, status, starts_at, expires_at, free_variant_id
         FROM promo_codes WHERE LOWER(code) = LOWER($1) AND organization_id = $2`,
        [code, orgId],
      );

      if (result.rows.length === 0) {
        return NextResponse.json({ valid: false, reason: "Code not found" });
      }

      const promo = result.rows[0];
      // Compare timestamps as numbers (epoch ms), not ISO-vs-Date strings.
      // pg returns timestamp columns as JS Date; String(Date) is not ISO-sortable.
      const nowMs = Date.now();

      // Validation checks
      if (promo.status !== "active") {
        return NextResponse.json({ valid: false, reason: `Code is ${promo.status}`, promo });
      }
      if (promo.starts_at && new Date(promo.starts_at).getTime() > nowMs) {
        return NextResponse.json({ valid: false, reason: "Code is not yet active", promo });
      }
      if (promo.expires_at && new Date(promo.expires_at).getTime() < nowMs) {
        return NextResponse.json({ valid: false, reason: "Code has expired", promo });
      }
      // max_redemptions = 0 means unlimited; only check when max > 0
      if (promo.max_redemptions > 0 && promo.current_redemptions >= promo.max_redemptions) {
        return NextResponse.json({ valid: false, reason: "Code has reached maximum redemptions", promo });
      }

      const subtotal = Number(sp.get("subtotal")) || 0;
      if (subtotal > 0 && subtotal < Number(promo.minimum_purchase)) {
        return NextResponse.json({
          valid: false,
          reason: `Minimum purchase of ${formatCurrency(Number(promo.minimum_purchase))} required`,
          promo,
        });
      }

      // Calculate discount (for fixed/percent/bogo). For `free_item` there
      // is no cart-level discount — the cashier adds the free variant at
      // $0 and the "value" of the promo is effectively the variant's
      // price. Register-side UI handles the free-variant lookup and
      // surfaces the variant info via `freePreview` below.
      let discountAmount = 0;
      if (subtotal > 0) {
        if (promo.type === "fixed") {
          discountAmount = Math.min(Number(promo.value), subtotal);
        } else if (promo.type === "percent") {
          discountAmount = Number((subtotal * Number(promo.value) / 100).toFixed(2));
        } else if (promo.type === "bogo") {
          discountAmount = Number((subtotal * 0.5).toFixed(2));
        }
      }

      // For free_item, attach a preview of the variant being given away so
      // the modal can show "Free: <Product Name — Variant>" without an
      // extra round-trip. Subtotal check must match `minimum_purchase`
      // (already enforced above), and the variant must be active + in this
      // org (RLS already enforces org; we additionally filter on is_active).
      let freePreview: { variantId: string; productName: string; variantName: string; unitPrice: number } | undefined;
      if (promo.type === "free_item" && promo.free_variant_id) {
        const { rows: variantRows } = await orgQuery(
          orgId,
          `SELECT pv.id, pv.name AS variant_name, pv.price, pv.is_active, p.name AS product_name
           FROM product_variants pv
           LEFT JOIN products p ON p.id = pv.product_id AND p.organization_id = $2
           WHERE pv.id = $1 AND pv.organization_id = $2 LIMIT 1`,
          [promo.free_variant_id, orgId],
        );
        const v = variantRows[0] as { id: string; variant_name: string; price: string; is_active: boolean; product_name: string | null } | undefined;
        if (!v || !v.is_active) {
          // The free variant was deactivated or deleted — treat the promo
          // as unusable rather than silently giving away a different item.
          return NextResponse.json({ valid: false, reason: "Free item is no longer available", promo });
        }
        freePreview = {
          variantId: v.id,
          productName: v.product_name ?? "Free Item",
          variantName: v.variant_name,
          unitPrice: Number(v.price),
        };
      }

      return NextResponse.json({ valid: true, promo, discountAmount, freePreview });
    }

    // ── Lookup by ID with redemptions ──
    const id = sp.get("id");
    if (id) {
      // R27-C11: explicit organization_id filter. Without it, an owner
      // could look up any tenant's promo by id. Also gate redemptions
      // via JOIN to promo_codes.
      const promo = await orgQuery(orgId, `SELECT id, organization_id, code, description, type, value, minimum_purchase, max_redemptions, current_redemptions, status, starts_at, expires_at, free_variant_id FROM promo_codes WHERE id = $1 AND organization_id = $2`, [id, orgId]);
      if (promo.rows.length === 0) {
        return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
      }

      const redemptions = await orgQuery(
        orgId,
        `SELECT pr.*, e.display_name AS employee_name
         FROM promo_redemptions pr
         JOIN promo_codes pc ON pc.id = pr.promo_code_id AND pc.organization_id = $2
         LEFT JOIN employees e ON e.id = pr.employee_id AND e.organization_id = $2
         WHERE pr.promo_code_id = $1
         ORDER BY pr.created_at DESC`,
        [id, orgId],
      );

      return NextResponse.json({ promo: promo.rows[0], redemptions: redemptions.rows });
    }

    // ── List all ──
    // R27-C11: explicit organization_id filter. Without it, owners at
    // any tenant read every other tenant's promo codes + values.
    // R30-C3: static org predicate in base SQL; dynamic clause only
    // adds status filter.
    const status = sp.get("status");
    const andStatus = status ? " AND status = $2" : "";
    const params: unknown[] = status ? [orgId, status] : [orgId];

    const codes = await orgQuery(
      orgId,
      `SELECT id, organization_id, code, description, type, value, minimum_purchase, max_redemptions, current_redemptions, status, starts_at, expires_at, free_variant_id, created_at FROM promo_codes WHERE organization_id = $1${andStatus} ORDER BY created_at DESC`,
      params,
    );

    return NextResponse.json({ promoCodes: codes.rows });
  } catch (err) {
    console.error("GET /api/promo-codes error:", safeErr(err));
    return NextResponse.json({ error: "Failed to fetch promo codes" }, { status: 500 });
  }
});

/**
 * POST /api/promo-codes
 *
 * Body: { action, ... }
 *   action: "create" — { code, description?, type (fixed|percent|bogo), value, minimumPurchase, maxRedemptions, startsAt, expiresAt? }
 *   action: "redeem" — { promoCodeId, transactionId, employeeId, discountAmount }
 *   action: "disable" — { promoCodeId }
 */
export const POST = withAdminAuth("pricing.manage", async (req, ctx) => {
  const { orgId, employee } = ctx;
  // R30-M4: cap promo CRUD. 30 per 5 min comfortably covers legitimate
  // bulk code provisioning but blocks a compromised pricing.manage
  // session from grinding the redeem branch to mint effectively-
  // unlimited discounts on accomplice transactions.
  const rl = checkRateLimit(`promo-codes:${orgId}:${employee.id}`, { maxAttempts: 30, windowMs: 300_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many promo-code operations. Try again shortly." }, { status: 429 });
  }
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "create") {
      const v = validateBody(promoCodeSchema, body);
      if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
      const { code, description, type, value, minimumPurchase, maxRedemptions, maxRedemptionsPerCustomer, startsAt, expiresAt, freeVariantId } = v.data;

      // R49 / R56-C: step-up re-auth on high-risk promo creations.
      // A 50%+ percent-off promo with no redemption cap is cash-
      // equivalent minting — an attacker with a stolen manager
      // cookie could issue "FREEFORALL 100% off, unlimited" then
      // redeem against accomplice carts. Gate only the high-risk
      // shapes so routine 10%-off codes stay frictionless.
      //
      // R56-C fixes two R55 bypasses:
      //   1. Fixed-discount liability $50+ was NOT previously gated —
      //      an attacker could POST {type:'fixed', value:1000, ...}
      //      without step-up. Add the fixed-≥50 arm.
      //   2. "Unlimited redemptions" was gated on null/undefined
      //      only, but the admin UI transforms `maxRedemptions=0`
      //      to `10_000_000` sentinel before sending (the Zod schema
      //      requires positive, so 0 isn't representable). The
      //      sentinel slid past the gate entirely. Treat any value
      //      ≥ 1_000_000 as effectively unbounded.
      const isUnbounded = maxRedemptions === null || maxRedemptions === undefined || Number(maxRedemptions) >= 1_000_000;
      const isHighValueFixed = type === 'fixed' && Number(value) >= 50;
      const isHighPercent = type === 'percent' && Number(value) >= 50;
      const isHighRiskPromo = isHighPercent || isHighValueFixed || isUnbounded;
      if (isHighRiskPromo) {
        const { requireStepUp } = await import('@/lib/auth/step-up');
        const stepUp = await requireStepUp({
          actorId: employee.id,
          orgId,
          actorPassword: (body as { actorPassword?: string }).actorPassword,
          bucketKey: 'promo-code-create-stepup',
        });
        if (!stepUp.ok) {
          return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
        }
      }

      // R27-C11: explicit organization_id filter on the variant
      // existence check. Without it, freeVariantId could reference
      // another tenant's variant — either a pricing-intel leak or
      // a crafted FK that lands a foreign variant on this tenant's
      // promo.
      if (type === "free_item") {
        const { rows: variantRows } = await orgQuery(
          orgId,
          `SELECT id, is_active FROM product_variants WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [freeVariantId, orgId],
        );
        const v0 = variantRows[0] as { id: string; is_active: boolean } | undefined;
        if (!v0) {
          return NextResponse.json({ error: "freeVariantId does not exist in this organization" }, { status: 400 });
        }
        if (!v0.is_active) {
          return NextResponse.json({ error: "freeVariantId refers to an inactive variant" }, { status: 400 });
        }
      }

      // R27-C11: per-tenant uniqueness check (migration 034 made the
      // unique index per-org; the prior SELECT blocked legitimate
      // cross-tenant code reuse AND leaked foreign code existence).
      const existing = await orgQuery(orgId, `SELECT id FROM promo_codes WHERE LOWER(code) = LOWER($1) AND organization_id = $2`, [code, orgId]);
      if (existing.rows.length > 0) {
        return NextResponse.json({ error: `Promo code "${code}" already exists` }, { status: 409 });
      }

      const promoId = randomUUID();
      // R49: wrap INSERT + audit in one orgTx. Prior shape used orgQuery
      // for the INSERT then post-commit pgInsertAuditEvent via
      // waitUntilOrAwait — if the audit-write failed, the promo
      // existed with no audit trail. 100%-off promos are cash-
      // equivalent minting; audit drop is a direct fraud-evidence gap.
      const client = await orgTx(orgId);
      try {
        // R28-M6: new max_redemptions_per_customer column (NULL = unlimited).
        await client.query(
          `INSERT INTO promo_codes (id, organization_id, code, description, type, value, minimum_purchase, max_redemptions, max_redemptions_per_customer, current_redemptions, status, starts_at, expires_at, free_variant_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'active', $10, $11, $12, now(), now())`,
          [
            promoId, orgId, code.toUpperCase(), description || null, type, value,
            minimumPurchase || 0, maxRedemptions ?? null, maxRedemptionsPerCustomer ?? null,
            startsAt, expiresAt || null,
            type === "free_item" ? freeVariantId : null,
          ],
        );
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'promo_code', $5, 'promo_code_created', $6, now())`,
          [
            randomUUID(), orgId, null, employee.id, promoId,
            JSON.stringify({
              code: code.toUpperCase(),
              type,
              value: String(value),
              minimum_purchase: String(minimumPurchase || 0),
              max_redemptions: maxRedemptions ?? null,
              max_redemptions_per_customer: maxRedemptionsPerCustomer ?? null,
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

      invalidateStoreCache(orgId);
      return NextResponse.json({ id: promoId, code: code.toUpperCase(), status: "active" }, { status: 201 });
    }

    if (action === "redeem") {
      // Free-item promos aren't redeemed through this cart-discount path —
      // the register adds a $0 cart line and checkout-action writes the
      // promo_redemption inside the sale transaction. Going through this
      // endpoint would burn a redemption + bump current_redemptions
      // without adding the freebie line, silently corrupting accounting.
      // Reject here to surface the misuse early.
      const { promoCodeId, transactionId, subtotal } = body as {
        promoCodeId?: string; transactionId?: string; subtotal?: number;
      };
      if (!promoCodeId || !transactionId || typeof subtotal !== 'number' || subtotal < 0 || !Number.isFinite(subtotal)) {
        return NextResponse.json({ error: "promoCodeId, transactionId, and non-negative numeric subtotal required" }, { status: 400 });
      }
      // Cap subtotal — without it, a manager passing subtotal=1e9 could
      // bypass minimum_purchase checks and fabricate percent-discount
      // arithmetic that pollutes `promo_redemptions.discount_amount` and
      // downstream reports. $10M per redemption is well above any
      // legitimate single-cart subtotal. (R11-L-2)
      const MAX_SUBTOTAL = 10_000_000;
      if (subtotal > MAX_SUBTOTAL) {
        return NextResponse.json({ error: `subtotal exceeds ${MAX_SUBTOTAL}` }, { status: 400 });
      }

      const client = await orgTx(orgId);
      try {
        // R15-M-2: verify `transactionId` belongs to this org BEFORE writing
        // a `promo_redemptions` row referencing it. The FK on transaction_id
        // is tenant-agnostic (FK checks skip RLS), and the promo_redemptions
        // RLS policy scopes via promo_code → organization_id, not
        // transactions. Without this gate, a pricing.manage caller in org X
        // who knows/guesses a transaction_id from org Y can write a
        // redemption linking X's promo to Y's transaction — polluting
        // analytics + inflating X's current_redemptions. Same shape as
        // R14-H-4 (gift-cards customer_id) + R14-M-3 (transfers locations).
        // R29-C3: also pull customer_id from the txn so per-customer cap
        // can be enforced below.
        const txCheck = await client.query(
          `SELECT customer_id FROM transactions WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [transactionId, orgId],
        );
        if (txCheck.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "transaction_id does not exist in this organization" }, { status: 400 });
        }
        const txnCustomerId = (txCheck.rows[0]?.customer_id as string | null) ?? null;

        // R27-C11: explicit organization_id filter on the FOR UPDATE.
        // Without it, a POST with a foreign tenant's promoCodeId would
        // pass the transaction-id check (this tenant's txn), lock the
        // victim's promo, redeem it against our txn, and increment
        // their current_redemptions counter — a promo-depletion DoS.
        // R29-C3: select max_redemptions_per_customer so the per-customer
        // cap check below can enforce it here too. Without this column in
        // the SELECT, the register enforces the cap (checkout-action.ts)
        // but this admin-side redeem path silently bypassed it — letting
        // a pricing.manage holder mint unlimited redemptions of a capped
        // promo by driving the loop through /api/promo-codes.
        const pc = await client.query(
          `SELECT id, type, value, minimum_purchase, current_redemptions, max_redemptions,
                  max_redemptions_per_customer,
                  status, starts_at, expires_at
           FROM promo_codes WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [promoCodeId, orgId],
        );
        if (pc.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
        }
        const promo = pc.rows[0];
        const now = Date.now();
        // Free-item promos are redeemed atomically by the checkout path —
        // this endpoint would insert a $0 discount redemption without
        // actually giving away the variant, silently corrupting
        // current_redemptions counters. Reject early.
        if (promo.type === 'free_item') {
          await client.query("ROLLBACK");
          return NextResponse.json(
            { error: "Free-item promos must be applied through the register cart flow, not /redeem" },
            { status: 400 },
          );
        }
        if (promo.status !== 'active') {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Promo code is not active" }, { status: 400 });
        }
        if (promo.starts_at && new Date(promo.starts_at).getTime() > now) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Promo code is not yet active" }, { status: 400 });
        }
        if (promo.expires_at && new Date(promo.expires_at).getTime() < now) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Promo code has expired" }, { status: 400 });
        }
        if (promo.max_redemptions > 0 && promo.current_redemptions >= promo.max_redemptions) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Promo code is maxed out" }, { status: 400 });
        }
        // R29-C3: enforce per-customer cap on this server-side redeem path.
        // If the promo has a per-customer cap but the backing transaction
        // has no customer_id, refuse — otherwise the cap is bypassable by
        // guest-checking out in a loop. If customer_id IS set, count this
        // customer's prior redemptions and reject at cap.
        if (promo.max_redemptions_per_customer) {
          if (!txnCustomerId) {
            await client.query("ROLLBACK");
            return NextResponse.json(
              { error: "Promo requires an identified customer on the transaction" },
              { status: 400 },
            );
          }
          const { rows: priorRows } = await client.query(
            `SELECT COUNT(*)::int AS n
               FROM promo_redemptions pr
               JOIN transactions t ON t.id = pr.transaction_id
              WHERE pr.promo_code_id = $1
                AND t.customer_id = $2
                AND t.organization_id = $3`,
            [promoCodeId, txnCustomerId, orgId],
          );
          const prior = Number(priorRows[0]?.n ?? 0);
          if (prior >= Number(promo.max_redemptions_per_customer)) {
            await client.query("ROLLBACK");
            return NextResponse.json(
              { error: "Customer has reached the per-customer limit for this promo" },
              { status: 400 },
            );
          }
        }
        if (Number(promo.minimum_purchase) > 0 && subtotal < Number(promo.minimum_purchase) - 0.005) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: `Minimum purchase of ${formatCurrency(Number(promo.minimum_purchase))} required` }, { status: 400 });
        }

        // Compute discountAmount SERVER-SIDE from the promo's type and value.
        // Client-supplied amount is IGNORED — otherwise a $5 promo could be
        // redeemed as any amount.
        let discountAmount = 0;
        if (promo.type === 'fixed') {
          discountAmount = Math.min(Number(promo.value), subtotal);
        } else if (promo.type === 'percent') {
          const pct = Math.min(100, Math.max(0, Number(promo.value)));
          discountAmount = Number((subtotal * pct / 100).toFixed(2));
        } else if (promo.type === 'bogo') {
          // BOGO math is per-line; without line detail here just apply value as fixed.
          // The register UI should pre-compute and pass via `fixed` type instead.
          discountAmount = Math.min(Number(promo.value), subtotal);
        }
        discountAmount = Number(Math.max(0, discountAmount).toFixed(2));

        // Insert the redemption first; if the unique (promo_code_id,
        // transaction_id) index fires, it's a duplicate redemption attempt.
        try {
          await client.query(
            `INSERT INTO promo_redemptions (id, promo_code_id, transaction_id, employee_id, discount_amount, created_at)
             VALUES ($1, $2, $3, $4, $5, now())`,
            [randomUUID(), promoCodeId, transactionId, employee.id, discountAmount],
          );
        } catch (e) {
          const err = e as { code?: string };
          if (err.code === '23505') {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: "Promo already redeemed for this transaction" }, { status: 409 });
          }
          throw e;
        }

        // R27-C11: explicit org filter on the counter UPDATE.
        await client.query(
          `UPDATE promo_codes SET current_redemptions = current_redemptions + 1, updated_at = now()
           WHERE id = $1 AND organization_id = $2`,
          [promoCodeId, orgId],
        );

        // Auto-disable if maxed out (skip if unlimited)
        const newCount = Number(promo.current_redemptions) + 1;
        if (promo.max_redemptions > 0 && newCount >= promo.max_redemptions) {
          await client.query(
            `UPDATE promo_codes SET status = 'depleted', updated_at = now() WHERE id = $1 AND organization_id = $2`,
            [promoCodeId, orgId],
          );
        }

        // R47-M: audit the redemption INSIDE the tx. Prior shape had
        // zero audit_events entry for this path (create + disable
        // both audit; redeem was the gap). Attacker with pricing.
        // manage could drive repeat `redeem` calls through this admin
        // endpoint silently.
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'promo_code', $5, 'promo_code_redeemed', $6, now())`,
          [
            randomUUID(), orgId, null, employee.id, promoCodeId,
            JSON.stringify({
              transaction_id: transactionId,
              discount_amount: discountAmount,
              new_count: newCount,
            }),
          ],
        );

        await client.query("COMMIT");
        invalidateStoreCache(orgId);
        return NextResponse.json({
          redeemed: true,
          discountAmount,
          remainingUses: promo.max_redemptions > 0 ? promo.max_redemptions - newCount : null,
        });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    if (action === "disable") {
      const { promoCodeId } = body;
      if (!promoCodeId) {
        return NextResponse.json({ error: "promoCodeId required" }, { status: 400 });
      }

      // R49: wrap UPDATE + audit in one orgTx. Prior shape used orgQuery
      // for the UPDATE then post-commit pgInsertAuditEvent — a disable
      // action (e.g., owner pulls a honeypot promo before investigation)
      // with a missing audit row undermines the exact investigation it
      // would enable.
      const client = await orgTx(orgId);
      try {
        // R27-C11: explicit org filter on disable. Without it, any
        // pricing.manage-holder at any tenant could disable any other
        // tenant's promos — availability / revenue disruption.
        // R70-L2: RETURNING id + existence check so a bogus/cross-
        // tenant promoCodeId doesn't write a phantom audit row
        // referencing a non-existent promo. Prior shape emitted a
        // 'promo_code_disabled' event even when UPDATE affected 0
        // rows — log pollution + investigation noise.
        // R81-DB-L: idempotent — `AND status != 'disabled'` so a
        // repeat disable on an already-disabled promo returns
        // without writing a fresh audit row (every re-disable
        // previously emitted another promo_code_disabled event,
        // polluting the audit trail). Separate 404 for non-existent
        // from 200 idempotent for already-disabled.
        const exists = await client.query(
          `SELECT status FROM promo_codes WHERE id = $1 AND organization_id = $2 LIMIT 1`,
          [promoCodeId, orgId],
        );
        if (exists.rows.length === 0) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
        }
        if (exists.rows[0].status === 'disabled') {
          await client.query("ROLLBACK");
          return NextResponse.json({ id: promoCodeId, status: 'disabled', _idempotent: true });
        }
        const upd = await client.query(
          `UPDATE promo_codes SET status = 'disabled', updated_at = now() WHERE id = $1 AND organization_id = $2 AND status != 'disabled' RETURNING id`,
          [promoCodeId, orgId],
        );
        if (upd.rows.length === 0) {
          // Concurrent disable beat us — idempotent success.
          await client.query("ROLLBACK");
          return NextResponse.json({ id: promoCodeId, status: 'disabled', _idempotent: true });
        }
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'promo_code', $5, 'promo_code_disabled', $6, now())`,
          [randomUUID(), orgId, null, employee.id, promoCodeId, JSON.stringify({})],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      invalidateStoreCache(orgId);
      return NextResponse.json({ id: promoCodeId, status: "disabled" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("POST /api/promo-codes error:", safeErr(err));
    return NextResponse.json({ error: "Failed to process promo code action" }, { status: 500 });
  }
});
