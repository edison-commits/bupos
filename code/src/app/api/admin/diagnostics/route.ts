import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { orgQuery } from "@/lib/supabase-rest";
import { buildSupportPacket, runAdminDiagnostics } from "@/lib/diagnostics/admin-diagnostics";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, private, max-age=0" };

export const GET = withAdminAuth("audit.view", async (req, ctx) => {
  const diagnostics = await runAdminDiagnostics(
    {
      orgId: ctx.orgId,
      locationId: ctx.locationId,
      allowedLocations: ctx.allowedLocations,
      employee: {
        id: ctx.employee.id,
        roleKey: ctx.employee.roleKey,
        locationIds: ctx.employee.locationIds,
      },
      reqId: ctx.reqId,
    },
    (sql, values) => orgQuery(ctx.orgId, sql, values),
  );

  if (req.nextUrl.searchParams.get("format") === "packet") {
    return NextResponse.json(buildSupportPacket(diagnostics), { headers: NO_STORE_HEADERS });
  }

  return NextResponse.json(diagnostics, { headers: NO_STORE_HEADERS });
});
