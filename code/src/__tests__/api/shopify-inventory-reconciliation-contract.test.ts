import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("Shopify inventory reconciliation contract", () => {
  it("provider can read Shopify inventory quantity for a mapped item", () => {
    const types = read("src/lib/channels/types.ts");
    const shopify = read("src/lib/channels/shopify.ts");
    expect(types).toContain("getInventoryQuantity");
    expect(shopify).toContain("inventoryLevel");
    expect(shopify).toContain("quantities(names: [\"available\"]) ");
  });

  it("repository compares BUPOS on-hand against Shopify and classifies drift", () => {
    const repo = read("src/lib/channels/repo.ts");
    expect(repo).toContain("getInventoryReconciliation");
    expect(repo).toContain("buposOnHand");
    expect(repo).toContain("shopifyOnHand");
    expect(repo).toContain("drift");
    expect(repo).toContain("needs_attention");
  });

  it("API is secured and supports report and push-to-Shopify repair", () => {
    const route = read("src/app/api/channels/shopify/reconciliation/route.ts");
    expect(route).toContain('withAdminAuth("online.manage"');
    expect(route).toContain("getInventoryReconciliation");
    expect(route).toContain("pushInventory");
    expect(route).toContain("action === 'push_to_shopify'");
  });

  it("admin page shows drift, summary, and repair action", () => {
    const page = read("src/app/admin/online-selling/reconciliation/page.tsx");
    expect(page).toContain("Shopify Inventory Reconciliation");
    expect(page).toContain("authFetch('/api/channels/shopify/reconciliation'");
    expect(page).toContain("Push BUPOS counts to Shopify");
    expect(page).toContain("Drift");
    expect(page).toContain("Needs attention");
  });

  it("online selling links to reconciliation", () => {
    const page = read("src/app/admin/online-selling/page.tsx");
    expect(page).toContain("Reconcile inventory");
    expect(page).toContain("/admin/online-selling/reconciliation");
  });
});
