import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withAuth } from "@/lib/api/with-auth";

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
export const GET = withAuth("audit.view", async (req, ctx) => {
  const orgId = ctx.orgId;

  const sp = req.nextUrl.searchParams;

  const pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize")) || 50));
  const cursorParam = sp.get("cursor");
  let cursorId: string | null = null;
  let cursorCreatedAt: string | null = null;
  if (cursorParam) {
    try {
      const decoded = JSON.parse(Buffer.from(cursorParam, "base64").toString("utf-8"));
      // Validate shape before handing to pg. A crafted cursor with
      // `id: "not-a-uuid"` or `created_at: "not-a-timestamp"` would otherwise
      // trip pg's type parser and 500 the audit page on every keystroke of
      // pagination — making the audit trail unreadable on demand.
      const maybeId = decoded?.id;
      const maybeCreated = decoded?.created_at;
      if (typeof maybeId === "string" && /^[0-9a-f-]{36}$/i.test(maybeId)) {
        cursorId = maybeId;
      }
      if (typeof maybeCreated === "string" && !Number.isNaN(Date.parse(maybeCreated))) {
        cursorCreatedAt = maybeCreated;
      }
      // Both must be set to use the cursor — otherwise start from scratch.
      if (cursorId === null || cursorCreatedAt === null) {
        cursorId = null;
        cursorCreatedAt = null;
      }
    } catch {
      // Invalid cursor — ignore
    }
  }

  // Both UNION branches alias their rows to `x.`, so conditions always use
  // the `x.` prefix. The old code text-replaced `/te\./g → 'x.'` on a single
  // condition array, which was fragile: any future LIKE value containing the
  // literal `te.` would also get rewritten. Building conditions directly
  // with `x.` makes the SQL source-true and removes the regex footgun.
  const conditionsX: string[] = [];
  const values: unknown[] = [];
  let idx = 0;
  const addCond = (xExpr: string, val: unknown) => {
    idx++;
    conditionsX.push(xExpr.replace(/\$N/g, `$${idx}`));
    values.push(val);
  };

  // R28-C1: the R27-C3 fix here was broken. It added `x.organization_id
  // = $N` to conditionsX, which applies to BOTH UNION branches. But
  // `transaction_events` does NOT have an organization_id column (see
  // migration 001 line 300-308 — only id, transaction_id,
  // actor_employee_id, event_kind, notes, payload, created_at). Every
  // GET /api/audit threw `column x.organization_id does not exist`.
  //
  // New shape: scope each branch separately.
  //   • audit_events branch: direct `x.organization_id = $1`
  //   • transaction_events branch: subquery through `transactions`
  //     (FK-scoped — same pattern the prior location-filter code used
  //     when allowedLocations was set; now always-on regardless).
  // The per-branch filters are assembled below as locFilterTxn /
  // locFilterAudit which were repurposed to carry org scoping too.

  // $1 is reserved for orgId, used by both branches' per-branch filters.
  idx++;
  values.push(orgId);
  const orgIdParam = `$${idx}`;

  const from = sp.get("from");
  if (from) addCond("x.created_at >= $N", from);

  const to = sp.get("to");
  if (to) addCond("x.created_at <= $N", to);

  const employeeId = sp.get("employee_id");
  if (employeeId) {
    // Validate the UUID shape before pushing into pg; an attacker cycling
    // `?employee_id=not-a-uuid` would otherwise 500 every audit request.
    if (!/^[0-9a-f-]{36}$/i.test(employeeId)) {
      return NextResponse.json({ error: "Invalid employee_id" }, { status: 400 });
    }
    // R32-D5: non-managers can only filter to THEIR OWN employee_id.
    // Prior shape let any audit.view holder (support, inventory_clerk)
    // page through an owner's every action by filtering on the owner's
    // employee_id — privacy leak + social-engineering intel. Managers
    // + owners keep org-wide visibility for legitimate investigation.
    const isManager = ctx.employee.roleKey === "owner" || ctx.employee.roleKey === "manager";
    if (!isManager && employeeId !== ctx.employee.id) {
      return NextResponse.json(
        { error: "Only managers can filter audit events by another employee." },
        { status: 403 },
      );
    }
    addCond("x.actor_employee_id = $N", employeeId);
  }

  // R13-H-5 + R14-C-2: push event_kind filter to the OUTER SELECT over
  // `combined` so a kind living only in audit_events doesn't wastefully
  // scan the transaction_events branch (or vice versa).
  //
  // R14-C-2: the previous revision validated event_kind against a hardcoded
  // allowlist that fell out of date with every new `pgInsertAuditEvent`
  // caller (typo `inventory_adjust` vs emitted `inventory_adjustment`, +
  // ~20 other missing kinds). Legitimate filter values returned 400.
  //
  // The right abstraction: event_kind is not security-critical (queries
  // are parameterized) — it's just a UX value used for filter UI. A regex
  // sanity check blocks garbage without needing to maintain a perfect
  // allowlist that drifts behind emitters. The admin UI already derives
  // its dropdown options from `kinds.add(event.event_kind)` on observed
  // data (see admin/audit/page.tsx:116), so the union is self-healing.
  const EVENT_KIND_RX = /^[a-z][a-z0-9_]{0,63}$/;
  const eventKindRaw = sp.get("event_kind");
  const eventKind = eventKindRaw && EVENT_KIND_RX.test(eventKindRaw) ? eventKindRaw : null;
  if (eventKindRaw && !eventKind) {
    return NextResponse.json(
      { error: "Invalid event_kind; must match /^[a-z][a-z0-9_]{0,63}$/" },
      { status: 400 },
    );
  }

  // R12-H-2: location-scope filter. `audit.view` is held by inventory_clerk
  // and support — without this they paged through every store's audit
  // events (manager overrides, pay-in/outs, customer PII, promo redemptions)
  // org-wide. Owners and managers still see everything via
  // allowedLocations === null.
  //
  // transaction_events has no location_id column, but the parent
  // `transactions` row does — join via x.transaction_id. audit_events has
  // its own nullable `location_id`. We filter each branch separately
  // below; `conditionsX` (used on both UNION branches) can't distinguish
  // them, so we build two separate WHERE clauses.
  if (cursorCreatedAt !== null && cursorId !== null) {
    idx += 2;
    conditionsX.push(`(x.created_at, x.id) < ($${idx - 1}, $${idx})`);
    values.push(cursorCreatedAt, cursorId);
  }

  // Location scope — encode the filter on `x.id IN (...)` by joining the
  // right table per branch. We do this by composing an extra WHERE on each
  // branch AFTER building `whereX`.
  const baseWhereX = conditionsX.length > 0 ? `WHERE ${conditionsX.join(" AND ")}` : "";

  // R28-C1: per-branch org filter (was part of conditionsX but that
  // applied to both branches; transaction_events has no organization_id
  // column). Transaction events scope via the parent transactions row;
  // audit events scope on their own organization_id column.
  let branchFilterTxn = ` AND x.transaction_id IN (SELECT id FROM transactions WHERE organization_id = ${orgIdParam})`;
  let branchFilterAudit = ` AND x.organization_id = ${orgIdParam}`;

  if (ctx.allowedLocations !== null) {
    if (ctx.allowedLocations.length === 0) {
      // No assigned locations means no visible events.
      return NextResponse.json({ events: [], nextCursor: null, hasMore: false });
    }
    idx += 1;
    values.push(ctx.allowedLocations);
    // Extend the transactions subquery to also gate by location for
    // non-managers. The org filter is already inside the subquery; add
    // the location constraint to it.
    branchFilterTxn = ` AND x.transaction_id IN (SELECT id FROM transactions WHERE organization_id = ${orgIdParam} AND location_id = ANY($${idx}::uuid[]))`;
    // audit_events.location_id may be null (org-level events). Non-managers
    // shouldn't see null-location events either — they represent org-wide
    // actions like signup / plan-change that only owner/manager need.
    branchFilterAudit = ` AND x.organization_id = ${orgIdParam} AND x.location_id = ANY($${idx}::uuid[])`;
  }

  const whereX = baseWhereX;
  // Append the per-branch filter to whereX. When there's no base WHERE,
  // attach as `WHERE <filter>`; otherwise append with `AND`. Strip the
  // leading " AND " from branchFilter* accordingly.
  const attachFilter = (base: string, filter: string) => {
    if (!filter) return base;
    if (base === "") return `WHERE ${filter.replace(/^\s+AND\s+/i, "")}`;
    return `${base}${filter}`;
  };

  // R13-H-5: event_kind filter applied to the OUTER SELECT so a kind that
  // lives only in audit_events doesn't cause the transaction_events branch
  // to return 0 rows (and vice versa). Each branch still does its own
  // date/employee/cursor/location filtering for index efficiency.
  let outerWhere = "";
  const outerParams: unknown[] = [];
  if (eventKind) {
    idx += 1;
    outerParams.push(eventKind);
    outerWhere = ` WHERE event_kind = $${idx}`;
  }

  // R28-C1: each UNION branch gets its own org-scoped filter:
  //   • transaction_events has NO organization_id column, so scope via
  //     subquery through the parent `transactions` row.
  //   • audit_events HAS organization_id, so gate directly.
  // The employees LEFT JOIN is also org-gated so a crafted
  // actor_employee_id can't splice a foreign display name in.
  // check-pool-org-filter: scoped-by-R28-C1-per-branch-filters
  const rows = await orgQuery(
    orgId,
    `SELECT * FROM (
       SELECT
         x.id, x.transaction_id, x.actor_employee_id,
         COALESCE(e.display_name, e.first_name || ' ' || e.last_name, 'Unknown') AS actor_name,
         e.role_key, x.event_kind, x.notes, x.payload, x.created_at
       FROM transaction_events x
       LEFT JOIN employees e ON e.id = x.actor_employee_id AND e.organization_id = ${orgIdParam}
       ${attachFilter(whereX, branchFilterTxn)}
       UNION ALL
       SELECT
         x.id, NULL AS transaction_id, x.actor_employee_id,
         COALESCE(e.display_name, e.first_name || ' ' || e.last_name, 'System') AS actor_name,
         e.role_key, x.event_kind, NULL AS notes, x.payload, x.created_at
       FROM audit_events x
       LEFT JOIN employees e ON e.id = x.actor_employee_id AND e.organization_id = ${orgIdParam}
       ${attachFilter(whereX, branchFilterAudit)}
     ) combined${outerWhere}
     ORDER BY created_at DESC, id DESC
     LIMIT $${idx + 1}`,
    [...values, ...outerParams, pageSize + 1],
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
});
