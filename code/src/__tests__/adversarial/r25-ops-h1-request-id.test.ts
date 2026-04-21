/**
 * R25-ops-H-1 regression: every response from `withAdminAuth` /
 * `withDualAuth`-wrapped routes must include an `x-request-id`
 * header, and 500 responses must emit structured JSON logs with
 * {reqId, orgId, employeeId, path, method, error}.
 *
 * Prior to R25 the wrappers emitted `[GET /api/foo]` + safeErr(err)
 * with NO correlation ID and NO tenant context. Support tickets
 * saying "my checkout failed at 3pm" were undebuggable.
 *
 * This test validates both the header echo and the structured log
 * shape so a future refactor that drops the reqId fails CI.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Mock the auth path to return a valid admin context.
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: async () => ({
    session: { id: "s1" },
    employee: {
      id: "emp1",
      organizationId: "org-r25-h1",
      roleKey: "owner",
      locationIds: ["loc1"],
    },
  }),
  getRegisterSession: async () => null,
}));
vi.mock("@/lib/domain/permissions", () => ({
  hasPermission: () => true,
}));
// next/headers requires a request scope; stub cookies() so unit tests
// can invoke the wrapper without a full Next.js runtime.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));

describe("R25-ops-H-1 regression: response carries x-request-id + structured error logs", () => {
  it("successful response echoes x-request-id", async () => {
    const { withAdminAuth } = await import("@/lib/api/with-auth");
    const handler = withAdminAuth("audit.view", async (req, ctx) => {
      // Handler has access to reqId via context.
      expect(ctx.reqId).toBeTruthy();
      return NextResponse.json({ ok: true, ctxReqId: ctx.reqId });
    });
    const req = new NextRequest("https://bupos.example/api/audit", { method: "GET" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const echoed = res.headers.get("x-request-id");
    expect(echoed).toBeTruthy();
    expect(echoed!.length).toBeGreaterThan(8);
  });

  it("500 response echoes x-request-id AND logs structured JSON with reqId + orgId + employeeId", async () => {
    const { withAdminAuth } = await import("@/lib/api/with-auth");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handler = withAdminAuth("audit.view", async () => {
        throw new Error("deliberate failure for test");
      });
      const req = new NextRequest("https://bupos.example/api/boom", { method: "GET" });
      const res = await handler(req);
      expect(res.status).toBe(500);
      const reqId = res.headers.get("x-request-id");
      expect(reqId).toBeTruthy();

      // Response body includes reqId so users can cite it in support tickets.
      const body = await res.json();
      expect(body.reqId).toBe(reqId);

      // Structured log: one console.error call with a parsable JSON payload
      // matching the api_route_error shape.
      expect(consoleErrorSpy).toHaveBeenCalled();
      const call = consoleErrorSpy.mock.calls.find((c) => {
        try {
          const obj = JSON.parse(c[0] as string);
          return obj.event === "api_route_error";
        } catch {
          return false;
        }
      });
      expect(call, "must emit api_route_error structured JSON").toBeTruthy();
      const parsed = JSON.parse(call![0] as string);
      expect(parsed.reqId).toBe(reqId);
      expect(parsed.orgId).toBe("org-r25-h1");
      expect(parsed.employeeId).toBe("emp1");
      expect(parsed.path).toBe("/api/boom");
      expect(parsed.method).toBe("GET");
      expect(parsed.error).toBeTruthy();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("Unauthorized response ALSO includes x-request-id (users can cite on login issues)", async () => {
    // Override the session mock to return null → unauthorized path.
    vi.resetModules();
    vi.doMock("@/lib/auth/session", () => ({
      getAdminSession: async () => null,
      getRegisterSession: async () => null,
    }));
    vi.doMock("@/lib/domain/permissions", () => ({ hasPermission: () => true }));
    const { withAdminAuth } = await import("@/lib/api/with-auth");
    const handler = withAdminAuth("audit.view", async () => NextResponse.json({}));
    const req = new NextRequest("https://bupos.example/api/any", { method: "GET" });
    const res = await handler(req);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});
