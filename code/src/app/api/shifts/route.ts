import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";
import { pgOpenShift } from "@/lib/persistence/postgres-store";
import { randomUUID } from "node:crypto";
import { requireAdminPermission } from "@/lib/authz";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";

const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const LOCATION_ID = "c57268b3-cb14-4c1a-bda6-55e49ddc6313";

export async function GET(req: NextRequest) {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  if (!adminCtx && !registerCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sp = req.nextUrl.searchParams;
    const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") ?? "20", 10)));
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
      ORG_ID,
      `SELECT COUNT(*)::int AS total FROM shifts s WHERE ${where}`,
      params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    // Paginated shifts
    const shifts = await orgQuery(
      ORG_ID,
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
  await requireAdminPermission('register.open');
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
      ORG_ID,
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
