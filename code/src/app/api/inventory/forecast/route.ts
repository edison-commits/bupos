import { NextResponse } from "next/server";
import { withDualAuth } from "@/lib/api/with-auth";
import { getInventoryForecast, summarizeInventoryForecast } from "@/lib/inventory/forecast-report";
import type { StockoutRisk } from "@/lib/inventory/forecast";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function isRisk(value: string): value is StockoutRisk | "all" {
  return value === "all" || value === "critical" || value === "soon" || value === "watch" || value === "healthy" || value === "unknown";
}

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

export const GET = withDualAuth("inventory.adjust", async (req, ctx) => {
  const sp = req.nextUrl.searchParams;
  const requestedLocation = sp.get("location") ?? ctx.locationId ?? "all";
  const risk = sp.get("risk") ?? "all";
  const limit = parseLimit(sp.get("limit"));

  if (!isRisk(risk)) {
    return NextResponse.json({ error: "Invalid risk. Use all, critical, soon, watch, healthy, or unknown." }, { status: 400 });
  }

  let locationId: string | undefined;
  if (ctx.allowedLocations) {
    if (requestedLocation === "all") {
      locationId = ctx.locationId ?? ctx.allowedLocations[0];
    } else if (ctx.allowedLocations.includes(requestedLocation)) {
      locationId = requestedLocation;
    } else {
      return NextResponse.json({ error: "Location not assigned to this employee" }, { status: 403 });
    }
  } else if (requestedLocation !== "all") {
    locationId = requestedLocation;
  }

  const rows = await getInventoryForecast({
    orgId: ctx.orgId,
    locationId,
    risk,
    limit,
  });

  return NextResponse.json({
    rows,
    summary: summarizeInventoryForecast(rows),
  });
});
