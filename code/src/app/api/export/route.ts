import { NextRequest, NextResponse } from "next/server";
import { orgQuery } from "@/lib/db";
import { requireAdminPermission } from "@/lib/authz";

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
export async function GET(req: NextRequest) {
  // M-10: Use reports.export permission instead of audit.view
  const ctx = await requireAdminPermission("reports.export");
  const orgId = ctx.employee.organizationId;

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
        const rows = await orgQuery(
          orgId,
          `SELECT t.id, t.status, t.tender_type, t.subtotal, t.discount_total, t.tax_total,
                  t.grand_total, t.amount_tendered, t.change_due, t.created_at,
                  e.display_name AS employee,
                  c.first_name || ' ' || c.last_name AS customer
           FROM transactions t
           LEFT JOIN employees e ON e.id = t.employee_id
           LEFT JOIN customers c ON c.id = t.customer_id
           WHERE t.created_at >= $1 AND t.created_at <= ($2 || 'T23:59:59.999Z')
           ORDER BY t.created_at DESC`,
          [from + "T00:00:00.000Z", to],
        );
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
        const rows = await orgQuery(
          orgId,
          `SELECT p.name AS product, pv.sku, pv.barcode, pv.size_label AS size, pv.color_label AS color, pv.price AS retail_price, pv.cost AS cost_price,
                  il.on_hand, il.reserved, il.reorder_point,
                  l.name AS location,
                  EXTRACT(DAY FROM now() - il.received_at)::int AS days_on_shelf
           FROM inventory_levels il
           JOIN product_variants pv ON pv.id = il.product_variant_id
           JOIN products p ON p.id = pv.product_id
           JOIN locations l ON l.id = il.location_id
           WHERE il.location_id = $1
           ORDER BY p.name, pv.sku`,
          [locationId],
        );
        csv = toCsv(rows.rows, [
          "product", "sku", "barcode", "size", "color", "retail_price", "cost_price",
          "on_hand", "reserved", "reorder_point", "location", "days_on_shelf",
        ]);
        filename = `inventory_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      }

      case "products": {
        const rows = await orgQuery(
          orgId,
          `SELECT p.name, p.description, c.name AS category,
                  pv.sku, pv.barcode, pv.size_label AS size, pv.color_label AS color,
                  pv.price AS retail_price, pv.cost AS cost_price, pv.is_active
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           JOIN product_variants pv ON pv.product_id = p.id
           ORDER BY p.name, pv.sku`,
          [],
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
        const rows = await orgQuery(
          orgId,
          `SELECT ${piiColumns}
                  loyalty_points, total_spend, visit_count, store_credit_balance,
                  tax_exempt, is_active, created_at
           FROM customers
           ORDER BY last_name, first_name`,
          [],
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
        const rows = await orgQuery(
          orgId,
          `SELECT gc.code, gc.balance, gc.initial_balance, gc.status,
                  c.first_name || ' ' || c.last_name AS customer,
                  e.display_name AS activated_by,
                  gc.activated_at, gc.expires_at, gc.created_at
           FROM gift_cards gc
           LEFT JOIN customers c ON c.id = gc.customer_id
           LEFT JOIN employees e ON e.id = gc.activated_by
           ORDER BY gc.created_at DESC`,
          [],
        );
        csv = toCsv(rows.rows, [
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
        const rows = await orgQuery(
          orgId,
          `SELECT category, description, amount, notes,
                  is_recurring, recurrence_period, expense_date, created_at
           FROM expenses
           WHERE expense_date >= $1 AND expense_date <= $2
           ORDER BY expense_date DESC`,
          [from, to + "T23:59:59.999Z"],
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
    console.error("GET /api/export error:", err);
    return NextResponse.json({ error: "Failed to export data" }, { status: 500 });
  }
}

/** Neutralize formula injection: prefix cells starting with =, +, -, @ with a single quote */
function sanitizeCsvCell(str: string): string {
  if (str.length > 0 && (str[0] === '=' || str[0] === '+' || str[0] === '-' || str[0] === '@')) {
    return "'" + str;
  }
  return str;
}

/** Convert an array of objects to CSV string */
function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.join(",");
  const body = rows.map((row) =>
    columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return "";
      const str = sanitizeCsvCell(String(val));
      // Escape commas, quotes, and newlines
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(",")
  ).join("\n");
  return `${header}\n${body}`;
}
