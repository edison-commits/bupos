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
 *   cursor      — base64(JSON.stringify({ id, created_at })) for cursor-based pagination
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

    const pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize")) || 50));
    const cursorParam = sp.get("cursor");
    let cursorId: string | null = null;
    let cursorCreatedAt: string | null = null;
    if (cursorParam) {
      try {
        const decoded = JSON.parse(Buffer.from(cursorParam, "base64").toString("utf-8"));
        cursorId = decoded.id ?? null;
        cursorCreatedAt = decoded.created_at ?? null;
      } catch {
        // Invalid cursor — ignore
      }
    }

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

    // Cursor: (created_at, id) < (cursor_created_at, cursor_id) for descending order
    if (cursorCreatedAt !== null && cursorId !== null) {
      conditions.push(`(te.created_at, te.id) < ($${idx + 1}, $${idx + 2})`);
      values.push(cursorCreatedAt, cursorId);
      idx += 2;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Fetch pageSize + 1 to determine if there's a next page
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
       ORDER BY te.created_at DESC, te.id DESC
       LIMIT $${idx}`,
      [...values, pageSize + 1],
    );

    const hasMore = rows.rows.length > pageSize;
    const events = hasMore ? rows.rows.slice(0, pageSize) : rows.rows;

    let nextCursor: string | null = null;
    if (hasMore && events.length > 0) {
      const last = events[events.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ id: last.id, created_at: last.created_at })).toString("base64");
    }

    return NextResponse.json({
      events,
      nextCursor,
      hasMore,
    });
  } catch (err) {
    console.error("GET /api/audit error:", err);
    return NextResponse.json(
      { error: "Failed to fetch audit events" },
      { status: 500 }
    );
  }
}
