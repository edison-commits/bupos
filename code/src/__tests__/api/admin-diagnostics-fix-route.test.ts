import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetAdminSession = vi.fn();
const mockAuditClient = {
  query: vi.fn(),
  release: vi.fn(),
};
const mockOrgTx = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
  getRegisterSession: vi.fn(),
}));

vi.mock("@/lib/domain/permissions", () => ({
  hasPermission: (role: string, permission: string) => permission === "audit.view" && ["owner", "manager", "support"].includes(role),
  roleDefinitions: [],
}));

vi.mock("@/lib/supabase-rest", () => ({
  orgTx: (...args: unknown[]) => mockOrgTx(...args),
}));

const { PATCH, POST } = await import("@/app/api/admin/diagnostics/fix/route");

function request(body: Record<string, unknown>, headers: Record<string, string> = {}, method = "POST") {
  return new NextRequest(new URL("http://localhost/api/admin/diagnostics/fix"), {
    method,
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
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

describe("POST /api/admin/diagnostics/fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditClient.query.mockResolvedValue({ rows: [], rowCount: 1 });
    mockAuditClient.release.mockReturnValue(undefined);
    mockOrgTx.mockResolvedValue(mockAuditClient);
    delete process.env.BUPOS_HELP_ACTIONS_KILLED;
    delete process.env.BUPOS_HELP_ACTIONS_KILLED_BY;
    delete process.env.BUPOS_HELP_ACTIONS_KILL_REASON;
  });

  it("requires admin auth", async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const res = await POST(request({ actionId: "refresh-diagnostics-cache" }));

    expect(res.status).toBe(401);
  });

  it("allows a safe local refresh action and returns a verifiable receipt", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("support"));

    const res = await POST(request({ actionId: "refresh-diagnostics-cache" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(body.decision).toMatchObject({ verdict: "allow", band: "L1", allowedToExecute: true });
    expect(body.executed).toBe(true);
    expect(body.receipt.kind).toBe("bupos-help-action-receipt");
    expect(body.receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(body.auditPersisted).toBe(true);
    expect(mockOrgTx).toHaveBeenCalledWith("org-1");
    expect(mockAuditClient.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_events"),
      expect.arrayContaining([
        "org-1",
        "loc-1",
        "emp-1",
        "help_action",
        expect.any(String),
        "help_action_decided",
        expect.any(String),
      ]),
    );
    const insertCall = mockAuditClient.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO audit_events"));
    const payload = JSON.parse(insertCall?.[1]?.[6] as string);
    expect(payload).toMatchObject({
      actionId: "refresh-diagnostics-cache",
      verdict: "allow",
      band: "L1",
      executed: true,
      receiptFingerprint: body.receipt.fingerprint,
    });
    expect(mockAuditClient.query).toHaveBeenCalledWith("COMMIT");
    expect(mockAuditClient.release).toHaveBeenCalled();
  });

  it("still returns the decision receipt if audit persistence fails", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("support"));
    mockAuditClient.query.mockRejectedValueOnce(new Error("audit unavailable"));

    const res = await POST(request({ actionId: "refresh-diagnostics-cache" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.executed).toBe(true);
    expect(body.auditPersisted).toBe(false);
    expect(body.receipt.kind).toBe("bupos-help-action-receipt");
    expect(mockAuditClient.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mockAuditClient.release).toHaveBeenCalled();
  });

  it("does not execute manager-approval actions and records a pending approval request", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("manager"));

    const res = await POST(request({
      actionId: "review-open-shift-conflicts",
      evidence: {
        sourceCheckId: "open-shift-conflicts",
        shiftId: "shift-1",
        reason: "duplicate_open_shift",
        ageHours: 14.5,
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.executed).toBe(false);
    expect(body.decision).toMatchObject({ verdict: "require_approval", band: "L2" });
    expect(body.receipt.outcome).toMatchObject({ executed: false });
    expect(body.approvalRequest).toMatchObject({
      status: "pending",
      actionId: "review-open-shift-conflicts",
      requestedBy: "emp-1",
      orgId: "org-1",
      locationId: "loc-1",
      receiptFingerprint: body.receipt.fingerprint,
    });
    expect(body.approvalRequest.id).toMatch(/^approval:/);

    const insertCalls = mockAuditClient.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO audit_events"));
    expect(insertCalls).toHaveLength(2);
    const approvalPayload = JSON.parse(insertCalls[1][1][6] as string);
    expect(insertCalls[1][1]).toEqual(expect.arrayContaining([
      "org-1",
      "loc-1",
      "emp-1",
      "help_action_approval_request",
      body.approvalRequest.id,
      "help_action_approval_requested",
      expect.any(String),
    ]));
    expect(approvalPayload).toMatchObject({
      status: "pending",
      actionId: "review-open-shift-conflicts",
      verdict: "require_approval",
      band: "L2",
      requestedBy: "emp-1",
      receiptFingerprint: body.receipt.fingerprint,
      evidence: {
        sourceCheckId: "open-shift-conflicts",
        shiftId: "shift-1",
        reason: "duplicate_open_shift",
        ageHours: 14.5,
      },
    });
  });

  it("denies high-risk actions", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("owner"));

    const res = await POST(request({ actionId: "retry-payment-capture" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.executed).toBe(false);
    expect(body.decision).toMatchObject({ verdict: "deny", band: "L3" });
  });

  it("kill switch blocks even safe actions", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("owner"));
    process.env.BUPOS_HELP_ACTIONS_KILLED = "1";
    process.env.BUPOS_HELP_ACTIONS_KILLED_BY = "ops";
    process.env.BUPOS_HELP_ACTIONS_KILL_REASON = "incident";

    const res = await POST(request({ actionId: "refresh-diagnostics-cache" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.executed).toBe(false);
    expect(body.decision.reason).toBe("Help action kill switch is engaged by ops: incident");
  });

  it("rejects malformed JSON/action ids", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("support"));

    const res = await POST(request({ actionId: "" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid actionId" });
  });

  it("lets managers review pending Help approval requests without executing repairs", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("manager"));

    const res = await PATCH(request({
      approvalRequestId: "approval:req-1:review-open-shift-conflicts",
      decision: "manual_review_required",
      receiptFingerprint: "a".repeat(64),
      note: "Check register shift timeline before any repair.",
    }, {}, "PATCH"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      reviewed: true,
      executed: false,
      approvalReview: {
        approvalRequestId: "approval:req-1:review-open-shift-conflicts",
        decision: "manual_review_required",
        reviewedBy: "emp-1",
        roleKey: "manager",
        receiptFingerprint: "a".repeat(64),
      },
    });
    const insertCall = mockAuditClient.query.mock.calls.find(([sql, params]) =>
      String(sql).includes("INSERT INTO audit_events") && Array.isArray(params) && params[5] === "help_action_approval_reviewed",
    );
    expect(insertCall?.[1]).toEqual(expect.arrayContaining([
      "org-1",
      "loc-1",
      "emp-1",
      "help_action_approval_request",
      "approval:req-1:review-open-shift-conflicts",
      "help_action_approval_reviewed",
      expect.any(String),
    ]));
    const payload = JSON.parse(insertCall?.[1]?.[6] as string);
    expect(payload).toMatchObject({
      status: "manual_review_required",
      decision: "manual_review_required",
      reviewedBy: "emp-1",
      executed: false,
    });
    expect(mockAuditClient.query).toHaveBeenCalledWith("COMMIT");
  });

  it("does not let support users review pending Help approval requests", async () => {
    mockGetAdminSession.mockResolvedValue(adminCtx("support"));

    const res = await PATCH(request({
      approvalRequestId: "approval:req-1:review-open-shift-conflicts",
      decision: "denied",
      receiptFingerprint: "b".repeat(64),
    }, {}, "PATCH"));

    expect(res.status).toBe(403);
    expect(mockOrgTx).not.toHaveBeenCalled();
  });
});
