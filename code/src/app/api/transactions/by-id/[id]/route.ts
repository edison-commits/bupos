import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withDualAuth } from "@/lib/api/with-auth";

/**
 * GET /api/transactions/by-id/:id
 *
 * Default (no query params): lightweight existence-and-status lookup.
 * Purpose: let the POS recover from silent-commit 503s where the DB
 * committed but the Worker response timed out. Small payload keeps CPU
 * cost low during the retry window.
 *
 * `?withCart=1`: also returns `cart_snapshot` + per-variant "already
 * returned" quantities. Used by the return modal to show a real item list
 * instead of a manual-refund-amount form. Pulling this conditionally keeps
 * the silent-commit recovery path fast.
 *
 * Access: admin + register scopes (dualAuth). Same-org enforcement via
 * orgQuery's app.current_org_id / RLS.
 *
 * @tags transactions
 */
export const GET = withDualAuth(
  "register.open",
  async (req, ctx) => {
    const { orgId } = ctx;
    const segments = req.nextUrl.pathname.split("/");
    const id = segments[segments.length - 1];
    if (!id || typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: "Valid transaction id required" }, { status: 400 });
    }

    const withCart = req.nextUrl.searchParams.get("withCart") === "1";

    // Non-managers can only see their own scope's transactions (R7-H-2).
    // R12-M-8: use `ctx.allowedLocations` — which is set to `[regCtx.location.id]`
    // for register-scope callers and employee.locationIds for admin-scope
    // non-managers — not `ctx.employee.locationIds`. A cashier assigned to
    // stores A + B, currently logged in at terminal A's register, should
    // only see transactions at the physically-connected location, not every
    // store they're ever assigned to.
    const isManager = ctx.allowedLocations === null;
    const allowedLocations = ctx.allowedLocations ?? [];

    const { rows } = await orgQuery(
      orgId,
      withCart
        ? `SELECT id, status, grand_total, tender_type, created_at,
                  cart_snapshot, subtotal, discount_total, tax_total, customer_id, location_id
           FROM transactions
           WHERE id = $1 AND organization_id = $2
           LIMIT 1`
        : `SELECT id, status, grand_total, tender_type, created_at, location_id
           FROM transactions
           WHERE id = $1 AND organization_id = $2
           LIMIT 1`,
      [id, orgId],
    );
    if (rows.length === 0) {
      return NextResponse.json({ found: false }, { status: 404 });
    }
    const txnLoc = rows[0].location_id as string;
    if (!isManager && !allowedLocations.includes(txnLoc)) {
      // Same response shape as a real miss — don't leak existence via error.
      return NextResponse.json({ found: false }, { status: 404 });
    }
    const r = rows[0] as Record<string, unknown>;
    const base = {
      id: r.id as string,
      status: r.status as string,
      grandTotal: Number(r.grand_total),
      tenderType: r.tender_type as string,
      createdAt: String(r.created_at),
    };

    if (!withCart) {
      return NextResponse.json({ found: true, transaction: base });
    }

    // Tally prior returns so the UI can gate "max returnable qty per item".
    // Covers BOTH return paths: the register action (writes a negative
    // `transactions` row with `originalTransactionId` in cart_snapshot) AND
    // the admin /api/returns (writes to the `returns` + `return_lines`
    // tables). Missing either side lets a customer double-refund.
    const [priorTxns, priorAdminReturns] = await Promise.all([
      orgQuery(
        orgId,
        `SELECT cart_snapshot FROM transactions
         WHERE organization_id = $1 AND status = 'completed'
           AND cart_snapshot->>'originalTransactionId' = $2`,
        [orgId, id],
      ),
      orgQuery(
        orgId,
        `SELECT rl.product_variant_id, rl.quantity
         FROM return_lines rl
         JOIN returns r ON r.id = rl.return_id
         WHERE r.organization_id = $1 AND r.transaction_id = $2
           AND r.status IN ('pending', 'completed')`,
        [orgId, id],
      ),
    ]);

    // Split the already-returned tally into two maps keyed by their
    // semantic identity:
    //   • alreadyReturnedByVariant  — indexed by real product_variant_id
    //   • alreadyReturnedByBundle   — indexed by bundle_id (for bundle lines)
    // The register's return modal picks the right map based on whether the
    // line it's displaying is a bundle. See `cartLineLookupKey` in
    // src/lib/cart/types.ts for the contract. Previously both kinds were
    // collapsed into one map keyed by the sentinel — which "just worked"
    // because sentinel === bundleId, but was fragile.
    const alreadyReturnedByVariant: Record<string, number> = {};
    const alreadyReturnedByBundle: Record<string, number> = {};
    for (const row of priorTxns.rows as { cart_snapshot: unknown }[]) {
      const snap = typeof row.cart_snapshot === "string"
        ? JSON.parse(row.cart_snapshot as string)
        : (row.cart_snapshot as {
            items?: { productVariantId: string; quantity: number; bundleId?: string }[];
          });
      for (const it of snap?.items ?? []) {
        if (it.bundleId) {
          alreadyReturnedByBundle[it.bundleId] =
            (alreadyReturnedByBundle[it.bundleId] ?? 0) + (it.quantity ?? 0);
        } else {
          alreadyReturnedByVariant[it.productVariantId] =
            (alreadyReturnedByVariant[it.productVariantId] ?? 0) + (it.quantity ?? 0);
        }
      }
    }
    // Admin /api/returns/process rows store bundle lines with
    // product_variant_id = bundleId (the sentinel). We can't distinguish
    // here without another join, so duplicate them into BOTH maps — any
    // real collision between a variant id and a bundle id is prevented by
    // gen_random_uuid(). Register code only reads ONE map per line
    // (bundle-ness is known there), so the duplication is safe.
    for (const row of priorAdminReturns.rows as { product_variant_id: string; quantity: number }[]) {
      alreadyReturnedByVariant[row.product_variant_id] =
        (alreadyReturnedByVariant[row.product_variant_id] ?? 0) + (Number(row.quantity) ?? 0);
      alreadyReturnedByBundle[row.product_variant_id] =
        (alreadyReturnedByBundle[row.product_variant_id] ?? 0) + (Number(row.quantity) ?? 0);
    }

    let cartSnapshot = typeof r.cart_snapshot === "string"
      ? JSON.parse(r.cart_snapshot as string)
      : r.cart_snapshot;
    // For non-managers, strip embedded customer PII from the snapshot
    // (mirrors the R8-M-10 handling on /api/transactions detail). Safe
    // to do — the register return modal only needs item lines.
    if (!isManager && cartSnapshot && typeof cartSnapshot === "object") {
      // R36-M2: strip the full cart_snapshot field set down to a
      // narrow allowlist for non-managers. The prior shape used a
      // deny-list (customerEmail/Phone/Address/Notes), which leaked
      // every OTHER field (overridePrice, modifierIds, lineDiscount,
      // sourceEmployeeId, loyalty/promo metadata, etc.) to any
      // cashier that hit the endpoint. Cashiers see their own store's
      // transactions routinely; there's no reason they need
      // overridePrice audit trails or promo redemption details.
      const snap = cartSnapshot as Record<string, unknown>;
      const items = Array.isArray(snap.items) ? snap.items : [];
      const sanitizedItems = items.map((it: unknown) => {
        const i = (it ?? {}) as Record<string, unknown>;
        return {
          productVariantId: i.productVariantId,
          productName: i.productName,
          variantName: i.variantName,
          sku: i.sku,
          unitPrice: i.unitPrice,
          quantity: i.quantity,
          // Preserve bundleId + promoCodeId shape (needed for the
          // return UI to render bundle/free lines correctly) but
          // drop bundleComponents / inner pricing detail.
          ...(i.bundleId ? { bundleId: i.bundleId } : {}),
          ...(i.promoCodeId ? { promoCodeId: i.promoCodeId } : {}),
        };
      });
      cartSnapshot = {
        items: sanitizedItems,
        ...(typeof snap.taxRate === "number" ? { taxRate: snap.taxRate } : {}),
        ...(typeof snap.isReturn === "boolean" ? { isReturn: snap.isReturn } : {}),
        ...(typeof snap.originalTransactionId === "string"
          ? { originalTransactionId: snap.originalTransactionId }
          : {}),
      };
    }

    return NextResponse.json({
      found: true,
      transaction: {
        ...base,
        subtotal: Number(r.subtotal ?? 0),
        discountTotal: Number(r.discount_total ?? 0),
        taxTotal: Number(r.tax_total ?? 0),
        customerId: (r.customer_id as string | null) ?? null,
        cartSnapshot,
        alreadyReturnedByVariant,
        alreadyReturnedByBundle,
      },
    });
  },
);
