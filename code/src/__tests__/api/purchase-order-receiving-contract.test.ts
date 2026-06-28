import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("purchase order receiving contract", () => {
  it("purchase-order admin submits the DB-valid submitted status", () => {
    const src = read("src/app/admin/purchase-orders/page.tsx");
    expect(src).toContain("handleUpdateStatus(selectedOrder.id, 'submitted')");
    expect(src).not.toContain("handleUpdateStatus(selectedOrder.id, 'pending')");
    expect(src).toContain("'submitted'");
  });

  it("receiving API lists submitted and partial purchase orders as open", () => {
    const src = read("src/app/api/receiving/route.ts");
    expect(src).toContain("po.status IN ('submitted', 'partial')");
    expect(src).not.toContain("po.status IN ('pending', 'partial')");
  });

  it("receiving API scopes PO details to the active receiving location", () => {
    const src = read("src/app/api/receiving/route.ts");
    const detailStart = src.indexOf("if (type === 'po_details')");
    const detailEnd = src.indexOf("if (type === 'search')");
    const detailSrc = src.slice(detailStart, detailEnd);
    expect(detailSrc).toContain("po.location_id = $3");
    expect(detailSrc).toContain("[poId, orgId, locationId]");
  });

  it("receiving page posts the validated receive payload shape", () => {
    const src = read("src/app/admin/receiving/page.tsx");
    expect(src).toContain("type: 'receive'");
    expect(src).toContain("product_variant_id: item.variant_id");
    expect(src).not.toContain("items: receivingItems,");
  });

  it("receiving page tracks PO receive quantities before adding a line", () => {
    const src = read("src/app/admin/receiving/page.tsx");
    expect(src).toContain("poReceiveQuantities");
    expect(src).toContain("poReceiveQuantities[line.id]");
    expect(src).toContain("handleAddPOItem(line, poReceiveQuantities[line.id]");
  });
});
