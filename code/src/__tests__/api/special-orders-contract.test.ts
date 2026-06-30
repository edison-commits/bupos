import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("special orders / backorders workflow contract", () => {
  it("adds org-scoped special order tables with forced RLS", () => {
    const migration = read("supabase/migrations/093_special_orders.sql");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS special_orders");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS special_order_lines");
    expect(migration).toContain("customer_id UUID NOT NULL REFERENCES customers");
    expect(migration).toContain("purchase_order_id UUID REFERENCES purchase_orders");
    expect(migration).toContain("ALTER TABLE special_orders FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE special_order_lines FORCE ROW LEVEL SECURITY");
  });

  it("API is admin secured, validates payloads, scopes by org and allowed locations", () => {
    const route = read("src/app/api/special-orders/route.ts");
    expect(route).toContain("withAdminAuth(\"inventory.adjust\"");
    expect(route).toContain("specialOrderCreateSchema");
    expect(route).toContain("specialOrderUpdateSchema");
    expect(route).toContain("so.organization_id = $1");
    expect(route).toContain("allowedLocations");
    expect(route).toContain("so.location_id = ANY");
    expect(route).toContain("customer_id does not exist in this organization");
    expect(route).toContain("product_variant_id");
  });

  it("API can generate a draft supplier PO from selected special-order lines", () => {
    const route = read("src/app/api/special-orders/route.ts");
    expect(route).toContain("action === \"generate_po\"");
    expect(route).toContain("INSERT INTO purchase_orders");
    expect(route).toContain("INSERT INTO purchase_order_lines");
    expect(route).toContain("purchase_order_id = poId");
    expect(route).toContain("status = 'ordered'");
  });

  it("admin page exposes intake, backorder queue, deposit due, and PO handoff", () => {
    const page = read("src/app/admin/special-orders/page.tsx");
    expect(page).toContain("Special Orders & Backorders");
    expect(page).toContain("Customer request intake");
    expect(page).toContain("Deposit due");
    expect(page).toContain("Generate draft PO");
    expect(page).toContain("authFetch('/api/special-orders'");
    expect(page).toContain("Ready for pickup");
  });

  it("customer admin links to the special-order queue", () => {
    const page = read("src/app/admin/customers/page.tsx");
    expect(page).toContain("Special Orders");
    expect(page).toContain("/admin/special-orders");
  });
});
