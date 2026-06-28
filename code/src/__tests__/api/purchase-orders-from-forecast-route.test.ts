import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetAdminSession = vi.fn();
const mockGetRegisterSession = vi.fn();
const mockCreatePurchaseOrdersFromForecast = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
  getRegisterSession: () => mockGetRegisterSession(),
}));

vi.mock("@/lib/domain/permissions", () => ({
  hasPermission: (role: string, permission: string) => permission === "inventory.adjust" && ["owner", "manager", "inventory_clerk"].includes(role),
  roleDefinitions: [],
}));

vi.mock("@/lib/purchase-orders/from-forecast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/purchase-orders/from-forecast")>();
  return {
    ...actual,
    createPurchaseOrdersFromForecast: (...args: unknown[]) => mockCreatePurchaseOrdersFromForecast(...args),
  };
});

const { POST } = await import("@/app/api/purchase-orders/from-forecast/route");

function request(body: unknown) {
  return new NextRequest("http://localhost/api/purchase-orders/from-forecast", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://localhost" },
  });
}

const LOC_1 = "11111111-1111-4111-8111-111111111111";
const LOC_2 = "22222222-2222-4222-8222-222222222222";

function adminCtx(roleKey = "owner", locationIds = [LOC_1, LOC_2]) {
  return {
    session: { id: "sess-1", employeeId: "emp-1", scope: "admin" },
    employee: {
      id: "emp-1",
      organizationId: "org-1",
      roleKey,
      locationIds,
    },
  };
}

describe("POST /api/purchase-orders/from-forecast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRegisterSession.mockResolvedValue(null);
    mockCreatePurchaseOrdersFromForecast.mockResolvedValue({
      orders: [{ id: "po-1", poNumber: "MAI-PO-260628-001", supplierName: "Uniform Co", locationName: "Main", lineCount: 2 }],
      skipped: [],
    });
  });

  it("creates draft POs from critical and soon forecast rows for managers", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("manager"));

    const res = await POST(request({ mode: "criticalSoon", location: "all" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orders: [{ id: "po-1", poNumber: "MAI-PO-260628-001", supplierName: "Uniform Co", locationName: "Main", lineCount: 2 }],
      skipped: [],
    });
    expect(mockCreatePurchaseOrdersFromForecast).toHaveBeenCalledWith({
      orgId: "org-1",
      employeeId: "emp-1",
      locationId: undefined,
      risks: ["critical", "soon"],
      variantIds: undefined,
    });
  });

  it("limits inventory clerks to their active location when location=all", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("inventory_clerk", [LOC_1]));

    const res = await POST(request({ mode: "critical", location: "all" }));

    expect(res.status).toBe(200);
    expect(mockCreatePurchaseOrdersFromForecast).toHaveBeenCalledWith(expect.objectContaining({
      locationId: LOC_1,
      risks: ["critical"],
    }));
  });

  it("rejects an inventory clerk's unassigned location", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("inventory_clerk", [LOC_1]));

    const res = await POST(request({ mode: "critical", location: LOC_2 }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Location not assigned to this employee" });
    expect(mockCreatePurchaseOrdersFromForecast).not.toHaveBeenCalled();
  });

  it("requires selected variant ids in selected mode", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("owner"));

    const res = await POST(request({ mode: "selected", variantIds: [] }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "selected mode requires at least one variant id" });
    expect(mockCreatePurchaseOrdersFromForecast).not.toHaveBeenCalled();
  });
});
