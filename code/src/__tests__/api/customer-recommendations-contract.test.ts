import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("customer-aware product recommendations v1", () => {
  it("extends register recommendations with explicit customer preference inputs", () => {
    const component = read("src/components/register/product-recommendations.tsx");
    expect(component).toContain("customer?: Customer");
    expect(component).toContain("categories:");
    expect(component).toContain("sizeLabel?: string");
    expect(component).toContain("colorLabel?: string");
  });

  it("scores preference matches before generic recommendations with human-readable reasons", () => {
    const component = read("src/components/register/product-recommendations.tsx");
    expect(component).toContain("customer_preference");
    expect(component).toContain("Matches customer preferences");
    expect(component).toContain("preferenceReasons");
    expect(component).toContain("preferredColors");
    expect(component).toContain("preferredBrands");
    expect(component).toContain("sizeLabel");
  });

  it("lets customer recommendations render even before the cart has items", () => {
    const component = read("src/components/register/pos-terminal.tsx");
    expect(component).toContain("selectedCustomerForRecommendations");
    expect(component).toContain("customer={selectedCustomerForRecommendations}");
    expect(component).toContain("cart.items.length > 0 || selectedCustomerForRecommendations?.preferences?.length");
  });

  it("passes category and full variant attributes into the recommendation engine", () => {
    const component = read("src/components/register/pos-terminal.tsx");
    expect(component).toContain("categories={categories}");
    expect(component).toContain("sizeLabel");
    expect(component).toContain("colorLabel");
  });
});
