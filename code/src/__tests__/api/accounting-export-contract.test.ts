import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("accounting export contract", () => {
  it("/api/export supports a QuickBooks-ready accounting journal CSV", () => {
    const route = read("src/app/api/export/route.ts");
    expect(route).toContain('case "accounting-journal"');
    expect(route).toContain('withAdminAuth("reports.export"');
    expect(route).toContain('t.organization_id = $1');
    expect(route).toContain('transaction_tenders');
    expect(route).toContain('Sales Income');
    expect(route).toContain('Sales Tax Payable');
    expect(route).toContain('Discounts Given');
    expect(route).toContain('Gift Card Liability');
    expect(route).toContain('Store Credit Liability');
    expect(route).toContain('QuickBooks Account');
    expect(route).toContain('csvCell');
  });

  it("reports page exposes the accounting export CTA", () => {
    const page = read("src/app/admin/reports/page.tsx");
    expect(page).toContain("Accounting Export");
    expect(page).toContain("QuickBooks-ready daily sales journal");
    expect(page).toContain("type=accounting-journal");
    expect(page).toContain("Download Accounting CSV");
  });
});
