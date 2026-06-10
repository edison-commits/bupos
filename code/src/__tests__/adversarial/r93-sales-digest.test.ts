/**
 * R93 — sales digest (P3.2) security/correctness invariants.
 * The digest sender is a cross-org Bearer endpoint (the third of its kind,
 * after run-cleanup and reconcile-channels) — these asserts keep it on the
 * same rails: fail-closed secret, constant-time compare, SECDEF RPC for the
 * cross-org list, server-managed bookkeeping fields not client-writable.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestConfigSchema } from "@/lib/validation/schemas";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R93: internal sender is Bearer-gated, fail-closed, constant-time", () => {
  const src = read("src/app/api/internal/send-sales-digest/route.ts");
  it("fails closed when SALES_DIGEST_SECRET is unset/short and compares constant-time", () => {
    expect(src).toMatch(/secret\.length < 32/);
    expect(src).toMatch(/function bearerMatches/);
    expect(src).toMatch(/diff \|= a\[i\] \^ b\[i\]/);
  });
  it("lists tenants via the SECDEF RPC and does per-org work via orgQuery", () => {
    expect(src).toMatch(/FROM list_digest_orgs\(\)/);
    expect(src).toMatch(/orgQuery\(/);
  });
  it("is idempotent per window (lastDailySentOn / lastWeeklySentOn markers)", () => {
    expect(src).toMatch(/lastDailySentOn/);
    expect(src).toMatch(/lastWeeklySentOn/);
  });
});

describe("R93: admin config route is permission-gated and validated", () => {
  const src = read("src/app/api/sales-digest/route.ts");
  it("gates on reports.export and validates with digestConfigSchema", () => {
    expect(src).toMatch(/withAdminAuth\("reports\.export"/);
    expect(src).toMatch(/validateBody\(digestConfigSchema/);
  });
  it("rate-limits the test send", () => {
    expect(src).toMatch(/checkRateLimit\(`digest-test/);
  });
});

describe("R93: digestConfigSchema keeps server bookkeeping out of client hands", () => {
  const valid = { dailyEnabled: true, weeklyEnabled: false, recipients: ["a@b.com"], sendHour: 8 };
  it("accepts a well-formed config", () => {
    expect(digestConfigSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects client-supplied lastDailySentOn / lastWeeklySentOn (strict)", () => {
    expect(digestConfigSchema.safeParse({ ...valid, lastDailySentOn: "2026-01-01" }).success).toBe(false);
    expect(digestConfigSchema.safeParse({ ...valid, lastWeeklySentOn: "2026-01-01" }).success).toBe(false);
  });
  it("bounds recipients (≤5 valid emails) and sendHour (0–23)", () => {
    expect(digestConfigSchema.safeParse({ ...valid, recipients: ["not-an-email"] }).success).toBe(false);
    expect(digestConfigSchema.safeParse({ ...valid, recipients: Array(6).fill("a@b.com") }).success).toBe(false);
    expect(digestConfigSchema.safeParse({ ...valid, sendHour: 24 }).success).toBe(false);
  });
});

describe("R93: migration 090 ships the column + locked-down RPC", () => {
  const src = read("supabase/migrations/090_sales_digest.sql");
  it("adds digest_config and the service_role-only list RPC", () => {
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS digest_config jsonb NOT NULL/);
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION public\.list_digest_orgs/);
    expect(src).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path = public/);
    expect(src).toMatch(/REVOKE EXECUTE ON FUNCTION public\.list_digest_orgs\(\) FROM PUBLIC, anon, authenticated/);
    expect(src).toMatch(/GRANT {2}EXECUTE ON FUNCTION public\.list_digest_orgs\(\) TO service_role/);
  });
});

describe("R93: the hourly cron exists and is dormant-safe", () => {
  const wf = fs.readFileSync(path.resolve(REPO, "..", ".github", "workflows", "sales-digest.yml"), "utf8");
  it("fires hourly, posts with the Bearer secret, and skips cleanly when unconfigured", () => {
    expect(wf).toMatch(/cron: "7 \* \* \* \*"/);
    expect(wf).toMatch(/send-sales-digest/);
    expect(wf).toMatch(/if: env\.DIGEST_SECRET != ''/);
    expect(wf).toMatch(/if: env\.DIGEST_SECRET == ''/);
  });
});
