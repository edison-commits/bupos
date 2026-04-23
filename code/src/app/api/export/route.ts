import { NextResponse } from "next/server";
import { orgQuery } from "@/lib/supabase-rest";
import { withAdminAuth } from "@/lib/api/with-auth";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { csvCell } from "@/lib/format/csv-sanitize";

import { safeErr } from "@/lib/logging/safe-err";
// M-05: Validate date params to prevent Content-Disposition header injection
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/export
 *
 * Exports data as CSV.
 *
 * Query params:
 *   type     — "transactions" | "inventory" | "products" | "customers" | "gift-cards" | "expenses"
 *   from     — start date (ISO) for transactions/expenses
 *   to       — end date (ISO)
 *   location — location ID for inventory
 */
export const GET = withAdminAuth("reports.export", async (req, ctx) => {
  const { orgId } = ctx;

  // R30-M5: cap export frequency. Each CSV generation can materialize
  // 50k rows in memory and hit the DB hard (unbounded JOINs on
  // transactions + customer PII export). 5 per 5 min per employee
  // covers legitimate reconciliation / audit use but blocks a
  // compromised reports.export session from grinding the customer PII
  // dump, transaction ledger, or gift-card balance file in a loop.
  const rl = checkRateLimit(`export:${orgId}:${ctx.employee.id}`, { maxAttempts: 5, windowMs: 300_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many export requests. Try again shortly." }, { status: 429 });
  }

  try {
    const sp = req.nextUrl.searchParams;
    const type = sp.get("type");

    if (!type) {
      return NextResponse.json({ error: "type parameter required (transactions, inventory, products, customers, gift-cards, expenses)" }, { status: 400 });
    }

    let csv = "";
    let filename = "";

    switch (type) {
      case "transactions": {
        const from = sp.get("from") || "2020-01-01";
        const to = sp.get("to") || new Date().toISOString().slice(0, 10);
        if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
          return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 });
        }
        // Hard row cap to stay inside the Cloudflare Worker 128 MB heap.
        // Previously an owner could hit `?from=2020-01-01&to=<today>` on
        // a busy store and crash the Worker isolate for everyone in the
        // same colo. The cap is generous for a single-day export and
        // explicit for multi-year ranges (caller must narrow down).
        const TRANSACTIONS_EXPORT_LIMIT = 50_000;
        // R27-C1: explicit organization_id filter. `orgQuery`'s SET LOCAL
        // app.current_org_id is cosmetic under the `postgres` role's
        // BYPASSRLS, so RLS does NOT fire. Without this WHERE clause an
        // attacker-owner at any tenant could export every tenant's
        // transactions via this endpoint.
        // R28-L4: LEFT JOINs gated by org too for defense-in-depth.
        const rows = await orgQuery(
          orgId,
          `SELECT t.id, t.status, t.tender_type, t.subtotal, t.discount_total, t.tax_total,
                  t.grand_total, t.amount_tendered, t.change_due, t.created_at,
                  e.display_name AS employee,
                  c.first_name || ' ' || c.last_name AS customer
           FROM transactions t
           LEFT JOIN employees e ON e.id = t.employee_id AND e.organization_id = $1
           LEFT JOIN customers c ON c.id = t.customer_id AND c.organization_id = $1
           WHERE t.organization_id = $1
             AND t.created_at >= $2 AND t.created_at < $3
           ORDER BY t.created_at DESC
           LIMIT $4`,
          // R83-LOW: use buildOrgDayRange for org-TZ-aware day bounds.
          // Prior shape ("T00:00:00.000Z" / "T23:59:59.999Z") hardcoded
          // UTC — an auditor pulling "Monday's transactions" got
          // UTC-Monday not org-Monday. Parity with R82-DB-H3 and
          // R83-SEC-H2 dashboard fixes.
          await (async () => {
            const { buildOrgDayRange } = await import("@/lib/reports/day-range");
            const { fromTs, toTs } = await buildOrgDayRange(orgId, from, to);
            return [orgId, fromTs, toTs, TRANSACTIONS_EXPORT_LIMIT + 1];
          })(),
        );
        if (rows.rows.length > TRANSACTIONS_EXPORT_LIMIT) {
          return NextResponse.json(
            {
              error: `Export exceeds ${TRANSACTIONS_EXPORT_LIMIT.toLocaleString()} rows. Narrow the date range and try again.`,
            },
            { status: 413 },
          );
        }
        csv = toCsv(rows.rows, [
          "id", "status", "tender_type", "subtotal", "discount_total", "tax_total",
          "grand_total", "amount_tendered", "change_due", "employee", "customer", "created_at",
        ]);
        filename = `transactions_${from}_to_${to}.csv`;
        break;
      }

      case "inventory": {
        const locationId = sp.get("location") ?? ctx.employee.locationIds?.[0];
        if (!locationId) {
          return NextResponse.json({ error: 'No location context' }, { status: 400 });
        }
        // R27-C1: explicit organization_id filter. Also verify the
        // requested location belongs to the caller's org so an
        // owner can't read another tenant's inventory by supplying
        // a foreign ?location= UUID.
        const rows = await orgQuery(
          orgId,
          `SELECT p.name AS product, pv.sku, pv.barcode, pv.size_label AS size, pv.color_label AS color, pv.price AS retail_price, pv.cost AS cost_price,
                  il.on_hand, il.reserved, il.reorder_point,
                  l.name AS location,
                  EXTRACT(DAY FROM now() - il.received_at)::int AS days_on_shelf
           FROM inventory_levels il
           JOIN product_variants pv ON pv.id = il.product_variant_id
           JOIN products p ON p.id = pv.product_id
           JOIN locations l ON l.id = il.location_id AND l.organization_id = $1
           WHERE il.organization_id = $1 AND il.location_id = $2
           ORDER BY p.name, pv.sku`,
          [orgId, locationId],
        );
        csv = toCsv(rows.rows, [
          "product", "sku", "barcode", "size", "color", "retail_price", "cost_price",
          "on_hand", "reserved", "reorder_point", "location", "days_on_shelf",
        ]);
        filename = `inventory_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      }

      case "products": {
        // R27-C1: explicit organization_id filter. Without it, this
        // endpoint dumped every tenant's catalog.
        const rows = await orgQuery(
          orgId,
          `SELECT p.name, p.description, c.name AS category,
                  pv.sku, pv.barcode, pv.size_label AS size, pv.color_label AS color,
                  pv.price AS retail_price, pv.cost AS cost_price, pv.is_active
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id AND c.organization_id = $1
           JOIN product_variants pv ON pv.product_id = p.id AND pv.organization_id = $1
           WHERE p.organization_id = $1
           ORDER BY p.name, pv.sku`,
          [orgId],
        );
        csv = toCsv(rows.rows, [
          "name", "description", "category", "sku", "barcode", "size", "color",
          "retail_price", "cost_price", "is_active",
        ]);
        filename = `products_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      }

      case "customers": {
        // Default export omits PII (email, phone, address). Admin can opt-in with ?include_pii=true.
        const includePii = sp.get("include_pii") === "true";
        const piiColumns = includePii
          ? `first_name, last_name, email, phone, address,`
          : `first_name, last_name,`;
        const piiHeaderFields = includePii
          ? ["first_name", "last_name", "email", "phone", "address"]
          : ["first_name", "last_name"];
        // Cloudflare Workers cap a single response at ~128 MB and the
        // isolate heap similarly. An unbounded 100k-customer CSV OOMs the
        // Worker before the download finishes. Hard-cap at 50k rows per
        // request; callers who need more can batch via repeated requests
        // with a future cursor (this endpoint is used by admin backup only).
        const CUSTOMER_EXPORT_LIMIT = 50_000;
        // R27-C1: explicit organization_id filter. Without it, this
        // endpoint dumped every tenant's customer list including PII
        // when ?include_pii=true.
        const rows = await orgQuery(
          orgId,
          `SELECT ${piiColumns}
                  loyalty_points, total_spend, visit_count, store_credit_balance,
                  tax_exempt, is_active, created_at
           FROM customers
           WHERE organization_id = $1
           ORDER BY last_name, first_name
           LIMIT $2`,
          [orgId, CUSTOMER_EXPORT_LIMIT],
        );
        csv = toCsv(rows.rows, [
          ...piiHeaderFields,
          "loyalty_points", "total_spend", "visit_count", "store_credit_balance",
          "tax_exempt", "is_active", "created_at",
        ]);
        filename = `customers_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      }

      case "gift-cards": {
        // R27-C1: explicit organization_id filter. Gift card codes
        // across every tenant were readable before this.
        const rows = await orgQuery(
          orgId,
          `SELECT gc.code, gc.balance, gc.initial_balance, gc.status,
                  c.first_name || ' ' || c.last_name AS customer,
                  e.display_name AS activated_by,
                  gc.activated_at, gc.expires_at, gc.created_at
           FROM gift_cards gc
           LEFT JOIN customers c ON c.id = gc.customer_id AND c.organization_id = $1
           LEFT JOIN employees e ON e.id = gc.activated_by AND e.organization_id = $1
           WHERE gc.organization_id = $1
           ORDER BY gc.created_at DESC`,
          [orgId],
        );
        // Mask gift card codes in export (show only last 4 chars)
        const maskedRows = rows.rows.map((r: Record<string, unknown>) => ({
          ...r,
          code: typeof r.code === 'string' && r.code.length > 4 ? `****${r.code.slice(-4)}` : r.code,
        }));
        csv = toCsv(maskedRows, [
          "code", "balance", "initial_balance", "status", "customer",
          "activated_by", "activated_at", "expires_at", "created_at",
        ]);
        filename = `gift_cards_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      }

      case "expenses": {
        const from = sp.get("from") || "2020-01-01";
        const to = sp.get("to") || new Date().toISOString().slice(0, 10);
        if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
          return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 });
        }
        // R27-C1: explicit organization_id filter.
        const rows = await orgQuery(
          orgId,
          `SELECT category, description, amount, notes,
                  is_recurring, recurrence_period, expense_date, created_at
           FROM expenses
           WHERE organization_id = $1
             AND expense_date >= $2 AND expense_date <= $3
           ORDER BY expense_date DESC`,
          [orgId, from, to + "T23:59:59.999Z"],
        );
        csv = toCsv(rows.rows, [
          "category", "description", "amount", "notes",
          "is_recurring", "recurrence_period", "expense_date", "created_at",
        ]);
        filename = `expenses_${from}_to_${to}.csv`;
        break;
      }

      default:
        return NextResponse.json({ error: `Unknown export type: ${type}` }, { status: 400 });
    }

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("GET /api/export error:", safeErr(err));
    return NextResponse.json({ error: "Failed to export data" }, { status: 500 });
  }
});

// R39-A2-7: sanitizeCsvCell moved to `@/lib/format/csv-sanitize` so
// server + client paths share ONE canonical implementation. See that
// module for the full rationale on leading-invisible-char stripping
// and formula-char prefix list. `csvCell` composes sanitize + the
// comma/quote/newline escape in a single call.

/** Convert an array of objects to CSV string */
function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.join(",");
  const body = rows.map((row) =>
    columns.map((col) => csvCell(row[col])).join(",")
  ).join("\n");
  return `${header}\n${body}`;
}
