/**
 * R83 regression tests. Pins audit round 27 — 4 HIGH + 3 MED +
 * long-tail LOW deferred.
 *
 * HIGH
 *   DB-H1: register/return-action PG path now emits
 *     `event_kind='transaction_placeholder'` with `is_return: "true"`
 *     in the payload (matches JSON fallback shape). Prior shape
 *     used `event_kind='return_processed'` with no is_return flag —
 *     7+ client-side admin widgets (dashboard-kpis, sales-reports,
 *     tax-report, daily-manager-report) filter on
 *     `eventKind === 'transaction_placeholder' && is_return === 'true'`
 *     and missed every register refund.
 *   DB-H2: /api/shift-report splits completed into sales (positive
 *     grand_total) + refunded (negative), parity with R82-DB-H2/H3
 *     on dashboard + eod-report. Prior status='refunded' filter
 *     caught ZERO register returns.
 *   SEC-H1: /api/returns PUT (admin return-approval path) now
 *     reverses customers.total_spend + visit_count on full refund.
 *     Third twin of the R82-DB-H1 pattern — register/return-action
 *     + returns/process were fixed, this PUT path was missed.
 *   SEC-H2: /api/dashboard uses buildOrgDayRange for org-TZ-aware
 *     day bounds + EXCLUSIVE upper bound (< instead of <=). Prior
 *     shape bucketed on UTC midnight — Pacific-TZ stores saw
 *     "today" cut off at 4pm local.
 *
 * MEDIUM
 *   MED-hourly: /api/reports + /api/dashboard + /api/shift-report
 *     hourly breakdown now buckets in ORG TIMEZONE (EXTRACT AT TIME
 *     ZONE org_tz, or Intl.DateTimeFormat in the JS path). Prior
 *     `AT TIME ZONE 'UTC'` literal + server-local `getHours()` bucketed
 *     9pm PDT as hour=4 (next-day UTC).
 *   MED-export: /api/export transactions now uses buildOrgDayRange
 *     for day bounds (parity with dashboard + reports).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R83 audit fixes — round 27", () => {
  describe("R83-DB-H1 HIGH: register return-action event shape", () => {
    const src = read("src/app/register/return-action.ts");
    it("uses event_kind='transaction_placeholder' instead of 'return_processed'", () => {
      expect(src).toMatch(/INSERT INTO transaction_events[\s\S]{0,200}VALUES \(\$1, \$2, \$3, 'transaction_placeholder'/);
    });
    it("payload carries is_return='true'", () => {
      expect(src).toMatch(/INSERT INTO transaction_events[\s\S]{0,1500}is_return: "true"/);
    });
  });

  describe("R83-DB-H2 HIGH: /api/shift-report sign-based refund filter", () => {
    const src = read("src/app/api/shift-report/route.ts");
    it("splits completedAll into sales (>=0) and refunded (<0)", () => {
      expect(src).toMatch(/completedAll = txns\.rows\.filter[\s\S]{0,200}Number\(t\.grand_total\) >= 0/);
      expect(src).toMatch(/refunded = completedAll\.filter[\s\S]{0,100}Number\(t\.grand_total\) < 0/);
    });
  });

  describe("R83-SEC-H1 HIGH: /api/returns PUT reverses total_spend + visit_count", () => {
    const src = read("src/app/api/returns/route.ts");
    it("PUT has wasPriorFullyRefunded + isNowFullyRefunded + visitCountDelta", () => {
      expect(src).toMatch(/wasPriorFullyRefunded[\s\S]{0,200}isNowFullyRefunded[\s\S]{0,200}visitCountDelta/);
    });
    it("UPDATE sets total_spend + visit_count decrements", () => {
      expect(src).toMatch(/SET total_spend = GREATEST\(0, total_spend - \$1\)[\s\S]{0,200}visit_count = GREATEST\(0, visit_count - \$2\)/);
    });
  });

  describe("R83-SEC-H2 HIGH: /api/dashboard buildOrgDayRange", () => {
    const src = read("src/app/api/dashboard/route.ts");
    it("imports + calls buildOrgDayRange", () => {
      expect(src).toMatch(/const \{ buildOrgDayRange \} = await import\("@\/lib\/reports\/day-range"\);/);
      expect(src).toMatch(/await buildOrgDayRange\(orgId, fromDay, toDay\)/);
    });
    it("uses EXCLUSIVE upper bound (created_at < $4, not <=)", () => {
      expect(src).not.toMatch(/created_at <= \$4/);
      expect(src).toMatch(/created_at < \$4/);
    });
  });

  describe("R83-MED: hourly breakdown uses ORG TIMEZONE", () => {
    it("/api/reports uses AT TIME ZONE (SELECT timezone FROM organizations)", () => {
      const src = read("src/app/api/reports/route.ts");
      expect(src).toMatch(/EXTRACT\(HOUR FROM created_at AT TIME ZONE COALESCE\(\(SELECT timezone FROM organizations WHERE id = \$1\)/);
    });
    it("/api/dashboard hourly uses AT TIME ZONE org timezone", () => {
      const src = read("src/app/api/dashboard/route.ts");
      expect(src).toMatch(/EXTRACT\(HOUR FROM created_at AT TIME ZONE COALESCE\(\(SELECT timezone FROM organizations/);
    });
    it("/api/shift-report uses Intl.DateTimeFormat with org timezone", () => {
      const src = read("src/app/api/shift-report/route.ts");
      expect(src).toMatch(/new Intl\.DateTimeFormat\('en-US', \{\s*timeZone: orgTz/);
    });
  });

  describe("R83-MED-export: /api/export transactions uses buildOrgDayRange", () => {
    const src = read("src/app/api/export/route.ts");
    it("calls buildOrgDayRange for transactions day bounds", () => {
      expect(src).toMatch(/buildOrgDayRange\(orgId, from, to\)/);
    });
  });
});
