import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("CRM customer segments contract", () => {
  it("adds a secured customer segments API with marketing-focused buckets", () => {
    const route = read("src/app/api/customers/segments/route.ts");
    expect(route).toContain('withAdminAuth("employee.manage"');
    expect(route).toContain("organization_id = $1");
    expect(route).toContain("win_back");
    expect(route).toContain("loyalty_ready");
    expect(route).toContain("high_value");
    expect(route).toContain("saved_preferences_no_recent_purchase");
    expect(route).toContain("marketing_opt_in");
    expect(route).toContain("csvCell");
  });

  it("adds a marketing segments admin page and customer navigation", () => {
    const page = read("src/app/admin/customers/segments/page.tsx");
    expect(page).toContain("Marketing Segments");
    expect(page).toContain("Win-back");
    expect(page).toContain("Loyalty ready");
    expect(page).toContain("Saved preferences");
    expect(page).toContain("Export segment CSV");

    const customers = read("src/app/admin/customers/page.tsx");
    expect(customers).toContain("/admin/customers/segments");
    expect(customers).toContain("Marketing Segments");
  });
});
