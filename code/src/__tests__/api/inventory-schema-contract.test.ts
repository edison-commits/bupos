import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const route = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/api/inventory/route.ts"),
  "utf8",
);

describe("inventory API canonical schema contract", () => {
  it("does not query product columns absent from canonical migrations", () => {
    expect(route).not.toContain("p.product_brand");
    expect(route).not.toContain("p.product_type");
    expect(route).not.toContain("FROM products\\n        WHERE organization_id = $1 AND product_type");
    expect(route).not.toContain("FROM products\\n        WHERE organization_id = $1 AND product_brand");
  });
});
