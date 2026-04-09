import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import type { PermissionKey } from "@/lib/domain/types";
import { hasPermission } from "@/lib/domain/permissions";

interface AuthContext {
  session: NonNullable<Awaited<ReturnType<typeof getAdminSession>>>["session"];
  employee: NonNullable<Awaited<ReturnType<typeof getAdminSession>>>["employee"];
  orgId: string;
}

/**
 * Wraps an API route handler with session validation, permission check,
 * org context extraction, and standardized error formatting.
 *
 * Usage:
 *   export const GET = withAuth("audit.view", async (req, ctx) => { ... });
 */
export function withAuth(
  permission: PermissionKey,
  handler: (req: NextRequest, ctx: AuthContext) => Promise<NextResponse>,
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
      });
    } catch (err) {
      console.error(`[${req.method} ${req.nextUrl.pathname}]`, err);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 },
      );
    }
  };
}
