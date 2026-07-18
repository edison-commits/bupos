import { describe, expect, it } from "vitest";
import fs from "node:fs";

function read(path: string) {
  return fs.readFileSync(path, "utf8");
}

describe("GET /api/inventory contract", () => {
  it("does not require docs-only product brand/type columns", () => {
    const route = read("src/app/api/inventory/route.ts");

    expect(route).toContain('withAdminAuth("inventory.adjust"');
    expect(route).toContain("NULL::text as product_brand");
    expect(route).toContain("NULL::text as product_type");
    expect(route).not.toContain("p.product_brand,");
    expect(route).not.toContain("p.product_type,");
    expect(route).not.toContain("FROM products\n        WHERE organization_id = $1 AND product_brand");
    expect(route).not.toContain("FROM products\n        WHERE organization_id = $1 AND product_type");
  });
});
