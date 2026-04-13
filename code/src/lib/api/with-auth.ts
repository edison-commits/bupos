import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";
import type { PermissionKey } from "@/lib/domain/types";
import { hasPermission } from "@/lib/domain/permissions";

interface AdminContext {
  session: NonNullable<Awaited<ReturnType<typeof getAdminSession>>>["session"];
  employee: NonNullable<Awaited<ReturnType<typeof getAdminSession>>>["employee"];
  orgId: string;
  locationId: string | undefined;
}

interface DualContext extends AdminContext {
  registerSession: Awaited<ReturnType<typeof getRegisterSession>>;
}

/**
 * Auth wrapper for admin-only API routes.
 * Returns 401 JSON instead of redirecting (correct for API routes).
 *
 * Usage:
 *   export const GET = withAdminAuth("audit.view", async (req, ctx) => { ... });
 */
export function withAdminAuth(
  permission: PermissionKey,
  handler: (req: NextRequest, ctx: AdminContext) => Promise<NextResponse>,
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const adminCtx = await getAdminSession();
    if (!adminCtx?.session || !adminCtx?.employee) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(adminCtx.employee.roleKey, permission)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const orgId = adminCtx.employee.organizationId;
    if (!orgId) {
      return NextResponse.json({ error: "No organization context" }, { status: 400 });
    }
    try {
      return await handler(req, {
        session: adminCtx.session,
        employee: adminCtx.employee,
        orgId,
        locationId: adminCtx.employee.locationIds?.[0],
      });
    } catch (err) {
      console.error(`[${req.method} ${req.nextUrl.pathname}]`, err);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

/** Backward-compatible alias for existing routes (audit, dashboard, reports) */
export const withAuth = withAdminAuth;

/**
 * Auth wrapper for API routes accessible from both admin panel AND register.
 * Tries admin session first, falls back to register session.
 *
 * Usage:
 *   export const GET = withDualAuth("transactions.view", async (req, ctx) => { ... });
 */
export function withDualAuth(
  permission: PermissionKey,
  handler: (req: NextRequest, ctx: DualContext) => Promise<NextResponse>,
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
    const ctx = adminCtx?.session && adminCtx?.employee ? adminCtx : null;
    const regCtx = registerCtx?.employee ? registerCtx : null;

    if (!ctx && !regCtx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const employee = ctx?.employee ?? regCtx?.employee;
    if (!employee || !hasPermission(employee.roleKey, permission)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const orgId = ctx?.employee?.organizationId ?? regCtx?.employee?.organizationId;
    if (!orgId) {
      return NextResponse.json({ error: "No organization context" }, { status: 400 });
    }

    try {
      return await handler(req, {
        session: ctx!.session,
        employee: ctx?.employee ?? regCtx!.employee,
        orgId,
        locationId: ctx?.employee?.locationIds?.[0] ?? regCtx?.location?.id,
        registerSession: regCtx,
      });
    } catch (err) {
      console.error(`[${req.method} ${req.nextUrl.pathname}]`, err);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
