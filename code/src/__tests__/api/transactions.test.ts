import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ──

const mockOrgQuery = vi.fn();
// R25-perf-3 migrated transaction read paths to orgTx + client.query.
// Bridge: each client.query() pulls from mockOrgQuery so tests that set
// mockOrgQuery.mockResolvedValueOnce(...) keep working.
const mockOrgTxClient = {
  query: (...args: unknown[]) => {
    const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : "";
    if (sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK") || sql.startsWith("BEGIN")) {
      return Promise.resolve({ rows: [] });
    }
    return mockOrgQuery(...args);
  },
  release: vi.fn(),
};
vi.mock("@/lib/db", () => ({
  orgQuery: (...args: unknown[]) => mockOrgQuery(...args),
  orgTx: vi.fn().mockResolvedValue(mockOrgTxClient),
  pool: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock("@/lib/supabase-rest", () => ({
  orgQuery: (...args: unknown[]) => mockOrgQuery(...args),
  orgTx: vi.fn().mockResolvedValue(mockOrgTxClient),
  getPool: vi.fn().mockResolvedValue({ query: vi.fn(), connect: vi.fn() }),
}));

const mockGetAdminSession = vi.fn();
const mockGetRegisterSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
  getRegisterSession: () => mockGetRegisterSession(),
}));

vi.mock("@/lib/domain/permissions", () => ({
  hasPermission: (role: string, _perm: string) =>
    role === "owner" || role === "manager",
  roleDefinitions: [],
}));

// Import route handlers after mocks are in place
const { GET } = await import("@/app/api/transactions/route");

// ── Helpers ──

function makeRequest(url = "http://localhost/api/transactions") {
  return new NextRequest(new URL(url));
}

const fakeAdminCtx = {
  session: { id: "sess-1", employeeId: "emp-1", scope: "admin" },
  employee: {
    id: "emp-1",
    organizationId: "org-1",
    roleKey: "owner",
    locationIds: ["loc-1"],
  },
};

// ── Tests ──

describe("GET /api/transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRegisterSession.mockResolvedValue(null);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns transaction list with auth", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);
    mockOrgQuery.mockResolvedValue({
      rows: [
        {
          id: "txn-1",
          status: "completed",
          grand_total: "25.00",
          created_at: "2026-04-01T00:00:00Z",
          employee_name: "Alice",
          customer_name: null,
          tender_count: 1,
        },
      ],
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].id).toBe("txn-1");
    expect(body.hasMore).toBe(false);
  });

  it("returns single transaction detail when ?id= is provided", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);

    // The route fires 4 parallel orgQuery calls for detail view
    mockOrgQuery
      .mockResolvedValueOnce({ rows: [{ id: "txn-1", status: "completed" }] }) // transaction
      .mockResolvedValueOnce({ rows: [{ id: "td-1", tender_type: "cash" }] }) // tenders
      .mockResolvedValueOnce({ rows: [] }) // events
      .mockResolvedValueOnce({ rows: [] }); // exceptions

    const res = await GET(makeRequest("http://localhost/api/transactions?id=txn-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transaction.id).toBe("txn-1");
    expect(body.tenders).toHaveLength(1);
  });

  it("returns 404 when transaction id not found", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);
    mockOrgQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await GET(makeRequest("http://localhost/api/transactions?id=missing"));
    expect(res.status).toBe(404);
  });

  it("returns 403 when user lacks permission", async () => {
    mockGetAdminSession.mockResolvedValue({
      session: { id: "s-1", employeeId: "emp-2", scope: "admin" },
      employee: {
        id: "emp-2",
        organizationId: "org-1",
        roleKey: "cashier",
        locationIds: ["loc-1"],
      },
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });
});
