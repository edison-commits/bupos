import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withDualAuth, withAdminAuth } from "@/lib/api/with-auth";
import { validateBody, taxConfigUpdateSchema } from "@/lib/validation/schemas";
// R94-sweep: `locations.tax_rate` is in the readStore snapshot —
// bust after every tax-config PUT.
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";


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
  // R64-M3: per-actor rate limit at 10/5min. Parity with /api/
  // settings PUT (R47-M4 / M-rate-limit) — both endpoints mutate
  // the same `locations.tax_rate` column; a stolen owner cookie
  // could hammer tax flips through this twin endpoint to find a
  // sweet spot (R39-A1-2 "owner flips rate mid-day, pockets
  // delta"). Step-up gates COLD starts but a fresh step-up window
  // would allow unbounded follow-on flips without this cap.
  const { checkRateLimit } = await import('@/lib/auth/rate-limit');
  const rl = checkRateLimit(`tax-config-put:${orgId}:${employee.id}`, { maxAttempts: 10, windowMs: 300_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many tax updates. Try again shortly.' },
      { status: 429 },
    );
  }
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

    // R48: wrap SELECT + UPDATE + audit in a single orgTx so the audit
    // row is atomic with the tax-rate change. Tax rate is the highest-
    // fraud-risk admin mutation (R39-A1-2); a post-commit audit that
    // fails silently is exactly the evidence-destruction vector the
    // audit is supposed to prevent.
    const { orgTx } = await import("@/lib/supabase-rest");
    const { randomUUID } = await import("@/lib/uuid");
    const client = await orgTx(orgId);
    let finalTaxRate: number;
    let finalLocName: string;
    try {
      const priorRes = await client.query(
        `SELECT tax_rate FROM locations WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [locationId, orgId],
      );
      const priorTaxRate = priorRes.rows[0]?.tax_rate ?? null;
      const updRes = await client.query(
        `UPDATE locations SET tax_rate = $1, updated_at = now() WHERE id = $2 AND organization_id = $3 RETURNING id, name, tax_rate`,
        [taxRate, locationId, orgId],
      );
      if (updRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Location not found" }, { status: 404 });
      }
      finalTaxRate = Number(updRes.rows[0].tax_rate);
      finalLocName = updRes.rows[0].name as string;
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'location', $5, 'tax_rate_changed', $6, now())`,
        [
          randomUUID(), orgId, locationId, employee.id, locationId,
          JSON.stringify({
            prior_tax_rate: priorTaxRate !== null ? String(priorTaxRate) : null,
            new_tax_rate: String(taxRate),
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
    return NextResponse.json({
      location: { id: locationId, name: finalLocName, tax_rate: finalTaxRate },
      taxRatePercent: Number((finalTaxRate * 100).toFixed(4)),
    });
  } catch (err) {
    console.error("PUT /api/tax-config error:", safeErr(err));
    return NextResponse.json({ error: "Failed to update tax config" }, { status: 500 });
  }
});
