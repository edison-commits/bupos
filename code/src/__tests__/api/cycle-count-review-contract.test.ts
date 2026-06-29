import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("cycle count review workflow contract", () => {
  it("stocktake manager exposes cycle count audit summary and CSV export", () => {
    const src = read("src/components/admin/stocktake-manager.tsx");
    expect(src).toContain("Cycle Count Review");
    expect(src).toContain("exportStocktakeCsv");
    expect(src).toContain("High variance");
    expect(src).toContain("Variance reason");
    expect(src).toContain("Ready for review");
  });

  it("record count captures variance reason notes before manager acceptance", () => {
    const src = read("src/app/admin/stocktake-actions.ts");
    expect(src).toContain('formData.get("varianceReason")');
    expect(src).toContain("variance_reason");
    expect(src).toContain("pending_review");
  });

  it("schema supports variance reason audit fields on stocktake lines", () => {
    const src = read("supabase/migrations/085_cycle_count_variance_reasons.sql");
    expect(src).toContain("ALTER TABLE stocktake_lines");
    expect(src).toContain("variance_reason");
    expect(src).toContain("variance_reason_required");
  });

  it("inventory shrink review links managers into cycle counts", () => {
    const src = read("src/app/admin/inventory/adjustments/page.tsx");
    expect(src).toContain('/admin/stocktakes');
    expect(src).toContain('Start Cycle Count');
  });
});
