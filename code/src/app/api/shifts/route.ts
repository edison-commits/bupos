import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { pgOpenShift } from "@/lib/persistence/postgres-store";
import { randomUUID } from "@/lib/uuid";
import { withDualAuth, withAdminAuth } from "@/lib/api/with-auth";
import { validateBody, shiftCreateSchema } from "@/lib/validation/schemas";

import { safeErr, safeErrorName } from "@/lib/logging/safe-err";
export const GET = withDualAuth("register.open", async (req, ctx) => {
  const { orgId, locationId } = ctx;
  try {
    const sp = req.nextUrl.searchParams;
    const pageRaw = parseInt(sp.get("page") ?? "1", 10);
    const pageSizeRaw = parseInt(sp.get("pageSize") ?? "20", 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(100, pageSizeRaw) : 20;
    const status = sp.get("status") ?? "all";
    // R30-L3: validate the date format before interpolating into the
    // ISO-8601 suffix. Prior shape accepted any string and passed
    // `"${date}T00:00:00.000Z"` to PG, which 500'd on malformed input
    // instead of returning a clean 400.
    const dateRaw = sp.get("date");
    const date = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;
    if (dateRaw && !date) {
      return NextResponse.json(
        { error: "Invalid date format. Use YYYY-MM-DD." },
        { status: 400 },
      );
    }
    const offset = (page - 1) * pageSize;

    // Non-managers can only see their own shifts. `closing_variance` +
    // `closing_declared_cash` are performance-review data (variance is used
    // when deciding termination / coaching); a cashier listing peer
    // variance is a leak.
    // R30-M2: `s.organization_id = $1` is STATIC in the base SQL below.
    // Prior shape built the entire WHERE from `conditions` starting with
    // only `s.location_id = $1` — the guardrail's dynamic-interpolation
    // bypass used to auto-pass these. Both count + list queries now
    // carry the static org predicate and the dynamic clause adds extra
    // ANDs.
    const isManager = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
    const extra: string[] = ["s.location_id = $2"];
    const params: unknown[] = [orgId, locationId];
    if (!isManager) {
      params.push(ctx.employee.id);
      extra.push(`s.employee_id = $${params.length}`);
    }

    if (status === "open") {
      extra.push("s.status = 'open'");
    } else if (status === "closed") {
      extra.push("s.status = 'closed'");
    }

    if (date) {
      // R88-MED: org-TZ day bounds for shift date filter, not UTC.
      // `opened_at` is TIMESTAMPTZ and Pacific-TZ stores filtering
      // "2026-04-22" previously got UTC-midnight-to-UTC-midnight, so a
      // shift opened at 2026-04-22 23:30 PT (= 2026-04-23 06:30 UTC)
      // fell out of the filter even though the manager considered it
      // a 2026-04-22 shift. Sibling of R83-SEC-H2 dashboard, R83 /api/export
      // transactions, R83 reports hourly, and R87 /api/returns/search
      // fixes — sixth and (hopefully) last timezone-sibling in the sweep.
      const { buildOrgDayRange } = await import("@/lib/reports/day-range");
      const { fromTs, toTs } = await buildOrgDayRange(orgId, date, date);
      params.push(fromTs);
      extra.push(`s.opened_at >= $${params.length}`);
      params.push(toTs);
      extra.push(`s.opened_at < $${params.length}`);
    }

    const andClause = extra.length > 0 ? ` AND ${extra.join(" AND ")}` : "";

    // Total count
    const countResult = await orgQuery(
      orgId,
      `SELECT COUNT(*)::int AS total FROM shifts s WHERE s.organization_id = $1${andClause}`,
      params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    // Paginated shifts
    // R30-M2 defense-in-depth: employees JOIN also org-gated so a
    // cross-tenant employee_id FK (shouldn't exist with the s.org
    // filter above, but defense-in-depth) can't splice foreign names.
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
       LEFT JOIN employees e ON e.id = s.employee_id AND e.organization_id = $1
       WHERE s.organization_id = $1${andClause}
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
    // Surface error class + pg code in BOTH structured log AND
    // response _diag so ops can triage from devtools without
    // Worker-log access. Same shape as /api/dashboard.
    // OPS-AUDIT4-2: full error.name in structured log, whitelist
    // version in response _diag (see /api/dashboard for rationale).
    const errName = error instanceof Error ? error.name : 'unknown';
    const errNameSafe = safeErrorName(error);
    const errCode = (error as { code?: string })?.code ?? null;
    console.error(JSON.stringify({
      level: "error",
      event: "shifts_load_failed",
      error_name: errName,
      pg_code: errCode,
      error: safeErr(error),
    }));
    return NextResponse.json({
      error: "Failed to load shifts",
      _diag: { error_name: errNameSafe, pg_code: errCode },
    }, { status: 500 });
  }
});

// POST /api/shifts — open a new shift (admin-initiated, no register session required).
//
// Gated on `register.open` because that's the baseline permission every
// cashier already has. The R7-C-2 additions inside the handler further
// restrict WHO can open a shift FOR WHOM (self-only for non-managers) and
// WHERE (location must be in the actor's assignment). A future refactor
// could introduce a dedicated `shift.open_for_self` / `shift.open_for_other`
// split if permissions grow more granular, but the current gate is safe.
export const POST = withAdminAuth('register.open', async (req, ctx) => {
  const { orgId } = ctx;
  const idempotencyKey = req.headers.get('Idempotency-Key');

  try {
    const body = await req.json();
    const v = validateBody(shiftCreateSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { employeeId, locationId, openingFloat, openedNote } = v.data;

    // Target validation. Previously the POST accepted any employeeId +
    // locationId from the body with no trust-boundary check: a cashier at
    // Location A could open a shift on behalf of a manager at Location B.
    // Enforce:
    //   - caller is opening FOR THEMSELVES (default), OR is owner/manager
    //   - locationId is in the caller's assignment (owner/manager bypass)
    //   - target employee exists in caller's org and is active
    const isManager = ["owner", "manager"].includes(ctx.employee.roleKey);
    if (!isManager && employeeId !== ctx.employee.id) {
      return NextResponse.json(
        { error: "Only owners or managers may open a shift on behalf of another employee" },
        { status: 403 },
      );
    }
    if (!isManager && !(ctx.employee.locationIds ?? []).includes(locationId)) {
      return NextResponse.json(
        { error: "Location not assigned to this employee" },
        { status: 403 },
      );
    }
    const { rows: targetRows } = await orgQuery(
      orgId,
      `SELECT id, is_active FROM employees WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [employeeId, orgId],
    );
    if (targetRows.length === 0) {
      return NextResponse.json({ error: "Target employee not found" }, { status: 404 });
    }
    if (!targetRows[0].is_active) {
      return NextResponse.json({ error: "Target employee is inactive" }, { status: 400 });
    }
    const { rows: locRows } = await orgQuery(
      orgId,
      `SELECT id FROM locations WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [locationId, orgId],
    );
    if (locRows.length === 0) {
      return NextResponse.json({ error: "Location not found" }, { status: 404 });
    }

    // Idempotency: if key provided, look for an already-succeeded shift
    if (idempotencyKey) {
      const existing = await orgQuery(
        orgId,
        `SELECT id, employee_id, location_id, opening_float, status, opened_at FROM shifts WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [orgId, idempotencyKey],
      );
      if (existing.rows.length > 0) {
        // Payload-match: if the caller retries with the SAME idempotency key
        // but a different (employee, location, opening_float), reject rather
        // than echoing the old shift as if the new request succeeded. Stops
        // idempotency-key replay across payloads.
        const prior = existing.rows[0];
        const priorFloat = Number(prior.opening_float);
        if (
          prior.employee_id !== employeeId ||
          prior.location_id !== locationId ||
          priorFloat !== Number(openingFloat)
        ) {
          return NextResponse.json(
            { error: "Idempotency key reused with a different payload" },
            { status: 409 },
          );
        }
        return NextResponse.json({ shift: existing.rows[0], success: true, _idempotent: true });
      }
    }

    const shiftId = randomUUID();
    const shift = await pgOpenShift({
      id: shiftId,
      organizationId: ctx.employee.organizationId,
      locationId,
      employeeId,
      registerSessionId: null, // admin-initiated
      openingFloat,
      openedNote: openedNote || undefined,
      idempotencyKey: idempotencyKey || undefined,
    });

    return NextResponse.json({ shift, success: true }, { status: 201 });
  } catch (error) {
    // Classify expected error messages from pgOpenShift to return
    // useful HTTP status codes. Prior shape returned a generic 500
    // for every error including "Employee already has an open shift"
    // — that's a 409 (conflict), not a server fault. Same for the
    // cross-tenant guards added by mig 077 / R-round2 (those should
    // be 403, not 500). Anything else falls through to 500.
    const msg = error instanceof Error ? error.message : '';
    if (/already has an open shift/i.test(msg)) {
      return NextResponse.json(
        { error: "Employee already has an open shift. Close it before opening a new one." },
        { status: 409 },
      );
    }
    if (/Cross-tenant /i.test(msg)) {
      return NextResponse.json(
        { error: "Forbidden: cross-tenant resource in shift open." },
        { status: 403 },
      );
    }

    // INT-AUDIT4-MED1: classify pg unique_violation 23505 from the
    // race-loser tx. Two concurrent POSTs both pass pgOpenShift's
    // SELECT FOR UPDATE check (no row to lock when none exists),
    // then race the INSERT. The losing tx hits one of three partial
    // unique indexes:
    //   - idx_shifts_one_open_per_employee (mig 043)
    //   - idx_shifts_one_open_per_register (mig 045)
    //   - idx_shifts_org_idempotency_key   (mig 045/048)
    // The pg error message ("duplicate key value violates unique
    // constraint…") doesn't match the /already has an open shift/
    // regex above, so prior shape returned a generic 500. Map back
    // to 409 Conflict for the open-shift races, and mirror the
    // idempotent-replay shape for the idempotency-key race.
    const pgCode = (error as { code?: string })?.code;
    const pgConstraint = (error as { constraint?: string })?.constraint;
    if (pgCode === '23505') {
      if (pgConstraint && /shifts_one_open_per_employee|shifts_one_open_per_register/i.test(pgConstraint)) {
        return NextResponse.json(
          { error: "Employee already has an open shift. Close it before opening a new one." },
          { status: 409 },
        );
      }
      if (pgConstraint && /idempotency/i.test(pgConstraint)) {
        // Race winner already inserted with this idempotency key —
        // re-SELECT and return the same payload so the caller sees
        // an idempotent success.
        if (idempotencyKey) {
          const replay = await orgQuery(
            orgId,
            `SELECT id, employee_id, location_id, opening_float, status, opened_at FROM shifts WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
            [orgId, idempotencyKey],
          ).catch(() => null);
          if (replay && replay.rows.length > 0) {
            return NextResponse.json({ shift: replay.rows[0], success: true, _idempotent: true });
          }
        }
        // Couldn't replay — surface as 409 (still better than 500).
        return NextResponse.json(
          { error: "Idempotency key conflict. Retry with a new key." },
          { status: 409 },
        );
      }
    }

    // Structured log for ops triage — error class + pg code surface
    // in Logpush so the actual root cause of 500s is queryable.
    // OPS-AUDIT4-2: full error.name in structured log, whitelist
    // version in response _diag (see /api/dashboard for rationale).
    const errName = error instanceof Error ? error.name : 'unknown';
    const errNameSafe = safeErrorName(error);
    const errCode = (error as { code?: string })?.code ?? null;
    console.error(JSON.stringify({
      level: "error",
      event: "shift_open_failed",
      error_name: errName,
      pg_code: errCode,
      pg_constraint: pgConstraint ?? null,
      error: safeErr(error),
    }));
    // OPS-AUDIT4-1: include _diag in 500 response to match the
    // pattern in /api/dashboard, /api/shifts GET, /api/reports.
    return NextResponse.json({
      error: "Failed to open shift",
      _diag: { error_name: errNameSafe, pg_code: errCode },
    }, { status: 500 });
  }
});
