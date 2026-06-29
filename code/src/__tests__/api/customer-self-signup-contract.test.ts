import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("customer self-signup QR flow", () => {
  it("adds a public customer self-signup page with profile and preference fields", () => {
    const page = read("src/app/customer-signup/page.tsx");
    const client = read("src/app/customer-signup/customer-signup-form.tsx");
    expect(page).toContain("CustomerSignupForm");
    expect(client).toContain("/api/customer-self-signup");
    expect(client).toContain("firstName");
    expect(client).toContain("lastName");
    expect(client).toContain("category");
    expect(client).toContain("preferredColors");
    expect(client).toContain("preferredBrands");
  });

  it("creates new customers through a public rate-limited API and avoids blind overwrite of existing matches", () => {
    const route = read("src/app/api/customer-self-signup/route.ts");
    expect(route).toContain("customerSelfSignupSchema");
    expect(route).toContain("checkRateLimit");
    expect(route).toContain("checkKvRateLimit");
    expect(route).toContain("checkDbRateLimit");
    expect(route).toContain("MAX_BODY_BYTES");
    expect(route).toContain("BUPOS_ORG_ID");
    expect(route).toContain("SELECT id FROM customers");
    expect(route).toContain("INSERT INTO customers");
    expect(route).toContain("!isExistingCustomer");
    expect(route).toContain("ON CONFLICT (organization_id, customer_id, category) DO UPDATE");
    expect(route).toContain("customer_self_signup");
    expect(route).toContain("return NextResponse.json({ ok: true })");
  });

  it("validates the public signup payload with bounded customer and preference fields", () => {
    const schemas = read("src/lib/validation/schemas.ts");
    expect(schemas).toContain("customerSelfSignupSchema");
    expect(schemas).toContain("preferences: z.array(customerPreferenceSchema).max(12)");
    expect(schemas).toContain("marketingOptIn: z.boolean().optional()");
  });

  it("renders a real QR on the paired customer display and links to self signup", () => {
    const pkg = read("package.json");
    const display = read("src/components/register/customer-display.tsx");
    const page = read("src/app/register/customer-display/page.tsx");
    expect(pkg).toContain('"qrcode"');
    expect(display).toContain("CustomerSignupQr");
    expect(display).toContain("customerSignupUrl");
    expect(page).toContain("readCustomerDisplayBranding");
    expect(page).toContain("customerSignupUrl");
    expect(page).toContain("/customer-signup");
  });
});
