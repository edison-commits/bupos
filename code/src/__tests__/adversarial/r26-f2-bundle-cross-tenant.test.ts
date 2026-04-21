/**
 * R26-F2 regression: `readStoreFromPg` must scope bundle + bundle_items
 * reads to the caller's organization.
 *
 * Background: the R25-perf-6 consolidation replaced three separate
 * `orgQuery` calls (which at least SET `app.current_org_id` via RLS)
 * with two `client.query` calls:
 *
 *   SELECT ... FROM product_bundles ORDER BY created_at DESC;
 *   SELECT bi.* FROM bundle_items bi ORDER BY bi.created_at ASC;
 *
 * Neither included an `organization_id` filter. In theory, RLS + FORCE
 * RLS would have caught this — but the `postgres` role has BYPASSRLS
 * (verified via `pg_roles.rolbypassrls = true`), so the filter is
 * purely cosmetic for the app's real connection. Result: every tenant's
 * `getFullStore` response carried EVERY org's bundle list.
 *
 * This test pins the fix by:
 *   1. Reading the `readStoreFromPg` source and asserting both bundle
 *      queries reference `organization_id` somewhere in their SQL.
 *   2. Asserting the bundle_items query JOINs through `product_bundles`
 *      (the correct shape, since bundle_items has no direct org FK).
 *
 * A future "refactor" that removes the filter would fail this test.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ_STORE_PATH = path.resolve(
  HERE,
  "..",
  "..",
  "lib",
  "persistence",
  "postgres-read-store.ts",
);

describe("R26-F2 regression: bundle reads are org-scoped", () => {
  const src = fs.readFileSync(READ_STORE_PATH, "utf8");

  it("product_bundles SELECT includes organization_id filter", () => {
    // Find the readStoreFromPg function body. We look for the first
    // "product_bundles" SELECT and assert the enclosing SQL literal
    // mentions organization_id.
    //
    // Heuristic: grab a ~600-char window around the first match and
    // check it contains both "product_bundles" and "organization_id".
    const idx = src.indexOf("FROM product_bundles");
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, idx - 200), idx + 400);
    expect(window).toContain("organization_id");
    // Belt-and-suspenders: confirm it's a parameterized `= $1` form
    // (not e.g. a hardcoded UUID, which would be a different bug).
    expect(window).toMatch(/organization_id\s*=\s*\$\d/);
  });

  it("bundle_items SELECT joins through product_bundles AND filters by org", () => {
    const idx = src.indexOf("FROM bundle_items");
    expect(idx).toBeGreaterThan(-1);
    // Widen the window — the JOIN may sit several lines below the
    // FROM clause.
    const window = src.slice(idx, idx + 500);
    expect(window).toMatch(/JOIN\s+product_bundles/i);
    expect(window).toMatch(/organization_id\s*=\s*\$\d/);
  });

  it("guardrail script names R26-F1/F2 in its header comment", () => {
    // Meta-check: the companion guardrail that catches this class of
    // bug should reference the finding IDs so future readers can trace
    // motivation. If someone deletes the reference, the test reminds
    // them the guardrail's purpose is specifically this class of leak.
    const GUARDRAIL_PATH = path.resolve(
      HERE,
      "..",
      "..",
      "..",
      "scripts",
      "check-pool-query-org-filter.mjs",
    );
    const guardrailSrc = fs.readFileSync(GUARDRAIL_PATH, "utf8");
    expect(guardrailSrc).toMatch(/R26-F[12]/);
    expect(guardrailSrc).toMatch(/BYPASSRLS/);
  });
});
