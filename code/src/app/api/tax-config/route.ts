import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";
import { withDualAuth, withAdminAuth } from "@/lib/api/with-auth";
import { validateBody, taxConfigUpdateSchema } from "@/lib/validation/schemas";


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

    if (locationId) {
      const result = await orgQuery(
        orgId,
        `SELECT id, name, city, region, postal_code, tax_rate FROM locations WHERE id = $1`,
        [locationId],
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
      `SELECT id, name, city, region, postal_code, tax_rate FROM locations ORDER BY name`,
      [],
    );

    return NextResponse.json({
      locations: locations.rows.map((l: Record<string, unknown>) => ({
        ...l,
        taxRatePercent: Number((Number(l.tax_rate) * 100).toFixed(4)),
      })),
    });
  } catch (err) {
    console.error("GET /api/tax-config error:", err);
    return NextResponse.json({ error: "Failed to fetch tax config" }, { status: 500 });
  }
});

/**
 * PUT /api/tax-config
 *
 * Update tax rate for a location.
 * Body: { locationId, taxRate } — taxRate as decimal (e.g., 0.1025 for 10.25%)
 */
export const PUT = withAdminAuth('catalog.manage', async (req, ctx) => {
  const { orgId } = ctx;
  try {
    const body = await req.json();
    const v = validateBody(taxConfigUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { locationId, taxRate } = v.data;

    const result = await orgQuery(
      orgId,
      `UPDATE locations SET tax_rate = $1, updated_at = now() WHERE id = $2 RETURNING id, name, tax_rate`,
      [taxRate, locationId],
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Location not found" }, { status: 404 });
    }

    return NextResponse.json({
      location: result.rows[0],
      taxRatePercent: Number((Number(result.rows[0].tax_rate) * 100).toFixed(4)),
    });
  } catch (err) {
    console.error("PUT /api/tax-config error:", err);
    return NextResponse.json({ error: "Failed to update tax config" }, { status: 500 });
  }
});
