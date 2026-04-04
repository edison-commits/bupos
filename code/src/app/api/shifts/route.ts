import { BUPOS_LOCATION_ID } from "@/lib/env";
import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";
import { pgOpenShift } from "@/lib/persistence/postgres-store";
import { randomUUID } from "node:crypto";
import { requireAdminPermission } from "@/lib/authz";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";

const LOCATION_ID = BUPOS_LOCATION_ID;

export async function GET(req: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }  if (!adminCtx && !registerCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sp = req.nextUrl.searchParams;
    const pageRaw = parseInt(sp.get("page") ?? "1", 10);
    const pageSizeRaw = parseInt(sp.get("pageSize") ?? "20", 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(100, pageSizeRaw) : 20;
    const status = sp.get("status") ?? "all";
    const date = sp.get("date");
    const offset = (page - 1) * pageSize;

    const conditions: string[] = ["s.location_id = $1"];
    const params: unknown[] = [LOCATION_ID];

    if (status === "open") {
      conditions.push("s.status = 'open'");
    } else if (status === "closed") {
      conditions.push("s.status = 'closed'");
    }

    if (date) {
      params.push(`${date}T00:00:00.000Z`);
      conditions.push(`s.opened_at >= $${params.length}`);
      params.push(`${date}T23:59:59.999Z`);
      conditions.push(`s.opened_at <= $${params.length}`);
    }

    const where = conditions.join(" AND ");

    // Total count
    const countResult = await orgQuery(
      orgId,
      `SELECT COUNT(*)::int AS total FROM shifts s WHERE ${where}`,
      params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    // Paginated shifts
    const shifts = await orgQuery(
      orgId,
      `SELECT
         s.id,
         s.employee_id,
         COALESCE(e.display_name, e.first_name || ' ' || e.last_name) AS employee_name,
         s.opened_at,
         s.closed_at,
         s.status,
         s.opening_float,
         s.closing_expected_cash,
         s.closing_declared_cash,
         s.closing_variance
       FROM shifts s
       LEFT JOIN employees e ON e.id = s.employee_id
       WHERE ${where}
       ORDER BY s.opened_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );

    const result = shifts.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      employeeId: row.employee_id as string,
      employeeName: (row.employee_name as string) ?? "Unknown",
      openedAt: row.opened_at as string,
      closedAt: row.closed_at as string | null,
      status: row.status as string,
      openingFloat: Number(row.opening_float ?? 0),
      expectedCash: row.closing_expected_cash != null ? Number(row.closing_expected_cash) : null,
      declaredCash: row.closing_declared_cash != null ? Number(row.closing_declared_cash) : null,
      variance: row.closing_variance != null ? Number(row.closing_variance) : null,
    }));

    return NextResponse.json({
      shifts: result,
      total,
      page,
      pageSize,
    });
  } catch (error) {
    console.error("[shifts GET]", error);
    return NextResponse.json({ error: "Failed to load shifts" }, { status: 500 });
  }
}

// POST /api/shifts — open a new shift (admin-initiated, no register session required)
export async function POST(req: NextRequest) {
  const ctx = await requireAdminPermission('register.open');
  const orgId = ctx.employee.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { employeeId, locationId, openingFloat, openedNote } = await req.json();

    if (!employeeId || !locationId) {
      return NextResponse.json({ error: "Employee and location are required" }, { status: 400 });
    }
    if (typeof openingFloat !== "number" || openingFloat < 0) {
      return NextResponse.json({ error: "Opening float must be 0 or greater" }, { status: 400 });
    }

    // Check for existing open shift
    const existing = await orgQuery(
      orgId,
      `SELECT id FROM shifts WHERE employee_id = $1 AND location_id = $2 AND status = 'open' LIMIT 1`,
      [employeeId, locationId],
    );
    if (existing.rows.length > 0) {
      return NextResponse.json({ error: "Employee already has an open shift" }, { status: 409 });
    }

    const shiftId = randomUUID();
    const shift = await pgOpenShift({
      id: shiftId,
      locationId,
      employeeId,
      registerSessionId: null, // admin-initiated
      openingFloat,
      openedNote: openedNote || undefined,
    });

    return NextResponse.json({ shift, success: true });
  } catch (error) {
    console.error("[shifts POST]", error);
    return NextResponse.json({ error: "Failed to open shift" }, { status: 500 });
  }
}
