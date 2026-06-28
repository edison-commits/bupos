import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetAdminSession = vi.fn();
const mockGetRegisterSession = vi.fn();
const mockGetInventoryForecast = vi.fn();
const mockSummarizeInventoryForecast = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
  getRegisterSession: () => mockGetRegisterSession(),
}));

vi.mock("@/lib/domain/permissions", () => ({
  hasPermission: (role: string, permission: string) => permission === "inventory.adjust" && ["owner", "manager", "inventory_clerk"].includes(role),
  roleDefinitions: [],
}));

vi.mock("@/lib/inventory/forecast-report", () => ({
  getInventoryForecast: (...args: unknown[]) => mockGetInventoryForecast(...args),
  summarizeInventoryForecast: (...args: unknown[]) => mockSummarizeInventoryForecast(...args),
}));

const { GET } = await import("@/app/api/inventory/forecast/route");

function request(url: string) {
  return new NextRequest(new URL(url));
}

function adminCtx(roleKey = "owner", locationIds = ["loc-1", "loc-2"]) {
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

describe("GET /api/inventory/forecast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRegisterSession.mockResolvedValue(null);
    mockGetInventoryForecast.mockResolvedValue([
      { variantId: "var-1", risk: "critical", productName: "Polo" },
    ]);
    mockSummarizeInventoryForecast.mockReturnValue({ critical: 1, soon: 0, watch: 0, healthy: 0, unknown: 0 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const res = await GET(request("http://localhost/api/inventory/forecast"));

    expect(res.status).toBe(401);
    expect(mockGetInventoryForecast).not.toHaveBeenCalled();
  });

  it("lets managers request all locations", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("manager"));

    const res = await GET(request("http://localhost/api/inventory/forecast?location=all&risk=critical&limit=50"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [{ variantId: "var-1", risk: "critical", productName: "Polo" }],
      summary: { critical: 1, soon: 0, watch: 0, healthy: 0, unknown: 0 },
    });
    expect(mockGetInventoryForecast).toHaveBeenCalledWith({
      orgId: "org-1",
      locationId: undefined,
      risk: "critical",
      limit: 50,
    });
  });

  it("constrains non-manager all-location requests to their active location", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("inventory_clerk", ["loc-1"]));

    const res = await GET(request("http://localhost/api/inventory/forecast?location=all&risk=all"));

    expect(res.status).toBe(200);
    expect(mockGetInventoryForecast).toHaveBeenCalledWith({
      orgId: "org-1",
      locationId: "loc-1",
      risk: "all",
      limit: 100,
    });
  });

  it("rejects a non-manager request for an unassigned location", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("inventory_clerk", ["loc-1"]));

    const res = await GET(request("http://localhost/api/inventory/forecast?location=loc-2"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Location not assigned to this employee" });
    expect(mockGetInventoryForecast).not.toHaveBeenCalled();
  });

  it("rejects invalid risk filters", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("owner"));

    const res = await GET(request("http://localhost/api/inventory/forecast?risk=urgent"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid risk. Use all, critical, soon, watch, healthy, or unknown." });
    expect(mockGetInventoryForecast).not.toHaveBeenCalled();
  });

  it("caps limit at 500", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("owner"));

    const res = await GET(request("http://localhost/api/inventory/forecast?limit=9999"));

    expect(res.status).toBe(200);
    expect(mockGetInventoryForecast).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
  });
});
