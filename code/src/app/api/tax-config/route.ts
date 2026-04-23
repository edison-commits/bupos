import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withDualAuth, withAdminAuth } from "@/lib/api/with-auth";
import { validateBody, taxConfigUpdateSchema } from "@/lib/validation/schemas";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";


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
  const { orgId, employee } = ctx;
  try {
    const body = await req.json();
    const v = validateBody(taxConfigUpdateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { locationId, taxRate } = v.data;

    // R44-H: require step-up re-auth. Tax rate is the single highest-
    // fraud-risk admin mutation (R39-A1-2 rationale: "owner flips rate
    // mid-day, pockets delta"). Prior shape only added AUDIT (R39)
    // without the STEP-UP gate, so a stolen owner cookie can silently
    // flip the rate. Gating via `tax-rate-stepup` bucket bounds an
    // attacker to the aggregate step-up cap.
    const { requireStepUp } = await import('@/lib/auth/step-up');
    const stepUp = await requireStepUp({
      actorId: employee.id,
      orgId,
      actorPassword: (body as { actorPassword?: string }).actorPassword,
      bucketKey: 'tax-rate-stepup',
    });
    if (!stepUp.ok) {
      return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
    }

    // R27: explicit org filter on UPDATE — without it any tenant's
    // owner could change any other tenant's tax rate.
    // R39-A1-2: capture the OLD rate so the audit event records the
    // full transition.
    const { rows: priorRows } = await orgQuery(
      orgId,
      `SELECT tax_rate FROM locations WHERE id = $1 AND organization_id = $2`,
      [locationId, orgId],
    );
    const priorTaxRate = priorRows[0]?.tax_rate ?? null;
    const result = await orgQuery(
      orgId,
      `UPDATE locations SET tax_rate = $1, updated_at = now() WHERE id = $2 AND organization_id = $3 RETURNING id, name, tax_rate`,
      [taxRate, locationId, orgId],
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Location not found" }, { status: 404 });
    }

    // R39-A1-2: audit the change.
    await waitUntilOrAwait(pgInsertAuditEvent(
      orgId, locationId, employee.id,
      "location", locationId, "tax_rate_changed",
      {
        prior_tax_rate: priorTaxRate !== null ? String(priorTaxRate) : null,
        new_tax_rate: String(taxRate),
      },
    ).catch((err) => console.error("[audit] tax_rate_changed failed:", safeErr(err))));

    return NextResponse.json({
      location: result.rows[0],
      taxRatePercent: Number((Number(result.rows[0].tax_rate) * 100).toFixed(4)),
    });
  } catch (err) {
    console.error("PUT /api/tax-config error:", safeErr(err));
    return NextResponse.json({ error: "Failed to update tax config" }, { status: 500 });
  }
});
