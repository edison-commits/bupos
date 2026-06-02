import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { signRegisterStoreToken } from "@/lib/auth/device-cookie";

// SEC-AUDIT7-CRIT1: mint the signed per-store /register link for the
// caller's org. Managers/owners (employee.manage) provision this onto each
// register terminal; the token scopes the tap-your-name roster + clock-in
// to THIS org only, closing the cross-tenant exposure on the shared domain.
// Returns a relative path; the client prefixes window.location.origin so the
// full token never travels through a server-side host header or a log line.
export const GET = withAdminAuth("employee.manage", async (_req, ctx) => {
  const token = await signRegisterStoreToken(ctx.orgId);
  return NextResponse.json({ path: `/register?store=${token}` });
});
