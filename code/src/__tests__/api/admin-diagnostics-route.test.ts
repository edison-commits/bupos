import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetAdminSession = vi.fn();
const mockOrgQuery = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
  getRegisterSession: vi.fn(),
}));

vi.mock("@/lib/domain/permissions", () => ({
  hasPermission: (role: string, permission: string) => permission === "audit.view" && ["owner", "manager", "support"].includes(role),
  roleDefinitions: [],
}));

vi.mock("@/lib/supabase-rest", () => ({
  orgQuery: (...args: unknown[]) => mockOrgQuery(...args),
}));

const { GET } = await import("@/app/api/admin/diagnostics/route");

function request(path: string) {
  return new NextRequest(new URL(`http://localhost${path}`));
}

function adminCtx(roleKey = "support") {
  return {
    session: { id: "sess-1", employeeId: "emp-1", scope: "admin" },
    employee: {
      id: "emp-1",
      organizationId: "org-1",
      roleKey,
      locationIds: ["loc-1"],
    },
  };
}

describe("GET /api/admin/diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgQuery.mockImplementation(async (_orgId: string, sql: string) => {
      if (sql.includes("SELECT 1 AS ok")) return { rows: [{ ok: 1 }] };
      if (sql.includes("open_shift_evidence")) return { rows: [] };
      if (sql.includes("FROM shifts")) return { rows: [{ conflict_count: 0 }] };
      if (sql.includes("FROM inventory_levels")) return { rows: [{ negative_count: 0, low_stock_count: 2 }] };
      if (sql.includes("FROM transactions")) return { rows: [{ void_count: 0, refund_count: 0 }] };
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("requires an admin session", async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const res = await GET(request("/api/admin/diagnostics"));

    expect(res.status).toBe(401);
    expect(mockOrgQuery).not.toHaveBeenCalled();
  });

  it("returns no-store diagnostics for the current org and assigned location", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("support"));

    const res = await GET(request("/api/admin/diagnostics"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(body.status).toBe("warning");
    expect(body.locationId).toBe("loc-1");
    expect(body.checks.map((check: { id: string }) => check.id)).toEqual([
      "database-connectivity",
      "open-shift-conflicts",
      "inventory-risk",
      "recent-transaction-exceptions",
    ]);
    expect(mockOrgQuery).toHaveBeenCalledWith("org-1", expect.stringContaining("FROM inventory_levels"), ["org-1", ["loc-1"]]);
  });

  it("returns a sanitized support packet when format=packet", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("manager"));

    const res = await GET(request("/api/admin/diagnostics?format=packet"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.kind).toBe("bupos-admin-support-packet");
    expect(body.operatorSummary).toMatchObject({
      status: "warning",
      requestId: expect.any(String),
      warningCount: 1,
      criticalCount: 0,
    });
    expect(body.operatorSummary.headline).toBe("Store health needs manager review.");
    expect(body.operatorSummary.safeNextSteps).toContain("Open inventory review before changing quantities.");
    expect(JSON.stringify(body)).not.toContain("/" + "Users/");
    expect(JSON.stringify(body)).not.toContain("sk" + "-");
    expect(body.note).toContain("No fix action was performed");
  });
});
