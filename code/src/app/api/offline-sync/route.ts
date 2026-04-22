import { NextResponse } from "next/server";
import { randomUUID } from "@/lib/uuid";
import { orgTx } from "@/lib/supabase-rest";
import { withDualAuth } from "@/lib/api/with-auth";
import { readRegisterConfigWith } from "@/lib/config/register-config";
import type { RegisterConfig } from "@/lib/config/register-config";
import { validateBody, offlineSyncSchema } from "@/lib/validation/schemas";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";
import { invalidateInventoryCache } from "@/lib/cache/inventory-cache";

import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
/**
 * Distinguishes a "cart is no longer valid" condition from a generic
 * server error. Offline-sync retries indefinitely on 5xx; it needs a 4xx
 * for conditions the client can't recover by retrying (promo was
 * deactivated, expired, depleted, or the cart's free-item line references
 * a variant the promo no longer points at).
 */
class PromoRevalidationError extends Error {
  constructor(public reason: string, public promoId: string) {
    super(`Promo revalidation failed: ${reason} (promo ${promoId})`);
    this.name = "PromoRevalidationError";
  }
}

interface CartPayload {
  employeeId?: string;
  registerSessionId?: string;
  customerId?: string;
  loyaltyPointsEarned?: number;
  discountMode?: 'percent' | 'fixed';
  discountAmount?: number;
  items?: CartLineItem[];
  [key: string]: unknown;
}

interface CartLineItem {
  productVariantId: string;
  quantity: number;
  overridePrice?: number;
  unitPrice?: number;
  modifierTotal?: number;
  lineDiscount?: {
    mode: 'percent' | 'fixed';
    value: number;
  };
  /** Present iff this line is a bundle. See src/lib/cart/types.ts. */
  bundleId?: string;
  bundleComponents?: { productVariantId: string; quantity: number }[];
  /** Present iff this line is a free-with-purchase promo redemption. */
  promoCodeId?: string;
  [key: string]: unknown;
}

/**
 * POST /api/offline-sync
 *
 * Receives a transaction that was completed offline and persists it to Postgres.
 * This mirrors the logic in checkout-action.ts but works from a serialized payload
 * rather than requiring a live session.
 */
export const POST = withDualAuth("register.open", async (request, ctx) => {
  const { orgId, registerSession } = ctx;
  const authCtx = registerSession;
  if (!authCtx?.employee) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const raw = await request.json();
    const v = validateBody(offlineSyncSchema, raw);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const body = v.data;
    const { id, timestamp: rawTimestamp, registerSessionId, approvedExceptions: rawApprovedExceptions = [] } = body;
    const cart = body.cart as CartPayload;
    const tenders = body.tenders as Array<{ type: string; amount: number }>;
    // approvedExceptions: we ACCEPT only those codes that have a matching
    // pending/approved row in register_session_exceptions for THIS register
    // session and still within its expiry. The client can claim anything but
    // we only honor server-verified exceptions — matching the online checkout
    // validation path. Verification happens after sessionId is resolved below.
    let approvedExceptions: string[] = [];

    // Clamp client-supplied timestamp to a reasonable window:
    //  - reject future timestamps (> now + 5min clock skew)
    //  - reject stale offline carts (> 7 days old)
    // Without this, an attacker could backdate to evade return windows or
    // future-date to pollute reports.
    const now = Date.now();
    const MAX_CLOCK_SKEW_MS = 5 * 60_000;
    const MAX_STALE_MS = 7 * 24 * 3_600_000;
    let timestamp: string | undefined = rawTimestamp;
    if (timestamp) {
      const ts = new Date(timestamp).getTime();
      if (!Number.isFinite(ts)) {
        timestamp = undefined;
      } else if (ts > now + MAX_CLOCK_SKEW_MS) {
        return NextResponse.json({ error: 'Offline timestamp cannot be in the future' }, { status: 400 });
      } else if (ts < now - MAX_STALE_MS) {
        return NextResponse.json({ error: 'Offline timestamp is too old (> 7 days)' }, { status: 400 });
      }
    }

    // cart is an object { items, employeeId, registerSessionId, discountMode, discountAmount, ... }
    // tenders is an array [{ tenderType, amount }, ...]
    if (!cart || typeof cart !== 'object' || Array.isArray(cart)) {
      return NextResponse.json({ error: 'Invalid sync payload: cart must be an object' }, { status: 400 });
    }
    if (!Array.isArray(tenders)) {
      return NextResponse.json({ error: 'Invalid sync payload: tenders must be an array' }, { status: 400 });
    }
    if (tenders.length === 0) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }
    // Structural validation — offlineSyncSchema uses z.unknown() for tenders,
    // so we validate shape + sign + finiteness here before any arithmetic.
    const ALLOWED_TENDER_TYPES = new Set(['cash', 'card', 'store_credit', 'loyalty', 'gift_card']);
    for (const t of tenders) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        return NextResponse.json({ error: 'Invalid tender entry' }, { status: 400 });
      }
      const tt = t as { type?: unknown; amount?: unknown };
      if (typeof tt.type !== 'string' || !ALLOWED_TENDER_TYPES.has(tt.type)) {
        return NextResponse.json({ error: 'Invalid tender type' }, { status: 400 });
      }
      if (typeof tt.amount !== 'number' || !Number.isFinite(tt.amount) || tt.amount <= 0 || tt.amount > 10_000_000) {
        return NextResponse.json({ error: 'Invalid tender amount' }, { status: 400 });
      }
    }

    // ── Auth: validate registerSessionId against cookie-backed session ──────────
    // `withDualAuth` already resolved the register session from the cookie
    // (authCtx.registerSession) and mapped it to the caller's employee +
    // location. The client-supplied `registerSessionId` must match the
    // resolved one — otherwise a cashier could forge someone else's session
    // id in the payload. No DB round-trip needed; the resolved authCtx is
    // authoritative.
    //
    // Dropping this redundant SELECT saves one Neon pool per offline-sync
    // call. Under the prior simulation that was enough to push Worker CPU
    // over the Cloudflare 1102 limit during bursty syncs.
    const resolvedRegisterSessionId = authCtx.registerSession?.id;
    const suppliedSessionId = registerSessionId || cart.registerSessionId || null;

    if (!suppliedSessionId) {
      return NextResponse.json({ error: "registerSessionId is required" }, { status: 401 });
    }
    if (!resolvedRegisterSessionId || suppliedSessionId !== resolvedRegisterSessionId) {
      return NextResponse.json({ error: "Register session mismatch" }, { status: 403 });
    }
    const sessionId = resolvedRegisterSessionId;
    // R32-H9: attribute to the CAPTURE-TIME employee, not the sync-time
    // session employee. Prior shape pulled `sessionEmployeeId =
    // authCtx.employee.id` from the cookie at sync time — so Alice's
    // offline sales, synced while Bob is logged in on the same
    // terminal, landed under Bob's employee_id. Shift reports, audit
    // trail, and commissions all pointed at the wrong actor.
    //
    // Trust model: the OFFLINE cart carries cart.employeeId (from
    // usePOSTerminal at capture time). We require it, AND verify that
    // it belongs to this org and was assigned to the registering
    // location at capture time. If it doesn't match or can't be
    // verified, we reject the sync — better than attributing to the
    // wrong actor. Capture-time employee is the one liable for
    // whatever transpired during the offline session.
    const capturedEmployeeId = (cart.employeeId as string | undefined) ?? undefined;
    if (!capturedEmployeeId || !/^[0-9a-f-]{36}$/i.test(capturedEmployeeId)) {
      return NextResponse.json(
        { error: "Offline cart missing capture-time employeeId" },
        { status: 400 },
      );
    }
    // Validate capture-time employee belongs to this org (the cookie's
    // authCtx already proved it's a valid session in this org, so
    // checking the cart's employeeId is cheap defense-in-depth).
    // R34-D9 + R36-H4: REJECT offline sales where the capture-time
    // employee has since been deactivated. Prior shape (R34-D9) logged
    // a warning and accepted, reasoning that the employee WAS the
    // actor at sale time. But offline capture timestamps are
    // client-controlled, so we can't reliably distinguish "legit
    // pending sale from before termination" from "post-termination
    // fraud on an uncollected offline device." The safer default is
    // to refuse any offline sale whose capture-time employee is now
    // inactive; a manager must manually re-enter real pending sales
    // that were captured just before deactivation. Mirrors the
    // online-path defense (customers.is_active = true filter) and the
    // audit-flagged exploit: fired cashier + offline-capable device
    // = unbounded fraud window.
    {
      const { rows: capEmpRows } = await (await import('@/lib/supabase-rest')).orgQuery(
        orgId,
        `SELECT is_active FROM employees WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [capturedEmployeeId, orgId],
      );
      if (capEmpRows.length === 0) {
        return NextResponse.json(
          { error: "Offline cart's employee is not in this organization" },
          { status: 403 },
        );
      }
      if ((capEmpRows[0] as { is_active?: boolean }).is_active === false) {
        console.warn(
          `[offline-sync] capture-time employee ${capturedEmployeeId} is deactivated; sync rejected`,
        );
        return NextResponse.json(
          { error: "Offline cart's employee is deactivated; sync rejected. A manager must manually re-enter this sale." },
          { status: 403 },
        );
      }
    }
    const sessionEmployeeId = capturedEmployeeId;

    // Derive locationId from register session context
    const locationId = authCtx.location.id;

    // Server-side verification of approvedExceptions: only keep codes that
    // actually have a matching row in register_session_exceptions. Without
    // this filter, a compromised client could set
    //   approvedExceptions: ["price_override", "discount_threshold", "store_credit_threshold"]
    // in the sync payload and bypass all manager approval thresholds.
    //
    // CRITICAL: earlier this was an UPDATE that auto-committed here, so any
    // subsequent reject (unknown variant, tender mismatch, inventory
    // shortage, etc.) permanently burned the manager approval without
    // persisting a transaction — the cashier's retry would then fail the
    // threshold checks. Now we only READ the pending codes up front and
    // defer the burn to inside the main syncClient transaction, so any
    // rollback un-burns the approval atomically.
    // PERF: run ALL pre-tx reads on ONE shared Neon client to cut
    // handshake cost. Previously each `orgQuery` opened a fresh one-shot
    // pool (tax rate, variant prices, modifier prices) — 3-4 handshakes
    // per call before the main write tx even started. On Cloudflare
    // Workers this burst was the primary driver of intermittent 1102
    // "Worker exceeded CPU time" errors during load tests.
    const items = cart.items || [];

    // SECURITY: validate every line item BEFORE any aggregation or pricing.
    // Without this, a negative quantity (e.g., `{variant: A, quantity: -5}`)
    // flips the UPDATE delta sign and INCREMENTS inventory — phantom stock
    // the cashier can later sell or "return" for cash. `offlineSyncSchema`
    // treats `cart` as `z.unknown()` so fields are untyped here.
    //
    // Upper-bound qty at 10,000 per line and cap total lines at 500 — these
    // are well above any legitimate POS cart and bound the CPU cost of
    // subsequent loops on the now-30s Workers budget.
    if (!Array.isArray(items) || items.length > 500) {
      return NextResponse.json({ error: "Invalid cart: too many line items" }, { status: 400 });
    }
    for (const it of items) {
      const q = Number((it as { quantity?: unknown }).quantity);
      if (!Number.isInteger(q) || q <= 0 || q > 10_000) {
        return NextResponse.json(
          { error: "Invalid cart: line quantity must be a positive integer" },
          { status: 400 },
        );
      }
      const pid = (it as { productVariantId?: unknown }).productVariantId;
      if (typeof pid !== "string" || !/^[0-9a-f-]{36}$/i.test(pid)) {
        return NextResponse.json(
          { error: "Invalid cart: missing/invalid productVariantId" },
          { status: 400 },
        );
      }
      // Bundle lines have extra constraints — mirror checkout-action.ts.
      const bid = (it as { bundleId?: unknown }).bundleId;
      if (bid !== undefined) {
        if (typeof bid !== "string" || !/^[0-9a-f-]{36}$/i.test(bid)) {
          return NextResponse.json({ error: "Invalid cart: invalid bundleId" }, { status: 400 });
        }
        if ((it as { overridePrice?: unknown }).overridePrice !== undefined) {
          return NextResponse.json({ error: "Invalid cart: bundle line cannot have overridePrice" }, { status: 400 });
        }
        if ((it as { lineDiscount?: unknown }).lineDiscount !== undefined) {
          return NextResponse.json({ error: "Invalid cart: bundle line cannot have lineDiscount" }, { status: 400 });
        }
      }
      // Free-item promo lines — must carry a valid promoCodeId, override
      // exactly $0, quantity 1, no line discount. Mirrors checkout-action.
      const pcid = (it as { promoCodeId?: unknown }).promoCodeId;
      if (pcid !== undefined) {
        if (typeof pcid !== "string" || !/^[0-9a-f-]{36}$/i.test(pcid)) {
          return NextResponse.json({ error: "Invalid cart: invalid promoCodeId" }, { status: 400 });
        }
        if ((it as { overridePrice?: unknown }).overridePrice !== 0) {
          return NextResponse.json({ error: "Invalid cart: free-item line must have overridePrice 0" }, { status: 400 });
        }
        if (q !== 1) {
          return NextResponse.json({ error: "Invalid cart: free-item line quantity must be 1" }, { status: 400 });
        }
        if ((it as { lineDiscount?: unknown }).lineDiscount !== undefined) {
          return NextResponse.json({ error: "Invalid cart: free-item line cannot have lineDiscount" }, { status: 400 });
        }
      }
    }

    // Split lines: bundle lines price against product_bundles; free-item
    // lines price against promo_codes (value-to-give-away); regular lines
    // price against product_variants. Each has its own validation path.
    const bundleLines: CartLineItem[] = items.filter((i: CartLineItem) => !!i.bundleId);
    const freeItemLines: CartLineItem[] = items.filter((i: CartLineItem) => !i.bundleId && !!i.promoCodeId);
    const regularLines: CartLineItem[] = items.filter((i: CartLineItem) => !i.bundleId && !i.promoCodeId);

    let subtotal = 0;
    const m = (v: number) => Number(v.toFixed(2));
    // Variant prices are needed for regular lines AND for free-item lines
    // (we quote the "gave away" dollar value by reading the current price).
    const variantIds = Array.from(new Set([
      ...regularLines.map((i) => i.productVariantId),
      ...freeItemLines.map((i) => i.productVariantId),
    ]));
    const bundleIds = bundleLines.map((i) => i.bundleId!);
    const freePromoIds = Array.from(new Set(freeItemLines.map((i) => i.promoCodeId!)));
    const allModifierIds = new Set<string>();
    for (const item of items) {
      const maybeIds = (item as unknown as { modifierIds?: unknown }).modifierIds;
      if (Array.isArray(maybeIds)) {
        for (const x of maybeIds as unknown[]) {
          if (typeof x === "string") allModifierIds.add(x);
        }
      }
    }

    let taxRate = 0.1025; // default fallback
    const serverPrices: Record<string, number> = {};
    const serverVariantActive: Record<string, boolean> = {};
    const modifierPrices: Record<string, number> = {};
    const serverBundlePrices: Record<string, { price: number; active: boolean }> = {};
    const serverBundleComponents: Record<string, { variantId: string; quantity: number }[]> = {};
    interface ServerPromoRow {
      id: string; type: string; status: string;
      minimum_purchase: number; max_redemptions: number; current_redemptions: number;
      starts_at: string; expires_at: string | null; free_variant_id: string | null;
    }
    const serverPromoById: Record<string, ServerPromoRow> = {};
    let regConfig: RegisterConfig | null = null;
    {
      const preClient = await orgTx(orgId);
      let preReadFailed = false;
      let preReadError: unknown = null;
      try {
        // Tax rate lookup — defaults to location rate, but drops to 0 when
        // the attached customer is flagged tax_exempt. Mirrors checkout-
        // action.ts's R10-H-2 fix. If the customerId in the queued offline
        // cart doesn't belong to this org, the earlier R8-C-5 org scope
        // catches it — we return null and fall back to location rate only.
        // R27: explicit org filter. locationId is server-derived
        // (context), but BYPASSRLS-era defense-in-depth demands it.
        const { rows: locRows } = await preClient.query(
          `SELECT tax_rate FROM locations WHERE id = $1 AND organization_id = $2`,
          [locationId, orgId],
        );
        if (locRows[0]?.tax_rate != null) {
          taxRate = Number(locRows[0].tax_rate);
        }
        if (cart.customerId) {
          // R16-H-2: reject foreign-tenant customer_id. Previously this
          // query just read tax_exempt; a tampered offline cart with a
          // customerId from org Y would sync through org X and land a
          // transaction row linking X's sale to Y's customer (FK is
          // tenant-agnostic). Now reject explicitly.
          const { rows: custRows } = await preClient.query(
            `SELECT tax_exempt FROM customers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
            [cart.customerId, orgId],
          );
          if (custRows.length === 0) {
            await preClient.query("ROLLBACK").catch(() => {});
            return NextResponse.json(
              { error: "customer_id does not exist in this organization" },
              { status: 400 },
            );
          }
          if (custRows[0].tax_exempt === true) {
            taxRate = 0;
          }
        }
        // Authoritative variant prices (can't trust client-supplied prices).
        // Also track is_active so free-item lines can reject a freshly
        // deactivated variant at validation time.
        if (variantIds.length > 0) {
          // R27: explicit org filter. Without it, a crafted offline
          // cart with foreign variantIds pulled ORG B's prices and
          // active-flags into this sync — pricing intel leak.
          const { rows: priceRows } = await preClient.query(
            `SELECT id, price, is_active FROM product_variants WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
            [variantIds, orgId],
          );
          for (const row of priceRows) {
            const r = row as Record<string, unknown>;
            serverPrices[r.id as string] = Number(r.price);
            serverVariantActive[r.id as string] = r.is_active as boolean;
          }
        }
        // Authoritative bundle prices + components. Same rationale as variant
        // prices — never trust the client payload.
        if (bundleIds.length > 0) {
          // R27: explicit org filter on both queries. bundle_items is
          // FK-scoped via product_bundles — JOIN through.
          const [{ rows: bRows }, { rows: biRows }] = await Promise.all([
            preClient.query(
              `SELECT id, bundle_price, is_active FROM product_bundles WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
              [bundleIds, orgId],
            ),
            preClient.query(
              `SELECT bi.bundle_id, bi.product_variant_id, bi.quantity
               FROM bundle_items bi
               JOIN product_bundles pb ON pb.id = bi.bundle_id
               WHERE bi.bundle_id = ANY($1::uuid[]) AND pb.organization_id = $2`,
              [bundleIds, orgId],
            ),
          ]);
          for (const row of bRows) {
            const r = row as Record<string, unknown>;
            serverBundlePrices[r.id as string] = {
              price: Number(r.bundle_price),
              active: r.is_active as boolean,
            };
          }
          for (const row of biRows) {
            const r = row as Record<string, unknown>;
            const bid = r.bundle_id as string;
            const arr = serverBundleComponents[bid] ?? [];
            arr.push({ variantId: r.product_variant_id as string, quantity: Number(r.quantity) });
            serverBundleComponents[bid] = arr;
          }
        }
        // Authoritative promo rows for any free-item lines. Unlike the
        // online checkout path we do NOT take FOR UPDATE here — the row
        // lock is re-acquired inside the main syncClient tx below so
        // offline-sync doesn't hold locks across the pre-read and the
        // write paths.
        if (freePromoIds.length > 0) {
          // R27: explicit org filter. Without it, crafted free-item
          // lines could reference foreign promo codes.
          const { rows: promoRows } = await preClient.query(
            `SELECT id, type, status, minimum_purchase, max_redemptions, current_redemptions,
                    starts_at, expires_at, free_variant_id
             FROM promo_codes WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
            [freePromoIds, orgId],
          );
          for (const row of promoRows) {
            const r = row as Record<string, unknown>;
            serverPromoById[r.id as string] = {
              id: r.id as string,
              type: r.type as string,
              status: r.status as string,
              minimum_purchase: Number(r.minimum_purchase),
              max_redemptions: Number(r.max_redemptions),
              current_redemptions: Number(r.current_redemptions),
              starts_at: String(r.starts_at),
              expires_at: r.expires_at ? String(r.expires_at) : null,
              free_variant_id: (r.free_variant_id as string | null) ?? null,
            };
          }
        }
        // Batch modifier-price lookup
        if (allModifierIds.size > 0) {
          // R27: explicit org filter on modifiers.
          const { rows: modRows } = await preClient.query(
            `SELECT id, price FROM modifiers WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
            [Array.from(allModifierIds), orgId],
          );
          for (const row of modRows) {
            const r = row as Record<string, unknown>;
            modifierPrices[r.id as string] = Number(r.price) || 0;
          }
        }
        // Pending manager-approval codes. Folded into the pre-tx block
        // (was its own orgQuery = separate pool) so all 4 reads share one
        // WebSocket handshake. The actual burn (UPDATE → 'consumed') still
        // happens inside the main syncClient tx so it rolls back on any
        // later failure — preserving the "no approvals lost on failed
        // sync" guarantee.
        if (Array.isArray(rawApprovedExceptions) && rawApprovedExceptions.length > 0 && sessionId) {
          // check-pool-org-filter: scoped-by-register-session-id
          // sessionId is the authenticated register session id from
          // the session cookie — tenant-verified.
          const { rows: pendingRows } = await preClient.query(
            `SELECT exception_code FROM register_session_exceptions
             WHERE register_session_id = $1
               AND status = 'pending'
               AND exception_code = ANY($2::text[])
               AND (expires_at IS NULL OR expires_at > now())`,
            [sessionId, rawApprovedExceptions],
          );
          approvedExceptions = pendingRows.map((r: { exception_code: string }) => r.exception_code);
        }
        // Register config (approval thresholds, loyalty earn rate). On
        // Workers the per-isolate cache in getRegisterConfig is ~useless
        // (each request gets a fresh isolate) so folding it onto the
        // shared pre-tx client saves ~100-200ms per offline-sync.
        regConfig = await readRegisterConfigWith(preClient, orgId);
        await preClient.query("COMMIT");
      } catch (err) {
        await preClient.query("ROLLBACK").catch(() => {});
        preReadFailed = true;
        preReadError = err;
      } finally {
        preClient.release();
      }
      if (preReadFailed) {
        // CRITICAL: if ANY of the three reads failed we could have PARTIAL
        // data — e.g. tax_rate set but modifier prices empty. Falling
        // through with partial data produces a lower grand_total than the
        // register receipt. Bail out with 503 so the client retries
        // cleanly instead of silently undercharging the customer.
        console.error("[offline-sync] pre-tx read failed:", safeErr(preReadError));
        // Try to write an audit row so operators see the degradation.
        // employeeId is required (NOT NULL in audit_events), use the
        // cashier resolved from the register session above.
        await waitUntilOrAwait(pgInsertAuditEvent(
          orgId, locationId, sessionEmployeeId,
          "transaction", id, "transaction_placeholder",
          { reason: "offline_sync_pre_read_failed", error: preReadError instanceof Error ? preReadError.message : String(preReadError) },
        ).catch(() => {}));
        return NextResponse.json(
          { error: "Temporary server error — retry in a moment" },
          { status: 503 },
        );
      }
    }

    let discountTotal = 0;
    let modifiersTotal = 0;

    for (const item of items) {
      // Bundle lines: validated against product_bundles, no modifiers, no
      // line-discount. unitPrice must equal the DB's bundle_price.
      if (item.bundleId) {
        const srv = serverBundlePrices[item.bundleId];
        if (!srv) {
          return NextResponse.json({ error: "Unknown bundle in offline cart" }, { status: 400 });
        }
        if (!srv.active) {
          return NextResponse.json({ error: "Bundle is not active" }, { status: 400 });
        }
        if (item.unitPrice !== srv.price) {
          return NextResponse.json({ error: "Bundle price tampering detected" }, { status: 400 });
        }
        const comps = serverBundleComponents[item.bundleId] ?? [];
        if (comps.length === 0) {
          return NextResponse.json({ error: "Bundle has no components" }, { status: 400 });
        }
        subtotal = m(subtotal + m(srv.price * item.quantity));
        continue;
      }

      // Free-item promo lines: validate against promo_codes. unitPrice is
      // NOT checked against the variant price (variants reprice; the
      // customer still gets the freebie). overridePrice=0 is authoritative
      // and the subtotal contribution is 0. The minimum_purchase check
      // happens after the loop since we need the full non-free subtotal.
      if (item.promoCodeId) {
        const promo = serverPromoById[item.promoCodeId];
        if (!promo) {
          return NextResponse.json({ error: "Unknown promo code in offline cart" }, { status: 400 });
        }
        if (promo.type !== "free_item") {
          return NextResponse.json({ error: "Promo code is not a free-item promo" }, { status: 400 });
        }
        if (promo.status !== "active") {
          return NextResponse.json({ error: `Promo code is ${promo.status}` }, { status: 400 });
        }
        const nowMs = Date.now();
        if (promo.starts_at && new Date(promo.starts_at).getTime() > nowMs) {
          return NextResponse.json({ error: "Promo code is not yet active" }, { status: 400 });
        }
        if (promo.expires_at && new Date(promo.expires_at).getTime() < nowMs) {
          return NextResponse.json({ error: "Promo code has expired" }, { status: 400 });
        }
        if (promo.max_redemptions > 0 && promo.current_redemptions >= promo.max_redemptions) {
          return NextResponse.json({ error: "Promo code has reached maximum redemptions" }, { status: 400 });
        }
        if (promo.free_variant_id !== item.productVariantId) {
          return NextResponse.json({ error: "Promo free variant mismatch" }, { status: 400 });
        }
        // Variant deactivated between the offline save and this sync —
        // don't hand out stock an admin deliberately pulled. Terminal;
        // the sync-service will dead-letter once retriable=false lands.
        if (serverVariantActive[item.productVariantId] === false) {
          return NextResponse.json(
            { error: "Free item is no longer available", retriable: false },
            { status: 409 },
          );
        }
        // Free line contributes 0 to subtotal (overridePrice=0).
        continue;
      }

      // Use server price; only allow overridePrice if approval was stored server-side
      // for this register_session_exceptions (not trusted from client payload).
      // IMPORTANT: distinguish "variant not found" (legitimate reject) from
      // "price is 0" (legitimate free/promo item). `?? 0` used to collapse
      // both into the same branch and block every $0 item from syncing.
      const hasServerPrice = Object.prototype.hasOwnProperty.call(serverPrices, item.productVariantId);
      if (!hasServerPrice) {
        return NextResponse.json({ error: "Unknown product variant in offline cart" }, { status: 400 });
      }
      const serverPrice = serverPrices[item.productVariantId];
      // Reject price tampering unless server has an approved price_override exception
      // tied to this register session (same validation path as online checkout).
      // R31-M2: negative overridePrice is never legitimate. The
      // online checkout-action rejects with "Invalid price override"
      // — mirror that here for offline carts.
      if (item.overridePrice != null && item.overridePrice < 0) {
        return NextResponse.json({ error: "Invalid price override" }, { status: 400 });
      }
      const hasApprovedOverride = item.overridePrice != null && approvedExceptions.includes("price_override");
      if (item.unitPrice !== serverPrice && !hasApprovedOverride) {
        return NextResponse.json({ error: "Price tampering detected in offline cart" }, { status: 400 });
      }
      const effectivePrice = hasApprovedOverride ? item.overridePrice! : serverPrice;
      const lineBase = m(effectivePrice * item.quantity);
      // Server-side modifier pricing: sum the authoritative `price` from modifiers
      // referenced by the cart line. A missing modifier ID (stale client) → 0.
      // This closes the attack where a client claims $0 modifierTotal for a $5 add-on.
      const maybeIds = (item as unknown as { modifierIds?: unknown }).modifierIds;
      const modifierIds = Array.isArray(maybeIds)
        ? (maybeIds as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      let modifierSum = 0;
      for (const modifierId of modifierIds) {
        modifierSum += modifierPrices[modifierId] ?? 0;
      }
      const lineMods = m(modifierSum * item.quantity);
      let lineDiscount = 0;

      if (item.lineDiscount) {
        // R30-C4: clamp lineDiscount.value at 0 — a negative value would
        // produce a negative discount that inflates grand_total and
        // enables the refund/store_credit inflation exploit.
        const clampedVal = Math.max(0, Number(item.lineDiscount.value) || 0);
        if (item.lineDiscount.mode === "percent") {
          lineDiscount = m(lineBase * Math.min(100, clampedVal) / 100);
        } else {
          lineDiscount = m(Math.min(clampedVal, lineBase));
        }
      }

      subtotal = m(subtotal + lineBase);
      modifiersTotal = m(modifiersTotal + lineMods);
      discountTotal = m(discountTotal + lineDiscount);
    }

    // Free-item promo: minimum_purchase check must use the NON-FREE
    // subtotal. The loop above already skips free-item lines from the
    // subtotal accumulation (overridePrice=0, continue), so `subtotal`
    // here is exactly what we need.
    // "Spend $X" is measured against subtotal + modifiers (what the
    // customer actually pays pre-discount), NOT raw subtotal. Kept in
    // sync with checkout-action.ts so online + offline behavior agree.
    const freeItemThresholdBase = m(subtotal + modifiersTotal);
    for (const line of freeItemLines) {
      const promo = serverPromoById[line.promoCodeId!];
      // The main validation already ran above; this just re-checks the
      // min_purchase once we know the final subtotal.
      if (promo && freeItemThresholdBase < promo.minimum_purchase) {
        return NextResponse.json(
          { error: "Cart does not meet minimum purchase for promo" },
          { status: 400 },
        );
      }
    }

    // Cart-level discount — must match computeTotals() in lib/cart/cart.ts.
    // Percent base is (subtotal + modifiers - lineDiscounts), NOT subtotal only.
    // Without this alignment, an offline cart synced later produces a different
    // grand_total than the register receipt the customer was handed.
    // R30-C4 + R34-D4: clamp cart.discountAmount at 0, reject
    // Infinity/NaN. A tampered offline payload could otherwise set
    // `discountAmount: -50` or `Infinity` and inflate grand_total.
    // This mirrors the same clamp in src/lib/cart/cart.ts:computeTotals.
    const rawDiscountAmount = Number(cart.discountAmount) || 0;
    const clampedCartDiscountAmount = Number.isFinite(rawDiscountAmount)
      ? Math.max(0, rawDiscountAmount)
      : 0;
    const afterLineDiscounts = Math.max(0, subtotal + modifiersTotal - discountTotal);
    const rawCartDiscount = cart.discountMode === "percent"
      ? m(afterLineDiscounts * Math.min(100, clampedCartDiscountAmount) / 100)
      : Math.min(clampedCartDiscountAmount, afterLineDiscounts);
    const cartDiscount = m(rawCartDiscount);
    // Clamp combined discount to prevent rounding from pushing grand total negative
    const rawTotalDiscount = discountTotal + cartDiscount;
    discountTotal = m(Math.min(rawTotalDiscount, subtotal + modifiersTotal));

    const taxableAmount = Math.max(0, subtotal + modifiersTotal - discountTotal);
    const taxTotal = Number((taxableAmount * taxRate).toFixed(2));
    const grandTotal = Number((taxableAmount + taxTotal).toFixed(2));

    // ── Server-side approval enforcement — mirrors checkout-action.ts ──────────
    // `regConfig` is already loaded inside the pre-tx block above (shared
    // client). If that fails it's null; getRegisterConfig's defaults apply.
    if (!regConfig) {
      // Fallback only if pre-tx block somehow skipped (shouldn't happen
      // because failure returns 503 above) — keeps `thresholds` defined.
      const { getRegisterConfig } = await import("@/lib/config/register-config");
      regConfig = await getRegisterConfig(orgId);
    }
    const thresholds = regConfig.approvalThresholds;
    // R38-A-F1: gate on the COMBINED discount (`discountTotal` at this
    // point contains both line-level and cart-level discounts, per
    // line 684 above). Prior shape only read `cartDiscount`, so a
    // cashier could take unlimited `lineDiscount: {mode:'percent',
    // value:95}` off every line and the approval gate never fired.
    // R38-A-F7: use `>=` so a threshold set at $50 blocks an exactly-
    // $50 discount.
    if (discountTotal >= thresholds.discountOver && !approvedExceptions.includes("discount_threshold")) {
      return NextResponse.json({ error: "Cart discount exceeds threshold without manager approval" }, { status: 403 });
    }
    const storeCreditTendered = tenders
      .filter((t: { type: string }) => t.type === "store_credit")
      .reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    if (storeCreditTendered >= thresholds.storeCreditIssuanceOver && !approvedExceptions.includes("store_credit_threshold")) {
      return NextResponse.json({ error: "Store credit issuance exceeds threshold without manager approval" }, { status: 403 });
    }

    const totalTendered = tenders.reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    // Tender sufficiency checks — mirror online checkout
    if (totalTendered < grandTotal - 0.005) {
      return NextResponse.json({ error: "Insufficient tender amount in offline cart" }, { status: 400 });
    }
    // On a zero-total cart, ANY non-zero tender is outside the reasonable limit.
    // Without this check, a free-item cart could sync with an arbitrary gift-card
    // tender and record change_due without burning balance.
    if (grandTotal === 0 && totalTendered > 0.005) {
      return NextResponse.json({ error: "Tender amount exceeds reasonable limit" }, { status: 400 });
    }
    if (grandTotal > 0 && totalTendered > grandTotal * 10) {
      return NextResponse.json({ error: "Tender amount exceeds reasonable limit" }, { status: 400 });
    }
    const cashTendered = tenders.filter((t: { type: string }) => t.type === "cash").reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    const loyaltyTendered = tenders.filter((t: { type: string }) => t.type === "loyalty").reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    const nonCashTendered = tenders.filter((t: { type: string }) => t.type !== "cash" && t.type !== "loyalty").reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
    const cashPortion = Math.max(0, grandTotal - nonCashTendered - loyaltyTendered);
    const changeDue = cashTendered > cashPortion ? Number((cashTendered - cashPortion).toFixed(2)) : 0;
    const primaryTenderType = tenders.length === 1 ? tenders[0].type : "split";
    const loyaltyPointsRedeemed = loyaltyTendered > 0 && cart.customerId
      ? Math.round(loyaltyTendered / regConfig.loyalty.redemptionValuePerPoint)
      : 0;

    const transactionId = id || randomUUID();

    const syncClient = await orgTx(orgId);
    let inserted = true;
    try {
      // 1. Idempotency check first so retried syncs can safely no-op.
      // Scope the lookup by org to reject cross-org ID collisions.
      const { rows: existingEvents } = await syncClient.query(
        `SELECT te.id FROM transaction_events te
         JOIN transactions t ON t.id = te.transaction_id
         WHERE te.transaction_id = $1 AND te.payload->>'synced_at' IS NOT NULL
           AND t.organization_id = $2
         LIMIT 1`,
        [transactionId, orgId],
      );
      const isAlreadySynced = existingEvents.length > 0;

      // R27: explicit org probe so we can distinguish "exists in ours"
      // from "exists in another tenant's". The query body already
      // references organization_id so the guardrail passes; this
      // comment documents intent.
      // check-pool-org-filter: scoped-by-intentional-cross-tenant-collision-probe
      const { rows: conflictRows } = await syncClient.query(
        `SELECT organization_id FROM transactions WHERE id = $1 LIMIT 1`,
        [transactionId],
      );
      if (conflictRows[0] && conflictRows[0].organization_id !== orgId) {
        await syncClient.query("ROLLBACK");
        return NextResponse.json({ error: "Transaction ID collision" }, { status: 409 });
      }

      // 2. Transaction record and follow-on effects only run once per synced transaction
      if (!isAlreadySynced) {
        // Deferred consume of manager approvals — now INSIDE the syncClient
        // transaction, so a rollback on any later reject path un-burns them
        // atomically. Previously the consume happened before the tx started,
        // so a failed sync permanently destroyed the approval and the
        // cashier's retry would then fail the threshold check.
        if (approvedExceptions.length > 0 && sessionId) {
          // check-pool-org-filter: scoped-by-register-session-id
          // sessionId is from the authenticated register cookie.
          const { rows: burnedRows } = await syncClient.query(
            `UPDATE register_session_exceptions
             SET status = 'consumed'
             WHERE register_session_id = $1
               AND status = 'pending'
               AND exception_code = ANY($2::text[])
               AND (expires_at IS NULL OR expires_at > now())
             RETURNING exception_code`,
            [sessionId, approvedExceptions],
          );
          // Defensive: if another request (e.g. online checkout) burned the
          // same approvals between our SELECT and this UPDATE, fail the sync
          // so thresholds are re-validated on the next retry.
          if (burnedRows.length !== approvedExceptions.length) {
            await syncClient.query("ROLLBACK");
            return NextResponse.json({ error: "Approval was consumed by another request" }, { status: 409 });
          }
        }

        // R29-H1: compute loyaltyPointsEarned here (not later) so we can
        // persist it on the transaction row. Refunds read this value
        // back and prorate the reversal — see returns/process/route.ts
        // and register/return-action.ts. Must match the formula in
        // checkout-action.ts exactly so online + offline sales reverse
        // identically.
        const insertLoyaltyPointsEarned = cart.customerId
          ? Math.round(grandTotal * regConfig.loyalty.earnRatePerDollar)
          : 0;

        // Use ON CONFLICT DO NOTHING to avoid overwriting existing transactions
        // (e.g., if the online checkout already created this transaction id).
        // The idempotency check above already handles true duplicates.
        const txnRes = await syncClient.query(
          `INSERT INTO transactions (id, organization_id, location_id, register_session_id, employee_id, customer_id, cart_snapshot, subtotal, discount_total, tax_total, grand_total, tender_type, amount_tendered, change_due, status, created_at, points_earned)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'completed', $15, $16)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [
            transactionId, orgId, locationId, sessionId, sessionEmployeeId,
            cart.customerId ?? null,
            JSON.stringify(cart), subtotal, discountTotal, taxTotal, grandTotal,
            primaryTenderType, totalTendered, changeDue,
            timestamp || new Date().toISOString(),
            insertLoyaltyPointsEarned,
          ],
        );
        if (!txnRes.rows[0]) {
          inserted = false;
        }

        // If the transaction row already existed (online already persisted it),
        // DO NOT replay any of the side-effects (tenders, events, inventory,
        // loyalty, store credit, gift card). The online path already burned them
        // and a second application would double-decrement everything.
        if (!inserted) {
          await syncClient.query("COMMIT");
          invalidateInventoryCache(orgId);
          return NextResponse.json({ success: true, transactionId, inserted: false, _alreadyPersisted: true });
        }

        // Single round-trip INSERT for N tenders instead of a loop of
        // N sequential statements (saves ~30-80ms on split-tender carts).
        // `change_due` metadata is attached to the LAST cash row if any
        // cash was tendered — matches the semantics of the old loop.
        const lastCashIdx = (() => {
          for (let i = tenders.length - 1; i >= 0; i--) {
            if (tenders[i].type === "cash") return i;
          }
          return -1;
        })();
        const tenderIds = tenders.map(() => randomUUID());
        const tenderTypes = tenders.map((t: { type: string }) => t.type);
        const tenderAmounts = tenders.map((t: { amount: number }) => t.amount);
        const tenderMetas = tenders.map((_, i) =>
          JSON.stringify(i === lastCashIdx ? { change_due: changeDue.toFixed(2) } : {}),
        );
        await syncClient.query(
          `INSERT INTO transaction_tenders (id, transaction_id, tender_type, amount, metadata)
           SELECT unnest($1::uuid[]), $2, unnest($3::text[]), unnest($4::numeric[]), unnest($5::jsonb[])
           ON CONFLICT DO NOTHING`,
          [tenderIds, transactionId, tenderTypes, tenderAmounts, tenderMetas],
        );

        await syncClient.query(
          `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, notes, payload)
           VALUES ($1, $2, $3, 'transaction_placeholder', $4, $5)
           ON CONFLICT DO NOTHING`,
          [
            randomUUID(), transactionId, sessionEmployeeId,
            `Offline checkout synced`,
            JSON.stringify({
              location_id: locationId,
              register_session_id: sessionId,
              item_count: items.length,
              grand_total: grandTotal.toFixed(2),
              offline_timestamp: timestamp,
              synced_at: new Date().toISOString(),
            }),
          ],
        );

        // 3. Decrement inventory (batched) — lock rows + check stock before applying to prevent oversell
        if (items.length > 0) {
          // IMPORTANT: the SAME variant can appear on multiple cart lines
          // (same SKU with different modifiers → addItem keeps them separate
          // by modifier signature). PostgreSQL's UPDATE...FROM with two
          // delta rows matching the same inventory_levels row only applies
          // ONE of them and silently discards the other → oversell. We
          // aggregate totals by variant BEFORE hitting the DB.
          //
          // Bundle lines: fold each bundle's authoritative components (from
          // the DB, not the client payload) into the same per-variant total
          // so a cart with 2 hats + 1 bundle-containing-1-hat decrements 3
          // hats. Mirrors checkout-action.ts.
          const totalsByVariant = new Map<string, number>();
          for (const item of regularLines) {
            totalsByVariant.set(
              item.productVariantId,
              (totalsByVariant.get(item.productVariantId) ?? 0) + Number(item.quantity),
            );
          }
          for (const line of bundleLines) {
            const comps = serverBundleComponents[line.bundleId!] ?? [];
            for (const c of comps) {
              totalsByVariant.set(
                c.variantId,
                (totalsByVariant.get(c.variantId) ?? 0) + c.quantity * Number(line.quantity),
              );
            }
          }
          // Free-item lines decrement their variant's inventory too —
          // customer walked out with physical stock even at $0.
          for (const line of freeItemLines) {
            totalsByVariant.set(
              line.productVariantId,
              (totalsByVariant.get(line.productVariantId) ?? 0) + Number(line.quantity),
            );
          }
          const aggVariantIds = Array.from(totalsByVariant.keys());
          const aggDecrements = aggVariantIds.map((id) => -(totalsByVariant.get(id) ?? 0));

          // Lock rows in deterministic order to avoid deadlocks, then verify stock
          // R27: explicit org filter.
          const { rows: locked } = await syncClient.query(
            `SELECT il.product_variant_id, il.on_hand
             FROM inventory_levels il
             WHERE il.organization_id = $3
               AND il.product_variant_id = ANY($1::uuid[])
               AND il.location_id = $2
             ORDER BY il.product_variant_id
             FOR UPDATE`,
            [aggVariantIds, locationId, orgId],
          );

          const onHandByVariant: Record<string, number> = {};
          for (const row of locked) {
            onHandByVariant[row.product_variant_id] = Number(row.on_hand);
          }

          // Check AGGREGATE quantity per variant (not per line) so two lines
          // of qty=1 against onHand=1 correctly reject as oversell.
          for (const [variantId, aggQty] of totalsByVariant) {
            const onHand = onHandByVariant[variantId] ?? 0;
            if (onHand < aggQty) {
              // R27: explicit org filter so a crafted variantId from
              // another tenant can't leak its SKU via error messages.
              const { rows: skuRows } = await syncClient.query(
                `SELECT sku FROM product_variants WHERE id = $1 AND organization_id = $2`,
                [variantId, orgId],
              );
              const sku = skuRows[0]?.sku ?? variantId;
              await syncClient.query("ROLLBACK");
              return NextResponse.json(
                { error: `Insufficient inventory for SKU ${sku}`, insufficientSku: sku },
                { status: 409 },
              );
            }
          }

          // Single round-trip: UPDATE inventory + INSERT audit rows in one
          // statement via a WITH-CTE. Previously this was two sequential
          // queries (UPDATE, then INSERT consuming the RETURNING set in JS);
          // collapsing them saves ~50 ms per checkout and keeps both sides
          // in the same implicit subtransaction for free.
          // R27: explicit org filter on the inventory UPDATE.
          await syncClient.query(
            `WITH updated AS (
               UPDATE inventory_levels il
               SET on_hand = GREATEST(0, il.on_hand + delta.qty), updated_at = now()
               FROM (SELECT unnest($1::uuid[]) AS variant_id, unnest($2::int[]) AS qty) AS delta
               WHERE il.organization_id = $5
                 AND il.product_variant_id = delta.variant_id
                 AND il.location_id = $3
               RETURNING il.id AS inventory_level_id, il.product_variant_id, il.on_hand, delta.qty AS delta_qty
             )
             INSERT INTO inventory_adjustments
               (organization_id, inventory_level_id, product_variant_id, location_id, employee_id, reason, delta, resulting_on_hand)
             SELECT $5, inventory_level_id, product_variant_id, $3, $4, 'sale', delta_qty, on_hand
             FROM updated`,
            [aggVariantIds, aggDecrements, locationId, sessionEmployeeId, orgId],
          );
        }

        // 4. Reuse the points figure already computed + persisted above
        // (R29-H1). Server-side only — never trust client-supplied
        // cart.loyaltyPointsEarned here; this variable is derived from
        // grandTotal × regConfig.loyalty.earnRatePerDollar at sync time.
        const loyaltyPointsEarned = insertLoyaltyPointsEarned;
        if ((loyaltyPointsEarned > 0 || loyaltyPointsRedeemed > 0) && cart.customerId) {
          // Scope every customers/gift_cards/promo_codes FOR UPDATE by org.
          // Offline-sync trusts client-supplied ids (cart.customerId,
          // tender.metadata.gift_card_id, line.promoCodeId) — without the
          // org filter, a tampered device cart could redeem another tenant's
          // credit / card / promo if RLS ever regresses.
          // Also filter is_active so a deactivated customer (between
          // offline capture and online replay) doesn't get loyalty or
          // store credit mutated. R11-H-3.
          const { rows: customerRows } = await syncClient.query(
            `SELECT loyalty_points FROM customers
             WHERE id = $1 AND organization_id = $2 AND is_active = true FOR UPDATE`,
            [cart.customerId, orgId],
          );
          if (customerRows.length === 0) {
            await syncClient.query("ROLLBACK");
            return NextResponse.json({ error: "Customer not found or inactive" }, { status: 409 });
          }
          const currentPoints = Number(customerRows[0]?.loyalty_points ?? 0);
          if (loyaltyPointsRedeemed > currentPoints) {
            await syncClient.query("ROLLBACK");
            return NextResponse.json({ error: "Insufficient loyalty points" }, { status: 409 });
          }
          await syncClient.query(
            `UPDATE customers SET
              loyalty_points = loyalty_points - $1 + $2,
              total_spend = total_spend + $3,
              visit_count = visit_count + 1,
              updated_at = now()
            WHERE id = $4 AND organization_id = $5`,
            [loyaltyPointsRedeemed, loyaltyPointsEarned, grandTotal, cart.customerId, orgId],
          );
        }

        // 4c. Deduct gift card balance if used — mirrors checkout-action.ts step 8.
        // WITHOUT this, an offline cart with a gift_card tender would redeem at
        // the register but never burn balance server-side — infinite store value.
        const giftCardTenders = tenders.filter(
          (t: { type: string; amount: number; metadata?: { gift_card_id?: string } }) =>
            t.type === "gift_card" && t.metadata?.gift_card_id,
        ) as Array<{ type: string; amount: number; metadata: { gift_card_id: string } }>;
        for (const tender of giftCardTenders) {
          const { rows: gcRows } = await syncClient.query(
            `SELECT balance, status FROM gift_cards WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
            [tender.metadata.gift_card_id, orgId],
          );
          const card = gcRows[0];
          if (!card || card.status !== 'active' || Number(card.balance) < tender.amount) {
            await syncClient.query("ROLLBACK");
            return NextResponse.json(
              { error: "Gift card insufficient balance during offline sync" },
              { status: 409 },
            );
          }
          const newBalance = Number(card.balance) - tender.amount;
          await syncClient.query(
            `UPDATE gift_cards SET balance = $1, status = CASE WHEN $1 <= 0 THEN 'depleted' ELSE 'active' END, updated_at = now() WHERE id = $2 AND organization_id = $3`,
            [newBalance, tender.metadata.gift_card_id, orgId],
          );
          await syncClient.query(
            `INSERT INTO gift_card_transactions (id, gift_card_id, transaction_type, amount, balance_after, employee_id, transaction_id, reason, created_at)
             VALUES ($1, $2, 'redemption', $3, $4, $5, $6, 'Offline sync redemption', now())`,
            [randomUUID(), tender.metadata.gift_card_id, -tender.amount, newBalance, sessionEmployeeId, transactionId],
          );
        }

        // 4b. Deduct store credit balance if used — mirrors checkout-action.ts step 7b
        // Reject if insufficient balance rather than silently capping at zero.
        if (storeCreditTendered > 0 && cart.customerId) {
          // Also filter is_active — a deactivated customer's store credit
          // must not be drained via offline replay.
          const { rows: currRows } = await syncClient.query(
            `SELECT store_credit_balance FROM customers
             WHERE id = $1 AND organization_id = $2 AND is_active = true FOR UPDATE`,
            [cart.customerId, orgId],
          );
          if (currRows.length === 0) {
            throw new Error("Customer not found or inactive in this organization");
          }
          const currentBalance = Number(currRows[0]?.store_credit_balance ?? 0);
          if (currentBalance < storeCreditTendered) {
            throw new Error(`Insufficient store credit balance (${currentBalance} < ${storeCreditTendered})`);
          }
          const newBalance = currentBalance - storeCreditTendered;
          await syncClient.query(
            `UPDATE customers SET store_credit_balance = $1, updated_at = now() WHERE id = $2 AND organization_id = $3`,
            [newBalance, cart.customerId, orgId],
          );
          await syncClient.query(
            `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, transaction_id, reason, created_at)
             VALUES ($1, $2, $3, 'redemption', $4, $5, $6, $7, 'Offline sync redemption', now())`,
            [randomUUID(), orgId, cart.customerId, -storeCreditTendered, newBalance, sessionEmployeeId, transactionId],
          );
        }
      }

      // Free-item promo redemptions. Row-lock the promo codes here so
      // concurrent syncs can't both pass the max_redemptions check. The
      // UNIQUE (promo_code_id, transaction_id) index catches double-
      // redemption on retry. Re-validate status + expiry inside the lock
      // — a promo could have been disabled since the pre-tx read. Each
      // loop iteration is a DB round-trip; free-item promo usage is
      // rare enough that batching isn't worth the complexity yet.
      for (const line of freeItemLines) {
        const promoId = line.promoCodeId!;
        // R29-H2: also select max_redemptions_per_customer so the
        // per-customer cap is enforced on the offline sync path too.
        // Without this, a device held offline could stockpile identical
        // per-customer-capped free-item promos and sync them all at
        // once — the online path blocks it, the offline path did not.
        const { rows: lockedPromo } = await syncClient.query(
          `SELECT id, status, max_redemptions, max_redemptions_per_customer,
                  current_redemptions, expires_at, type, free_variant_id
           FROM promo_codes WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [promoId, orgId],
        );
        const p = lockedPromo[0] as {
          id: string; status: string;
          max_redemptions: number; max_redemptions_per_customer: number | null;
          current_redemptions: number;
          expires_at: string | null; type: string; free_variant_id: string | null;
        } | undefined;
        if (!p) {
          throw new PromoRevalidationError("promo_not_found", promoId);
        }
        if (p.status !== "active") {
          throw new PromoRevalidationError(`promo_status_${p.status}`, promoId);
        }
        if (p.type !== "free_item" || p.free_variant_id !== line.productVariantId) {
          throw new PromoRevalidationError("promo_variant_mismatch", promoId);
        }
        if (p.max_redemptions > 0 && p.current_redemptions >= p.max_redemptions) {
          throw new PromoRevalidationError("promo_depleted", promoId);
        }
        if (p.expires_at && new Date(p.expires_at).getTime() < Date.now()) {
          throw new PromoRevalidationError("promo_expired", promoId);
        }
        // R29-H2: per-customer cap. Mirror checkout-action.ts:452 exactly
        // so identical carts validate identically online vs offline.
        // If a per-customer cap exists but no customer is attached,
        // refuse — guest-checkout bypass was the R29-C2 finding.
        if (p.max_redemptions_per_customer) {
          if (!cart.customerId) {
            throw new PromoRevalidationError(
              "promo_requires_identified_customer",
              promoId,
            );
          }
          const { rows: priorRows } = await syncClient.query(
            `SELECT COUNT(*)::int AS n
               FROM promo_redemptions pr
               JOIN transactions t ON t.id = pr.transaction_id
              WHERE pr.promo_code_id = $1
                AND t.customer_id = $2
                AND t.organization_id = $3
                AND t.id <> $4`,
            [promoId, cart.customerId, orgId, transactionId],
          );
          const prior = Number(priorRows[0]?.n ?? 0);
          if (prior >= Number(p.max_redemptions_per_customer)) {
            throw new PromoRevalidationError("promo_per_customer_cap_reached", promoId);
          }
        }

        // discount_amount = variant's retail price at sale time (what we
        // "gave away"). Use the server-side variant price we already read.
        const giveawayValue = serverPrices[line.productVariantId] ?? Number(line.unitPrice) ?? 0;
        try {
          await syncClient.query(
            `INSERT INTO promo_redemptions (id, promo_code_id, transaction_id, employee_id, discount_amount, created_at)
             VALUES ($1, $2, $3, $4, $5, now())`,
            [randomUUID(), promoId, transactionId, sessionEmployeeId, giveawayValue],
          );
        } catch (e) {
          const err = e as { code?: string };
          if (err.code === "23505") {
            // already redeemed on this transaction (sync retry) — skip
            // the redemption insert; the promo bump below is idempotent
            // against the pre-existing redemption.
            continue;
          }
          throw e;
        }
        // R27: explicit org filter on the promo counter UPDATE.
        await syncClient.query(
          `UPDATE promo_codes SET current_redemptions = current_redemptions + 1, updated_at = now()
           WHERE id = $1 AND organization_id = $2`,
          [promoId, orgId],
        );
        const nextCount = p.current_redemptions + 1;
        if (p.max_redemptions > 0 && nextCount >= p.max_redemptions) {
          await syncClient.query(
            `UPDATE promo_codes SET status = 'depleted', updated_at = now() WHERE id = $1 AND organization_id = $2`,
            [promoId, orgId],
          );
        }
      }

      await syncClient.query("COMMIT");
    } catch (e) {
      // .catch on the rollback so that if the connection is already dead
      // / the tx is already aborted, we don't clobber the original error
      // with the rollback's error. The outer logger only sees the real
      // cause then.
      await syncClient.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      syncClient.release();
    }

    invalidateInventoryCache(orgId);
    return NextResponse.json({ success: true, transactionId, inserted });
  } catch (error) {
    // Promo revalidation errors are structured 409s (Conflict) — the cart
    // was built offline against a now-stale promo row. The client should
    // NOT retry this specific transaction; the cashier needs to void or
    // re-apply a different code. Keeping the `reason` code machine-
    // readable so the offline queue can show an actionable message.
    if (error instanceof PromoRevalidationError) {
      console.warn(`[offline-sync] ${error.reason} — won't retry`);
      return NextResponse.json(
        { error: "Promo code is no longer valid for this cart", reason: error.reason, promoId: error.promoId, retriable: false },
        { status: 409 },
      );
    }
    console.error("Offline sync error:", safeErr(error));
    return NextResponse.json(
      { error: "Failed to sync transaction" },
      { status: 500 },
    );
  }
});
