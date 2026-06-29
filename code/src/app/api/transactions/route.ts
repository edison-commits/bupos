import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withAdminAuth } from "@/lib/api/with-auth";

import { safeErr } from "@/lib/logging/safe-err";
/**
 * BuPOS Transaction History API
 * @tags transactions
 *
 * GET /api/transactions
 *
 * Query params:
 *   search   — search by transaction ID prefix or employee name
 *   status   — filter by status (completed, voided, refunded)
 *   tender   — filter by tender_type
 *   from     — start date (ISO)
 *   to       — end date (ISO)
 *   customer — customer ID
 *   cursor   — base64(JSON.stringify({ id, created_at })) for cursor-based pagination
 *   limit    — results per page (default 50, max 200)
 *   id       — fetch single transaction by ID (returns full detail with tenders/events)
 */
export const GET = withAdminAuth("audit.view", async (req, ctx) => {
  const { orgId } = ctx;

  try {
    const sp = req.nextUrl.searchParams;

    // Location scope for non-managers. `audit.view` is held by every role
    // including inventory_clerk and support — without this filter, they can
    // page through every sale (with joined customer PII) across every
    // location in the org. Owners and managers still see everything.
    // R12-M-8: use `ctx.allowedLocations` not `ctx.employee.locationIds`
    // so register-scope callers see only their physically-connected
    // terminal's location.
    const isManager = ctx.allowedLocations === null;
    const allowedLocations = ctx.allowedLocations ?? [];

    // ── Single transaction detail ──
    const id = sp.get("id");
    if (id) {
      // R25-perf-7: consolidate 4 sequential orgQuery calls onto a
      // single orgTx client. On remote, each orgQuery opens a fresh
      // Neon WebSocket pool; previously a transaction-detail open fired
      // 4 × ~50-150ms handshakes = 200-600ms overhead. Now one
      // handshake amortized across all reads.
      const { orgTx } = await import("@/lib/supabase-rest");
      const client = await orgTx(orgId);
      let txn, tenders, events, exceptions;
      try {
        // R27-C8: explicit organization_id filter. Without it, passing
        // `?id=<foreign-UUID>` returned any tenant's full transaction
        // row including cart_snapshot + customer PII.
        txn = await client.query(
          `SELECT t.*,
                  e.display_name AS employee_name,
                  c.first_name || ' ' || c.last_name AS customer_name,
                  c.email AS customer_email,
                  c.phone AS customer_phone
           FROM transactions t
           LEFT JOIN employees e ON e.id = t.employee_id AND e.organization_id = $2
           LEFT JOIN customers c ON c.id = t.customer_id AND c.organization_id = $2
           WHERE t.id = $1 AND t.organization_id = $2`,
          [id, orgId],
        );

      if (txn.rows.length === 0) {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
        return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
      }

      // Per-record location check on the detail path — returning the row
      // first and then rejecting means less info leaks than building the
      // check into the SQL (we don't reveal whether the id exists for a
      // non-accessible location — still 404).
      if (!isManager && !allowedLocations.includes(txn.rows[0].location_id)) {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
        return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
      }

      // Scrub PII embedded in cart_snapshot for non-manager callers. The
      // snapshot JSON can include customer email/phone/address/notes that
      // the cashier typed at checkout; the paired /api/customers endpoint
      // is gated on employee.manage, so the PII should not leak via the
      // transaction detail path either.
      if (!isManager) {
        try {
          const raw = txn.rows[0].cart_snapshot;
          const snap = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (snap && typeof snap === "object") {
            delete snap.customerEmail;
            delete snap.customerPhone;
            delete snap.customerAddress;
            delete snap.customerNotes;
            txn.rows[0].cart_snapshot = snap;
          }
          // Also scrub the join-joined columns in the top-level row.
          txn.rows[0].customer_email = undefined;
          txn.rows[0].customer_phone = undefined;
        } catch {
          // If the snapshot won't parse, leave as-is — the raw JSON shouldn't
          // be decoded client-side anyway.
        }
      }

        // R27-C8: tenders/events/exceptions are FK-scoped by the
        // already-org-verified transaction_id above. Keeping the
        // simple WHERE is safe, but JOIN the employees lookup
        // through org so a cross-tenant actor_employee_id/approved_by
        // (if one ever sneaks in) can't splice foreign names.
        // check-pool-org-filter: scoped-by-just-verified-transaction-id
        tenders = await client.query(
          `SELECT id, transaction_id, tender_type, amount, metadata, created_at
             FROM transaction_tenders WHERE transaction_id = $1 ORDER BY created_at`,
          [id],
        );
        // ISO-AUDIT4-HIGH1: `transaction_events` has NO
        // `organization_id` column (mig 001 lines 300-308). The
        // prior `te.organization_id = $2` predicate threw SQLSTATE
        // 42703 (undefined_column) on EVERY detail-view of a
        // transaction with any events row — every voided / refunded
        // / manager-overridden sale 500'd. Scope via the parent
        // transactions table instead — same shape as
        // /api/audit/route.ts's R28-C1 fix.
        // check-pool-org-filter: scoped-by-parent-transactions-org
        events = await client.query(
          `SELECT te.*, e.display_name AS actor_name
             FROM transaction_events te
             LEFT JOIN employees e ON e.id = te.actor_employee_id AND e.organization_id = $2
            WHERE te.transaction_id = $1
              AND te.transaction_id IN (
                SELECT id FROM transactions WHERE organization_id = $2
              )
            ORDER BY te.created_at`,
          [id, orgId],
        );
        exceptions = await client.query(
          `SELECT tex.*, e.display_name AS approver_name
             FROM transaction_exceptions tex
             LEFT JOIN employees e ON e.id = tex.approved_by AND e.organization_id = $2
            WHERE tex.transaction_id = $1
            ORDER BY tex.created_at`,
          [id, orgId],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }

      return NextResponse.json({
        transaction: txn.rows[0],
        tenders: tenders.rows,
        events: events.rows,
        exceptions: exceptions.rows,
      });
    }

    // ── Transaction list / search with cursor-based pagination ──
    const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 50));
    const cursorParam = sp.get("cursor");
    let cursorId: string | null = null;
    let cursorCreatedAt: string | null = null;

    if (cursorParam) {
      try {
        const decoded = JSON.parse(Buffer.from(cursorParam, "base64").toString("utf-8"));
        // Validate before pushing — an attacker who crafts a base64 cursor
        // with `created_at: "not-a-timestamp"` would otherwise trip pg's
        // timestamp parser on every page turn, serving 500s instead of
        // paging correctly. Reset to null on bad input.
        const maybeCreated = decoded?.created_at;
        const maybeId = decoded?.id;
        if (typeof maybeCreated === "string" && !Number.isNaN(Date.parse(maybeCreated))) {
          cursorCreatedAt = maybeCreated;
        }
        if (typeof maybeId === "string" && /^[0-9a-f-]{36}$/i.test(maybeId)) {
          cursorId = maybeId;
        }
        if (cursorCreatedAt === null || cursorId === null) {
          cursorCreatedAt = null;
          cursorId = null;
        }
      } catch {
        // Invalid cursor — ignore and start from beginning
      }
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 0;

    // R27-C8: explicit organization_id filter. Without it, the list
    // endpoint returned every tenant's transactions for owner/manager
    // callers (non-managers were partially gated by location but the
    // location_id could be a foreign tenant's).
    idx++;
    conditions.push(`t.organization_id = $${idx}`);
    values.push(orgId);

    // Non-managers can only see transactions at their assigned locations.
    // If they have no locations, return an empty list (no data leak).
    if (!isManager) {
      if (allowedLocations.length === 0) {
        return NextResponse.json({ transactions: [], nextCursor: null, hasMore: false });
      }
      idx++;
      conditions.push(`t.location_id = ANY($${idx}::uuid[])`);
      values.push(allowedLocations);
    }

    const search = sp.get("search");
    if (search) {
      const escaped = search.replace(/[%_\\]/g, '\\$&');
      idx++;
      // UUIDs only match `[0-9a-f-]`. If the search term is clearly NOT a
      // UUID prefix, skip the `t.id::text ILIKE` branch — that branch forces
      // a per-row cast + ILIKE scan (no index can serve it), so a short
      // search like "a" triggered a seq scan over every transaction. Short
      // alphanumeric matches are now only compared against display_name.
      const looksLikeUuidPrefix = /^[0-9a-f-]+$/i.test(search);
      if (looksLikeUuidPrefix) {
        conditions.push(`(t.id::text ILIKE $${idx} OR e.display_name ILIKE $${idx})`);
      } else {
        conditions.push(`e.display_name ILIKE $${idx}`);
      }
      values.push(`%${escaped}%`);
    }

    const status = sp.get("status");
    if (status) {
      idx++;
      conditions.push(`t.status = $${idx}`);
      values.push(status);
    }

    const tender = sp.get("tender");
    if (tender) {
      idx++;
      conditions.push(`t.tender_type = $${idx}`);
      values.push(tender);
    }

    const from = sp.get("from");
    if (from) {
      idx++;
      conditions.push(`t.created_at >= $${idx}`);
      values.push(from);
    }

    const to = sp.get("to");
    if (to) {
      idx++;
      conditions.push(`t.created_at <= $${idx}`);
      values.push(to);
    }

    const customer = sp.get("customer");
    if (customer) {
      // R29-L2: validate the customer param belongs to this org BEFORE
      // using it in the WHERE clause. The transactions rows are already
      // org-filtered (t.organization_id = $1) so a foreign customer
      // would merely return empty results, but the empty-vs-populated
      // response still works as a timing-free existence oracle for
      // other tenants' customer_ids. Return 404 for unknown customers
      // regardless of tenant — uniform response, no side channel.
      const { rows: cCheck } = await orgQuery(
        orgId,
        `SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [customer, orgId],
      );
      if (cCheck.length === 0) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }
      idx++;
      conditions.push(`t.customer_id = $${idx}`);
      values.push(customer);
    }

    // Cursor-based pagination: (created_at, id) < (cursor_created_at, cursor_id)
    // to get rows "before" the cursor in descending order
    if (cursorCreatedAt !== null && cursorId !== null) {
      conditions.push(`(t.created_at, t.id) < ($${idx + 1}, $${idx + 2})`);
      values.push(cursorCreatedAt, cursorId);
      idx += 2;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // R25-perf-7 originally replaced a per-row correlated tender-count
    // subquery with a grouped aggregate, but that grouped aggregate still
    // scanned *all* transaction_tenders before pagination. Page the
    // transactions first, then count tenders only for the returned page via
    // an indexed per-row lateral lookup. This keeps the work bounded to
    // limit+1 rows instead of growing with all historical tender rows.
    // Fetch limit + 1 to determine if there's a next page.
    // R27-C8: employee/customer JOINs also org-gated for defense in
    // depth, so a cross-tenant employee_id/customer_id (shouldn't
    // exist given the new t.organization_id filter above, but cheap
    // insurance) can't splice foreign names.
    const rows = await orgQuery(
      orgId,
      `WITH page AS (
         SELECT t.id, t.status, t.tender_type, t.subtotal, t.discount_total, t.tax_total,
                t.grand_total, t.amount_tendered, t.change_due, t.created_at,
                t.customer_id,
                e.display_name AS employee_name,
                c.first_name || ' ' || c.last_name AS customer_name
           FROM transactions t
           LEFT JOIN employees e ON e.id = t.employee_id AND e.organization_id = $1
           LEFT JOIN customers c ON c.id = t.customer_id AND c.organization_id = $1
           ${whereClause}
           ORDER BY t.created_at DESC, t.id DESC
           LIMIT $${idx + 1}
       )
       SELECT page.*,
              COALESCE(tt.tender_count, 0)::int AS tender_count
         FROM page
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS tender_count
             FROM transaction_tenders
            WHERE transaction_id = page.id
         ) tt ON TRUE
        ORDER BY page.created_at DESC, page.id DESC`,
      [...values, limit + 1],
    );

    const hasMore = rows.rows.length > limit;
    const transactions = hasMore ? rows.rows.slice(0, limit) : rows.rows;

    let nextCursor: string | null = null;
    if (hasMore && transactions.length > 0) {
      const last = transactions[transactions.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ id: last.id, created_at: last.created_at })).toString("base64");
    }

    return NextResponse.json({
      transactions,
      nextCursor,
      hasMore,
    });
  } catch (err) {
    console.error("GET /api/transactions error:", safeErr(err));
    return NextResponse.json({ error: "Failed to fetch transactions" }, { status: 500 });
  }
});
