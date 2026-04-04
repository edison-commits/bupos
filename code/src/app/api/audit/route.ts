import { BUPOS_LOCATION_ID } from "@/lib/env";
import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";

const LOCATION_ID = BUPOS_LOCATION_ID;

/**
 * GET /api/audit
 *
 * Query params:
 *   from        — start date (ISO)
 *   to          — end date (ISO)
 *   employee_id — filter by actor_employee_id
 *   event_kind  — filter by specific event kind
 *   page        — page number (default 1)
 *   pageSize    — results per page (default 50, max 200)
 *
 * Returns paginated transaction events with employee display names.
 */
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

    const page = Math.max(1, Number(sp.get("page")) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize")) || 50));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 0;

    const from = sp.get("from");
    if (from) {
      idx++;
      conditions.push(`te.created_at >= $${idx}`);
      values.push(from);
    }

    const to = sp.get("to");
    if (to) {
      idx++;
      conditions.push(`te.created_at <= $${idx}`);
      values.push(to);
    }

    const employeeId = sp.get("employee_id");
    if (employeeId) {
      idx++;
      conditions.push(`te.actor_employee_id = $${idx}`);
      values.push(employeeId);
    }

    const eventKind = sp.get("event_kind");
    if (eventKind) {
      idx++;
      conditions.push(`te.event_kind = $${idx}`);
      values.push(eventKind);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count total records
    const countResult = await orgQuery(
      orgId,
      `SELECT COUNT(*)::int AS total FROM transaction_events te ${where}`,
      values
    );
    const total = countResult.rows[0]?.total ?? 0;

    // Fetch paginated results with employee display name
    const resultIdx1 = idx + 1;
    const resultIdx2 = idx + 2;
    const rows = await orgQuery(
      orgId,
      `SELECT 
         te.id,
         te.transaction_id,
         te.actor_employee_id,
         COALESCE(e.display_name, e.first_name || ' ' || e.last_name, 'Unknown') AS actor_name,
         e.role_key,
         te.event_kind,
         te.notes,
         te.payload,
         te.created_at
       FROM transaction_events te
       LEFT JOIN employees e ON e.id = te.actor_employee_id
       ${where}
       ORDER BY te.created_at DESC
       LIMIT $${resultIdx1} OFFSET $${resultIdx2}`,
      [...values, pageSize, offset]
    );

    return NextResponse.json({
      events: rows.rows,
      pagination: { 
        page, 
        pageSize, 
        total, 
        totalPages: Math.ceil(total / pageSize) 
      },
    });
  } catch (err) {
    console.error("GET /api/audit error:", err);
    return NextResponse.json(
      { error: "Failed to fetch audit events" },
      { status: 500 }
    );
  }
}
