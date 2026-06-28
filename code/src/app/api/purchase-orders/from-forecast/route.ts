import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { createPurchaseOrdersFromForecast } from "@/lib/purchase-orders/from-forecast";
import type { StockoutRisk } from "@/lib/inventory/forecast";
import { safeErr } from "@/lib/logging/safe-err";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ForecastPoMode = "critical" | "criticalSoon" | "selected";

function risksForMode(mode: ForecastPoMode): StockoutRisk[] {
  if (mode === "critical") return ["critical"];
  if (mode === "criticalSoon") return ["critical", "soon"];
  return ["critical", "soon", "watch", "healthy", "unknown"];
}

function parseBody(body: Record<string, unknown>): { ok: true; mode: ForecastPoMode; location: string; variantIds?: string[] } | { ok: false; error: string } {
  const mode = (body.mode ?? "criticalSoon") as string;
  if (mode !== "critical" && mode !== "criticalSoon" && mode !== "selected") {
    return { ok: false, error: "mode must be critical, criticalSoon, or selected" };
  }
  const location = typeof body.location === "string" && body.location ? body.location : "all";
  if (location !== "all" && !UUID_RE.test(location)) {
    return { ok: false, error: "location must be all or a valid location id" };
  }
  const variantIds = Array.isArray(body.variantIds) ? body.variantIds.filter((v): v is string => typeof v === "string") : undefined;
  if (mode === "selected" && (!variantIds || variantIds.length === 0)) {
    return { ok: false, error: "selected mode requires at least one variant id" };
  }
  if (variantIds?.some((id) => !UUID_RE.test(id))) {
    return { ok: false, error: "variantIds must contain only valid ids" };
  }
  return { ok: true, mode, location, variantIds };
}

export const POST = withAdminAuth("inventory.adjust", async (request, ctx) => {
  try {
    const parsed = parseBody(await request.json() as Record<string, unknown>);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    let locationId: string | undefined;
    if (ctx.allowedLocations) {
      if (parsed.location === "all") {
        locationId = ctx.locationId ?? ctx.allowedLocations[0];
      } else if (ctx.allowedLocations.includes(parsed.location)) {
        locationId = parsed.location;
      } else {
        return NextResponse.json({ error: "Location not assigned to this employee" }, { status: 403 });
      }
    } else if (parsed.location !== "all") {
      locationId = parsed.location;
    }

    const result = await createPurchaseOrdersFromForecast({
      orgId: ctx.orgId,
      employeeId: ctx.employee.id,
      locationId,
      risks: risksForMode(parsed.mode),
      variantIds: parsed.variantIds,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("PO from forecast error:", safeErr(error));
    return NextResponse.json({ error: "Failed to create purchase orders from forecast" }, { status: 500 });
  }
});
