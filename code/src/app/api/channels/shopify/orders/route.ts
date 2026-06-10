import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { getOnlineSalesReport } from "@/lib/channels/repo";

/**
 * GET: the dedicated "Online Sales" report (summary + recent orders) for the
 * Online Selling tab. Read-only, org-scoped, fed from online_orders only —
 * intentionally NOT merged into the in-store transactions/shift reports.
 * Query param `days` (1..365, default 30) sets the lookback window.
 */
export const GET = withAdminAuth("online.manage", async (req, ctx) => {
  const { orgId } = ctx;
  const daysRaw = Number(new URL(req.url).searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, Math.floor(daysRaw))) : 30;
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const report = await getOnlineSalesReport(orgId, sinceIso, 100);
  return NextResponse.json({ days, ...report });
});
