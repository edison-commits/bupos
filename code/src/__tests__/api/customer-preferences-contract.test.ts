import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("customer profile size/style preferences v1", () => {
  it("adds org-scoped customer_preferences table for explicit fit and style memory", () => {
    const migration = read("supabase/migrations/092_customer_preferences.sql");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS customer_preferences");
    expect(migration).toContain("organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE");
    expect(migration).toContain("customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE");
    expect(migration).toContain("category TEXT NOT NULL");
    expect(migration).toContain("size_label TEXT");
    expect(migration).toContain("fit_preference TEXT");
    expect(migration).toContain("preferred_colors TEXT[] NOT NULL DEFAULT '{}'");
    expect(migration).toContain("preferred_brands TEXT[] NOT NULL DEFAULT '{}'");
    expect(migration).toContain("style_notes TEXT");
    expect(migration).toContain("UNIQUE (organization_id, customer_id, category)");
    expect(migration).toContain("idx_customer_preferences_org_customer");
  });

  it("validates customer preference payloads with bounded explicit fields", () => {
    const schemas = read("src/lib/validation/schemas.ts");
    expect(schemas).toContain("customerPreferenceSchema");
    expect(schemas).toContain("category: requiredString");
    expect(schemas).toContain("size_label: optionalString");
    expect(schemas).toContain("fit_preference: optionalString");
    expect(schemas).toContain("preferred_colors: z.array(requiredString).max(12)");
    expect(schemas).toContain("preferred_brands: z.array(requiredString).max(12)");
    expect(schemas).toContain("style_notes: optionalString");
    expect(schemas).toContain("customerPreferencesUpdateSchema");
  });

  it("customer detail API reads preferences and preference route upserts them atomically with audit", () => {
    const route = read("src/app/api/customers/route.ts");
    const prefRoute = read("src/app/api/customers/preferences/route.ts");
    expect(route).toContain("customer_preferences");
    expect(route).toContain("preferencesRes");
    expect(route).toContain("preferences: preferencesRes.rows");
    expect(prefRoute).toContain("customerPreferencesUpdateSchema");
    expect(prefRoute).toContain("ON CONFLICT (organization_id, customer_id, category) DO UPDATE");
    expect(prefRoute).toContain("customer_preferences_updated");
    expect(prefRoute).toContain("orgTx(orgId)");
  });

  it("admin customer detail exposes editable size and style memory", () => {
    const page = read("src/app/admin/customers/page.tsx");
    expect(page).toContain("interface CustomerPreference");
    expect(page).toContain("Fit & style memory");
    expect(page).toContain("handleSavePreferences");
    expect(page).toContain("preferred_colors");
    expect(page).toContain("preferred_brands");
    expect(page).toContain("Add preference");
    expect(page).toContain("/api/customers/preferences");
  });

  it("register customer search surfaces customer size/style hints for cashiers", () => {
    const modal = read("src/components/register/customer-search-modal.tsx");
    expect(modal).toContain("preferences?: CustomerPreference[]");
    expect(modal).toContain("Size/style hints");
    expect(modal).toContain("preferredColors");
    expect(modal).toContain("preferredBrands");
  });

  it("domain customer includes preferences for register and admin displays", () => {
    const types = read("src/lib/domain/types.ts");
    expect(types).toContain("export interface CustomerPreference");
    expect(types).toContain("preferences?: CustomerPreference[]");
  });
});
