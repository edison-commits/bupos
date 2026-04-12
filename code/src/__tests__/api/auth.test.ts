import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ── Mocks ──

const mockGetAdminSession = vi.fn();
const mockGetRegisterSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
  getRegisterSession: () => mockGetRegisterSession(),
}));

vi.mock("@/lib/domain/permissions", () => ({
  hasPermission: (role: string, perm: string) => {
    const perms: Record<string, string[]> = {
      owner: ["audit.view", "catalog.manage", "employee.manage"],
      manager: ["audit.view", "catalog.manage", "employee.manage"],
      cashier: ["register.open"],
    };
    return perms[role]?.includes(perm) ?? false;
  },
  roleDefinitions: [],
}));

import { withAdminAuth, withDualAuth } from "@/lib/api/with-auth";

// ── Helpers ──

function makeRequest(url = "http://localhost/api/test") {
  return new NextRequest(new URL(url));
}

const ownerCtx = {
  session: { id: "sess-1", employeeId: "emp-1", scope: "admin" as const },
  employee: {
    id: "emp-1",
    organizationId: "org-1",
    roleKey: "owner",
    locationIds: ["loc-1"],
  },
};

const cashierCtx = {
  session: { id: "sess-2", employeeId: "emp-2", scope: "admin" as const },
  employee: {
    id: "emp-2",
    organizationId: "org-1",
    roleKey: "cashier",
    locationIds: ["loc-1"],
  },
};

const registerCtx = {
  session: { id: "sess-3", employeeId: "emp-3", scope: "register" as const },
  employee: {
    id: "emp-3",
    organizationId: "org-1",
    roleKey: "owner",
    locationIds: ["loc-1"],
  },
  location: { id: "loc-1" },
  registerSession: { id: "reg-sess-1" },
};

// ── Tests ──

describe("withAdminAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRegisterSession.mockResolvedValue(null);
  });

  it("returns 401 without session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const handler = withAdminAuth("audit.view", async () =>
      NextResponse.json({ ok: true }),
    );
    const res = await handler(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 403 without permission", async () => {
    mockGetAdminSession.mockResolvedValue(cashierCtx);
    const handler = withAdminAuth("audit.view", async () =>
      NextResponse.json({ ok: true }),
    );
    const res = await handler(makeRequest());
    expect(res.status).toBe(403);
  });

  it("calls handler with correct context when authorized", async () => {
    mockGetAdminSession.mockResolvedValue(ownerCtx);
    const spy = vi.fn(async (_req, ctx) => {
      return NextResponse.json({
        orgId: ctx.orgId,
        employeeId: ctx.employee.id,
      });
    });

    const handler = withAdminAuth("audit.view", spy);
    const res = await handler(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.orgId).toBe("org-1");
    expect(body.employeeId).toBe("emp-1");
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("withDualAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when neither admin nor register session exists", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    mockGetRegisterSession.mockResolvedValue(null);
    const handler = withDualAuth("audit.view", async () =>
      NextResponse.json({ ok: true }),
    );
    const res = await handler(makeRequest());
    expect(res.status).toBe(401);
  });

  it("falls back to register session when admin session is missing", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    mockGetRegisterSession.mockResolvedValue(registerCtx);

    const spy = vi.fn(async (_req, ctx) => {
      return NextResponse.json({
        orgId: ctx.orgId,
        hasRegisterSession: ctx.registerSession != null,
      });
    });

    const handler = withDualAuth("audit.view", spy);
    const res = await handler(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.orgId).toBe("org-1");
    expect(body.hasRegisterSession).toBe(true);
  });

  it("prefers admin session over register session", async () => {
    mockGetAdminSession.mockResolvedValue(ownerCtx);
    mockGetRegisterSession.mockResolvedValue(registerCtx);

    const spy = vi.fn(async (_req, ctx) =>
      NextResponse.json({ employeeId: ctx.employee.id }),
    );

    const handler = withDualAuth("audit.view", spy);
    const res = await handler(makeRequest());
    const body = await res.json();
    expect(body.employeeId).toBe("emp-1"); // admin's employee, not register's
  });
});
