import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOrgQuery = vi.fn();
const mockBuildOrgDayRange = vi.fn();

vi.mock("@/lib/supabase-rest", () => ({
  orgQuery: (...args: unknown[]) => mockOrgQuery(...args),
}));

vi.mock("@/lib/reports/day-range", () => ({
  buildOrgDayRange: (...args: unknown[]) => mockBuildOrgDayRange(...args),
}));

const { getSalesByStorePeriod } = await import("@/lib/reports/admin-analytics");

describe("getSalesByStorePeriod", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildOrgDayRange.mockResolvedValue({
      fromTs: "2026-01-01T08:00:00.000Z",
      toTs: "2026-02-01T08:00:00.000Z",
    });
  });

  it("queries monthly sales grouped by store and maps numeric rows", async () => {
    mockOrgQuery.mockResolvedValueOnce({
      rows: [
        {
          location_id: "loc-1",
          location_name: "Redondo",
          period: "2026-01",
          revenue: "1234.56",
          transaction_count: "10",
          units_sold: "25",
          avg_ticket: "123.456",
          refund_count: "1",
          return_total: "12.34",
        },
      ],
    });

    const rows = await getSalesByStorePeriod({
      orgId: "org-1",
      from: "2026-01-01",
      to: "2026-01-31",
      groupBy: "month",
    });

    expect(mockBuildOrgDayRange).toHaveBeenCalledWith("org-1", "2026-01-01", "2026-01-31");
    expect(mockOrgQuery).toHaveBeenCalledTimes(1);
    const [orgId, sql, params] = mockOrgQuery.mock.calls[0];
    expect(orgId).toBe("org-1");
    expect(sql).toContain("DATE_TRUNC('month'");
    expect(sql).toContain("t.organization_id = $1");
    expect(sql).toContain("l.organization_id = $1");
    expect(sql).toContain("t.status = 'completed'");
    expect(sql).not.toContain("DATE_TRUNC('quarter'");
    expect(params).toEqual(["org-1", "2026-01-01T08:00:00.000Z", "2026-02-01T08:00:00.000Z"]);
    expect(rows).toEqual([
      {
        locationId: "loc-1",
        locationName: "Redondo",
        period: "2026-01",
        revenue: 1234.56,
        transactionCount: 10,
        unitsSold: 25,
        avgTicket: 123.456,
        refundCount: 1,
        returnTotal: 12.34,
      },
    ]);
  });

  it("adds a parameterized location filter when location IDs are provided", async () => {
    mockOrgQuery.mockResolvedValueOnce({ rows: [] });

    await getSalesByStorePeriod({
      orgId: "org-1",
      from: "2026-01-01",
      to: "2026-01-31",
      groupBy: "day",
      locationIds: ["loc-1", "loc-2"],
    });

    const [, sql, params] = mockOrgQuery.mock.calls[0];
    expect(sql).toContain("t.location_id = ANY($4::uuid[])");
    expect(sql).toContain("DATE_TRUNC('day'");
    expect(params).toEqual([
      "org-1",
      "2026-01-01T08:00:00.000Z",
      "2026-02-01T08:00:00.000Z",
      ["loc-1", "loc-2"],
    ]);
  });

  it("uses year buckets when requested", async () => {
    mockOrgQuery.mockResolvedValueOnce({ rows: [] });

    await getSalesByStorePeriod({
      orgId: "org-1",
      from: "2026-01-01",
      to: "2026-12-31",
      groupBy: "year",
    });

    const [, sql] = mockOrgQuery.mock.calls[0];
    expect(sql).toContain("DATE_TRUNC('year'");
    expect(sql).toContain("TO_CHAR");
    expect(sql).toContain("YYYY");
  });
});
