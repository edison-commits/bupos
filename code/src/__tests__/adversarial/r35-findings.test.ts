/**
 * R35 regression tests — pin the performance optimizations landed
 * this round. The failure modes here are correctness regressions
 * (accidental re-introduction of the old pre-tx handshake burst,
 * etc.) and perf regressions (someone reverts memoization, etc.).
 *
 * Each test asserts on source text rather than runtime behavior;
 * the adversarial suite already covers correctness.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R35 perf findings", () => {
  describe("R35-P1: checkout pre-tx handshakes consolidated", () => {
    const src = read("src/app/register/checkout-action.ts");
    it("no longer imports getPool (pre-tx pool opens removed)", () => {
      expect(src).not.toMatch(/import\s*\{[^}]*getPool[^}]*\}\s*from\s*["']@\/lib\/supabase-rest["']/);
    });
    it("uses readRegisterConfigWith inside the tx client", () => {
      expect(src).toMatch(/readRegisterConfigWith\(client,\s*context\.employee\.organizationId\)/);
    });
    it("customer tax_exempt query runs on the tx client", () => {
      // The pre-tx pool version called `pool.query(...)` before orgTx;
      // the consolidated version calls `client.query(...)` with the
      // same SELECT inside the tx's Promise.all.
      expect(src).toMatch(/client\.query\([\s\S]*?SELECT tax_exempt FROM customers/);
    });
    it("modifier prices re-fetch runs on the tx client", () => {
      expect(src).toMatch(/client\.query\([\s\S]*?SELECT id, price FROM modifiers/);
    });
    it("Promise.all wraps register_sessions FOR UPDATE + reg config + reads", () => {
      expect(src).toMatch(/Promise\.all\(\[[\s\S]*?readRegisterConfigWith[\s\S]*?register_sessions[\s\S]*?FOR UPDATE/);
    });
  });

  describe("R35-P2: return-action pre-tx reads consolidated", () => {
    const src = read("src/app/register/return-action.ts");
    it("no longer imports getPool", () => {
      expect(src).not.toMatch(/import\s*\{[^}]*getPool[^}]*\}\s*from\s*["']@\/lib\/supabase-rest["']/);
    });
    it("advisory lock acquired BEFORE the Promise.all reads", () => {
      const lockIdx = src.indexOf("pg_advisory_xact_lock");
      const promiseAllIdx = src.indexOf("Promise.all");
      expect(lockIdx).toBeGreaterThan(0);
      expect(promiseAllIdx).toBeGreaterThan(lockIdx);
    });
    it("uses readRegisterConfigWith on the tx client", () => {
      expect(src).toMatch(/readRegisterConfigWith\(client,\s*context\.employee\.organizationId\)/);
    });
    it("cash-refund cap reads share the same tx client", () => {
      expect(src).toMatch(/client\.query\([\s\S]*?COALESCE\(SUM\(tt\.amount\)/);
      expect(src).toMatch(/client\.query\([\s\S]*?COALESCE\(SUM\(ABS\(tt\.amount\)\)/);
    });
    it("redundant post-lock re-check was removed", () => {
      // Old code re-queried priorAfterLock* inside the tx AFTER the
      // pool-based pre-reads. With the consolidated flow the single
      // read happens after the lock and is authoritative.
      expect(src).not.toMatch(/priorAfterLockTxn|priorAfterLockTable/);
    });
  });

  describe("R35-P3: hot-path dynamic imports hoisted to static", () => {
    it("step-up.ts statically imports checkKvRateLimit + pgInsertAuditEvent", () => {
      const src = read("src/lib/auth/step-up.ts");
      expect(src).toMatch(/^import\s*\{\s*checkKvRateLimit\s*\}\s*from\s*['"]@\/lib\/auth\/kv-rate-limit['"]/m);
      expect(src).toMatch(/^import\s*\{\s*pgInsertAuditEvent\s*\}\s*from\s*['"]@\/lib\/persistence\/postgres-store['"]/m);
      // And no leftover dynamic imports of the same.
      expect(src).not.toMatch(/await\s+import\(['"]@\/lib\/auth\/kv-rate-limit['"]\)/);
      expect(src).not.toMatch(/await\s+import\(['"]@\/lib\/persistence\/postgres-store['"]\)/);
    });
    it("session.ts statically imports getPool + device-cookie helpers", () => {
      const src = read("src/lib/auth/session.ts");
      expect(src).toMatch(/^import\s*\{\s*getPool\s*\}\s*from\s*['"]@\/lib\/supabase-rest['"]/m);
      expect(src).toMatch(/verifyDeviceIdCookie,\s*signDeviceId/);
      expect(src).toMatch(/pgFindCredentialByEmail,\s*pgFindCredentialByPin/);
      expect(src).toMatch(/invalidateStoreCache/);
      // No leftover dynamic imports for these hot-path helpers
      expect(src).not.toMatch(/await\s+import\(['"]@\/lib\/auth\/device-cookie['"]\)/);
      expect(src).not.toMatch(/await\s+import\(['"]@\/lib\/persistence\/postgres-read-store['"]\)/);
    });
  });

  describe("R35-P4: composite transaction index migration", () => {
    const mig = read("supabase/migrations/066_r35_perf_transaction_index.sql");
    it("creates idx_transactions_org_loc_created_completed partial index", () => {
      expect(mig).toMatch(/idx_transactions_org_loc_created_completed/);
      expect(mig).toMatch(/ON transactions \(organization_id, location_id, created_at DESC\)/);
      expect(mig).toMatch(/WHERE status = 'completed'/);
    });
    it("is idempotent (IF NOT EXISTS)", () => {
      expect(mig).toMatch(/CREATE INDEX IF NOT EXISTS/);
    });
    it("deploy runbook mentions the CONCURRENTLY path for large tables", () => {
      const rb = read("docs/runbook-deploy.md");
      expect(rb).toMatch(/Large-table index creation/);
      expect(rb).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_org_loc_created_completed/);
    });
  });

  describe("R35-P5: TenderPanel useMemo", () => {
    const src = read("src/components/register/tender-panel.tsx");
    it("memoizes tipAmount + grandTotal", () => {
      expect(src).toMatch(/const tipAmount = useMemo\(/);
      expect(src).toMatch(/const grandTotal = useMemo\(/);
    });
    it("memoizes quickCashAmounts + nonSplitTenders", () => {
      expect(src).toMatch(/const quickCashAmounts = useMemo\(/);
      expect(src).toMatch(/const nonSplitTenders = useMemo\(/);
    });
    it("no longer inlines `supportedTenders.filter((t) => t !== \"split\")` in JSX", () => {
      // Raw filter inline was duplicated at two sites; both should now
      // reference the memoized list.
      expect(src).not.toMatch(/\{supportedTenders\.filter\(\(t\) => t !== "split"\)\.map/);
    });
  });

  describe("R35-P6: admin perf (inventory debounced, barcode filter memoized)", () => {
    it("inventory-browser still debounces search", () => {
      const src = read("src/components/admin/inventory-browser.tsx");
      expect(src).toMatch(/debouncedSearch/);
    });
    it("customer-database still debounces search", () => {
      const src = read("src/components/admin/customer-database.tsx");
      expect(src).toMatch(/debouncedSearch/);
    });
    it("barcode-label-printer precomputes productsById map + memoizes filter", () => {
      const src = read("src/components/admin/barcode-label-printer.tsx");
      expect(src).toMatch(/const productsById = useMemo\(/);
      expect(src).toMatch(/const filteredVariants = useMemo\(/);
      // The old shape called `.find` inside the filter — O(n²).
      expect(src).not.toMatch(/products\.find\(\(p\) => p\.id === v\.productId\)/);
    });
  });

  describe("R35-P7: theme FOUC fix via inline head script", () => {
    it("layout.tsx injects a pre-paint theme script with nonce", () => {
      const src = read("src/app/layout.tsx");
      expect(src).toMatch(/<head>/);
      expect(src).toMatch(/pos-theme/);
      expect(src).toMatch(/classList\.add\('dark'\)/);
      expect(src).toMatch(/data-theme'[,]?'high-contrast/);
      // Script tag receives nonce (CSP compliant)
      expect(src).toMatch(/nonce=\{nonce\}[\s\S]*?pos-theme/);
    });
    it("theme-toggle reads the DOM rather than re-applying on mount", () => {
      const src = read("src/components/register/theme-toggle.tsx");
      expect(src).toMatch(/root\.classList\.contains\('dark'\)/);
      // The old shape always called applyTheme(initial) on mount.
      expect(src).not.toMatch(/applyTheme\(initial\)/);
    });
    it("register-console-client no longer removes .dark on unmount", () => {
      const src = read("src/components/register/register-console-client.tsx");
      // Prior shape had a cleanup that dropped the class, causing a
      // flash when navigating away and back.
      const lastThemeBlock = src.slice(src.indexOf("Theme for register"));
      // The useEffect's return cleanup should NOT contain
      // `classList.remove('dark')`. Allow the migration branch to still
      // set the class when legacy data migrates.
      const cleanupIdx = lastThemeBlock.indexOf("return () =>");
      expect(cleanupIdx).toBe(-1);
    });
  });
});
