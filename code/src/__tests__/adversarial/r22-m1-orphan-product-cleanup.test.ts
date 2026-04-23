/**
 * R22-M-1 + R23-H-2: `createProductAction` must clean up the
 * product row if variant insert raises `VariantUniquenessConflictError`.
 *
 * Background: R23-H-2 fixed the FK-ordering bug by switching to a
 * 3-step sequence (product with null default → variant → update
 * product). If the variant insert throws (duplicate SKU/barcode,
 * R22-M-1), the product row is already committed. The catch path
 * MUST delete the orphan product before redirecting — otherwise
 * the admin UI shows a partially-created product.
 *
 * Regression gate: confirms the cleanup call happens when
 * VariantUniquenessConflictError is thrown. We mock the pg helpers
 * and assert on call order.
 */
import { describe, it, expect, vi } from "vitest";

// Calls we want to observe.
const calls: string[] = [];

// Mock the pg helpers used by createProductAction.
vi.mock("@/lib/persistence/postgres-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/persistence/postgres-store")>(
    "@/lib/persistence/postgres-store",
  );
  return {
    ...actual,
    pgCreateProduct: vi.fn(async () => {
      calls.push("pgCreateProduct");
      return { id: "prod1", modifierGroupIds: [] } as unknown as Awaited<
        ReturnType<typeof actual.pgCreateProduct>
      >;
    }),
    pgCreateVariant: vi.fn(async () => {
      calls.push("pgCreateVariant");
      // Simulate the partial-unique-index collision: throw the
      // typed error the real helper would throw.
      throw new actual.VariantUniquenessConflictError("sku");
    }),
    pgDeleteProduct: vi.fn(async () => {
      calls.push("pgDeleteProduct");
      return true;
    }),
    pgCreateInventoryLevel: vi.fn(async () => {
      calls.push("pgCreateInventoryLevel");
    }),
    pgUpdateProduct: vi.fn(async () => {
      calls.push("pgUpdateProduct");
      return null;
    }),
    pgInsertAuditEvent: vi.fn(async () => {
      calls.push("pgInsertAuditEvent");
    }),
  };
});

// Mock auth + redirect so the action runs without a real session.
vi.mock("@/lib/authz", () => ({
  requireAdminPermission: async () => ({
    session: { id: "s", employeeId: "e", organizationId: "11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    employee: {
      id: "e",
      organizationId: "11aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      roleKey: "owner",
      locationIds: ["22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    },
  }),
}));
// R70-H1: createProductAction now requires step-up re-auth. Mock
// `requireStepUp` to always pass so this regression test stays
// focused on the orphan-cleanup path.
vi.mock("@/lib/auth/step-up", () => ({
  requireStepUp: async () => ({ ok: true as const, status: 200 }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    calls.push(`redirect:${url}`);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

describe("R22-M-1 regression: orphan product cleaned up on variant failure", () => {
  it("createProductAction invokes pgDeleteProduct before redirecting", async () => {
    calls.length = 0;
    const { createProductAction } = await import("@/app/admin/actions");
    const fd = new FormData();
    fd.set("name", "Test Product");
    fd.set("categoryId", "33aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    fd.set("sku", "DUPLICATE-SKU");
    fd.set("variantName", "Default");
    fd.set("price", "19.99");
    // USE_POSTGRES must be truthy to reach the pg branch.
    (process.env as unknown as Record<string, string>).USE_POSTGRES = "true";

    await expect(createProductAction(fd)).rejects.toThrow(/NEXT_REDIRECT/);

    // Expected call order:
    //   1. pgCreateProduct succeeds (product committed).
    //   2. pgCreateVariant throws VariantUniquenessConflictError.
    //   3. pgDeleteProduct fires to clean the orphan.
    //   4. redirect to /admin?error=...
    expect(calls[0]).toBe("pgCreateProduct");
    expect(calls[1]).toBe("pgCreateVariant");
    expect(calls[2]).toBe("pgDeleteProduct");
    expect(calls[3]).toMatch(/^redirect:/);
    // Assert we never reached inventory or the post-catch update.
    expect(calls).not.toContain("pgCreateInventoryLevel");
    expect(calls).not.toContain("pgUpdateProduct");
  });
});
