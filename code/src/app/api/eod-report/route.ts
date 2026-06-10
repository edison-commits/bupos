import { NextResponse } from "next/server";
import { withAdminAuth, withDualAuth } from "@/lib/api/with-auth";
import { validateBody, eodReportSchema } from "@/lib/validation/schemas";
import { safeErr } from "@/lib/logging/safe-err";
// P3.2: the report engine moved VERBATIM to src/lib/reports/eod.ts so the
// sales-digest sender can reuse it (route files may only export handlers).
// Behavior of GET/POST here is unchanged.
import { generateReportData, sendEodEmail, hasResendKey } from "@/lib/reports/eod";

/**
 * GET /api/eod-report  [DEPRECATED — no UI consumer; hardcoded locationId]
 *
 * Previously used by an EOD email cron. The email delivery now uses POST.
 * GET has no active consumer and relies on the hardcoded BUPOS_locationId,
 * making it unreliable for multi-location deployments.
 */
export const GET = withDualAuth("audit.view", async (req, ctx) => {
  const { orgId, locationId } = ctx;
  try {
    const reportData = await generateReportData(orgId, locationId);
    return NextResponse.json(reportData);
  } catch (error) {
    console.error("EOD Report GET error:", safeErr(error));
    return NextResponse.json(
      { error: "Failed to generate report data" },
      { status: 500 }
    );
  }
});

/**
 * POST /api/eod-report
 * Generate and send the daily email report
 */
export const POST = withAdminAuth("audit.view", async (req, ctx) => {
  const { orgId, employee } = ctx;
  const body = await req.json().catch(() => ({}));
  const v = validateBody(eodReportSchema, body);
  if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });

  // Prefer the active-location header/cookie (wired through withAdminAuth)
  // so a multi-location manager gets the EOD for the store they're viewing,
  // not the first in their assignment. Fall back to ctx.locationId (already
  // resolved to locationIds[0] by the wrapper) for non-JS clients.
  const locationId = ctx.locationId ?? employee.locationIds?.[0];
  let reportData;
  try {
    reportData = await generateReportData(orgId, locationId);
  } catch (error) {
    console.error("EOD Report: data generation failed:", safeErr(error));
    return NextResponse.json({ error: "Failed to generate report data" }, { status: 500 });
  }

  if (!hasResendKey()) {
    return NextResponse.json({
      success: true,
      message: "Report generated (email not sent - no API key)",
      reportData,
    });
  }

  try {
    await sendEodEmail(reportData);
    return NextResponse.json({ success: true, message: "Report generated and sent", reportData });
  } catch (error) {
    console.error("EOD Report: email send failed:", safeErr(error));
    // Report was generated OK; email delivery failed — surface this clearly
    return NextResponse.json(
      { error: "Report generated but email delivery failed" },
      { status: 502 }
    );
  }
});
