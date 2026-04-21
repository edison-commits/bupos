import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withDualAuth, withAdminAuth } from "@/lib/api/with-auth";
import { validateBody, taxConfigUpdateSchema } from "@/lib/validation/schemas";


import { safeErr } from "@/lib/logging/safe-err";
/**
 * GET /api/tax-config
 *
 * Returns tax rates for all locations.
 * Query params:
 *   location — specific location ID
 */
export const GET = withDualAuth("catalog.manage", async (req, ctx) => {
  const { orgId } = ctx;

  try {
    const locationId = req.nextUrl.searchParams.get("location");

    // R27: explicit organization_id on every locations query.
    if (locationId) {
      const result = await orgQuery(
        orgId,
        `SELECT id, name, city, region, postal_code, tax_rate FROM locations WHERE id = $1 AND organization_id = $2`,
        [locationId, orgId],
      );
      if (result.rows.length === 0) {
        return NextResponse.json({ error: "Location not found" }, { status: 404 });
      }
      const loc = result.rows[0];
      return NextResponse.json({
        location: loc,
        taxRatePercent: Number((Number(loc.tax_rate) * 100).toFixed(4)),
      });
    }

    const locations = await orgQuery(
      orgId,
      `SELECT id, name, city, region, postal_code, tax_rate FROM locations WHERE organization_id = $1 ORDER BY name`,
      [orgId],
    );

    return NextResponse.json({
      locations: locations.rows.map((l: Record<string, unknown>) => ({
        ...l,
        taxRatePercent: Number((Number(l.tax_rate) * 100).toFixed(4)),
      })),
    });
  } catch (err) {
    console.error("GET /api/tax-config error:", safeErr(err));
    return NextResponse.json({ error: "Failed to fetch tax config" }, { status: 500 });
  }
});

/**
 * PUT /api/tax-config
 *
 * Update tax rate for a location.
 * Body: { locationId, taxRate } — taxRate as decimal (e.g., 0.1025 for 10.25%)
 */
// Tax rate affects every checkout. Restrict to manager/owner via employee.manage
// instead of catalog.manage (which inventory_clerk also has).
export const PUT = withAdminAuth('employee.manage', async (req, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await req.json();
    const v = validateBody(taxConfigUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { locationId, taxRate } = v.data;

    // R27: explicit org filter on UPDATE — without it any tenant's
    // owner could change any other tenant's tax rate.
    const result = await orgQuery(
      orgId,
      `UPDATE locations SET tax_rate = $1, updated_at = now() WHERE id = $2 AND organization_id = $3 RETURNING id, name, tax_rate`,
      [taxRate, locationId, orgId],
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Location not found" }, { status: 404 });
    }

    return NextResponse.json({
      location: result.rows[0],
      taxRatePercent: Number((Number(result.rows[0].tax_rate) * 100).toFixed(4)),
    });
  } catch (err) {
    console.error("PUT /api/tax-config error:", safeErr(err));
    return NextResponse.json({ error: "Failed to update tax config" }, { status: 500 });
  }
});
