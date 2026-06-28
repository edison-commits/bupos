import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { getSalesByStorePeriod, type SalesGroupBy } from "@/lib/reports/admin-analytics";

const MAX_REPORT_DAYS = 400;

function isSalesGroupBy(value: string): value is SalesGroupBy {
  return value === "day" || value === "month" || value === "year";
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime());
}

function spanDays(from: string, to: string): number {
  const fromMs = new Date(`${from}T00:00:00Z`).getTime();
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  return Math.floor((toMs - fromMs) / 86_400_000);
}

export const GET = withAuth("audit.view", async (req, ctx) => {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  const groupBy = sp.get("groupBy") ?? "month";
  const requestedLocation = sp.get("location") ?? ctx.locationId ?? "all";

  if (!from || !to) {
    return NextResponse.json({ error: "Missing required parameters: from, to" }, { status: 400 });
  }
  if (!isValidDate(from) || !isValidDate(to)) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD." }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: "'from' must be before or equal to 'to'." }, { status: 400 });
  }
  if (!isSalesGroupBy(groupBy)) {
    return NextResponse.json({ error: "Invalid groupBy. Use day, month, or year." }, { status: 400 });
  }
  if (spanDays(from, to) > MAX_REPORT_DAYS) {
    return NextResponse.json({ error: "Date range exceeds 400-day cap. Use export for longer ranges." }, { status: 400 });
  }

  let locationIds: string[] | undefined;
  if (ctx.allowedLocations) {
    if (requestedLocation === "all") {
      locationIds = ctx.allowedLocations;
    } else if (ctx.allowedLocations.includes(requestedLocation)) {
      locationIds = [requestedLocation];
    } else {
      return NextResponse.json({ error: "Location not assigned to this employee" }, { status: 403 });
    }
  } else if (requestedLocation !== "all") {
    locationIds = [requestedLocation];
  }

  const rows = await getSalesByStorePeriod({
    orgId: ctx.orgId,
    from,
    to,
    groupBy,
    locationIds,
  });

  return NextResponse.json({
    groupBy,
    from,
    to,
    rows,
  });
});
