/**
 * R23-L-3: public `/api/health` must NOT expose `lastLookupError`
 * or per-subsystem detail. Full diagnostics moved to
 * `/api/admin/health` behind admin auth.
 *
 * Regression gate: hit /api/health via route module + assert the
 * JSON body shape only contains {status, rateLimitKv.bindingAvailable}.
 * Previously the response included `lastLookupError` (up to 200
 * chars of OpenNext internal error text) which leaked to
 * unauthenticated callers.
 *
 * Also asserts `Cache-Control: no-store, private` — required so a
 * misconfigured CDN can't cache a stale error response.
 */
import { describe, it, expect, vi } from "vitest";

// Mock the heavy deps so the route module runs in unit-test isolation.
vi.mock("@/lib/auth/kv-rate-limit", () => ({
  probeKvBinding: async () => ({
    bindingAvailable: true,
    lastLookupError: "SECRET_LEAK: stack frames + internal paths",
  }),
}));
vi.mock("@/lib/supabase-rest", () => ({
  getPool: async () => ({
    query: async () => ({ rows: [{ check: 1, ts: new Date() }], rowCount: 1 }),
  }),
}));

describe("R23-L-3 regression: /api/health public response", () => {
  it("body does not contain lastLookupError", async () => {
    const { GET } = await import("@/app/api/health/route");
    // R32-M-health-RL: GET now takes a NextRequest for IP-based RL.
    const req = new Request("https://example.com/api/health", { headers: { "cf-connecting-ip": "1.2.3.4" } }) as unknown as Parameters<typeof GET>[0];
    const res = await GET(req);
    const body = await res.json();
    // bindingAvailable present (ops alerting needs this).
    expect(body.rateLimitKv?.bindingAvailable).toBe(true);
    // lastLookupError MUST NOT leak.
    expect(body.rateLimitKv).not.toHaveProperty("lastLookupError");
    // Also assert the overall JSON doesn't mention the leaky sentinel
    // (defense-in-depth against future changes).
    expect(JSON.stringify(body)).not.toContain("SECRET_LEAK");
  });

  it("response sets Cache-Control: no-store", async () => {
    const { GET } = await import("@/app/api/health/route");
    // R32-M-health-RL: GET now takes a NextRequest for IP-based RL.
    const req = new Request("https://example.com/api/health", { headers: { "cf-connecting-ip": "1.2.3.4" } }) as unknown as Parameters<typeof GET>[0];
    const res = await GET(req);
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).toMatch(/no-store/i);
    expect(cacheControl).toMatch(/private/i);
  });

  it("503 path still suppresses the leaky error", async () => {
    // Re-mock to force the unhealthy branch.
    vi.resetModules();
    vi.doMock("@/lib/auth/kv-rate-limit", () => ({
      probeKvBinding: async () => ({
        bindingAvailable: false,
        lastLookupError: "DB DOWN SECRET DETAIL",
      }),
    }));
    vi.doMock("@/lib/supabase-rest", () => ({
      getPool: async () => {
        throw new Error("connection refused SECRET_CONN_STRING");
      },
    }));
    const { GET } = await import("@/app/api/health/route");
    // R32-M-health-RL: GET now takes a NextRequest for IP-based RL.
    const req = new Request("https://example.com/api/health", { headers: { "cf-connecting-ip": "1.2.3.4" } }) as unknown as Parameters<typeof GET>[0];
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    // Unhealthy response must NOT include the error message or KV
    // error detail. Only a status marker.
    expect(JSON.stringify(body)).not.toContain("SECRET_CONN_STRING");
    expect(JSON.stringify(body)).not.toContain("DB DOWN SECRET DETAIL");
  });
});
