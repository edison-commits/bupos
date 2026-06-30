import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("register worker UX polish", () => {
  it("keeps quantity controls visible on every cart line without expanding details", () => {
    const cartSidebar = read("src/components/register/cart-sidebar.tsx");
    expect(cartSidebar).toContain("aria-label={`Decrease quantity for ${item.productName}`}");
    expect(cartSidebar).toContain("aria-label={`Increase quantity for ${item.productName}`}");
    expect(cartSidebar).toContain("aria-label={`Quantity for ${item.productName}: ${item.quantity}`}");
    expect(cartSidebar).toContain("worker-qty-stepper");
  });

  it("shows plain-language low-stock warnings in the product grid and variant picker", () => {
    const productGrid = read("src/components/register/product-grid.tsx");
    expect(productGrid).toContain("Only {totalStock} left");
    expect(productGrid).toContain("Only {variantStock} left");
    expect(productGrid).toContain("worker-low-stock-warning");
  });

  it("confirms manual product taps with the same cashier-facing add feedback as scanner adds", () => {
    const productGrid = read("src/components/register/product-grid.tsx");
    expect(productGrid).toContain("showAddFeedback");
    expect(productGrid).toContain("Added: ${product.name} — ${variant.name}");
  });
});
