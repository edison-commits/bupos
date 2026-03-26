import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";

const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";

/**
 * GET /api/tax-config
 *
 * Returns tax rates for all locations.
 * Query params:
 *   location — specific location ID
 */
export async function GET(req: NextRequest) {
  try {
    const locationId = req.nextUrl.searchParams.get("location");

    if (locationId) {
      const result = await orgQuery(
        ORG_ID,
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
      ORG_ID,
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
}

/**
 * PUT /api/tax-config
 *
 * Update tax rate for a location.
 * Body: { locationId, taxRate } — taxRate as decimal (e.g., 0.1025 for 10.25%)
 */
export async function PUT(req: NextRequest) {
  try {
    const { locationId, taxRate } = await req.json();

    if (!locationId || taxRate === undefined || taxRate === null) {
      return NextResponse.json({ error: "locationId and taxRate required" }, { status: 400 });
    }

    if (taxRate < 0 || taxRate > 0.5) {
      return NextResponse.json({ error: "Tax rate must be between 0 and 0.50 (0-50%)" }, { status: 400 });
    }

    const result = await orgQuery(
      ORG_ID,
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
}
