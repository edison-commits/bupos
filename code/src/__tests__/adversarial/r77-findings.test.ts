/**
 * R77 regression tests. Pins audit round 21 — 19 findings
 * (3 HIGH + 9 MEDIUM + 7 LOW).
 *
 * HIGH (3)
 *   SEC-H: toggleEmployeeAction Server Action now accepts explicit
 *     "activate" | "deactivate" (not blind NOT is_active), rejects
 *     self-deactivate, rejects owner-on-owner deactivate, and
 *     wipes the victim's sessions on deactivate. Parity with REST
 *     /api/employees PATCH R28-H4 / R30-H3 / R76-SEC-H2.
 *   DB-H1: /api/returns PUT + /api/returns/process cross-shift
 *     cash-refund pay_out now SELECTs the open shift with FOR
 *     UPDATE SKIP LOCKED so a concurrent closeShiftEnhancedAction
 *     either blocks this path or returns 0 rows — prior shape
 *     could land pay_out against a just-closed shift that shift-
 *     close never saw.
 *   DB-H2: /api/purchase-orders PUT now FOR UPDATEs the PO row
 *     and enforces a state-machine on status transitions. Prior
 *     shape accepted any status → any status (could regress
 *     'received' to 'cancelled', reactivate 'cancelled' to
 *     'submitted'). Forbidden transitions return 409.
 *
 * MEDIUM
 *   DB-M1: stocktake accept aggregates by variant before unnest
 *     delta-join. Duplicate lines for same variant used to let
 *     PostgreSQL apply only ONE delta nondeterministically.
 *   DB-M2: returns/process restock switched from UPDATE-then-
 *     INSERT to UPSERT. Prior shape R31-H6-prone — two concurrent
 *     refund-restocks on new-row variant both INSERT → 23505
 *     rolls back one whole return tx.
 *   FE-M-submit: bundle-manager createSubmitting flag guards
 *     the password-prompt + fetch window (isPending from
 *     useTransition only tracks the trailing router.refresh).
 *   FE-M-alert: approval-modal error banner gets role="alert" +
 *     aria-live="assertive" so blind cashiers hear approval
 *     denials.
 *   FE-M-fetch: purchase-order-manager fetchOrders + fetchSuppliers
 *     bare catch{} now surfaces setMessage; res.json on error
 *     response has .catch() fallback for non-JSON bodies.
 *   FE-M-abort: PO-manager searchVariants uses AbortController
 *     so rapid typing doesn't let stale results overwrite.
 *   FE-M-unmount: inventory-browser useEffect cleanup aborts
 *     the in-flight fetch so torn-down component doesn't setState.
 *
 * LOW
 *   FE-L-order: use-online-status cleanup flips mountedRef=false
 *     BEFORE abort() (defensive ordering).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("R77 audit fixes — round 21", () => {
  describe("R77-SEC-H HIGH: toggleEmployeeAction twin-path parity", () => {
    const src = read("src/app/admin/actions.ts");
    const block = src.slice(src.indexOf("export async function toggleEmployeeAction"));
    it("reads explicit 'action' from FormData + rejects missing/invalid", () => {
      expect(block).toMatch(/const explicitAction = String\(formData\.get\("action"\) \?\? ""\)/);
      expect(block).toMatch(/explicitAction !== "activate" && explicitAction !== "deactivate"/);
    });
    it("blocks self-deactivation", () => {
      expect(block).toMatch(/isSelf && explicitAction === "deactivate"[\s\S]{0,200}cannot\+deactivate\+yourself/);
    });
    it("blocks owner-on-owner deactivation", () => {
      expect(block).toMatch(/!isSelf && actor\.roleKey === "owner" && targetRole === "owner" && !targetActive/);
    });
    it("UPDATE uses is_active = $1 with explicit targetActive (not NOT toggle)", () => {
      expect(block).toMatch(/UPDATE employees SET is_active = \$1, updated_at = \$2/);
    });
    it("event_kind matches REST shape (employee_activated / employee_deactivated)", () => {
      expect(block).toMatch(/targetActive \? "employee_activated" : "employee_deactivated"/);
    });
    it("DELETEs sessions on deactivate", () => {
      expect(block).toMatch(/newStatus === false[\s\S]{0,500}DELETE FROM sessions\s+WHERE employee_id/);
    });
    it("admin-console wires explicit action hidden input", () => {
      const ui = read("src/components/admin/admin-console.tsx");
      expect(ui).toMatch(/name="action"\s+value=\{employee\.isActive \? "deactivate" : "activate"\}/);
    });
  });

  describe("R77-DB-H1 HIGH: returns cash-refund locks open shift with SKIP LOCKED", () => {
    it("/api/returns PUT uses FOR UPDATE SKIP LOCKED on open shift SELECT", () => {
      const src = read("src/app/api/returns/route.ts");
      expect(src).toMatch(/SELECT id, register_session_id, opened_at FROM shifts[\s\S]{0,400}status = 'open'[\s\S]{0,300}FOR UPDATE SKIP LOCKED/);
    });
    it("/api/returns/process uses FOR UPDATE SKIP LOCKED on open shift SELECT", () => {
      const src = read("src/app/api/returns/process/route.ts");
      expect(src).toMatch(/SELECT id, register_session_id, opened_at FROM shifts[\s\S]{0,400}status = 'open'[\s\S]{0,300}FOR UPDATE SKIP LOCKED/);
    });
  });

  describe("R77-DB-H2 HIGH: /api/purchase-orders PUT state-machine + FOR UPDATE", () => {
    const src = read("src/app/api/purchase-orders/route.ts");
    it("PUT SELECTs current status FOR UPDATE inside the tx", () => {
      expect(src).toMatch(/SELECT status FROM purchase_orders WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/);
    });
    it("allowed-transition table rejects received and cancelled as source", () => {
      expect(src).toMatch(/received:\s*\[\]/);
      expect(src).toMatch(/cancelled:\s*\[\]/);
    });
    it("returns 409 + actionable message on forbidden transition", () => {
      expect(src).toMatch(/PO cannot transition from '\$\{curStatus\}' to '\$\{status\}'/);
    });
  });

  describe("R77-DB-M1 MED: stocktake accept aggregates by variant", () => {
    const src = read("src/app/admin/stocktake-actions.ts");
    it("builds latestByVariant Map before unnest arrays", () => {
      expect(src).toMatch(/const latestByVariant = new Map<string, \{ counted: number \}>\(\)/);
    });
    it("update loop iterates latestByVariant entries", () => {
      expect(src).toMatch(/for \(const \[variantId, \{ counted \}\] of latestByVariant\)/);
    });
  });

  describe("R77-DB-M2 MED: returns/process restock uses UPSERT", () => {
    const src = read("src/app/api/returns/process/route.ts");
    it("INSERT ... ON CONFLICT DO UPDATE replaces UPDATE-then-INSERT", () => {
      expect(src).toMatch(/INSERT INTO inventory_levels[\s\S]{0,400}ON CONFLICT \(product_variant_id, location_id\)\s+DO UPDATE SET on_hand = inventory_levels\.on_hand \+ EXCLUDED\.on_hand/);
    });
  });

  describe("R77-FE-M MED: bundle-manager createSubmitting double-submit guard", () => {
    const src = read("src/components/admin/bundle-manager.tsx");
    it("declares createSubmitting state", () => {
      expect(src).toMatch(/const \[createSubmitting, setCreateSubmitting\] = useState\(false\)/);
    });
    it("handleCreateSubmit checks + sets the flag", () => {
      expect(src).toMatch(/if \(createSubmitting\) return;/);
      expect(src).toMatch(/setCreateSubmitting\(true\)/);
    });
    it("finally clears createSubmitting", () => {
      expect(src).toMatch(/\} finally \{\s*setCreateSubmitting\(false\);\s*\}/);
    });
    it("submit button disabled uses isPending || createSubmitting", () => {
      expect(src).toMatch(/disabled=\{isPending \|\| createSubmitting\}/);
    });
  });

  describe("R77-FE-M MED: approval-modal error has role=alert + aria-live", () => {
    const src = read("src/components/register/approval-modal.tsx");
    it("error paragraph has role='alert' and aria-live='assertive'", () => {
      expect(src).toMatch(/role="alert"\s+aria-live="assertive"/);
    });
  });

  describe("R77-FE-M MED: purchase-order-manager surfaces fetch errors", () => {
    const src = read("src/components/admin/purchase-order-manager.tsx");
    it("fetchOrders catch sets message", () => {
      expect(src).toMatch(/fetchOrders = useCallback[\s\S]{0,1500}\} catch \(e\) \{[\s\S]{0,400}Failed to load purchase orders/);
    });
    it("fetchSuppliers catch sets message", () => {
      expect(src).toMatch(/fetchSuppliers = useCallback[\s\S]{0,1500}\} catch \(e\) \{[\s\S]{0,400}Failed to load suppliers/);
    });
    it("PATCH receive err body has .catch fallback", () => {
      expect(src).toMatch(/const err = await res\.json\(\)\.catch\(\(\) => \(\{ error:/);
    });
  });

  describe("R77-FE-M MED: PO-manager searchVariants uses AbortController", () => {
    const src = read("src/components/admin/purchase-order-manager.tsx");
    it("declares searchAbortRef", () => {
      expect(src).toMatch(/const searchAbortRef = useRef<AbortController \| null>\(null\)/);
    });
    it("searchVariants aborts prior + passes signal", () => {
      expect(src).toMatch(/searchAbortRef\.current\?\.abort\(\);[\s\S]{0,500}signal: controller\.signal/);
    });
  });

  describe("R77-FE-M MED: inventory-browser unmount cleanup aborts fetch", () => {
    const src = read("src/components/admin/inventory-browser.tsx");
    it("useEffect cleanup calls fetchAbortRef.current?.abort()", () => {
      expect(src).toMatch(/useEffect\(\(\) => \{\s*fetchInventory\(1\);[\s\S]{0,400}return \(\) => \{\s*fetchAbortRef\.current\?\.abort\(\);/);
    });
  });

  describe("R77-FE-L LOW: use-online-status cleanup order", () => {
    const src = read("src/lib/offline/use-online-status.ts");
    it("mountedRef flipped to false BEFORE abort()", () => {
      expect(src).toMatch(/mountedRef\.current = false;\s*abortRef\.current\?\.abort\(\);/);
    });
  });
});
