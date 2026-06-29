import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("supplier performance and PO aging contract", () => {
  it("exposes a secured supplier performance API with location scoping", () => {
    const src = read("src/app/api/purchase-orders/supplier-performance/route.ts");
    expect(src).toContain('withAdminAuth("inventory.adjust"');
    expect(src).toContain("allowedLocations");
    expect(src).toContain("po.location_id = ANY");
    expect(src).toContain("openPurchaseOrders");
    expect(src).toContain("supplierPerformance");
  });

  it("supplier analytics calculate aging and fill-rate metrics", () => {
    const src = read("src/app/api/purchase-orders/supplier-performance/route.ts");
    expect(src).toContain("days_overdue");
    expect(src).toContain("avg_days_to_receive");
    expect(src).toContain("fill_rate");
    expect(src).toContain("partial_count");
    expect(src).toContain("overdue_count");
  });

  it("purchase order admin page links managers to supplier performance", () => {
    const src = read("src/app/admin/purchase-orders/page.tsx");
    expect(src).toContain("Supplier Performance");
    expect(src).toContain("/admin/purchase-orders/supplier-performance");
  });

  it("supplier performance dashboard renders aging, fill rate, partial, and CSV export", () => {
    const src = read("src/app/admin/purchase-orders/supplier-performance/page.tsx");
    expect(src).toContain("PO Aging");
    expect(src).toContain("Fill rate");
    expect(src).toContain("Partial shipments");
    expect(src).toContain("Export CSV");
    expect(src).toContain("authFetch('/api/purchase-orders/supplier-performance");
  });
});
