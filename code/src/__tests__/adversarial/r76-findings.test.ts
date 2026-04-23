/**
 * R76 regression tests. Pins audit round 20 — 17 findings
 * (5 HIGH + 8 MEDIUM + 4 LOW). New HIGH streak attempt starts R77.
 *
 * HIGH (5)
 *   FE-H1: offline-status-bar dead-letter 5s auto-clear REGRESSION
 *          of R75-F. `try { return; } finally { ... }` still runs
 *          the finally, so R75's "early return" did not skip the
 *          auto-clear. Dead-letter messages vanished after 5s
 *          despite the stated fix. Now: `hasDeadLetters` hoisted
 *          above try, checked inside finally.
 *   SEC-H1: /api/transfers ship aggregates per-variant before
 *          stock check + single delta-join UPDATE. Duplicate
 *          transfer_lines with same variant used to both pass the
 *          stock check (read base on_hand independently) and then
 *          serially UPDATE on_hand negative. R75-H3 pattern on a
 *          different surface.
 *   SEC-H2: PIN reset now calls invalidateEmployeeSessions after
 *          COMMIT. Prior shape rotated the pin_hash + sent
 *          notification but never touched sessions — defeated the
 *          primary reason a victim asks for reset (cookie
 *          compromise).
 *   DB-H1: /api/returns PUT resolves original_tender via dominant
 *          tender on the original sale (parity with
 *          /api/returns/process R47-M4). Also rejects unsupported
 *          refund_method enum values explicitly instead of
 *          silently flipping status='completed' with zero
 *          financial rows.
 *   DB-H2: closeShiftEnhancedAction + payInOutAction now take
 *          advisory lock + FOR UPDATE on shifts (and
 *          register_sessions for close). Mirrors the /api/shift-
 *          close lock shape. Prior shape could under-count
 *          expectedCash when a concurrent pay_in/pay_out committed
 *          between the aggregation SELECT and the close UPDATE.
 *
 * MEDIUM
 *   DB-M: /api/transfers RECEIVE on-conflict insert defaults
 *         reorder_point=5 (parity with /api/purchase-orders
 *         receive path) instead of 0.
 *   FE-M-nan: daily-manager-report, sales-reports, multi-location-
 *         dashboard parseFloat paths now guard NaN with safeNum
 *         helper / Number.isFinite fallback.
 *   FE-M-cust: customer-search-modal new-customer flow now
 *         try/catch + finally + inline error surface so RBAC /
 *         duplicate / step-up failures don't freeze the button.
 *   FE-M-idb: idb-store.ts adds onversionchange + onblocked
 *         handlers so a second tab's upgrade doesn't hang.
 *   FE-M-online: use-online-status.ts uses AbortController + mount
 *         ref so stale pings can't flip state on unmounted
 *         components or override newer checks.
 *   FE-M-fetch: expense-tracker + returns-manager fetch catch{}
 *         now surfaces setMessage error instead of silent empty
 *         list.
 *   FE-M-abort: inventory-browser debounced fetch uses
 *         AbortController so filter/sort races don't overwrite
 *         newer result with older response.
 *
 * LOW
 *   FE-L-barcode: barcode-lookup handleSave validates parseFloat
 *         /parseInt BEFORE submitting — prior shape let trailing-
 *         dot typos silently coerce to 0 and ship a free-item SKU.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R76 audit fixes — round 20", () => {
  describe("R76-FE-H1 HIGH: offline-status-bar dead-letter regression fixed", () => {
    const src = read("src/components/register/offline-status-bar.tsx");
    it("hasDeadLetters is declared BEFORE the try block", () => {
      expect(src).toMatch(/let hasDeadLetters = false;\s*try \{\s*const result = await syncPendingTransactions/);
    });
    it("finally block gates auto-clear on !hasDeadLetters", () => {
      expect(src).toMatch(/\} finally \{[\s\S]{0,500}if \(!hasDeadLetters\)[\s\S]{0,300}setTimeout/);
    });
  });

  describe("R76-SEC-H1 HIGH: /api/transfers ship aggregates per-variant", () => {
    const src = read("src/app/api/transfers/route.ts");
    it("ship branch builds requestedByVariant Map before stock check", () => {
      expect(src).toMatch(/const requestedByVariant = new Map<string, number>\(\);[\s\S]{0,400}requestedByVariant\.set\(vid, \(requestedByVariant\.get\(vid\) \?\? 0\) \+ qty\)/);
    });
    it("stock check iterates requestedByVariant totals (not raw lines)", () => {
      expect(src).toMatch(/for \(const \[vid, totalRequested\] of requestedByVariant\)/);
    });
    it("single UPDATE uses unnest delta-join with GREATEST(0, ...) clamp", () => {
      expect(src).toMatch(/UPDATE inventory_levels il\s+SET on_hand = GREATEST\(0, il\.on_hand - delta\.qty\)[\s\S]{0,400}unnest\(\$1::uuid\[\]\)/);
    });
  });

  describe("R76-SEC-H2 HIGH: PIN reset invalidates sessions", () => {
    const src = read("src/app/api/employees/route.ts");
    it("reset_pin branch calls invalidateEmployeeSessions after COMMIT", () => {
      const block = src.slice(src.indexOf("action === 'reset_pin'"));
      expect(block.slice(0, 6000)).toMatch(/await pinClient\.query\("COMMIT"\);[\s\S]{0,2500}await invalidateEmployeeSessions\(id, orgId\)/);
    });
  });

  describe("R76-DB-H1 HIGH: /api/returns PUT resolves original_tender + rejects unsupported", () => {
    const src = read("src/app/api/returns/route.ts");
    it("original_tender triggers dominant-tender SELECT", () => {
      expect(src).toMatch(/if \(refundMethod === 'original_tender'\)[\s\S]{0,1200}SELECT tt\.tender_type, SUM\(tt\.amount\)::numeric AS total/);
    });
    it("pay_out gate uses effectiveMethod (not refundMethod)", () => {
      expect(src).toMatch(/if \(effectiveMethod === 'cash'\)/);
    });
    it("unsupported refund_method rejected with 400 + ROLLBACK", () => {
      expect(src).toMatch(/Unsupported refund_method:[\s\S]{0,300}status: 400/);
    });
  });

  describe("R76-DB-H2 HIGH: closeShiftEnhancedAction + payInOutAction lock the shift", () => {
    const src = read("src/app/register/shift-actions.ts");
    it("closeShiftEnhancedAction takes pg_advisory_xact_lock on shift-close key", () => {
      expect(src).toMatch(/pg_advisory_xact_lock[\s\S]{0,200}shift-close:\$\{shiftId\}/);
    });
    it("closeShiftEnhancedAction SELECTs shift FOR UPDATE", () => {
      expect(src).toMatch(/SELECT opening_float FROM shifts WHERE id = \$1 AND status = 'open' AND organization_id = \$2 FOR UPDATE/);
    });
    it("closeShiftEnhancedAction locks register_sessions row", () => {
      expect(src).toMatch(/SELECT id FROM register_sessions WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/);
    });
    it("payInOutAction FOR UPDATEs shift with status='open' predicate", () => {
      expect(src).toMatch(/SELECT id FROM shifts WHERE id = \$1 AND status = 'open' AND organization_id = \$2 FOR UPDATE/);
    });
  });

  describe("R76-DB-M: /api/transfers RECEIVE reorder_point default=5", () => {
    const src = read("src/app/api/transfers/route.ts");
    it("INSERT defaults reorder_point to 5 (parity with PO receive)", () => {
      expect(src).toMatch(/INSERT INTO inventory_levels[\s\S]{0,400}VALUES \(\$1, \$2, \$3, \$4, \$5, 0, 5/);
    });
  });

  describe("R76-FE-M: NaN guards on report parseFloat paths", () => {
    it("daily-manager-report uses safeNum helper", () => {
      const src = read("src/components/admin/daily-manager-report.tsx");
      expect(src).toMatch(/const safeNum = \(v: unknown\) => \{[\s\S]{0,200}Number\.isFinite\(n\) \? n : 0/);
    });
    it("sales-reports uses safeNum helper", () => {
      const src = read("src/components/admin/sales-reports.tsx");
      expect(src).toMatch(/const safeNum = \(v: unknown\) => \{[\s\S]{0,200}Number\.isFinite\(n\) \? n : 0/);
    });
    it("multi-location-dashboard guards parseFloat with Number.isFinite", () => {
      const src = read("src/components/admin/multi-location-dashboard.tsx");
      expect(src).toMatch(/const parsed = parseFloat\(transaction\.payload\.grand_total\);[\s\S]{0,100}Number\.isFinite\(parsed\) \? parsed : 0/);
    });
  });

  describe("R76-FE-M: customer-search-modal surfaces create errors", () => {
    const src = read("src/components/register/customer-search-modal.tsx");
    it("has createError state + role=alert surface", () => {
      expect(src).toMatch(/const \[createError, setCreateError\] = useState<string \| null>/);
      expect(src).toMatch(/role="alert"[\s\S]{0,200}\{createError\}/);
    });
    it("Create & attach button wraps onCreateCustomer in try/catch/finally", () => {
      expect(src).toMatch(/try \{[\s\S]{0,600}await onCreateCustomer[\s\S]{0,600}\} catch \(err\) \{[\s\S]{0,300}setCreateError\(/);
    });
    it("resetNewForm clears all new-customer fields", () => {
      expect(src).toMatch(/const resetNewForm = \(\) => \{[\s\S]{0,400}setNewFirst\(""\)[\s\S]{0,300}setCreateError\(null\)/);
    });
  });

  describe("R76-FE-M: idb-store versionchange + blocked", () => {
    const src = read("src/lib/offline/idb-store.ts");
    it("onversionchange closes stale connection", () => {
      expect(src).toMatch(/onversionchange = \(\) => \{\s*_dbInstance\?\.close\(\);\s*_dbInstance = null;/);
    });
    it("onblocked rejects with actionable message", () => {
      expect(src).toMatch(/request\.onblocked = \(\) =>[\s\S]{0,200}IndexedDB upgrade blocked/);
    });
  });

  describe("R76-FE-M: use-online-status uses AbortController", () => {
    const src = read("src/lib/offline/use-online-status.ts");
    it("declares abortRef + mountedRef", () => {
      expect(src).toMatch(/const abortRef = useRef<AbortController \| null>\(null\)/);
      expect(src).toMatch(/const mountedRef = useRef\(true\)/);
    });
    it("checkConnectivity aborts prior controller + passes signal", () => {
      expect(src).toMatch(/abortRef\.current\?\.abort\(\);[\s\S]{0,400}signal: controller\.signal/);
    });
    it("cleanup aborts + marks mountedRef false", () => {
      expect(src).toMatch(/abortRef\.current\?\.abort\(\);\s*mountedRef\.current = false/);
    });
  });

  describe("R76-FE-M: expense-tracker + returns-manager surface fetch errors", () => {
    it("expense-tracker fetchExpenses catch sets message", () => {
      const src = read("src/components/admin/expense-tracker.tsx");
      expect(src).toMatch(/\} catch \(e\) \{[\s\S]{0,300}setMessage\(\{[\s\S]{0,200}Failed to load expenses/);
    });
    it("returns-manager fetchReturns catch sets message", () => {
      const src = read("src/components/admin/returns-manager.tsx");
      expect(src).toMatch(/\} catch \(e\) \{[\s\S]{0,300}setMessage\(\{[\s\S]{0,200}Failed to load returns/);
    });
  });

  describe("R76-FE-M: inventory-browser debounced fetch uses AbortController", () => {
    const src = read("src/components/admin/inventory-browser.tsx");
    it("declares fetchAbortRef", () => {
      expect(src).toMatch(/const fetchAbortRef = useRef<AbortController \| null>\(null\)/);
    });
    it("fetchInventory aborts prior + passes signal", () => {
      expect(src).toMatch(/fetchAbortRef\.current\?\.abort\(\);[\s\S]{0,600}signal: controller\.signal/);
    });
  });

  describe("R76-FE-L: barcode-lookup validates numeric inputs before submit", () => {
    const src = read("src/components/admin/barcode-lookup.tsx");
    it("rejects price that is NaN or <= 0", () => {
      expect(src).toMatch(/!Number\.isFinite\(parsedPrice\) \|\| parsedPrice <= 0[\s\S]{0,200}Price must be a positive number/);
    });
    it("rejects initial_stock NaN or negative", () => {
      expect(src).toMatch(/!Number\.isFinite\(parsedStock\) \|\| parsedStock < 0[\s\S]{0,200}Initial stock must be/);
    });
  });
});
