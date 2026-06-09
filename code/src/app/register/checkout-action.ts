"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRegisterPermission } from "@/lib/authz";
import { mutateStore } from "@/lib/persistence/store";
import { orgTx } from "@/lib/supabase-rest";
import type { Cart, CheckoutResult, TenderLine } from "@/lib/cart/types";
import { computeTotals, checkOutCart, lineDiscountAmount } from "@/lib/cart/cart";
import { getRegisterConfig, readRegisterConfigWith } from "@/lib/config/register-config";
import { invalidateInventoryCache } from "@/lib/cache/inventory-cache";
import { mintActionReqId, logActionError } from "@/lib/logging/action-log";

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
  idempotencyKey?: string,
): Promise<CheckoutResult> {
  void approvedExceptions;
  const context = await requireRegisterPermission("register.open");
  // R31-H7: if the caller didn't thread an Idempotency-Key, derive a
  // deterministic one from (cart.id, orgId). Two concurrent submits
  // of the same cart (double-click on the POS, network retry) will
  // then hit the `ON CONFLICT (organization_id, idempotency_key) DO
  // NOTHING` path and the loser reads back the winner's row instead
  // of committing a duplicate transaction. The cart.id advisory lock
  // serializes the two calls; this dedupes their OUTPUT. The derived
  // key is stable across retries of the SAME submit and changes
  // when the cashier starts a new cart (cart.id rotates on clear).
  const effectiveIdempotencyKey =
    idempotencyKey ?? `cart:${context.employee.organizationId}:${cart.id}`;
  // R25-ops-H-2: correlation ID for this checkout. Surfaces in
  // structured error logs + response JSON so support can correlate
  // user reports with a specific failure. Cheap — one UUID alloc.
  const actionReqId = mintActionReqId();

  if (cart.items.length === 0) {
    redirect("/register?error=Cart+is+empty");
  }

  // SECURITY: validate every line item BEFORE any math or aggregation.
  // Without this, a crafted `cart.items[i] = { quantity: -5, ... }` flips
  // the inventory UPDATE sign and CREATES phantom stock (the cashier can
  // later sell or "return" it). The `Cart` type is client-controlled via
  // the server-action payload, so these fields need explicit re-validation
  // here even though TypeScript declares them as numbers.
  if (cart.items.length > 500) {
    redirect("/register?error=Cart+has+too+many+line+items");
  }
  for (const it of cart.items) {
    const q = Number(it.quantity);
    if (!Number.isInteger(q) || q <= 0 || q > 10_000) {
      redirect("/register?error=Invalid+line+quantity");
    }
    if (typeof it.productVariantId !== "string" || !/^[0-9a-f-]{36}$/i.test(it.productVariantId)) {
      redirect("/register?error=Invalid+line+variant");
    }
    // Bundle lines: validate UUID shape, reject overridePrice, reject
    // line-level discounts (bundles are already package-priced; discount
    // the whole cart via cart.discountAmount if you need to).
    if (it.bundleId !== undefined) {
      if (typeof it.bundleId !== "string" || !/^[0-9a-f-]{36}$/i.test(it.bundleId)) {
        redirect("/register?error=Invalid+bundle+id");
      }
      if (it.overridePrice !== undefined) {
        redirect("/register?error=Bundle+price+cannot+be+overridden");
      }
      if (it.lineDiscount !== undefined) {
        redirect("/register?error=Bundle+line+cannot+have+a+line+discount");
      }
    }
    // Free-item promo lines: must have promoCodeId as a UUID and
    // overridePrice=0. Quantity must be exactly 1 (no stacking freebies).
    // Line discount on a $0 line is nonsensical; reject.
    if (it.promoCodeId !== undefined) {
      if (typeof it.promoCodeId !== "string" || !/^[0-9a-f-]{36}$/i.test(it.promoCodeId)) {
        redirect("/register?error=Invalid+promo+code+id");
      }
      if (it.overridePrice !== 0) {
        redirect("/register?error=Free-item+line+must+have+overridePrice+0");
      }
      if (q !== 1) {
        redirect("/register?error=Free-item+line+quantity+must+be+1");
      }
      if (it.lineDiscount !== undefined) {
        redirect("/register?error=Free-item+line+cannot+have+a+line+discount");
      }
    }
  }

  if (tenders.length === 0) {
    redirect("/register?error=No+payment+method+provided");
  }

  // Reject non-positive, non-finite, or absurdly large tender amounts. A
  // negative gift_card tender would otherwise top up the card instead of
  // redeeming it (Number(balance) < negative is false; newBalance = balance -
  // negative = balance + |negative|).
  for (const t of tenders) {
    if (!Number.isFinite(t.amount) || t.amount <= 0 || t.amount > 10_000_000) {
      redirect("/register?error=Invalid+tender+amount");
    }
  }

  // --- Pre-compute derived cart state (sync, no DB) ---
  // Split cart lines into three categories — each has a distinct
  // validation + pricing path. Done up-front so we can hand id sets to
  // the tx's Promise.all below without re-walking the cart.
  const bundleLines = cart.items.filter((i) => i.bundleId);
  const freeItemLines = cart.items.filter((i) => !i.bundleId && i.promoCodeId);
  const regularLines = cart.items.filter((i) => !i.bundleId && !i.promoCodeId);
  const variantIds = Array.from(new Set([
    ...regularLines.map((i) => i.productVariantId),
    ...freeItemLines.map((i) => i.productVariantId),
  ]));
  const bundleIds = bundleLines.map((i) => i.bundleId!);
  const freePromoIds = Array.from(new Set(freeItemLines.map((i) => i.promoCodeId!)));
  const allModifierIds = new Set<string>();
  for (const item of cart.items) {
    if (Array.isArray(item.modifierIds)) {
      for (const id of item.modifierIds) {
        if (typeof id === "string") allModifierIds.add(id);
      }
    }
  }

  const transactionId = randomUUID();
  const primaryTenderType = tenders.length === 1 ? tenders[0].type : "split";

  // R35-P1: outer declarations so both branches can fill them; the final
  // return at the bottom uses these plus `transactionId`/`tenders`.
  let totals!: ReturnType<typeof computeTotals>;
  let changeDue = 0;
  let loyaltyPointsEarned = 0;
  let loyaltyPointsRedeemed = 0;

  if (isPg()) {
    const client = await orgTx(context.employee.organizationId);
    try {
      // Use transaction-scoped advisory lock — auto-releases on COMMIT/ROLLBACK,
      // preventing lock leaks if client.release() runs before explicit unlock.
      await client.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [cart.id],
      );

      // R35-P1 (perf): consolidate the three pre-tx pool handshakes onto
      // this one tx client. Before this round, checkout opened a fresh
      // Neon pool for each of: getRegisterConfig(), the customer
      // tax_exempt lookup, and the modifier price re-fetch — three
      // ~50-150ms WebSocket handshakes that now fold into the single
      // `orgTx` connect. Parallel with the existing variant/bundle/
      // promo/exception reads. Net savings ~150-400ms per checkout.
      const [
        regConfig,
        { rows: sessionRows },
        { rows: custTaxRows },
        { rows: modRows },
        { rows: variantRows },
        { rows: bundleRows },
        { rows: bundleItemRows },
        { rows: freePromoRows },
        { rows: excRows },
      ] = await Promise.all([
        // Register config (approval thresholds + loyalty) — reads organizations row
        readRegisterConfigWith(client, context.employee.organizationId),
        // Register session row-lock. FOR UPDATE so a concurrent close/cancel serializes.
        client.query(
          `SELECT id, status FROM register_sessions WHERE id = $1 FOR UPDATE`,
          [context.registerSession.id],
        ),
        // Customer tax_exempt — override client-claimed taxRate for tax-exempt customers.
        cart.customerId
          ? client.query(
              `SELECT tax_exempt FROM customers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
              [cart.customerId, context.employee.organizationId],
            )
          : Promise.resolve({ rows: [] as { tax_exempt: boolean }[] }),
        // R28-C3 server-side modifier re-pricing (org-scoped) — DB-authoritative
        // price over the client-supplied modifierTotal. See inline comment below.
        allModifierIds.size > 0
          ? client.query(
              `SELECT id, price FROM modifiers WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
              [Array.from(allModifierIds), context.employee.organizationId],
            )
          : Promise.resolve({ rows: [] as { id: string; price: string }[] }),
        // Variant prices + is_active (regular + free-item lines)
        variantIds.length > 0
          ? client.query(
              // Include is_active so we can reject deactivated variants
              // specifically on FREE-ITEM lines (admin may have pulled
              // the variant after the cashier added it to the cart).
              // Regular lines tolerate inactive variants if they existed
              // at add-time — matches historical behavior.
              // R26-F1: explicit org filter; variantIds comes from the
              // client-side cart so we MUST re-scope to caller's org.
              `SELECT id, price, is_active FROM product_variants
               WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
              [variantIds, context.employee.organizationId],
            )
          : Promise.resolve({ rows: [] as { id: string; price: string; is_active: boolean }[] }),
        // Bundle prices + is_active
        // R26-F1: explicit organization_id filters. `postgres` has
        // BYPASSRLS so the cart's bundleIds / freePromoIds coming
        // from client-supplied payload MUST be re-scoped to the
        // authenticated org — otherwise an attacker could include
        // another org's bundle id in their cart and get that bundle's
        // authoritative price.
        bundleIds.length > 0
          ? client.query(
              `SELECT id, bundle_price, is_active FROM product_bundles
               WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
              [bundleIds, context.employee.organizationId],
            )
          : Promise.resolve({ rows: [] as { id: string; bundle_price: string; is_active: boolean }[] }),
        // Bundle component breakdown (authoritative) — used for inventory decrement
        bundleIds.length > 0
          ? client.query(
              `SELECT bi.bundle_id, bi.product_variant_id, bi.quantity
                 FROM bundle_items bi
                 JOIN product_bundles pb ON pb.id = bi.bundle_id
                WHERE bi.bundle_id = ANY($1::uuid[]) AND pb.organization_id = $2`,
              [bundleIds, context.employee.organizationId],
            )
          : Promise.resolve({ rows: [] as { bundle_id: string; product_variant_id: string; quantity: number }[] }),
        // Promo rows for free-item lines (FOR UPDATE: serialize max_redemptions)
        freePromoIds.length > 0
          ? client.query(
              // Lock these rows so concurrent checkouts of the same promo
              // code can't both pass the max_redemptions check. The
              // bump-current_redemptions step below serializes on these
              // same rows.
              `SELECT id, type, status, value, minimum_purchase, max_redemptions,
                      max_redemptions_per_customer,
                      current_redemptions, starts_at, expires_at, free_variant_id
               FROM promo_codes
               WHERE id = ANY($1::uuid[]) AND organization_id = $2
               FOR UPDATE`,
              [freePromoIds, context.employee.organizationId],
            )
          : Promise.resolve({ rows: [] as {
              id: string; type: string; status: string; value: string;
              minimum_purchase: string; max_redemptions: number; current_redemptions: number;
              max_redemptions_per_customer: number | null;
              starts_at: string; expires_at: string | null; free_variant_id: string | null;
            }[] }),
        // Pending exception approvals for this register session.
        // register_session_id proves scope — the HMAC cookie verifies
        // caller possesses this specific session. No org filter needed
        // (adding one would require an extra JOIN for no gain).
        // check-pool-org-filter: scoped-by-register-session-cookie
        client.query(
          // R38-A-F2: also read `approved_amount` so consumers can
          // verify the applied amount doesn't exceed what the manager
          // approved. NULL approved_amount = unbounded (legacy row or
          // non-amount-scoped action type).
          `SELECT exception_code, approved_amount FROM register_session_exceptions
           WHERE register_session_id = $1 AND status = 'pending'
           AND (expires_at IS NULL OR expires_at > now())`,
          [context.registerSession.id],
        ),
      ]);

      // --- Validate register session still active (pre-check) ---
      if (sessionRows.length === 0 || sessionRows[0].status !== "active") {
        redirect("/register?error=Cart+already+checked+out");
      }

      // R79-DB-H1 (HIGH): serialize against closeShiftEnhancedAction.
      // register_sessions is locked above, but closeShiftEnhancedAction
      // (R76-DB-H2) takes FOR UPDATE on BOTH shifts AND
      // register_sessions. If the close wins the shift lock first,
      // aggregates cashSales, flips shifts.status='closed', commits —
      // we'd unblock on register_sessions, then INSERT transaction +
      // transaction_tenders for an already-closed shift (no status
      // check on the write path). Cash enters the drawer with zero
      // shift-variance ledger. Mirror /api/returns R77-DB-H1 +
      // register/return-action R78-SEC-H2 shape: FOR UPDATE SKIP
      // LOCKED on the open shift at this location; if the shift is
      // currently being closed, reject the checkout cleanly so the
      // cashier can wait for the next shift to open.
      const { rows: shiftLockRows } = await client.query(
        `SELECT id FROM shifts
           WHERE organization_id = $1 AND location_id = $2 AND status = 'open'
           ORDER BY opened_at DESC LIMIT 1
           FOR UPDATE SKIP LOCKED`,
        [context.employee.organizationId, context.location.id],
      );
      if (shiftLockRows.length === 0) {
        redirect("/register?error=Shift+is+closed+or+being+closed.+Ask+a+manager+to+open+the+next+shift.");
      }

      // --- Apply customer.tax_exempt override before computing totals ---
      // Without this lookup, migration 014's tax_exempt column has no live
      // consumer — tax-exempt customers are silently charged full tax, the
      // client shows $0 tax on the display, and the tendered amount mismatches.
      let taxRate = context.location?.taxRate ?? 0;
      if (cart.customerId && custTaxRows[0]?.tax_exempt === true) {
        taxRate = 0;
      }
      cart.taxRate = taxRate;

      // --- R28-C3 server-side modifier re-pricing ---
      //
      // `computeTotals(cart)` sums `item.modifierTotal * item.quantity` from
      // the CLIENT cart without DB verification. A cashier-as-attacker
      // submitting `items[i].modifierTotal = 0` (or any negative value)
      // while keeping real `modifierIds` reduces the grand total while
      // inventory still gets consumed at the cheese/add-on row — free
      // modifier upcharges, pocketed as cash differential.
      //
      // The offline-sync path fixed this (route.ts:401-406, 551-560); the
      // online path mirrors it now: fetch authoritative prices from
      // `modifiers` (org-scoped, above), then overwrite each line's
      // modifierTotal with the server-computed sum. The `modifierIds`
      // array is still client-supplied (the cashier chose which modifiers
      // to add), but the PRICE of each one comes from the DB.
      if (allModifierIds.size > 0) {
        const modifierPrices: Record<string, number> = {};
        for (const row of modRows as { id: string; price: string }[]) {
          modifierPrices[row.id] = Number(row.price) || 0;
        }
        // Overwrite each item's modifierTotal with the DB-authoritative sum.
        // A modifierId absent from the result set (stale client, cross-org
        // tampered id) contributes 0 — the org-scoped SELECT filters out
        // cross-tenant ids silently.
        for (const item of cart.items) {
          const ids = Array.isArray(item.modifierIds) ? item.modifierIds : [];
          const sum = ids.reduce((s, id) => s + (modifierPrices[id] ?? 0), 0);
          item.modifierTotal = Number(sum.toFixed(2));
        }
      } else {
        // No modifiers on this cart — zero out any stale client values so
        // negative/nonzero modifierTotal without a modifierIds[] entry
        // can't slip through.
        for (const item of cart.items) {
          item.modifierTotal = 0;
        }
      }

      // --- Server-side totals + derived money figures ---
      totals = computeTotals(cart);
      const thresholds = regConfig.approvalThresholds;

      // Percent discount applies to (subtotal + modifiers - lineDiscounts),
      // matching computeTotals() in lib/cart/cart.ts. Computing the threshold
      // check against subtotal only under-counts the actual dollar discount
      // whenever the cart has modifier upcharges, letting a cashier bypass the
      // manager-approval threshold on high-modifier carts.
      const lineDiscountsTotal = cart.items.reduce((s, i) => s + lineDiscountAmount(i), 0);
      const discountBase = Math.max(0, totals.subtotal + totals.modifiersTotal - lineDiscountsTotal);
      // R32-M-clamp: clamp `cart.discountAmount` at 0 BEFORE it enters the
      // threshold check. `computeTotals` clamps it for the real math
      // (R30-C4), but this pre-math threshold gate read the raw value. A
      // tampered client sending `discountAmount: -50` would pass `<=
      // thresholds.discountOver` trivially (even negative vs. threshold
      // comparison is ≤), skip manager approval, then have its negative
      // value clamped back to 0 by computeTotals. Net effect: no fraud,
      // but the approval gate was bypassed for free. Clamping here makes
      // the gate see the same value that reaches the grand-total math.
      // R34-D4: reject Infinity / NaN too. `Number.isFinite` gates both.
      const rawDiscountAmount = Number(cart.discountAmount) || 0;
      const clampedDiscountAmount = Number.isFinite(rawDiscountAmount)
        ? Math.max(0, rawDiscountAmount)
        : 0;
      const baseCartDiscountEffective = cart.discountMode === 'percent'
        ? Number((discountBase * Math.min(100, clampedDiscountAmount) / 100).toFixed(2))
        : clampedDiscountAmount;
      // R38-A-F1: include per-line discounts in the approval gate. The
      // prior shape only measured cart-level `baseCartDiscountEffective`
      // — a cashier applying 10× $100 items @ 95% line discount took
      // $950 off with zero approval because each line's discount was
      // invisible to the threshold check. Sum both surfaces and gate on
      // the combined dollar impact.
      const totalDiscountEffective = Number((baseCartDiscountEffective + lineDiscountsTotal).toFixed(2));
      const baseStoreCreditTendered = tenders.filter((t) => t.type === "store_credit").reduce((s, t) => s + t.amount, 0);
      const totalTendered = tenders.reduce((sum, t) => sum + t.amount, 0);

      // Change due comes only from cash overage
      const cashTendered = tenders.filter((t) => t.type === "cash").reduce((sum, t) => sum + t.amount, 0);
      const nonCashTendered = tenders.filter((t) => t.type !== "cash" && t.type !== "loyalty").reduce((sum, t) => sum + t.amount, 0);
      const loyaltyTendered = tenders.filter((t) => t.type === "loyalty").reduce((sum, t) => sum + t.amount, 0);
      const giftCardTendered = tenders.filter((t) => t.type === "gift_card").reduce((sum, t) => sum + t.amount, 0);
      const storeCreditTenderedTotal = baseStoreCreditTendered;
      // INT-AUDIT5-CRIT1: reject carts where non-cash + loyalty tenders
      // sum to MORE than the grand total. Non-cash tenders (gift card,
      // store credit, card, etc.) and loyalty redemption do NOT generate
      // change — only cash does. Prior shape allowed e.g. a $20 sale
      // tendered as { gift_card: $50, cash: $100 } to clear: cashPortion
      // clamped to 0 via Math.max, the cashier handed back $100 cash, and
      // the gift card was still debited the FULL $50. Customer effectively
      // converted $30 of gift-card balance into cashier-pocketable cash;
      // a malicious cashier could ring a $20 sale, charge the customer's
      // gift card $50, and skim $30 from the till. Reject before any
      // ledger row writes; cashier must re-enter the tender mix correctly.
      const nonCashPlusLoyalty = Number((nonCashTendered + loyaltyTendered).toFixed(2));
      if (nonCashPlusLoyalty > totals.grandTotal + 0.005) {
        redirect(`/register?error=Non-cash+tenders+exceed+sale+total`);
      }
      const cashPortion = Math.max(0, totals.grandTotal - nonCashTendered - loyaltyTendered);
      changeDue = cashTendered > cashPortion ? Number((cashTendered - cashPortion).toFixed(2)) : 0;

      // Loyalty calculations
      const loyaltyConfig = regConfig.loyalty;
      // Round earned points to nearest integer (standard loyalty rounding — no floor/ceil bias)
      // Policy: partial points are rounded to nearest; redemption rounds to nearest as well
      loyaltyPointsEarned = cart.customerId
        ? Math.round(totals.grandTotal * loyaltyConfig.earnRatePerDollar)
        : 0;
      // Redemption: round redemption to nearest whole point
      loyaltyPointsRedeemed = loyaltyTendered > 0 && cart.customerId
        ? Math.round(loyaltyTendered / loyaltyConfig.redemptionValuePerPoint)
        : 0;

      // R38-A-F2: retain approved_amount alongside exception_code so
      // threshold-gated consumers can verify `applied <= approved`.
      const pendingExceptionRows = excRows as Array<{ exception_code: string; approved_amount: string | number | null }>;
      const pendingExceptions = pendingExceptionRows.map((r) => r.exception_code);
      const approvedAmountByCode = new Map<string, number>();
      for (const r of pendingExceptionRows) {
        if (r.approved_amount !== null && r.approved_amount !== undefined) {
          // Use the MAX across duplicates (shouldn't happen under normal
          // flow; if there are multiple pending approvals for the same
          // code, grant the most permissive — still tighter than the
          // prior "unbounded" behavior).
          const n = Number(r.approved_amount);
          const prev = approvedAmountByCode.get(r.exception_code) ?? 0;
          if (Number.isFinite(n) && n > prev) {
            approvedAmountByCode.set(r.exception_code, n);
          }
        }
      }
      // Epsilon tolerance: an approved $55.00 should clear a computed
      // $55.00 even with floating-point noise. 1 cent of slack.
      const amountApprovedFor = (code: string, applied: number): boolean => {
        if (!pendingExceptions.includes(code)) return false;
        const approved = approvedAmountByCode.get(code);
        if (approved === undefined) return true; // NULL = unbounded legacy
        return applied <= approved + 0.01;
      };
      const dbPriceByVariant: Record<string, number> = {};
      const dbActiveByVariant: Record<string, boolean> = {};
      for (const row of variantRows as { id: string; price: string; is_active: boolean }[]) {
        dbPriceByVariant[row.id] = Number(row.price);
        dbActiveByVariant[row.id] = row.is_active;
      }

      const dbBundleById = new Map<string, { price: number; active: boolean }>();
      for (const row of bundleRows as { id: string; bundle_price: string; is_active: boolean }[]) {
        dbBundleById.set(row.id, { price: Number(row.bundle_price), active: row.is_active });
      }
      // Authoritative component breakdown keyed by bundle id. Used for
      // inventory decrement so no client-side list is trusted.
      const dbComponentsByBundle = new Map<string, { variantId: string; quantity: number }[]>();
      for (const r of bundleItemRows as { bundle_id: string; product_variant_id: string; quantity: number }[]) {
        const arr = dbComponentsByBundle.get(r.bundle_id) ?? [];
        arr.push({ variantId: r.product_variant_id, quantity: Number(r.quantity) });
        dbComponentsByBundle.set(r.bundle_id, arr);
      }

      // Promo-code lookup by id (for free-item line validation).
      interface PromoRow {
        id: string; type: string; status: string; value: string;
        minimum_purchase: string; max_redemptions: number; current_redemptions: number;
        // R28-M6: per-customer cap column (NULL when unlimited).
        max_redemptions_per_customer: number | null;
        starts_at: string; expires_at: string | null; free_variant_id: string | null;
      }
      const dbPromoById = new Map<string, PromoRow>();
      for (const row of freePromoRows as PromoRow[]) {
        dbPromoById.set(row.id, row);
      }

      // Validate regular lines: variant exists + price matches DB.
      let totalOverrideImpact = 0;
      for (const item of regularLines) {
        const dbPrice = dbPriceByVariant[item.productVariantId];
        if (dbPrice === undefined) {
          redirect(`/register?error=Unknown+product+variant`);
        }
        // R38-A-F11: reject deactivated variants on regular lines too,
        // not just free-item promo lines. Prior shape allowed a cashier
        // to check out a variant an admin had already pulled from the
        // catalog (recalled / discontinued SKU). Combined with price-
        // override approval, this was a path to move shrink goods off
        // the books at an attacker-chosen price.
        if (dbActiveByVariant[item.productVariantId] === false) {
          redirect(`/register?error=Product+is+no+longer+available`);
        }
        if (item.unitPrice !== dbPrice) {
          redirect(`/register?error=Price+tampering+detected`);
        }
        // R31-M2: negative overridePrice is never legitimate — every
        // math path treats overridePrice as the EFFECTIVE line price
        // and a negative value inflates grand_total via subtotal.
        // Rejection is stricter than the cart.ts clamp (defence in
        // depth against a client that bypasses cart.ts).
        if (item.overridePrice !== undefined && item.overridePrice < 0) {
          redirect(`/register?error=Invalid+price+override`);
        }
        if (item.overridePrice !== undefined && item.overridePrice !== dbPrice) {
          // R38-A-F2 / AUDIT9: accumulate the DOLLAR IMPACT of this override
          // (|dbPrice - overridePrice|, abs because overrides go up or down)
          // and gate the CART AGGREGATE below — not per line.
          totalOverrideImpact += Math.abs(dbPrice - item.overridePrice);
        }
      }
      // AUDIT9: price-override approval is amount-scoped and MUST be checked
      // in aggregate across the cart, mirroring discount_threshold. The prior
      // per-line check authorized up to the approved amount on EACH line, so a
      // single $X override approval unlocked $X of markdown on every regular
      // line (N lines = N x the approved amount of unapproved markdown).
      if (totalOverrideImpact > 0 && !amountApprovedFor("price_override", Number(totalOverrideImpact.toFixed(2)))) {
        redirect(`/register?error=Price+override+exceeds+approved+amount`);
      }

      // Validate free-item promo lines. Every check sources from the DB —
      // the client can claim anything but only lines backed by a live,
      // active, unexhausted promo whose free_variant_id matches this line
      // and whose minimum_purchase is met by the non-free subtotal will
      // be honored. Same-cart duplicates are already rejected by
      // `addFreeItem` on the client and by the UNIQUE constraint on
      // `promo_redemptions (promo_code_id, transaction_id)` below.
      //
      // "Spend $X" in a free-item promo is measured against what the
      // CUSTOMER pays pre-discount: subtotal + modifiers. Free lines
      // contribute 0 (overridePrice=0). Previously we used `totals.subtotal`
      // only, which rejected a $19 burger + $2 cheese for a $20 promo —
      // customer-perception was "I spent $21". Now includes modifiers so
      // the threshold behaves like customers expect.
      const nonFreeSubtotal = Number((totals.subtotal + totals.modifiersTotal).toFixed(2));
      const nowMs = Date.now();
      for (const line of freeItemLines) {
        const promo = dbPromoById.get(line.promoCodeId!);
        if (!promo) {
          redirect(`/register?error=Unknown+promo+code`);
        }
        if (promo.type !== "free_item") {
          redirect(`/register?error=Promo+code+is+not+a+free-item+promo`);
        }
        if (promo.status !== "active") {
          redirect(`/register?error=Promo+code+is+${promo.status}`);
        }
        if (promo.starts_at && new Date(promo.starts_at).getTime() > nowMs) {
          redirect(`/register?error=Promo+code+is+not+yet+active`);
        }
        if (promo.expires_at && new Date(promo.expires_at).getTime() < nowMs) {
          redirect(`/register?error=Promo+code+has+expired`);
        }
        if (promo.max_redemptions > 0 && promo.current_redemptions >= promo.max_redemptions) {
          redirect(`/register?error=Promo+code+has+reached+maximum+redemptions`);
        }
        // R28-M6: per-customer cap. Checks that THIS customer hasn't
        // already hit their personal limit for this promo. A single
        // accomplice customer was otherwise able to drain a global
        // max_redemptions tick by tick.
        // R29-C2: if the promo has a per-customer cap but the cart has
        // no customer attached, REFUSE the redemption. Prior shape
        // `&& cart.customerId` silently skipped the cap whenever no
        // customer was set — letting the accomplice ring up guest sales
        // in a loop to drain the free-item quota anyway. Promos with a
        // per-customer cap therefore require an identified customer.
        if (promo.max_redemptions_per_customer) {
          if (!cart.customerId) {
            redirect(`/register?error=Promo+requires+an+identified+customer`);
          }
          const perCustomerCap = Number(promo.max_redemptions_per_customer);
          const { rows: priorRows } = await client.query(
            `SELECT COUNT(*)::int AS n
               FROM promo_redemptions pr
               JOIN transactions t ON t.id = pr.transaction_id
              WHERE pr.promo_code_id = $1
                AND t.customer_id = $2
                AND t.organization_id = $3`,
            [promo.id, cart.customerId, context.employee.organizationId],
          );
          const prior = Number(priorRows[0]?.n ?? 0);
          if (prior >= perCustomerCap) {
            redirect(`/register?error=You+have+reached+the+per-customer+limit+for+this+promo`);
          }
        }
        if (promo.free_variant_id !== line.productVariantId) {
          redirect(`/register?error=Promo+free+variant+mismatch`);
        }
        // If the variant was deactivated between cart-add and checkout,
        // refuse to hand it out free. Without this an admin pulling a
        // variant from the catalog mid-sale still loses a unit of
        // inventory to the promo.
        if (dbActiveByVariant[line.productVariantId] === false) {
          redirect(`/register?error=Free+item+is+no+longer+available`);
        }
        if (nonFreeSubtotal < Number(promo.minimum_purchase)) {
          redirect(`/register?error=Cart+does+not+meet+minimum+purchase+for+promo`);
        }
        // unitPrice should reflect the variant's real price for display
        // (receipts, audit) — but we intentionally DON'T reject a mismatch
        // here because variants reprice occasionally and the customer
        // should still get the freebie. overridePrice=0 is what matters;
        // checkout-action.ts line-top security block already enforces it.
      }

      // Validate bundle lines: bundle exists, is active, unitPrice matches
      // the DB's bundle_price exactly, and has ≥1 components (defensive).
      for (const line of bundleLines) {
        const db = dbBundleById.get(line.bundleId!);
        if (!db) {
          redirect(`/register?error=Unknown+bundle`);
        }
        if (!db.active) {
          redirect(`/register?error=Bundle+is+not+active`);
        }
        if (line.unitPrice !== db.price) {
          redirect(`/register?error=Bundle+price+tampering+detected`);
        }
        const comps = dbComponentsByBundle.get(line.bundleId!) ?? [];
        if (comps.length === 0) {
          redirect(`/register?error=Bundle+has+no+components`);
        }
      }

      // R38-A-F1 + R38-A-F7: gate on combined (cart + line) discount
      // and use `>=` so a threshold set at $50 blocks a $50.00 discount
      // (prior `>` let exactly-threshold sneak through).
      // R38-A-F2: ALSO verify the manager-approved amount covers the
      // applied amount. A $55 approval no longer unlocks an arbitrary
      // discount — the consumer confirms `applied <= approved`.
      if (
        totalDiscountEffective >= thresholds.discountOver
        && !amountApprovedFor("discount_threshold", totalDiscountEffective)
      ) {
        redirect("/register?error=Discount+exceeds+threshold+or+approved+amount");
      }
      if (
        baseStoreCreditTendered >= thresholds.storeCreditIssuanceOver
        && !amountApprovedFor("store_credit_threshold", baseStoreCreditTendered)
      ) {
        redirect("/register?error=Store+credit+exceeds+threshold+or+approved+amount");
      }
      if (totalTendered < totals.grandTotal - 0.005) {
        redirect("/register?error=Insufficient+tender+amount");
      }
      if (totalTendered > totals.grandTotal * 10) {
        redirect("/register?error=Tender+amount+exceeds+reasonable+limit");
      }

      // 1. Transaction record (with optional idempotency key)
      // Insert via ON CONFLICT to close the idempotency race window. Two
      // concurrent requests with the same idempotency_key would otherwise both
      // see "no existing row" at line 32-43 and race to INSERT. The unique
      // index catches it at DB level; we return the winning row's ID.
      // R29-H1: persist points_earned so refunds reverse the exact
      // credit, not a recomputation against the live earn rate.
      const insertResult = await client.query(
        `INSERT INTO transactions (id, organization_id, location_id, register_session_id, employee_id, customer_id, cart_snapshot, subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered, change_due, status, idempotency_key, points_earned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'completed', $15, $16)
         ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          transactionId, context.employee.organizationId, context.location.id,
          context.registerSession.id, context.employee.id,
          // Populate customer_id so return / store-credit lookups can find the
          // customer; previously this column was always NULL for POS sales.
          cart.customerId ?? null,
          JSON.stringify(checkOutCart(cart)),
          totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal,
          primaryTenderType, totalTendered, changeDue,
          effectiveIdempotencyKey,
          loyaltyPointsEarned,
        ],
      );
      if (insertResult.rowCount === 0) {
        // R31-H7: we ALWAYS have an idempotency key now, so this
        // branch fires whenever a concurrent submit won the race.
        // Return the winner's row rather than committing a duplicate.
        const { rows: winner } = await client.query(
          `SELECT id, status FROM transactions WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [context.employee.organizationId, effectiveIdempotencyKey],
        );
        // R36-H2: guard ROLLBACK. We're RETURNING (not throwing) so the
        // outer catch block won't see this failure — skip the ROLLBACK
        // error if it fires, otherwise the caller gets a db error
        // instead of the duplicate-sale response.
        await client.query("ROLLBACK").catch(() => {});
        return {
          transactionId: winner[0]?.id as string,
          status: winner[0]?.status as string,
          duplicate: true,
        } as unknown as CheckoutResult;
      }

      // 2. Normalized tender lines — single round-trip INSERT via unnest
      // arrays. Saves ~30-80ms on split-tender checkouts vs a loop of N
      // sequential statements.
      const lastCashIdx = (() => {
        for (let i = tenders.length - 1; i >= 0; i--) {
          if (tenders[i].type === "cash") return i;
        }
        return -1;
      })();
      const tenderIds = tenders.map(() => randomUUID());
      const tenderTypes = tenders.map((t) => t.type);
      const tenderAmounts = tenders.map((t) => t.amount);
      const tenderMetas = tenders.map((_, i) =>
        JSON.stringify(i === lastCashIdx ? { change_due: changeDue.toFixed(2) } : {}),
      );
      await client.query(
        `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata)
         SELECT unnest($1::uuid[]), $2, unnest($3::text[]), unnest($4::numeric[]), unnest($5::jsonb[])`,
        [tenderIds, transactionId, tenderTypes, tenderAmounts, tenderMetas],
      );

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
            // Record bundle ids for reporting; empty string when no bundles
            // in the sale so the field is always present.
            bundle_ids: bundleLines.map((l) => l.bundleId).join(","),
          }),
        ],
      );

      // 4. Decrement inventory (batched) — with row lock + stock check to prevent oversell
      if (cart.items.length > 0) {
        // IMPORTANT: the SAME variant can appear on multiple cart lines
        // (same SKU with different modifiers → addItem keeps them separate
        // by modifier signature). PostgreSQL's UPDATE...FROM with two
        // delta rows matching the same inventory_levels row only applies
        // ONE of them and silently discards the other → oversell. Aggregate
        // by variant BEFORE touching the DB.
        //
        // Bundle lines: each bundle is a single cart line whose *components*
        // each consume inventory. We fold those into the same per-variant
        // total so a cart with (2× hat + 1× back-to-school bundle containing
        // 1 hat) correctly decrements 3 hats with one DB trip. Component
        // quantities come from the DB (dbComponentsByBundle), not the client
        // payload — see validation block above.
        const totalsByVariant = new Map<string, number>();
        for (const line of regularLines) {
          totalsByVariant.set(
            line.productVariantId,
            (totalsByVariant.get(line.productVariantId) ?? 0) + Number(line.quantity),
          );
        }
        for (const line of bundleLines) {
          const comps = dbComponentsByBundle.get(line.bundleId!) ?? [];
          for (const c of comps) {
            totalsByVariant.set(
              c.variantId,
              (totalsByVariant.get(c.variantId) ?? 0) + c.quantity * Number(line.quantity),
            );
          }
        }
        // Free-item lines consume inventory just like regular lines — the
        // customer is walking out with physical stock even though the
        // price is $0. Same aggregation + stock check applies.
        for (const line of freeItemLines) {
          totalsByVariant.set(
            line.productVariantId,
            (totalsByVariant.get(line.productVariantId) ?? 0) + Number(line.quantity),
          );
        }
        const aggVariantIds = Array.from(totalsByVariant.keys());
        const aggDecrements = aggVariantIds.map((id) => -(totalsByVariant.get(id) ?? 0));

        // Lock rows in product_variant order to avoid deadlocks.
        // R26-F1: explicit organization_id filter — location_id comes
        // from ctx but inventory_levels.organization_id is the DB-level
        // guarantee against cross-tenant inventory manipulation.
        const { rows: locked } = await client.query(
          `SELECT il.product_variant_id, il.on_hand
           FROM inventory_levels il
           WHERE il.product_variant_id = ANY($1::uuid[])
             AND il.location_id = $2
             AND il.organization_id = $3
           ORDER BY il.product_variant_id
           FOR UPDATE`,
          [aggVariantIds, context.location.id, context.employee.organizationId],
        );

        const onHandByVariant: Record<string, number> = {};
        for (const row of locked) {
          onHandByVariant[row.product_variant_id] = Number(row.on_hand);
        }

        // Check AGGREGATE stock per variant so two lines of qty=1 against
        // onHand=1 reject correctly.
        for (const [variantId, aggQty] of totalsByVariant) {
          const onHand = onHandByVariant[variantId] ?? 0;
          if (onHand < aggQty) {
            // R26-F1: variantId came from the client cart; filter by org.
            const { rows: skuRows } = await client.query(
              `SELECT sku FROM product_variants WHERE id = $1 AND organization_id = $2`,
              [variantId, context.employee.organizationId],
            );
            const sku = skuRows[0]?.sku ?? variantId;
            // R36-H2: no pre-redirect ROLLBACK. redirect() throws
            // NEXT_REDIRECT; the outer catch's guarded ROLLBACK handles
            // the tx cleanup. A pre-ROLLBACK without `.catch()` would
            // clobber the NEXT_REDIRECT with a db error and show the
            // user a generic 500.
            redirect(`/register?error=Insufficient+inventory+for+SKU+${sku}`);
          }
        }

        // Combined UPDATE-and-audit in one round-trip. See offline-sync for
        // the rationale — saves ~50ms per checkout.
        // R26-F1: explicit organization_id filter on the inventory
        // UPDATE. Without it, a crafted cart referencing another org's
        // variant_id at the same location would decrement that tenant's
        // inventory.
        await client.query(
          `WITH updated AS (
             UPDATE inventory_levels il
             SET on_hand = GREATEST(0, il.on_hand + delta.qty), updated_at = now()
             FROM (SELECT unnest($1::uuid[]) AS variant_id, unnest($2::int[]) AS qty) AS delta
             WHERE il.product_variant_id = delta.variant_id
               AND il.location_id = $3
               AND il.organization_id = $5
             RETURNING il.id AS inventory_level_id, il.product_variant_id, il.on_hand, delta.qty AS delta_qty
           )
           INSERT INTO inventory_adjustments
             (organization_id, inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand)
           SELECT $5, inventory_level_id, product_variant_id, $3, $4, 'sale', delta_qty, on_hand
           FROM updated`,
          [aggVariantIds, aggDecrements, context.location.id, context.employee.id, context.employee.organizationId],
        );
      }

      // 5. Update register session
      await client.query(
        `UPDATE register_sessions SET last_transaction_id = $1, last_cart_id = $2, updated_at = now() WHERE id = $3`,
        [transactionId, cart.id, context.registerSession.id],
      );

      // 5c. Record free-item promo redemptions + bump current_redemptions
      // on each promo. The `promo_codes` rows are already locked (FOR
      // UPDATE above) so the bump is serialized against concurrent
      // checkouts — no TOCTOU gap on max_redemptions. Unique index on
      // (promo_code_id, transaction_id) guards against double-redemption
      // of the same promo on the same transaction (e.g. retry).
      if (freeItemLines.length > 0) {
        for (const line of freeItemLines) {
          const promo = dbPromoById.get(line.promoCodeId!)!;
          // `discount_amount` on a free-item redemption = the variant's
          // retail price at the time of sale (what we "gave away"). Comes
          // from the cart line's unitPrice (which equals variant.price
          // the moment addFreeItem ran); server didn't re-enforce that
          // above — defensively clamp to the current DB price if that's
          // been updated between cart-add and checkout.
          const dbPrice = dbPriceByVariant[line.productVariantId] ?? Number(line.unitPrice);
          try {
            await client.query(
              `INSERT INTO promo_redemptions (id, promo_code_id, transaction_id, employee_id, discount_amount, created_at)
               VALUES ($1, $2, $3, $4, $5, now())`,
              [randomUUID(), promo.id, transactionId, context.employee.id, dbPrice],
            );
          } catch (e) {
            const err = e as { code?: string };
            if (err.code === "23505") {
              // duplicate redemption on this transaction (same promo
              // twice) — the cart helper should have prevented this, but
              // if it didn't, fail cleanly rather than silently double-
              // awarding.
              await client.query("ROLLBACK").catch(() => {});
              redirect("/register?error=Promo+already+redeemed+on+this+transaction");
            }
            throw e;
          }
          // R26-F1: explicit org filter. promo.id was loaded earlier
          // via an org-scoped SELECT but defense in depth.
          await client.query(
            `UPDATE promo_codes SET current_redemptions = current_redemptions + 1, updated_at = now()
             WHERE id = $1 AND organization_id = $2`,
            [promo.id, context.employee.organizationId],
          );
          // Audit event — fraud investigations need to correlate a cashier
          // with specific promo redemptions. Inside the checkout tx so it
          // rolls back with the sale if anything fails.
          await client.query(
            `INSERT INTO audit_events
               (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
             VALUES ($1, $2, $3, $4, 'promo_code', $5, 'promo_redeemed', $6, now())`,
            [
              randomUUID(), context.employee.organizationId, context.location.id,
              context.employee.id, promo.id,
              JSON.stringify({
                transaction_id: transactionId,
                discount_amount: dbPrice.toFixed(2),
                variant_id: line.productVariantId,
                register_session_id: context.registerSession.id,
              }),
            ],
          );
          // Auto-disable when maxed out (max_redemptions = 0 means unlimited).
          const nextCount = promo.current_redemptions + 1;
          if (promo.max_redemptions > 0 && nextCount >= promo.max_redemptions) {
            await client.query(
              `UPDATE promo_codes SET status = 'depleted', updated_at = now()
               WHERE id = $1 AND organization_id = $2`,
              [promo.id, context.employee.organizationId],
            );
          }
        }
      }

      // 5b. Consume any pending approvals so they can't be reused on the NEXT
      // checkout — NOR by offline-sync. Use a terminal 'consumed' status so
      // other read paths (offline-sync) won't see the row as still valid.
      //
      // Defensive check: RETURNING the count lets us detect the case where
      // another concurrent request (e.g., offline-sync) already burned the
      // same approvals between our pre-tx SELECT and this UPDATE — if so,
      // the threshold check we ran against `pendingExceptions` is stale and
      // we should abort rather than complete the sale with an approval the
      // DB no longer has.
      if (pendingExceptions.length > 0) {
        // check-pool-org-filter: scoped-by-register-session-id
        // register_session_id is the authenticated session (tenant-
        // verified via requireRegisterPermission above). The exceptions
        // table's only use site is consuming pending approvals on the
        // session that created them.
        const { rows: burned } = await client.query(
          `UPDATE register_session_exceptions
             SET status = 'consumed'
           WHERE register_session_id = $1
             AND status = 'pending'
             AND exception_code = ANY($2::text[])
             AND (expires_at IS NULL OR expires_at > now())
           RETURNING exception_code`,
          [context.registerSession.id, pendingExceptions],
        );
        // R28-L9: verify the SET of burned codes matches the requested
        // set, not just the length. Length-only comparison could pass
        // if duplicates landed in `pendingExceptions` and the DB
        // returned duplicates too (shouldn't happen under the unique
        // index but defense in depth).
        const burnedCodes = new Set((burned as { exception_code: string }[]).map((r) => r.exception_code));
        const missingCode = pendingExceptions.find((code) => !burnedCodes.has(code));
        if (burnedCodes.size !== new Set(pendingExceptions).size || missingCode) {
          await client.query("ROLLBACK").catch(() => {});
          redirect("/register?error=Approval+was+consumed+by+another+request");
        }
      }

      // 6. Audit event — inside the sale transaction so it rolls back
      // cleanly on any later failure AND reuses the already-open client
      // instead of spawning a fresh Neon pool after commit. Saves ~150-300ms
      // per checkout (one fewer WebSocket handshake).
      await client.query(
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
      );

      // 7. Update customer loyalty, spend, visits — lock row first to prevent double-awarding
      // if two concurrent checkouts award points for the same customer (e.g. same
      // offline+online txn syncing, or a retry). Step 7b (store credit) also locks this
      // row; Postgres queues the locks so both updates are serialised correctly.
      if (cart.customerId) {
        // Filter by is_active so a deactivated customer can't be used at
        // checkout (loyalty/store credit mutations). Reading via FOR UPDATE
        // locks the row for the atomic UPDATE below. R11-H-3.
        const { rows: customerRows } = await client.query(
          `SELECT loyalty_points, store_credit_balance FROM customers
           WHERE id = $1 AND organization_id = $2 AND is_active = true FOR UPDATE`,
          [cart.customerId, context.employee.organizationId],
        );
        if (customerRows.length === 0) {
          // R36-H2: outer catch handles ROLLBACK.
          redirect(`/register?error=Customer+not+found+or+inactive`);
        }
        const currentCustomer = customerRows[0];
        const currentPoints = Number(currentCustomer?.loyalty_points ?? 0);
        if (loyaltyPointsRedeemed > currentPoints) {
          // R36-H2: outer catch handles ROLLBACK.
          redirect(`/register?error=Insufficient+loyalty+points`);
        }
        await client.query(
          `UPDATE customers SET
            loyalty_points = loyalty_points - $1 + $2,
            total_spend = total_spend + $3,
            visit_count = visit_count + 1,
            updated_at = now()
          WHERE id = $4 AND organization_id = $5`,
          [loyaltyPointsRedeemed, loyaltyPointsEarned, totals.grandTotal, cart.customerId, context.employee.organizationId],
        );

        // 7b. Deduct store credit if used — verify sufficient balance before deducting
        if (storeCreditTenderedTotal > 0) {
          const currentBalance = Number(currentCustomer?.store_credit_balance ?? 0);
          if (currentBalance < storeCreditTenderedTotal) {
            // R36-H2: outer catch handles ROLLBACK.
            redirect(`/register?error=Insufficient+store+credit+balance`);
          }
          const newBalance = currentBalance - storeCreditTenderedTotal;
          // R26-F1: explicit org filter. Though the FOR UPDATE SELECT
          // above is already org-scoped, the UPDATE key (cart.customerId)
          // is client-supplied, so we re-scope on write too.
          await client.query(
            `UPDATE customers SET store_credit_balance = $1, updated_at = now()
             WHERE id = $2 AND organization_id = $3`,
            [newBalance, cart.customerId, context.employee.organizationId],
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
          // Lock row AND scope the SELECT to this org (defence-in-depth
          // against a future RLS regression) AND reject expired cards.
          // Status column isn't auto-flipped to 'expired' by any
          // scheduled job, so we check expires_at in SQL explicitly.
          const { rows: gcRows } = await client.query(
            `SELECT balance, status, expires_at
             FROM gift_cards
             WHERE id = $1 AND organization_id = $2
             FOR UPDATE`,
            [tender.metadata.gift_card_id, context.employee.organizationId],
          );
          const card = gcRows[0];
          // R36-H2: outer catch handles ROLLBACK for every failure path
          // below. Unguarded pre-ROLLBACK would clobber NEXT_REDIRECT
          // on connection drop / already-aborted tx.
          if (!card) {
            redirect(`/register?error=Gift+card+not+found`);
          }
          if (card.status !== 'active') {
            redirect(`/register?error=Gift+card+is+${card.status}`);
          }
          if (card.expires_at && new Date(card.expires_at).getTime() < Date.now()) {
            redirect(`/register?error=Gift+card+has+expired`);
          }
          if (Number(card.balance) < tender.amount) {
            // R36-H2: outer catch handles ROLLBACK.
            redirect(`/register?error=Gift+card+insufficient+balance`);
          }
          const newBalance = Number(card.balance) - tender.amount;
          // R26-F1: explicit organization_id filter. gift_card_id comes
          // from the client tender payload.
          await client.query(
            `UPDATE gift_cards SET balance = $1,
               status = CASE WHEN $1 <= 0 THEN 'depleted' ELSE 'active' END,
               updated_at = now()
             WHERE id = $2 AND organization_id = $3`,
            [newBalance, tender.metadata.gift_card_id, context.employee.organizationId],
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
      // Guard: Next.js redirect() throws a special "NEXT_REDIRECT" object
      // with a `digest` prop that the framework catches to perform the
      // redirect. Don't let a ROLLBACK error (e.g. already-rolled-back)
      // clobber the redirect. Also wrap ROLLBACK in .catch() so a driver
      // error never replaces the original exception with a 500.
      await client.query("ROLLBACK").catch(() => {});
      // R25-ops-H-2: before R25 this server action had zero console.error
      // calls. A checkout that 500'd on prod produced no log line — just
      // a generic React error boundary client-side. Emit a structured
      // JSON log with the cart + tender shape so support can correlate
      // user reports ("my cart froze at 3:14pm") with a specific failure.
      // NEXT_REDIRECT is NOT an error and must not be logged — filter
      // on the framework's internal sentinel shape.
      const digest = (e as { digest?: string })?.digest;
      if (!digest || !digest.startsWith("NEXT_REDIRECT")) {
        logActionError(
          {
            action: "checkout",
            reqId: actionReqId,
            orgId: context.employee.organizationId,
            employeeId: context.employee.id,
            registerSessionId: context.registerSession?.id,
            cartId: cart.id,
            itemCount: cart.items.length,
            tenderCount: tenders.length,
            idempotencyKey,
          },
          e,
        );
      }
      throw e;
    } finally {
      // pg_advisory_xact_lock auto-releases on COMMIT/ROLLBACK — no manual unlock needed.
      client.release();
    }
  } else {
    // --- Non-isPg / JSON fallback path (dev + test only) ---
    const regConfig = await getRegisterConfig(context.employee.organizationId);
    cart.taxRate = context.location?.taxRate ?? 0;
    // No customer tax_exempt / modifier re-fetch on this path — those
    // fields don't exist in the JSON store.
    for (const item of cart.items) {
      // JSON path mirrors the PG path: zero out stale client modifier
      // totals when no IDs are attached, otherwise trust client (JSON
      // store has no modifiers table).
      if (!Array.isArray(item.modifierIds) || item.modifierIds.length === 0) {
        item.modifierTotal = 0;
      }
    }

    totals = computeTotals(cart);
    const thresholds = regConfig.approvalThresholds;
    const loyaltyConfig = regConfig.loyalty;

    // JSON fallback: coarse check only (no row lock available)
    if (cart.status !== "open") {
      redirect("/register?error=Cart+already+checked+out");
    }

    const lineDiscountsTotal = cart.items.reduce((s, i) => s + lineDiscountAmount(i), 0);
    const discountBase = Math.max(0, totals.subtotal + totals.modifiersTotal - lineDiscountsTotal);
    const rawDiscountAmount = Number(cart.discountAmount) || 0;
    const clampedDiscountAmount = Number.isFinite(rawDiscountAmount)
      ? Math.max(0, rawDiscountAmount)
      : 0;
    const baseCartDiscountEffective = cart.discountMode === 'percent'
      ? Number((discountBase * Math.min(100, clampedDiscountAmount) / 100).toFixed(2))
      : clampedDiscountAmount;
    // R38-A-F1: same combined-discount gate as the isPg branch.
    const totalDiscountEffective = Number((baseCartDiscountEffective + lineDiscountsTotal).toFixed(2));
    const baseStoreCreditTendered = tenders.filter((t) => t.type === "store_credit").reduce((s, t) => s + t.amount, 0);
    const totalTendered = tenders.reduce((sum, t) => sum + t.amount, 0);

    // JSON path: no exception approvals possible, so threshold checks always apply
    if (totalDiscountEffective >= thresholds.discountOver) {
      redirect("/register?error=Discount+exceeds+threshold+without+manager+approval");
    }
    if (baseStoreCreditTendered >= thresholds.storeCreditIssuanceOver) {
      redirect("/register?error=Store+credit+exceeds+threshold+without+manager+approval");
    }
    if (totalTendered < totals.grandTotal - 0.005) {
      redirect("/register?error=Insufficient+tender+amount");
    }
    // Upper bound: reject absurd over-tendering (e.g. $10k cash on a $20 transaction).
    // Allow up to 10× the total as the sane ceiling — change will be given back.
    if (totalTendered > totals.grandTotal * 10) {
      redirect("/register?error=Tender+amount+exceeds+reasonable+limit");
    }

    const cashTendered = tenders.filter((t) => t.type === "cash").reduce((sum, t) => sum + t.amount, 0);
    const nonCashTendered = tenders.filter((t) => t.type !== "cash" && t.type !== "loyalty").reduce((sum, t) => sum + t.amount, 0);
    const loyaltyTendered = tenders.filter((t) => t.type === "loyalty").reduce((sum, t) => sum + t.amount, 0);
    const giftCardTendered = tenders.filter((t) => t.type === "gift_card").reduce((sum, t) => sum + t.amount, 0);
    const storeCreditTenderedTotal = baseStoreCreditTendered;
    const cashPortion = Math.max(0, totals.grandTotal - nonCashTendered - loyaltyTendered);
    changeDue = cashTendered > cashPortion ? Number((cashTendered - cashPortion).toFixed(2)) : 0;

    loyaltyPointsEarned = cart.customerId
      ? Math.round(totals.grandTotal * loyaltyConfig.earnRatePerDollar)
      : 0;
    loyaltyPointsRedeemed = loyaltyTendered > 0 && cart.customerId
      ? Math.round(loyaltyTendered / loyaltyConfig.redemptionValuePerPoint)
      : 0;

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
          if (loyaltyPointsRedeemed > customer.loyaltyPoints) {
            redirect("/register?error=Insufficient+loyalty+points");
          }
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
  invalidateInventoryCache(context.employee.organizationId);
  // R84-hand: invalidate admin-side store cache so dashboards +
  // sales reports pick up the new transaction within the next read.
  // Prior shape left admin views stale for up to 30s TTL after
  // every register sale. Pairs with R82-DB-H1/H2 fixes that made
  // register-side data correctly visible to admin analytics.
  const { invalidateStoreCache } = await import("@/lib/persistence/postgres-read-store");
  invalidateStoreCache(context.employee.organizationId);
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
