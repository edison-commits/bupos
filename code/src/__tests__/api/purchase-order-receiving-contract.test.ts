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

  it("purchase-order details link submitted orders into receiving", () => {
    const src = read("src/app/admin/purchase-orders/page.tsx");
    expect(src).toContain("import Link from 'next/link'");
    expect(src).toContain("href={`/admin/receiving?mode=po&po_id=${selectedOrder.id}`}");
    expect(src).toContain("Receive PO");
  });

  it("receiving page opens directly to a linked purchase order", () => {
    const src = read("src/app/admin/receiving/page.tsx");
    expect(src).toContain("new URLSearchParams(window.location.search)");
    expect(src).toContain("setInitialPoId(linkedPoId)");
    expect(src).toContain("purchaseOrders.find((po) => po.id === initialPoId)");
    expect(src).toContain("fetchPODetails(matchedPO.id)");
  });
});
