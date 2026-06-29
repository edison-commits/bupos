import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("customer display branding controls", () => {
  it("adds persisted organization fields for customer display branding", () => {
    const migration = read("supabase/migrations/091_customer_display_branding.sql");
    expect(migration).toContain("customer_display_display_name");
    expect(migration).toContain("customer_display_welcome_text");
    expect(migration).toContain("customer_display_accent_color");
    expect(migration).toContain("customer_display_idle_message");
    expect(migration).toContain("CHECK (customer_display_accent_color ~ '^#[0-9A-Fa-f]{6}$')");
  });

  it("settings API reads and writes a customerDisplay section", () => {
    const api = read("src/app/api/settings/route.ts");
    expect(api).toContain("customer_display_display_name");
    expect(api).toContain("customerDisplay:");
    expect(api).toContain("case 'customerDisplay'");
    expect(api).toContain("section: 'customerDisplay'");
  });

  it("settings schema restricts customer display branding fields", () => {
    const schema = read("src/lib/validation/schemas.ts");
    expect(schema).toContain("customerDisplaySettingsSchema");
    expect(schema).toContain("accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/)");
    expect(schema).toContain("z.object({ section: z.literal('customerDisplay'), data: customerDisplaySettingsSchema })");
  });

  it("admin settings page exposes an editable Customer Display section with live preview", () => {
    const page = read("src/app/admin/settings/page.tsx");
    expect(page).toContain("CustomerDisplaySection");
    expect(page).toContain("Customer Display Branding");
    expect(page).toContain("accentColor");
    expect(page).toContain("CustomerDisplayPreview");
    expect(page).toContain("handleSaveCustomerDisplay");
  });

  it("customer display component accepts and renders branding values", () => {
    const component = read("src/components/register/customer-display.tsx");
    expect(component).toContain("interface CustomerDisplayBranding");
    expect(component).toContain("accentColor");
    expect(component).toContain("welcomeText");
    expect(component).toContain("idleMessage");
    expect(component).toContain("branding={branding}");
  });

  it("register customer display page passes persisted branding to the display client", () => {
    const page = read("src/app/register/customer-display/page.tsx");
    const client = read("src/app/register/customer-display/customer-display-client.tsx");
    expect(page).toContain("customerDisplayBranding");
    expect(page).toContain("displayName");
    expect(client).toContain("branding?: CustomerDisplayBranding");
    expect(client).toContain("branding={branding}");
  });
});
