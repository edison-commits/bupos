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

vi.mock("@/lib/supabase-rest", () => ({
  orgQuery: (...args: unknown[]) => mockOrgQuery(...args),
  orgTx: (...args: unknown[]) => mockOrgTx(...args),
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

vi.mock("@/lib/validation/schemas", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual };
});

const { GET, POST } = await import("@/app/api/returns/route");

// ── Helpers ──

function makeRequest(url = "http://localhost/api/returns") {
  return new NextRequest(new URL(url));
}

/**
 * Build a state-changing request with Origin header so checkOrigin
 * (with-auth.ts CSRF guard) passes through to the auth check.
 */
function makeMutatingRequest(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body: object,
) {
  return new NextRequest(new URL(url), {
    method,
    headers: { "content-type": "application/json", origin: new URL(url).origin },
    body: JSON.stringify(body),
  });
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
      makeMutatingRequest("http://localhost/api/returns", "POST", {
        reason: "defective",
        lines: [],
      }),
    );
    expect(res.status).toBe(401);
  });

  it("creates a return with valid data", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);

    // The entire route now runs on a SINGLE orgTx client. Every
    // client.query() pulls the next mock in the sequence below.
    const clientQueries = vi.fn()
      // 0) R31-H5: pg_advisory_xact_lock on `return:<txn>`
      .mockResolvedValueOnce({ rows: [{ pg_advisory_xact_lock: "" }] })
      // 1) FOR UPDATE on transactions — returns the original txn so the
      //    line-by-line verification passes.
      .mockResolvedValueOnce({
        rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          cart_snapshot: {
            items: [
              { productVariantId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", unitPrice: 10, quantity: 1 },
            ],
          },
          subtotal: "10.00",
          discount_total: "0.00",
          tax_total: "0.00",
          grand_total: "10.00",
          location_id: "loc-1",
        }],
      })
      // 2) prior returns aggregation (empty — nothing previously returned)
      .mockResolvedValueOnce({ rows: [] })
      // 3) prior register-side returns (empty)
      .mockResolvedValueOnce({ rows: [] })
      // 4) location name lookup
      .mockResolvedValueOnce({ rows: [{ name: "BEL" }] })
      // 5) Count for sequence (inside retry loop)
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      // 6) SAVEPOINT sp_ret_insert
      .mockResolvedValueOnce({ rows: [] })
      // 7) Header INSERT RETURNING
      .mockResolvedValueOnce({ rows: [{ id: "ret-new", return_number: "RET-BEL-260412-001", status: "pending" }] })
      // 8) RELEASE SAVEPOINT
      .mockResolvedValueOnce({ rows: [] })
      // 9) Line INSERT
      .mockResolvedValueOnce({ rows: [] })
      // 10) COMMIT
      .mockResolvedValueOnce({ rows: [] });
    mockOrgTx.mockResolvedValueOnce({
      query: clientQueries,
      release: vi.fn(),
    });

    const res = await POST(
      makeMutatingRequest("http://localhost/api/returns", "POST", {
        transaction_id: "11111111-1111-4111-8111-111111111111",
        reason: "defective",
        lines: [
          { product_variant_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", quantity: 1, unit_price: 10 },
        ],
      }),
    );
    expect(res.status).toBe(201);
  });

  it("returns 400 on invalid input", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);
    const res = await POST(
      makeMutatingRequest("http://localhost/api/returns", "POST", {}),
    );
    expect(res.status).toBe(400);
  });
});
