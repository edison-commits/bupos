/**
 * R89 / AUDIT9 — deep-audit findings.
 *
 *  price_override approval is now AGGREGATE-checked across the cart (was
 *  per-line: one $X approval authorized $X of markdown on every line).
 *  /api/products create requires category_id + derives slug (NOT-NULL 500).
 *  expenses + customer-display payment_status zod enums mirror the DB CHECK.
 *  Two dropped invalidateInventoryCache cascades now awaited.
 *  quickSwitch re-verifies the TARGET role's register permissions.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("AUDIT9-1: price_override approval is aggregate, not per-line", () => {
  it("checkout-action accumulates override impact and gates the cart total", () => {
    const src = read("src/app/register/checkout-action.ts");
    expect(src).toMatch(/let totalOverrideImpact = 0/);
    expect(src).toMatch(/totalOverrideImpact \+= Math\.abs\(dbPrice - item\.overridePrice\)/);
    expect(src).toMatch(/totalOverrideImpact > 0 && !amountApprovedFor\("price_override", Number\(totalOverrideImpact/);
    // the old per-line check must be gone
    expect(src).not.toMatch(/const overrideDollarImpact = Math\.abs/);
  });
  it("offline-sync accumulates override impact and gates the cart total", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    expect(src).toMatch(/totalOverrideImpact \+= Math\.abs\(serverPrice - item\.overridePrice!\)/);
    expect(src).toMatch(/totalOverrideImpact > 0 && !amountApprovedFor\("price_override"/);
  });
});

describe("AUDIT9-2: /api/products create guards NOT-NULL category_id + slug", () => {
  const src = read("src/app/api/products/route.ts");
  it("requires category_id and derives slug, reading pv.data not raw body", () => {
    expect(src).toMatch(/= pv\.data;\s*\n\s*const is_touch_favorite = pv\.data\.is_touch_favorite/);
    expect(src).toMatch(/if \(!category_id\) \{[\s\S]*?category_id is required/);
    expect(src).toMatch(/const finalSlug = slug && slug\.length > 0/);
    // INSERT binds the guarded/derived values, not `category_id || null` / raw slug
    expect(src).toMatch(/\[orgId, category_id, name, finalSlug,/);
  });
  it("PUT uses validated pv.data, not the raw body", () => {
    expect(src).toMatch(/const updates = pv\.data;/);
  });
});

describe("AUDIT9-3: expenses + payment_status zod mirror the DB CHECK", () => {
  it("expenseCreateSchema enforces the category + recurrence enums", async () => {
    const { expenseCreateSchema } = await import("@/lib/validation/schemas");
    const ok = { category: "utilities", description: "x", amount: 5 };
    expect(expenseCreateSchema.safeParse(ok).success).toBe(true);
    expect(expenseCreateSchema.safeParse({ ...ok, category: "food" }).success).toBe(false);
    expect(expenseCreateSchema.safeParse({ ...ok, recurrence_period: "daily" }).success).toBe(false);
    expect(expenseCreateSchema.safeParse({ ...ok, recurrence_period: "monthly" }).success).toBe(true);
  });
  it("customerDisplaySchema.paymentStatus matches the (migration 086) CHECK", async () => {
    const { customerDisplaySchema } = await import("@/lib/validation/schemas");
    const field = (customerDisplaySchema as unknown as { shape: { paymentStatus: { safeParse: (v: unknown) => { success: boolean } } } }).shape.paymentStatus;
    expect(field.safeParse("failed").success).toBe(true);
    expect(field.safeParse("cancelled").success).toBe(true);
    expect(field.safeParse(undefined).success).toBe(true); // optional
    expect(field.safeParse("idle").success).toBe(false);
    expect(field.safeParse("error").success).toBe(false);
  });
  it("migration 086 widens the prod CHECK to the 5-value set", () => {
    const src = read("supabase/migrations/086_customer_display_payment_status_check_reconcile.sql");
    expect(src).toMatch(/'pending', 'processing', 'complete', 'failed', 'cancelled'/);
  });
});

describe("AUDIT9-4: dropped cache cascades are awaited", () => {
  it("returns/process awaits invalidateInventoryCache", () => {
    const src = read("src/app/api/returns/process/route.ts");
    expect(src).toMatch(/await invalidateInventoryCache\(orgId\);\n\s*return NextResponse\.json\(\{\s*\n\s*return_id/);
  });
  it("offline-sync !inserted branch awaits invalidateInventoryCache", () => {
    const src = read("src/app/api/offline-sync/route.ts");
    expect(src).toMatch(/if \(!inserted\) \{[\s\S]*?await invalidateInventoryCache\(orgId\);/);
  });
});

describe("AUDIT9-5: quickSwitch re-verifies the target role's register perms", () => {
  it("both branches check hasPermission(newEmployee.roleKey, register.*)", () => {
    const src = read("src/app/register/actions.ts");
    const matches = src.match(/hasPermission\(newEmployee\.roleKey, "register\.pin_login"\) \|\| !hasPermission\(newEmployee\.roleKey, "register\.open"\)/g) ?? [];
    expect(matches.length).toBe(2); // PG branch + JSON branch
  });
});
