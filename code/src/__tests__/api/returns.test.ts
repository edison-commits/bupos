import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ──

const mockOrgQuery = vi.fn();
const mockOrgTx = vi.fn();
vi.mock("@/lib/db", () => ({
  orgQuery: (...args: unknown[]) => mockOrgQuery(...args),
  orgTx: (...args: unknown[]) => mockOrgTx(...args),
  pool: { query: vi.fn(), connect: vi.fn() },
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

vi.mock("@/lib/validation/schemas", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual };
});

const { GET, POST } = await import("@/app/api/returns/route");

// ── Helpers ──

function makeRequest(url = "http://localhost/api/returns") {
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

describe("GET /api/returns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRegisterSession.mockResolvedValue(null);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns paginated returns list", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);
    // GET fires 2 parallel queries: count + rows
    mockOrgQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "ret-1",
            return_number: "RET-STR-260401-001",
            status: "pending",
            location_name: "Main",
            line_count: 2,
            total_items: 3,
          },
        ],
      });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.returns).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});

describe("POST /api/returns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRegisterSession.mockResolvedValue(null);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await POST(
      new NextRequest(new URL("http://localhost/api/returns"), {
        method: "POST",
        body: JSON.stringify({ reason: "defective", lines: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("creates a return with valid data", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);

    // location name lookup
    mockOrgQuery.mockResolvedValueOnce({ rows: [{ name: "BEL" }] });
    // count for sequence
    mockOrgQuery.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });
    // insert return
    mockOrgQuery.mockResolvedValueOnce({ rows: [{ id: "ret-new", return_number: "RET-BEL-260412-001", status: "pending" }] });
    // insert line
    mockOrgQuery.mockResolvedValueOnce({ rows: [] });

    const res = await POST(
      new NextRequest(new URL("http://localhost/api/returns"), {
        method: "POST",
        body: JSON.stringify({
          reason: "defective",
          lines: [
            { product_variant_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", quantity: 1, unit_price: 10 },
          ],
        }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("returns 400 on invalid input", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);
    const res = await POST(
      new NextRequest(new URL("http://localhost/api/returns"), {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
});
