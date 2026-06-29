import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("supplier returns RTV contract", () => {
  it("adds supplier return tables with org/location scoping", () => {
    const migration = read("supabase/migrations/090_supplier_returns.sql");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS supplier_returns");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS supplier_return_lines");
    expect(migration).toContain("organization_id uuid NOT NULL");
    expect(migration).toContain("location_id uuid NOT NULL");
    expect(migration).toContain("status IN ('draft','submitted','credited','cancelled')");
  });

  it("API creates and lists RTVs with inventory-adjust permission", () => {
    const route = read("src/app/api/supplier-returns/route.ts");
    expect(route).toContain('withAdminAuth("inventory.adjust"');
    expect(route).toContain("supplier_return_lines");
    expect(route).toContain("inventory_adjustments");
    expect(route).toContain("reason, delta, resulting_on_hand");
    expect(route).toContain("'supplier_return'");
    expect(route).toContain("FOR UPDATE");
  });

  it("admin RTV page supports draft creation and history", () => {
    const page = read("src/app/admin/supplier-returns/page.tsx");
    expect(page).toContain("RTV / Supplier Returns");
    expect(page).toContain("authFetch('/api/supplier-returns'");
    expect(page).toContain("Create RTV");
    expect(page).toContain("Return reason");
    expect(page).toContain("Return history");
  });

  it("supplier admin links to RTV workflow", () => {
    const page = read("src/app/admin/suppliers/page.tsx");
    expect(page).toContain("Supplier Returns");
    expect(page).toContain("/admin/supplier-returns");
  });
});
