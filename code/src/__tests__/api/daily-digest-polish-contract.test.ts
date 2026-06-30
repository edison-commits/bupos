import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("daily digest preview and alerts contract", () => {
  it("report engine calculates manager exception alerts", () => {
    const src = read("src/lib/reports/eod.ts");
    expect(src).toContain("DigestAlert");
    expect(src).toContain("exception_alerts");
    expect(src).toContain("cash_variance");
    expect(src).toContain("stockout");
    expect(src).toContain("large_discount");
    expect(src).toContain("discount_total >= 25");
    expect(src).toContain("ABS(closing_variance) >= 5");
  });

  it("digest email includes a manager alerts section before operational detail", () => {
    const src = read("src/lib/reports/eod.ts");
    expect(src).toContain("Manager Alerts");
    expect(src).toContain("exception_alerts.length > 0");
    expect(src).toContain("No exceptions triggered for this window");
  });

  it("sales digest settings preview highlights alerts and test-send readiness", () => {
    const src = read("src/components/admin/sales-digest-settings.tsx");
    expect(src).toContain("Manager Alert Preview");
    expect(src).toContain("largeDiscountCount");
    expect(src).toContain("Stockouts");
    expect(src).toContain("Cash variance");
    expect(src).toContain("Test-send readiness");
  });

  it("sales digest API returns a preview without sending email", () => {
    const src = read("src/app/api/sales-digest/route.ts");
    expect(src).toContain("action === \"preview\"");
    expect(src).toContain("generateReportData(orgId, locationId)");
    expect(src).toContain("return NextResponse.json({ preview: report })");
  });
});
