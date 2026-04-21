/**
 * R27 regression: cross-tenant exposure sweep.
 *
 * Background: R27's parallel audit found 12 CRITICAL cross-tenant
 * read/write endpoints plus 82 additional SQL sites that leaked data
 * across tenants because the `postgres` DB role has `BYPASSRLS=true`
 * — the `orgQuery()` / `SET LOCAL app.current_org_id` pattern is
 * cosmetic at the app's real connection layer.
 *
 * The remediation:
 *   1. Added explicit `WHERE organization_id = $N` predicates to every
 *      flagged SQL site (12 CRITICAL + 82 surfaced sites).
 *   2. Extended `check-pool-query-org-filter.mjs` to scan `orgQuery()`
 *      callsites in addition to raw `.query()` calls, dropped the
 *      narrow allowlist, and widened the scan to all src/app/api/**,
 *      src/app/admin/**, src/app/register/**, src/lib/persistence/**.
 *
 * This test pins the fix in three ways:
 *   (a) Reads a representative set of the previously-vulnerable SQL
 *       literals and asserts each contains `organization_id` OR joins
 *       through an org-scoped parent. Prevents "refactor-reverts".
 *   (b) Reads the extended guardrail source and asserts it scans
 *       `orgQuery(` patterns AND walks directory trees (not just an
 *       allowlist). Prevents "guardrail narrowing" regressions.
 *   (c) Reads `check-rls-force-matching.mjs` and asserts its header
 *       documents the BYPASSRLS reality — so a future developer who
 *       "simplifies" the guardrail can see why the WHERE clauses
 *       exist.
 *
 * A genuine integration-level proof (2 orgs, cross-tenant API calls
 * all returning 404/403) is out of scope here; this file is the
 * static-code gate that a refactor can't silently reverse.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("R27 cross-tenant regression: all previously-vulnerable SQL now gated", () => {
  // ─── (a) Representative CRITICAL endpoints ─────────────────────────

  describe("C1 /api/export — every type path includes organization_id", () => {
    const src = read("src/app/api/export/route.ts");

    it("transactions export filters by t.organization_id", () => {
      // Walk from the `case "transactions"` label to the first SELECT
      // inside it and assert the slice contains organization_id.
      const start = src.indexOf('case "transactions"');
      expect(start).toBeGreaterThan(-1);
      const window = src.slice(start, start + 2000);
      expect(window).toMatch(/t\.organization_id\s*=\s*\$/);
    });

    it("customers export filters by organization_id", () => {
      const start = src.indexOf('case "customers"');
      expect(start).toBeGreaterThan(-1);
      const window = src.slice(start, start + 2000);
      expect(window).toMatch(/organization_id\s*=\s*\$/);
    });

    it("gift-cards export filters by gc.organization_id", () => {
      const start = src.indexOf('case "gift-cards"');
      expect(start).toBeGreaterThan(-1);
      const window = src.slice(start, start + 1500);
      expect(window).toMatch(/gc\.organization_id\s*=\s*\$/);
    });
  });

  describe("C4 /api/dashboard — location belongs-to-org check + org filters", () => {
    const src = read("src/app/api/dashboard/route.ts");

    it("verifies requested locationId belongs to caller's org before any query", () => {
      // The location-scope gate prevents an owner at ORG A from supplying
      // ORG B's location UUID to read B's dashboard.
      expect(src).toMatch(
        /FROM\s+locations\s+WHERE\s+id\s*=\s*\$1\s+AND\s+organization_id\s*=\s*\$2/,
      );
    });

    it("metrics + tender + recent queries all filter by organization_id", () => {
      // Every major query should have the org predicate.
      const orgMatches = src.match(/organization_id\s*=\s*\$/g) ?? [];
      // Pre-R27 this file had 0 org predicates. Post-fix: ≥ 6.
      expect(orgMatches.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe("C8 /api/transactions detail — SELECT gated by org", () => {
    const src = read("src/app/api/transactions/route.ts");

    it("single-transaction SELECT by ID includes t.organization_id", () => {
      expect(src).toMatch(
        /WHERE\s+t\.id\s*=\s*\$1\s+AND\s+t\.organization_id\s*=\s*\$2/,
      );
    });
  });

  describe("C9 /api/transfers — POST ship/receive/cancel gated by org", () => {
    const src = read("src/app/api/transfers/route.ts");

    it("ship action FOR UPDATE includes organization_id", () => {
      // The 'requested' status gate used to be the only block; now org filters too.
      expect(src).toMatch(
        /FROM\s+transfers\s+WHERE\s+id\s*=\s*\$1\s+AND\s+organization_id\s*=\s*\$2\s+AND\s+status\s*=\s*'requested'/,
      );
    });
    it("receive action FOR UPDATE includes organization_id", () => {
      expect(src).toMatch(
        /FROM\s+transfers\s+WHERE\s+id\s*=\s*\$1\s+AND\s+organization_id\s*=\s*\$2\s+AND\s+status\s*=\s*'in_transit'/,
      );
    });
    it("cancel UPDATE includes organization_id", () => {
      // Owner bypass of the location-authority check used to make cross-
      // tenant cancellation possible. The org filter on the UPDATE blocks it.
      expect(src).toMatch(
        /UPDATE\s+transfers\s+SET\s+status\s*=\s*'cancelled'[\s\S]*?WHERE\s+id\s*=\s*\$2\s+AND\s+organization_id\s*=\s*\$3\s+AND\s+status\s*=\s*'requested'/,
      );
    });
  });

  describe("C10 /api/returns PUT — return SELECT gated by org", () => {
    const src = read("src/app/api/returns/route.ts");

    it("status UPDATE includes AND organization_id", () => {
      // Note: the SELECT is a FOR UPDATE; both read + write must be gated.
      expect(src).toMatch(
        /FROM\s+returns\s+WHERE\s+id\s*=\s*\$1\s+AND\s+organization_id\s*=\s*\$2\s+FOR\s+UPDATE/,
      );
      expect(src).toMatch(
        /UPDATE\s+returns\s+SET[\s\S]*?WHERE\s+id\s*=\s*\$3\s+AND\s+organization_id\s*=\s*\$4/,
      );
    });
  });

  describe("C12 /api/bundles — PATCH + DELETE gated by org", () => {
    const src = read("src/app/api/bundles/route.ts");

    it("PATCH UPDATE gates by organization_id", () => {
      // The UPDATE query uses `${sets.join(', ')}` + dynamic `$idx` — we
      // just assert the pattern `AND organization_id = $` is present inside
      // a product_bundles UPDATE.
      expect(src).toMatch(
        /UPDATE\s+product_bundles\s+SET\s+\$\{sets[\s\S]*?AND\s+organization_id\s*=/,
      );
    });

    it("DELETE gates by organization_id", () => {
      expect(src).toMatch(
        /DELETE\s+FROM\s+product_bundles\s+WHERE\s+id\s*=\s*\$1\s+AND\s+organization_id\s*=\s*\$2/,
      );
    });
  });

  // ─── (b) Guardrail coverage assertions ───────────────────────────

  describe("Guardrail check-pool-query-org-filter.mjs — R27 extension", () => {
    const src = read("scripts/check-pool-query-org-filter.mjs");

    it("scans orgQuery() callsites in addition to .query()", () => {
      // The R26 version only scanned `.query(`. The R27 extension adds
      // an `orgQuery(` pattern. If a future refactor drops this, cross-
      // tenant regressions in orgQuery-using routes will slip through.
      expect(src).toMatch(/orgQuery\\s\*\\\(/);
    });

    it("dropped the narrow allowlist in favor of directory traversal", () => {
      // R26 shipped a hardcoded SCAN_TARGETS array — which excluded the
      // 12 CRITICAL files found by R27. R27 replaced it with SCAN_DIRS
      // + walkTs() so the coverage can't be silently narrowed by adding
      // a new route outside the allowlist.
      expect(src).toMatch(/const\s+SCAN_DIRS\s*=/);
      expect(src).toMatch(/function\s+walkTs/);
    });

    it("header documents the BYPASSRLS reality", () => {
      expect(src).toMatch(/BYPASSRLS/);
      expect(src).toMatch(/cosmetic/i);
    });

    it("self-test asserts orgQuery extraction fires", () => {
      // The extraction regex for orgQuery is fragile (depends on
      // backtick-literal convention). A self-test that synthesizes an
      // orgQuery call proves the extractor still works on every CI run.
      expect(src).toMatch(/orgQuery extractor/);
    });
  });

  // ─── (c) Supporting RLS guardrail documents the reality ──────────

  describe("check-rls-force-matching.mjs — header documents BYPASSRLS", () => {
    it("explains why FORCE RLS is cosmetic for the app's postgres role", () => {
      const src = read("scripts/check-rls-force-matching.mjs");
      // Without this documentation, a future developer would see FORCE
      // RLS on every table and assume tenant isolation is DB-enforced.
      expect(src).toMatch(/BYPASSRLS/);
    });
  });
});
