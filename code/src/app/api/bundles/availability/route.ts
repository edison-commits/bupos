/**
 * BuPOS Bundle Availability
 *
 * GET /api/bundles/availability?locationId=<uuid>
 *
 * Returns a per-bundle availability hint for the current location. Used by
 * the register's BundlePicker to refresh the "OOS" chip periodically
 * without re-fetching the entire inventory snapshot. When two cashiers are
 * racing for the last unit, the polling interval narrows but does not
 * close the race — authoritative stock check happens server-side at
 * checkout. This is UX polish, not reservation.
 *
 * Small response (bundleId + available-qty + OOS component names) so the
 * poll stays cheap even on busy days with many bundles.
 *
 * @tags bundles
 */
import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withDualAuth } from "@/lib/api/with-auth";

import { safeErr } from "@/lib/logging/safe-err";
interface BundleItemRow {
  bundle_id: string;
  bundle_name: string;
  bundle_active: boolean;
  product_variant_id: string;
  variant_name: string;
  product_name: string;
  component_qty: number;
  on_hand: number;
}

export const GET = withDualAuth("register.open", async (req, ctx) => {
  const { orgId } = ctx;

  const locationId = req.nextUrl.searchParams.get("locationId");
  if (!locationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(locationId)) {
    return NextResponse.json({ error: "Valid locationId query param required" }, { status: 400 });
  }

  try {
    // Verify the location belongs to the caller's org BEFORE doing the
    // inventory scan. Without this, a cashier whose session is scoped to
    // org A could pass a locationId from org B; RLS would then return 0
    // inventory rows and the UI would quietly render every bundle as OOS
    // (misleading, not a data leak — but confusing). 404 early.
    const locCheck = await orgQuery(
      orgId,
      `SELECT id FROM locations WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [locationId, orgId],
    );
    if (locCheck.rows.length === 0) {
      return NextResponse.json({ error: "Location not found" }, { status: 404 });
    }
    // Single query pulling every active bundle's components alongside the
    // on_hand at the requested location. LEFT JOIN on inventory_levels so
    // components with no inventory row still appear (they contribute 0
    // stock to the availability calc, which correctly marks the bundle
    // unavailable).
    //
    // Every org-scoped table in the join chain (product_bundles,
    // product_variants, products, inventory_levels) is explicitly gated by
    // organization_id. Passing a foreign locationId (already 404'd above)
    // can't bypass the tenant boundary through any of the joined rows.
    const { rows } = await orgQuery(
      orgId,
      `SELECT pb.id AS bundle_id, pb.name AS bundle_name, pb.is_active AS bundle_active,
              bi.product_variant_id, pv.name AS variant_name, p.name AS product_name,
              bi.quantity AS component_qty,
              COALESCE(il.on_hand, 0) AS on_hand
       FROM product_bundles pb
       JOIN bundle_items bi ON bi.bundle_id = pb.id
       JOIN product_variants pv ON pv.id = bi.product_variant_id AND pv.organization_id = $2
       LEFT JOIN products p ON p.id = pv.product_id AND p.organization_id = $2
       LEFT JOIN inventory_levels il
         ON il.product_variant_id = bi.product_variant_id
        AND il.location_id = $1
        AND il.organization_id = $2
       WHERE pb.is_active = true
         AND pb.organization_id = $2`,
      [locationId, orgId],
    );

    // Collapse into one availability row per bundle. For each bundle the
    // most constraining component caps the bundle's buildable quantity:
    //   floor(component.on_hand / component.qty)
    // An OOS component list is returned so the UI can show "OOS: X, Y".
    const byBundle = new Map<string, {
      bundleId: string;
      bundleName: string;
      isActive: boolean;
      maxBuildable: number;
      oosComponents: string[];
    }>();
    for (const row of rows as BundleItemRow[]) {
      const qty = Number(row.component_qty);
      const onHand = Number(row.on_hand);
      const buildable = qty > 0 ? Math.floor(onHand / qty) : 0;
      const existing = byBundle.get(row.bundle_id);
      const componentLabel = (row.product_name ? `${row.product_name} — ` : "") + row.variant_name;
      if (existing) {
        existing.maxBuildable = Math.min(existing.maxBuildable, buildable);
        if (onHand < qty) existing.oosComponents.push(componentLabel);
      } else {
        byBundle.set(row.bundle_id, {
          bundleId: row.bundle_id,
          bundleName: row.bundle_name,
          isActive: row.bundle_active,
          maxBuildable: buildable,
          oosComponents: onHand < qty ? [componentLabel] : [],
        });
      }
    }

    return NextResponse.json(
      { availability: Array.from(byBundle.values()) },
      // Tight no-cache so polling never hits a CDN layer.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("GET /api/bundles/availability error:", safeErr(err));
    return NextResponse.json({ error: "Failed to load bundle availability" }, { status: 500 });
  }
});
