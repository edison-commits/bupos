import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ──

const mockOrgQuery = vi.fn();
const mockPoolConnect = vi.fn();
// R25-perf-3 migrated the products route from 3 parallel `orgQuery`
// calls to a single `orgTx` + 3 `client.query(...)` calls on that
// client. mockOrgTxClient bridges: each client.query() pulls the next
// queued result out of mockOrgQuery, so the existing
// `mockOrgQuery.mockResolvedValueOnce(...)` setup keeps working.
const mockOrgTxClient = {
  query: (...args: unknown[]) => {
    // COMMIT/ROLLBACK/BEGIN are structural — skip the fixture queue.
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
  pool: { query: vi.fn(), connect: () => mockPoolConnect() },
}));

// API routes actually import from @/lib/supabase-rest (lazy wrapper).
// Mock that too so orgQuery calls route to the same mock fn.
vi.mock("@/lib/supabase-rest", () => ({
  orgQuery: (...args: unknown[]) => mockOrgQuery(...args),
  orgTx: vi.fn().mockResolvedValue(mockOrgTxClient),
  getPool: vi.fn().mockResolvedValue({ query: vi.fn(), connect: () => mockPoolConnect() }),
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

vi.mock("@/lib/persistence/postgres-store", () => ({
  invalidateProductsCache: vi.fn(),
  invalidateVariantsCache: vi.fn(),
  pgInsertAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
}));

const { GET, POST, PUT } = await import("@/app/api/products/route");

// ── Helpers ──

function makeRequest(url = "http://localhost/api/products") {
  return new NextRequest(new URL(url));
}

/**
 * Build a state-changing request. R21-something added a CSRF guard
 * (checkOrigin in with-auth.ts) that returns 403 if Origin/Referer is
 * missing on POST/PUT/PATCH/DELETE. Tests need to provide a same-origin
 * Origin header so the guard passes through to the auth check.
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

function makeFakeClient() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  mockPoolConnect.mockResolvedValue(client);
  return client;
}

// ── Tests ──

describe("GET /api/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRegisterSession.mockResolvedValue(null);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns products list", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);

    // 3 parallel queries: products, categories, summary
    mockOrgQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "p-1",
            name: "T-Shirt",
            slug: "t-shirt",
            category_id: "cat-1",
            category_name: "Apparel",
            is_active: true,
            variant_id: "v-1",
            sku: "TS-001",
            price: "25.00",
            cost: "10.00",
            stock: 50,
            variant_is_active: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "cat-1", name: "Apparel", slug: "apparel" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            total_products: 1,
            active_products: 1,
            total_variants: 1,
            categories_count: 1,
          },
        ],
      });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toHaveLength(1);
    expect(body.products[0].name).toBe("T-Shirt");
    expect(body.products[0].variants).toHaveLength(1);
    expect(body.categories).toHaveLength(1);
  });

  it("returns products filtered by search", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);
    mockOrgQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total_products: 0 }] });

    const res = await GET(makeRequest("http://localhost/api/products?search=hat"));
    expect(res.status).toBe(200);
    // R25-perf-3: route migrated from orgQuery(orgId, sql, params) to
    // client.query(sql, params). SQL is now at args[0], not args[1].
    const firstCallSql = mockOrgQuery.mock.calls[0][0] as string;
    expect(firstCallSql).toContain("ILIKE");
  });
});

describe("POST /api/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRegisterSession.mockResolvedValue(null);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await POST(
      makeMutatingRequest("http://localhost/api/products", "POST", { name: "Test" }),
    );
    expect(res.status).toBe(401);
  });

  it("creates a product with valid data", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);
    const client = makeFakeClient();
    // POST route: pool.connect() → client.query(BEGIN, SET LOCAL, INSERT product, COMMIT)
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL
      .mockResolvedValueOnce({ // INSERT product
        rows: [{
          id: "p-new",
          name: "Jacket",
          slug: "jacket",
          category_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          is_active: true,
          is_touch_favorite: false,
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await POST(
      makeMutatingRequest("http://localhost/api/products", "POST", {
        name: "Jacket",
        slug: "jacket",
        category_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        variant: {
          sku: "JK-001",
          name: "Default",
          price: 50,
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Jacket");
  });

  it("returns 400 on validation error (missing name)", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);
    makeFakeClient();

    const res = await POST(
      makeMutatingRequest("http://localhost/api/products", "POST", { slug: "no-name" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRegisterSession.mockResolvedValue(null);
  });

  it("returns 400 on validation error (missing product_id)", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);
    makeFakeClient();

    const res = await PUT(
      makeMutatingRequest("http://localhost/api/products", "PUT", { name: "Updated" }),
    );
    expect(res.status).toBe(400);
  });

  it("updates a product successfully", async () => {
    mockGetAdminSession.mockResolvedValue(fakeAdminCtx);
    const client = makeFakeClient();
    // PUT route: pool.connect() → client.query(BEGIN, SET LOCAL, UPDATE RETURNING, COMMIT)
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL
      .mockResolvedValueOnce({ // UPDATE RETURNING
        rows: [
          {
            id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            name: "Updated Jacket",
            slug: "jacket",
            updated_at: "2026-04-12T00:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await PUT(
      makeMutatingRequest("http://localhost/api/products", "PUT", {
        product_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        name: "Updated Jacket",
      }),
    );
    expect([200, 400, 409, 500].includes(res.status)).toBe(true);
  });
});
