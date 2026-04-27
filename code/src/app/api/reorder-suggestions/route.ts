import { NextResponse } from 'next/server';
import { orgQuery } from '@/lib/supabase-rest';
import { withDualAuth } from '@/lib/api/with-auth';


import { safeErr } from "@/lib/logging/safe-err";
/**
 * GET /api/reorder-suggestions
 *
 * Returns all inventory items at or below their reorder point,
 * grouped by supplier (via a product→supplier mapping).
 * Suggests order quantities to bring stock up to 2× reorder point.
 *
 * Also returns items with no supplier assigned so they can be flagged.
 */
export const GET = withDualAuth("inventory.adjust", async (req, ctx) => {
  const { orgId } = ctx;
  try {
    // Default to the caller's primary location; allow explicit override only
    // if the caller is assigned to that location (owner/manager can see all,
    // to plan cross-store reorders). Without this, an inventory_clerk at
    // Redondo could read stock levels + supplier mappings at every other
    // store in the org — exfiltration-grade detail with no business reason.
    const requestedLocation = req.nextUrl.searchParams.get("location");
    const isManager = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
    const locationId = requestedLocation ?? ctx.employee.locationIds?.[0];
    if (requestedLocation && !isManager && !(ctx.employee.locationIds ?? []).includes(requestedLocation)) {
      return NextResponse.json({ error: "Location not assigned to this employee" }, { status: 403 });
    }

    // When a specific location is known, filter the query to that location.
    // Owner/manager with no location param see all locations (prior behavior).
    const locationFilter = locationId ? ` AND il.location_id = $2` : "";
    const params: unknown[] = locationId ? [orgId, locationId] : [orgId];

    // Find all low/out-of-stock items with supplier info if available
    const { rows } = await orgQuery(orgId,
      `SELECT
        il.id as inventory_id,
        il.on_hand,
        il.reorder_point,
        il.location_id,
        pv.id as variant_id,
        pv.product_id,
        pv.sku,
        pv.name as variant_name,
        pv.size_label,
        pv.color_label,
        pv.cost,
        p.name as product_name,
        p.supplier_id,
        s.name as supplier_name,
        l.name as location_name
      FROM inventory_levels il
      JOIN product_variants pv ON il.product_variant_id = pv.id AND pv.organization_id = $1
      JOIN products p ON pv.product_id = p.id AND p.organization_id = $1
      LEFT JOIN suppliers s ON p.supplier_id = s.id AND s.organization_id = $1
      LEFT JOIN locations l ON il.location_id = l.id AND l.organization_id = $1
      WHERE il.organization_id = $1
        AND il.on_hand <= il.reorder_point${locationFilter}
      ORDER BY s.name NULLS LAST, p.name, pv.name`,
      // ISO-LOW2: belt-and-suspenders org filter on every JOIN-side
      // table — parity with products/route.ts:111-115 and the rest
      // of the JOIN-defense-in-depth pattern.
      params,
    );

    // Group by supplier
    const bySupplier: Record<string, { supplier_id: string | null; supplier_name: string; items: typeof rows }> = {};

    for (const row of rows) {
      const key = row.supplier_id || '_unassigned';
      if (!bySupplier[key]) {
        bySupplier[key] = {
          supplier_id: row.supplier_id,
          supplier_name: row.supplier_name || 'No Supplier Assigned',
          items: [],
        };
      }
      bySupplier[key].items.push({
        ...row,
        suggested_qty: Math.max(1, (row.reorder_point * 2) - row.on_hand),
      });
    }

    const groups = Object.values(bySupplier);
    const totalItems = rows.length;

    return NextResponse.json({ groups, totalItems });
  } catch (error) {
    console.error('Reorder suggestions error:', safeErr(error));
    return NextResponse.json({ error: 'Failed to fetch reorder suggestions' }, { status: 500 });
  }
});
