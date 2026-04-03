import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";

const ORG_ID = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const LOCATION_ID = "c57268b3-cb14-4c1a-bda6-55e49ddc6313";

export async function GET(req: NextRequest) {
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
         COALESCE(ep.display_name, e.display_name) AS employee_name,
         s.opened_at,
         s.closed_at,
         s.status,
         s.opening_float,
         s.closing_expected_cash,
         s.closing_declared_cash,
         s.closing_variance
       FROM shifts s
       LEFT JOIN employees e ON e.id = s.employee_id
       LEFT JOIN employee_profiles ep ON ep.employee_id = s.employee_id
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
