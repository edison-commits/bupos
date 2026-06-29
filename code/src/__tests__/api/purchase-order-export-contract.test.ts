import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("enhanced PO supplier export contract", () => {
  it("purchase order detail has supplier-ready print and CSV export actions", () => {
    const src = read("src/app/admin/purchase-orders/page.tsx");
    expect(src).toContain("printable-po-detail");
    expect(src).toContain("handlePrintPO");
    expect(src).toContain("handleExportSupplierCsv");
    expect(src).toContain("Print / Save PDF");
    expect(src).toContain("Export Supplier CSV");
  });

  it("supplier export includes supplier-facing line fields and delivery metadata", () => {
    const src = read("src/app/admin/purchase-orders/page.tsx");
    expect(src).toContain("PO Number");
    expect(src).toContain("Supplier");
    expect(src).toContain("Expected Delivery");
    expect(src).toContain("SKU");
    expect(src).toContain("Quantity Ordered");
    expect(src).toContain("Unit Cost");
    expect(src).toContain("Line Total");
  });

  it("print styles hide admin chrome and format the PO detail as a document", () => {
    const src = read("src/app/admin/purchase-orders/page.tsx");
    expect(src).toContain("@media print");
    expect(src).toContain("no-print");
    expect(src).toContain("printable-po-detail");
  });
});
