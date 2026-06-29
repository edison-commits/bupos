import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("inventory ledger per SKU contract", () => {
  it("exposes secured location-scoped inventory ledger API", () => {
    const src = read("src/app/api/inventory/ledger/route.ts");
    expect(src).toContain('withAdminAuth("inventory.adjust"');
    expect(src).toContain("allowedLocations");
    expect(src).toContain("ia.location_id = ANY");
    expect(src).toContain("inventory_adjustments ia");
    expect(src).toContain("previous_on_hand");
  });

  it("ledger API supports SKU search and movement type filters", () => {
    const src = read("src/app/api/inventory/ledger/route.ts");
    expect(src).toContain("search");
    expect(src).toContain("reason");
    expect(src).toContain("variantId");
    expect(src).toContain("pagination");
  });

  it("admin ledger page renders SKU timeline and export", () => {
    const src = read("src/app/admin/inventory/ledger/page.tsx");
    expect(src).toContain("Inventory Ledger");
    expect(src).toContain("SKU timeline");
    expect(src).toContain("authFetch(`/api/inventory/ledger?");
    expect(src).toContain("Export CSV");
    expect(src).toContain("Previous");
    expect(src).toContain("Resulting");
  });

  it("inventory admin links managers to the ledger", () => {
    const src = read("src/app/admin/inventory/page.tsx");
    expect(src).toContain("Inventory Ledger");
    expect(src).toContain("/admin/inventory/ledger");
  });
});
