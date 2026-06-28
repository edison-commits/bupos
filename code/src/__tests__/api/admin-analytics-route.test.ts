import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetAdminSession = vi.fn();
const mockGetSalesByStorePeriod = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
  getRegisterSession: vi.fn(),
}));

vi.mock("@/lib/domain/permissions", () => ({
  hasPermission: (role: string, permission: string) => permission === "audit.view" && ["owner", "manager", "support"].includes(role),
  roleDefinitions: [],
}));

vi.mock("@/lib/reports/admin-analytics", () => ({
  getSalesByStorePeriod: (...args: unknown[]) => mockGetSalesByStorePeriod(...args),
}));

const { GET } = await import("@/app/api/reports/sales-by-store/route");

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

describe("GET /api/reports/sales-by-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSalesByStorePeriod.mockResolvedValue([
      {
        locationId: "loc-1",
        locationName: "Redondo",
        period: "2026-01",
        revenue: 100,
        transactionCount: 4,
        unitsSold: 8,
        avgTicket: 25,
        refundCount: 0,
        returnTotal: 0,
      },
    ]);
  });

  it("returns 401 when no admin session exists", async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const res = await GET(request("http://localhost/api/reports/sales-by-store?from=2026-01-01&to=2026-01-31&groupBy=month"));

    expect(res.status).toBe(401);
    expect(mockGetSalesByStorePeriod).not.toHaveBeenCalled();
  });

  it("lets managers request all stores", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("manager"));

    const res = await GET(request("http://localhost/api/reports/sales-by-store?from=2026-01-01&to=2026-01-31&groupBy=month&location=all"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      groupBy: "month",
      from: "2026-01-01",
      to: "2026-01-31",
      rows: [
        {
          locationId: "loc-1",
          locationName: "Redondo",
          period: "2026-01",
          revenue: 100,
          transactionCount: 4,
          unitsSold: 8,
          avgTicket: 25,
          refundCount: 0,
          returnTotal: 0,
        },
      ],
    });
    expect(mockGetSalesByStorePeriod).toHaveBeenCalledWith({
      orgId: "org-1",
      from: "2026-01-01",
      to: "2026-01-31",
      groupBy: "month",
      locationIds: undefined,
    });
  });

  it("constrains non-manager all-store requests to assigned locations", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("support", ["loc-1"]));

    const res = await GET(request("http://localhost/api/reports/sales-by-store?from=2026-01-01&to=2026-01-31&groupBy=day&location=all"));

    expect(res.status).toBe(200);
    expect(mockGetSalesByStorePeriod).toHaveBeenCalledWith({
      orgId: "org-1",
      from: "2026-01-01",
      to: "2026-01-31",
      groupBy: "day",
      locationIds: ["loc-1"],
    });
  });

  it("rejects a non-manager request for an unassigned location", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("support", ["loc-1"]));

    const res = await GET(request("http://localhost/api/reports/sales-by-store?from=2026-01-01&to=2026-01-31&groupBy=day&location=loc-2"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Location not assigned to this employee" });
    expect(mockGetSalesByStorePeriod).not.toHaveBeenCalled();
  });

  it("rejects invalid groupBy values", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("owner"));

    const res = await GET(request("http://localhost/api/reports/sales-by-store?from=2026-01-01&to=2026-01-31&groupBy=quarter"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid groupBy. Use day, month, or year." });
    expect(mockGetSalesByStorePeriod).not.toHaveBeenCalled();
  });

  it("rejects date ranges over 400 days", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("owner"));

    const res = await GET(request("http://localhost/api/reports/sales-by-store?from=2025-01-01&to=2026-12-31&groupBy=year"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Date range exceeds 400-day cap. Use export for longer ranges." });
    expect(mockGetSalesByStorePeriod).not.toHaveBeenCalled();
  });
});
