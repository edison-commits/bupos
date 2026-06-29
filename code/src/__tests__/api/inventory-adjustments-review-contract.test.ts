import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("inventory adjustment review contract", () => {
  it("exposes a secured inventory adjustment review endpoint", () => {
    const src = read("src/app/api/inventory/adjustments/route.ts");
    expect(src).toContain('withAdminAuth("inventory.adjust"');
    expect(src).toContain("FROM inventory_adjustments ia");
    expect(src).toContain("ia.organization_id = $1");
  });

  it("location-scopes non-manager inventory adjustment reads", () => {
    const src = read("src/app/api/inventory/adjustments/route.ts");
    expect(src).toContain("ctx.allowedLocations !== null");
    expect(src).toContain("ia.location_id = ANY");
    expect(src).toContain("allowedLocations.length === 0");
  });

  it("supports shrink-review filters and summary buckets", () => {
    const src = read("src/app/api/inventory/adjustments/route.ts");
    expect(src).toContain('searchParams.get("reason")');
    expect(src).toContain('searchParams.get("employeeId")');
    expect(src).toContain('searchParams.get("locationId")');
    expect(src).toContain('searchParams.get("risk")');
    expect(src).toContain("large_negative_count");
    expect(src).toContain("after_hours_count");
  });

  it("returns repeat-pattern shrink signals by employee and SKU", () => {
    const src = read("src/app/api/inventory/adjustments/route.ts");
    expect(src).toContain("repeated_negative_count");
    expect(src).toContain("patternsResult");
    expect(src).toContain("employeePatterns");
    expect(src).toContain("skuPatterns");
    expect(src).toContain("HAVING COUNT(*) >= 3");
  });

  it("renders the admin shrink review page with CSV export and risk filters", () => {
    const src = read("src/app/admin/inventory/adjustments/page.tsx");
    expect(src).toContain("Inventory Adjustment Review");
    expect(src).toContain("Large negative");
    expect(src).toContain("After hours");
    expect(src).toContain("Repeat pattern");
    expect(src).toContain("Suspicious patterns");
    expect(src).toContain("exportCsv");
    expect(src).toContain("/api/inventory/adjustments");
  });

  it("links inventory management to the adjustment review", () => {
    const src = read("src/app/admin/inventory/page.tsx");
    expect(src).toContain('/admin/inventory/adjustments');
    expect(src).toContain('Adjustment Review');
  });
});
