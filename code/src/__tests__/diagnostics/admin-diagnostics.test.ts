import { describe, expect, it, vi } from "vitest";
import {
  buildSupportPacket,
  runAdminDiagnostics,
  summarizeDiagnostics,
  type DiagnosticsContext,
} from "@/lib/diagnostics/admin-diagnostics";

function ctx(overrides: Partial<DiagnosticsContext> = {}): DiagnosticsContext {
  return {
    orgId: "org-1",
    locationId: "loc-1",
    allowedLocations: ["loc-1"],
    employee: { id: "emp-1", roleKey: "support", locationIds: ["loc-1"] },
    reqId: "req-1",
    ...overrides,
  };
}

describe("admin diagnostics", () => {
  it("returns a read-only store health summary scoped to the active org and location", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT 1 AS ok")) return { rows: [{ ok: 1 }] };
      if (sql.includes("conflict_count") && sql.includes("FROM shifts")) {
        expect(values).toEqual(["org-1", ["loc-1"]]);
        return { rows: [{ conflict_count: 2 }] };
      }
      if (sql.includes("open_shift_evidence")) {
        expect(values).toEqual(["org-1", ["loc-1"]]);
        return {
          rows: [
            {
              id: "shift-1",
              employee_id: "emp-1",
              location_id: "loc-1",
              register_session_id: "reg-1",
              opened_at: "2026-07-17T01:00:00.000Z",
              duplicate_count: 2,
              age_hours: 14.5,
              reason: "duplicate_open_shift",
            },
            {
              id: "shift-2",
              employee_id: "emp-2",
              location_id: "loc-1",
              register_session_id: null,
              opened_at: "2026-07-16T22:00:00.000Z",
              duplicate_count: 1,
              age_hours: 17.5,
              reason: "stale_open_shift",
            },
          ],
        };
      }
      if (sql.includes("FROM inventory_levels")) {
        expect(values).toEqual(["org-1", ["loc-1"]]);
        return { rows: [{ negative_count: 1, low_stock_count: 4 }] };
      }
      if (sql.includes("FROM transactions")) {
        expect(values).toEqual(["org-1", ["loc-1"]]);
        return { rows: [{ void_count: 1, refund_count: 3 }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await runAdminDiagnostics(ctx(), query);

    expect(result.status).toBe("warning");
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["database-connectivity", "ok"],
      ["open-shift-conflicts", "warning"],
      ["inventory-risk", "warning"],
      ["recent-transaction-exceptions", "warning"],
    ]);
    expect(result.checks[1].recommendedAction).toBe("Review the shift evidence cards, then create a manager approval request before any close/repair action.");
    expect(result.checks[1].details).toMatchObject({
      conflictCount: 2,
      staleOpenShiftCount: 1,
      shiftConflictCards: [
        {
          shiftId: "shift-1",
          employeeId: "emp-1",
          locationId: "loc-1",
          registerSessionId: "reg-1",
          openedAt: "2026-07-17T01:00:00.000Z",
          ageHours: 14.5,
          duplicateOpenShiftCount: 2,
          reason: "duplicate_open_shift",
        },
        {
          shiftId: "shift-2",
          employeeId: "emp-2",
          locationId: "loc-1",
          registerSessionId: null,
          openedAt: "2026-07-16T22:00:00.000Z",
          ageHours: 17.5,
          duplicateOpenShiftCount: 1,
          reason: "stale_open_shift",
        },
      ],
    });
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("keeps diagnostic failures contained to the individual check", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT 1 AS ok")) return { rows: [{ ok: 1 }] };
      if (sql.includes("FROM shifts")) throw new Error("relation does not exist: shifts");
      return { rows: [{}] };
    });

    const result = await runAdminDiagnostics(ctx(), query);

    expect(result.status).toBe("warning");
    expect(result.checks.find((check) => check.id === "open-shift-conflicts")).toMatchObject({
      status: "warning",
      summary: "Open-shift conflict check could not complete.",
    });
    expect(JSON.stringify(result)).not.toContain("relation does not exist");
  });

  it("fails closed for location-scoped roles with no assigned locations", async () => {
    const scopedValues: unknown[][] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT 1 AS ok")) return { rows: [{ ok: 1 }] };
      scopedValues.push(values ?? []);
      return { rows: [{}] };
    });

    await runAdminDiagnostics(
      ctx({
        locationId: undefined,
        allowedLocations: [],
        employee: { id: "emp-1", roleKey: "support", locationIds: [] },
      }),
      query,
    );

    expect(query).toHaveBeenCalledTimes(5);
    expect(scopedValues).toEqual([
      ["org-1", []],
      ["org-1", []],
      ["org-1", []],
      ["org-1", []],
    ]);
  });

  it("builds a sanitized support packet without secrets, local paths, or raw SQL", async () => {
    const diagnostics = {
      status: "warning" as const,
      checkedAt: "2026-07-16T12:00:00.000Z",
      reqId: "req-1",
      orgId: "org-1",
      locationId: "loc-1",
      roleKey: "manager",
      checks: [
        {
          id: "database-connectivity",
          label: "Database connectivity",
          category: "database" as const,
          status: "ok" as const,
          summary: "Database is reachable.",
          details: { connected: true, localPath: "/" + "Users/edison/.hermes", token: "sk" + "-test-secret", shiftConflictCards: [{ shiftId: "shift-1", openedAt: "2026-07-17T01:00:00.000Z", debugPath: "file:///" + "Users/edison/private" }] },
        },
        {
          id: "inventory-risk",
          label: "Inventory risk",
          category: "inventory" as const,
          status: "warning" as const,
          summary: "1 negative-stock row; 4 low-stock rows.",
          recommendedAction: "Open inventory review before changing quantities.",
        },
      ],
    };

    const packet = buildSupportPacket(diagnostics);
    const text = JSON.stringify(packet);

    expect(packet.kind).toBe("bupos-admin-support-packet");
    expect(packet.operatorSummary).toMatchObject({
      status: "warning",
      requestId: "req-1",
      checkedAt: "2026-07-16T12:00:00.000Z",
      criticalCount: 0,
      warningCount: 1,
      okCount: 1,
      safeNextSteps: ["Open inventory review before changing quantities."],
    });
    expect(packet.operatorSummary.headline).toBe("Store health needs manager review.");
    expect(packet.operatorSummary.safetyNote).toContain("No fix action was performed");
    expect(packet.diagnostics.checks[0].details).toEqual({
      connected: true,
      localPath: "[redacted]",
      token: "[redacted]",
      shiftConflictCards: [{ shiftId: "shift-1", openedAt: "2026-07-17T01:00:00.000Z", debugPath: "[redacted]" }],
    });
    expect(text).not.toContain("/" + "Users/");
    expect(text).not.toContain("sk" + "-test-secret");
  });

  it("summarizes the worst status without treating warnings as critical", () => {
    expect(summarizeDiagnostics([{ status: "ok" }, { status: "warning" }])).toBe("warning");
    expect(summarizeDiagnostics([{ status: "ok" }, { status: "critical" }])).toBe("critical");
    expect(summarizeDiagnostics([{ status: "ok" }])).toBe("ok");
  });
});
